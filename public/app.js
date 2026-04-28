/* ============================================================================
   app.js — whatdoyouwannawatch.com (flat-redesign)
   ============================================================================
   The entire front-end. Runs in the browser. Talks to server.js via fetch().
   TMDB calls happen directly from the browser — our server never talks to TMDB.

   KEY DIFFERENCE FROM v1:
   The server now returns movies with ranks and comments INLINE on each row.
   No more separate rankings or comments arrays to cross-reference.
   Each movie object looks like:
     { id, title, year, poster, added_by,
       user1_rank: 2, user1_comment: "Great film",
       user2_rank: 1, user2_comment: null, ... }

   Visitors are keyed by SLOT NUMBER (1-10), not visitor ID. The slot tells
   you which columns belong to that visitor: slot 3 → user3_rank, user3_comment.

   There is no drag-to-reorder. Instead, up/down arrow buttons swap a movie's
   rank with the one above/below it. One click = one swap = two SQL UPDATEs.

   DATABASE TABLES (on the server, for reference):
   visitors       — id, name, color (global, one row per person)
   lists          — id, created (one row per list)
   list_visitors  — list_id, slot (1-10), visitor_id (who has which slot)
   movies         — id, list_id, tmdb_id, title, year, poster, added_by,
                    user1_rank, user1_comment, ..., user10_rank, user10_comment
   ============================================================================ */


/* ============================================================================
   SECTION 1: CONSTANTS
   ============================================================================ */

const TMDB_API_KEY  = 'bb37c18bfeb7c0d06d9106291b13317b';
const TMDB_BASE     = 'https://api.themoviedb.org/3';
const TMDB_IMG      = 'https://image.tmdb.org/t/p/';
const API           = '/api';
const LIST_ID_LEN   = 8;
const VISITOR_ID_LEN = 10;
const DEBOUNCE_MS   = 300;


/* ============================================================================
   SECTION 2: STATE VARIABLES
   ============================================================================
   listId           — 8-char list ID from the URL
   visitorId        — 10-char visitor ID from the cookie
   visitor          — { id, name, color } from server, or null if not yet named
   listData         — everything about this list from the server:
                      { list, visitors (keyed by slot), movies (with ranks inline) }
   mySlot           — our slot number (1-10) on this list, or null if not joined
   activeTab        — "couch" or a visitor ID string — whose ranking to show
   selectedVisitors — { visitorId: true/false } — who's included in the Couch vote
   searchResults    — array of TMDB movie objects from current search
   expandedComment  — { movieId, visitorId } or null — which comment is expanded
   movieDetailCache — { tmdbId: detailObject } — cached TMDB detail lookups
   displayNames     — { visitorId: "Doug" or "Doug(2)" } — per-list display names
   ============================================================================ */

let appMode           = 'list';                                    // 'list' (Couchlist) or 'shelf' (My Shelf)
let listId            = null;
let visitorId         = null;
let visitor           = null;
let listData          = null;
let shelfData         = null;                                      // { visitor, lists, movies } from /shelf
let mySlot            = null;                                      // NEW: my slot (1-10) on this list
let activeTab         = 'couch';
let selectedVisitors  = {};
let searchResults     = [];
let expandedComment   = null;
let movieDetailCache  = {};
let displayNames      = {};

/* Shelf-only state — set in shelf mode, ignored in list mode.
   `shelfSelected === null` means "uninitialized for the current tab" —
   the renderer fills it with everything checked on first render. The user
   explicitly unchecking all leaves it as an empty Set, NOT null, so we
   don't auto-recheck behind their back. */
let shelfSelected     = null;
let shelfManageOpen   = false;                                     // is the Manage modal up?
let shelfReadySnap    = null;                                      // RDY snapshot taken at modal-open


/* ============================================================================
   SECTION 3: INITIALIZATION — initApp()
   ============================================================================
   1. Read URL path → listId (or generate one and redirect)
   2. Read cookie → visitorId (or generate one)
   3. Fetch visitor profile from server
   4. Load the list data and render
   5. Wire up event listeners
   ============================================================================ */

function initApp() {
  const urlPath = window.location.pathname.replace(/^\//, '');

  visitorId = getCookie('wtw_visitor');
  if (!visitorId) {
    visitorId = generateId(VISITOR_ID_LEN);
    setCookie('wtw_visitor', visitorId);
  }

  /* Bare `/` lands on My Shelf; `/<8charid>` is the existing Couchlist view. */
  if (!urlPath || urlPath === '') {
    appMode = 'shelf';
    initShelf();
    return;
  }

  appMode = 'list';
  listId = urlPath;

  loadVisitorProfile().then(() => {
    return loadList();
  }).then(() => {
    setupEventListeners();
    console.log('app.js BUILD myshelf-step4');
    document.title = 'CouchList';

    /* pendingPaste hook: if a previous Apply redirected us here (either for
       a URL swap or a visitor swap), run the blob now that we're on the
       right list/visitor. applyPasteText clears the entry on success. */
    const pending = sessionStorage.getItem('pendingPaste');
    if (pending) {
      const parsed = parseBlob(pending);
      if (parsed && parsed.list_id === listId) {
        applyPasteText(pending);
      }
    }
  });
}


/* ============================================================================
   SECTION 4: VISITOR MANAGEMENT
   ============================================================================
   loadVisitorProfile()       — fetch our name/color from server on startup
   handleNameEntry(nameText)  — user typed a name and hit enter
   handleColorChange(color)   — user picked a new color
   restoreVisitorId(oldId)    — user pasted an old visitor ID to recover it
   ============================================================================ */

async function loadVisitorProfile() {
  const resp = await fetch(API + '/visitor/' + visitorId);
  if (resp.ok) {
    visitor = await resp.json();
  } else {
    visitor = null;
  }
}

async function handleNameEntry(nameText) {
  if (!nameText || nameText.trim() === '') return;
  nameText = nameText.trim();

  /* check if name is taken on this list */
  const checkResp = await fetch(
    API + '/list/' + listId + '/check-name/' + encodeURIComponent(nameText)
    + '?visitor_id=' + visitorId
  );
  const checkData = await checkResp.json();

  if (checkData.taken) {
    showNameWarning('Name taken — you\'ll appear as "' + nameText + '(2)"');
    nameText = nameText + '(2)';
  }

  /* create or update our visitor profile */
  const color = visitor ? visitor.color : randomColor();
  const resp = await fetch(API + '/visitor/' + visitorId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nameText, color: color })
  });
  visitor = await resp.json();

  /* claim a slot on this list so we can comment/rank before adding a movie,
     and so other visitors see our tab as soon as we have a name */
  await fetch(API + '/list/' + listId + '/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId })
  });

  hideNameWarning();
  updateSearchArea();
  await loadList();
}

async function handleColorChange(newColor) {
  if (!visitor) return;
  visitor.color = newColor;

  await fetch(API + '/visitor/' + visitorId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: visitor.name, color: newColor })
  });

  renderUserTabs();
  updateSearchArea();
  renderList();
}

function restoreVisitorId(oldId) {
  if (!oldId || oldId.trim().length !== VISITOR_ID_LEN) return;
  visitorId = oldId.trim();
  setCookie('wtw_visitor', visitorId);
  window.location.reload();
}

function showNameWarning(msg) {
  const el = document.getElementById('name-warning');
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
   Called on page load and after any change (add, delete, swap, comment).

   Server returns:
   {
     list:     { id, created },
     visitors: { "1": { id, name, color, slot }, ... },   ← keyed by slot
     movies:   [ { id, title, year, ..., user1_rank, user1_comment, ... }, ... ]
   }

   After fetching, we figure out:
   - mySlot: which slot number we have (or null if not joined)
   - selectedVisitors: who's toggled on for the Couch vote
   - displayNames: collision-handled display names
   Then re-render everything.
   ============================================================================ */

async function loadList() {
  /* pass visitor_id so the response includes our private list nickname */
  const resp = await fetch(API + '/list/' + listId
    + (visitorId ? '?visitor_id=' + encodeURIComponent(visitorId) : ''));

  if (!resp.ok) {
    /* list doesn't exist yet — start with empty data */
    listData = {
      list: { id: listId },
      visitors: {},
      movies: [],
      your_list_name: null
    };
  } else {
    listData = await resp.json();
  }

  /* figure out our slot number on this list */
  mySlot = null;
  Object.entries(listData.visitors).forEach(([slot, v]) => {
    if (v.id === visitorId) mySlot = parseInt(slot);
  });

  /* selectedVisitors mirrors server state — v.ready is authoritative */
  selectedVisitors = {};
  Object.values(listData.visitors).forEach(v => {
    selectedVisitors[v.id] = (v.ready !== false);
  });

  buildDisplayNames();
  updateSearchArea();
  renderUserTabs();
  renderList();
}

/* show the search box only if the visitor has a name, otherwise show a welcome message */
function updateSearchArea() {
  const searchBox = document.getElementById('search-box');
  const welcome = document.getElementById('welcome-msg');
  const colorDot = document.getElementById('my-color-dot');
  if (visitor) {
    searchBox.style.display = '';
    welcome.style.display = 'none';
    if (colorDot) {
      colorDot.style.display = '';
      colorDot.style.background = visitor.color;
    }
  } else {
    searchBox.style.display = 'none';
    welcome.style.display = 'block';
    if (colorDot) colorDot.style.display = 'none';
  }
}


/* ============================================================================
   buildDisplayNames()
   ============================================================================
   Handles name collisions on a single list. Two people both named "Doug"
   → first keeps "Doug", second becomes "Doug(2)". Only affects display.
   ============================================================================ */

function buildDisplayNames() {
  displayNames = {};
  const nameCount = {};

  /* process visitors in slot order (1, 2, 3...) */
  const sortedSlots = Object.keys(listData.visitors).sort((a, b) => a - b);
  sortedSlots.forEach(slot => {
    const v = listData.visitors[slot];
    const lower = v.name.toLowerCase();
    if (!nameCount[lower]) {
      nameCount[lower] = 1;
      displayNames[v.id] = v.name;
    } else {
      nameCount[lower]++;
      displayNames[v.id] = v.name + '(' + nameCount[lower] + ')';
    }
  });

  /* check if our own visitor collides but isn't on the list yet */
  if (visitor && !displayNames[visitorId]) {
    const lower = visitor.name.toLowerCase();
    if (nameCount[lower]) {
      nameCount[lower]++;
      displayNames[visitorId] = visitor.name + '(' + nameCount[lower] + ')';
    } else {
      displayNames[visitorId] = visitor.name;
    }
  }
}


/* ============================================================================
   SECTION 6: TMDB SEARCH
   ============================================================================
   Search box → TMDB /search/multi → dropdown results → click to add.
   TV shows and movies are treated the same end-to-end: TV results get
   normalized (name → title, first_air_date → release_date) before being
   stored in searchResults, so every downstream renderer keeps working.
   The only piece that still needs to know the difference is the popup,
   which has to hit /movie/:id vs /tv/:id — so we stash media_type on each
   result and forward it to the server on add.
   ============================================================================ */

const debouncedSearch = debounce(handleSearchInput, DEBOUNCE_MS);

function handleSearchInput(queryText) {
  if (!queryText || queryText.length < 2) {
    searchResults = [];
    renderSearchResults();
    return;
  }
  searchTMDB(queryText);
}

/* Take a raw TMDB /search/multi hit and return the shape the rest of the UI
   expects: { id, media_type, title, release_date, poster_path, ...raw }.
   TV entries use `name` and `first_air_date`; we copy those into the movie-
   shaped fields so renderers don't have to branch. */
function normalizeTmdbResult(r) {
  if (r.media_type === 'tv') {
    return Object.assign({}, r, {
      title:        r.name,
      release_date: r.first_air_date,
    });
  }
  return r;
}

async function searchTMDB(query) {
  const url = TMDB_BASE + '/search/multi'
    + '?api_key=' + TMDB_API_KEY
    + '&query=' + encodeURIComponent(query);

  const resp = await fetch(url);
  const data = await resp.json();
  searchResults = (data.results || [])
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
    .map(normalizeTmdbResult)
    .slice(0, 8);
  renderSearchResults();
}

function renderSearchResults() {
  const container = document.getElementById('search-results');

  if (searchResults.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = searchResults.map(movie => {
    const year = formatYear(movie.release_date);
    const posterThumb = movie.poster_path
      ? TMDB_IMG + 'w45' + movie.poster_path
      : '';
    /* tiny TV badge so users can tell a show from a same-named movie */
    const tvBadge = movie.media_type === 'tv' ? ' <span class="tv-badge">TV</span>' : '';
    return '<div class="search-result" data-tmdb-id="' + movie.id
         + '" data-media-type="' + movie.media_type + '">'
      + (posterThumb ? '<img src="' + posterThumb + '" class="search-thumb">' : '')
      + '<span>' + escapeHtml(movie.title) + ' (' + year + ')' + tvBadge + '</span>'
      + '</div>';
  }).join('');
}

async function addMovie(tmdbMovie) {
  if (!visitor) {
    showNameWarning('Enter your name before adding movies');
    return;
  }

  const year = formatYear(tmdbMovie.release_date);

  await fetch(API + '/list/' + listId + '/movies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tmdb_id:    tmdbMovie.id,
      media_type: tmdbMovie.media_type || 'movie',
      title:      tmdbMovie.title,
      year:       year,
      poster:     tmdbMovie.poster_path,
      visitor_id: visitorId
    })
  });

  document.getElementById('search-box').value = '';
  searchResults = [];
  renderSearchResults();
  hideMoviePopup();
  await loadList();
}


/* ============================================================================
   SECTION 7: RENDERING THE MOVIE LIST — renderList()
   ============================================================================
   The main draw function. Clears the list and rebuilds every entry.

   Picks which ordering to use based on activeTab:
   — "couch"    → Borda score (sum of all selected visitors' ranks, lowest wins)
   — visitorId  → that visitor's rank column, sorted ascending

   Borda is computed INLINE here — no separate calculateCouchRanking() function.
   For each movie, sum up the rank columns of all selected voters. Lower = better.
   Ties share a label like "23-24" (or "39-43" for a 5-way tie) shown in
   place of the rank number on every tied row. Ties are broken randomly for
   internal ordering only — the displayed number is the same across the run.

   --- renderEntry(movie, position, tieLabel, visitorById, isMyTab, isCouchTab) ---
   Builds one row. The two leftmost grid cells (cols A and B) follow a
   tab-dependent visual language — see the comment at the top of renderEntry.
   ============================================================================ */

/* Push the current RDY users' colors into --rdy-gradient on :root.
   Style.css uses this gradient as a background clipped to the shape of
   prominent text (movie titles, rank numbers). 0 RDY → white fallback;
   1 RDY → solid color of that user; 2+ → left-to-right gradient through
   their colors in slot order. Called from renderList() so the gradient
   updates whenever ready state changes. */
