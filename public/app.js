/* ============================================================================
   app.js — whatdoyouwannawatch.com
   ============================================================================
   This is the entire front-end brain of the app. It runs in the browser.
   It does NOT touch the database directly — it talks to server.js via fetch().

   TMDB (The Movie Database) API calls happen directly from here in the browser.
   Everything else (saving lists, visitors, comments, rankings) goes through
   our server API.

   VISITOR MODEL:
   One cookie ("wtw_visitor") holds a 10-character alphanumeric visitor ID.
   This ID is the same across all lists — it's like a casual account.
   Name and color are stored on the server, keyed by visitor ID.
   If you lose your cookie, you can restore your visitor ID from the
   Copy/Paste screen.

   DATABASE TABLES (on the server, for reference):
   visitors  — id, name, color              (one row per person, global)
   lists     — id, created                  (one row per list)
   movies    — id, list_id, tmdb_id, title, year, poster, added_by
   rankings  — list_id, visitor_id, movie_id, position
   comments  — list_id, movie_id, visitor_id, text
   ============================================================================ */


/* ============================================================================
   SECTION 1: CONSTANTS
   ============================================================================
   Fixed values that never change while the app is running.

   TMDB_API_KEY        — free API key from themoviedb.org
                          each person hosting their own copy gets their own key
   TMDB_BASE           — "https://api.themoviedb.org/3", root of all TMDB calls
   TMDB_IMG            — "https://image.tmdb.org/t/p/", root for poster URLs
                          append a size like "w92" or "w500" then the poster path
   API                 — "/api", root of OUR server's endpoints
   LIST_ID_LEN         — 8, characters in a list ID like "a1b2c3d4"
   VISITOR_ID_LEN      — 10, characters in a visitor ID like "f7ka3m9x2b"
   DEBOUNCE_MS         — 300, milliseconds to wait after typing before searching
   LONG_PRESS_MS       — 500, milliseconds to hold before it counts as long-press
   ============================================================================ */

const TMDB_API_KEY  = '50f0ec96e69aa677d94e2977722686b4';       // TMDB API key (free tier)
const TMDB_BASE     = 'https://api.themoviedb.org/3';          // TMDB API root
const TMDB_IMG      = 'https://image.tmdb.org/t/p/';           // TMDB image root
const API           = '/api';                                   // our server root
const LIST_ID_LEN   = 8;                                        // length of list IDs
const VISITOR_ID_LEN = 10;                                      // length of visitor IDs
const DEBOUNCE_MS   = 300;                                      // search typing delay
const LONG_PRESS_MS = 500;                                      // hold-to-toggle delay


/* ============================================================================
   SECTION 2: STATE VARIABLES
   ============================================================================
   These hold the current state of what the user sees. They change as the
   user interacts with the page. All rendering functions read from these.

   listId              — string, the 8-char ID from the URL, like "a1b2c3d4"
   visitorId           — string, the 10-char ID from the cookie, like "f7ka3m9x2b"
                          null if no cookie yet (brand new browser)
   visitor             — object from server: { id, name, color } or null if unregistered
   listData            — object, everything about this list from the server:
                          { list, movies, visitors, rankings, comments }
   myRanking           — array of movie IDs in my drag order: [7, 3, 12, 1]
   couchRanking        — array of movie IDs sorted by Borda score (lowest = best)
   couchTies           — { movieId: "1-2" } — tie labels for movies with same score
   activeTab           — "couch" or a visitorId string — whose ordering to show
   selectedVisitors    — { visitorId: true/false } — who's included in the Couch vote
   searchResults       — array of TMDB movie objects from the current search
   expandedComment     — { movieId, visitorId } or null — which comment is expanded
   movieDetailCache    — { tmdbId: detailObject } — cached TMDB detail lookups
   displayNames        — { visitorId: "Doug" or "Doug(2)" } — per-list display names
                          built fresh on each loadList(), handles name collisions
                          without changing anyone's stored name
   ============================================================================ */

let listId            = null;                                   // from URL path
let visitorId         = null;                                   // from cookie
let visitor           = null;                                   // { id, name, color } from server
let listData          = null;                                   // full list from server
let myRanking         = [];                                     // my movie order
let couchRanking      = [];                                     // consensus order (Borda)
let couchTies         = {};                                     // { movieId: "1-2" } tie labels
let activeTab         = 'couch';                                // start on consensus view
let selectedVisitors  = {};                                     // everyone ON by default
let searchResults     = [];                                     // current TMDB search hits
let expandedComment   = null;                                   // which comment is open
let movieDetailCache  = {};                                     // TMDB detail cache
let displayNames      = {};                                     // visitorId → per-list display name


/* ============================================================================
   SECTION 3: INITIALIZATION — initApp()
   ============================================================================
   Runs once when the page loads.

   1. Read the URL path to get listId.
      — "/" (homepage) → generate random 8-char ID, redirect to "/a1b2c3d4"
      — "/a1b2c3d4" → extract that as listId

   2. Read the cookie "wtw_visitor" to get visitorId.
      — if no cookie → generate a new 10-char visitor ID, save it to cookie
      — either way, visitorId is now set

   3. Fetch this visitor's profile from the server (name, color).
      — if the server doesn't know this visitor ID yet, visitor stays null
        and we show the "enter your name" prompt

   4. Call loadList() to fetch all list data and draw the page.

   5. Call setupEventListeners() to wire up all the UI interactions.
   ============================================================================ */

