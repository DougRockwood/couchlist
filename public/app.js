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
    console.log('app.js BUILD details-paste');
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

  /* 2. POSTER THUMBNAIL — media_type rides along so popup/link can hit the right TMDB endpoint */
  const posterUrl = movie.poster
    ? TMDB_IMG + 'w92' + movie.poster
    : '';
  const mediaType = movie.media_type || 'movie';
  const posterHtml = '<div class="entry-poster" data-tmdb-id="' + movie.tmdb_id
    + '" data-media-type="' + mediaType + '">'
    + (posterUrl ? '<img src="' + posterUrl + '">' : '<div class="no-poster">?</div>')
    + '</div>';

  /* 3. TITLE */
  const titleHtml = '<div class="entry-title" data-tmdb-id="' + movie.tmdb_id
    + '" data-media-type="' + mediaType + '">'
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
    commentsHtml += '<div class="comment-box" '
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
  let html = '';

  /* Couch tab — always first */
  html += '<div class="tab tab-couch' + (activeTab === 'couch' ? ' tab-active' : '') + '" '
    + 'data-tab="couch">Couch List</div>';

  /* one tab per other visitor (not us) in slot order */
  const sortedSlots = Object.keys(listData.visitors).sort((a, b) => a - b);
  sortedSlots.forEach(slot => {
    const v = listData.visitors[slot];
    if (v.id === visitorId) return;
    html += buildVisitorTab(v, false);
  });

  /* your own tab */
  if (visitor) {
    html += buildVisitorTab(visitor, true);
    html += '<input type="color" id="color-picker" value="' + escapeHtml(visitor.color) + '" '
      + 'style="display:none">';
  } else {
    /* brand new visitor — no name yet. Tab has just the name input. */
    html += '<div class="tab tab-mine tab-new">'
      + '<input id="name-input" class="tab-name-input" type="text" '
      + 'placeholder="enter your name" autocomplete="off">'
      + '</div>';
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
  html += '<span class="tab-color-dot" style="background:' + escapeHtml(v.color) + '"></span>';
  if (isMe && isActive) {
    /* Your tab is the active view — now it's an editable input.
       The first tap on your own tab just activates it (via the span branch
       below); the input only renders once you're already here, so mobile
       keyboards don't pop up until a deliberate second tap. */
    html += '<input class="tab-name-input" type="text" value="'
      + escapeHtml(v.name) + '" autocomplete="off">';
  } else {
    html += '<span class="tab-name">' + escapeHtml(displayNames[v.id] || v.name) + '</span>';
  }
  html += '<span class="tab-ready-btn ' + (isSelected ? 'ready' : 'not-ready') + '">'
    + (isSelected ? 'RDY' : 'NAW') + '</span>';
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

async function showMoviePopup(tmdbId, mediaType, anchorEl) {
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
    + (posterUrl ? '<img src="' + posterUrl + '" class="popup-poster">' : '')
    + '<div class="popup-info">'
    + '<h3>' + escapeHtml(titleText) + ' (' + formatYear(dateText) + ')</h3>'
    + '<p><strong>' + leadLabel + ':</strong> ' + escapeHtml(leadName) + '</p>'
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
  delete popup.dataset.tmdbId;
  delete popup.dataset.mediaType;
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

  modal.style.display = 'flex';

  modal.querySelector('.modal-close').addEventListener('click', closeCopyPasteModal);

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

    /* color dot: your own → open native color picker; anyone else's →
       treat as a click on their tab */
    const colorDot = e.target.closest('.tab-color-dot');
    if (colorDot) {
      const tab = colorDot.closest('.tab');
      if (!tab) return;
      if (tab.dataset.tab === visitorId && visitor) {
        document.getElementById('color-picker').click();
      } else {
        handleTabClick(tab.dataset.tab);
      }
      return;
    }

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

  /* --- MOVIE LIST: all click interactions --- */
  const movieList = document.getElementById('movie-list');

  movieList.addEventListener('click', e => {
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

    /* POSTER or TITLE — show popup (tap-to-preview).
       Tapping the popup itself is what navigates to TMDB — handled below. */
    const el = e.target.closest('.entry-poster, .entry-title');
    if (el) {
      showMoviePopup(parseInt(el.dataset.tmdbId), el.dataset.mediaType || 'movie', el);
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

  /* Click the popup itself → open TMDB and dismiss. */
  const moviePopup = document.getElementById('movie-popup');
  moviePopup.addEventListener('click', () => {
    const tmdbId = moviePopup.dataset.tmdbId;
    const mt = moviePopup.dataset.mediaType || 'movie';
    if (tmdbId) {
      window.open('https://www.themoviedb.org/' + mt + '/' + tmdbId, '_blank');
    }
    hideMoviePopup();
  });

  /* Any click outside the popup AND outside a movie poster/title dismisses
     the popup. Clicks on a poster/title are allowed through so they can
     re-show the popup for a different movie without a flicker. */
  document.addEventListener('click', e => {
    const popup = document.getElementById('movie-popup');
    if (popup.style.display !== 'block') return;
    if (e.target.closest('#movie-popup')) return;
    if (e.target.closest('.entry-poster, .entry-title')) return;
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

  /* --- COPY/PASTE BUTTON --- */
  document.getElementById('copy-paste-btn').addEventListener('click', openCopyPasteModal);

  /* --- HOW-TO BUTTON --- */
  document.getElementById('how-to-btn').addEventListener('click', openHowToModal);
}


/* ============================================================================
   SECTION 15b: HOW-TO MODAL — feature cheat-sheet
   ============================================================================ */

function openHowToModal() {
  const modal = document.getElementById('how-to-modal');
  modal.innerHTML = '<div class="modal-content howto-modal">'
    + '<button class="modal-close">✕</button>'
    + '<h2>How CouchList works</h2>'

    + '<h3>Your tab</h3>'
    + '<p>Type your name on your tab to join the list. Click the color dot on '
    + 'your own tab to change your color.</p>'

    + '<h3>Adding movies</h3>'
    + '<p>Type in the search box at the top to find a movie on TMDB. '
    + 'Click a result to add it to the list.</p>'

    + '<h3>Ranking movies</h3>'
    + '<p>Click any visitor tab to see that person\'s personal ranking. On your '
    + 'own tab, use the up / down arrows to reorder. Double arrows jump a movie '
    + 'to the top or bottom.</p>'

    + '<h3>Comments</h3>'
    + '<p>Tap any comment box on a movie to write or edit your thoughts. Each '
    + 'person gets one comment per movie.</p>'

    + '<h3>The Couch tab</h3>'
    + '<p>Shows the group consensus ranking — a Borda count across everyone '
    + 'marked <strong>RDY</strong>. Toggle <strong>RDY / NAW</strong> on any '
    + 'tab to include or exclude that person\'s votes. RDY state is shared — '
    + 'everyone viewing the list sees the same toggles.</p>'

    + '<h3>Movie details</h3>'
    + '<p>Tap a poster or title to see the plot, director, and cast. Tap the '
    + 'popup to open the TMDB page, or tap anywhere else to dismiss it.</p>'

    + '<h3>Remove a movie</h3>'
    + '<p>Only the person who added a movie can remove it. The remove button '
    + 'only shows up on your own additions.</p>'

    + '<h3>Info / sharing</h3>'
    + '<p>The <strong>INFO</strong> button shows this list as an editable '
    + 'text snapshot. Copy it to share the list, or paste an edited version '
    + 'and click Apply to merge changes. Your visitor ID lives in that text — '
    + 'save it somewhere if you want to keep your identity across devices or '
    + 'after clearing cookies.</p>'

    + '<h3>No accounts, no security</h3>'
    + '<p>This is a casual site. Your identity is just a random string in a '
    + 'cookie. Anyone who sees your visitor ID can use it. Don\'t put anything '
    + 'here you wouldn\'t want strangers to read.</p>'
    + '</div>';

  modal.style.display = 'flex';
  modal.querySelector('.modal-close').addEventListener('click', () => {
    modal.style.display = 'none';
  });
}


/* ============================================================================
   SECTION 16: STARTUP
   ============================================================================ */

initApp();