function applyRdyGradient() {
  if (!listData || !listData.visitors) return;
  /* slot-ordered for stability — 1, 2, 3 ... */
  const sortedSlots = Object.keys(listData.visitors).sort((a, b) => a - b);
  const colors = sortedSlots
    .map(slot => listData.visitors[slot])
    .filter(v => selectedVisitors[v.id])
    .map(v => v.color);
  let gradient;
  if (colors.length === 0) {
    gradient = 'linear-gradient(90deg, #ffffff, #ffffff)';
  } else if (colors.length === 1) {
    gradient = 'linear-gradient(90deg, ' + colors[0] + ', ' + colors[0] + ')';
  } else {
    gradient = 'linear-gradient(90deg, ' + colors.join(', ') + ')';
  }
  document.documentElement.style.setProperty('--rdy-gradient', gradient);
}

function renderList() {
  applyRdyGradient();
  const container = document.getElementById('movie-list');
  const movies = listData.movies.slice();                          // copy so we can sort

  /* build lookup: visitor id → slot number */
  const slotByVisitorId = {};
  Object.entries(listData.visitors).forEach(([slot, v]) => {
    slotByVisitorId[v.id] = parseInt(slot);
  });

  /* build lookup: visitor id → visitor object (for names, colors in comments) */
  const visitorById = {};
  Object.values(listData.visitors).forEach(v => { visitorById[v.id] = v; });

  /* row-height experiment — row height is a function of visitor count.
     Every visitor gets a comment pill, pills stack in the comments column,
     so the comments stack determines the row height. Poster column width =
     rowHeight * TMDB aspect (92/138). Remaining columns split the leftover
     width using their original percent ratios.
     Pill box model: 12px font * 1.2 line-height = 14.4 content, + 2px
     vertical padding + 2px border = 18.4px — rounded to 19 for a tiny
     safety margin. Gap between pills = 2px. Entry has 8px top/bottom
     padding (16 total).
     Title clamp = N lines: now that the adder badge is gone the title
     can use the full row height instead of leaving the bottom row free. */
  const N        = Math.max(1, Object.keys(listData.visitors).length);
  const pillH    = 19;
  const pillGap  = 2;
  const entryPad = 16;
  const rowH     = N * pillH + (N - 1) * pillGap + entryPad;
  const posterW  = Math.round(rowH * 92 / 138);
  container.style.setProperty('--row-height',  rowH + 'px');
  container.style.setProperty('--poster-width', posterW + 'px');
  container.style.setProperty('--title-lines', String(N));

  /* figure out which tab we're on and what slot that corresponds to */
  let viewSlot = null;                                             // which slot's ranking to show
  const isMyTab = (activeTab === visitorId);                       // are we viewing our own tab?
  let isCouchTab = (activeTab === 'couch');
  let couchTies = {};                                              // { movieId: "2-3" } for ties

  if (!isCouchTab) {
    /* viewing a specific visitor's tab — find their slot */
    viewSlot = slotByVisitorId[activeTab] || null;
  }

  /* --- SORTING --- */

  if (isCouchTab) {
    /* BORDA: sum ranks from all selected voters, lowest sum wins */

    /* find which slots are selected (toggled ON and actually have a visitor) */
    const activeSlots = [];
    Object.entries(listData.visitors).forEach(([slot, v]) => {
      if (selectedVisitors[v.id] !== false) activeSlots.push(parseInt(slot));
    });

    if (activeSlots.length === 0) {
      /* no voters selected — just show in movie-ID order */
      movies.sort((a, b) => a.id - b.id);
    } else {
      const numMovies = movies.length;

      /* compute score for each movie */
      movies.forEach(m => {
        m._score = 0;
        activeSlots.forEach(slot => {
          const rank = m['user' + slot + '_rank'];
          /* if a slot has no rank for this movie (shouldn't happen), penalize it */
          m._score += (rank != null) ? rank : (numMovies + 1);
        });
      });

      /* sort by score ascending (lowest = best). break ties randomly. */
      movies.sort((a, b) => {
        if (a._score !== b._score) return a._score - b._score;
        return Math.random() - 0.5;
      });

      /* detect ties and build tie labels */
      let i = 0;
      while (i < movies.length) {
        let j = i + 1;
        while (j < movies.length && movies[j]._score === movies[i]._score) j++;
        if (j - i > 1) {
          const label = (i + 1) + '-' + j;                        // e.g. "2-4"
          for (let k = i; k < j; k++) {
            couchTies[movies[k].id] = label;
          }
        }
        i = j;
      }
    }
  } else if (viewSlot) {
    /* viewing a specific visitor's ranking — sort by their rank column */
    const col = 'user' + viewSlot + '_rank';
    movies.sort((a, b) => (a[col] || 999) - (b[col] || 999));
  } else {
    /* fallback: visitor not on this list yet, show by movie ID */
    movies.sort((a, b) => a.id - b.id);
  }

  /* --- RENDER EACH ENTRY --- */
  container.innerHTML = '';

  movies.forEach((movie, index) => {
    const position = index + 1;
    const tieLabel = isCouchTab ? (couchTies[movie.id] || null) : null;
    const entry = renderEntry(movie, position, tieLabel, visitorById, isMyTab, isCouchTab);
    container.appendChild(entry);
  });
}

function renderEntry(movie, position, tieLabel, visitorById, isMyTab, isCouchTab) {
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.dataset.movieId = movie.id;

  /* VISUAL LANGUAGE FOR THE TWO LEFT-MOST CELLS (cols A and B):
       your rank → LEFT (col A)
       others'   → RIGHT (col B)
       Couch     → the two ranks merged into one centered number in the middle
     Concretely:
       - Your tab    : your rank in A, drag handle in B.
       - Other's tab : your own rank in A (faded gray-blue, out of order
                       since the list is sorted by THEIR ranks), their rank
                       in B (brand blue).
       - Couch tab   : a single rank cell spans cols 1-2, centered.
                       Tied positions show a range like "23-24" or "39-43"
                       repeated on every tied row (no separate "tied" pill).

     Cols C–F are unchanged: poster | title | comments | remove. The remove
     cell is always emitted so col F's width never shifts between tabs. */

  let leftHtml, rightHtml;

  if (isCouchTab) {
    /* Couch: one centered rank that spans cols 1-2. Tied → range string. */
    const labelText = tieLabel || String(position);
    leftHtml = '<div class="entry-rank entry-rank-couch">'
      + '<span class="rank-number">' + escapeHtml(labelText) + '</span>'
      + '</div>';
    rightHtml = '';
  } else if (isMyTab) {
    /* Your tab: your rank in A, drag handle in B (the reverse of the
       earlier layout). The handle gets `touch-action:none` so finger drags
       start a drag instead of scrolling the page. */
    leftHtml = '<div class="entry-rank">'
      + '<span class="rank-number">' + position + '</span>'
      + '</div>';
    rightHtml = mySlot
      ? '<div class="entry-grab">'
          + '<div class="grab-handle" data-movie-id="' + movie.id + '" aria-label="Drag to reorder">'
          + '<span class="grab-icon">&#9776;</span>'        /* ☰ three-bars icon */
          + '</div>'
        + '</div>'
      : '<div class="entry-grab"></div>';
  } else {
    /* Other's tab: your own rank in A (faded), their rank in B (blue).
       The list is sorted by their ranks so your own column appears
       out-of-order — that's the point: it's a glanceable comparison. */
    const myRank = (mySlot != null) ? movie['user' + mySlot + '_rank'] : null;
    const myRankStr = (myRank != null) ? String(myRank) : '';
    leftHtml = '<div class="entry-rank entry-rank-mine-shadow">'
      + (myRankStr ? '<span class="rank-number">' + escapeHtml(myRankStr) + '</span>' : '')
      + '</div>';
    rightHtml = '<div class="entry-rank entry-rank-other">'
      + '<span class="rank-number">' + position + '</span>'
      + '</div>';
  }

  /* POSTER THUMBNAIL — media_type rides along so popup/link can hit the right TMDB endpoint */
  const posterUrl = movie.poster
    ? TMDB_IMG + 'w92' + movie.poster
    : '';
  const mediaType = movie.media_type || 'movie';
  const posterHtml = '<div class="entry-poster" data-tmdb-id="' + movie.tmdb_id
    + '" data-media-type="' + mediaType + '">'
    + (posterUrl ? '<img src="' + posterUrl + '">' : '<div class="no-poster">?</div>')
    + '</div>';

  /* TITLE — just the title text now. The adder badge is gone (the adder
     is implicit: their comment is always the first pill in the comments
     column). The "tied" pill is gone too — see the rank cell above. */
  const titleHtml = '<div class="entry-title" data-tmdb-id="' + movie.tmdb_id
    + '" data-media-type="' + mediaType + '">'
    + '<div class="entry-title-text">'
    + escapeHtml(movie.title) + ' (' + movie.year + ')'
    + '</div>'
    + '</div>';

  /* 5. COMMENTS — one pill per occupied visitor slot, always emitted so
     each list member is visible on every row (blank pills are "Name: rank"
     with an empty comment). Each pill shows the visitor's rank for this
     movie right after their name, then the comment text if any.
     The movie adder's pill goes first, then the rest in slot order. */
  let commentsHtml = '<div class="entry-comments">';

  const pillEntries = [];
  Object.entries(listData.visitors).forEach(([slot, v]) => {
    const text = movie['user' + slot + '_comment'] || '';
    const rank = movie['user' + slot + '_rank'];
    pillEntries.push({ visitorId: v.id, slot: parseInt(slot), text: text, rank: rank });
  });

  pillEntries.sort((a, b) => {
    if (a.visitorId === movie.added_by) return -1;
    if (b.visitorId === movie.added_by) return 1;
    return a.slot - b.slot;
  });

  pillEntries.forEach(c => {
    const commenter = visitorById[c.visitorId] || { name: '?', color: '#999' };
    const rankStr = (c.rank != null) ? '(' + c.rank + ')' : '';
    commentsHtml += '<div class="comment-row">'
      + '<div class="comment-box" '
        + 'data-movie-id="' + movie.id + '" '
        + 'data-visitor-id="' + c.visitorId + '" '
        + 'style="color: ' + escapeHtml(commenter.color) + '">'
        + '<strong>' + escapeHtml(displayNames[c.visitorId] || commenter.name) + ':</strong>'
        + (c.text ? ' ' + escapeHtml(c.text) : '')
      + '</div>'
      + (rankStr ? '<span class="comment-rank" style="color: ' + escapeHtml(commenter.color) + '">' + escapeHtml(rankStr) + '</span>' : '')
      + '</div>';
  });

  commentsHtml += '</div>';

  /* 6. REMOVE CELL — wrapper is always emitted so column F's width never
     shifts; the X button lives inside only when this is your movie. */
  const removeHtml = '<div class="entry-remove">'
    + (movie.added_by === visitorId
        ? '<button class="remove-btn" data-movie-id="' + movie.id + '">✕</button>'
        : '')
    + '</div>';

  entry.innerHTML = leftHtml + rightHtml + posterHtml + titleHtml + commentsHtml + removeHtml;
  return entry;
}


/* ============================================================================
   SECTION 8: DRAG TO REORDER  (transform-the-original — no clone)
   ============================================================================
   On your own tab each row has a grab handle. Pointerdown on it starts a
   drag; pointermove translates the row to follow the finger; pointerup
   commits the new order to the server via /api/list/:id/my-ranks.

   The dragged row IS the row — we don't clone. While dragging:
     - The original entry stays in its grid slot, so column widths and row
       heights remain identical to every other row (no layout shift).
     - We `transform: translateY(...)` it each frame to follow the pointer.
       Transform is a paint-only operation, so the row visually leaves its
       slot but still occupies its layout space — leaving a "gap" exactly
       where it used to sit.
     - z-index lifts it above its siblings; the .dragging CSS class adds
       the lift-off look (opacity/shadow) and pointer-events:none so
       elementFromPoint can find the row UNDER the floating one.
     - The handle keeps pointer events via setPointerCapture, so the drag
       continues even though the entry around it is pointer-events:none.

   No server call until the drop. One trip, one source of truth. Auto-scroll
   near viewport edges is a simple rAF loop. touch-action:none on the
   handle means the browser doesn't steal the gesture for its own scroll.
   ============================================================================ */

let dragState = null;     /* { movieId, originalEntry, handle, pointerId,
                              orderedMovieIds, startIndex, currentIndex,
                              startEntryTop, grabOffsetY, pointerY,
                              autoScrollDir, autoScrollFrame,
                              topBar, bottomBar, inEdgeBar, edgeBarHeight } */

function onGrabPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;           // left click / primary touch only
  /* In list mode you must have a slot before reordering; in shelf mode anyone
     with master_rank entries (i.e. any visitor with movies) can reorder. */
  if (appMode === 'list' && !mySlot) return;

  const handle = e.target.closest('.grab-handle');
  if (!handle) return;
  const entry = handle.closest('.entry');
  if (!entry) return;

  e.preventDefault();                                             // stop text selection / native drag
  handle.setPointerCapture(e.pointerId);

  /* snapshot the on-screen order AT drag start. Every drop target index is
     relative to this list, not a live query — so sorting/reflow during the
     drag can't desync us. List mode commits movie-row IDs; shelf mode commits
     (tmdb_id, media_type) keys, so we capture both. */
  const entries = Array.from(document.querySelectorAll('#movie-list .entry'));
  const orderedMovieIds = entries.map(el => parseInt(el.dataset.movieId));
  const orderedShelfKeys = entries.map(el => ({
    tmdb_id: parseInt(el.dataset.tmdbId),
    media_type: el.dataset.mediaType
  }));
  const startIndex = entries.indexOf(entry);

  /* No clone. The row itself is the floater. Track the pointer in PAGE
     coords (clientY + scrollY) so auto-scroll during the drag doesn't
     cause the row to drift away from the finger. */
  const rect = entry.getBoundingClientRect();
  const startPointerPageY = e.clientY + window.scrollY;
  entry.classList.add('dragging');
  entry.style.willChange = 'transform';                           // hint the browser to GPU-promote

  /* build the two edge bars — pinned to the visible top/bottom each frame */
  const topBar = document.createElement('div');
  topBar.className = 'drag-edge-bar drag-edge-bar-top';
  topBar.textContent = 'To the top!';
  const bottomBar = document.createElement('div');
  bottomBar.className = 'drag-edge-bar drag-edge-bar-bottom';
  bottomBar.textContent = 'To the bottom!';
  document.body.appendChild(topBar);
  document.body.appendChild(bottomBar);

  dragState = {
    movieId: parseInt(entry.dataset.movieId),
    originalEntry: entry,
    handle: handle,
    pointerId: e.pointerId,
    startPointerPageY: startPointerPageY,                          // page-coord pointer Y at drag start
    orderedMovieIds: orderedMovieIds,
    orderedShelfKeys: orderedShelfKeys,
    startIndex: startIndex,
    currentIndex: startIndex,
    pointerY: e.clientY,
    autoScrollDir: 0,
    autoScrollFrame: null,
    topBar: topBar,
    bottomBar: bottomBar,
    inEdgeBar: null,                                              // 'top' | 'bottom' | null
  };

  positionEdgeBars();

  handle.addEventListener('pointermove', onDragPointerMove);
  handle.addEventListener('pointerup', onDragPointerUp);
  handle.addEventListener('pointercancel', onDragPointerUp);
}

function onDragPointerMove(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  dragState.pointerY = e.clientY;
  applyDragTransform();

  positionEdgeBars();
  updateDropIndicator();
  updateAutoScroll();
}