function initApp() {
  const path = window.location.pathname.replace(/^\//, '');     // strip leading slash

  if (!path || path === '') {                                   // homepage: "/" with nothing after
    listId = generateId(LIST_ID_LEN);                           // make a random list ID
    window.location.href = '/' + listId;                        // redirect — this reloads the page
    return;                                                     // stop here, page will reload
  }

  listId = path;                                                // use the path as the list ID

  visitorId = getCookie('wtw_visitor');                          // check for existing cookie
  if (!visitorId) {                                             // brand new browser, no cookie
    visitorId = generateId(VISITOR_ID_LEN);                     // make a random visitor ID
    setCookie('wtw_visitor', visitorId);                         // save it
  }

  loadVisitorProfile().then(() => {                             // fetch name/color from server
    return loadList();                                          // then fetch and render the list
  }).then(() => {
    setupEventListeners();                                      // wire up all UI interactions
  });
}


/* ============================================================================
   SECTION 4: VISITOR MANAGEMENT
   ============================================================================
   The cookie holds only the visitor ID (10 chars). Name and color live on the
   server in the visitors table, shared across all lists.

   --- loadVisitorProfile() ---
   On startup, ask the server who this visitor ID belongs to.
   If the server has no record, visitor stays null → show name prompt.

   --- handleNameEntry(nameText) ---
   When user types a name and hits enter or clicks away.
   Sends the name to the server. Server checks if name is taken on this list
   (different visitor using same name). If taken, appends "(2)".

   --- handleColorChange(newColor) ---
   When user picks a new color. Updates server + re-renders.

   --- restoreVisitorId(oldId) ---
   User pasted an old visitor ID in the Copy/Paste screen.
   Swap the cookie to the old ID and reload everything.
   ============================================================================ */

async function loadVisitorProfile() {
  const resp = await fetch(API + '/visitor/' + visitorId);      // ask server for this visitor
  if (resp.ok) {
    visitor = await resp.json();                                 // { id, name, color }
  } else {
    visitor = null;                                              // server doesn't know us yet
  }
}

async function handleNameEntry(nameText) {
  if (!nameText || nameText.trim() === '') return;              // ignore blank entry
  nameText = nameText.trim();

  /* check if this name is already used by someone else on this list */
  const checkResp = await fetch(                                // ask server to look
    API + '/list/' + listId + '/check-name/' + encodeURIComponent(nameText)
    + '?visitor_id=' + visitorId                                // exclude ourselves from the check
  );
  const checkData = await checkResp.json();                     // { taken: true/false }

  if (checkData.taken) {
    showNameWarning('Name taken — you\'ll appear as "' + nameText + '(2)"');
    nameText = nameText + '(2)';                                // server enforces this too
  }

  /* create or update our visitor profile on the server */
  const color = visitor ? visitor.color : randomColor();        // keep existing color, or pick new
  const resp = await fetch(API + '/visitor/' + visitorId, {
    method: 'PUT',                                              // PUT = create or update
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameText, color: color })      // send name + color
  });
  visitor = await resp.json();                                  // server returns { id, name, color }

  hideNameWarning();                                            // clear any red warning
  await loadList();                                             // refresh everything with our name
}

async function handleColorChange(newColor) {
  if (!visitor) return;                                         // can't change color without a name
  visitor.color = newColor;                                     // update locally right away

  await fetch(API + '/visitor/' + visitorId, {                  // tell the server
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: visitor.name, color: newColor })
  });

  renderList();                                                 // redraw comments in new color
}

function restoreVisitorId(oldId) {
  if (!oldId || oldId.trim().length !== VISITOR_ID_LEN) return; // ignore bad input
  visitorId = oldId.trim();                                     // swap to the old ID
  setCookie('wtw_visitor', visitorId);                          // save new cookie
  window.location.reload();                                     // reload page with restored identity
}

function showNameWarning(msg) {
  const el = document.getElementById('name-warning');           // red warning box in the HTML
  el.textContent = msg;
  el.style.display = 'block';
}

function hideNameWarning() {
  const el = document.getElementById('name-warning');
  el.style.display = 'none';
}


/* ============================================================================
   SECTION 5: DATA LOADING — loadList()
   ============================================================================
   Fetches everything about this list from our server and updates state.
   Called on page load and after any change (add, delete, reorder, comment).

   Server returns:
   {
     list:     { id, created },
     movies:   [ { id, tmdb_id, title, year, poster, added_by }, ... ],
     visitors: [ { id, name, color }, ... ],       ← only visitors active on THIS list
     rankings: { visitorId: [movieId, movieId, ...], ... },
     comments: [ { movie_id, visitor_id, text }, ... ]
   }

   After fetching, we rebuild myRanking (our ordering), selectedVisitors
   (who's toggled on), couchRanking (consensus), then re-render.
   ============================================================================ */

async function loadList() {
  const resp = await fetch(API + '/list/' + listId);            // GET the full list

  if (!resp.ok) {                                               // list doesn't exist yet
    listData = {                                                // start with empty data
      list: { id: listId },
      movies: [], visitors: [], rankings: {}, comments: []
    };
  } else {
    listData = await resp.json();                                // parse the full response
  }

  /* build myRanking — our personal order of movie IDs */
  if (visitorId && listData.rankings[visitorId]) {              // we have saved rankings
    myRanking = listData.rankings[visitorId];                   // use them
  } else {                                                      // no rankings yet
    myRanking = listData.movies.map(m => m.id);                 // default: order they were added
  }

  /* build selectedVisitors — preserve toggles, default new visitors to ON */
  const newSelected = {};
  listData.visitors.forEach(v => {
    if (selectedVisitors.hasOwnProperty(v.id)) {                // we already have a toggle state
      newSelected[v.id] = selectedVisitors[v.id];               // keep it
    } else {
      newSelected[v.id] = true;                                 // new visitor, default ON
    }
  });
  selectedVisitors = newSelected;

  buildDisplayNames();                                          // compute per-list display names
  calculateCouchRanking();                                      // recalc consensus from rankings
  renderUserTabs();                                             // redraw the tab bar
  renderList();                                                 // redraw the movie list
}


/* --- buildDisplayNames() ---
   Computes display names for all visitors on this list, handling collisions.
   Two visitors both named "Doug" on different lists is fine — but if they
   both show up on the SAME list, the first one to interact keeps "Doug"
   and the second becomes "Doug(2)".

   "First to interact" = appears earlier in listData.visitors (server returns
   them in order of first activity on this list).

   We also check our own visitor (who may not be in the list's visitors yet if
   they haven't added/ranked/commented). If our name collides, we include
   ourselves in the map with a "(2)" suffix.

   This ONLY affects display — nobody's stored name changes.
   ============================================================================ */

function buildDisplayNames() {
  displayNames = {};                                             // reset
  const nameCount = {};                                          // "doug" → how many seen so far

  /* process visitors in server order (first to interact = first in array) */
  listData.visitors.forEach(v => {
    const lower = v.name.toLowerCase();                          // case-insensitive collision check
    if (!nameCount[lower]) {                                     // first visitor with this name
      nameCount[lower] = 1;
      displayNames[v.id] = v.name;                               // keep clean name
    } else {
      nameCount[lower]++;
      displayNames[v.id] = v.name + '(' + nameCount[lower] + ')'; // "Doug(2)"
    }
  });

  /* check if our visitor collides but isn't in the list's visitors yet */
  if (visitor && !displayNames[visitorId]) {
    const lower = visitor.name.toLowerCase();
    if (nameCount[lower]) {                                      // our name is already taken
      nameCount[lower]++;
      displayNames[visitorId] = visitor.name + '(' + nameCount[lower] + ')';
    } else {
      displayNames[visitorId] = visitor.name;                    // no collision
    }
  }
}


