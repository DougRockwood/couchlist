/* ============================================================================
   server.js — whatdoyouwannawatch.com (flat-redesign)
   ============================================================================
   The entire backend. Three jobs:

   1. Serve static files (index.html, style.css, app.js) from public/
   2. Provide a JSON API that app.js calls via fetch()
   3. Store everything in a SQLite database file (couchlist.db)

   KEY DIFFERENCE FROM v1:
   Rankings and comments are NO LONGER separate tables. They live directly
   on the movies table as user1_rank, user1_comment, user2_rank, etc.
   Each list supports up to 10 visitors. A "list_visitors" table maps
   slot numbers (1-10) to visitor IDs on a per-list basis.

   This means every movie row contains ALL the data the frontend needs —
   no cross-referencing, no reshaping. The response from GET /api/list/:id
   is essentially what you see on screen.

   DEPENDENCIES (package.json):
     express         — web framework
     better-sqlite3  — synchronous SQLite driver

   HOW TO RUN:
     npm install
     node server.js
     open localhost:3000
   ============================================================================ */


/* ============================================================================
   SECTION 1: IMPORTS AND SETUP
   ============================================================================ */

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database(path.join(__dirname, 'couchlist.db'));
db.pragma('journal_mode = WAL');                                   // better concurrency


/* ============================================================================
   SECTION 2: DATABASE SCHEMA
   ============================================================================
   Three tables (down from five in v1):

   visitors       — global registry of people. One row per person, shared
                    across all lists. The 10-char ID comes from the cookie.

   lists          — one row per list. Created when the first movie is added.

   list_visitors  — maps slot numbers (1-10) to visitor IDs, per list.
                    When doug joins list "abc123", he gets slot 1.
                    When percy joins, he gets slot 2. Up to 10 per list.
                    The slot number determines which columns hold their data
                    in the movies table (user1_rank, user2_rank, etc).

   movies         — one row per movie on a list. Contains ALL data:
                    - movie info (title, year, poster, tmdb_id)
                    - who added it (added_by)
                    - every visitor's rank (user1_rank through user10_rank)
                    - every visitor's comment (user1_comment through user10_comment)

                    If user3_rank is NULL, it means slot 3 has no visitor
                    assigned yet. If it's a number, that's their ranking
                    for this movie (1 = their top pick).
   ============================================================================ */

db.exec(`
  CREATE TABLE IF NOT EXISTS visitors (
    id    TEXT PRIMARY KEY,
    name  TEXT,
    color TEXT
  );

  CREATE TABLE IF NOT EXISTS lists (
    id      TEXT PRIMARY KEY,
    created TEXT
  );

  CREATE TABLE IF NOT EXISTS list_visitors (
    list_id    TEXT,
    slot       INTEGER CHECK(slot BETWEEN 1 AND 10),
    visitor_id TEXT,
    ready      INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(list_id, slot),
    UNIQUE(list_id, visitor_id)
  );

  CREATE TABLE IF NOT EXISTS movies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id    TEXT,
    tmdb_id    INTEGER,
    media_type TEXT NOT NULL DEFAULT 'movie',   -- 'movie' or 'tv'; TV shows are treated like movies everywhere else
    title      TEXT,
    year       INTEGER,
    poster     TEXT,
    added_by   TEXT,
    user1_rank  INTEGER, user1_comment  TEXT,
    user2_rank  INTEGER, user2_comment  TEXT,
    user3_rank  INTEGER, user3_comment  TEXT,
    user4_rank  INTEGER, user4_comment  TEXT,
    user5_rank  INTEGER, user5_comment  TEXT,
    user6_rank  INTEGER, user6_comment  TEXT,
    user7_rank  INTEGER, user7_comment  TEXT,
    user8_rank  INTEGER, user8_comment  TEXT,
    user9_rank  INTEGER, user9_comment  TEXT,
    user10_rank INTEGER, user10_comment TEXT
  );
`);

/* migration: add `ready` column to existing list_visitors tables that predate it.
   SQLite throws if the column already exists — swallow that one case. */
try {
  db.exec('ALTER TABLE list_visitors ADD COLUMN ready INTEGER NOT NULL DEFAULT 1');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

/* migration: add `media_type` column to existing movies tables. Existing rows
   default to 'movie' (what we used to assume); new rows carry 'movie' or 'tv'. */
try {
  db.exec("ALTER TABLE movies ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'");
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}


/* ============================================================================
   SECTION 2b: MY SHELF SCHEMA  (added 2026-04-26)
   ============================================================================
   Major redesign in progress: every visitor gets one canonical ordering of
   every movie they've encountered. Per-list rankings become projections of
   this master order. See planning notes (chat 2026-04-26) for the full plan.

   user_movies   — visitor's master ranking. One row per (visitor, movie key).
                   Movie key is (tmdb_id, media_type) so the SAME tmdb item on
                   two different lists is the SAME row here. master_rank is a
                   contiguous 1..N sequence per visitor; reordering on any list
                   rewrites this sequence and re-projects per-list ranks.

   lists.private + lists.owner_visitor_id
                 — flags a "solo list" (per-user private stash, formerly
                   "no one can know"). Solo list ID convention: first 8 chars
                   of the owner's 10-char visitor ID. Only owner can read or
                   mutate. Created lazily; not bootstrapped here.

   list_visitors.list_name
                 — per-user nickname for a list (max 12 chars, displayed
                   above "couchlist" in the tab). Strictly per-viewer; other
                   visitors do not see your nickname for the list.

   Step 1 of the rollout is purely additive: existing user1_rank..user10_rank
   columns remain authoritative. The bootstrap below populates user_movies so
   later steps can flip the source-of-truth without a backfill at that point. */

db.exec(`
  CREATE TABLE IF NOT EXISTS user_movies (
    visitor_id   TEXT    NOT NULL,
    tmdb_id      INTEGER NOT NULL,
    media_type   TEXT    NOT NULL,
    master_rank  INTEGER NOT NULL,
    PRIMARY KEY (visitor_id, tmdb_id, media_type)
  );
  CREATE INDEX IF NOT EXISTS user_movies_by_rank
    ON user_movies(visitor_id, master_rank);
`);

try {
  db.exec('ALTER TABLE lists ADD COLUMN private INTEGER NOT NULL DEFAULT 0');
} catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

try {
  db.exec('ALTER TABLE lists ADD COLUMN owner_visitor_id TEXT');
} catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

try {
  db.exec('ALTER TABLE list_visitors ADD COLUMN list_name TEXT');
} catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }


/* Bootstrap user_movies from existing per-list rankings.

   For each visitor, walk every list they're on in (lists.created, list_id)
   order. Within each list, walk movies in that visitor's per-list rank order
   (rank 1 first). Append each movie key (tmdb_id, media_type) to the visitor's
   master order if it's not already there. Result: a contiguous 1..N master
   ranking per visitor, biased toward how they ranked their FIRST list when
   the same movie appears in multiple lists.

   Idempotent: if a visitor already has any user_movies rows, skip them — the
   bootstrap has already run for that visitor in a prior boot. */

(function bootstrapUserMovies () {
  const visitorsWithSlots = db.prepare(`
    SELECT DISTINCT visitor_id FROM list_visitors
  `).all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO user_movies (visitor_id, tmdb_id, media_type, master_rank)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const { visitor_id } of visitorsWithSlots) {
      const already = db.prepare(
        'SELECT 1 FROM user_movies WHERE visitor_id = ? LIMIT 1'
      ).get(visitor_id);
      if (already) continue;                                       // already bootstrapped

      const memberships = db.prepare(`
        SELECT lv.list_id, lv.slot, l.created
        FROM list_visitors lv
        JOIN lists l ON l.id = lv.list_id
        WHERE lv.visitor_id = ?
        ORDER BY l.created, lv.list_id
      `).all(visitor_id);

      const seen = new Set();
      let nextRank = 1;
      for (const m of memberships) {
        const col = 'user' + m.slot + '_rank';
        const movies = db.prepare(
          'SELECT tmdb_id, media_type, ' + col + ' AS rank '
          + 'FROM movies WHERE list_id = ? AND tmdb_id IS NOT NULL '
          + 'ORDER BY ' + col + ' IS NULL, ' + col + ', id'
        ).all(m.list_id);

        for (const mv of movies) {
          const key = mv.tmdb_id + ':' + mv.media_type;
          if (seen.has(key)) continue;
          seen.add(key);
          insert.run(visitor_id, mv.tmdb_id, mv.media_type, nextRank++);
        }
      }
    }
  });
  tx();
})();


/* ============================================================================
   SECTION 2c: MASTER-RANK HELPERS  (added 2026-04-26 — step 2 of My Shelf rollout)
   ============================================================================
   user_movies is the source of truth for every visitor's ordering of every
   movie they've encountered. The userN_rank columns on movies are now a
   denormalized cache: for a given list, each visitor's userN_rank values are
   the projection of their master_rank onto the movies on this list.

   Reorder rule (drag/swap/move/my-ranks):
     "Permute master_rank values among ONLY the movies on this list,
      keeping the SET of master_rank slots unchanged."
     Movies not on this list keep their master_rank intact; the relative
     order of OTHER movies on the same list also stays put except where the
     user explicitly moved something.
     This is the algorithm that produces both of Doug's worked examples:
       master [A,X,Y,B,C], list [A,B,C], drag→[A,C,B] => [A,X,Y,C,B]
       master [B,A,X,Y,C], list [B,A,C], drag→[A,B,C] => [A,B,X,Y,C]

   Add rule:
     Adder: their new master_rank for the (tmdb_id,media_type) is 1; if they
     already had it elsewhere, move it to 1 (everything else shifts down).
     Others on the list: if they already had the key, leave master_rank
     alone; otherwise append at end (max+1).

   Remove rule:
     Decrement nothing in master_rank if the key still exists on some other
     list. If the deletion makes the key vanish from the entire DB, drop the
     user_movies row for every visitor who had it and re-compact each
     visitor's master_rank so it's contiguous 1..N again.

   NULL tmdb_id movies (legacy Details paste flow) are not tracked in
   user_movies. Their userN_rank values get a deterministic tail position
   from the reproject helper, so they remain visible without breaking ranks.
   ============================================================================ */

function ensureUserMovieAtTop (visitor_id, tmdb_id, media_type) {
  if (tmdb_id == null) return;
  const existing = db.prepare(
    'SELECT master_rank FROM user_movies WHERE visitor_id=? AND tmdb_id=? AND media_type=?'
  ).get(visitor_id, tmdb_id, media_type);

  if (existing) {
    if (existing.master_rank === 1) return;                          // already at top
    db.prepare(
      'UPDATE user_movies SET master_rank = master_rank + 1 '
      + 'WHERE visitor_id = ? AND master_rank < ?'
    ).run(visitor_id, existing.master_rank);
    db.prepare(
      'UPDATE user_movies SET master_rank = 1 '
      + 'WHERE visitor_id = ? AND tmdb_id = ? AND media_type = ?'
    ).run(visitor_id, tmdb_id, media_type);
  } else {
    db.prepare(
      'UPDATE user_movies SET master_rank = master_rank + 1 WHERE visitor_id = ?'
    ).run(visitor_id);
    db.prepare(
      'INSERT INTO user_movies (visitor_id, tmdb_id, media_type, master_rank) VALUES (?, ?, ?, 1)'
    ).run(visitor_id, tmdb_id, media_type);
  }
}