/* Translate the original row by however far the pointer has moved in PAGE
   coordinates (clientY + scrollY) since drag start. Page coords mean the
   transform stays correct even when the page scrolls underneath us during
   auto-scroll — the layout slot of the row doesn't move when the page
   scrolls, so we want translation to track absolute pointer movement. */
function applyDragTransform() {
  if (!dragState) return;
  const currentPointerPageY = dragState.pointerY + window.scrollY;
  const deltaY = currentPointerPageY - dragState.startPointerPageY;
  dragState.originalEntry.style.transform = 'translateY(' + deltaY + 'px)';
}

function onDragPointerUp(e) {
  if (!dragState || e.pointerId !== dragState.pointerId) return;

  const targetIndex = dragState.currentIndex;
  const startIndex = dragState.startIndex;
  const orderedMovieIds = dragState.orderedMovieIds.slice();
  const orderedShelfKeys = dragState.orderedShelfKeys
    ? dragState.orderedShelfKeys.slice()
    : null;

  /* tear down drag UI first, regardless of whether anything changed */
  stopAutoScroll();
  dragState.originalEntry.classList.remove('dragging');
  dragState.originalEntry.style.transform = '';
  dragState.originalEntry.style.willChange = '';
  document.querySelectorAll('#movie-list .entry.drop-above, #movie-list .entry.drop-below')
    .forEach(el => el.classList.remove('drop-above', 'drop-below'));
  dragState.topBar.remove();
  dragState.bottomBar.remove();
  const handle = dragState.handle;
  handle.removeEventListener('pointermove', onDragPointerMove);
  handle.removeEventListener('pointerup', onDragPointerUp);
  handle.removeEventListener('pointercancel', onDragPointerUp);
  try { handle.releasePointerCapture(dragState.pointerId); } catch (_) { /* already released */ }
  dragState = null;

  if (targetIndex === startIndex) return;                         // dropped in place, no-op

  /* build the new order: pull the dragged id (or key), reinsert at target.
     We do both in parallel so list-mode and shelf-mode commits stay symmetric. */
  const [draggedId] = orderedMovieIds.splice(startIndex, 1);
  orderedMovieIds.splice(targetIndex, 0, draggedId);
  if (orderedShelfKeys) {
    const [draggedKey] = orderedShelfKeys.splice(startIndex, 1);
    orderedShelfKeys.splice(targetIndex, 0, draggedKey);
  }

  if (appMode === 'shelf') {
    if (activeTab === 'me') {
      commitShelfReorder(orderedShelfKeys);
    } else {
      /* list-tab in shelf mode: activeTab is a list_id, entries carry per-list movie_ids */
      commitShelfListReorder(activeTab, orderedMovieIds);
    }
  } else {
    commitReorder(orderedMovieIds);
  }
}

/* Position the "To the top!" / "To the bottom!" bars flush with the
   visible viewport. Uses visualViewport when available so pinch-zoom
   works. Height is scaled by the zoom factor so the bars stay a
   consistent on-screen size (~44px). */
const EDGE_BAR_SCREEN_HEIGHT = 44;

function positionEdgeBars() {
  if (!dragState) return;
  const vv = window.visualViewport;
  const scale    = vv ? vv.scale       : 1;
  const visTop   = vv ? vv.offsetTop   : 0;
  const visLeft  = vv ? vv.offsetLeft  : 0;
  const visW     = vv ? vv.width       : window.innerWidth;
  const visH     = vv ? vv.height      : window.innerHeight;
  const barH     = EDGE_BAR_SCREEN_HEIGHT / scale;                 // layout px that renders to ~44 screen px
  const fontPx   = 18 / scale;

  const t = dragState.topBar;
  t.style.top    = visTop + 'px';
  t.style.left   = visLeft + 'px';
  t.style.width  = visW + 'px';
  t.style.height = barH + 'px';
  t.style.fontSize = fontPx + 'px';

  const b = dragState.bottomBar;
  b.style.top    = (visTop + visH - barH) + 'px';
  b.style.left   = visLeft + 'px';
  b.style.width  = visW + 'px';
  b.style.height = barH + 'px';
  b.style.fontSize = fontPx + 'px';

  dragState.edgeBarHeight = barH;                                  // cached for hit-testing
}

/* Figure out which gap the pointer is currently over and paint the drop
   indicator there. The edge bars win: if the pointer is inside either bar
   we commit to rank 1 or last and suppress the in-list indicator. Else
   we compute midlines of every non-dragging entry and find which one the
   pointer is above vs. below. */
function updateDropIndicator() {
  if (!dragState) return;
  const entries = Array.from(document.querySelectorAll('#movie-list .entry'));
  const y = dragState.pointerY;

  /* --- edge bars first ---
     y is in layout coords; so are the bar boundaries we just computed. */
  const vv = window.visualViewport;
  const visTop = vv ? vv.offsetTop : 0;
  const visH   = vv ? vv.height    : window.innerHeight;
  const barH   = dragState.edgeBarHeight || (EDGE_BAR_SCREEN_HEIGHT);
  const topBarBottom    = visTop + barH;
  const bottomBarTop    = visTop + visH - barH;

  dragState.topBar.classList.remove('active');
  dragState.bottomBar.classList.remove('active');

  if (y <= topBarBottom) {
    /* commit: jump to rank 1 */
    document.querySelectorAll('#movie-list .entry.drop-above, #movie-list .entry.drop-below')
      .forEach(el => el.classList.remove('drop-above', 'drop-below'));
    dragState.topBar.classList.add('active');
    dragState.inEdgeBar = 'top';
    dragState.currentIndex = 0;
    return;
  }
  if (y >= bottomBarTop) {
    /* commit: jump to last rank */
    document.querySelectorAll('#movie-list .entry.drop-above, #movie-list .entry.drop-below')
      .forEach(el => el.classList.remove('drop-above', 'drop-below'));
    dragState.bottomBar.classList.add('active');
    dragState.inEdgeBar = 'bottom';
    dragState.currentIndex = entries.length - 1;
    return;
  }
  dragState.inEdgeBar = null;

  let targetIndex = dragState.startIndex;                         // default: unchanged
  let indicatorEntry = null;
  let indicatorSide = null;                                       // 'above' or 'below'

  /* walk entries in order, skipping the dragged row; stop at the first
     non-dragging entry whose midline is below the pointer */
  let placed = false;
  for (let i = 0; i < entries.length; i++) {
    const el = entries[i];
    if (el === dragState.originalEntry) continue;
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (y < mid) {
      targetIndex = i;
      /* dropping ABOVE entry i. If the original (still occupying its slot)
         sits between i-1 and i, landing above entry i from the original's
         old position means the same place — account for that by comparing
         to startIndex below. */
      if (i > dragState.startIndex) targetIndex -= 1;             // shift because the original will be removed from above
      indicatorEntry = el;
      indicatorSide = 'above';
      placed = true;
      break;
    }
  }
  if (!placed) {
    /* past everything → drop at the very bottom. The last non-dragging
       entry gets a bottom bar. */
    targetIndex = entries.length - 1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i] !== dragState.originalEntry) { indicatorEntry = entries[i]; break; }
    }
    indicatorSide = 'below';
    /* if original was already at the end, targetIndex should equal
       startIndex → no move; fall through is fine */
  }

  /* repaint indicator */
  document.querySelectorAll('#movie-list .entry.drop-above, #movie-list .entry.drop-below')
    .forEach(el => el.classList.remove('drop-above', 'drop-below'));
  if (indicatorEntry && targetIndex !== dragState.startIndex) {
    indicatorEntry.classList.add(indicatorSide === 'above' ? 'drop-above' : 'drop-below');
  }

  dragState.currentIndex = targetIndex;
}

/* --- Auto-scroll ---
   When the pointer is within EDGE_PX of the top or bottom of the viewport,
   scroll the page in that direction at a speed proportional to how close.
   Uses requestAnimationFrame so we don't hammer scroll; tick cancels itself
   when the pointer pulls away from the edge.

   Pinch-zoom note: the browser has two independent scroll states — the
   layout scroll (window.scrollY) and the visual-viewport pan (what moves
   when you one-finger-drag around while zoomed). window.scrollBy only
   moves the layout; it can't pan the visual viewport. So when scrollBy
   bottoms out at a document edge while the visual viewport still has room
   to pan, we fall back to scrollIntoView on the edgemost entry —
   scrollIntoView is allowed to pan the visual viewport. */
const EDGE_PX = 70;
const MAX_SCROLL_PX_PER_FRAME = 14;

function updateAutoScroll() {
  if (!dragState) return;

  /* clientY is in layout-viewport coordinates. When pinch-zoomed, the
     user's visible region is a sub-rect of the layout viewport, tracked
     by visualViewport. The finger "at the edge of the screen" is at the
     edge of the VISUAL viewport, not the layout one — so we translate
     clientY into visual-viewport space before checking proximity. */
  const vv = window.visualViewport;
  const visHeight = vv ? vv.height      : window.innerHeight;
  const visTop    = vv ? vv.offsetTop   : 0;
  const yInVis    = dragState.pointerY - visTop;                    // 0 = top of visible area

  let dir = 0;
  if (yInVis < EDGE_PX)                    dir = -1 * (1 - yInVis / EDGE_PX);
  else if (yInVis > visHeight - EDGE_PX)   dir = 1 * (1 - (visHeight - yInVis) / EDGE_PX);
  dragState.autoScrollDir = dir;

  if (dir !== 0 && !dragState.autoScrollFrame) {
    const tick = () => {
      if (!dragState || dragState.autoScrollDir === 0) {
        if (dragState) dragState.autoScrollFrame = null;
        return;
      }
      const delta = dragState.autoScrollDir * MAX_SCROLL_PX_PER_FRAME;

      /* try layout-scroll first; cheap and smooth when not zoomed */
      window.scrollBy(0, delta);

      /* scrollIntoView fallback — only when the DOCUMENT is actually at its
         scroll boundary AND the visual viewport still has room to pan
         inward (i.e. user is pinch-zoomed and hasn't reached the real edge
         of the list yet). We can't key off "did scrollBy move?" — small
         fractional deltas near EDGE_PX can round to zero mid-document and
         trigger a false snap-to-end. */
      const docH = document.documentElement.scrollHeight;
      const atTop    = delta < 0 && window.scrollY <= 0.5;
      const atBottom = delta > 0 && window.scrollY + window.innerHeight >= docH - 0.5;
      const vvPanUp    = vv && vv.offsetTop > 1;
      const vvPanDown  = vv && (vv.offsetTop + vv.height) < (window.innerHeight - 1);
      const needFallback = (atTop && vvPanUp) || (atBottom && vvPanDown);

      if (needFallback) {
        const entries = document.querySelectorAll('#movie-list .entry');
        if (entries.length) {
          const target = delta < 0 ? entries[0] : entries[entries.length - 1];
          target.scrollIntoView({ block: delta < 0 ? 'start' : 'end' });
        }
      }

      /* scrolling changes which entry is under the pointer without a
         pointermove event, so re-check the drop indicator (and bar
         positions, since visualViewport offsets can shift) each frame.
         applyDragTransform also runs every frame so the translated row
         keeps tracking the pointer's page-coord position as the page
         scrolls underneath. */
      applyDragTransform();
      positionEdgeBars();
      updateDropIndicator();
      dragState.autoScrollFrame = requestAnimationFrame(tick);
    };
    dragState.autoScrollFrame = requestAnimationFrame(tick);
  }
}

function stopAutoScroll() {
  if (dragState && dragState.autoScrollFrame) {
    cancelAnimationFrame(dragState.autoScrollFrame);
    dragState.autoScrollFrame = null;
  }
}

async function commitReorder(orderedMovieIds) {
  await fetch(API + '/list/' + listId + '/my-ranks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId, ordered_movie_ids: orderedMovieIds })
  });
  await loadList();
}


/* ============================================================================
   SECTION 9: COMMENT EXPAND / EDIT
   ============================================================================
   Tapping a comment box expands it. Your own → editable textarea. Others → read-only.

   findCommentText() now reads directly from the movie row's userN_comment column
   instead of searching a separate comments array.
   ============================================================================ */

let commentUnbindWidth = null;

function expandComment(movieId, commentVisitorId) {
  expandedComment = { movieId: movieId, visitorId: commentVisitorId };

  const box = document.querySelector(
    '.comment-box[data-movie-id="' + movieId + '"]'
    + '[data-visitor-id="' + commentVisitorId + '"]'
  );
  if (!box) return;

  /* add a dark backdrop behind the comment */
  const backdrop = document.createElement('div');
  backdrop.className = 'comment-backdrop';
  backdrop.addEventListener('click', () => collapseComment());
  document.body.appendChild(backdrop);

  box.classList.add('comment-expanded');

  /* Position with the same CSS vars used by modals and the movie popup —
     10% margins of the visible viewport; width tracks zoom live. */
  applyViewportLayout(box);
  if (commentUnbindWidth) commentUnbindWidth();
  commentUnbindWidth = bindViewportWidthTracking(box);

  const isOurs = (commentVisitorId === visitorId);

  if (isOurs) {
    const existingComment = findCommentText(movieId, visitorId);
    const commenterName = displayNames[visitorId] || (visitor ? visitor.name : '');

    box.innerHTML = '<strong>' + escapeHtml(commenterName) + ':</strong>'
      + '<textarea class="comment-edit">' + escapeHtml(existingComment) + '</textarea>'
      + '<button class="comment-done-btn">Done</button>';

    box.querySelector('.comment-edit').focus();

    box.querySelector('.comment-done-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const newText = box.querySelector('.comment-edit').value;
      saveComment(movieId, newText);
      collapseComment();
    });
  } else {
    box.classList.add('comment-readonly');
  }

  /* Top-right close X. Appended after the innerHTML for edit mode (so it
     isn't wiped by the rebuild above) and added unconditionally for
     readonly. Stops propagation so clicks don't bubble to the backdrop
     ourselves — backdrop closes too, so it wouldn't matter, but this is
     tidier in case a future handler cares. */
  const xBtn = document.createElement('button');
  xBtn.className = 'modal-close';
  xBtn.setAttribute('aria-label', 'Close');
  xBtn.textContent = '✕';
  xBtn.addEventListener('click', (e) => { e.stopPropagation(); collapseComment(); });
  box.appendChild(xBtn);
}

function collapseComment() {
  if (!expandedComment) return;

  const box = document.querySelector('.comment-expanded');
  if (box) {
    box.classList.remove('comment-expanded', 'comment-readonly');
    /* clear the CSS vars and inline style overrides set during expand */
    box.style.removeProperty('--modal-top');
    box.style.removeProperty('--modal-left');
    box.style.removeProperty('--modal-width');
  }

  const backdrop = document.querySelector('.comment-backdrop');
  if (backdrop) backdrop.remove();

  if (commentUnbindWidth) { commentUnbindWidth(); commentUnbindWidth = null; }

  expandedComment = null;
  loadList();                                                      // refresh to show updated text
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
  /* find this visitor's slot, then read their comment column from the movie */
  let slot = null;
  Object.entries(listData.visitors).forEach(([s, v]) => {
    if (v.id === vid) slot = s;
  });
  if (!slot) return '';

  const movie = listData.movies.find(m => m.id === movieId);
  if (!movie) return '';

  return movie['user' + slot + '_comment'] || '';
}


