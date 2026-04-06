/* ============================================================================
   server.js — whatdoyouwannawatch.com
   ============================================================================
   This is the entire backend. It does three things:

   1. Serves the static files (index.html, style.css, app.js) from public/
   2. Provides a JSON API that app.js calls via fetch()
   3. Stores everything in a SQLite database file (whattowatch.db)

   The API never talks to TMDB — that happens directly from the browser.
   This server only handles our own data: visitors, lists, movies, rankings,
   and comments.

   DEPENDENCIES (listed in package.json):
     express         — web framework, handles routing and static files
     better-sqlite3  — SQLite driver, synchronous API (no callbacks/promises
                       needed for DB calls — simpler code)

   HOW TO RUN:
     npm install          — downloads dependencies into node_modules/
     node server.js       — starts the server on port 3000
     open localhost:3000   — browser loads index.html, app.js takes over

   DATABASE:
     SQLite stores everything in a single file: whattowatch.db
     The file is auto-created on first run. Tables are auto-created too.
     No database server to install, no configuration, no connection strings.
     To reset everything: just delete whattowatch.db and restart.
   ============================================================================ */


/* ============================================================================
   SECTION 1: IMPORTS AND SETUP
   ============================================================================
   Load Express and better-sqlite3, create the app, open the database.

   Express is the web framework — it handles HTTP requests and responses.
   better-sqlite3 is synchronous, which means we can write:
     const row = db.prepare('SELECT ...').get(id);
   instead of:
     db.query('SELECT ...', [id], (err, rows) => { ... });
   Much simpler to read and reason about.

   The database file lives next to server.js (not in public/ — we don't
   want browsers to download it). If it doesn't exist, better-sqlite3
   creates it automatically.
   ============================================================================ */

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database(path.join(__dirname, 'whattowatch.db'));
db.pragma('journal_mode = WAL');


/* ============================================================================
   SECTION 2: DATABASE SCHEMA
   ============================================================================
   Create tables if they don't already exist. This runs every time the
   server starts, but "IF NOT EXISTS" means it's a no-op after the first run.

   Five tables (matching the schema in Outline.txt):

   visitors  — one row per person, shared across all lists
               id is the 10-char visitor ID from the cookie
               name + color are set when the visitor enters their name

   lists     — one row per list, created when the first movie is added
               id is the 8-char code from the URL

   movies    — one row per movie on a list
               id is auto-incrementing (SQLite handles this)
               tmdb_id is TMDB's ID for fetching poster/details from browser
               title/year/poster are cached so the list loads without TMDB calls

   rankings  — one row per movie per visitor per list
               position is 1-based (1 = top pick)
               when a visitor reorders, we DELETE all their rows and re-INSERT

   comments  — one row per visitor per movie per list
               UNIQUE constraint means PUT = INSERT OR REPLACE (upsert)
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

  CREATE TABLE IF NOT EXISTS movies (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id  TEXT,
    tmdb_id  INTEGER,
    title    TEXT,
    year     INTEGER,
    poster   TEXT,
    added_by TEXT
  );

  CREATE TABLE IF NOT EXISTS rankings (
    list_id    TEXT,
    visitor_id TEXT,
    movie_id   INTEGER,
    position   INTEGER
  );

  CREATE TABLE IF NOT EXISTS comments (
    list_id    TEXT,
    movie_id   INTEGER,
    visitor_id TEXT,
    text       TEXT,
    UNIQUE(list_id, movie_id, visitor_id)
  );
`);


/* ============================================================================
   SECTION 3: MIDDLEWARE
   ============================================================================
   Express middleware runs on every request before the route handler.

   express.json()       — parses JSON request bodies (POST/PUT with
                           Content-Type: application/json) so we can
                           read req.body as a JavaScript object

   express.static()     — serves files from public/ directory.
                           GET /style.css → sends public/style.css
                           GET /app.js → sends public/app.js
                           GET / → sends public/index.html (default)
   ============================================================================ */

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


/* ============================================================================
   SECTION 4: VISITOR ENDPOINTS
   ============================================================================
   GET  /api/visitor/:id   — look up a visitor by their 10-char ID
                              returns { id, name, color } or 404

   PUT  /api/visitor/:id   — create or update a visitor
                              body: { name, color }
                              returns { id, name, color }

   The PUT uses INSERT OR REPLACE — if the visitor ID exists, the row is
   replaced. If it doesn't exist, a new row is created. Either way, we
   return the current state of the visitor.
   ============================================================================ */

app.get('/api/visitor/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM visitors WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'visitor not found' });
  res.json(row);
});

app.put('/api/visitor/:id', (req, res) => {
  const { name, color } = req.body;
  db.prepare('INSERT OR REPLACE INTO visitors (id, name, color) VALUES (?, ?, ?)')
    .run(req.params.id, name, color);
  res.json({ id: req.params.id, name, color });
});