function ensureUserMovieKeepOrAppend (visitor_id, tmdb_id, media_type) {
  if (tmdb_id == null) return;
  const existing = db.prepare(
    'SELECT 1 FROM user_movies WHERE visitor_id=? AND tmdb_id=? AND media_type=?'
  ).get(visitor_id, tmdb_id, media_type);
  if (existing) return;

  const maxRank = db.prepare(
    'SELECT COALESCE(MAX(master_rank), 0) AS m FROM user_movies WHERE visitor_id = ?'
  ).get(visitor_id).m;
  db.prepare(
    'INSERT INTO user_movies (visitor_id, tmdb_id, media_type, master_rank) VALUES (?, ?, ?, ?)'
  ).run(visitor_id, tmdb_id, media_type, maxRank + 1);
}

/* If the (tmdb_id, media_type) is no longer present on ANY list, drop every
   visitor's user_movies row for it and re-compact their master_ranks. Returns
   true if the row was orphaned and cleaned up. */
function cleanupOrphanedKey (tmdb_id, media_type) {
  if (tmdb_id == null) return false;
  const stillSomewhere = db.prepare(
    'SELECT 1 FROM movies WHERE tmdb_id = ? AND media_type = ? LIMIT 1'
  ).get(tmdb_id, media_type);
  if (stillSomewhere) return false;

  const affected = db.prepare(
    'SELECT visitor_id, master_rank FROM user_movies WHERE tmdb_id = ? AND media_type = ?'
  ).all(tmdb_id, media_type);

  const del = db.prepare(
    'DELETE FROM user_movies WHERE visitor_id = ? AND tmdb_id = ? AND media_type = ?'
  );
  const compact = db.prepare(
    'UPDATE user_movies SET master_rank = master_rank - 1 '
    + 'WHERE visitor_id = ? AND master_rank > ?'
  );
  affected.forEach(a => {
    del.run(a.visitor_id, tmdb_id, media_type);
    compact.run(a.visitor_id, a.master_rank);
  });
  return true;
}

/* Recompute the userN_rank cache column for one visitor on one list.
   Movies on the list are sorted by master_rank ASC (NULL master_rank — i.e.
   movies with no tmdb_id — sort to the end, then by movies.id for stability),
   then assigned rank 1..N. Caller must have validated that visitor has a
   slot on this list. */
function reprojectListForVisitor (visitor_id, list_id, slot) {
  const col = 'user' + slot + '_rank';
  const ordered = db.prepare(
    'SELECT m.id FROM movies m '
    + 'LEFT JOIN user_movies um '
    + '  ON um.visitor_id = ? AND um.tmdb_id = m.tmdb_id AND um.media_type = m.media_type '
    + 'WHERE m.list_id = ? '
    + 'ORDER BY (um.master_rank IS NULL), um.master_rank, m.id'
  ).all(visitor_id, list_id);

  const upd = db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ?');
  ordered.forEach((m, i) => upd.run(i + 1, m.id));
}

function reprojectListForAllVisitors (list_id) {
  const slots = db.prepare(
    'SELECT slot, visitor_id FROM list_visitors WHERE list_id = ?'
  ).all(list_id);
  slots.forEach(s => reprojectListForVisitor(s.visitor_id, list_id, s.slot));
}

/* Re-project every list this visitor is on. Called whenever the visitor's
   master_rank values change, since other lists' projections of shared keys
   depend on master_rank too. Cost is O(lists * movies-per-list); fine for
   the scale this app operates at. */
function reprojectAllListsForVisitor (visitor_id) {
  const memberships = db.prepare(
    'SELECT list_id, slot FROM list_visitors WHERE visitor_id = ?'
  ).all(visitor_id);
  memberships.forEach(m => reprojectListForVisitor(visitor_id, m.list_id, m.slot));
}

/* Permute master_rank values among ONLY the keys passed in. Used by the
   My Shelf page when the visitor reorders their movies on the "your" tab —
   movies they didn't add (or that aren't in the filtered visible list) keep
   their master_rank untouched. Errors out if any key is missing from
   user_movies for this visitor (caller should never pass orphaned keys). */
function setMasterProjectionByKeys (visitor_id, ordered_keys) {
  const slots = [];
  for (const k of ordered_keys) {
    const r = db.prepare(
      'SELECT master_rank FROM user_movies '
      + 'WHERE visitor_id = ? AND tmdb_id = ? AND media_type = ?'
    ).get(visitor_id, k.tmdb_id, k.media_type);
    if (!r) throw new Error('key not in master: ' + k.tmdb_id + ':' + k.media_type);
    slots.push(r.master_rank);
  }
  const sortedSlots = slots.slice().sort((a, b) => a - b);

  const stmt = db.prepare(
    'UPDATE user_movies SET master_rank = ? '
    + 'WHERE visitor_id = ? AND tmdb_id = ? AND media_type = ?'
  );
  ordered_keys.forEach((k, i) => stmt.run(-(i + 1), visitor_id, k.tmdb_id, k.media_type));
  ordered_keys.forEach((k, i) => stmt.run(sortedSlots[i], visitor_id, k.tmdb_id, k.media_type));
}

/* Apply a desired list ordering for one visitor by permuting which master_rank
   slot each of this list's movies occupies. Master_ranks of movies NOT on
   this list (and NULL-tmdb movies) are untouched.

   `ordered_movie_ids` is a list of movies.id values in the desired list-order;
   movies on the list but absent from this array get appended (preserving
   their current relative master_rank order).  */