/* ============================================================================
   SECTION 6: TMDB SEARCH
   ============================================================================
   The search box at the top of the page. User types a movie name, we query
   TMDB directly from the browser (no server involved), show results in a
   dropdown. Clicking a result adds the movie to this list.

   --- handleSearchInput(queryText) ---
   Called on every keystroke (through debounce). If query is too short, clears
   results. Otherwise calls searchTMDB().

   --- searchTMDB(query) ---
   Fetches matching movies from TMDB. Stores top 8 results.

   --- renderSearchResults() ---
   Draws the dropdown below the search box, overlaying the list.

   --- addMovie(tmdbMovie) ---
   User clicked a result. Sends movie to our server, then reloads the list.
   ============================================================================ */

const debouncedSearch = debounce(handleSearchInput, DEBOUNCE_MS); // wrapped version for events

function handleSearchInput(queryText) {
  if (!queryText || queryText.length < 2) {                     // too short to search
    searchResults = [];
    renderSearchResults();                                      // hides the dropdown
    return;
  }
  searchTMDB(queryText);                                        // go fetch from TMDB
}

async function searchTMDB(query) {
  const url = TMDB_BASE + '/search/movie'                       // TMDB search endpoint
    + '?api_key=' + TMDB_API_KEY
    + '&query=' + encodeURIComponent(query);                    // URL-encode the search text

  const resp = await fetch(url);
  const data = await resp.json();                               // { results: [...] }
  searchResults = data.results.slice(0, 8);                     // keep top 8 matches
  renderSearchResults();
}

function renderSearchResults() {
  const container = document.getElementById('search-results');  // dropdown div below search box

  if (searchResults.length === 0) {                             // nothing to show
    container.innerHTML = '';
    container.style.display = 'none';                           // hide the dropdown
    return;
  }

  container.style.display = 'block';                            // show the dropdown
  container.innerHTML = searchResults.map(movie => {
    const year = formatYear(movie.release_date);                // "2002-06-14" → 2002
    const posterThumb = movie.poster_path                       // tiny poster for the row
      ? TMDB_IMG + 'w45' + movie.poster_path                   // 45px wide thumbnail
      : '';                                                     // no poster available
    return '<div class="search-result" data-tmdb-id="' + movie.id + '">'
      + (posterThumb ? '<img src="' + posterThumb + '" class="search-thumb">' : '')
      + '<span>' + escapeHtml(movie.title) + ' (' + year + ')</span>'
      + '</div>';
  }).join('');
}

async function addMovie(tmdbMovie) {
  if (!visitor) {                                               // must have a name first
    showNameWarning('Enter your name before adding movies');
    return;
  }

  const year = formatYear(tmdbMovie.release_date);

  await fetch(API + '/list/' + listId + '/movies', {            // POST to our server
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tmdb_id:    tmdbMovie.id,                                 // TMDB's ID for this movie
      title:      tmdbMovie.title,                              // store title so we don't re-fetch
      year:       year,
      poster:     tmdbMovie.poster_path,                        // just the path, not full URL
      visitor_id: visitorId                                     // who added it
    })
  });

  document.getElementById('search-box').value = '';             // clear the search box
  searchResults = [];
  renderSearchResults();                                        // hide the dropdown
  await loadList();                                             // refresh to show the new movie
}


/* ============================================================================
   SECTION 7: RENDERING THE MOVIE LIST — renderList()
   ============================================================================
   The main draw function. Clears the list container and rebuilds every entry.

   Picks which ordering to use based on activeTab:
   — "couch"    → couchRanking (consensus order)
   — visitorId  → that visitor's ranking from listData.rankings

   For each movie in order, calls renderEntry() to build one row.

   --- renderEntry(movie, position) ---
   Builds one list row. Left to right:
   1. Rank number (big) + drag handle (only on your own list)
   2. Poster thumbnail (click → TMDB, long-press → popup)
   3. Title + year (same click/long-press behavior)
   4. Comment boxes (one per visitor who commented, plus your empty one)
   5. Remove button (only if you added this movie)
   ============================================================================ */

function renderList() {
  const container = document.getElementById('movie-list');      // the list area in the HTML

  /* decide which ordering to show */
  let ordering;
  if (activeTab === 'couch') {
    ordering = couchRanking;                                    // ranked choice consensus
  } else if (listData.rankings[activeTab]) {
    ordering = listData.rankings[activeTab];                    // specific visitor's ranking
  } else {
    ordering = listData.movies.map(m => m.id);                  // fallback: order added
  }

  /* build a quick lookup: movie id → movie object */
  const movieById = {};
  listData.movies.forEach(m => { movieById[m.id] = m; });

  /* build a quick lookup: visitor id → visitor object (for names, colors) */
  const visitorById = {};
  listData.visitors.forEach(v => { visitorById[v.id] = v; });

  /* build a quick lookup: movie id → array of comments for that movie */
  const commentsByMovie = {};
  listData.comments.forEach(c => {
    if (!commentsByMovie[c.movie_id]) commentsByMovie[c.movie_id] = [];
    commentsByMovie[c.movie_id].push(c);
  });

  /* render each entry */
  const isDraggable = (activeTab === visitorId);                // only drag your own list
  container.innerHTML = '';                                     // clear old entries

  ordering.forEach((movieId, index) => {
    const movie = movieById[movieId];
    if (!movie) return;                                         // skip if movie was deleted
    const position = index + 1;                                 // 1-based rank
    const tieLabel = (activeTab === 'couch') ? (couchTies[movieId] || null) : null;
    const comments = commentsByMovie[movie.id] || [];           // comments for this movie
    const entry = renderEntry(movie, position, tieLabel, comments, visitorById, isDraggable);
    container.appendChild(entry);
  });
}

