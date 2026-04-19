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

const TMDB_API_KEY  = '50f0ec96e69aa677d94e2977722686b4';
const TMDB_BASE     = 'https://api.themoviedb.org/3';
const TMDB_IMG      = 'https://image.tmdb.org/t/p/';
const API           = '/api';
const LIST_ID_LEN   = 8;
const VISITOR_ID_LEN = 10;
const DEBOUNCE_MS   = 300;
const LONG_PRESS_MS = 500;


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

let listId            = null;
let visitorId         = null;
let visitor           = null;
let listData          = null;
let mySlot            = null;                                      // NEW: my slot (1-10) on this list
let activeTab         = 'couch';
let selectedVisitors  = {};
let searchResults     = [];
let expandedComment   = null;
let movieDetailCache  = {};
let displayNames      = {};


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

  if (!urlPath || urlPath === '') {
    listId = generateId(LIST_ID_LEN);
    window.location.href = '/' + listId;
    return;
  }

  listId = urlPath;

  visitorId = getCookie('wtw_visitor');
  if (!visitorId) {
    visitorId = generateId(VISITOR_ID_LEN);
    setCookie('wtw_visitor', visitorId);
  }

  loadVisitorProfile().then(() => {
    return loadList();
  }).then(() => {
    setupEventListeners();
    console.log('app.js BUILD flat-redesign');
    document.title = 'WTW';
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
  const resp = await fetch(API + '/list/' + listId);

  if (!resp.ok) {
    /* list doesn't exist yet — start with empty data */
    listData = {
      list: { id: listId },
      visitors: {},
      movies: []
    };
  } else {
    listData = await resp.json();
  }

  /* figure out our slot number on this list */
  mySlot = null;
  Object.entries(listData.visitors).forEach(([slot, v]) => {
    if (v.id === visitorId) mySlot = parseInt(slot);
  });

  /* build selectedVisitors — preserve existing toggles, default new visitors ON */
  const newSelected = {};
  Object.values(listData.visitors).forEach(v => {
    if (selectedVisitors.hasOwnProperty(v.id)) {
      newSelected[v.id] = selectedVisitors[v.id];                  // keep existing toggle
    } else {
      newSelected[v.id] = true;                                    // new visitor, default ON
    }
  });
  selectedVisitors = newSelected;

  buildDisplayNames();
  updateSearchArea();
  renderUserTabs();
  renderList();
}

/* show the search box only if the visitor has a name, otherwise show a welcome message */
function updateSearchArea() {
  const searchBox = document.getElementById('search-box');
  const welcome = document.getElementById('welcome-msg');
  if (visitor) {
    searchBox.style.display = '';
    welcome.style.display = 'none';
  } else {
    searchBox.style.display = 'none';
    welcome.style.display = 'block';
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
   Search box → TMDB API → dropdown results → click to add movie.
   Unchanged from v1 except the server now auto-assigns ranks on add.
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

async function searchTMDB(query) {
  const url = TMDB_BASE + '/search/movie'
    + '?api_key=' + TMDB_API_KEY
    + '&query=' + encodeURIComponent(query);

  const resp = await fetch(url);
  const data = await resp.json();
  searchResults = data.results.slice(0, 8);
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
    return '<div class="search-result" data-tmdb-id="' + movie.id + '">'
      + (posterThumb ? '<img src="' + posterThumb + '" class="search-thumb">' : '')
      + '<span>' + escapeHtml(movie.title) + ' (' + year + ')</span>'
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
   Ties get a "tied 2-3" label. Ties are broken randomly.

   --- renderEntry(movie, position, tieLabel, isMyTab) ---
   Builds one row. If isMyTab is true, shows up/down arrows instead of
   a static rank number.
   ============================================================================ */

function renderList() {
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
    const entry = renderEntry(movie, position, tieLabel, visitorById, isMyTab);
    container.appendChild(entry);
  });
}

function renderEntry(movie, position, tieLabel, visitorById, isMyTab) {
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.dataset.movieId = movie.id;

  /* 1. RANK NUMBER + optional up/down arrows + optional tie indicator
     If this is our tab, show clickable arrows to move the movie up or down.
     The up arrow is the top half of the rank area, down arrow is the bottom half. */
  const tieHtml = tieLabel
    ? '<span class="tie-label">tied ' + tieLabel + '</span>' : '';

  let rankHtml;
  if (isMyTab && mySlot) {
    /* show single arrows (swap one) on left, rank number center, double arrows (jump to edge) on right */
    rankHtml = '<div class="entry-rank">'
      + '<div class="rank-arrows">'
      + '<div class="arrow-up" data-movie-id="' + movie.id + '">&#9650;</div>'
      + '<div class="arrow-down" data-movie-id="' + movie.id + '">&#9660;</div>'
      + '</div>'
      + '<span class="rank-number">' + position + '</span>'
      + '<div class="rank-arrows">'
      + '<div class="arrow-top" data-movie-id="' + movie.id + '"><span>&#9650;</span><span>&#9650;</span></div>'
      + '<div class="arrow-bottom" data-movie-id="' + movie.id + '"><span>&#9660;</span><span>&#9660;</span></div>'
      + '</div>'
      + tieHtml
      + '</div>';
  } else {
    /* read-only rank number */
    rankHtml = '<div class="entry-rank">'
      + '<span class="rank-number">' + position + '</span>'
      + tieHtml
      + '</div>';
  }

  /* 2. POSTER THUMBNAIL */
  const posterUrl = movie.poster
    ? TMDB_IMG + 'w92' + movie.poster
    : '';
  const posterHtml = '<div class="entry-poster" data-tmdb-id="' + movie.tmdb_id + '">'
    + (posterUrl ? '<img src="' + posterUrl + '">' : '<div class="no-poster">?</div>')
    + '</div>';

  /* 3. TITLE */
  const titleHtml = '<div class="entry-title" data-tmdb-id="' + movie.tmdb_id + '">'
    + escapeHtml(movie.title) + ' (' + movie.year + ')'
    + '</div>';

  /* 4. COMMENTS — read directly from the movie row's userN_comment columns.
     We iterate through all occupied slots and show any non-null comments.
     The movie adder's comment goes first. */
  let commentsHtml = '<div class="entry-comments">';

  /* gather all comments: [ { visitorId, slot, text }, ... ] */
  const commentEntries = [];
  Object.entries(listData.visitors).forEach(([slot, v]) => {
    const text = movie['user' + slot + '_comment'];
    if (text) {
      commentEntries.push({ visitorId: v.id, slot: parseInt(slot), text: text });
    }
  });

  /* sort: movie adder's comment first */
  commentEntries.sort((a, b) => {
    if (a.visitorId === movie.added_by) return -1;
    if (b.visitorId === movie.added_by) return 1;
    return a.slot - b.slot;
  });

  let myCommentExists = false;

  commentEntries.forEach(c => {
    const commenter = visitorById[c.visitorId] || { name: '?', color: '#999' };
    if (c.visitorId === visitorId) myCommentExists = true;
    commentsHtml += '<div class="comment-box" '
      + 'data-movie-id="' + movie.id + '" '
      + 'data-visitor-id="' + c.visitorId + '" '
      + 'style="color: ' + escapeHtml(commenter.color) + '">'
      + '<strong>' + escapeHtml(displayNames[c.visitorId] || commenter.name) + ':</strong> '
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
   SECTION 8: SWAP RANK (replaces drag-to-reorder)
   ============================================================================
   Called when user clicks an up or down arrow on their own tab.
   Tells the server to swap this movie's rank with the one above/below.
   Then reloads the list to show the new order.

   This is the ENTIRE reordering system. No pointer events, no drag state,
   no transform calculations, no pointer capture. One click, one swap.
   ============================================================================ */

async function swapRank(movieId, direction) {
  if (!mySlot) return;                                             // can't swap if we're not on the list

  await fetch(API + '/list/' + listId + '/swap', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: mySlot, movieId: movieId, direction: direction })
  });

  await loadList();
}


async function moveToEdge(movieId, direction) {
  if (!mySlot) return;

  await fetch(API + '/list/' + listId + '/move', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slot: mySlot, movieId: movieId, direction: direction })
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

function expandComment(movieId, commentVisitorId) {
  expandedComment = { movieId: movieId, visitorId: commentVisitorId };

  const box = document.querySelector(
    '.comment-box[data-movie-id="' + movieId + '"]'
    + '[data-visitor-id="' + commentVisitorId + '"]'
  );
  if (!box) return;

  /* scroll so this entry is ~1/6 from the top of the screen */
  const entry = box.closest('.entry');
  const targetY = window.innerHeight / 6;
  const entryTop = entry.getBoundingClientRect().top;
  window.scrollBy(0, entryTop - targetY);

  /* add a dark backdrop behind the comment */
  const backdrop = document.createElement('div');
  backdrop.className = 'comment-backdrop';
  backdrop.addEventListener('click', () => collapseComment());
  document.body.appendChild(backdrop);

  box.classList.add('comment-expanded');

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
}

function collapseComment() {
  if (!expandedComment) return;

  const box = document.querySelector('.comment-expanded');
  if (box) {
    box.classList.remove('comment-expanded', 'comment-readonly');
  }

  const backdrop = document.querySelector('.comment-backdrop');
  if (backdrop) backdrop.remove();

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
   Tab bar: [ Couch ]  [ Doug ■ ]  [ Percy ■ ]  ...  [ name-input ■ ]

   Click a tab → switch view to that visitor's ranking.
   Long-press → toggle them in/out of the Couch vote (dimmed = excluded).
   ============================================================================ */

function renderUserTabs() {
  const tabBar = document.getElementById('tab-bar');

  /* Couch tab — always first */
  let html = '<div class="tab' + (activeTab === 'couch' ? ' tab-active' : '') + '" '
    + 'data-tab="couch">Couch List</div>';

  /* one tab per visitor on this list, in slot order */
  const sortedSlots = Object.keys(listData.visitors).sort((a, b) => a - b);
  sortedSlots.forEach(slot => {
    const v = listData.visitors[slot];
    const isActive = (activeTab === v.id);
    const isSelected = selectedVisitors[v.id] !== false;
    html += '<div class="tab' + (isActive ? ' tab-active' : '')
      + (isSelected ? '' : ' tab-dimmed') + '" '
      + 'data-tab="' + v.id + '">'
      + escapeHtml(displayNames[v.id] || v.name)
      + ' <span class="color-swatch" style="background:' + escapeHtml(v.color) + '"></span>'
      + '</div>';
  });

  /* show our own tab if we have a name but aren't on the list yet */
  if (visitor && !Object.values(listData.visitors).find(v => v.id === visitorId)) {
    const isActive = (activeTab === visitorId);
    const isSelected = selectedVisitors[visitorId] !== false;
    html += '<div class="tab' + (isActive ? ' tab-active' : '')
      + (isSelected ? '' : ' tab-dimmed') + '" '
      + 'data-tab="' + visitorId + '">'
      + escapeHtml(displayNames[visitorId] || visitor.name)
      + ' <span class="color-swatch" style="background:' + escapeHtml(visitor.color) + '"></span>'
      + '</div>';
  }

  /* name input — only show if visitor hasn't entered a name */
  if (!visitor) {
    html += '<div class="name-entry">'
      + '<input id="name-input" type="text" placeholder="enter your name">'
      + '<span id="name-warning" style="display:none"></span>'
      + '</div>';
  } else {
    html += '<input type="color" id="color-picker" value="' + visitor.color + '" '
      + 'style="display:none">';
  }

  tabBar.innerHTML = html;
}

function handleTabClick(tabId) {
  activeTab = (tabId === 'couch') ? 'couch' : tabId;
  renderList();
  renderUserTabs();
}

function handleTabLongPress(tabVisitorId) {
  if (tabVisitorId === 'couch') return;
  selectedVisitors[tabVisitorId] = !selectedVisitors[tabVisitorId];
  renderUserTabs();
  if (activeTab === 'couch') renderList();
}


/* ============================================================================
   SECTION 11: MOVIE INFO POPUP
   ============================================================================
   Hover (desktop) on poster or title → popup with full poster, director,
   cast, and summary from TMDB. Cached after first fetch.
   ============================================================================ */

async function showMoviePopup(tmdbId, anchorEl) {
  if (!movieDetailCache[tmdbId]) {
    const url = TMDB_BASE + '/movie/' + tmdbId
      + '?api_key=' + TMDB_API_KEY
      + '&append_to_response=credits';
    const resp = await fetch(url);
    movieDetailCache[tmdbId] = await resp.json();
  }

  const detail = movieDetailCache[tmdbId];
  const director = detail.credits.crew.find(p => p.job === 'Director');
  const directorName = director ? director.name : 'Unknown';
  const topCast = detail.credits.cast.slice(0, 5).map(p => p.name);

  const popup = document.getElementById('movie-popup');
  const posterUrl = detail.poster_path
    ? TMDB_IMG + 'w300' + detail.poster_path
    : '';

  popup.innerHTML = '<div class="popup-content">'
    + (posterUrl ? '<img src="' + posterUrl + '" class="popup-poster">' : '')
    + '<div class="popup-info">'
    + '<h3>' + escapeHtml(detail.title) + ' (' + formatYear(detail.release_date) + ')</h3>'
    + '<p><strong>Director:</strong> ' + escapeHtml(directorName) + '</p>'
    + '<p><strong>Cast:</strong> ' + escapeHtml(topCast.join(', ')) + '</p>'
    + '<p>' + escapeHtml(detail.overview || 'No summary available.') + '</p>'
    + '</div></div>';

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
   SECTION 12: COPY / PASTE + VISITOR ID MANAGEMENT
   ============================================================================
   Bottom-left button opens a modal with:
   1. Your Visitor ID (copyable)
   2. Restore Visitor ID (paste to recover)
   3. List ID
   4. Export (full list as text)
   5. Import (paste text to bulk-add movies)
   ============================================================================ */

function openCopyPasteModal() {
  const modal = document.getElementById('copy-paste-modal');
  const visitorById = {};
  Object.values(listData.visitors).forEach(v => { visitorById[v.id] = v; });

  modal.innerHTML = '<div class="modal-content">'
    + '<button class="modal-close">✕</button>'

    + '<div class="modal-section">'
    + '<h3>Your Visitor ID</h3>'
    + '<input type="text" id="visitor-id-display" readonly value="' + visitorId + '">'
    + '<button id="copy-visitor-id-btn">Copy</button>'
    + '<p class="modal-hint">Save this somewhere safe. If you clear your cookies, '
    + 'paste it back below to restore your identity.</p>'
    + '</div>'

    + '<div class="modal-section">'
    + '<h3>Restore Visitor ID</h3>'
    + '<input type="text" id="restore-visitor-input" placeholder="paste old visitor ID">'
    + '<button id="restore-visitor-btn">Restore</button>'
    + '</div>'

    + '<div class="modal-section">'
    + '<h3>List ID</h3>'
    + '<input type="text" readonly value="' + listId + '">'
    + '</div>'

    + '<div class="modal-section">'
    + '<h3>Export List</h3>'
    + '<textarea id="export-text" readonly>' + escapeHtml(buildExportText(visitorById)) + '</textarea>'
    + '<button id="copy-export-btn">Copy</button>'
    + '</div>'

    + '<div class="modal-section">'
    + '<h3>Import List</h3>'
    + '<textarea id="import-text" placeholder="Paste a list here..."></textarea>'
    + '<button id="import-btn">Import</button>'
    + '</div>'

    + '</div>';

  modal.style.display = 'flex';

  modal.querySelector('.modal-close').addEventListener('click', closeCopyPasteModal);

  modal.querySelector('#copy-visitor-id-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(visitorId);
  });

  modal.querySelector('#restore-visitor-btn').addEventListener('click', () => {
    const oldId = document.getElementById('restore-visitor-input').value;
    restoreVisitorId(oldId);
  });

  modal.querySelector('#copy-export-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('export-text').value);
  });

  modal.querySelector('#import-btn').addEventListener('click', () => {
    const text = document.getElementById('import-text').value;
    parseImportText(text);
  });
}

function closeCopyPasteModal() {
  document.getElementById('copy-paste-modal').style.display = 'none';
}

function buildExportText(visitorById) {
  /* sort movies by couch ranking (Borda) for export */
  const movies = listData.movies.slice();

  /* compute Borda scores for sorting */
  const activeSlots = [];
  Object.entries(listData.visitors).forEach(([slot, v]) => {
    if (selectedVisitors[v.id] !== false) activeSlots.push(parseInt(slot));
  });

  if (activeSlots.length > 0) {
    const numMovies = movies.length;
    movies.forEach(m => {
      m._score = 0;
      activeSlots.forEach(slot => {
        const rank = m['user' + slot + '_rank'];
        m._score += (rank != null) ? rank : (numMovies + 1);
      });
    });
    movies.sort((a, b) => a._score - b._score);
  }

  let lines = [];
  movies.forEach((movie, i) => {
    const adder = visitorById[movie.added_by] || { name: '?' };
    let line = (i + 1) + '. ' + movie.title + ' (' + movie.year + ')'
      + ' - Added by ' + (displayNames[movie.added_by] || adder.name);

    /* append comments from all slots */
    Object.entries(listData.visitors).forEach(([slot, v]) => {
      const text = movie['user' + slot + '_comment'];
      if (text) {
        line += ' - ' + (displayNames[v.id] || v.name) + ': ' + text;
      }
    });

    lines.push(line);
  });

  return lines.join('\n');
}

async function parseImportText(text) {
  if (!text || text.trim() === '') return;

  const lines = text.trim().split('\n');

  for (const line of lines) {
    const match = line.match(
      /^\d+\.\s+(.+?)\s+\((\d{4})\)\s*-\s*Added by\s+(.+?)(?:\s*-\s*|$)/
    );
    if (!match) continue;

    const title = match[1];
    const year = parseInt(match[2]);

    const searchUrl = TMDB_BASE + '/search/movie'
      + '?api_key=' + TMDB_API_KEY
      + '&query=' + encodeURIComponent(title)
      + '&year=' + year;
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();

    if (searchData.results.length === 0) continue;

    const tmdbMovie = searchData.results[0];

    await fetch(API + '/list/' + listId + '/movies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tmdb_id:    tmdbMovie.id,
        title:      tmdbMovie.title,
        year:       formatYear(tmdbMovie.release_date),
        poster:     tmdbMovie.poster_path,
        visitor_id: visitorId
      })
    });
  }

  closeCopyPasteModal();
  await loadList();
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

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