function setListProjection (visitor_id, list_id, ordered_movie_ids) {
  const allOnList = db.prepare(
    'SELECT m.id, m.tmdb_id, m.media_type, um.master_rank '
    + 'FROM movies m '
    + 'LEFT JOIN user_movies um '
    + '  ON um.visitor_id = ? AND um.tmdb_id = m.tmdb_id AND um.media_type = m.media_type '
    + 'WHERE m.list_id = ?'
  ).all(visitor_id, list_id);

  /* skip movies with no tmdb_id (they can't be in user_movies) */
  const trackable = allOnList.filter(m => m.tmdb_id != null);

  /* full target order: requested ids first, then remaining trackable movies
     ordered by their current master_rank (NULL last, then id) */
  const requested = new Set(ordered_movie_ids);
  const tail = trackable
    .filter(m => !requested.has(m.id))
    .sort((a, b) => {
      if (a.master_rank == null && b.master_rank == null) return a.id - b.id;
      if (a.master_rank == null) return 1;
      if (b.master_rank == null) return -1;
      return a.master_rank - b.master_rank;
    });

  const byId = new Map(allOnList.map(m => [m.id, m]));
  const orderedKeys = [];
  for (const id of ordered_movie_ids) {
    const m = byId.get(id);
    if (m && m.tmdb_id != null) orderedKeys.push(m);
  }
  const finalOrder = orderedKeys.concat(tail);                       // movie objects in target list-order

  /* the SET of master_rank slots occupied by these movies stays the same;
     we just reassign which key gets which slot. NULL master_rank means the
     visitor doesn't yet have a user_movies entry for that key — give it one
     by appending at the end first. */
  finalOrder.forEach(m => {
    if (m.master_rank == null) {
      ensureUserMovieKeepOrAppend(visitor_id, m.tmdb_id, m.media_type);
      m.master_rank = db.prepare(
        'SELECT master_rank FROM user_movies WHERE visitor_id=? AND tmdb_id=? AND media_type=?'
      ).get(visitor_id, m.tmdb_id, m.media_type).master_rank;
    }
  });

  const slotValues = finalOrder
    .map(m => m.master_rank)
    .sort((a, b) => a - b);                                          // ascending master_rank slots

  /* assign keys to slots in order. Two-phase to avoid collisions: first
     stamp each key with a sentinel negative rank, then write the real one. */
  const stampNeg = db.prepare(
    'UPDATE user_movies SET master_rank = ? '
    + 'WHERE visitor_id = ? AND tmdb_id = ? AND media_type = ?'
  );
  finalOrder.forEach((m, i) => {
    stampNeg.run(-(i + 1), visitor_id, m.tmdb_id, m.media_type);
  });
  finalOrder.forEach((m, i) => {
    stampNeg.run(slotValues[i], visitor_id, m.tmdb_id, m.media_type);
  });
}


/* ============================================================================
   SECTION 3: MIDDLEWARE
   ============================================================================ */

app.use(express.json());

/* Serve /public as static files. index.html is the ONE exception — it
   gets `Cache-Control: no-store` so the browser never holds a stale copy.
   Mobile Chrome was seen serving a cached index.html (with old `?v=`
   asset tokens) even with max-age:0, which defeats the whole cache-bust
   scheme. CSS/JS can be cached freely — their URLs change on each edit. */
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));


/* ============================================================================
   SECTION 4: VISITOR ENDPOINTS
   ============================================================================
   GET  /api/visitor/:id   — look up a visitor by their 10-char ID
   PUT  /api/visitor/:id   — create or update a visitor (name, color)
   ============================================================================ */

app.get('/api/visitor/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM visitors WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'visitor not found' });
  res.json(row);
});

app.put('/api/visitor/:id', (req, res) => {
  const { name, color } = req.body;

  /* SECURITY: validate `color` at the API boundary.
     The frontend renders this directly into a style attribute as
     `style="color: ${escapeHtml(color)}"`, but escapeHtml only escapes
     <>&, NOT quotes. So a color of `red" onclick="alert(1)` would break
     out of the attribute and run JS in every other visitor's browser
     (stored XSS → cookie/identity theft). Restrict to the two formats
     the UI actually produces: 6-digit hex (#rrggbb from <input type=color>)
     or hsl(...) from randomColor(). Anything else is rejected. */
  if (color != null && color !== '') {
    const isHex = typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
    const isHsl = typeof color === 'string' &&
      /^hsl\(\s*\d+\s*,\s*\d+%\s*,\s*\d+%\s*\)$/.test(color);
    if (!isHex && !isHsl) {
      return res.status(400).json({ error: 'invalid color' });
    }
  }

  db.prepare('INSERT OR REPLACE INTO visitors (id, name, color) VALUES (?, ?, ?)')
    .run(req.params.id, name, color);
  res.json({ id: req.params.id, name, color });
});

/* GET /api/visitor/:id/shelf — everything needed to render My Shelf in one
   response.

   Returns:
     {
       visitor: { id, name, color },
       lists:   [ { id, list_name, ready, slot, private, owner_visitor_id, created } ],
       movies:  [ { tmdb_id, media_type, title, year, poster, master_rank,
                    added_by_me, list_ids: [string, ...] } ]
     }

   Movies are sorted by master_rank ascending. `added_by_me` is true if the
   visitor was the adder on AT LEAST one list this movie is on. `list_ids`
   contains every list the movie is on AND the visitor is also on (we never
   leak movies from lists they aren't a member of).

   404 if the visitor row doesn't exist; an empty shelf is returned for
   visitors who exist but have no list memberships yet. */