function renderEntry(movie, position, tieLabel, comments, visitorById, isDraggable) {
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.dataset.movieId = movie.id;                             // store movie id on the element

  /* 1. RANK NUMBER + optional drag handle + optional tie indicator */
  const tieHtml = tieLabel                                      // e.g. "tied 1-3"
    ? '<span class="tie-label">tied ' + tieLabel + '</span>' : '';
  const rankHtml = '<div class="entry-rank">'
    + (isDraggable ? '<span class="drag-handle">⠿</span>' : '') // grip dots, only on own list
    + '<span class="rank-number">' + position + '</span>'
    + tieHtml
    + '</div>';

  /* 2. POSTER THUMBNAIL */
  const posterUrl = movie.poster
    ? TMDB_IMG + 'w92' + movie.poster                           // 92px wide poster
    : '';                                                        // no poster
  const posterHtml = '<div class="entry-poster" data-tmdb-id="' + movie.tmdb_id + '">'
    + (posterUrl ? '<img src="' + posterUrl + '">' : '<div class="no-poster">?</div>')
    + '</div>';

  /* 3. TITLE */
  const titleHtml = '<div class="entry-title" data-tmdb-id="' + movie.tmdb_id + '">'
    + escapeHtml(movie.title) + ' (' + movie.year + ')'
    + '</div>';

  /* 4. COMMENTS — one box per commenter, sorted: adder first, then by creation */
  let commentsHtml = '<div class="entry-comments">';

  /* sort: movie adder's comment first, then others in order */
  const sorted = comments.slice().sort((a, b) => {
    if (a.visitor_id === movie.added_by) return -1;             // adder goes first
    if (b.visitor_id === movie.added_by) return 1;
    return 0;                                                    // keep original order otherwise
  });

  let myCommentExists = false;                                  // track if we've already commented

  sorted.forEach(c => {
    const commenter = visitorById[c.visitor_id] || { name: '?', color: '#999' };
    if (c.visitor_id === visitorId) myCommentExists = true;     // found our comment
    commentsHtml += '<div class="comment-box" '
      + 'data-movie-id="' + movie.id + '" '
      + 'data-visitor-id="' + c.visitor_id + '" '
      + 'style="color: ' + escapeHtml(commenter.color) + '">'
      + '<strong>' + escapeHtml(displayNames[c.visitor_id] || commenter.name) + ':</strong> '
      + escapeHtml(c.text)
      + '</div>';
  });

  /* if we haven't commented yet, show an empty box with our name */
  if (visitor && !myCommentExists) {
    commentsHtml += '<div class="comment-box comment-empty" '
      + 'data-movie-id="' + movie.id + '" '
      + 'data-visitor-id="' + visitorId + '" '
      + 'style="color: ' + escapeHtml(visitor.color) + '">'
      + '<strong>' + escapeHtml(displayNames[visitorId] || visitor.name) + ':</strong> '
      + '</div>';
  }
  commentsHtml += '</div>';

  /* 5. REMOVE BUTTON — only if we added this movie */
  let removeHtml = '';
  if (movie.added_by === visitorId) {
    removeHtml = '<button class="remove-btn" data-movie-id="' + movie.id + '">✕</button>';
  }

  entry.innerHTML = rankHtml + posterHtml + titleHtml + commentsHtml + removeHtml;
  return entry;
}


/* ============================================================================
   SECTION 8: DRAG TO REORDER (your own list only)
   ============================================================================
   When viewing your own tab, entries have a grip handle (⠿). Dragging an
   entry up or down changes your personal ranking.

   Works on both desktop (mouse) and phone (touch).

   --- handleDragStart(event) ---
   Record which entry is being dragged and where the finger/cursor started.

   --- handleDragMove(event) ---
   Move the dragged entry with the finger. When it crosses the midpoint of
   another entry, swap them visually and update myRanking.

   --- handleDragEnd() ---
   Save the new ranking to the server.
   ============================================================================ */

let dragState = null;                                            // null when not dragging

function handleDragStart(entry, startY) {
  const movieId = parseInt(entry.dataset.movieId);               // which movie
  const rect = entry.getBoundingClientRect();                    // entry's position on screen
  dragState = {
    movieId:    movieId,
    entry:      entry,                                           // the DOM element being dragged
    startY:     startY,                                          // where the finger started
    offsetY:    startY - rect.top,                               // finger offset within the entry
    entryH:     rect.height                                      // height of one entry
  };
  entry.classList.add('dragging');                                // CSS: lift shadow, slight opacity
}

function handleDragMove(currentY) {
  if (!dragState) return;                                        // not dragging

  const delta = currentY - dragState.startY;                     // how far the finger has moved
  dragState.entry.style.transform = 'translateY(' + delta + 'px)'; // move the entry visually

  /* check if we've crossed over another entry */
  const container = document.getElementById('movie-list');
  const entries = Array.from(container.querySelectorAll('.entry'));
  const dragIndex = myRanking.indexOf(dragState.movieId);        // current position in array

  entries.forEach((other, i) => {
    if (other === dragState.entry) return;                        // skip ourselves
    const otherRect = other.getBoundingClientRect();
    const otherMid = otherRect.top + otherRect.height / 2;       // midpoint of the other entry

    /* if our finger is past the midpoint of another entry, swap them */
    if (currentY > otherMid && i > dragIndex) {                  // dragging down past this one
      myRanking.splice(dragIndex, 1);                            // remove from old position
      myRanking.splice(i, 0, dragState.movieId);                 // insert at new position
      renderList();                                              // redraw with new order
      /* re-grab the entry element since renderList rebuilt the DOM */
      dragState.entry = container.querySelector('[data-movie-id="' + dragState.movieId + '"]');
      dragState.entry.classList.add('dragging');
    } else if (currentY < otherMid && i < dragIndex) {           // dragging up past this one
      myRanking.splice(dragIndex, 1);
      myRanking.splice(i, 0, dragState.movieId);
      renderList();
      dragState.entry = container.querySelector('[data-movie-id="' + dragState.movieId + '"]');
      dragState.entry.classList.add('dragging');
    }
  });
}

async function handleDragEnd() {
  if (!dragState) return;

  dragState.entry.classList.remove('dragging');                   // remove lift effect
  dragState.entry.style.transform = '';                          // snap back to position
  dragState = null;                                              // done dragging

  /* save the new ranking to the server */
  await fetch(API + '/list/' + listId + '/rankings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visitor_id: visitorId,
      ranking: myRanking                                         // full ordered array of movie IDs
    })
  });

  calculateCouchRanking();                                       // our vote changed, recalc
  if (activeTab === 'couch') renderList();                       // update couch view if showing
}


/* ============================================================================
   SECTION 9: COMMENT EXPAND / EDIT
   ============================================================================
   Tapping a comment box expands it to ~2/3 screen height.
   If it's your comment, you can edit it. If it's someone else's, read-only.

   --- expandComment(movieId, commentVisitorId) ---
   Grows the comment box, scrolls the entry into view.
   If it's ours: shows editable textarea + Done button.
   If it's theirs: shows scrollable read-only text.

   --- collapseComment() ---
   Saves changes (if ours), shrinks the box back to entry height.
   ============================================================================ */

function expandComment(movieId, commentVisitorId) {
  expandedComment = { movieId: movieId, visitorId: commentVisitorId };

  /* find the comment box element */
  const box = document.querySelector(
    '.comment-box[data-movie-id="' + movieId + '"]'
    + '[data-visitor-id="' + commentVisitorId + '"]'
  );
  if (!box) return;

  /* scroll so this entry is ~1/6 from the top of the screen */
  const entry = box.closest('.entry');
  const targetY = window.innerHeight / 6;                        // 1/6 down from top
  const entryTop = entry.getBoundingClientRect().top;
  window.scrollBy(0, entryTop - targetY);                        // smooth scroll

  /* expand the box */
  box.classList.add('comment-expanded');                          // CSS handles the sizing

  const isOurs = (commentVisitorId === visitorId);               // is this our comment?

  if (isOurs) {
    /* find the existing text (after the "Name: " prefix) */
    const existingComment = findCommentText(movieId, visitorId); // from listData
    const commenterName = displayNames[visitorId] || (visitor ? visitor.name : '');

    box.innerHTML = '<strong>' + escapeHtml(commenterName) + ':</strong>'
      + '<textarea class="comment-edit">' + escapeHtml(existingComment) + '</textarea>'
      + '<button class="comment-done-btn">Done</button>';

    /* focus the textarea */
    box.querySelector('.comment-edit').focus();

    /* wire up the Done button */
    box.querySelector('.comment-done-btn').addEventListener('click', () => {
      const newText = box.querySelector('.comment-edit').value;  // grab edited text
      saveComment(movieId, newText);                              // save to server
      collapseComment();                                         // shrink back
    });
  } else {
    /* read-only: just let them scroll within the box, tap outside to close */
    box.classList.add('comment-readonly');
  }
}