/* ============================================================================
   SECTION 10: USER TABS AND COUCH TOGGLE
   ============================================================================
   Tab bar: [ Couch List ]  [ Doug ]  [ Percy ]  [ You ]  ...

   Tabs after Couch are in slot order — slot 1 first, slot 10 last. Slot
   number IS join order (server.js assigns the next free slot when a
   visitor first joins a list), so this puts visitors left-to-right in the
   order they joined. Your own tab sits in line with everyone else.

   Click a tab → switch view to that visitor's ranking.
   ============================================================================ */

const NAME_MAX_LEN = 12;                          // matches the maxlength on the input

function renderUserTabs() {
  const tabBar = document.getElementById('tab-bar');
  let html = '';

  /* Couch tab — always first. Two stacked centered lines: the visitor's
     list nickname on top (or empty when not set), "Couch List" on bottom.
     Both paint with the RDY-gradient via background-clip:text on the
     wrapping span (the parent .tab-couch keeps its black background). */
  const myListName = (listData && listData.your_list_name) || '';
  html += '<div class="tab tab-couch' + (activeTab === 'couch' ? ' tab-active' : '') + '" '
    + 'data-tab="couch">'
    + '<div class="tab-couch-stack">'
    +   (myListName
        ? '<span class="tab-couch-text tab-couch-nickname">'
            + escapeHtml(myListName) + '</span>'
        : '')
    +   '<span class="tab-couch-text">Couch List</span>'
    + '</div>'
    /* My Shelf sub-tab overlay: only when the user's own user-tab is
       active. Absolutely positioned over the right half of the Couch tab
       so the left half stays tappable to switch back to Couch view. */
    + (visitor && activeTab === visitorId
      ? '<a class="tab-myshelf-overlay" href="/" '
        +   'style="background:' + escapeHtml(tintColor(visitor.color))
        +   ';color:' + escapeHtml(darkenColor(visitor.color)) + ';" '
        +   'aria-label="My Shelf">'
        +   '<span class="tab-myshelf-line">My</span>'
        +   '<span class="tab-myshelf-line">Shelf</span>'
        + '</a>'
      : '')
    + '</div>';

  if (!visitor) {
    html += '<div class="tab tab-mine tab-new">'
      + '<input id="name-input" class="tab-name-input" type="text" '
      + 'placeholder="Type your name" autocomplete="off" maxlength="' + NAME_MAX_LEN + '">'
      + '</div>';
  }

  const sortedSlots = Object.keys(listData.visitors).sort((a, b) => a - b);
  sortedSlots.forEach(slot => {
    const v = listData.visitors[slot];
    html += buildVisitorTab(v, v.id === visitorId);
  });

  if (visitor) {
    html += '<input type="color" id="color-picker" value="' + escapeHtml(visitor.color) + '" '
      + 'style="display:none">';
  }

  html += '<span id="name-warning" style="display:none"></span>';

  tabBar.innerHTML = html;
}

function buildVisitorTab(v, isMe) {
  const isActive = (activeTab === v.id);
  const isSelected = selectedVisitors[v.id] !== false;

  const classes = ['tab', 'tab-user'];
  if (isActive) classes.push('tab-active');
  if (!isSelected) classes.push('tab-dimmed');
  if (isMe) classes.push('tab-mine');

  let html = '<div class="' + classes.join(' ') + '" data-tab="' + v.id + '" '
    + 'style="background:' + escapeHtml(v.color) + '">';
  html += '<span class="tab-ready-btn ' + (isSelected ? 'ready' : 'not-ready') + '">'
    + (isSelected ? 'RDY' : 'NAW') + '</span>';
  if (isMe && isActive) {
    /* Your own tab, currently active → name row becomes an editable input.
       First tap on your own tab just activates it (via the span branch
       below); the input only renders once you're already here, so mobile
       keyboards don't pop up until a deliberate second tap. */
    html += '<input class="tab-name-input" type="text" value="'
      + escapeHtml(v.name) + '" autocomplete="off" maxlength="' + NAME_MAX_LEN + '">';
  } else {
    html += '<span class="tab-name">' + escapeHtml(displayNames[v.id] || v.name) + '</span>';
  }
  html += '</div>';
  return html;
}

function handleTabClick(tabId) {
  activeTab = (tabId === 'couch') ? 'couch' : tabId;
  renderList();
  renderUserTabs();
  /* opportunistic refresh — any tab click pulls fresh RDY state from server */
  loadList();
}

async function handleReadyToggle(tabVisitorId) {
  if (tabVisitorId === 'couch') return;
  const newReady = !(selectedVisitors[tabVisitorId] !== false);
  selectedVisitors[tabVisitorId] = newReady;

  /* surgical DOM update — preserves focus in any open name input */
  const tabEl = document.querySelector('.tab[data-tab="' + tabVisitorId + '"]');
  if (tabEl) {
    tabEl.classList.toggle('tab-dimmed', !newReady);
    const btn = tabEl.querySelector('.tab-ready-btn');
    if (btn) {
      btn.classList.toggle('ready', newReady);
      btn.classList.toggle('not-ready', !newReady);
      btn.textContent = newReady ? 'RDY' : 'NAW';
    }
  }

  if (activeTab === 'couch') renderList();

  /* persist to server, then reload so every viewer converges */
  try {
    await fetch(API + '/list/' + listId + '/ready', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: tabVisitorId, ready: newReady })
    });
  } catch (e) { /* optimistic update stays even if network fails */ }
  loadList();
}


/* ============================================================================
   SECTION 11: MOVIE INFO POPUP
   ============================================================================
   Hover (desktop) on poster or title → popup with full poster, director,
   cast, and summary from TMDB. Cached after first fetch.
   ============================================================================ */

let moviePopupUnbindWidth = null;   // cleanup fn for visualViewport listener

async function showMoviePopup(tmdbId, mediaType) {
  /* TMDB movie and TV ID spaces overlap, so cache key must include media_type */
  const cacheKey = mediaType + ':' + tmdbId;
  if (!movieDetailCache[cacheKey]) {
    const url = TMDB_BASE + '/' + mediaType + '/' + tmdbId
      + '?api_key=' + TMDB_API_KEY
      + '&append_to_response=credits';
    const resp = await fetch(url);
    movieDetailCache[cacheKey] = await resp.json();
  }

  const detail = movieDetailCache[cacheKey];

  /* TV shows use `name`/`first_air_date` and list showrunners in `created_by`
     (not in credits.crew as "Director"). Fold both shapes into one. */
  const titleText = detail.title || detail.name || '';
  const dateText  = detail.release_date || detail.first_air_date || '';

  let leadLabel, leadName;
  if (mediaType === 'tv') {
    leadLabel = (detail.created_by && detail.created_by.length > 1) ? 'Creators' : 'Creator';
    leadName  = (detail.created_by && detail.created_by.length)
      ? detail.created_by.map(p => p.name).join(', ')
      : 'Unknown';
  } else {
    const director = detail.credits.crew.find(p => p.job === 'Director');
    leadLabel = 'Director';
    leadName  = director ? director.name : 'Unknown';
  }
  const topCast = detail.credits.cast.slice(0, 5).map(p => p.name);

  const popup = document.getElementById('movie-popup');
  const posterUrl = detail.poster_path
    ? TMDB_IMG + 'w300' + detail.poster_path
    : '';

  /* Stash identity on the popup so the popup's own click handler can open
     the right TMDB page without needing to know which movie was tapped. */
  popup.dataset.tmdbId = tmdbId;
  popup.dataset.mediaType = mediaType;

  popup.innerHTML = '<div class="popup-content">'
    + '<button class="modal-close" aria-label="Close">✕</button>'
    + (posterUrl ? '<img src="' + posterUrl + '" class="popup-poster">' : '')
    + '<div class="popup-info">'
    + '<h3>' + escapeHtml(titleText) + ' (' + formatYear(dateText) + ')</h3>'
    + '<p><strong>' + leadLabel + ':</strong> ' + escapeHtml(leadName) + '</p>'
    + '<p><strong>Cast:</strong> ' + escapeHtml(topCast.join(', ')) + '</p>'
    + '<p>' + escapeHtml(detail.overview || 'No summary available.') + '</p>'
    + '</div></div>';

  popup.style.display = 'block';
  const content = popup.querySelector('.popup-content');
  applyViewportLayout(content);
  if (moviePopupUnbindWidth) moviePopupUnbindWidth();
  moviePopupUnbindWidth = bindViewportWidthTracking(content);

  /* The popup-content click opens TMDB; the X cancels that and just closes. */
  content.querySelector('.modal-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hideMoviePopup();
  });
}

function hideMoviePopup() {
  const popup = document.getElementById('movie-popup');
  popup.style.display = 'none';
  popup.innerHTML = '';
  delete popup.dataset.tmdbId;
  delete popup.dataset.mediaType;
  if (moviePopupUnbindWidth) { moviePopupUnbindWidth(); moviePopupUnbindWidth = null; }
}


/* ============================================================================
   SECTION 12: DETAILS MODAL — export/import as one editable blob
   ============================================================================
   One big textarea showing the list as a markdown snapshot. User can Copy the
   blob to the clipboard, or edit it and click Apply to merge changes back.

   BLOB FORMAT (kept loose so hand-edits survive):
     # CouchList Snapshot
     URL:       https://.../<list_id>
     List ID:   <list_id>
     Created:   YYYY-MM-DD
     Snapshot:  YYYY-MM-DD
     Your ID:   <visitor_id>   (<your name>)

     ## People
     - Name    (you)
     - Name

     ## Movies
     ### 1. Title (Year)
     - tmdb:     <tmdb_id>
     - added_by: <name>                 (ignored on apply — always current user)
     - ranks:    Name #N, Name #N       (repeats for readability; ignored on parse)
     - Name: comment text               (only current user's comments are applied)

   APPLY RULES (additive):
     - New movies always get added as the current user.
     - Comments attributed to anyone other than the current user are dropped.
     - Movie order in the textarea becomes the current user's personal ranking.
     - If list_id differs: stash the blob, navigate to the new URL; the next
       page load picks it up via sessionStorage.pendingPaste.
     - If visitor_id differs: ensure that visitor exists, try to recycle the
       current (untouched) visitor, swap the cookie, reload; pendingPaste
       carries the blob through.
   ============================================================================ */

/* ============================================================================
   Popup sizing — visualViewport-aware (shared by all 4 popups)
   ============================================================================
   Three consumers: .modal-content (INFO + How-to), .popup-content (poster
   info), and .comment-expanded (comment popup). All use the same three
   CSS vars — --modal-top, --modal-left, --modal-width — set on the
   element passed in.

   applyViewportLayout() sets all three at open time.
   applyViewportWidth()  sets only width + left; called on visualViewport
     resize/scroll events so pinch-zoom live-rescales the popup.
   We DON'T update `top` live because tall popups either (a) extend past
     the bottom of the visible area with the surrounding overlay scrolling
     to reveal them, or (b) have internal overflow — in either case,
     moving `top` on every viewport scroll would fight that scroll.
   ============================================================================ */

function applyViewportLayout(el) {
  if (!el) return;
  const vv = window.visualViewport;
  const w    = vv ? vv.width      : window.innerWidth;
  const h    = vv ? vv.height     : window.innerHeight;
  const offL = vv ? vv.offsetLeft : 0;
  const offT = vv ? vv.offsetTop  : 0;
  el.style.setProperty('--modal-left',  (offL + w * 0.10) + 'px');
  el.style.setProperty('--modal-top',   (offT + h * 0.10) + 'px');
  el.style.setProperty('--modal-width', (w * 0.80) + 'px');
}

function applyViewportWidth(el) {
  if (!el) return;
  const vv = window.visualViewport;
  const w    = vv ? vv.width      : window.innerWidth;
  const offL = vv ? vv.offsetLeft : 0;
  el.style.setProperty('--modal-left',  (offL + w * 0.10) + 'px');
  el.style.setProperty('--modal-width', (w * 0.80) + 'px');
}

function bindViewportWidthTracking(el) {
  const onResize = () => applyViewportWidth(el);
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
  }
  window.addEventListener('resize', onResize);
  return () => {
    if (vv) {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    }
    window.removeEventListener('resize', onResize);
  };
}

function openCopyPasteModal() {
  const modal = document.getElementById('copy-paste-modal');
  const visitorById = {};
  Object.values(listData.visitors).forEach(v => { visitorById[v.id] = v; });

  const blob = buildBlob(visitorById);

  modal.innerHTML = '<div class="modal-content details-modal">'
    + '<button class="modal-close">✕</button>'
    + '<div class="modal-welcome">'
    +   '<p><strong>Welcome to CouchList!</strong> '
    +     'Written by Doug and Claude Code · last edit 2026-04-19</p>'
    +   '<p>This is an experimental, casual site with no secure identities '
    +     'at all. You are just a series of letters and numbers to this site '
    +     'and here they are in plain text:</p>'
    + '</div>'
    + '<textarea id="details-blob" spellcheck="false">'
    +   escapeHtml(blob)
    + '</textarea>'
    + '<div class="modal-buttons">'
    +   '<button id="copy-blob-btn">Copy</button>'
    +   '<button id="apply-blob-btn">Apply</button>'
    + '</div>'
    + '<p class="modal-footnote">'
    +   'Edit the snapshot above and click Apply — changes merge additively '
    +   'and get attributed to you.'
    + '</p>'
    + '</div>';

  modal.style.display = 'block';
  const modalContent = modal.querySelector('.modal-content');
  applyViewportLayout(modalContent);
  const unbindWidth = bindViewportWidthTracking(modalContent);
  const close = () => { unbindWidth(); closeCopyPasteModal(); };

  modal.querySelector('.modal-close').addEventListener('click', close);

  /* tap-outside-to-close: a click whose target IS the backdrop itself
     (not a descendant) means the user tapped outside the white panel. */
  modal.onclick = (e) => { if (e.target === modal) close(); };

  modal.querySelector('#copy-blob-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('details-blob').value);
  });

  modal.querySelector('#apply-blob-btn').addEventListener('click', () => {
    applyPasteText(document.getElementById('details-blob').value);
  });
}

function closeCopyPasteModal() {
  document.getElementById('copy-paste-modal').style.display = 'none';
}


/* ============================================================================
   buildBlob(visitorById) — serialize the list as the markdown snapshot
   ============================================================================
   Only the current user's visitor ID is emitted. All other references are
   by name only (the parser never needs anyone else's ID: movies are always
   reattributed to the current user, and only the current user's comments
   survive filtering).
   ============================================================================ */