app.get('/api/visitor/:id/shelf', (req, res) => {
  const vid = req.params.id;

  const visitor = db.prepare('SELECT id, name, color FROM visitors WHERE id = ?').get(vid);
  if (!visitor) return res.status(404).json({ error: 'visitor not found' });

  const lists = db.prepare(`
    SELECT l.id, l.created, l.private, l.owner_visitor_id,
           lv.slot, lv.list_name, lv.ready
    FROM list_visitors lv
    JOIN lists l ON l.id = lv.list_id
    WHERE lv.visitor_id = ?
    ORDER BY l.created, l.id
  `).all(vid).map(r => ({
    id: r.id,
    list_name: r.list_name,
    ready: r.ready !== 0,
    slot: r.slot,
    private: r.private,
    owner_visitor_id: r.owner_visitor_id,
    created: r.created
  }));

  const movieRows = db.prepare(`
    SELECT
      m.tmdb_id, m.media_type,
      MIN(m.title)  AS title,
      MIN(m.year)   AS year,
      MIN(m.poster) AS poster,
      um.master_rank,
      GROUP_CONCAT(DISTINCT m.list_id) AS list_ids_csv,
      MAX(CASE WHEN m.added_by = ? THEN 1 ELSE 0 END) AS added_by_me
    FROM movies m
    JOIN user_movies um
      ON um.visitor_id = ? AND um.tmdb_id = m.tmdb_id AND um.media_type = m.media_type
    JOIN list_visitors lv
      ON lv.list_id = m.list_id AND lv.visitor_id = ?
    GROUP BY m.tmdb_id, m.media_type, um.master_rank
    ORDER BY um.master_rank
  `).all(vid, vid, vid);

  const movies = movieRows.map(r => ({
    tmdb_id: r.tmdb_id,
    media_type: r.media_type,
    title: r.title,
    year: r.year,
    poster: r.poster,
    master_rank: r.master_rank,
    added_by_me: r.added_by_me === 1,
    list_ids: r.list_ids_csv ? r.list_ids_csv.split(',') : []
  }));

  res.json({ visitor, lists, movies });
});


/* PUT /api/visitor/:id/shelf-ranks — reorder master_rank among a subset of
   the visitor's movies (used by the My Shelf "your" tab drag).

   Body: { ordered_keys: [ { tmdb_id, media_type }, ... ] }

   Master_rank values for movies NOT in ordered_keys are untouched. The
   ordered_keys list MUST contain only keys this visitor has in user_movies;
   sending unknown keys returns 400 (we don't silently create entries here,
   to avoid a malformed client payload corrupting the master order).
   Re-projects all of this visitor's lists on success. */
app.put('/api/visitor/:id/shelf-ranks', (req, res) => {
  const vid = req.params.id;
  const { ordered_keys } = req.body;

  if (!Array.isArray(ordered_keys)) {
    return res.status(400).json({ error: 'ordered_keys must be an array' });
  }

  /* validate every key — same shape rules as the rest of the app */
  for (const k of ordered_keys) {
    if (!k || typeof k !== 'object') return res.status(400).json({ error: 'invalid key' });
    if (!Number.isInteger(k.tmdb_id) || k.tmdb_id <= 0) {
      return res.status(400).json({ error: 'invalid tmdb_id in key' });
    }
    if (k.media_type !== 'movie' && k.media_type !== 'tv') {
      return res.status(400).json({ error: 'invalid media_type in key' });
    }
  }

  const visitor = db.prepare('SELECT id FROM visitors WHERE id = ?').get(vid);
  if (!visitor) return res.status(404).json({ error: 'visitor not found' });

  try {
    const tx = db.transaction(() => {
      setMasterProjectionByKeys(vid, ordered_keys);
      reprojectAllListsForVisitor(vid);
    });
    tx();
  } catch (e) {
    if (/^key not in master/.test(e.message)) {
      return res.status(400).json({ error: e.message });
    }
    throw e;
  }

  res.json({ ok: true });
});


/* DELETE /api/visitor/:id — only succeeds if the visitor is "untouched":
   no name set AND no slot in any list. Used by the Details paste flow when
   a brand-new visitor adopts an existing ID and we want to recycle the
   freshly-generated cookie ID rather than leave an orphan visitor row. */
app.delete('/api/visitor/:id', (req, res) => {
  const id = req.params.id;
  const v = db.prepare('SELECT * FROM visitors WHERE id = ?').get(id);
  if (!v) return res.json({ ok: true, deleted: false });             // already gone

  const hasName = v.name && v.name.trim() !== '';
  const memberships = db.prepare(
    'SELECT COUNT(*) as n FROM list_visitors WHERE visitor_id = ?'
  ).get(id).n;

  if (hasName || memberships > 0) {
    return res.status(403).json({ error: 'visitor not untouched', deleted: false });
  }

  db.prepare('DELETE FROM visitors WHERE id = ?').run(id);
  res.json({ ok: true, deleted: true });
});


/* ============================================================================
   SECTION 5: GET LIST — GET /api/list/:id
   ============================================================================
   Returns everything about a list in one response:
   {
     list:     { id, created },
     visitors: { "1": { id, name, color, slot }, "2": { ... }, ... },
     movies:   [ { id, tmdb_id, title, year, poster, added_by,
                   user1_rank, user1_comment, user2_rank, ... }, ... ]
   }

   Visitors are keyed by SLOT NUMBER (not visitor ID). This makes it easy
   for app.js to know "user3_rank belongs to the visitor in slot 3".

   Movies come back with all 20 rank/comment columns. Slots without a
   visitor assigned will have NULL in their columns — app.js ignores those.
   ============================================================================ */

app.get('/api/list/:id', (req, res) => {
  const listId = req.params.id;

  /* fetch the list itself */
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list) return res.status(404).json({ error: 'list not found' });

  /* fetch all movies — they already contain ranks and comments inline */
  const movies = db.prepare('SELECT * FROM movies WHERE list_id = ?').all(listId);

  /* fetch slot assignments and look up each visitor's profile */
  const slots = db.prepare('SELECT * FROM list_visitors WHERE list_id = ?').all(listId);
  const visitors = {};                                             // keyed by slot number
  slots.forEach(s => {
    const v = db.prepare('SELECT * FROM visitors WHERE id = ?').get(s.visitor_id);
    if (v) {
      visitors[s.slot] = {
        id: v.id, name: v.name, color: v.color, slot: s.slot,
        ready: s.ready !== 0
      };
    }
  });

  res.json({ list, visitors, movies });
});