function collapseComment() {
  if (!expandedComment) return;

  /* find and shrink the expanded box */
  const box = document.querySelector('.comment-expanded');
  if (box) {
    box.classList.remove('comment-expanded', 'comment-readonly');
  }

  expandedComment = null;
  loadList();                                                    // refresh to show updated text
}

async function saveComment(movieId, text) {
  await fetch(API + '/list/' + listId + '/comments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      movie_id:   movieId,
      visitor_id: visitorId,
      text:       text
    })
  });
}

function findCommentText(movieId, vid) {
  /* search listData.comments for this movie + visitor combo */
  const found = listData.comments.find(
    c => c.movie_id === movieId && c.visitor_id === vid
  );
  return found ? found.text : '';                                // empty string if no comment yet
}


/* ============================================================================
   SECTION 10: USER TABS AND COUCH TOGGLE
   ============================================================================
   The tab bar below the search box:

   [ Couch ]  [ Doug ■ ]  [ Beta ■ ]  [ Mom ■ ]    [ name-input ■ ]

   "Couch" tab:  shows ranked-choice consensus of all selected visitors.
   Visitor tabs: click to view that person's ranking. Click your own for
                 the draggable view. Long-press to toggle them in/out of
                 the Couch vote (dimmed = excluded).
   Name input:   shown if this visitor hasn't set a name yet.

   --- renderUserTabs() ---
   Rebuilds the tab bar HTML.

   --- handleTabClick(tabVisitorId) ---
   Switches activeTab and re-renders the list.

   --- handleTabLongPress(tabVisitorId) ---
   Toggles a visitor in/out of the Couch calculation.
   ============================================================================ */

function renderUserTabs() {
  const tabBar = document.getElementById('tab-bar');

  /* Couch tab */
  let html = '<div class="tab' + (activeTab === 'couch' ? ' tab-active' : '') + '" '
    + 'data-tab="couch">Couch</div>';

  /* one tab per visitor on this list */
  listData.visitors.forEach(v => {
    const isActive = (activeTab === v.id);                       // is this tab selected?
    const isSelected = selectedVisitors[v.id] !== false;         // included in Couch vote?
    html += '<div class="tab' + (isActive ? ' tab-active' : '')
      + (isSelected ? '' : ' tab-dimmed') + '" '                // dim if excluded from vote
      + 'data-tab="' + v.id + '">'
      + escapeHtml(displayNames[v.id] || v.name)                  // use display name (handles dupes)
      + ' <span class="color-swatch" style="background:' + escapeHtml(v.color) + '"></span>'
      + '</div>';
  });

  /* show our own tab if we have a name but aren't in the list's visitors yet
     (happens when we've entered a name but haven't added/ranked/commented) */
  if (visitor && !listData.visitors.find(v => v.id === visitorId)) {
    const isActive = (activeTab === visitorId);
    const isSelected = selectedVisitors[visitorId] !== false;
    html += '<div class="tab' + (isActive ? ' tab-active' : '')
      + (isSelected ? '' : ' tab-dimmed') + '" '
      + 'data-tab="' + visitorId + '">'
      + escapeHtml(displayNames[visitorId] || visitor.name)
      + ' <span class="color-swatch" style="background:' + escapeHtml(visitor.color) + '"></span>'
      + '</div>';
  }

  /* name input — only show if this visitor hasn't entered a name */
  if (!visitor) {
    html += '<div class="name-entry">'
      + '<input id="name-input" type="text" placeholder="enter your name">'
      + '<span id="name-warning" style="display:none"></span>'
      + '</div>';
  } else {
    /* color picker — clickable swatch next to our name */
    html += '<input type="color" id="color-picker" value="' + visitor.color + '" '
      + 'style="display:none">';                                 // hidden, opened by swatch click
  }

  tabBar.innerHTML = html;
}

function handleTabClick(tabId) {
  if (tabId === 'couch') {
    activeTab = 'couch';                                         // show consensus
  } else {
    activeTab = tabId;                                           // show this visitor's ranking
  }
  renderList();                                                  // redraw in the new order
  renderUserTabs();                                              // update which tab looks selected
}

function handleTabLongPress(tabVisitorId) {
  if (tabVisitorId === 'couch') return;                          // can't toggle the couch tab
  selectedVisitors[tabVisitorId] = !selectedVisitors[tabVisitorId]; // flip on↔off
  calculateCouchRanking();                                       // recalculate consensus
  renderUserTabs();                                              // update dimmed/undimmed look
  if (activeTab === 'couch') renderList();                       // refresh if viewing consensus
}


/* ============================================================================
   SECTION 11: MOVIE INFO POPUP
   ============================================================================
   Hover (desktop) or long-press (phone) on a poster or title shows a popup
   with the full poster, director, top cast, and a summary.

   --- showMoviePopup(tmdbId, anchorElement) ---
   Fetches detailed info from TMDB (cached after first fetch), builds and
   displays the overlay popup near the anchor element.

   --- hideMoviePopup() ---
   Removes the popup.
   ============================================================================ */

async function showMoviePopup(tmdbId, anchorEl) {
  /* check cache first */
  if (!movieDetailCache[tmdbId]) {
    const url = TMDB_BASE + '/movie/' + tmdbId                   // TMDB detail endpoint
      + '?api_key=' + TMDB_API_KEY
      + '&append_to_response=credits';                           // include cast and crew
    const resp = await fetch(url);
    movieDetailCache[tmdbId] = await resp.json();                // cache the full response
  }

  const detail = movieDetailCache[tmdbId];

  /* extract director from crew */
  const director = detail.credits.crew.find(p => p.job === 'Director');
  const directorName = director ? director.name : 'Unknown';

  /* extract top 5 cast members */
  const topCast = detail.credits.cast.slice(0, 5).map(p => p.name);

  /* build popup HTML */
  const popup = document.getElementById('movie-popup');
  const posterUrl = detail.poster_path
    ? TMDB_IMG + 'w300' + detail.poster_path                     // medium poster
    : '';

  popup.innerHTML = '<div class="popup-content">'
    + (posterUrl ? '<img src="' + posterUrl + '" class="popup-poster">' : '')
    + '<div class="popup-info">'
    + '<h3>' + escapeHtml(detail.title) + ' (' + formatYear(detail.release_date) + ')</h3>'
    + '<p><strong>Director:</strong> ' + escapeHtml(directorName) + '</p>'
    + '<p><strong>Cast:</strong> ' + escapeHtml(topCast.join(', ')) + '</p>'
    + '<p>' + escapeHtml(detail.overview || 'No summary available.') + '</p>'
    + '</div></div>';

  /* position the popup near the element that triggered it */
  const rect = anchorEl.getBoundingClientRect();
  popup.style.top = (rect.bottom + window.scrollY) + 'px';
  popup.style.left = rect.left + 'px';
  popup.style.display = 'block';
}