function buildBlob(visitorById) {
  const myName = (visitor && visitor.name) || 'You';

  /* sort movies by the current user's personal rank if we have a slot */
  const movies = listData.movies.slice();
  let rankCol = null;
  Object.values(listData.visitors).forEach(v => {
    if (v.id === visitorId) rankCol = 'user' + v.slot + '_rank';
  });
  if (rankCol) {
    movies.sort((a, b) => {
      const ra = a[rankCol], rb = b[rankCol];
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return ra - rb;
    });
  }

  const slotOrder = Object.keys(listData.visitors)
    .map(s => parseInt(s))
    .sort((a, b) => a - b);

  const today = new Date().toISOString().split('T')[0];
  const lines = [];
  lines.push('# CouchList Snapshot');
  lines.push('');
  lines.push('URL:       ' + window.location.origin + '/' + listId);
  lines.push('List ID:   ' + listId);
  lines.push('Created:   ' + (listData.list.created || '?'));
  lines.push('Snapshot:  ' + today);
  lines.push('Your ID:   ' + visitorId + '   (' + myName + ')');
  lines.push('');
  lines.push('## People');
  lines.push('');
  slotOrder.forEach(s => {
    const v = listData.visitors[s];
    const tag = (v.id === visitorId) ? '   (you)' : '';
    lines.push('- ' + (v.name || '?') + tag);
  });
  lines.push('');
  lines.push('## Movies');
  lines.push('');

  movies.forEach((m, i) => {
    lines.push('### ' + (i + 1) + '. ' + m.title + ' (' + m.year + ')');
    lines.push('- tmdb:     ' + m.tmdb_id);
    /* only emit `media:` for TV rows — keeps movie snapshots byte-identical to the old format */
    if (m.media_type && m.media_type !== 'movie') {
      lines.push('- media:    ' + m.media_type);
    }
    const adder = visitorById[m.added_by];
    lines.push('- added_by: ' + (adder ? (adder.name || '?') : '?'));

    const rankParts = [];
    slotOrder.forEach(s => {
      const v = listData.visitors[s];
      const r = m['user' + s + '_rank'];
      if (r != null) rankParts.push((v.name || '?') + ' #' + r);
    });
    if (rankParts.length) lines.push('- ranks:    ' + rankParts.join(', '));

    slotOrder.forEach(s => {
      const v = listData.visitors[s];
      const c = m['user' + s + '_comment'];
      if (c) lines.push('- ' + (v.name || '?') + ': ' + c);
    });

    lines.push('');
  });

  return lines.join('\n');
}


/* ============================================================================
   parseBlob(text) — read the markdown snapshot back into a structured object
   ============================================================================
   Returns { list_id, visitor_id, your_name, movies: [...] } or null on failure.
   Each movie has { title, year, tmdb_id, comments: { name: text } }.
   added_by and ranks lines are intentionally dropped — they're informational.
   ============================================================================ */

function parseBlob(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/);

  const result = {
    list_id: null,
    visitor_id: null,
    your_name: null,
    movies: []
  };

  let inMovies = false;
  let current = null;

  const reservedKeys = new Set(['tmdb', 'media', 'added_by', 'ranks']);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^##\s+Movies\b/i.test(line)) { inMovies = true; continue; }
    if (/^##\s+/.test(line))          { inMovies = false; continue; }

    if (!inMovies) {
      /* top-of-file key/value pairs */
      const kv = line.match(/^([A-Za-z][A-Za-z ]*?):\s*(.+)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase().replace(/\s+/g, '_');
      const val = kv[2].trim();
      if (key === 'list_id') {
        result.list_id = val;
      } else if (key === 'url') {
        const m = val.match(/\/([A-Za-z0-9]+)\/?\s*$/);
        if (m && !result.list_id) result.list_id = m[1];
      } else if (key === 'your_id') {
        const m = val.match(/^(\S+)\s*(?:\((.+?)\))?/);
        if (m) {
          result.visitor_id = m[1];
          if (m[2]) result.your_name = m[2].trim();
        }
      }
      continue;
    }

    /* in movies section */
    const heading = line.match(/^###\s+\d+\.\s+(.+?)(?:\s*\((\d{4})\))?\s*$/);
    if (heading) {
      if (current) result.movies.push(current);
      current = {
        title: heading[1].trim(),
        year: heading[2] ? parseInt(heading[2]) : null,
        tmdb_id: null,
        media_type: 'movie',   /* default — snapshots from before TV support won't have this line */
        comments: {}
      };
      continue;
    }

    if (!current) continue;

    const bullet = line.match(/^-\s+(.+?):\s*(.*)$/);
    if (!bullet) continue;
    const key = bullet[1].trim();
    const val = bullet[2].trim();
    const lkey = key.toLowerCase();

    if (lkey === 'tmdb') {
      current.tmdb_id = parseInt(val) || null;
    } else if (lkey === 'media') {
      current.media_type = (val === 'tv') ? 'tv' : 'movie';
    } else if (reservedKeys.has(lkey)) {
      /* added_by / ranks — informational, ignored on apply */
    } else if (val) {
      current.comments[key] = val;
    }
  }

  if (current) result.movies.push(current);
  return result;
}


/* ============================================================================
   applyPasteText(text) — the apply pipeline
   ============================================================================
   Handles URL handoff, visitor handoff, additive movie merge, comment filter,
   and the final bulk rank reset. Safe to call either from the Apply button
   or from the pendingPaste hook in initApp.
   ============================================================================ */

async function applyPasteText(text) {
  const parsed = parseBlob(text);
  if (!parsed) {
    alert('Could not parse paste — check the format.');
    return;
  }

  /* URL handoff: different list → stash and navigate. */
  if (parsed.list_id && parsed.list_id !== listId) {
    sessionStorage.setItem('pendingPaste', text);
    window.location.href = '/' + parsed.list_id;
    return;
  }

  /* Visitor handoff: different ID → ensure it exists, recycle ours if
     untouched, swap the cookie, reload. pendingPaste carries the blob. */
  if (parsed.visitor_id && parsed.visitor_id !== visitorId) {
    const lookup = await fetch(API + '/visitor/' + parsed.visitor_id);
    if (!lookup.ok) {
      await fetch(API + '/visitor/' + parsed.visitor_id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: null, color: randomColor() })
      });
    }
    await fetch(API + '/visitor/' + visitorId, { method: 'DELETE' });  // 403 if we've done anything — fine
    sessionStorage.setItem('pendingPaste', text);
    setCookie('wtw_visitor', parsed.visitor_id);
    window.location.reload();
    return;
  }

  /* --- additive apply starts here --- */
  const myName = parsed.your_name;
  const skipped = [];
  const orderedMovieIds = [];
  let addedOrFound = 0;
  let commentsSet = 0;
  let commentsDropped = 0;

  for (const m of parsed.movies) {
    let tmdb = null;
    const mt = m.media_type === 'tv' ? 'tv' : 'movie';   /* from the snapshot; default 'movie' */

    if (m.tmdb_id) {
      const r = await fetch(
        TMDB_BASE + '/' + mt + '/' + m.tmdb_id + '?api_key=' + TMDB_API_KEY
      );
      if (r.ok) {
        const d = await r.json();
        const title = d.title || d.name;
        const date  = d.release_date || d.first_air_date;
        tmdb = { id: d.id, media_type: mt, title: title,
                 year: formatYear(date), poster: d.poster_path };
      }
    } else if (m.title) {
      /* search /multi so legacy snapshots without media: lines still resolve TV titles */
      const url = TMDB_BASE + '/search/multi'
        + '?api_key=' + TMDB_API_KEY
        + '&query=' + encodeURIComponent(m.title);
      const r = await fetch(url);
      const d = await r.json();
      const q = m.title.toLowerCase();
      let candidates = (d.results || [])
        .filter(c => c.media_type === 'movie' || c.media_type === 'tv')
        .map(normalizeTmdbResult)
        .filter(c => c.title && c.title.toLowerCase().includes(q));
      if (m.year) {
        const narrowed = candidates.filter(
          c => c.release_date && c.release_date.startsWith(String(m.year))
        );
        if (narrowed.length) candidates = narrowed;
      }
      candidates.sort((a, b) =>
        (b.popularity || 0) - (a.popularity || 0)
        || (b.vote_count || 0) - (a.vote_count || 0)
      );
      if (candidates.length) {
        const c = candidates[0];
        tmdb = { id: c.id, media_type: c.media_type, title: c.title,
                 year: formatYear(c.release_date), poster: c.poster_path };
      }
    }

    if (!tmdb) {
      skipped.push(m.title + (m.year ? ' (' + m.year + ')' : ''));
      continue;
    }

    /* POST — server dedupes by (list_id, tmdb_id, media_type). */
    const addResp = await fetch(API + '/list/' + listId + '/movies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tmdb_id:    tmdb.id,
        media_type: tmdb.media_type || 'movie',
        title:      tmdb.title,
        year:       tmdb.year,
        poster:     tmdb.poster,
        visitor_id: visitorId
      })
    });
    const row = await addResp.json();
    if (row && row.id) {
      orderedMovieIds.push(row.id);
      addedOrFound++;

      /* apply only the current user's comment */
      if (myName && m.comments[myName]) {
        await fetch(API + '/list/' + listId + '/comments', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            movie_id: row.id, visitor_id: visitorId, text: m.comments[myName]
          })
        });
        commentsSet++;
      }
      for (const n of Object.keys(m.comments)) {
        if (n !== myName) commentsDropped++;
      }
    }
  }

  /* Reset the current user's personal ranks to match textarea order. */
  if (orderedMovieIds.length) {
    await fetch(API + '/list/' + listId + '/my-ranks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: visitorId,
        ordered_movie_ids: orderedMovieIds
      })
    });
  }

  sessionStorage.removeItem('pendingPaste');
  closeCopyPasteModal();
  await loadList();

  const notes = [
    'Apply complete.',
    '',
    'Movies: ' + addedOrFound + ' added or matched',
    'Comments: ' + commentsSet + ' set, ' + commentsDropped + ' dropped (not yours)',
    'Skipped: ' + skipped.length
  ];
  if (skipped.length) {
    notes.push('');
    notes.push('No TMDB match for:');
    skipped.forEach(s => notes.push('  - ' + s));
  }
  alert(notes.join('\n'));
}


/* ============================================================================
   SECTION 13: REMOVE MOVIE
   ============================================================================ */

async function removeMovie(movieId) {
  await fetch(API + '/list/' + listId + '/movies/' + movieId, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId })
  });

  await loadList();
}


/* ============================================================================
   SECTION 14: UTILITY FUNCTIONS
   ============================================================================ */

function generateId(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

function getCookie(name) {
  const match = document.cookie.match(
    new RegExp('(?:^|;\\s*)' + name + '=([^;]*)')
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value) {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  document.cookie = name + '=' + encodeURIComponent(value)
    + '; expires=' + expires.toUTCString()
    + '; path=/'
    + '; SameSite=Lax';
}

function debounce(func, delayMs) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => func.apply(this, args), delayMs);
  };
}

function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  const sat = 60 + Math.floor(Math.random() * 30);
  const lit = 30 + Math.floor(Math.random() * 25);
  return 'hsl(' + hue + ', ' + sat + '%, ' + lit + '%)';
}

function formatYear(releaseDate) {
  if (!releaseDate) return '?';
  return releaseDate.split('-')[0];
}

/* SECURITY: escape user-supplied text for safe insertion into HTML.
   The previous textContent→innerHTML trick escaped <, >, and & — but NOT
   " or ', which meant any caller using escapeHtml inside a double-quoted
   attribute (e.g. `style="color: ${escapeHtml(color)}"` in renderEntry)
   could still be broken out of by a malicious value. This version handles
   all five HTML-significant characters explicitly. The `&` substitution
   MUST run first so we don't double-escape later substitutions. */
/* Derived-color helpers used by the My Shelf overlay on the Couchlist page.
   Visitor colors come in as either `#rrggbb` (from the native picker) or
   `hsl(h,s%,l%)` (from randomColor()). We darken for text, lighten for bg. */
function darkenColor(c) {
  if (!c) return '#1a1a1a';
  let m = c.match(/^hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*\d+%\s*\)$/);
  if (m) return 'hsl(' + m[1] + ', ' + m[2] + '%, 22%)';
  m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) {
    const r = Math.round(parseInt(m[1], 16) * 0.35);
    const g = Math.round(parseInt(m[2], 16) * 0.35);
    const b = Math.round(parseInt(m[3], 16) * 0.35);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  return '#1a1a1a';
}
function tintColor(c) {
  if (!c) return '#f0f0f0';
  let m = c.match(/^hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*\d+%\s*\)$/);
  if (m) return 'hsl(' + m[1] + ', ' + m[2] + '%, 90%)';
  m = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m) {
    const r = parseInt(m[1], 16),
          g = parseInt(m[2], 16),
          b = parseInt(m[3], 16);
    const mix = (v) => Math.round(v * 0.2 + 255 * 0.8);
    return 'rgb(' + mix(r) + ',' + mix(g) + ',' + mix(b) + ')';
  }
  return '#f0f0f0';
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/* ============================================================================
   SECTION 15: EVENT LISTENER SETUP — setupEventListeners()
   ============================================================================
   Called once from initApp(). Uses event delegation — one listener on a
   parent container handles clicks on any child, including ones added later.

   Also attaches the drag-start pointerdown handler to the grab handle.
   The pointermove/up listeners are attached to the handle itself in
   onGrabPointerDown so they naturally scope to that drag session.
   ============================================================================ */

