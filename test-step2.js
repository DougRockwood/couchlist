/* test-step2.js — verifies the master_rank refactor.
   Run with the dev server up:  node test-step2.js

   Strategy: create an isolated test list with fresh test visitors so we
   never touch the real prod-snapshot data. Run each refactored endpoint
   and assert (a) master_rank stays contiguous 1..N per visitor, (b) the
   userN_rank cache is a valid projection of master_rank for each list/slot,
   (c) Doug's two worked reorder examples produce the expected outcomes.

   Cleanup at the end removes the test list, test visitors, and their
   user_movies rows so the script is rerunnable. */

const Database = require('better-sqlite3');
const http = require('http');
const path = require('path');

const db = new Database(path.join(__dirname, 'couchlist.db'));
const BASE = 'http://localhost:3000';

const TEST_LIST = 'tst12345';
const V1 = 'tstvisitor1';                                          // adder
const V2 = 'tstvisitor2';                                          // joiner
const TST_MOVIES = [
  { tmdb_id: 9991, media_type: 'movie', title: 'Test A', year: 2020 },
  { tmdb_id: 9992, media_type: 'movie', title: 'Test B', year: 2021 },
  { tmdb_id: 9993, media_type: 'movie', title: 'Test C', year: 2022 },
  { tmdb_id: 9994, media_type: 'movie', title: 'Test D', year: 2023 },
  { tmdb_id: 9995, media_type: 'movie', title: 'Test E', year: 2024 },
];

let pass = 0, fail = 0;
function assert (cond, msg) {
  if (cond) { console.log('  PASS  ' + msg); pass++; }
  else      { console.log('  FAIL  ' + msg); fail++; }
}
function section (name) { console.log('\n=== ' + name + ' ==='); }

function req (method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request(BASE + urlPath, opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function masterFor (visitor_id) {
  return db.prepare(
    'SELECT tmdb_id, master_rank FROM user_movies '
    + 'WHERE visitor_id = ? ORDER BY master_rank'
  ).all(visitor_id);
}

function checkMasterContiguous (visitor_id, label) {
  const rows = masterFor(visitor_id);
  let ok = true;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].master_rank !== i + 1) { ok = false; break; }
  }
  assert(ok, label + ': master_rank contiguous 1..' + rows.length + ' for ' + visitor_id);
}

function checkProjection (list_id, label) {
  const slots = db.prepare(
    'SELECT slot, visitor_id FROM list_visitors WHERE list_id = ?'
  ).all(list_id);
  for (const s of slots) {
    const col = 'user' + s.slot + '_rank';
    const projected = db.prepare(
      'SELECT m.id, m.tmdb_id, m.media_type, '
      + col + ' AS cached, um.master_rank '
      + 'FROM movies m '
      + 'LEFT JOIN user_movies um '
      + '  ON um.visitor_id = ? AND um.tmdb_id = m.tmdb_id AND um.media_type = m.media_type '
      + 'WHERE m.list_id = ? '
      + 'ORDER BY (um.master_rank IS NULL), um.master_rank, m.id'
    ).all(s.visitor_id, list_id);

    let ok = true;
    for (let i = 0; i < projected.length; i++) {
      if (projected[i].cached !== i + 1) { ok = false; break; }
    }
    assert(ok, label + ': slot ' + s.slot + ' (' + s.visitor_id + ') userN_rank matches projection');
  }
}

function listOrderForSlot (list_id, slotNum) {
  const col = 'user' + slotNum + '_rank';
  return db.prepare(
    'SELECT id FROM movies WHERE list_id = ? '
    + 'ORDER BY ' + col + ' IS NULL, ' + col + ', id'
  ).all(list_id).map(r => r.id);
}

function masterOrderTmdb (visitor_id) {
  return masterFor(visitor_id).map(r => r.tmdb_id);
}

async function cleanup () {
  /* delete in dependency order */
  db.prepare('DELETE FROM movies WHERE list_id = ?').run(TEST_LIST);
  db.prepare('DELETE FROM list_visitors WHERE list_id = ?').run(TEST_LIST);
  db.prepare('DELETE FROM lists WHERE id = ?').run(TEST_LIST);
  /* drop test visitors' user_movies (only TST tmdb_ids 9991..9999 to be safe) */
  db.prepare('DELETE FROM user_movies WHERE visitor_id IN (?, ?)').run(V1, V2);
  db.prepare('DELETE FROM visitors WHERE id IN (?, ?)').run(V1, V2);
}