/* ============================================================================
   SECTION 6: JOIN LIST — POST /api/list/:id/join
   ============================================================================
   Assigns a visitor to the next available slot (1-10) on this list, then
   ensures they have a master_rank entry for every movie already on the list
   (appending unfamiliar keys at the end of their master order, leaving any
   keys they already had alone). Re-projects userN_rank cache for this
   visitor's slot.

   Body: { visitor_id }
   Returns: { slot: N }
   ============================================================================ */

app.post('/api/list/:id/join', (req, res) => {
  const listId = req.params.id;
  const { visitor_id } = req.body;

  const existingList = db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!existingList) {
    db.prepare('INSERT INTO lists (id, created) VALUES (?, ?)')
      .run(listId, new Date().toISOString().split('T')[0]);
  }

  const existing = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
  ).get(listId, visitor_id);
  if (existing) return res.json({ slot: existing.slot });

  const taken = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? ORDER BY slot'
  ).all(listId).map(r => r.slot);
  let nextSlot = null;
  for (let s = 1; s <= 10; s++) {
    if (!taken.includes(s)) { nextSlot = s; break; }
  }
  if (!nextSlot) return res.status(400).json({ error: 'list full (max 10 visitors)' });

  const join = db.transaction(() => {
    db.prepare('INSERT INTO list_visitors (list_id, slot, visitor_id) VALUES (?, ?, ?)')
      .run(listId, nextSlot, visitor_id);

    const existingMovies = db.prepare(
      'SELECT tmdb_id, media_type FROM movies WHERE list_id = ? ORDER BY id'
    ).all(listId);
    existingMovies.forEach(m => {
      ensureUserMovieKeepOrAppend(visitor_id, m.tmdb_id, m.media_type);
    });

    /* master_rank may have grown — re-project every list this visitor is on */
    reprojectAllListsForVisitor(visitor_id);
  });
  join();

  res.json({ slot: nextSlot });
});


/* ============================================================================
   SECTION 7: CHECK NAME — GET /api/list/:id/check-name/:name
   ============================================================================
   Checks if a name is already used by a DIFFERENT visitor on this list.
   Query param: ?visitor_id=xxx (the current visitor, excluded from check)
   Returns { taken: true } or { taken: false }.
   ============================================================================ */

app.get('/api/list/:id/check-name/:name', (req, res) => {
  const listId = req.params.id;
  const name = req.params.name;
  const excludeVisitor = req.query.visitor_id;

  /* find all visitor IDs on this list via list_visitors (much simpler than v1) */
  const slots = db.prepare(
    'SELECT visitor_id FROM list_visitors WHERE list_id = ?'
  ).all(listId);

  let taken = false;
  slots.forEach(s => {
    if (s.visitor_id === excludeVisitor) return;                   // skip ourselves
    const v = db.prepare('SELECT name FROM visitors WHERE id = ?').get(s.visitor_id);
    if (v && v.name && v.name.toLowerCase() === name.toLowerCase()) {
      taken = true;
    }
  });

  res.json({ taken });
});


/* ============================================================================
   SECTION 8: ADD MOVIE — POST /api/list/:id/movies
   ============================================================================
   Adds a movie to a list. Creates the list if it doesn't exist yet.

   Body: { tmdb_id, media_type, title, year, poster, visitor_id }
     media_type is 'movie' or 'tv'; defaults to 'movie' so older clients keep working.

   After inserting the movie:
   1. If the visitor doesn't have a slot yet, auto-join them (next open slot)
      and ensure their master_rank entries exist for every pre-existing movie
      on the list (appended at the end of their master order).
   2. The adder gets the new movie at master_rank = 1 (everything else of
      theirs shifts down by 1). Other visitors on the list get the new movie
      appended to the end of their master order — UNLESS they already had a
      master_rank for the same (tmdb_id, media_type) from another list, in
      which case their existing position is preserved.
   3. Re-projects userN_rank cache for every occupied slot on the list.
   ============================================================================ */