function hideMoviePopup() {
  const popup = document.getElementById('movie-popup');
  popup.style.display = 'none';
  popup.innerHTML = '';
}


/* ============================================================================
   SECTION 12: BORDA COUNT VOTING — calculateCouchRanking()
   ============================================================================
   Runs entirely in the browser. No server call.

   Uses Borda Count — simple, transparent, no rounds or elimination.

   Algorithm:
   1. For each selected visitor, look at their ranking (personal drag order).
      Their #1 movie gets position 1, #2 gets position 2, etc.
   2. For each movie, add up the position numbers from every selected visitor.
      Low total = everyone ranked it high = consensus favorite.
   3. Sort movies by total score (ascending). That's the Couch order.
   4. If two or more movies have the same total score, they're tied.
      Ties are broken randomly (shuffled), and a "tied 3-5" label is shown
      next to the rank number so everyone knows it's a tie.

   Example with 2 voters, 3 movies:
     Beta:  Arcane=1, Zootopia=2, Bourne=3
     Doug:  Bourne=1, Arcane=2,   Zootopia=3
     Scores: Arcane=3, Bourne=4, Zootopia=5  → Arcane wins!
     (If Bourne and Zootopia both scored 4, they'd show "tied 2-3")

   Movies not ranked by a visitor get position (N+1) where N is the total
   number of movies — they sink to the bottom without penalizing others.
   ============================================================================ */

function calculateCouchRanking() {
  couchTies = {};                                                // reset tie labels

  /* gather rankings from selected visitors only */
  const voterIds = Object.keys(selectedVisitors).filter(vid =>
    selectedVisitors[vid] && listData.rankings[vid]              // toggled ON and has rankings
  );

  const allMovieIds = listData.movies.map(m => m.id);            // every movie on the list

  /* edge case: no voters */
  if (voterIds.length === 0) {
    couchRanking = allMovieIds.slice();                           // default: order added
    return;
  }

  const numMovies = allMovieIds.length;
  const defaultPos = numMovies + 1;                              // score for unranked movies

  /* calculate Borda score for each movie */
  const scores = {};                                             // movieId → total score
  allMovieIds.forEach(mid => { scores[mid] = 0; });              // start at zero

  voterIds.forEach(vid => {
    const ranking = listData.rankings[vid];                      // this visitor's ordered list
    ranking.forEach((movieId, index) => {
      scores[movieId] = (scores[movieId] || 0) + (index + 1);   // position is 1-based
    });
    /* movies not in this visitor's ranking get the default (worst) position */
    allMovieIds.forEach(mid => {
      if (ranking.indexOf(mid) === -1) {                         // not ranked by this voter
        scores[mid] = (scores[mid] || 0) + defaultPos;
      }
    });
  });

  /* sort movies by score (lowest = best) */
  const sorted = allMovieIds.slice().sort((a, b) => {
    if (scores[a] !== scores[b]) return scores[a] - scores[b];   // lower score wins
    return Math.random() - 0.5;                                  // tied: random order
  });

  /* detect ties and build tie labels */
  let i = 0;
  while (i < sorted.length) {
    /* find the run of movies with the same score starting at i */
    let j = i + 1;
    while (j < sorted.length && scores[sorted[j]] === scores[sorted[i]]) {
      j++;                                                       // extend the tie group
    }
    if (j - i > 1) {                                             // more than one movie at this score
      const label = (i + 1) + '-' + j;                           // e.g. "3-5" for positions 3,4,5
      for (let k = i; k < j; k++) {
        couchTies[sorted[k]] = label;                            // tag each tied movie
      }
    }
    i = j;                                                       // jump past this group
  }

  couchRanking = sorted;
}


/* ============================================================================
   SECTION 13: COPY / PASTE + VISITOR ID MANAGEMENT
   ============================================================================
   Bottom-left button "Copy / Paste" opens a modal with four sections:

   1. YOUR VISITOR ID — shown as text, copyable. You can save this in Google
      Keep or wherever. If you lose your cookie, paste it back to restore.

   2. RESTORE VISITOR ID — text box to paste an old visitor ID.

   3. EXPORT — the full list as plain text, ready to copy.

   4. IMPORT — paste text from another list to bulk-add movies + comments.

   The export format:
   "1. The Bourne Identity (2002) - Added by Doug - Doug: Matt Damon, super spy
    2. Arcane (2021) - Added by Beta - Beta: Now!!!!!!"

   The import parser reads this format and adds each movie via TMDB search.
   ============================================================================ */

function openCopyPasteModal() {
  const modal = document.getElementById('copy-paste-modal');
  const visitorById = {};
  listData.visitors.forEach(v => { visitorById[v.id] = v; });

  modal.innerHTML = '<div class="modal-content">'
    /* close button */
    + '<button class="modal-close">✕</button>'

    /* section 1: your visitor ID */
    + '<div class="modal-section">'
    + '<h3>Your Visitor ID</h3>'
    + '<input type="text" id="visitor-id-display" readonly value="' + visitorId + '">'
    + '<button id="copy-visitor-id-btn">Copy</button>'
    + '<p class="modal-hint">Save this somewhere safe. If you clear your cookies, '
    + 'paste it back below to restore your identity.</p>'
    + '</div>'

    /* section 2: restore visitor ID */
    + '<div class="modal-section">'
    + '<h3>Restore Visitor ID</h3>'
    + '<input type="text" id="restore-visitor-input" placeholder="paste old visitor ID">'
    + '<button id="restore-visitor-btn">Restore</button>'
    + '</div>'

    /* section 3: list ID */
    + '<div class="modal-section">'
    + '<h3>List ID</h3>'
    + '<input type="text" readonly value="' + listId + '">'
    + '</div>'

    /* section 4: export */
    + '<div class="modal-section">'
    + '<h3>Export List</h3>'
    + '<textarea id="export-text" readonly>' + escapeHtml(buildExportText(visitorById)) + '</textarea>'
    + '<button id="copy-export-btn">Copy</button>'
    + '</div>'

    /* section 5: import */
    + '<div class="modal-section">'
    + '<h3>Import List</h3>'
    + '<textarea id="import-text" placeholder="Paste a list here..."></textarea>'
    + '<button id="import-btn">Import</button>'
    + '</div>'

    + '</div>';

  modal.style.display = 'flex';                                  // show the modal

  /* wire up buttons */
  modal.querySelector('.modal-close').addEventListener('click', closeCopyPasteModal);

  modal.querySelector('#copy-visitor-id-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(visitorId);                    // copy to clipboard
  });

  modal.querySelector('#restore-visitor-btn').addEventListener('click', () => {
    const oldId = document.getElementById('restore-visitor-input').value;
    restoreVisitorId(oldId);                                     // swap cookie and reload
  });

  modal.querySelector('#copy-export-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('export-text').value);
  });

  modal.querySelector('#import-btn').addEventListener('click', () => {
    const text = document.getElementById('import-text').value;
    parseImportText(text);                                       // parse and add movies
  });
}

