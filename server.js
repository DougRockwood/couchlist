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
   Assigns a visitor to the next available slot (1-10) on this list.
   If the visitor already has a slot, returns that slot.
   If all 10 slots are taken, returns an error.

   After assigning a slot, initializes ranks for all existing movies:
   each movie gets a sequential rank (1, 2, 3...) in movie-ID order.
   This means a new visitor immediately has a complete ranking — no gaps,
   no NULLs in their column.

   Body: { visitor_id }
   Returns: { slot: N }
   ============================================================================ */

app.post('/api/list/:id/join', (req, res) => {
  const listId = req.params.id;
  const { visitor_id } = req.body;

  /* create the list if it doesn't exist yet — so the first visitor to set
     their name on a brand-new URL becomes visible via GET /api/list/:id */
  const existingList = db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!existingList) {
    db.prepare('INSERT INTO lists (id, created) VALUES (?, ?)')
      .run(listId, new Date().toISOString().split('T')[0]);
  }

  /* check if this visitor already has a slot on this list */
  const existing = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
  ).get(listId, visitor_id);
  if (existing) return res.json({ slot: existing.slot });          // already joined

  /* find the next open slot (1-10) */
  const taken = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? ORDER BY slot'
  ).all(listId).map(r => r.slot);

  let nextSlot = null;
  for (let s = 1; s <= 10; s++) {
    if (!taken.includes(s)) { nextSlot = s; break; }
  }
  if (!nextSlot) return res.status(400).json({ error: 'list full (max 10 visitors)' });

  /* assign the slot */
  db.prepare('INSERT INTO list_visitors (list_id, slot, visitor_id) VALUES (?, ?, ?)')
    .run(listId, nextSlot, visitor_id);

  /* initialize ranks for all existing movies in this slot's column
     each movie gets a sequential rank (1, 2, 3...) in movie-ID order */
  const movies = db.prepare(
    'SELECT id FROM movies WHERE list_id = ? ORDER BY id'
  ).all(listId);

  const col = 'user' + nextSlot + '_rank';
  const stmt = db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ?');
  movies.forEach((m, i) => {
    stmt.run(i + 1, m.id);                                         // rank 1, 2, 3, ...
  });

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
   1. If the visitor doesn't have a slot yet, auto-join them (next open slot).
   2. For every occupied slot, set that slot's rank for this movie to
      (current movie count) — the new movie starts at LAST PLACE for everyone.

   This guarantees: after adding a movie, every visitor has a rank for it,
   and no visitor has any gaps in their ranking numbers.
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

  /* check for duplicate — same TMDB item already on this list (id+type) */
  const existing = db.prepare(
    'SELECT * FROM movies WHERE list_id = ? AND tmdb_id = ? AND media_type = ?'
  ).get(listId, tmdbIdNum, mediaType);
  if (existing) return res.json(existing);

  /* auto-join: if this visitor has no slot, assign one now */
  let visitorSlot = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
  ).get(listId, visitor_id);

  if (!visitorSlot) {
    /* find next open slot */
    const taken = db.prepare(
      'SELECT slot FROM list_visitors WHERE list_id = ? ORDER BY slot'
    ).all(listId).map(r => r.slot);

    let nextSlot = null;
    for (let s = 1; s <= 10; s++) {
      if (!taken.includes(s)) { nextSlot = s; break; }
    }
    if (!nextSlot) return res.status(400).json({ error: 'list full' });

    db.prepare('INSERT INTO list_visitors (list_id, slot, visitor_id) VALUES (?, ?, ?)')
      .run(listId, nextSlot, visitor_id);
    visitorSlot = { slot: nextSlot };

    /* initialize this new visitor's ranks for all EXISTING movies */
    const existingMovies = db.prepare(
      'SELECT id FROM movies WHERE list_id = ? ORDER BY id'
    ).all(listId);
    const col = 'user' + nextSlot + '_rank';
    const initStmt = db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ?');
    existingMovies.forEach((m, i) => {
      initStmt.run(i + 1, m.id);
    });
  }

  /* insert the new movie — note we store the VALIDATED values (tmdbIdNum,
     validYear, validPoster), not the raw request body fields. */
  const result = db.prepare(
    'INSERT INTO movies (list_id, tmdb_id, media_type, title, year, poster, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(listId, tmdbIdNum, mediaType, title, validYear, validPoster, visitor_id);
  const newMovieId = result.lastInsertRowid;

  /* count total movies now (including the one we just added) — this is the
     new movie's rank (last place) for everyone */
  const movieCount = db.prepare(
    'SELECT COUNT(*) as n FROM movies WHERE list_id = ?'
  ).get(listId).n;

  /* set every occupied slot's rank for this new movie to last place,
     EXCEPT the adder gets it at #1 (bump all their other movies down) */
  const slots = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ?'
  ).all(listId);

  slots.forEach(s => {
    const col = 'user' + s.slot + '_rank';
    if (s.slot === visitorSlot.slot) {
      /* adder: bump all existing movies down by 1, then set new movie to rank 1 */
      db.prepare(
        'UPDATE movies SET ' + col + ' = ' + col + ' + 1 WHERE list_id = ? AND id != ?'
      ).run(listId, newMovieId);
      db.prepare('UPDATE movies SET ' + col + ' = 1 WHERE id = ?').run(newMovieId);
    } else {
      /* everyone else: new movie goes to last place */
      db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ?')
        .run(movieCount, newMovieId);
    }
  });

  /* return the full new movie row */
  const newMovie = db.prepare('SELECT * FROM movies WHERE id = ?').get(newMovieId);
  res.json(newMovie);
});