app.post('/api/list/:id/movies', (req, res) => {
  const listId = req.params.id;
  const { tmdb_id, title, year, poster, visitor_id } = req.body;
  /* TMDB uses separate ID spaces for movies and TV, so we key duplicates on both. */
  const mediaType = req.body.media_type === 'tv' ? 'tv' : 'movie';

  /* SECURITY: validate fields that get string-concatenated into HTML on the
     client. None of these reach SQL unsafely (better-sqlite3 binds them as
     `?` parameters), but the frontend builds movie rows by concatenating
     `poster`, `year`, and `tmdb_id` directly into <img src="...">,
     <div data-tmdb-id="...">, and raw text inside titleHtml. Without
     validation, a malicious POST could plant stored XSS that executes in
     every visitor's browser when they load the list — letting the attacker
     steal their 10-char visitor cookie, which IS the identity in this app.

     tmdb_id: positive integer or null (null is allowed because the Details
              paste flow can create movies without a TMDB ID).
     year:    null/empty/"?" pass through unchanged; otherwise must be a
              4-digit number in [1800, 2100]. The literal "?" is the
              frontend's "no release date" sentinel and is safe — it can't
              encode HTML.
     poster:  null/empty pass through; otherwise must look like a TMDB
              poster path (`/<alphanum-dot-dash-underscore>+`). Excludes
              spaces, quotes, angle brackets — anything that could break
              out of the src="..." attribute. */
  let tmdbIdNum;
  if (tmdb_id == null) {
    tmdbIdNum = null;
  } else {
    tmdbIdNum = Number(tmdb_id);
    if (!Number.isInteger(tmdbIdNum) || tmdbIdNum <= 0) {
      return res.status(400).json({ error: 'invalid tmdb_id' });
    }
  }

  let validYear;
  if (year == null || year === '' || year === '?') {
    validYear = (year === '?') ? '?' : null;
  } else {
    const yearNum = Number(year);
    if (!Number.isInteger(yearNum) || yearNum < 1800 || yearNum > 2100) {
      return res.status(400).json({ error: 'invalid year' });
    }
    validYear = yearNum;
  }

  let validPoster;
  if (poster == null || poster === '') {
    validPoster = null;
  } else if (typeof poster === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(poster)) {
    validPoster = poster;
  } else {
    return res.status(400).json({ error: 'invalid poster path' });
  }

  /* create the list if it doesn't exist yet */
  const existingList = db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!existingList) {
    db.prepare('INSERT INTO lists (id, created) VALUES (?, ?)')
      .run(listId, new Date().toISOString().split('T')[0]);
  }

  /* check for duplicate — same TMDB item already on this list (id+type).
     A NULL tmdbIdNum can't collide because SQL NULL never equals NULL. */
  if (tmdbIdNum != null) {
    const existing = db.prepare(
      'SELECT * FROM movies WHERE list_id = ? AND tmdb_id = ? AND media_type = ?'
    ).get(listId, tmdbIdNum, mediaType);
    if (existing) return res.json(existing);
  }

  /* All the writes below run inside a single transaction so an error mid-way
     leaves the DB in its prior state. */
  const addTx = db.transaction(() => {
    let slot = db.prepare(
      'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
    ).get(listId, visitor_id);

    if (!slot) {
      const taken = db.prepare(
        'SELECT slot FROM list_visitors WHERE list_id = ? ORDER BY slot'
      ).all(listId).map(r => r.slot);
      let nextSlot = null;
      for (let s = 1; s <= 10; s++) {
        if (!taken.includes(s)) { nextSlot = s; break; }
      }
      if (!nextSlot) throw new Error('list full');

      db.prepare('INSERT INTO list_visitors (list_id, slot, visitor_id) VALUES (?, ?, ?)')
        .run(listId, nextSlot, visitor_id);
      slot = { slot: nextSlot };

      /* new joiner: ensure master_rank entries for every pre-existing movie */
      const existingMovies = db.prepare(
        'SELECT tmdb_id, media_type FROM movies WHERE list_id = ? ORDER BY id'
      ).all(listId);
      existingMovies.forEach(m => {
        ensureUserMovieKeepOrAppend(visitor_id, m.tmdb_id, m.media_type);
      });
    }

    const result = db.prepare(
      'INSERT INTO movies (list_id, tmdb_id, media_type, title, year, poster, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(listId, tmdbIdNum, mediaType, title, validYear, validPoster, visitor_id);
    const newMovieId = result.lastInsertRowid;

    /* update master_rank for every occupied slot on this list:
       adder → master_rank 1 (bump everything else down)
       others → keep existing master_rank, or append at end if absent */
    const slots = db.prepare(
      'SELECT slot, visitor_id FROM list_visitors WHERE list_id = ?'
    ).all(listId);
    slots.forEach(s => {
      const v = db.prepare('SELECT id FROM visitors WHERE id = ?').get(s.visitor_id);
      if (!v) return;                                                // orphan slot, skip
      if (s.visitor_id === visitor_id) {
        ensureUserMovieAtTop(s.visitor_id, tmdbIdNum, mediaType);
      } else {
        ensureUserMovieKeepOrAppend(s.visitor_id, tmdbIdNum, mediaType);
      }
    });

    /* re-project: master_rank changed for every visitor on this list, and
       those changes propagate to all OTHER lists those visitors are on too */
    slots.forEach(s => {
      reprojectAllListsForVisitor(s.visitor_id);
    });

    return newMovieId;
  });

  let newMovieId;
  try {
    newMovieId = addTx();
  } catch (e) {
    if (e.message === 'list full') return res.status(400).json({ error: 'list full' });
    throw e;
  }

  const newMovie = db.prepare('SELECT * FROM movies WHERE id = ?').get(newMovieId);
  res.json(newMovie);
});


/* ============================================================================
   SECTION 9: REMOVE MOVIE — DELETE /api/list/:id/movies/:movieId
   ============================================================================
   Removes a movie from the list. Only the person who added it can remove it.

   After deletion:
   - If the same (tmdb_id, media_type) is still present on some other list,
     master_rank entries stay (the key still belongs in the visitor's shelf).
   - If this was the last copy anywhere in the DB, every visitor's
     user_movies row for it is dropped and their master_rank is re-compacted.
   - userN_rank cache is re-projected for every occupied slot on this list.
   ============================================================================ */