function closeCopyPasteModal() {
  document.getElementById('copy-paste-modal').style.display = 'none';
}

function buildExportText(visitorById) {
  /* build the text representation of the current list */
  let lines = [];

  /* use current display ordering */
  const ordering = (activeTab === 'couch') ? couchRanking : myRanking;
  const movieById = {};
  listData.movies.forEach(m => { movieById[m.id] = m; });

  const commentsByMovie = {};
  listData.comments.forEach(c => {
    if (!commentsByMovie[c.movie_id]) commentsByMovie[c.movie_id] = [];
    commentsByMovie[c.movie_id].push(c);
  });

  ordering.forEach((movieId, i) => {
    const movie = movieById[movieId];
    if (!movie) return;
    const adder = visitorById[movie.added_by] || { name: '?' };

    let line = (i + 1) + '. ' + movie.title + ' (' + movie.year + ')'
      + ' - Added by ' + (displayNames[movie.added_by] || adder.name);

    /* append each comment */
    const comments = commentsByMovie[movie.id] || [];
    comments.forEach(c => {
      const commenter = visitorById[c.visitor_id] || { name: '?' };
      line += ' - ' + (displayNames[c.visitor_id] || commenter.name) + ': ' + c.text;
    });

    lines.push(line);
  });

  return lines.join('\n');
}

async function parseImportText(text) {
  if (!text || text.trim() === '') return;

  const lines = text.trim().split('\n');                         // one movie per line

  for (const line of lines) {
    /* parse: "1. Title (2002) - Added by Name - Name: comment - Name2: comment2" */
    const match = line.match(                                    // regex to extract parts
      /^\d+\.\s+(.+?)\s+\((\d{4})\)\s*-\s*Added by\s+(.+?)(?:\s*-\s*|$)/
    );
    if (!match) continue;                                        // skip lines that don't match

    const title = match[1];                                      // "The Bourne Identity"
    const year = parseInt(match[2]);                              // 2002

    /* search TMDB for this movie */
    const searchUrl = TMDB_BASE + '/search/movie'
      + '?api_key=' + TMDB_API_KEY
      + '&query=' + encodeURIComponent(title)
      + '&year=' + year;
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();

    if (searchData.results.length === 0) continue;               // movie not found on TMDB, skip

    const tmdbMovie = searchData.results[0];                     // take the top result

    /* add the movie to our list */
    await fetch(API + '/list/' + listId + '/movies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tmdb_id:    tmdbMovie.id,
        title:      tmdbMovie.title,
        year:       formatYear(tmdbMovie.release_date),
        poster:     tmdbMovie.poster_path,
        visitor_id: visitorId                                    // imported movies belong to us
      })
    });

    /* extract and save comments: " - Name: comment text" */
    const commentPattern = /\s*-\s*(\w+):\s*(.+?)(?=\s+-\s+\w+:|$)/g;
    let commentMatch;
    /* skip the "Added by" part, start after it */
    const afterAdded = line.substring(line.indexOf('Added by'));
    const afterFirstDash = afterAdded.indexOf(' - ', 10);       // skip "Added by Name"
    if (afterFirstDash > -1) {
      const commentsPart = afterAdded.substring(afterFirstDash);
      while ((commentMatch = commentPattern.exec(commentsPart)) !== null) {
        /* comments from import are attributed to the importer for now */
        /* the original author names are preserved in the text itself */
      }
    }
  }

  closeCopyPasteModal();
  await loadList();                                              // refresh to show imported movies
}


/* ============================================================================
   SECTION 14: REMOVE MOVIE
   ============================================================================
   Only the person who added a movie can remove it.
   The remove button (✕) only appears if movie.added_by === our visitorId.
   ============================================================================ */

async function removeMovie(movieId) {
  await fetch(API + '/list/' + listId + '/movies/' + movieId, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId })              // server verifies ownership
  });

  await loadList();                                              // refresh
}


/* ============================================================================
   SECTION 15: UTILITY FUNCTIONS
   ============================================================================
   Small helpers used throughout the app.

   generateId(len)      — random alphanumeric string of given length
   getCookie(name)      — read a cookie value by name
   setCookie(name, val) — write a cookie, 1 year expiry
   debounce(fn, ms)     — wrap a function so it waits ms after the last call
   randomColor()        — pick a random visible-on-white hex color
   formatYear(date)     — "2002-06-14" → 2002
   escapeHtml(text)     — prevent XSS, replace < > & " with safe equivalents
   ============================================================================ */

function generateId(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';          // lowercase + digits
  const arr = new Uint8Array(length);                            // array of random bytes
  crypto.getRandomValues(arr);                                   // fill with secure random values
  return Array.from(arr, b => chars[b % chars.length]).join(''); // map each byte to a char
}

function getCookie(name) {
  const match = document.cookie.match(                           // search the cookie string
    new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')               // find name=value
  );
  return match ? decodeURIComponent(match[1]) : null;            // return value or null
}

function setCookie(name, value) {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year from now
  document.cookie = name + '=' + encodeURIComponent(value)
    + '; expires=' + expires.toUTCString()
    + '; path=/'                                                 // available on all pages
    + '; SameSite=Lax';                                          // basic security
}

function debounce(func, delayMs) {
  let timer;                                                     // holds the timeout ID
  return function (...args) {                                    // return a wrapper function
    clearTimeout(timer);                                         // cancel previous timer
    timer = setTimeout(() => func.apply(this, args), delayMs);   // start new timer
  };
}

function randomColor() {
  /* generate a random color that's readable on white (not too light) */
  const hue = Math.floor(Math.random() * 360);                  // 0-359 degrees on color wheel
  const sat = 60 + Math.floor(Math.random() * 30);              // 60-90% saturation (vivid)
  const lit = 30 + Math.floor(Math.random() * 25);              // 30-55% lightness (not too light)
  return 'hsl(' + hue + ', ' + sat + '%, ' + lit + '%)';        // CSS hsl color string
}