/* ============================================================================
   SECTION 5: LIST ENDPOINT — GET /api/list/:id
   ============================================================================
   Returns everything about a list in one response:
   {
     list:     { id, created },
     movies:   [ { id, tmdb_id, title, year, poster, added_by }, ... ],
     visitors: [ { id, name, color }, ... ],
     rankings: { visitorId: [movieId, movieId, ...], ... },
     comments: [ { movie_id, visitor_id, text }, ... ]
   }

   The "visitors" array contains only visitors who are active on THIS list
   (they've added a movie, ranked, or commented). We figure this out by
   looking at who appears in movies.added_by, rankings.visitor_id, or
   comments.visitor_id for this list.

   Rankings are returned as an object keyed by visitor ID, where each value
   is an ordered array of movie IDs. This is what app.js expects — it
   matches the structure of the myRanking state variable.
   ============================================================================ */

app.get('/api/list/:id', (req, res) => {
  const listId = req.params.id;

  /* fetch the list itself */
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list) return res.status(404).json({ error: 'list not found' });

  /* fetch all movies on this list */
  const movies = db.prepare('SELECT * FROM movies WHERE list_id = ?').all(listId);

  /* figure out which visitor IDs are active on this list */
  const visitorIds = new Set();
  movies.forEach(m => visitorIds.add(m.added_by));

  const rankingRows = db.prepare('SELECT * FROM rankings WHERE list_id = ? ORDER BY position')
    .all(listId);
  rankingRows.forEach(r => visitorIds.add(r.visitor_id));

  const comments = db.prepare('SELECT * FROM comments WHERE list_id = ?').all(listId);
  comments.forEach(c => visitorIds.add(c.visitor_id));

  /* fetch visitor profiles for all active visitor IDs */
  const visitors = [];
  visitorIds.forEach(vid => {
    const v = db.prepare('SELECT * FROM visitors WHERE id = ?').get(vid);
    if (v) visitors.push(v);
  });

  /* build rankings object: { visitorId: [movieId, movieId, ...] } */
  const rankings = {};
  rankingRows.forEach(r => {
    if (!rankings[r.visitor_id]) rankings[r.visitor_id] = [];
    rankings[r.visitor_id].push(r.movie_id);
  });

  res.json({ list, movies, visitors, rankings, comments });
});


/* ============================================================================
   SECTION 6: CHECK NAME — GET /api/list/:id/check-name/:name
   ============================================================================
   Checks if a name is already used by a DIFFERENT visitor on this list.
   Query param: ?visitor_id=xxx (the current visitor, excluded from check)

   Returns { taken: true } or { taken: false }.

   Used by app.js before creating/updating a visitor name, so we can warn
   the user that they'll appear as "Doug(2)" before it happens.

   "Active on this list" means the name belongs to a visitor who has added
   a movie, ranked, or commented on this specific list.
   ============================================================================ */

app.get('/api/list/:id/check-name/:name', (req, res) => {
  const listId = req.params.id;
  const name = req.params.name;                       // Express already decodes URL params
  const excludeVisitor = req.query.visitor_id;

  /* find all visitor IDs active on this list */
  const movies = db.prepare('SELECT DISTINCT added_by FROM movies WHERE list_id = ?').all(listId);
  const ranks = db.prepare('SELECT DISTINCT visitor_id FROM rankings WHERE list_id = ?').all(listId);
  const comms = db.prepare('SELECT DISTINCT visitor_id FROM comments WHERE list_id = ?').all(listId);

  const activeIds = new Set();
  movies.forEach(m => activeIds.add(m.added_by));
  ranks.forEach(r => activeIds.add(r.visitor_id));
  comms.forEach(c => activeIds.add(c.visitor_id));

  /* check if any active visitor (other than us) has this name */
  let taken = false;
  activeIds.forEach(vid => {
    if (vid === excludeVisitor) return;
    const v = db.prepare('SELECT name FROM visitors WHERE id = ?').get(vid);
    if (v && v.name && v.name.toLowerCase() === name.toLowerCase()) {
      taken = true;
    }
  });

  res.json({ taken });
});


/* ============================================================================
   SECTION 7: ADD MOVIE — POST /api/list/:id/movies
   ============================================================================
   Adds a movie to a list. Creates the list if it doesn't exist yet
   (first movie added = list created).

   Body: { tmdb_id, title, year, poster, visitor_id }

   Checks for duplicates — if this tmdb_id is already on this list, returns
   the existing movie instead of adding a duplicate.

   Returns the movie row (with its auto-generated id).
   ============================================================================ */