function setupEventListeners() {

  /* --- SEARCH BOX --- */
  document.getElementById('search-box').addEventListener('input', e => {
    debouncedSearch(e.target.value);
  });

  /* --- MY COLOR DOT (search row) --- opens native color picker for this visitor */
  document.getElementById('my-color-dot').addEventListener('click', () => {
    if (!visitor) return;
    const picker = document.getElementById('color-picker');
    if (picker) picker.click();
  });

  /* --- SEARCH RESULTS: click to add.
         TMDB movie and TV ID spaces overlap, so match on (id, media_type). --- */
  document.getElementById('search-results').addEventListener('click', e => {
    const resultEl = e.target.closest('.search-result');
    if (!resultEl) return;
    const tmdbId = parseInt(resultEl.dataset.tmdbId);
    const mediaType = resultEl.dataset.mediaType || 'movie';
    const movie = searchResults.find(m => m.id === tmdbId && m.media_type === mediaType);
    if (movie) addMovie(movie);
  });

  /* --- TAB BAR: single click handler dispatches based on what was clicked --- */
  const tabBar = document.getElementById('tab-bar');

  tabBar.addEventListener('click', e => {
    /* name input — let native focus behavior happen, don't switch tabs */
    if (e.target.closest('.tab-name-input')) return;

    /* RDY/NAW button → toggle ready state */
    const readyBtn = e.target.closest('.tab-ready-btn');
    if (readyBtn) {
      const tab = readyBtn.closest('.tab');
      if (tab) handleReadyToggle(tab.dataset.tab);
      return;
    }

    /* tab body → switch active view */
    const tab = e.target.closest('.tab');
    if (tab) handleTabClick(tab.dataset.tab);
  });

  /* color picker change */
  document.addEventListener('change', e => {
    if (e.target.id === 'color-picker') {
      handleColorChange(e.target.value);
    }
  });

  /* name input — Enter blurs, blur commits */
  tabBar.addEventListener('keydown', e => {
    if (e.target.classList.contains('tab-name-input') && e.key === 'Enter') {
      e.target.blur();
    }
  });

  tabBar.addEventListener('focusout', e => {
    if (!e.target.classList.contains('tab-name-input')) return;
    const newName = e.target.value.trim();
    if (!newName) return;
    if (visitor && newName === visitor.name) return;
    handleNameEntry(newName);
  });

  /* focus into your own name input → make your tab the active view
     (surgical class toggle so the input doesn't lose focus mid-click) */
  tabBar.addEventListener('focusin', e => {
    if (!e.target.classList.contains('tab-name-input')) return;
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const tabId = tab.dataset.tab;
    if (!tabId || tabId === 'couch' || tabId === activeTab) return;
    activeTab = tabId;
    document.querySelectorAll('#tab-bar .tab').forEach(t => {
      t.classList.toggle('tab-active', t.dataset.tab === tabId);
    });
    renderList();
  });

  /* --- MOVIE LIST: drag start + click interactions --- */
  const movieList = document.getElementById('movie-list');

  /* Drag-to-reorder: pointerdown on a grab handle kicks off Section 8.
     pointermove/up bind inside onGrabPointerDown so they live only for the
     duration of the drag and can't leak across drags. */
  movieList.addEventListener('pointerdown', e => {
    if (e.target.closest('.grab-handle')) onGrabPointerDown(e);
  });

  movieList.addEventListener('click', e => {
    /* POSTER or TITLE TEXT — show popup (tap-to-preview).
       We target .entry-title-text (not the whole .entry-title) so clicks on
       the row's whitespace next to the title don't fire the popup. Dataset
       for tmdb_id/media_type lives on the parent .entry-title. */
    const hit = e.target.closest('.entry-poster, .entry-title-text');
    if (hit) {
      const src = hit.classList.contains('entry-poster') ? hit : hit.closest('.entry-title');
      showMoviePopup(parseInt(src.dataset.tmdbId), src.dataset.mediaType || 'movie');
      return;
    }

    /* REMOVE BUTTON */
    const removeBtn = e.target.closest('.remove-btn');
    if (removeBtn) {
      removeMovie(parseInt(removeBtn.dataset.movieId));
      return;
    }

    /* COMMENT BOX — expand it */
    const commentBox = e.target.closest('.comment-box');
    if (commentBox && !expandedComment) {
      e.stopPropagation();
      expandComment(
        parseInt(commentBox.dataset.movieId),
        commentBox.dataset.visitorId
      );
    }
  });

  /* Movie popup click handling:
     - click on the inner .popup-content card  → open TMDB in new tab, close
     - click on the backdrop (anywhere else)    → just close */
  const moviePopup = document.getElementById('movie-popup');
  moviePopup.addEventListener('click', (e) => {
    if (e.target.closest('.popup-content')) {
      const tmdbId = moviePopup.dataset.tmdbId;
      const mt = moviePopup.dataset.mediaType || 'movie';
      if (tmdbId) {
        window.open('https://www.themoviedb.org/' + mt + '/' + tmdbId, '_blank');
      }
    }
    hideMoviePopup();
  });

  /* click outside search area → hide search results */
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-area')) {
      searchResults = [];
      renderSearchResults();
    }
  });

  /* click back into search box → re-show results if there's text */
  document.getElementById('search-box').addEventListener('focus', e => {
    if (e.target.value.length >= 2) {
      debouncedSearch(e.target.value);
    }
  });

  /* click outside expanded comment → collapse it */
  document.addEventListener('click', e => {
    if (expandedComment && !e.target.closest('.comment-expanded')) {
      collapseComment();
    }
  });

  /* INFO + Help buttons in the search row — open their modals. */
  document.querySelectorAll('#search-row .action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'info')  openCopyPasteModal();
      if (btn.dataset.action === 'howto') openHowToModal();
    });
  });
}


/* ============================================================================
   SECTION 15b: HOW-TO MODAL — feature cheat-sheet
   ============================================================================ */

function openHowToModal() {
  const modal = document.getElementById('how-to-modal');
  const myColor = visitor ? visitor.color : '#bbb';
  const isReady = !visitor || (selectedVisitors[visitorId] !== false);
  const rdyClass = isReady ? 'ready' : 'not-ready';
  const rdyText  = isReady ? 'RDY' : 'NAW';
  /* Show the viewer's actual display name in the comment demo, with a
     lowercase fallback for pre-join sessions. */
  const myName = (displayNames[visitorId] || (visitor && visitor.name) || 'your_name').toLowerCase();

  modal.innerHTML = '<div class="modal-content howto-modal">'
    + '<button class="modal-close">✕</button>'
    + '<h2>How CouchList works</h2>'

    + '<p><span class="tab tab-mine tab-new howto-demo-tab">'
    + '<input class="tab-name-input" type="text" placeholder="Type your name" '
    + 'readonly tabindex="-1"></span> '
    + 'on your tab to join the list.</p>'

    + '<p><strong>Change your color</strong> by tapping the circle '
    + '<span class="tab-color-dot howto-demo-dot" data-howto-action="color" '
    + 'style="background:' + escapeHtml(myColor) + '"></span> '
    + 'next to the search bar.</p>'

    + '<p><strong>Search for movies</strong> you want to add to the watch list in the search bar.</p>'

    + '<p><strong>Rank movies</strong> in your tab. Drag them by the '
    + 'handle. Drop them in their new spot.</p>'

    + '<p><strong>Comment</strong> once on each movie. Tap on '
    + '<span class="comment-box howto-demo-box" style="color:#1976d2">'
    + '<strong>' + escapeHtml(myName) + ':</strong></span> '
    + '.</p>'

    + '<p>The <span class="tab tab-couch howto-demo-tab"><span class="tab-couch-text">Couch List</span></span> '
    + 'is the consensus (Borda method) of the '
    + '<span class="tab-ready-btn ready howto-demo-rdy">RDY</span> people.</p>'

    + '<p><strong>Toggle</strong> '
    + '<span class="tab-ready-btn ' + rdyClass + ' howto-demo-rdy howto-demo-rdy-active" '
    + 'data-howto-action="rdy">' + rdyText + '</span> '
    + 'on any tab to include or exclude that person. Shared state with all users.</p>'

    + '<p><strong>Tap movies</strong> for plot and cast pop up. Tap that '
    + 'to go to TMDB.</p>'

    + '<p><strong>Remove movies</strong> you have added with the ✕ on the right.</p>'

    + '<p><strong>The INFO button</strong> shows all the data, for nerds.</p>'

    + '<p><strong>No security.</strong> Your ID is just a random text string. '
    + 'Anyone who sees it can be you on the site. Don\'t put anything '
    + 'sensitive here.</p>'

    + '<p>Going to '
    + '<a href="https://couchlist.org/" target="_blank" rel="noopener">couchlist.org</a> '
    + 'generates a new list and URL. Invite potential couch mates to this list by '
    + 'sending them: <strong>' + escapeHtml(window.location.host + '/' + listId) + '</strong></p>'
    + '</div>';

  modal.style.display = 'block';
  const modalContent = modal.querySelector('.modal-content');
  applyViewportLayout(modalContent);
  const unbindWidth = bindViewportWidthTracking(modalContent);
  const closeIt = () => { unbindWidth(); modal.style.display = 'none'; };
  modal.querySelector('.modal-close').addEventListener('click', closeIt);
  /* tap-outside-to-close on the backdrop (target === modal means the click
     landed on the overlay itself, not on the white panel inside). */
  modal.onclick = (e) => { if (e.target === modal) closeIt(); };

  /* Live color-dot in the demo: opens the real native color picker, which
     only exists in the DOM when the user has a name. */
  const colorDot = modal.querySelector('[data-howto-action="color"]');
  if (colorDot && visitor) {
    colorDot.style.cursor = 'pointer';
    colorDot.addEventListener('click', () => {
      const picker = document.getElementById('color-picker');
      if (picker) picker.click();
    });
  }

  /* Live RDY toggle: flips the user's own ready state and reflects it in
     the demo button. handleReadyToggle updates selectedVisitors synchronously
     before its await, so we can read the new state immediately. */
  const rdyBtn = modal.querySelector('[data-howto-action="rdy"]');
  if (rdyBtn && visitor) {
    rdyBtn.addEventListener('click', () => {
      handleReadyToggle(visitorId);
      const nowReady = selectedVisitors[visitorId] !== false;
      rdyBtn.classList.toggle('ready', nowReady);
      rdyBtn.classList.toggle('not-ready', !nowReady);
      rdyBtn.textContent = nowReady ? 'RDY' : 'NAW';
    });
  }
}


/* ============================================================================
   SECTION 16: MY SHELF MODE  (added 2026-04-26 — step 4 of My Shelf rollout)
   ============================================================================
   The bare `/` URL routes here instead of generating a new list. Loads the
   visitor's profile + shelf (master_rank list across all their lists) and
   renders the "your" tab: every movie they've added across any list, in
   master_rank order, with drag-to-reorder.

   Step 4 is intentionally minimal. Deferred to later steps:
     - Search-and-add (auto-creates a "solo list" entry)         step 8
     - X-to-remove (multi-list confirm)                          step 5+
     - ALL/NONE checkbox column (used by Manage modal)           step 6
     - Per-list tabs alongside the user tab                      step 5
     - RDY/NAW per list                                          step 5
     - Manage modal (replaces the old Info/copy-paste flow)      step 6
     - List nicknames + sub-tab on the Couchlist page            step 7
     - First-time landing card (no name, no lists yet)           step 8

   The drag scaffolding is shared with list mode; SECTION 8 reads `appMode`
   to decide whether to commit by movie ID (list) or shelf key (this mode).
   ============================================================================ */

function initShelf () {
  loadVisitorProfile().then(() => {
    return loadShelf();
  }).then(() => {
    setupShelfEventListeners();
    document.title = 'My Shelf';
  });
}

async function loadShelf () {
  if (!visitor) {
    /* cookie exists but the server has no visitor row yet (no name set).
       Render the basic "type your name" prompt — full landing card is step 8. */
    shelfData = null;
    renderShelfBare();
    return;
  }
  const resp = await fetch(API + '/visitor/' + visitorId + '/shelf');
  if (!resp.ok) {
    shelfData = null;
    renderShelfBare();
    return;
  }
  shelfData = await resp.json();
  renderShelf();
}

/* Bare shell when we don't have a named visitor yet. Shows just the
   "type your name" tab and a help button. Once a name is entered we'll
   PUT /visitor/:id and re-render. */
function renderShelfBare () {
  const tabBar = document.getElementById('tab-bar');
  tabBar.innerHTML =
    '<div class="tab tab-mine tab-new tab-active">'
    + '<input id="name-input" class="tab-name-input" type="text" '
    +   'placeholder="Type your name" autocomplete="off" maxlength="' + NAME_MAX_LEN + '">'
    + '</div>'
    + '<div class="tab tab-new tab-shelf-newlist">'
    + '<input id="newlist-input" class="tab-name-input" type="text" '
    +   'placeholder="Name a new list" autocomplete="off" maxlength="12">'
    + '</div>';

  const searchBox = document.getElementById('search-box');
  const colorDot  = document.getElementById('my-color-dot');
  const welcome   = document.getElementById('welcome-msg');
  if (searchBox) searchBox.style.display = 'none';
  if (colorDot)  colorDot.style.display = 'none';
  if (welcome)   { welcome.style.display = 'block';
                   welcome.textContent = 'Welcome — name yourself, or start a list.'; }

  const infoBtn = document.querySelector('.action-btn[data-action="info"]');
  if (infoBtn) infoBtn.style.display = 'none';                   /* INFO is being replaced by Manage */
  /* Manage stays available so a first-time visitor can paste a visitor ID
     to "become this user". ALL/NONE has nothing to select against here. */
  document.querySelectorAll('.action-btn.shelf-only').forEach(b => {
    if (b.dataset.action === 'select-all') b.style.display = 'none';
    else b.style.display = '';
  });

  document.getElementById('movie-list').innerHTML = '';
}

function renderShelf () {
  /* Search box visible on the user-tab (auto-adds to solo). Hidden on
     list-tabs for now — step 8 sticks to user-tab search. The Help button
     stays. INFO is gone; ALL/NONE and Manage are shelf-only. */
  const searchBox = document.getElementById('search-box');
  const welcome   = document.getElementById('welcome-msg');
  const colorDot  = document.getElementById('my-color-dot');
  const infoBtn = document.querySelector('.action-btn[data-action="info"]');
  if (infoBtn) infoBtn.style.display = 'none';
  document.querySelectorAll('.action-btn.shelf-only').forEach(b => {
    b.style.display = '';
  });

  /* default to the user-tab view if activeTab isn't already a known list */
  const knownTab =
    activeTab === 'me' ||
    (shelfData.lists && shelfData.lists.some(l => l.id === activeTab));
  if (!knownTab) activeTab = 'me';

  if (searchBox) {
    if (activeTab === 'me') {
      searchBox.style.display = '';
      searchBox.placeholder = 'Add a movie to your shelf...';
    } else {
      searchBox.style.display = 'none';
    }
  }
  if (welcome)  welcome.style.display = 'none';
  if (colorDot) colorDot.style.display = 'none';

  renderShelfTabs();
  renderShelfMovieList();
}

/* Identifier used both as data-shelf-key on the entry div AND as the
   Set entry in shelfSelected. User-tab keys are `tmdb_id:media_type`;
   list-tab keys are `m:<movie_id>` so they never collide. */
function shelfEntryKey (movie, listEntry) {
  return listEntry
    ? 'm:' + listEntry.movie_id
    : movie.tmdb_id + ':' + movie.media_type;
}

function shelfVisibleKeys () {
  if (activeTab === 'me') {
    return shelfData.movies
      .filter(m => m.added_by_me)
      .map(m => shelfEntryKey(m, null));
  }
  /* list-tab */
  const out = [];
  shelfData.movies.forEach(m => {
    const e = m.list_entries.find(le => le.list_id === activeTab);
    if (e) out.push(shelfEntryKey(m, e));
  });
  return out;
}

function refreshShelfSelectAllLabel () {
  const btn = document.querySelector('.action-btn[data-action="select-all"]');
  if (!btn) return;
  const visible = shelfVisibleKeys();
  /* null = "uninitialized → defaults to all checked" */
  const allSelected = shelfSelected === null
    ? visible.length > 0
    : (visible.length > 0 && visible.every(k => shelfSelected.has(k)));
  btn.textContent = allSelected ? 'NONE' : 'ALL';
}

function selectAllVisible () {
  shelfVisibleKeys().forEach(k => shelfSelected.add(k));
}