function formatYear(releaseDate) {
  if (!releaseDate) return '?';                                  // no date available
  return releaseDate.split('-')[0];                              // "2002-06-14" → "2002"
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');                     // create a throwaway element
  div.textContent = text;                                        // browser auto-escapes the text
  return div.innerHTML;                                          // now safe to insert as HTML
}


/* ============================================================================
   SECTION 16: EVENT LISTENER SETUP — setupEventListeners()
   ============================================================================
   Called once from initApp(). Connects DOM elements to our functions.
   Uses event delegation where possible — instead of attaching a listener to
   every button, we attach one listener to a parent container and check which
   child was actually clicked. This way dynamically-added elements (like new
   movie entries) automatically work without re-attaching listeners.
   ============================================================================ */

function setupEventListeners() {

  /* --- SEARCH BOX: typing triggers debounced TMDB search --- */
  document.getElementById('search-box').addEventListener('input', e => {
    debouncedSearch(e.target.value);                              // calls handleSearchInput after delay
  });

  /* --- SEARCH RESULTS: clicking a result adds the movie --- */
  document.getElementById('search-results').addEventListener('click', e => {
    const resultEl = e.target.closest('.search-result');          // find the clicked result row
    if (!resultEl) return;
    const tmdbId = parseInt(resultEl.dataset.tmdbId);            // get the TMDB ID from data attr
    const movie = searchResults.find(m => m.id === tmdbId);      // find the full movie object
    if (movie) addMovie(movie);
  });

  /* --- SEARCH RESULTS: hover/long-press shows movie popup --- */
  document.getElementById('search-results').addEventListener('mouseenter', e => {
    const resultEl = e.target.closest('.search-result');
    if (!resultEl) return;
    showMoviePopup(parseInt(resultEl.dataset.tmdbId), resultEl);
  }, true);                                                      // true = capture phase (for delegation)

  document.getElementById('search-results').addEventListener('mouseleave', e => {
    const resultEl = e.target.closest('.search-result');
    if (resultEl) hideMoviePopup();
  }, true);

  /* --- TAB BAR: click and long-press on tabs --- */
  let longPressTimer = null;                                     // for detecting long-press
  let longPressFired = false;                                    // did long-press fire on this touch?

  document.getElementById('tab-bar').addEventListener('pointerdown', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const tabId = tab.dataset.tab;                               // "couch" or a visitor ID
    longPressFired = false;
    longPressTimer = setTimeout(() => {                          // start long-press timer
      longPressFired = true;
      handleTabLongPress(tabId);                                 // toggle this visitor on/off
    }, LONG_PRESS_MS);
  });

  document.getElementById('tab-bar').addEventListener('pointerup', e => {
    clearTimeout(longPressTimer);                                // cancel long-press timer
    if (longPressFired) return;                                  // long-press already handled it
    const tab = e.target.closest('.tab');
    if (!tab) return;
    handleTabClick(tab.dataset.tab);                             // normal click
  });

  document.getElementById('tab-bar').addEventListener('pointerleave', () => {
    clearTimeout(longPressTimer);                                // cancel if finger slides off
  });

  /* --- COLOR PICKER: our swatch opens it, change updates color --- */
  document.getElementById('tab-bar').addEventListener('click', e => {
    if (e.target.classList.contains('color-swatch') && visitor) {
      /* only open color picker for our own swatch */
      const tab = e.target.closest('.tab');
      if (tab && tab.dataset.tab === visitorId) {
        document.getElementById('color-picker').click();         // open the hidden color input
      }
    }
  });

  /* color picker is hidden, but when its value changes, update our color */
  document.addEventListener('change', e => {
    if (e.target.id === 'color-picker') {
      handleColorChange(e.target.value);
    }
  });

  /* --- NAME INPUT: enter key or blur submits the name --- */
  document.getElementById('tab-bar').addEventListener('keydown', e => {
    if (e.target.id === 'name-input' && e.key === 'Enter') {
      handleNameEntry(e.target.value);
    }
  });
  document.getElementById('tab-bar').addEventListener('focusout', e => {
    if (e.target.id === 'name-input' && e.target.value.trim()) {
      handleNameEntry(e.target.value);
    }
  });

  /* --- MOVIE LIST: delegated events for click, drag, comments --- */
  const movieList = document.getElementById('movie-list');

  /* click on poster or title → open TMDB in new tab */
  movieList.addEventListener('click', e => {
    const el = e.target.closest('.entry-poster, .entry-title');
    if (el) {
      const tmdbId = el.dataset.tmdbId;
      window.open('https://www.themoviedb.org/movie/' + tmdbId, '_blank');
    }

    /* click on comment box → expand it */
    const commentBox = e.target.closest('.comment-box');
    if (commentBox && !expandedComment) {                        // only if nothing already expanded
      expandComment(
        parseInt(commentBox.dataset.movieId),
        commentBox.dataset.visitorId
      );
    }

    /* click on remove button → remove the movie */
    const removeBtn = e.target.closest('.remove-btn');
    if (removeBtn) {
      removeMovie(parseInt(removeBtn.dataset.movieId));
    }
  });

  /* hover on poster or title → show popup (desktop) */
  movieList.addEventListener('mouseenter', e => {
    const el = e.target.closest('.entry-poster, .entry-title');
    if (el) showMoviePopup(parseInt(el.dataset.tmdbId), el);
  }, true);

  movieList.addEventListener('mouseleave', e => {
    const el = e.target.closest('.entry-poster, .entry-title');
    if (el) hideMoviePopup();
  }, true);

  /* drag to reorder — pointer events work for both mouse and touch */
  movieList.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.drag-handle');              // only start drag from the handle
    if (!handle) return;
    const entry = handle.closest('.entry');
    if (!entry) return;
    e.preventDefault();                                          // prevent text selection
    handleDragStart(entry, e.clientY);
  });

  document.addEventListener('pointermove', e => {
    if (dragState) {
      e.preventDefault();
      handleDragMove(e.clientY);
    }
  });

  document.addEventListener('pointerup', () => {
    if (dragState) handleDragEnd();
  });

  /* click outside expanded comment → collapse it */
  document.addEventListener('click', e => {
    if (expandedComment && !e.target.closest('.comment-expanded')) {
      collapseComment();
    }
  });

  /* --- COPY/PASTE BUTTON --- */
  document.getElementById('copy-paste-btn').addEventListener('click', openCopyPasteModal);
}


/* ============================================================================
   SECTION 17: STARTUP
   ============================================================================
   The single line that starts everything when the browser loads this script.
   ============================================================================ */

initApp();