app.post('/api/list/:id/movies', (req, res) => {
  const listId = req.params.id;
  const { tmdb_id, title, year, poster, visitor_id } = req.body;

  /* create the list if it doesn't exist yet */
  const existingList = db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!existingList) {
    db.prepare('INSERT INTO lists (id, created) VALUES (?, ?)').run(listId, new Date().toISOString().split('T')[0]);
  }

  /* check for duplicate — same TMDB movie already on this list */
  const existing = db.prepare('SELECT * FROM movies WHERE list_id = ? AND tmdb_id = ?')
    .get(listId, tmdb_id);
  if (existing) return res.json(existing);

  /* insert the movie */
  const result = db.prepare(
    'INSERT INTO movies (list_id, tmdb_id, title, year, poster, added_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(listId, tmdb_id, title, year, poster, visitor_id);

  res.json({ id: result.lastInsertRowid, list_id: listId, tmdb_id, title, year, poster, added_by: visitor_id });
});


/* ============================================================================
   SECTION 8: REMOVE MOVIE — DELETE /api/list/:id/movies/:movieId
   ============================================================================
   Removes a movie from the list. Only the person who added it can remove it
   (body must include visitor_id matching the movie's added_by).

   Also cleans up: removes all rankings and comments for this movie,
   since they'd be orphaned.
   ============================================================================ */

app.delete('/api/list/:id/movies/:movieId', (req, res) => {
  const listId = req.params.id;
  const movieId = parseInt(req.params.movieId);
  const { visitor_id } = req.body;

  /* verify ownership */
  const movie = db.prepare('SELECT * FROM movies WHERE id = ? AND list_id = ?').get(movieId, listId);
  if (!movie) return res.status(404).json({ error: 'movie not found' });
  if (movie.added_by !== visitor_id) return res.status(403).json({ error: 'not your movie' });

  /* delete the movie and its related data */
  db.prepare('DELETE FROM movies WHERE id = ?').run(movieId);
  db.prepare('DELETE FROM rankings WHERE list_id = ? AND movie_id = ?').run(listId, movieId);
  db.prepare('DELETE FROM comments WHERE list_id = ? AND movie_id = ?').run(listId, movieId);

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 9: SAVE RANKINGS — PUT /api/list/:id/rankings
   ============================================================================
   Replaces a visitor's entire ranking for a list.

   Body: { visitor_id, ranking: [movieId, movieId, ...] }

   Strategy: DELETE all existing rankings for this visitor on this list,
   then INSERT each movie at its new position. This is simpler and safer
   than trying to UPDATE individual rows — we're replacing the whole order.

   The ranking array is ordered: index 0 = position 1, index 1 = position 2, etc.
   ============================================================================ */

app.put('/api/list/:id/rankings', (req, res) => {
  const listId = req.params.id;
  const { visitor_id, ranking } = req.body;

  /* delete all existing rankings for this visitor on this list */
  db.prepare('DELETE FROM rankings WHERE list_id = ? AND visitor_id = ?').run(listId, visitor_id);

  /* insert each movie at its position */
  const insert = db.prepare(
    'INSERT INTO rankings (list_id, visitor_id, movie_id, position) VALUES (?, ?, ?, ?)'
  );

  ranking.forEach((movieId, index) => {
    insert.run(listId, visitor_id, movieId, index + 1);
  });

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 10: SAVE COMMENT — PUT /api/list/:id/comments
   ============================================================================
   Creates or updates a visitor's comment on a movie.

   Body: { movie_id, visitor_id, text }

   Uses INSERT OR REPLACE with the UNIQUE constraint on
   (list_id, movie_id, visitor_id) — if this visitor already has a comment
   on this movie, it's replaced. If not, a new one is created.

   If the text is empty, we DELETE the comment instead of saving blank text.
   ============================================================================ */

app.put('/api/list/:id/comments', (req, res) => {
  const listId = req.params.id;
  const { movie_id, visitor_id, text } = req.body;

  if (!text || text.trim() === '') {
    /* empty comment = delete it */
    db.prepare('DELETE FROM comments WHERE list_id = ? AND movie_id = ? AND visitor_id = ?')
      .run(listId, movie_id, visitor_id);
  } else {
    /* create or update the comment */
    db.prepare(
      'INSERT OR REPLACE INTO comments (list_id, movie_id, visitor_id, text) VALUES (?, ?, ?, ?)'
    ).run(listId, movie_id, visitor_id, text);
  }

  res.json({ ok: true });
});


/* ============================================================================
   SECTION 11: CATCH-ALL ROUTE — serve index.html for any unknown path
   ============================================================================
   When the browser requests "/a1b2c3d4" (a list URL), Express doesn't have
   a matching static file or API route. Without this catch-all, it would
   return 404.

   Instead, we serve index.html for ALL non-API GET requests. Then app.js
   reads the URL path, extracts the list ID, and handles it from there.

   This is called "client-side routing" — the server always serves the same
   HTML page, and the JavaScript figures out what to show based on the URL.
   ============================================================================ */

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


/* ============================================================================
   SECTION 12: START THE SERVER
   ============================================================================
   Listen on the configured port (default 3000). Log a message so you know
   it's running. That's it — Express handles everything from here.
   ============================================================================ */

app.listen(PORT, () => {
  console.log('whattowatch server running on http://localhost:' + PORT);
});