/* ============================================================================
   SECTION 9: REMOVE MOVIE — DELETE /api/list/:id/movies/:movieId
   ============================================================================
   Removes a movie from the list. Only the person who added it can remove it.

   After deleting, re-compacts ranks: for every occupied slot, any movie
   whose rank was GREATER than the deleted movie's rank gets decremented
   by 1. This keeps ranks contiguous (1, 2, 3... with no gaps).
   ============================================================================ */

app.delete('/api/list/:id/movies/:movieId', (req, res) => {
  const listId = req.params.id;
  const movieId = parseInt(req.params.movieId);
  const { visitor_id } = req.body;

  /* verify ownership */
  const movie = db.prepare('SELECT * FROM movies WHERE id = ? AND list_id = ?')
    .get(movieId, listId);
  if (!movie) return res.status(404).json({ error: 'movie not found' });
  if (movie.added_by !== visitor_id) return res.status(403).json({ error: 'not your movie' });

  /* for each occupied slot, find the deleted movie's rank and re-compact */
  const slots = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ?'
  ).all(listId);

  slots.forEach(s => {
    const col = 'user' + s.slot + '_rank';
    const deletedRank = movie[col];                                // what rank did this movie have?
    if (deletedRank != null) {
      /* decrement all ranks that were below (higher number = lower rank) */
      db.prepare(
        'UPDATE movies SET ' + col + ' = ' + col + ' - 1 '
        + 'WHERE list_id = ? AND ' + col + ' > ?'
      ).run(listId, deletedRank);
    }
  });

  /* now delete the movie row */
  db.prepare('DELETE FROM movies WHERE id = ?').run(movieId);

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10: SWAP RANK — PUT /api/list/:id/swap
   ============================================================================
   Moves a movie up or down by one position in a visitor's ranking.

   Body: { slot, movieId, direction: "up" | "down" }

   "up" means rank gets SMALLER (closer to #1).
   "down" means rank gets BIGGER (further from #1).

   Finds the movie at the target rank and swaps the two. Two UPDATEs.
   This replaces the old drag-and-drop system entirely.
   ============================================================================ */

app.put('/api/list/:id/swap', (req, res) => {
  const listId = req.params.id;
  const { slot, movieId, direction } = req.body;

  /* SECURITY: `slot` is concatenated into the SQL column name on the next
     line — `'user' + slot + '_rank'`. Every other endpoint that builds
     this column reads `slot` from the list_visitors table (where it's
     constrained to 1..10 by a CHECK), but /swap and /move take it
     directly from the request body. Without this guard, a payload like
     `1_rank = 0, list_id = 'other' --` produces a syntactically valid
     UPDATE that re-parents movie rows. better-sqlite3 blocks
     multi-statement strings, so DROP TABLE etc. is impossible, but
     re-parenting / clobbering columns is not. Restricting to a literal
     integer 1..10 closes the surface entirely. */
  const slotNum = Number(slot);
  if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > 10) {
    return res.status(400).json({ error: 'invalid slot' });
  }

  const col = 'user' + slotNum + '_rank';

  /* get the current rank of the movie being moved */
  const movie = db.prepare('SELECT id, ' + col + ' as rank FROM movies WHERE id = ? AND list_id = ?')
    .get(movieId, listId);
  if (!movie) return res.status(404).json({ error: 'movie not found' });

  /* calculate the target rank */
  const targetRank = direction === 'up' ? movie.rank - 1 : movie.rank + 1;

  /* bounds check: can't go above 1 or below movie count */
  const movieCount = db.prepare('SELECT COUNT(*) as n FROM movies WHERE list_id = ?').get(listId).n;
  if (targetRank < 1 || targetRank > movieCount) {
    return res.json({ ok: true });                                 // no-op, already at the edge
  }

  /* find the movie currently at the target rank */
  const other = db.prepare(
    'SELECT id FROM movies WHERE list_id = ? AND ' + col + ' = ?'
  ).get(listId, targetRank);

  if (!other) return res.json({ ok: true });                       // shouldn't happen, but safe

  /* swap: give our movie the target rank, give the other movie our old rank */
  db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ?').run(targetRank, movieId);
  db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ?').run(movie.rank, other.id);

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10b: MOVE TO TOP/BOTTOM — PUT /api/list/:id/move
   ============================================================================
   Moves a movie to rank 1 (top) or last place (bottom) in a visitor's ranking.

   Body: { slot, movieId, direction: "top" | "bottom" }

   Shifts all movies in between to fill the gap and make room.
   ============================================================================ */

app.put('/api/list/:id/move', (req, res) => {
  const listId = req.params.id;
  const { slot, movieId, direction } = req.body;

  /* SECURITY: same column-name injection risk as /swap above — `slot` is
     concatenated into the SQL column name. Restrict to integer 1..10. */
  const slotNum = Number(slot);
  if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > 10) {
    return res.status(400).json({ error: 'invalid slot' });
  }

  const col = 'user' + slotNum + '_rank';

  /* get the current rank of the movie being moved */
  const movie = db.prepare('SELECT id, ' + col + ' as rank FROM movies WHERE id = ? AND list_id = ?')
    .get(movieId, listId);
  if (!movie) return res.status(404).json({ error: 'movie not found' });

  const movieCount = db.prepare('SELECT COUNT(*) as n FROM movies WHERE list_id = ?').get(listId).n;
  const targetRank = (direction === 'top') ? 1 : movieCount;

  if (movie.rank === targetRank) return res.json({ ok: true });       // already there

  if (direction === 'top') {
    /* shift everything above (rank < current) down by 1 to make room at rank 1 */
    db.prepare(
      'UPDATE movies SET ' + col + ' = ' + col + ' + 1 WHERE list_id = ? AND ' + col + ' < ? AND id != ?'
    ).run(listId, movie.rank, movieId);
  } else {
    /* shift everything below (rank > current) up by 1 to fill the gap */
    db.prepare(
      'UPDATE movies SET ' + col + ' = ' + col + ' - 1 WHERE list_id = ? AND ' + col + ' > ? AND id != ?'
    ).run(listId, movie.rank, movieId);
  }

  /* set the movie to its new rank */
  db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ?').run(targetRank, movieId);

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10c: BULK RANK RESET — PUT /api/list/:id/my-ranks
   ============================================================================
   Resets the caller's personal ranking to match a given movie order. Used
   by the Details paste flow to apply the order of movies in the textarea
   to the current user's column. Movies present on the list but not in the
   supplied order are pushed past the ordered ones, keeping their current
   relative order. Ranks end up contiguous 1..N.

   Body: { visitor_id, ordered_movie_ids: [int, ...] }
   ============================================================================ */

app.put('/api/list/:id/my-ranks', (req, res) => {
  const listId = req.params.id;
  const { visitor_id, ordered_movie_ids } = req.body;

  const slotRow = db.prepare(
    'SELECT slot FROM list_visitors WHERE list_id = ? AND visitor_id = ?'
  ).get(listId, visitor_id);
  if (!slotRow) return res.status(400).json({ error: 'visitor not on this list' });

  const col = 'user' + slotRow.slot + '_rank';

  const allMovies = db.prepare(
    'SELECT id, ' + col + ' as rank FROM movies WHERE list_id = ?'
  ).all(listId);

  const orderedSet = new Set(ordered_movie_ids);
  const tail = allMovies
    .filter(m => !orderedSet.has(m.id))
    .sort((a, b) => {
      if (a.rank == null && b.rank == null) return 0;
      if (a.rank == null) return 1;
      if (b.rank == null) return -1;
      return a.rank - b.rank;
    });

  const update = db.prepare('UPDATE movies SET ' + col + ' = ? WHERE id = ? AND list_id = ?');
  let rank = 1;
  ordered_movie_ids.forEach(mid => { update.run(rank++, mid, listId); });
  tail.forEach(m => { update.run(rank++, m.id, listId); });

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