/* ============================================================================
   SECTION 15: EVENT LISTENER SETUP — setupEventListeners()
   ============================================================================
   Called once from initApp(). Uses event delegation — one listener on a
   parent container handles clicks on any child, including ones added later.

   NO DRAG EVENTS. The old pointerdown/pointermove/pointerup drag system is
   gone. Instead, clicks on .arrow-up and .arrow-down call swapRank().
   ============================================================================ */

function setupEventListeners() {

  /* --- SEARCH BOX --- */
  document.getElementById('search-box').addEventListener('input', e => {
    debouncedSearch(e.target.value);
  });

  /* --- SEARCH RESULTS: click to add --- */
  document.getElementById('search-results').addEventListener('click', e => {
    const resultEl = e.target.closest('.search-result');
    if (!resultEl) return;
    const tmdbId = parseInt(resultEl.dataset.tmdbId);
    const movie = searchResults.find(m => m.id === tmdbId);
    if (movie) addMovie(movie);
  });

  /* --- TAB BAR: click and long-press --- */
  let longPressTimer = null;
  let longPressFired = false;

  document.getElementById('tab-bar').addEventListener('pointerdown', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const tabId = tab.dataset.tab;
    longPressFired = false;
    longPressTimer = setTimeout(() => {
      longPressFired = true;
      handleTabLongPress(tabId);
    }, LONG_PRESS_MS);
  });

  document.getElementById('tab-bar').addEventListener('pointerup', e => {
    clearTimeout(longPressTimer);
    if (longPressFired) return;
    const tab = e.target.closest('.tab');
    if (!tab) return;
    handleTabClick(tab.dataset.tab);
  });

  document.getElementById('tab-bar').addEventListener('pointerleave', () => {
    clearTimeout(longPressTimer);
  });

  /* --- COLOR PICKER --- */
  document.getElementById('tab-bar').addEventListener('click', e => {
    if (e.target.classList.contains('color-swatch') && visitor) {
      const tab = e.target.closest('.tab');
      if (tab && tab.dataset.tab === visitorId) {
        document.getElementById('color-picker').click();
      }
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'color-picker') {
      handleColorChange(e.target.value);
    }
  });

  /* --- NAME INPUT --- */
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

  /* --- MOVIE LIST: all click interactions --- */
  const movieList = document.getElementById('movie-list');

  movieList.addEventListener('click', e => {
    hideMoviePopup();

    /* UP ARROW — move movie up one rank */
    const arrowUp = e.target.closest('.arrow-up');
    if (arrowUp) {
      swapRank(parseInt(arrowUp.dataset.movieId), 'up');
      return;
    }

    /* DOWN ARROW — move movie down one rank */
    const arrowDown = e.target.closest('.arrow-down');
    if (arrowDown) {
      swapRank(parseInt(arrowDown.dataset.movieId), 'down');
      return;
    }

    /* DOUBLE UP ARROW — move movie to #1 */
    const arrowTop = e.target.closest('.arrow-top');
    if (arrowTop) {
      moveToEdge(parseInt(arrowTop.dataset.movieId), 'top');
      return;
    }

    /* DOUBLE DOWN ARROW — move movie to last place */
    const arrowBottom = e.target.closest('.arrow-bottom');
    if (arrowBottom) {
      moveToEdge(parseInt(arrowBottom.dataset.movieId), 'bottom');
      return;
    }

    /* POSTER or TITLE — open TMDB page */
    const el = e.target.closest('.entry-poster, .entry-title');
    if (el) {
      window.open('https://www.themoviedb.org/movie/' + el.dataset.tmdbId, '_blank');
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

  /* hover on poster or title → show popup (desktop) */
  movieList.addEventListener('mouseenter', e => {
    const el = e.target.closest('.entry-poster, .entry-title');
    if (el) showMoviePopup(parseInt(el.dataset.tmdbId), el);
  }, true);

  movieList.addEventListener('mouseleave', e => {
    const el = e.target.closest('.entry-poster, .entry-title');
    if (el) hideMoviePopup();
  }, true);

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

  /* --- COPY/PASTE BUTTON --- */
  document.getElementById('copy-paste-btn').addEventListener('click', openCopyPasteModal);
}


/* ============================================================================
   SECTION 16: STARTUP
   ============================================================================ */

initApp();