function renderShelfTabs () {
  const v = shelfData.visitor;
  const tabBar = document.getElementById('tab-bar');
  const userColor = v.color ? ('background:' + escapeHtml(v.color) + ';') : '';

  let html = '<div class="tab tab-user tab-mine'
    + (activeTab === 'me' ? ' tab-active' : '')
    + '" data-shelf-tab="me" style="' + userColor + '">'
    + '<span class="tab-name">' + escapeHtml(v.name || '') + '</span>'
    + '</div>';

  /* one list-tab per joined list. When active, the nickname becomes editable
     (tap-again-to-edit, like the username) and a "couchlist" sidebutton is
     attached on the right. The visitor's solo list is hidden from the strip
     — it surfaces in the user-tab's added-movies and as a Manage destination,
     but doesn't get its own tab (per spec). */
  shelfData.lists.filter(l => !l.private).forEach(l => {
    const label = l.list_name && l.list_name.trim() ? l.list_name : l.id;
    const isActive = activeTab === l.id;
    const ready = l.ready;
    html += '<div class="tab tab-shelf-list'
      + (isActive ? ' tab-active' : '')
      + (ready ? '' : ' tab-dimmed')
      + '" data-shelf-tab="' + escapeHtml(l.id) + '">'
      + '<span class="tab-ready-btn ' + (ready ? 'ready' : 'not-ready') + '" '
      +   'data-shelf-rdy-list="' + escapeHtml(l.id) + '">'
      +   (ready ? 'RDY' : 'NAW')
      + '</span>';

    if (isActive) {
      /* active list-tab: nickname is an inline-editable input. Pre-filled
         with the current nickname; placeholder shows the list ID otherwise. */
      html += '<input class="tab-name-input shelf-list-name-input" type="text" '
        +   'value="' + escapeHtml(l.list_name || '') + '" '
        +   'placeholder="' + escapeHtml(l.id) + '" '
        +   'autocomplete="off" maxlength="12" '
        +   'data-list-id="' + escapeHtml(l.id) + '">';
    } else {
      html += '<span class="tab-name">' + escapeHtml(label) + '</span>';
    }
    html += '</div>';

    /* attached "couchlist" button — appears immediately after the active
       list-tab. Tapping it navigates to the actual Couchlist URL. */
    if (isActive) {
      html += '<a class="tab-shelf-listlink" href="/' + encodeURIComponent(l.id) + '">couchlist</a>';
    }
  });

  tabBar.innerHTML = html;
}

async function commitShelfListName (listId, newName) {
  await fetch(API + '/list/' + listId + '/list-name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId, list_name: newName })
  });
  await loadShelf();
}

function renderShelfMovieList () {
  const ml = document.getElementById('movie-list');

  /* default selection on first render of a tab: everything checked.
     null sentinel → fill with all visible. Empty-but-non-null Set means
     the user deliberately unchecked everything; respect that. */
  const visible = shelfVisibleKeys();
  if (shelfSelected === null) {
    shelfSelected = new Set(visible);
  } else {
    /* drop selections that no longer apply (data refresh removed an entry) */
    const visibleSet = new Set(visible);
    Array.from(shelfSelected).forEach(k => {
      if (!visibleSet.has(k)) shelfSelected.delete(k);
    });
  }

  if (activeTab === 'me') {
    const myMovies = shelfData.movies.filter(m => m.added_by_me);
    if (myMovies.length === 0) {
      ml.innerHTML = '<div class="shelf-empty">'
        + 'No movies added yet. Visit a list and add something — it will show up here.'
        + '</div>';
      refreshShelfSelectAllLabel();
      return;
    }
    ml.innerHTML = '';
    myMovies.forEach((m, i) => {
      ml.appendChild(renderShelfEntry(m, i + 1, null, null));
    });
    refreshShelfSelectAllLabel();
    return;
  }

  /* list-tab */
  const listId = activeTab;
  const onList = shelfData.movies
    .map(m => {
      const e = m.list_entries.find(le => le.list_id === listId);
      return e ? { movie: m, entry: e } : null;
    })
    .filter(Boolean);

  if (onList.length === 0) {
    ml.innerHTML = '<div class="shelf-empty">No movies on this list yet.</div>';
    refreshShelfSelectAllLabel();
    return;
  }

  ml.innerHTML = '';
  onList.forEach((row, i) => {
    ml.appendChild(renderShelfEntry(row.movie, i + 1, listId, row.entry));
  });
  refreshShelfSelectAllLabel();
}

/* `listEntry` is the per-list `{list_id, movie_id, added_here}` row when
   rendering inside a list-tab; null when rendering inside the "your" tab. */
function renderShelfEntry (movie, position, listId, listEntry) {
  const entry = document.createElement('div');
  entry.className = 'entry shelf-entry';
  entry.dataset.tmdbId    = movie.tmdb_id;
  entry.dataset.mediaType = movie.media_type;
  if (listEntry) entry.dataset.movieId = listEntry.movie_id;       // list-tab drag commits by movie_id

  const key = shelfEntryKey(movie, listEntry);
  entry.dataset.shelfKey = key;
  const checked = shelfSelected.has(key);

  const posterUrl = movie.poster ? TMDB_IMG + 'w92' + movie.poster : '';
  const yearText  = (movie.year != null) ? movie.year : '';

  /* X-to-remove. On list-tabs only entries the visitor added show one
     (existing behavior). On the user-tab the X opens a multi-list confirm
     popup that lists every list this movie is on (RDY ones default-checked). */
  let removeHtml = '';
  if (listEntry) {
    if (listEntry.added_here) {
      removeHtml = '<button class="remove-btn" data-movie-id="' + listEntry.movie_id
        + '" data-list-id="' + escapeHtml(listId) + '">✕</button>';
    }
  } else {
    /* user-tab: multi-list X popup. Always shown for movies the user added. */
    removeHtml = '<button class="remove-btn shelf-multi-x" '
      + 'data-tmdb-id="' + movie.tmdb_id
      + '" data-media-type="' + escapeHtml(movie.media_type) + '">✕</button>';
  }

  entry.innerHTML =
    '<div class="entry-rank">'
      + '<span class="rank-number">' + position + '</span>'
    + '</div>'
    + '<div class="entry-grab">'
      + '<div class="grab-handle" aria-label="Drag to reorder">'
        + '<span class="grab-icon">&#9776;</span>'
      + '</div>'
    + '</div>'
    + '<div class="entry-poster" data-tmdb-id="' + movie.tmdb_id
      + '" data-media-type="' + escapeHtml(movie.media_type) + '">'
      + (posterUrl ? '<img src="' + posterUrl + '">' : '<div class="no-poster">?</div>')
    + '</div>'
    + '<div class="entry-title" data-tmdb-id="' + movie.tmdb_id
      + '" data-media-type="' + escapeHtml(movie.media_type) + '">'
      + '<div class="entry-title-text">'
        + escapeHtml(movie.title) + (yearText !== '' ? ' (' + yearText + ')' : '')
      + '</div>'
    + '</div>'
    + '<div class="entry-comments shelf-checkbox-cell">'
      + '<input type="checkbox" class="shelf-cb" data-shelf-key="' + escapeHtml(key) + '"'
      + (checked ? ' checked' : '') + '>'
    + '</div>'
    + '<div class="entry-remove">' + removeHtml + '</div>';
  return entry;
}

async function commitShelfReorder (orderedKeys) {
  await fetch(API + '/visitor/' + visitorId + '/shelf-ranks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ordered_keys: orderedKeys })
  });
  await loadShelf();
}

async function addMovieToShelf (tmdbMovie) {
  if (!visitor) {
    alert('Type your name first.');
    return;
  }
  const year = formatYear(tmdbMovie.release_date);
  await fetch(API + '/visitor/' + visitorId + '/solo-add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tmdb_id: tmdbMovie.id,
      media_type: tmdbMovie.media_type || 'movie',
      title: tmdbMovie.title,
      year: year,
      poster: tmdbMovie.poster_path
    })
  });
  document.getElementById('search-box').value = '';
  searchResults = [];
  renderSearchResults();
  hideMoviePopup();
  await loadShelf();
}

async function commitShelfListReorder (listId, orderedMovieIds) {
  await fetch(API + '/list/' + listId + '/my-ranks', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId, ordered_movie_ids: orderedMovieIds })
  });
  await loadShelf();
}

async function shelfRemoveFromList (listId, movieId) {
  await fetch(API + '/list/' + listId + '/movies/' + movieId, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId })
  });
  await loadShelf();
}

async function shelfToggleReady (listId) {
  const lst = shelfData.lists.find(l => l.id === listId);
  if (!lst) return;
  const newReady = !lst.ready;
  /* optimistic */
  lst.ready = newReady;
  renderShelfTabs();
  try {
    await fetch(API + '/list/' + listId + '/ready', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitorId, ready: newReady })
    });
  } catch (e) { /* keep optimistic state — server retry happens on next loadShelf */ }
  await loadShelf();
}

function setupShelfEventListeners () {
  /* Drag — same handler as list mode, branches on appMode internally. */
  document.addEventListener('pointerdown', onGrabPointerDown);

  /* Search — wire the existing TMDB search infrastructure once. The
     searchTMDB → renderSearchResults pipeline is shared with list mode.
     Click-to-add branches based on activeTab: user-tab → solo-add, list-tab
     reserved for a future step (currently nobody hits this in shelf mode). */
  const searchBoxEl = document.getElementById('search-box');
  if (searchBoxEl) {
    searchBoxEl.addEventListener('input', e => debouncedSearch(e.target.value));
  }
  const searchResultsEl = document.getElementById('search-results');
  if (searchResultsEl) {
    searchResultsEl.addEventListener('click', e => {
      const resultEl = e.target.closest('.search-result');
      if (!resultEl) return;
      const tmdbId = parseInt(resultEl.dataset.tmdbId);
      const mediaType = resultEl.dataset.mediaType || 'movie';
      const movie = searchResults.find(m => m.id === tmdbId && m.media_type === mediaType);
      if (movie) addMovieToShelf(movie);
    });
  }

  /* Help button — reuses the existing modal (which is still list-mode-flavored;
     a shelf-specific version arrives in step 7). */
  document.addEventListener('click', e => {
    if (e.target.closest('.action-btn[data-action="howto"]')) {
      openHowToModal();
      return;
    }

    /* RDY/NAW on a list tab — must run BEFORE the tab-switch handler since
       the button lives inside the tab. */
    const rdy = e.target.closest('.tab-ready-btn[data-shelf-rdy-list]');
    if (rdy) {
      e.stopPropagation();
      shelfToggleReady(rdy.dataset.shelfRdyList);
      return;
    }

    /* X-to-remove on a list-tab entry. The button only renders when the
       visitor was the adder on this list, so the server-side check is
       a redundant safety net. */
    const remove = e.target.closest('.remove-btn[data-list-id]');
    if (remove) {
      e.stopPropagation();
      shelfRemoveFromList(remove.dataset.listId, parseInt(remove.dataset.movieId));
      return;
    }

    /* Tab switch — clicking anywhere on a shelf tab (except buttons handled
       above) makes it active. Reset checkbox selection so the new tab opens
       with everything checked by default. */
    const tab = e.target.closest('.tab[data-shelf-tab]');
    if (tab) {
      const newTab = tab.dataset.shelfTab;
      if (newTab !== activeTab) {
        activeTab = newTab;
        shelfSelected = null;             /* reset to "default to all checked" on the new tab */
        renderShelfTabs();
        renderShelfMovieList();
      }
      return;
    }

    /* ALL/NONE — toggle all visible checkboxes. */
    if (e.target.closest('.action-btn[data-action="select-all"]')) {
      const visible = shelfVisibleKeys();
      if (shelfSelected === null) shelfSelected = new Set(visible);
      const allSelected = visible.length > 0 && visible.every(k => shelfSelected.has(k));
      if (allSelected) shelfSelected.clear();
      else             visible.forEach(k => shelfSelected.add(k));
      renderShelfMovieList();
      return;
    }

    /* Manage button — open modal. */
    if (e.target.closest('.action-btn[data-action="manage"]')) {
      openShelfManageModal();
      return;
    }

    /* User-tab X (multi-list confirm). The data-tmdb-id signature is the
       discriminator that splits this from the per-list X above. */
    const multiX = e.target.closest('.remove-btn.shelf-multi-x');
    if (multiX) {
      e.stopPropagation();
      openShelfMultiRemove(parseInt(multiX.dataset.tmdbId), multiX.dataset.mediaType);
      return;
    }

    /* Movie popup show — clicking poster or title. */
    const popupTarget = e.target.closest('.entry-poster, .entry-title');
    if (popupTarget) {
      const tmdbId    = parseInt(popupTarget.dataset.tmdbId);
      const mediaType = popupTarget.dataset.mediaType || 'movie';
      if (tmdbId) showMoviePopup(tmdbId, mediaType);
      return;
    }

    /* Movie popup hide — click outside. */
    if (e.target.closest('.popup-content')) return;
    const popup = document.getElementById('movie-popup');
    if (popup && popup.style.display === 'block') hideMoviePopup();
  });

  /* Checkbox toggle on shelf entries. */
  document.addEventListener('change', e => {
    const cb = e.target.closest('.shelf-cb');
    if (!cb) return;
    const k = cb.dataset.shelfKey;
    if (cb.checked) shelfSelected.add(k);
    else            shelfSelected.delete(k);
    refreshShelfSelectAllLabel();
  });

  /* Name entry on the bare shell + list nickname commit on Enter/blur. */
  document.addEventListener('keydown', async (e) => {
    if (e.target && e.target.id === 'name-input' && e.key === 'Enter') {
      const text = e.target.value.trim();
      if (!text) return;
      const color = randomColor();
      const resp = await fetch(API + '/visitor/' + visitorId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: text, color })
      });
      visitor = await resp.json();
      await loadShelf();
    }
    if (e.target && e.target.classList
        && e.target.classList.contains('shelf-list-name-input')
        && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();                                              /* triggers focusout commit */
    }
    /* First-time landing: typing a list name + Enter creates a new list,
       joins, sets nickname. Visitor must have a name set first (otherwise
       the prompt is to name themselves). */
    if (e.target && e.target.id === 'newlist-input' && e.key === 'Enter') {
      const text = (e.target.value || '').trim();
      if (!text) return;
      if (!visitor) {
        alert('Type your name first (left tab).');
        return;
      }
      const newListId = generateId(LIST_ID_LEN);
      await fetch(API + '/list/' + newListId + '/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId })
      });
      await fetch(API + '/list/' + newListId + '/list-name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId, list_name: text })
      });
      activeTab = newListId;
      shelfSelected = null;
      await loadShelf();
    }
  });

  /* commit the list-nickname input when the user moves focus away */
  document.addEventListener('focusout', async (e) => {
    if (e.target && e.target.classList
        && e.target.classList.contains('shelf-list-name-input')) {
      const listId = e.target.dataset.listId;
      const newName = (e.target.value || '').trim();
      const lst = shelfData && shelfData.lists.find(l => l.id === listId);
      const oldName = lst ? (lst.list_name || '') : '';
      if (newName === oldName) return;                              /* no-op */
      await commitShelfListName(listId, newName);
    }
  });
}


/* ============================================================================
   SECTION 16b: SHELF MANAGE MODAL  (step 6)
   ============================================================================
   Replaces the old Info/copy-paste flow on shelf-mode pages. Shows:
     - editable text blob describing the current selection (RDY state is
       captured at modal-open and frozen for the modal's lifetime, per spec)
     - a list of joined lists with checkboxes — these are the destinations
       for Copy / Remove
     - Copy/Remove buttons — operate on (selected entries) × (checked dests)
     - Add/Create list input — joins or creates a list by 8-char ID
     - Apply box — paste a snapshot to "become this user" or import movies
   ============================================================================ */