async function main () {
  /* set up a fresh test playground */
  await cleanup();
  await req('PUT', '/api/visitor/' + V1, { name: 'TstOne', color: 'hsl(10, 60%, 54%)' });
  await req('PUT', '/api/visitor/' + V2, { name: 'TstTwo', color: 'hsl(200, 60%, 54%)' });

  section('add 3 movies as V1, sanity check');
  for (const m of TST_MOVIES.slice(0, 3)) {
    const r = await req('POST', '/api/list/' + TEST_LIST + '/movies',
      { ...m, visitor_id: V1 });
    assert(r.status === 200, 'POST /movies ' + m.title + ' → 200');
  }
  /* V1 added A, B, C — adder rule says each new add goes to top of master.
     Order of operations: add A → master [A]. Add B → master [B,A]. Add C → master [C,B,A]. */
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9993, 9992, 9991]),
    'V1 master order after adds: [C, B, A]');
  checkMasterContiguous(V1, 'after 3 adds');
  checkProjection(TEST_LIST, 'after 3 adds');

  section('V2 joins, ensures master_rank entries appended');
  const joinResp = await req('POST', '/api/list/' + TEST_LIST + '/join', { visitor_id: V2 });
  assert(joinResp.status === 200 && joinResp.body.slot === 2, 'V2 joined to slot 2');
  /* V2 had nothing before; bootstrap appends A, B, C in id order → [A, B, C] */
  assert(JSON.stringify(masterOrderTmdb(V2)) === JSON.stringify([9991, 9992, 9993]),
    'V2 master after join: [A, B, C] (id order)');
  checkMasterContiguous(V2, 'after V2 join');
  checkProjection(TEST_LIST, 'after V2 join');

  section('V1 adds D — adder gets it at master_rank 1');
  await req('POST', '/api/list/' + TEST_LIST + '/movies', { ...TST_MOVIES[3], visitor_id: V1 });
  /* V1 now: D at top, then prev order C, B, A */
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9994, 9993, 9992, 9991]),
    'V1 master after adding D: [D, C, B, A]');
  /* V2: D appended at end (V2 is non-adder for D) */
  assert(JSON.stringify(masterOrderTmdb(V2)) === JSON.stringify([9991, 9992, 9993, 9994]),
    'V2 master after V1 adds D: [A, B, C, D]');
  checkMasterContiguous(V1, 'after V1 adds D'); checkMasterContiguous(V2, 'after V1 adds D');
  checkProjection(TEST_LIST, 'after V1 adds D');

  section('PUT /swap — V1 swaps the top two on this list (D,C) → (C,D)');
  /* V1's slot is 1; their list order is [D, C, B, A]. Swap D down → [C, D, B, A]. */
  const v1Slot = db.prepare('SELECT slot FROM list_visitors WHERE list_id=? AND visitor_id=?')
    .get(TEST_LIST, V1).slot;
  const dMovieId = db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=9994').get(TEST_LIST).id;
  await req('PUT', '/api/list/' + TEST_LIST + '/swap',
    { slot: v1Slot, movieId: dMovieId, direction: 'down' });
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9993, 9994, 9992, 9991]),
    'V1 master after swap-D-down: [C, D, B, A]');
  checkMasterContiguous(V1, 'after swap');
  checkProjection(TEST_LIST, 'after swap');

  section('PUT /move — V1 moves A to top');
  const aMovieId = db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=9991').get(TEST_LIST).id;
  await req('PUT', '/api/list/' + TEST_LIST + '/move',
    { slot: v1Slot, movieId: aMovieId, direction: 'top' });
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9991, 9993, 9994, 9992]),
    'V1 master after move-A-top: [A, C, D, B]');
  checkMasterContiguous(V1, 'after move-top');
  checkProjection(TEST_LIST, 'after move-top');

  section('PUT /my-ranks — V1 sets order to [B, A, D, C]');
  const ids = ['B', 'A', 'D', 'C'].map(letter => {
    const tmdb = { A: 9991, B: 9992, C: 9993, D: 9994 }[letter];
    return db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=?').get(TEST_LIST, tmdb).id;
  });
  await req('PUT', '/api/list/' + TEST_LIST + '/my-ranks',
    { visitor_id: V1, ordered_movie_ids: ids });
  /* Pre-state V1 master: [A=1, C=2, D=3, B=4]. List has all 4 movies, so list-slots = {1,2,3,4}.
     Target list order = [B, A, D, C]. Assign B→1, A→2, D→3, C→4.
     Resulting master order: [B, A, D, C]. */
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9992, 9991, 9994, 9993]),
    'V1 master after my-ranks [B,A,D,C]');
  checkMasterContiguous(V1, 'after my-ranks');
  checkProjection(TEST_LIST, 'after my-ranks');

  section('DELETE — V1 removes A. A is unique to this list → user_movies rows drop for both.');
  await req('DELETE', '/api/list/' + TEST_LIST + '/movies/' + aMovieId,
    { visitor_id: V1 });
  /* V1 master had [B=1, A=2, D=3, C=4]; remove A → [B=1, D=2, C=3] */
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9992, 9994, 9993]),
    'V1 master after delete-A: [B, D, C]');
  /* V2 master had [A=1, B=2, C=3, D=4]; remove A → [B=1, C=2, D=3] */
  assert(JSON.stringify(masterOrderTmdb(V2)) === JSON.stringify([9992, 9993, 9994]),
    'V2 master after delete-A: [B, C, D]');
  checkMasterContiguous(V1, 'after delete'); checkMasterContiguous(V2, 'after delete');
  checkProjection(TEST_LIST, 'after delete');

  section("Doug's example 1 — master [A,X,Y,B,C], drag C between A and B → [A,X,Y,C,B]");
  /* Set up a fresh scenario: same V1, but with movies on TWO lists so that X, Y exist
     in V1's master but aren't on the current list.

     We need a second list for V1 with X and Y but NOT A, B, C. After joining, V1's
     master gets X, Y appended. Then we manipulate ranks to match [A, X, Y, B, C] master.
     Easier: use my-ranks twice. But my-ranks operates on a single list.

     Cleaner approach: directly set master_rank in DB for the test (we're testing
     the projection logic, not how the master got that way). Then call /my-ranks
     on the test list with the desired list order and verify master result. */
  /* current V1 master: [B=1, D=2, C=3]. Add A and an "X" (9995=E) and "Y" (9996=F).
     Use second test list for X, Y. */
  const TEST_LIST2 = 'tst22222';
  db.prepare('DELETE FROM movies WHERE list_id = ?').run(TEST_LIST2);
  db.prepare('DELETE FROM list_visitors WHERE list_id = ?').run(TEST_LIST2);
  db.prepare('DELETE FROM lists WHERE id = ?').run(TEST_LIST2);

  /* re-add A on the original test list (so list1 has A, B, C, D again) */
  await req('POST', '/api/list/' + TEST_LIST + '/movies',
    { tmdb_id: 9991, media_type: 'movie', title: 'Test A', year: 2020, visitor_id: V1 });

  /* second list: V1 adds X and Y */
  await req('POST', '/api/list/' + TEST_LIST2 + '/movies',
    { tmdb_id: 9996, media_type: 'movie', title: 'Test X', year: 2025, visitor_id: V1 });
  await req('POST', '/api/list/' + TEST_LIST2 + '/movies',
    { tmdb_id: 9997, media_type: 'movie', title: 'Test Y', year: 2026, visitor_id: V1 });

  /* directly set V1's master to [A=1, X=2, Y=3, B=4, C=5, D=6] for the test */
  const setMR = db.prepare('UPDATE user_movies SET master_rank = ? WHERE visitor_id = ? AND tmdb_id = ?');
  db.transaction(() => {
    /* use sentinel offsets to avoid PK clashes mid-transaction */
    setMR.run(-1, V1, 9991); setMR.run(-2, V1, 9996); setMR.run(-3, V1, 9997);
    setMR.run(-4, V1, 9992); setMR.run(-5, V1, 9993); setMR.run(-6, V1, 9994);
    setMR.run(1, V1, 9991); setMR.run(2, V1, 9996); setMR.run(3, V1, 9997);
    setMR.run(4, V1, 9992); setMR.run(5, V1, 9993); setMR.run(6, V1, 9994);
  })();
  /* (caches on list2 are stale until /my-ranks fires reprojectAllLists below) */
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9991, 9996, 9997, 9992, 9993, 9994]),
    'V1 master is [A, X, Y, B, C, D] before example 1');

  /* On TEST_LIST (which has A, B, C, D), drag the visible list to be [A, C, B, D].
     That is "C dragged between A and B". */
  const idA = db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=9991').get(TEST_LIST).id;
  const idB = db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=9992').get(TEST_LIST).id;
  const idC = db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=9993').get(TEST_LIST).id;
  const idD = db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=9994').get(TEST_LIST).id;
  await req('PUT', '/api/list/' + TEST_LIST + '/my-ranks',
    { visitor_id: V1, ordered_movie_ids: [idA, idC, idB, idD] });
  /* Expected V1 master: [A=1, X=2, Y=3, C=4, B=5, D=6] */
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9991, 9996, 9997, 9993, 9992, 9994]),
    "Doug ex1: master becomes [A,X,Y,C,B,D]");
  checkMasterContiguous(V1, 'Doug ex1');
  checkProjection(TEST_LIST, 'Doug ex1 list1');
  checkProjection(TEST_LIST2, 'Doug ex1 list2 (X,Y untouched)');

  section("Doug's example 2 — master [B,A,X,Y,C], drag B between A and C → [A,B,X,Y,C]");
  /* Set V1 master to [B=1, A=2, X=3, Y=4, C=5, D=6] and run again */
  db.transaction(() => {
    setMR.run(-1, V1, 9992); setMR.run(-2, V1, 9991); setMR.run(-3, V1, 9996);
    setMR.run(-4, V1, 9997); setMR.run(-5, V1, 9993); setMR.run(-6, V1, 9994);
    setMR.run(1, V1, 9992); setMR.run(2, V1, 9991); setMR.run(3, V1, 9996);
    setMR.run(4, V1, 9997); setMR.run(5, V1, 9993); setMR.run(6, V1, 9994);
  })();
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9992, 9991, 9996, 9997, 9993, 9994]),
    'V1 master is [B, A, X, Y, C, D] before example 2');
  /* On TEST_LIST (has A, B, C, D), list visible order initially [B, A, C, D] (sort by master).
     Drag B between A and C → list order becomes [A, B, C, D]. */
  await req('PUT', '/api/list/' + TEST_LIST + '/my-ranks',
    { visitor_id: V1, ordered_movie_ids: [idA, idB, idC, idD] });
  assert(JSON.stringify(masterOrderTmdb(V1)) === JSON.stringify([9991, 9992, 9996, 9997, 9993, 9994]),
    "Doug ex2: master becomes [A,B,X,Y,C,D]");
  checkMasterContiguous(V1, 'Doug ex2');
  checkProjection(TEST_LIST, 'Doug ex2 list1');
  checkProjection(TEST_LIST2, 'Doug ex2 list2');

  section('orphan key cleanup — delete X from TEST_LIST2 (only place X exists)');
  const xMovieId = db.prepare('SELECT id FROM movies WHERE list_id=? AND tmdb_id=9996').get(TEST_LIST2).id;
  await req('DELETE', '/api/list/' + TEST_LIST2 + '/movies/' + xMovieId, { visitor_id: V1 });
  const xStill = db.prepare('SELECT 1 FROM user_movies WHERE visitor_id=? AND tmdb_id=9996').get(V1);
  assert(!xStill, 'V1 user_movies row for X dropped (orphan cleanup)');
  checkMasterContiguous(V1, 'after orphan cleanup');

  /* full cleanup */
  await cleanup();
  db.prepare('DELETE FROM movies WHERE list_id = ?').run(TEST_LIST2);
  db.prepare('DELETE FROM list_visitors WHERE list_id = ?').run(TEST_LIST2);
  db.prepare('DELETE FROM lists WHERE id = ?').run(TEST_LIST2);

  console.log('\n=================================');
  console.log('Pass: ' + pass + '   Fail: ' + fail);
  console.log('=================================');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); cleanup().then(() => process.exit(2)); });