app.delete('/api/list/:id/movies/:movieId', (req, res) => {
  const listId = req.params.id;
  const movieId = parseInt(req.params.movieId);
  const { visitor_id } = req.body;

  const movie = db.prepare('SELECT * FROM movies WHERE id = ? AND list_id = ?')
    .get(movieId, listId);
  if (!movie) return res.status(404).json({ error: 'movie not found' });
  if (movie.added_by !== visitor_id) return res.status(403).json({ error: 'not your movie' });

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM movies WHERE id = ?').run(movieId);
    const orphaned = cleanupOrphanedKey(movie.tmdb_id, movie.media_type);

    if (orphaned) {
      /* every visitor who had this key needs every one of their lists
         re-projected, since their master_rank changed */
      const allVisitors = db.prepare(
        'SELECT DISTINCT visitor_id FROM list_visitors'
      ).all().map(r => r.visitor_id);
      allVisitors.forEach(v => reprojectAllListsForVisitor(v));
    } else {
      /* key still exists somewhere — only this list's cache changed */
      reprojectListForAllVisitors(listId);
    }
  });
  tx();

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10: SWAP RANK — PUT /api/list/:id/swap
   ============================================================================
   Moves a movie up or down by one position in a visitor's ranking.

   Body: { slot, movieId, direction: "up" | "down" }
     "up"   — list-rank gets SMALLER (closer to #1)
     "down" — list-rank gets BIGGER  (further from #1)

   Implementation: read the current list order (by userN_rank cache), swap
   the dragged movie with its visible neighbor, then call setListProjection
   which permutes the master_rank slots and re-projects the cache. End state:
   master_rank stays contiguous, userN_rank cache reflects the new order.
   ============================================================================ */

function readSlotOwner (listId, slotNum) {
  return db.prepare(
    'SELECT visitor_id FROM list_visitors WHERE list_id = ? AND slot = ?'
  ).get(listId, slotNum);
}

function readListOrder (listId, slotNum) {
  const col = 'user' + slotNum + '_rank';
  return db.prepare(
    'SELECT id FROM movies WHERE list_id = ? '
    + 'ORDER BY ' + col + ' IS NULL, ' + col + ', id'
  ).all(listId).map(r => r.id);
}

app.put('/api/list/:id/swap', (req, res) => {
  const listId = req.params.id;
  const { slot, movieId, direction } = req.body;

  const slotNum = Number(slot);
  if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > 10) {
    return res.status(400).json({ error: 'invalid slot' });
  }

  const owner = readSlotOwner(listId, slotNum);
  if (!owner) return res.status(400).json({ error: 'slot not assigned' });

  const order = readListOrder(listId, slotNum);
  const idx = order.indexOf(parseInt(movieId));
  if (idx < 0) return res.status(404).json({ error: 'movie not on this list' });

  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= order.length) return res.json({ ok: true });

  /* swap the two array elements */
  [order[idx], order[targetIdx]] = [order[targetIdx], order[idx]];

  const tx = db.transaction(() => {
    setListProjection(owner.visitor_id, listId, order);
    reprojectAllListsForVisitor(owner.visitor_id);
  });
  tx();

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10b: MOVE TO TOP/BOTTOM — PUT /api/list/:id/move
   ============================================================================
   Moves a movie to list-rank 1 (top) or last place (bottom) for one visitor.
   Body: { slot, movieId, direction: "top" | "bottom" }
   ============================================================================ */

app.put('/api/list/:id/move', (req, res) => {
  const listId = req.params.id;
  const { slot, movieId, direction } = req.body;

  const slotNum = Number(slot);
  if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > 10) {
    return res.status(400).json({ error: 'invalid slot' });
  }

  const owner = readSlotOwner(listId, slotNum);
  if (!owner) return res.status(400).json({ error: 'slot not assigned' });

  const order = readListOrder(listId, slotNum);
  const mid = parseInt(movieId);
  const idx = order.indexOf(mid);
  if (idx < 0) return res.status(404).json({ error: 'movie not on this list' });

  /* pull out and re-insert at the right end */
  order.splice(idx, 1);
  if (direction === 'top') order.unshift(mid);
  else order.push(mid);

  const tx = db.transaction(() => {
    setListProjection(owner.visitor_id, listId, order);
    reprojectAllListsForVisitor(owner.visitor_id);
  });
  tx();

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10c: BULK RANK RESET — PUT /api/list/:id/my-ranks
   ============================================================================
   Sets one visitor's full list ordering at once. Body: { visitor_id,
   ordered_movie_ids: [int, ...] }. Movies on the list but absent from the
   array get appended (preserving current relative order).
   ============================================================================ */

app.put('/api/list/:id/my-ranks', (req, res) => {
  const listId = req.params.id;
  const { visitor_id, ordered_movie_ids } = req.body;

  const slotRow = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
  ).get(listId, visitor_id);
  if (!slotRow) return res.status(400).json({ error: 'visitor not on this list' });

  const tx = db.transaction(() => {
    setListProjection(visitor_id, listId, ordered_movie_ids);
    reprojectAllListsForVisitor(visitor_id);
  });
  tx();

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10d: SET READY — PUT /api/list/:id/ready
   ============================================================================
   Sets a visitor's RDY/NAW flag on this list. The flag lives in list_visitors
   so everyone viewing the list sees the same state. The Couch tab's Borda
   count only includes slots whose ready = 1.

   Body: { visitor_id, ready }   (ready is truthy/falsy)
   ============================================================================ */

app.put('/api/list/:id/ready', (req, res) => {
  const listId = req.params.id;
  const { visitor_id, ready } = req.body;

  const slotRow = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
  ).get(listId, visitor_id);
  if (!slotRow) return res.status(400).json({ error: 'visitor not on this list' });

  db.prepare(
    'UPDATE list_visitors SET ready = ? WHERE list_id = ? AND visitor_id = ?'
  ).run(ready ? 1 : 0, listId, visitor_id);

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 11: SAVE COMMENT — PUT /api/list/:id/comments
   ============================================================================
   Creates or updates a visitor's comment on a movie.

   Body: { movie_id, visitor_id, text }

   Looks up the visitor's slot from list_visitors, then updates the
   corresponding userN_comment column on the movie row.
   If text is empty, sets the column to NULL (removes the comment).
   ============================================================================ */

app.put('/api/list/:id/comments', (req, res) => {
  const listId = req.params.id;
  const { movie_id, visitor_id, text } = req.body;

  /* find this visitor's slot on this list */
  const slotRow = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
  ).get(listId, visitor_id);
  if (!slotRow) return res.status(400).json({ error: 'visitor not on this list' });

  const col = 'user' + slotRow.slot + '_comment';
  const value = (text && text.trim() !== '') ? text.trim() : null; // empty → NULL

  db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ? AND list_id = ?')
    .run(value, movie_id, listId);

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 12: CATCH-ALL ROUTE — serve index.html for any unknown path
   ============================================================================ */

app.get('*', (req, res) => {
  /* Same no-store as the static handler — this route fires for list-ID
     URLs like /Ab3xPq9K and must never be cached by the browser. */
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


/* ============================================================================
   SECTION 13: START THE SERVER
   ============================================================================ */

app.listen(PORT, () => {
  console.log('couchlist server running on http://localhost:' + PORT);
});