function openShelfManageModal () {
  shelfManageOpen = true;
  /* RDY snapshot — modal acts on whatever was RDY at the moment it opened. */
  shelfReadySnap = {};
  shelfData.lists.forEach(l => { shelfReadySnap[l.id] = l.ready; });

  const modal = document.getElementById('copy-paste-modal');
  modal.innerHTML = renderManageModalHtml();
  modal.style.display = 'block';

  const content = modal.querySelector('.modal-content');
  applyViewportLayout(content);
  if (window._manageUnbindWidth) window._manageUnbindWidth();
  window._manageUnbindWidth = bindViewportWidthTracking(content);

  /* close handlers */
  modal.querySelector('.modal-close').addEventListener('click', closeShelfManageModal);
  modal.onclick = (e) => { if (e.target === modal) closeShelfManageModal(); };

  modal.querySelector('#manage-dest-toggle')
    .addEventListener('click', toggleAllDestChecks);

  modal.querySelectorAll('.manage-dest-cb').forEach(cb => {
    cb.addEventListener('change', refreshDestToggleLabel);
  });

  modal.querySelector('#manage-copy-btn').addEventListener('click', shelfManageCopy);
  modal.querySelector('#manage-remove-btn').addEventListener('click', shelfManageRemove);

  const addBtn = modal.querySelector('#manage-add-list-btn');
  if (addBtn) addBtn.addEventListener('click', shelfManageAddList);

  const applyBtn = modal.querySelector('#manage-apply-btn');
  if (applyBtn) applyBtn.addEventListener('click', shelfManageApplyPaste);

  refreshDestToggleLabel();
}

function closeShelfManageModal () {
  shelfManageOpen = false;
  shelfReadySnap = null;
  const modal = document.getElementById('copy-paste-modal');
  if (window._manageUnbindWidth) { window._manageUnbindWidth(); window._manageUnbindWidth = null; }
  modal.style.display = 'none';
  modal.innerHTML = '';
}

function renderManageModalHtml () {
  const v = shelfData.visitor;
  const blob = buildShelfBlob();

  /* Dest-list options: every list this visitor is on, including their
     solo list (rendered with a distinguishing label). Default UNCHECKED. */
  const destsHtml = shelfData.lists.map(l => {
    let label;
    if (l.private) label = 'Solo (only you)';
    else label = l.list_name && l.list_name.trim() ? l.list_name : l.id;
    const idHint = l.private ? '' : ' <span class="manage-dest-id">(' + escapeHtml(l.id) + ')</span>';
    return '<label class="manage-dest-row' + (l.private ? ' manage-dest-solo' : '') + '">'
      + '<input type="checkbox" class="manage-dest-cb" '
        + 'data-list-id="' + escapeHtml(l.id) + '">'
      + '<span class="manage-dest-label">' + escapeHtml(label) + idHint + '</span>'
      + '</label>';
  }).join('');

  return ''
    + '<div class="modal-content shelf-manage-modal">'
    +   '<button class="modal-close" aria-label="Close">✕</button>'
    +   '<h2 class="manage-title">Manage</h2>'

    +   '<div class="manage-section">'
    +     '<label class="manage-label">Snapshot (read-only — paste below to apply)</label>'
    +     '<textarea id="manage-blob" readonly>' + escapeHtml(blob) + '</textarea>'
    +   '</div>'

    +   '<div class="manage-section">'
    +     '<div class="manage-section-header">'
    +       '<span class="manage-label">Lists to act on</span>'
    +       '<button id="manage-dest-toggle" class="manage-mini-btn">ALL</button>'
    +     '</div>'
    +     '<div id="manage-dest-list">' + destsHtml + '</div>'
    +     '<div class="manage-add-row">'
    +       '<input type="text" id="manage-add-input" placeholder="8-char list ID" '
    +         'maxlength="8" autocomplete="off">'
    +       '<button id="manage-add-list-btn" class="manage-mini-btn">+ Add / Create</button>'
    +     '</div>'
    +   '</div>'

    +   '<div class="manage-section manage-actions">'
    +     '<button id="manage-copy-btn">Copy selected → checked lists</button>'
    +     '<button id="manage-remove-btn">Remove selected from checked lists</button>'
    +   '</div>'

    +   '<div class="manage-section">'
    +     '<label class="manage-label">Apply a snapshot or visitor ID</label>'
    +     '<textarea id="manage-apply-input" placeholder="Paste a snapshot or 10-char visitor ID"></textarea>'
    +     '<button id="manage-apply-btn" class="manage-mini-btn">Apply</button>'
    +     '<div class="manage-hint">Pasting a different visitor ID becomes that user (replaces the old Info paste flow).</div>'
    +   '</div>'

    + '</div>';
}

function buildShelfBlob () {
  const lines = [];
  const v = shelfData.visitor;
  lines.push('# My Shelf snapshot');
  lines.push('Your ID:    ' + v.id + (v.name ? ' (' + v.name + ')' : ''));
  lines.push('Snapshot:   ' + new Date().toISOString().split('T')[0]);
  lines.push('Active tab: ' + (activeTab === 'me' ? '(your tab)' : activeTab));
  lines.push('');

  /* Lists section — show all joined lists; mark RDY snapshot */
  lines.push('## Lists');
  shelfData.lists.forEach(l => {
    const label = l.list_name && l.list_name.trim() ? l.list_name : '(no nickname)';
    const rdy = shelfReadySnap[l.id] ? 'RDY' : 'NAW';
    lines.push('- ' + l.id + '  ' + label + '  [' + rdy + ']');
  });
  lines.push('');

  /* Selected movies — match selection at the time of open */
  lines.push('## Selected movies');
  const visible = shelfVisibleKeys();
  visible.forEach(k => {
    if (!shelfSelected.has(k)) return;
    /* find the movie + (if list-tab) the list_entry for this key */
    let movie = null, listEntry = null;
    if (k.startsWith('m:')) {
      const movieId = parseInt(k.slice(2));
      shelfData.movies.forEach(m => {
        const e = m.list_entries.find(le => le.movie_id === movieId);
        if (e) { movie = m; listEntry = e; }
      });
    } else {
      const [tid, mtype] = k.split(':');
      movie = shelfData.movies.find(m =>
        String(m.tmdb_id) === tid && m.media_type === mtype);
    }
    if (!movie) return;
    lines.push('### ' + movie.master_rank + '. ' + movie.title
      + (movie.year ? ' (' + movie.year + ')' : ''));
    lines.push('- tmdb:    ' + movie.tmdb_id);
    lines.push('- media:   ' + movie.media_type);
    if (listEntry) {
      lines.push('- on list: ' + listEntry.list_id
        + (listEntry.added_here ? ' (you added)' : ''));
    } else {
      const onLists = movie.list_entries.map(le => le.list_id).join(', ');
      if (onLists) lines.push('- on lists: ' + onLists);
    }
    lines.push('');
  });

  return lines.join('\n');
}

function toggleAllDestChecks () {
  const cbs = Array.from(document.querySelectorAll('.manage-dest-cb'));
  if (cbs.length === 0) return;
  const allChecked = cbs.every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !allChecked; });
  refreshDestToggleLabel();
}

function refreshDestToggleLabel () {
  const cbs = Array.from(document.querySelectorAll('.manage-dest-cb'));
  const btn = document.getElementById('manage-dest-toggle');
  if (!btn) return;
  const allChecked = cbs.length > 0 && cbs.every(cb => cb.checked);
  btn.textContent = allChecked ? 'NONE' : 'ALL';
}

function getSelectedDestListIds () {
  return Array.from(document.querySelectorAll('.manage-dest-cb'))
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.listId);
}

/* Build the {tmdb_id, media_type, ...} item array for currently selected
   shelf entries. Each shelfSelected key resolves to one movie object in
   shelfData.movies. Used by both Copy and Remove. */
function getSelectedShelfMovies () {
  const out = [];
  const seen = new Set();
  shelfSelected.forEach(k => {
    let movie = null;
    if (k.startsWith('m:')) {
      const movieId = parseInt(k.slice(2));
      shelfData.movies.forEach(m => {
        if (m.list_entries.some(le => le.movie_id === movieId)) movie = m;
      });
    } else {
      const [tid, mtype] = k.split(':');
      movie = shelfData.movies.find(m =>
        String(m.tmdb_id) === tid && m.media_type === mtype);
    }
    if (movie) {
      const dedupe = movie.tmdb_id + ':' + movie.media_type;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        out.push(movie);
      }
    }
  });
  return out;
}

async function shelfManageCopy () {
  const dests = getSelectedDestListIds();
  if (dests.length === 0) { alert('Pick at least one destination list.'); return; }

  const movies = getSelectedShelfMovies();
  if (movies.length === 0) { alert('No movies selected.'); return; }

  const items = movies.map(m => ({
    tmdb_id: m.tmdb_id,
    media_type: m.media_type,
    title: m.title,
    year: m.year,
    poster: m.poster
  }));
  const resp = await fetch(API + '/visitor/' + visitorId + '/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, dest_list_ids: dests })
  });
  const data = await resp.json();
  alert('Copied ' + (data.copied || 0) + ' movie/list pair(s); '
    + (data.skipped ? data.skipped.length : 0) + ' skipped (already on list).');
  closeShelfManageModal();
  await loadShelf();
}

async function shelfManageRemove () {
  const dests = getSelectedDestListIds();
  if (dests.length === 0) { alert('Pick at least one list to remove from.'); return; }

  const movies = getSelectedShelfMovies();
  if (movies.length === 0) { alert('No movies selected.'); return; }

  /* Build the (movie, list, movie_id) work items. Per spec we only remove
     movies the visitor was the adder of; show others with strikethrough. */
  const work = [];                                                  // eligible removes
  const skipped = [];                                               // others
  movies.forEach(m => {
    dests.forEach(lid => {
      const e = m.list_entries.find(le => le.list_id === lid);
      if (!e) return;                                               // not on this list
      if (e.added_here) work.push({ movie: m, list_id: lid, movie_id: e.movie_id });
      else skipped.push({ movie: m, list_id: lid });
    });
  });

  if (work.length === 0) {
    alert('Nothing to remove (you can only remove movies you added).');
    return;
  }

  const lines = [];
  lines.push('Remove these?');
  work.forEach(w => lines.push('  ✕ ' + w.movie.title + '  →  ' + w.list_id));
  if (skipped.length) {
    lines.push('');
    lines.push('Skipped (added by someone else):');
    skipped.forEach(s => lines.push('  – ' + s.movie.title + '  on  ' + s.list_id));
  }
  if (!confirm(lines.join('\n'))) return;

  for (const w of work) {
    await fetch(API + '/list/' + w.list_id + '/movies/' + w.movie_id, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitorId })
    });
  }
  closeShelfManageModal();
  await loadShelf();
}

async function shelfManageAddList () {
  const input = document.getElementById('manage-add-input');
  const id = (input.value || '').trim();
  if (!/^[A-Za-z0-9]{1,12}$/.test(id)) { alert('Enter a 1-12 char list ID.'); return; }
  /* Joining (or creating) the list — uses the existing /join endpoint. */
  await fetch(API + '/list/' + id + '/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId })
  });
  closeShelfManageModal();
  await loadShelf();
}

async function shelfManageApplyPaste () {
  const ta = document.getElementById('manage-apply-input');
  const text = (ta.value || '').trim();
  if (!text) return;

  /* a 10-char alphanumeric on its own = a visitor ID — become this user */
  if (/^[A-Za-z0-9]{10}$/.test(text)) {
    visitorId = text;
    setCookie('wtw_visitor', visitorId);
    window.location.reload();
    return;
  }

  /* otherwise treat as a snapshot blob — extract Your_ID line and become */
  const parsed = parseBlob(text);
  if (parsed && parsed.visitor_id && /^[A-Za-z0-9]{10}$/.test(parsed.visitor_id)) {
    visitorId = parsed.visitor_id;
    setCookie('wtw_visitor', visitorId);
    window.location.reload();
    return;
  }
  alert("Couldn't find a visitor ID to apply. Paste a 10-char ID or a snapshot with a 'Your ID:' line.");
}

/* ----------------------------------------------------------------------------
   User-tab X-to-remove popup. Browser-native confirm wrapped in a synthetic
   overlay so we can show the full list of lists with RDY-default checkboxes.
   ---------------------------------------------------------------------------- */
function openShelfMultiRemove (tmdb_id, media_type) {
  const movie = shelfData.movies.find(m =>
    m.tmdb_id === tmdb_id && m.media_type === media_type);
  if (!movie) return;
  /* lists where this user is the adder AND that exist on this movie's entries */
  const removable = movie.list_entries.filter(le => le.added_here);
  if (removable.length === 0) {
    alert('You did not add this movie on any list, so you can\'t remove it.');
    return;
  }

  /* Build a small inline confirm dialog. Reuse #copy-paste-modal as the
     overlay since it's already a fullscreen-style modal slot. */
  const modal = document.getElementById('copy-paste-modal');
  const rows = removable.map(le => {
    const lst = shelfData.lists.find(l => l.id === le.list_id);
    const isRdy = lst ? lst.ready : false;
    const label = (lst && lst.list_name && lst.list_name.trim())
      ? lst.list_name + ' (' + le.list_id + ')'
      : le.list_id;
    return '<label class="multi-x-row">'
      + '<input type="checkbox" class="multi-x-cb" '
        + 'data-list-id="' + escapeHtml(le.list_id) + '" '
        + 'data-movie-id="' + le.movie_id + '"'
        + (isRdy ? ' checked' : '') + '>'
      + '<span>' + escapeHtml(label) + (isRdy ? ' <em>RDY</em>' : '') + '</span>'
      + '</label>';
  }).join('');

  modal.innerHTML =
      '<div class="modal-content shelf-manage-modal">'
    +   '<button class="modal-close" aria-label="Close">✕</button>'
    +   '<h3 class="manage-title">Remove "' + escapeHtml(movie.title) + '"</h3>'
    +   '<p class="manage-hint">RDY lists are pre-selected. Confirm to remove from each checked list.</p>'
    +   '<div class="multi-x-list">' + rows + '</div>'
    +   '<div class="manage-actions">'
    +     '<button id="multi-x-confirm">Remove from checked lists</button>'
    +     '<button id="multi-x-cancel" class="manage-mini-btn">Cancel</button>'
    +   '</div>'
    + '</div>';
  modal.style.display = 'block';
  const content = modal.querySelector('.modal-content');
  applyViewportLayout(content);

  modal.querySelector('.modal-close').addEventListener('click', () => {
    modal.style.display = 'none'; modal.innerHTML = '';
  });
  modal.querySelector('#multi-x-cancel').addEventListener('click', () => {
    modal.style.display = 'none'; modal.innerHTML = '';
  });
  modal.querySelector('#multi-x-confirm').addEventListener('click', async () => {
    const picks = Array.from(modal.querySelectorAll('.multi-x-cb'))
      .filter(cb => cb.checked)
      .map(cb => ({ list_id: cb.dataset.listId, movie_id: parseInt(cb.dataset.movieId) }));
    modal.style.display = 'none'; modal.innerHTML = '';
    for (const p of picks) {
      await fetch(API + '/list/' + p.list_id + '/movies/' + p.movie_id, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId })
      });
    }
    await loadShelf();
  });
}


/* ============================================================================
   SECTION 17: STARTUP
   ============================================================================ */

initApp();
