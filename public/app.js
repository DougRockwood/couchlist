/* ============================================================================
   app.js — couchlist.org
   ============================================================================
   The entire front-end. Runs in the browser. Talks to server.js via fetch().
   TMDB calls happen directly from the browser — our server never talks to TMDB.

   TWO MODES, ROUTED BY URL QUERY PARAMS:

     /                        → list mode, virtual blank list
     /?ListId=<8>             → list mode, that list
     /?UserId=<10>            → consume the cookie-restoring param, then load
                                that user's last-viewed list
     /?Shelf=1                → shelf mode (the Shelf button target)
     /<8>                     → legacy backcompat for old path-style URLs

   In list mode the server returns each movie with every visitor's rank and
   comment INLINE on the row, keyed by SLOT NUMBER (1-10). Slot 3 owns
   user3_rank / user3_comment columns. mySlot tells us which slot is ours.

   In shelf mode (My Shelf) we fetch a single payload from /api/visitor/:id/
   shelf that aggregates every list this visitor is on into one master_rank
   ordering. SECTION 16 owns this mode.

   VIRTUAL IDENTITY (list mode only):
   Bare `/` doesn't generate or fetch anything. We show editable placeholders
   — Couch#NNN on the Couch tab and CouchM8#NNN on the user tab — and
   only persist anything (visitor row, list row, slot, nickname) when the
   user does something concrete. ensureMaterialized() in SECTION 4 is the
   one-stop "promote this virtual session to a real one" call site.

   DRAG TO REORDER:
   Pointer drag with transforms (no clone, no arrow buttons). SECTION 8 owns
   the scaffolding; both modes use it and branch by appMode at commit time.
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
   appMode           — 'list' (Couchlist) or 'shelf' (My Shelf)
   listId            — 8-char list ID. null in shelf mode and in virtual list
                       sessions (before materialize)
   visitorId         — 10-char visitor ID. Always set (cookie or freshly
                       generated); doesn't imply a DB row exists
   visitor           — { id, name, color, last_list_id } from server, or null
                       if no DB row for this visitorId yet
   listData          — { list, visitors (keyed by slot), movies, your_list_name }
                       In virtual mode, a stub with empty visitors/movies
   shelfData         — { visitor, lists, movies } from /shelf. Shelf mode only
   mySlot            — our slot number (1-10) on this list, or null if not joined
   activeTab         — 'couch' / a visitor ID / 'me' / 'all' / a list ID —
                       which view is showing. Mode-dependent
   selectedVisitors  — { visitorId: true/false } — who's included in the Borda
                       vote on the Couch tab
   searchResults     — array of TMDB movie objects from current search
   expandedComment   — { movieId, visitorId } or null — which comment is expanded
   movieDetailCache  — { '<media>:<tmdb>': detailObject } — cached TMDB lookups
   displayNames      — { visitorId: 'Doug' or 'Doug(2)' } — per-list display
                       names with collisions disambiguated
   ============================================================================ */

let appMode           = 'list';
let listId            = null;
let visitorId         = null;
let visitor           = null;
let listData          = null;
let shelfData         = null;
let mySlot            = null;
let activeTab         = 'couch';
let selectedVisitors  = {};
let searchResults     = [];
let expandedComment   = null;
let movieDetailCache  = {};
let displayNames      = {};

/* Virtual-mode placeholders.
   Used in three scenarios:
   1. Bare `/` — no listId, no visitor: full virtual mode (isVirtualList=true).
      User sees "CouchM8#NNN" / "Couch#NNN" defaults; first concrete action
      mints a fresh listId via materializeList().
   2. URL has a listId for a list that doesn't exist (404 from the server,
      e.g. fresh shared `/<8>` URL or stale last_list_id). isVirtualList
      stays false so materializeList() won't overwrite the URL's listId —
      /join uses it directly.
   3. URL has a listId for an existing list the visitor isn't on yet
      (fresh shared-URL arrival). virtualListName is seeded from the
      server's default_list_name (first non-empty nickname in slot
      order — prefers the creator) so the Couch tab pre-fills with the
      inherited name instead of a random Couch#NNN.
   In all three, names are kept in localStorage so a refresh during the
   pre-materialize state shows the same values. */
let virtualUserName  = null;       // shown on the user tab pre-materialize
let virtualUserColor = null;       // tab background pre-materialize (random hsl)
let virtualListName  = null;       // shown on the couch tab pre-materialize
let isVirtualList    = false;      // true when listId hasn't been generated/picked

/* Shelf-only state — set in shelf mode, ignored in list mode.
   shelfSelectedByTab — per-tab checkbox selections. Missing tab → empty Set
                        (default unchecked). Page refresh clears it.
   shelfSelected()    — accessor that returns the Set for the active tab.
   shelfManageOpen    — is the Manage modal up?
   shelfReadySnap     — { listId: ready } snapshot frozen at modal-open so
                        the modal acts on whatever was RDY when it opened. */
let shelfSelectedByTab = new Map();
function shelfSelected () {
  if (!shelfSelectedByTab.has(activeTab)) shelfSelectedByTab.set(activeTab, new Set());
  return shelfSelectedByTab.get(activeTab);
}
let shelfManageOpen   = false;
let shelfReadySnap    = null;


/* ============================================================================
   SECTION 3: INITIALIZATION — initApp()
   ============================================================================
   The single entry point. Runs once at page load (called from SECTION 17).

     1. Parse URL: ?ListId / ?UserId / ?Shelf, plus legacy `/<8>` path.
     2. Resolve visitorId — UserId param wins (and is then stripped from
        the URL), otherwise the cookie, otherwise a fresh 10-char ID.
     3. If ?Shelf=1 → hand off to SECTION 16 (initShelf).
     4. Else, list mode: pick listId from the URL, or fall back to the
        visitor's last_list_id, or enter virtual mode (no listId; show
        editable Couch#NNN / CouchM8#NNN placeholders).
     5. loadList() renders, setupEventListeners() wires interactions.

   Materialization helpers below initApp turn a virtual session into a real
   one lazily — first add, first name typed, first share-link tap, etc.
   ============================================================================ */

function initApp() {
  /* URL routing. New canonical form is query-param-based:
       /?ListId=<8>             → couchlist for that list
       /?UserId=<10>            → set cookie, then load that user's last list
       /?ListId=&UserId=        → both (UserId restores identity in incognito)
       /?Shelf=1                → shelf mode (Shelf button target)
       /?New=1                  → fresh virtual list (skip last_list_id resolve);
                                  target of the shelf-mode "+" tab
       /                        → couchlist mode, virtual blank list
       /<8>                     → legacy backcompat, same as ?ListId=<8>

     UserId and New are consumed once: their effect is applied, then the
     params are stripped from the URL via history.replaceState so they don't
     get re-applied on reload (and the "secret" UserId link isn't left
     visible in the address bar). */
  const params = new URLSearchParams(window.location.search);
  const userIdParam = params.get('UserId');
  const listIdParam = params.get('ListId');
  const shelfParam  = params.get('Shelf');
  const newParam    = params.get('New');

  const urlPath = window.location.pathname.replace(/^\//, '');
  const pathListId =
    (urlPath.length === LIST_ID_LEN && /^[A-Za-z0-9]+$/.test(urlPath))
      ? urlPath
      : null;

  /* Visitor identity */
  if (userIdParam && /^[A-Za-z0-9]{10}$/.test(userIdParam)) {
    visitorId = userIdParam;
    setCookie('wtw_visitor', visitorId);
  } else {
    visitorId = getCookie('wtw_visitor');
    if (!visitorId) {
      visitorId = generateId(VISITOR_ID_LEN);
      setCookie('wtw_visitor', visitorId);
    }
  }

  /* Strip UserId / New from the URL after consuming. Keep ListId/Shelf if
     present. New is a one-shot trigger — once we've decided to skip the
     last_list_id resolve below, we don't want a reload to repeat it. */
  if (userIdParam || newParam) {
    const clean = new URLSearchParams(params);
    clean.delete('UserId');
    clean.delete('New');
    const qs = clean.toString();
    history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
  }

  /* Mode */
  if (shelfParam === '1') {
    appMode = 'shelf';
    initShelf();
    return;
  }

  appMode = 'list';

  /* Pick the listId. Explicit ?ListId or path wins; otherwise we wait for
     loadVisitorProfile to finish and resolve against the visitor's
     last_list_id, or fall back to virtual mode (no list, blank state). */
  if (listIdParam && /^[A-Za-z0-9]{8}$/.test(listIdParam)) {
    listId = listIdParam;
  } else if (pathListId) {
    listId = pathListId;
  } else {
    listId = null;                                                   // resolve below
  }

  loadVisitorProfile().then(() => {
    /* If no listId yet and we found a stored last-list for this visitor,
       use it. Otherwise we go virtual. The ?New=1 path forces a fresh
       virtual list — the shelf "+" tab uses it to start a brand-new list
       without losing the visitor cookie. */
    if (!newParam && !listId && visitor && visitor.last_list_id
        && /^[A-Za-z0-9]{8}$/.test(visitor.last_list_id)) {
      listId = visitor.last_list_id;
    }
    if (!listId) {
      enterVirtualList();
    }
    return loadList();
  }).then(() => {
    setupEventListeners();
    document.title = 'CouchList';

    /* pendingPaste hook: if a previous Apply redirected us here, run the
       blob now that we're on the right list/visitor. */
    const pending = sessionStorage.getItem('pendingPaste');
    if (pending) {
      const parsed = parseBlob(pending);
      if (parsed && parsed.list_id === listId) {
        applyPasteText(pending);
      }
    }
  });
}

/* Populate the virtualUserName / virtualUserColor / virtualListName
   placeholders (Couch#NNN / CouchM8#NNN, random color), reading from
   localStorage so a refresh keeps the same values. Idempotent — safe to
   call repeatedly; only fills slots that are still null. Does NOT set
   isVirtualList — the caller decides that. */
function ensureVirtualPlaceholders () {
  if (!virtualUserName) {
    let n = readLocalStorage('wtw_virtual_user_name');
    if (!n) {
      n = 'CouchM8#' + threeDigits();
      writeLocalStorage('wtw_virtual_user_name', n);
    }
    virtualUserName = n;
  }
  if (!virtualUserColor) {
    let c = readLocalStorage('wtw_virtual_user_color');
    if (!c) {
      c = randomColor();
      writeLocalStorage('wtw_virtual_user_color', c);
    }
    virtualUserColor = c;
  }
  if (!virtualListName) {
    let l = readLocalStorage('wtw_virtual_list_name');
    if (!l) {
      l = 'Couch#' + threeDigits();
      writeLocalStorage('wtw_virtual_list_name', l);
    }
    virtualListName = l;
  }
}

/* Bare-/ entry point: generate placeholders AND flag the session as
   virtual so materializeList() will mint a fresh listId when the user
   commits something. */
function enterVirtualList () {
  isVirtualList = true;
  ensureVirtualPlaceholders();
}

function threeDigits () {
  return String(Math.floor(Math.random() * 1000)).padStart(3, '0');
}

function readLocalStorage (k) {
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function writeLocalStorage (k, v) {
  try { localStorage.setItem(k, v); } catch (e) { /* private mode */ }
}
function clearLocalStorage (k) {
  try { localStorage.removeItem(k); } catch (e) { /* private mode */ }
}

/* Generate a fresh listId and switch out of virtual mode. Updates the URL
   to ?ListId=<new> so the page is now a real, shareable list. Caller is
   responsible for then doing whatever DB write triggered materialization. */
function materializeList () {
  if (!isVirtualList) return;
  listId = generateId(LIST_ID_LEN);
  isVirtualList = false;
  /* Update URL but keep any existing search params (e.g. Shelf, though that
     would have routed elsewhere — defensive). */
  const params = new URLSearchParams(window.location.search);
  params.set('ListId', listId);
  history.replaceState({}, '', '/?' + params.toString());
}

/* Make sure the visitor row exists in the DB. If not, PUT it with the
   placeholder name. Caller can pass a `nameOverride` to force-save a typed
   name now. Idempotent — no-op when visitor is already materialized with
   the same name. */
async function materializeVisitor (nameOverride) {
  const wantName = (nameOverride && nameOverride.trim())
    || (visitor && visitor.name)
    || virtualUserName;
  if (!wantName) return;
  const wantColor = (visitor && visitor.color) || virtualUserColor || randomColor();
  const resp = await fetch(API + '/visitor/' + visitorId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: wantName, color: wantColor })
  });
  visitor = await resp.json();
  /* Once committed, drop the localStorage placeholders so future virtual
     sessions (different cookie) get fresh numbers and a fresh color. */
  clearLocalStorage('wtw_virtual_user_name');
  clearLocalStorage('wtw_virtual_user_color');
}

/* Promote a virtual session into a real one. Called before any DB write that
   needs a real list_id + visitor row + slot:
     1. Create the visitor row if missing (uses virtual or supplied name).
     2. Generate a real listId if we're still virtual; URL updates.
     3. Join the visitor to the list (creates the list row + claims slot 1).
     4. Save the virtual list nickname as their per-list nickname.
   Idempotent — safe to call when already materialized. */
async function ensureMaterialized (nameOverride) {
  await materializeVisitor(nameOverride);
  if (isVirtualList) materializeList();
  await fetch(API + '/list/' + listId + '/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId })
  });
  /* Save the virtual list nickname as our nickname for this list — only the
     first time, and only if the user hasn't already named it explicitly. */
  if (virtualListName) {
    await fetch(API + '/list/' + listId + '/list-name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitorId, list_name: virtualListName })
    });
    clearLocalStorage('wtw_virtual_list_name');
    virtualListName = null;
  }
}


/* ============================================================================
   SECTION 4: VISITOR MANAGEMENT
   ============================================================================
   loadVisitorProfile()       — fetch our visitor row (name/color/last_list_id)
                                from server on startup; sets visitor or null
   handleNameEntry(text)      — user typed a name in the user tab → call
                                ensureMaterialized to commit visitor + list
   handleListNameEntry(text)  — user typed a nickname in the Couch tab →
                                materialize, then PUT list-name
   handleColorChange(color)   — user picked a new color (shelf "Color" button)
   restoreVisitorId(oldId)    — paste an old 10-char ID to recover it (legacy
                                paste flow; the new way is the ?UserId= link
                                from the share modal)
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

  /* On a virtual list there's no list to check against yet, and no existing
     members. Skip the duplicate-name check. */
  if (!isVirtualList && listId) {
    const checkResp = await fetch(
      API + '/list/' + listId + '/check-name/' + encodeURIComponent(nameText)
      + '?visitor_id=' + visitorId
    );
    const checkData = await checkResp.json();
    if (checkData.taken) {
      showNameWarning('Name taken — you\'ll appear as "' + nameText + '(2)"');
      nameText = nameText + '(2)';
    }
  }

  /* materialize visitor + list + join + nickname in one shot */
  await ensureMaterialized(nameText);

  hideNameWarning();
  updateSearchArea();
  await loadList();
}

/* User edited the list nickname on the Couch tab. Same lazy materialize as
   typing your own name — list + visitor get persisted, then the nickname
   is saved as ours for the list. */
async function handleListNameEntry (nameText) {
  if (!nameText || nameText.trim() === '') return;
  nameText = nameText.trim().slice(0, 12);

  if (isVirtualList) {
    /* User typed an explicit list name — discard the auto-generated one
       so ensureMaterialized doesn't overwrite their choice. */
    virtualListName = null;
    clearLocalStorage('wtw_virtual_list_name');
  }
  await ensureMaterialized();
  await fetch(API + '/list/' + listId + '/list-name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId, list_name: nameText })
  });
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

   Pre-materialize paths populate Couch#NNN / CouchM8#NNN placeholders
   via ensureVirtualPlaceholders():
   - isVirtualList || !listId   → bare /, no fetch, virtual mode
   - 404 from /api/list/:id     → keep listId, synthesize empty stub
   - 200 but visitor not on list → seed virtualListName from the response's
                                  default_list_name (inherited nickname)

   Server returns:
   {
     list:              { id, created, private, owner_visitor_id, tab_color },
     visitors:          { "1": { id, name, color, slot, ready }, ... },
     movies:            [ { id, title, year, ..., user1_rank, ... } ],
     your_list_name:    <string|null>   // requester's per-list nickname
     default_list_name: <string|null>   // inherited nickname for non-members
                                          (first non-empty in slot order)
   }
   Passing ?visitor_id=... also bumps the server-side visitors.last_list_id.

   After fetching:
   - mySlot: which slot number we have (or null if not joined)
   - selectedVisitors: who's toggled on for the Couch vote (mirrors RDY)
   - displayNames: collision-handled display names
   Then re-render everything.
   ============================================================================ */

async function loadList() {
  /* Virtual mode: no listId, no fetch — render an empty list shell with
     the placeholder names. Editing anything will materialize. */
  if (isVirtualList || !listId) {
    listData = {
      list: { id: null },
      visitors: {},
      movies: [],
      your_list_name: virtualListName || null
    };
  } else {
    /* pass visitor_id so the response includes our private list nickname,
       and so the server can record this as our last-viewed list */
    const resp = await fetch(API + '/list/' + listId
      + (visitorId ? '?visitor_id=' + encodeURIComponent(visitorId) : ''));

    if (!resp.ok) {
      /* List doesn't exist yet — could be a fresh `/<8>` URL someone shared
         before joining, or a stale `last_list_id` pointing at a deleted list,
         or just a typo'd ListId. Either way, we want the same Couch#NNN /
         CouchM8#NNN placeholders the bare-/ flow shows so the page isn't
         blank. We do NOT flip isVirtualList — the URL's listId is preserved
         so the eventual /join creates the list with that ID instead of
         minting a fresh one. */
      ensureVirtualPlaceholders();
      listData = {
        list: { id: listId },
        visitors: {},
        movies: [],
        your_list_name: virtualListName || null
      };
    } else {
      listData = await resp.json();
      /* Fresh shared-URL arrival: list exists and has members, but we're
         not one of them yet. If any current member has named the list,
         the server returned that name as default_list_name (first non-
         empty in slot order — slot 1 is the creator, so this prefers the
         creator's nickname when set). Seed virtualListName with it so
         the Couch tab pre-fills with "Movie Night" instead of a random
         Couch#NNN. The server's current value wins over any stale
         localStorage value (e.g. members may have renamed since our
         last visit). When the user does anything concrete,
         ensureMaterialized -> PUT /list-name will save virtualListName
         as their per-user nickname; they can still edit it freely
         without affecting anyone else. */
      const haveSlot = Object.values(listData.visitors).some(v => v.id === visitorId);
      if (!haveSlot) {
        if (listData.default_list_name) {
          virtualListName = listData.default_list_name;
          writeLocalStorage('wtw_virtual_list_name', virtualListName);
        }
        ensureVirtualPlaceholders();
        listData.your_list_name = virtualListName;
      }
    }
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

/* Show the search box unconditionally — virtual visitors can search and
   add, which materializes them. The old "welcome msg / set name first"
   gate was removed when we made bare `/` land in couchlist mode. */
function updateSearchArea() {
  const searchBox = document.getElementById('search-box');
  const welcome = document.getElementById('welcome-msg');
  const colorDot = document.getElementById('my-color-dot');
  searchBox.style.display = '';
  if (welcome) welcome.style.display = 'none';
  /* Color dot is hidden in list mode — color management lives on the
     My Shelf "color" button. We keep the <input type=color> picker that
     it triggers around (it's a native helper for both modes). */
  if (colorDot) colorDot.style.display = 'none';

  /* Reveal/hide the per-mode side buttons. List mode shows the Shelf
     button (data-action="my-shelf", jumps to /?Shelf=1). Shelf mode is
     wired separately in renderShelf. */
  document.querySelectorAll('.action-btn.list-only').forEach(b => {
    b.style.display = (appMode === 'list') ? '' : 'none';
  });
  document.querySelectorAll('.action-btn.shelf-only').forEach(b => {
    b.style.display = (appMode === 'shelf') ? '' : 'none';
  });
  /* Tint the Shelf button to the visitor's color (white-ish bg, dark
     text/outline) so it reads as a "shortcut to your shelf". Pre-
     materialize visitors get a neutral blue. */
  const ms = document.querySelector('.action-btn.side-btn-myshelf');
  if (ms && visitor) {
    ms.style.background  = tintColor(visitor.color);
    ms.style.color       = darkenColor(visitor.color);
    ms.style.borderColor = darkenColor(visitor.color);
  } else if (ms) {
    ms.style.background = '#ffffff';
    ms.style.color = '#0000ee';
    ms.style.borderColor = '#0000ee';
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
  /* First-add on a virtual session creates the visitor, list, slot, and
     nickname before the POST /movies. Once we're materialized, this is a
     no-op. */
  await ensureMaterialized();

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
    /* Your tab: your rank in A, drag handle in B. The handle gets
       `touch-action:none` so finger drags start a drag instead of
       scrolling the page. */
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

  /* TITLE — just the title text. The adder is implicit: their comment is
     always the first pill in the comments column below. */
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
    if (activeTab === 'me' || activeTab === 'all') {
      /* All / My Shelf tabs reorder the master rank by key */
      commitShelfReorder(orderedShelfKeys);
    } else {
      /* list-tab (incl. solo) — entries carry per-list movie_ids */
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
   Tab bar layout:

     [ Couch ]  [ stub user-tab if no slot yet ]  [ Doug ]  [ Percy ]  ...  [ + ]

   - Couch tab — leftmost, always present. Two stacked centered lines, both
     at the same big size: list nickname on top, "couchlist" on bottom. When
     the Couch tab is active the top line becomes an editable input —
     focusout commits via handleListNameEntry. Pre-materialize the input
     placeholder is the virtual Couch#NNN.
   - Stub user tab — only rendered when we have no slot on the list yet
     (virtual session, or a real list we haven't joined). Shows the virtual
     CouchM8#NNN placeholder; typing commits via handleNameEntry.
   - Visitor tabs — one per occupied slot, in slot order (= join order, since
     server.js assigns the next free slot). Tap a tab to make it active. The
     RDY/NAW pip in the corner toggles whether that visitor's votes count
     toward the Couch Borda total. Tap your own tab again to edit your name.
   - "+" tab — always rightmost. Tap to open the share-link modal (which
     materializes the list first if it's still virtual).
   ============================================================================ */

const NAME_MAX_LEN = 12;                          // matches the maxlength on the input

function renderUserTabs() {
  const tabBar = document.getElementById('tab-bar');
  let html = '';

  /* Couch tab — always first. Two stacked centered lines, BOTH at the
     same large size:
       top    — "couchlist" (the brand label)
       bottom — list nickname (editable when this tab is active; falls back
                to the virtual Couch#NNN placeholder pre-materialize)
     Both paint in the list's saved tab_color (mixed from member colors,
     server-side). Threaded down via --list-tab-color so a single inline
     style on the parent paints both lines. Falls back to white when the
     list is virtual / has no saved color yet. */
  const savedListName = (listData && listData.your_list_name) || '';
  const placeholderListName = virtualListName || '';
  const couchActive = (activeTab === 'couch');
  const listTabColor = (listData && listData.list && listData.list.tab_color) || '#ffffff';

  let nicknameLine;
  if (couchActive) {
    nicknameLine = '<input class="tab-name-input tab-couch-name-input" type="text" '
      + 'value="' + escapeHtml(savedListName) + '" '
      + 'placeholder="' + escapeHtml(placeholderListName) + '" '
      + 'autocomplete="off" maxlength="12" data-list-name-input="1">';
  } else {
    const shown = savedListName || placeholderListName;
    nicknameLine = shown
      ? '<span class="tab-couch-text tab-couch-nickname">' + escapeHtml(shown) + '</span>'
      : '';
  }

  /* Total movies on this list — shown as the floating top-right badge on
     the Couch tab. Always numeric (never the red ✕): the Couch view itself
     isn't deletable, and an empty list is removed from shelf mode instead. */
  const couchCount = (listData && listData.movies) ? listData.movies.length : 0;

  html += '<div class="tab tab-couch' + (couchActive ? ' tab-active' : '') + '" '
    + 'data-tab="couch" '
    + 'style="--list-tab-color:' + escapeHtml(listTabColor) + ';">'
    + '<span class="tab-count tab-count-float">' + couchCount + '</span>'
    + '<div class="tab-couch-stack">'
    +   '<span class="tab-couch-text">Couchlist</span>'
    +   nicknameLine
    + '</div>'
    + '</div>';

  /* If there's no visitor row yet, render the user's "virtual" tab with the
     CouchM8#NNN placeholder. Once any slot exists for us, the loop below
     renders the real one instead (and we suppress this stub). */
  const haveSlot = Object.values(listData.visitors).some(v => v.id === visitorId);
  if (!haveSlot) {
    const meActive = (activeTab === visitorId);
    const meTabClasses = ['tab', 'tab-user', 'tab-mine'];
    if (meActive) meTabClasses.push('tab-active');
    const userColor = (visitor && visitor.color) || virtualUserColor || '#cccccc';
    const valueText = (visitor && visitor.name) || '';
    const placeholder = virtualUserName || 'Type your name';

    html += '<div class="' + meTabClasses.join(' ') + '" data-tab="' + visitorId + '" '
      + 'style="background:' + escapeHtml(userColor) + '">'
      + '<input id="name-input" class="tab-name-input" type="text" '
      +   'value="' + escapeHtml(valueText) + '" '
      +   'placeholder="' + escapeHtml(placeholder) + '" '
      +   'autocomplete="off" maxlength="' + NAME_MAX_LEN + '">'
      + '</div>';
  }

  const sortedSlots = Object.keys(listData.visitors).sort((a, b) => a - b);
  sortedSlots.forEach(slot => {
    const v = listData.visitors[slot];
    html += buildVisitorTab(v, v.id === visitorId);
  });

  /* The "+" tab — always rightmost. Tap to open the share-link modal. */
  html += '<div class="tab tab-plus" data-tab="plus" aria-label="Invite someone">'
    + '<span class="tab-plus-icon">+</span>'
    + '</div>';

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

  /* Count of movies this visitor added on the current list. Drives the
     top-right tab badge: positive = number, zero = red ✕ that confirms
     and removes the (movie-less) visitor from this list. */
  const addedCount = listData.movies.filter(m => m.added_by === v.id).length;

  const classes = ['tab', 'tab-user'];
  if (isActive) classes.push('tab-active');
  if (!isSelected) classes.push('tab-dimmed');
  if (isMe) classes.push('tab-mine');

  let html = '<div class="' + classes.join(' ') + '" data-tab="' + v.id + '" '
    + 'style="background:' + escapeHtml(v.color) + '">';
  html += '<span class="tab-ready-btn ' + (isSelected ? 'ready' : 'not-ready') + '">'
    + (isSelected ? 'Rdy' : 'Naw') + '</span>';

  /* Count badge / delete-X. The numeric form is informational and falls
     through to the tab-body click below (switches tabs as normal); the X
     form is intercepted in the tab-bar click handler by its
     .tab-count-empty class. */
  if (addedCount === 0) {
    html += '<span class="tab-count tab-count-empty" '
      + 'data-action="delete-visitor" data-visitor-id="' + escapeHtml(v.id) + '" '
      + 'title="Remove this empty user">✕</span>';
  } else {
    html += '<span class="tab-count">' + addedCount + '</span>';
  }

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
      btn.textContent = newReady ? 'Rdy' : 'Naw';
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
   SECTION 10g: REMOVE VISITOR / DELETE LIST  (added 2026-04-30 with the
                count badge — see project_visual_language / count_badge)
   ============================================================================
   The red ✕ on a tab calls one of two confirm flows. List-mode user-tab X
   removes the visitor's list_visitors row (server re-checks the
   "no movies added" guard). Shelf-mode list-tab X drops the whole list
   (server re-checks "no movies"). The visitor record itself is global and
   never deleted by either path.
   ============================================================================ */

function confirmDeleteVisitor (targetVisitorId) {
  if (!listData) return;
  const target = Object.values(listData.visitors).find(v => v.id === targetVisitorId);
  if (!target) return;
  const name = displayNames[target.id] || target.name || 'this user';
  const msg = 'Remove ' + name + ' from this list? They have no movies on it. '
    + '(Their identity isn’t deleted; they can rejoin any time.)';
  if (!window.confirm(msg)) return;
  deleteVisitorFromList(targetVisitorId);
}

async function deleteVisitorFromList (targetVisitorId) {
  try {
    const resp = await fetch(
      API + '/list/' + listId + '/visitors/' + targetVisitorId,
      { method: 'DELETE' }
    );
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      window.alert('Could not remove: ' + (body.error || resp.statusText));
      return;
    }
  } catch (e) {
    window.alert('Network error — please retry.');
    return;
  }

  /* If the viewer just removed themselves (or whoever they were viewing),
     fall back to the Couch tab so we don't render against a missing slot. */
  if (targetVisitorId === visitorId) activeTab = 'couch';
  if (activeTab === targetVisitorId) activeTab = 'couch';
  loadList();
}

function confirmDeleteList (targetListId) {
  if (!shelfData) return;
  const target = shelfData.lists.find(l => l.id === targetListId);
  if (!target) return;
  const label = (target.list_name && target.list_name.trim())
    || (target.private ? 'your Solo list' : 'this list');
  const scope = target.private
    ? 'It only contains your private picks.'
    : 'Everyone on the list will lose it.';
  const msg = 'Delete ' + label + '? It has no movies on it. ' + scope;
  if (!window.confirm(msg)) return;
  deleteEmptyList(targetListId);
}

async function deleteEmptyList (targetListId) {
  try {
    const resp = await fetch(API + '/list/' + targetListId, { method: 'DELETE' });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      window.alert('Could not delete: ' + (body.error || resp.statusText));
      return;
    }
  } catch (e) {
    window.alert('Network error — please retry.');
    return;
  }

  /* If the viewer was looking at the just-deleted list, reset to the
     "My Shelf" tab — the safest landing spot in shelf mode. */
  if (activeTab === targetListId) activeTab = 'me';
  if (typeof loadShelf === 'function') loadShelf();
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
   SECTION 12: DETAILS MODAL — list-mode export/import (currently inert)
   ============================================================================
   Legacy: the old INFO button opened openCopyPasteModal() with the blob
   below. The button has been removed from the search row, so on the live
   site this modal is unreachable in list mode. We keep the code because
   parseBlob() is still used by the shelf Manage modal to parse a pasted
   snapshot, and applyPasteText() is still reachable via the pendingPaste
   sessionStorage hook in initApp (a leftover from the time when paste
   could trigger a list/visitor handoff). Safe to delete this whole section
   if those two consumers are removed.

   BLOB FORMAT (kept loose so hand-edits survive):
     # CouchList Snapshot
     URL:       https://.../?ListId=<list_id>
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

   APPLY RULES (additive, when applyPasteText runs):
     - New movies always get added as the current user.
     - Comments attributed to anyone other than the current user are dropped.
     - Movie order in the textarea becomes the current user's personal ranking.
     - If list_id differs: stash the blob, navigate to ?ListId=...; the next
       page load picks it up via sessionStorage.pendingPaste.
     - If visitor_id differs: ensure that visitor exists, try to recycle the
       current (untouched) visitor, swap the cookie, reload.
   ============================================================================ */

/* ============================================================================
   Popup sizing — visualViewport-aware (shared by every popup)
   ============================================================================
   Consumers: .modal-content (How-to + shelf Manage + multi-X confirm),
   .popup-content (poster info), .comment-expanded (comment editor),
   .shelf-note-expanded (shelf note editor). All use the same three CSS
   vars — --modal-top, --modal-left, --modal-width — set on the element
   passed in. The share modal (`+` tab) uses fixed positioning instead.

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
   SHARE MODAL — opened by the rightmost "+" tab.
   ============================================================================
   Shows two links:
     • Invite link  — `?ListId=<id>`. Anyone who opens this URL joins the
                      list (their existing identity, or a fresh one).
     • Your private (incognito) link — `?ListId=<id>&UserId=<vid>`. Resumes
                      THIS visitor's identity in any browser. Treat it like
                      a password — anyone with it becomes you.
   Tapping the "+" forces materialization first so we always have a real,
   shareable URL even on a brand-new virtual session. */
async function openShareModal () {
  await ensureMaterialized();
  /* loadList so the tab strip and your_list_name reflect the new state. */
  await loadList();

  const origin = window.location.origin;
  const inviteUrl = origin + '/?ListId=' + encodeURIComponent(listId);
  const privateUrl = origin + '/?ListId=' + encodeURIComponent(listId)
    + '&UserId=' + encodeURIComponent(visitorId);

  const modal = document.getElementById('copy-paste-modal');
  modal.innerHTML =
    '<div class="share-modal">'
    + '<button class="modal-close share-modal-close" aria-label="Close">✕</button>'
    + '<h3>Invite someone</h3>'
    + '<p class="share-hint">Send this link to anyone you want on this list. '
    + 'Opening it joins them automatically.</p>'
    + '<input class="share-link" readonly value="' + escapeHtml(inviteUrl) + '">'
    + '<button class="share-copy-btn" data-share-target="invite">Copy invite link</button>'

    + '<h3 class="share-h3-2">Your private link</h3>'
    + '<p class="share-hint">Save this for yourself — it logs you back in '
    + 'as <strong>' + escapeHtml((visitor && visitor.name) || 'you') + '</strong> '
    + 'in incognito or a different browser. Don\'t share it with anyone.</p>'
    + '<input class="share-link" readonly value="' + escapeHtml(privateUrl) + '">'
    + '<button class="share-copy-btn" data-share-target="private">Copy private link</button>'
    + '</div>';

  modal.style.display = 'block';

  modal.querySelector('.share-modal-close').addEventListener('click', () => {
    modal.style.display = 'none';
    modal.innerHTML = '';
  });
  modal.querySelectorAll('.share-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.shareTarget;
      const url = (target === 'invite') ? inviteUrl : privateUrl;
      copyToClipboard(url);
      btn.textContent = 'Copied!';
      setTimeout(() => {
        btn.textContent = (target === 'invite') ? 'Copy invite link' : 'Copy private link';
      }, 1200);
    });
  });
  modal.querySelectorAll('.share-link').forEach(inp => {
    inp.addEventListener('focus', () => inp.select());
  });
}

function copyToClipboard (text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy (text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* best effort */ }
  document.body.removeChild(ta);
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
  lines.push('URL:       ' + window.location.origin + '/?ListId=' + listId);
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
   applyPasteText(text) — the legacy apply pipeline
   ============================================================================
   Handles URL handoff, visitor handoff, additive movie merge, comment filter,
   and the final bulk rank reset. Currently only reachable via the
   sessionStorage.pendingPaste hook in initApp (left over from the previous
   INFO/Apply flow). No live UI calls this directly anymore — see SECTION 12
   note. Kept because pendingPaste from older sessions could still appear.
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
    window.location.href = '/?ListId=' + encodeURIComponent(parsed.list_id);
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

/* Derived-color helpers used by the Shelf side-button tint in updateSearchArea
   (and historically by the now-removed My Shelf overlay). Visitor colors come
   in as either `#rrggbb` (from the native picker) or `hsl(h,s%,l%)` (from
   randomColor()). darkenColor → text/border, tintColor → near-white bg. */
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

/* SECURITY: escape user-supplied text for safe insertion into HTML.
   Handles all five HTML-significant characters — the `"` and `'`
   substitutions matter because we splice escapeHtml() output into
   double-quoted attributes (e.g. `style="color: ${escapeHtml(color)}"`).
   The `&` replacement MUST run first so later substitutions aren't
   double-escaped. */
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

    /* Red ✕ count-badge → confirm-and-remove the (movie-less) visitor.
       Numeric .tab-count (no -empty class) is informational; clicks fall
       through to the tab-body branch and just switch tabs. */
    const deleteX = e.target.closest('.tab-count.tab-count-empty');
    if (deleteX && deleteX.dataset.action === 'delete-visitor') {
      e.stopPropagation();
      confirmDeleteVisitor(deleteX.dataset.visitorId);
      return;
    }

    /* "+" tab → share-link modal (no active-view change) */
    const plusTab = e.target.closest('.tab-plus');
    if (plusTab) { openShareModal(); return; }

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

    /* Couch-tab nickname input — route to the list-name save path. */
    if (e.target.dataset.listNameInput === '1') {
      const current = (listData && listData.your_list_name) || '';
      if (newName === current) return;
      handleListNameEntry(newName);
      return;
    }

    /* otherwise: visitor name input */
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

  /* Search-row side buttons. List mode: Shelf (data-action my-shelf) +
     Help. Shelf mode wires its own cluster (Couch/Color/Move/All/Help)
     in setupShelfEventListeners. */
  document.querySelectorAll('#search-row .action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.action === 'howto') {
        openHowToModal();
        return;
      }
      if (btn.dataset.action === 'my-shelf') {
        /* Materialize the visitor first so the shelf has an identity to
           render against. Tapping Shelf is a deliberate write intent — it
           saves the virtual CouchM8#NNN name if no name has been typed. */
        await materializeVisitor();
        window.location.href = '/?Shelf=1';
      }
    });
  });
}


/* ============================================================================
   SECTION 15b: HOW-TO MODAL — feature cheat-sheet
   ============================================================================ */

function openHowToModal() {
  const modal = document.getElementById('how-to-modal');

  /* My Shelf gets its own body. The list-mode body further down stays the
     reference doc for visitors arriving on a couchlist URL. The shared
     show/wire-up code at the bottom of this function handles both paths;
     the colorDot/rdyBtn queries it runs return null in shelf mode (those
     elements aren't in the shelf body) and the if-guards skip the wire-up. */
  if (appMode === 'shelf') {
    renderShelfHowToBody(modal);
    showHowToModal(modal);
    return;
  }

  /* Pre-materialize fallbacks: virtualUserName / virtualListName /
     virtualUserColor are set by enterVirtualList() the moment a fresh
     visitor lands on /, so they're populated even before any DB row exists
     (e.g. an incognito tab that just hit the help modal). */
  const myColor = (visitor && visitor.color) || virtualUserColor || '#bbb';
  const myColorEsc = escapeHtml(myColor);
  const myName = (visitor && visitor.name) || virtualUserName || 'your name';
  const listNick = (listData && listData.your_list_name && listData.your_list_name.trim())
    || virtualListName
    || 'list nickname';

  /* Personal login URL — same `?ListId=…&UserId=…` form as the share
     modal's "private link". Falls back to placeholders when the visitor
     hasn't materialized yet. */
  const safeListId = listId ? encodeURIComponent(listId) : 'XXXXXXXX';
  const safeUserId = visitorId ? encodeURIComponent(visitorId) : 'YOURID';
  const loginUrl = window.location.origin
    + '/?ListId=' + safeListId + '&UserId=' + safeUserId;

  modal.innerHTML = '<div class="modal-content howto-modal">'
    + '<button class="modal-close">✕</button>'
    + '<h2>How CouchList works</h2>'

    + '<p>Couchlist is a list of movies you and your couch mates want to '
    + 'watch. It was made by Doug with Claude Code for fun.</p>'

    + '<p>The <span class="howto-mini howto-mini-couchtab">Couchlist</span> '
    + 'tab lists movies in everyone\'s average ranking '
    + '(<a href="https://en.wikipedia.org/wiki/Borda_count" target="_blank" rel="noopener">Borda</a>).</p>'

    + '<p>The other tabs show the list in each user\'s ranking.</p>'

    + '<p>Setting <span class="howto-mini howto-mini-naw-circle">Naw</span> '
    + 'instead of <span class="howto-mini howto-mini-rdy-circle">Rdy</span> '
    + 'exempts that user\'s ranking from the Couchlist.</p>'

    + '<p>Click on <span class="howto-mini howto-mini-mytab" '
    + 'style="background:' + myColorEsc + '">' + escapeHtml(myName) + '</span> '
    + 'or <span class="howto-mini howto-mini-couchtab">' + escapeHtml(listNick) + '</span> '
    + 'to edit it.</p>'

    + '<p>Use the search bar to add more movies.</p>'

    + '<p>Invite others with <span class="howto-mini howto-mini-plus">+</span>.</p>'

    + '<p><span class="howto-mini howto-mini-action howto-mini-shelfbtn">Shelf</span> '
    + 'is for ranking movies by yourself or with different couch mates.</p>'

    + '<p>Couchlist users have no security. A user ID is just a plain text '
    + 'string. Anyone who sees it can be that user. Don\'t put anything '
    + 'sensitive here.</p>'

    + '<p>A cookie with your user ID is set. This link will set the '
    + 'current user without the cookie:<br>'
    + '<strong>' + escapeHtml(loginUrl) + '</strong></p>'

    + '</div>';

  showHowToModal(modal);
}

/* Shared show + wire-up for both list-mode and shelf-mode help bodies.
   The colorDot/rdyBtn queries return null in shelf mode (those elements
   only exist in the list-mode body) and the if-guards skip the wire-up. */
function showHowToModal(modal) {
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
      rdyBtn.textContent = nowReady ? 'Rdy' : 'Naw';
    });
  }
}

/* Shelf-mode help body. Each parenthesized label in the source spec gets a
   small inline box that mirrors the corresponding tab/button — same border,
   bg, and text color, but at paragraph font size so it fits inline. */
function renderShelfHowToBody(modal) {
  const sv = shelfData && shelfData.visitor;
  const userColor = (sv && sv.color) ? sv.color : '#bbb';
  const userColorEsc = escapeHtml(userColor);

  modal.innerHTML = '<div class="modal-content howto-modal">'
    + '<button class="modal-close">✕</button>'
    + '<h2>How My Shelf works</h2>'

    + '<p>The <span class="howto-mini howto-mini-myshelf" '
    + 'style="background:' + userColorEsc + '">My Shelf</span> '
    + 'tab shows every movie you have added to any list you are '
    + '<span class="howto-mini howto-mini-rdy">Rdy</span> on.</p>'

    + '<p>The <span class="howto-mini howto-mini-all">All</span> '
    + 'tab shows every movie anyone has added to any list you are '
    + '<span class="howto-mini howto-mini-rdy">Rdy</span> on.</p>'

    + '<p>The <span class="howto-mini howto-mini-solo" '
    + 'style="color:' + userColorEsc + ';border-color:' + userColorEsc + '">Solo</span> '
    + 'tab shows any movie you have added that isn\'t on any couchlist.</p>'

    + '<p>Each couchlist tab shows all the movies in that list in your ranking only.</p>'

    + '<p>Tap <span class="howto-mini howto-mini-rdy">Rdy</span> on the '
    + '<span class="howto-mini howto-mini-all">All</span> '
    + 'tab to force all lists <span class="howto-mini howto-mini-rdy">Rdy</span>; '
    + 'tap again to force all lists <span class="howto-mini howto-mini-naw">Naw</span>.</p>'

    + '<p>Tap <span class="howto-mini howto-mini-action howto-mini-move">Move</span> '
    + 'to view/edit raw data, or to bulk copy or remove movies from lists.</p>'

    + '<p>Tap <span class="howto-mini howto-mini-action howto-mini-allbtn">All</span> '
    + 'to select all movies on the current list; tap again to clear all selections.</p>'

    + '<p><span class="howto-mini howto-mini-action howto-mini-color" '
    + 'style="color:' + userColorEsc + ';border-color:' + userColorEsc + '">Color</span> '
    + 'changes your user color.</p>'

    + '<p><span class="howto-mini howto-mini-action howto-mini-couch">Couch</span> '
    + 'goes to couchlist mode — it will go to the current couchlist tab if you are on one.</p>'

    + '</div>';
}


/* ============================================================================
   SECTION 16: MY SHELF MODE
   ============================================================================
   Reached via /?Shelf=1 (the Shelf button target) once the visitor has a
   real DB row. initShelf loads the visitor profile and the /shelf payload
   — a single response with every list this visitor is on (incl. their
   private "solo" list) and every movie they've encountered, in master_rank
   order. shelfData.lists carries RDY state; shelfData.movies carries
   per-list entries with `added_here` flags.

   Tab strip:
     [ My Shelf ]  [ All ]  [ Solo? ]  [ list-tab ]  [ list-tab ]  ...
       me            all     solo.id     list.id

     - "My Shelf"  — every movie YOU added that's on at least one currently-
                     RDY list of yours.
     - "All"       — every movie on at least one currently-RDY list (any
                     adder). The pip on this tab fans out RDY/NAW to every
                     list-tab + solo.
     - "Solo"      — your private stash. Hidden until it has at least one
                     movie.
     - One tab per non-private list you're on. Tapping the active list-tab
       again swaps the label for an editable nickname input.

   The drag scaffolding is shared with list mode; SECTION 8 reads `appMode`
   and `activeTab` to decide whether to commit by master-rank keys
   (/shelf-ranks) or per-list movie IDs (/list/:id/my-ranks).

   Bouncing back to list mode: if the visitor has no DB row when shelf
   loads (e.g. someone manually typed /?Shelf=1 with a fresh cookie),
   loadShelf redirects to / so they can engage and materialize there.
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
  /* Reaching shelf without a visitor row means someone manually navigated
     to /?Shelf=1 with a fresh cookie. Bounce them back to the couchlist
     landing where they can engage and materialize. */
  if (!visitor) {
    window.location.href = '/';
    return;
  }
  const resp = await fetch(API + '/visitor/' + visitorId + '/shelf');
  if (!resp.ok) {
    window.location.href = '/';
    return;
  }
  shelfData = await resp.json();
  renderShelf();
}

function renderShelf () {
  const searchBox = document.getElementById('search-box');
  const welcome   = document.getElementById('welcome-msg');
  const colorDot  = document.getElementById('my-color-dot');

  /* Mode chrome: hide list-only stuff, show shelf-only stuff. */
  document.querySelectorAll('.action-btn.list-only').forEach(b => b.style.display = 'none');
  document.querySelectorAll('.action-btn.shelf-only').forEach(b => b.style.display = '');

  /* Color the shelf-only side buttons from the visitor's color. */
  const colorBtn = document.querySelector('.action-btn.side-btn-color');
  if (colorBtn && shelfData && shelfData.visitor) {
    colorBtn.style.color = shelfData.visitor.color;
    colorBtn.style.borderColor = shelfData.visitor.color;
  }

  /* default to "my shelf" tab if activeTab isn't a recognized one. */
  const knownTab =
    activeTab === 'me' ||
    activeTab === 'all' ||
    (shelfData.lists && shelfData.lists.some(l => l.id === activeTab));
  if (!knownTab) activeTab = 'me';

  /* Reveal the All/None toggle now that we have a real shelf to act on.
     (Always shown in shelf mode — we always have at least the My Shelf tab.) */
  const selBtn = document.querySelector('.action-btn[data-action="select-all"]');
  if (selBtn) selBtn.style.display = '';

  /* Couch button — link target depends on active tab.
       on a real list-tab → that list's couchlist URL
       on All / My Shelf  → last-viewed list (localStorage), else first
                            joined non-solo list
       on Solo            → the solo list URL (created on first add)
     If we have no candidate at all (brand-new visitor with no lists),
     gray out the button. */
  const couchBtn = document.querySelector('.action-btn.side-btn-couch');
  if (couchBtn) {
    const linkId = pickCouchLinkTarget();
    if (linkId) {
      couchBtn.style.opacity = '';
      couchBtn.style.cursor = 'pointer';
      couchBtn.dataset.listLink = linkId;
    } else {
      couchBtn.style.opacity = '0.4';
      couchBtn.style.cursor = 'default';
      delete couchBtn.dataset.listLink;
    }
  }

  /* Search box always visible in shelf mode. Placeholder hints target. */
  if (searchBox) {
    searchBox.style.display = '';
    if (activeTab === 'me' || activeTab === 'all') {
      searchBox.placeholder = 'Add a movie (saved to your solo list)';
    } else {
      const list = shelfData.lists.find(l => l.id === activeTab);
      const label = list && list.list_name ? list.list_name
                  : list && list.private   ? 'solo' : 'this list';
      searchBox.placeholder = 'Add a movie to ' + label;
    }
  }
  if (welcome)  welcome.style.display = 'none';
  if (colorDot) colorDot.style.display = 'none';

  document.getElementById('movie-list').className = 'shelf-mode';

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
  if (activeTab === 'all') {
    /* Movies that appear on at least one currently-RDY list (yours OR
       added by someone else on a shared RDY list). */
    const rdy = rdyListIdSet();
    return shelfData.movies
      .filter(m => m.list_entries.some(le => rdy.has(le.list_id)))
      .map(m => shelfEntryKey(m, null));
  }
  if (activeTab === 'me') {
    return shelfData.movies
      .filter(m => m.added_by_me)
      .map(m => shelfEntryKey(m, null));
  }
  /* list-tab (incl. solo's actual id once it exists) */
  const out = [];
  shelfData.movies.forEach(m => {
    const e = m.list_entries.find(le => le.list_id === activeTab);
    if (e) out.push(shelfEntryKey(m, e));
  });
  return out;
}

/* Set of list_ids whose RDY pip is currently on. */
function rdyListIdSet () {
  const set = new Set();
  if (!shelfData) return set;
  shelfData.lists.forEach(l => { if (l.ready) set.add(l.id); });
  return set;
}

function refreshShelfSelectAllLabel () {
  const btn = document.querySelector('.action-btn[data-action="select-all"]');
  if (!btn) return;
  const visible = shelfVisibleKeys();
  const sel = shelfSelected();
  const allSelected = visible.length > 0 && visible.every(k => sel.has(k));
  btn.textContent = allSelected ? 'None' : 'All';
}

function selectAllVisible () {
  const sel = shelfSelected();
  shelfVisibleKeys().forEach(k => sel.add(k));
}

function renderShelfTabs () {
  const v = shelfData.visitor;
  const tabBar = document.getElementById('tab-bar');

  const listTabs   = shelfData.lists.filter(l => !l.private);
  const solo = shelfData.lists.find(l => l.private && l.owner_visitor_id === v.id);
  const soloHasMovies = solo
    ? shelfData.movies.some(m => m.list_entries.some(le => le.list_id === solo.id))
    : false;

  /* Helper — count movies on a given list_id by walking
     shelfData.movies[].list_entries. Same numbers the count badges show. */
  const movieCountForList = (lid) =>
    shelfData.movies.reduce((n, m) =>
      n + (m.list_entries.some(le => le.list_id === lid) ? 1 : 0), 0);

  /* Per-tab "movies you'd see clicking this" counts. Doug's rule: every
     tab in shelf mode carries a count badge in the top-right that matches
     the actual rendered list, so RDY toggling visibly updates the
     My Shelf and All numbers. Filters here mirror renderShelfMovieList:
       - My Shelf  → movies you added AND that live on at least one RDY list
       - All       → movies on at least one RDY list (any adder) */
  const rdyListIds = new Set();
  shelfData.lists.forEach(l => { if (l.ready) rdyListIds.add(l.id); });
  const onAnyRdyList = (m) => m.list_entries.some(le => rdyListIds.has(le.list_id));
  const myShelfCount = shelfData.movies
    .filter(m => m.added_by_me && onAnyRdyList(m))
    .length;
  const allCount = shelfData.movies
    .filter(onAnyRdyList)
    .length;

  /* "My Shelf" tab — leftmost, doublewide (mirrors the Couchlist tab in
     list mode). User-color bg, no RDY pip. Two stacked lines: the user's
     own name on top with a non-editable "'s" suffix (so it reads
     "Doug's"), and "Shelf" centered below. The username input commits on
     focusout / Enter via the listener in setupShelfEventListeners.
     The count badge is the floating variant — My Shelf overrides the
     .tab-user grid for a centered flex stack, so an in-flow grid-cell
     badge would shoulder the stack off-center. */
  const userBg = v.color ? ('background:' + escapeHtml(v.color) + ';') : '';
  const userName = v.name || '';
  let html = '<div class="tab tab-user tab-shelf-myshelf tab-mine'
    + (activeTab === 'me' ? ' tab-active' : '')
    + '" data-shelf-tab="me" style="' + userBg + '">'
    + '<span class="tab-count tab-count-float">' + myShelfCount + '</span>'
    + '<div class="tab-shelf-myshelf-stack">'
    +   '<span class="tab-shelf-myshelf-name-row">'
    +     '<input class="tab-name-input shelf-username-input" type="text" '
    +       'value="' + escapeHtml(userName) + '" '
    +       'autocomplete="off" maxlength="' + NAME_MAX_LEN + '">'
    +     '<span class="tab-shelf-myshelf-suffix">’s</span>'
    +   '</span>'
    +   '<span class="tab-shelf-myshelf-label">Shelf</span>'
    + '</div>'
    + '</div>';

  /* "All" tab — derived RDY state = "every visible list-tab (incl. solo
     when its tab is showing) is RDY". The toggle fans out to that same
     set; flipping any one list to NAW makes the All pip flip NAW. */
  const allRdyLists = soloHasMovies ? listTabs.concat([solo]) : listTabs;
  const allRdy     = allRdyLists.length > 0 && allRdyLists.every(l => l.ready);
  html += '<div class="tab tab-user tab-shelf-all'
    + (activeTab === 'all' ? ' tab-active' : '')
    + '" data-shelf-tab="all">'
    + '<span class="tab-ready-btn ' + (allRdy ? 'ready' : 'not-ready') + '" '
    +   'data-shelf-rdy-all="1">'
    +   (allRdy ? 'Rdy' : 'Naw')
    + '</span>'
    + '<span class="tab-count">' + allCount + '</span>'
    + '<span class="tab-name">All</span>'
    + '</div>';

  /* "Solo" tab — only renders if the visitor's solo list exists AND has
     at least one movie. (Solo is created lazily on first /solo-add.)
     Because the soloHasMovies guard above is exactly "count > 0", the
     count badge here is always numeric — the red ✕ path can never trigger,
     so we render it as a plain numeric span instead of going through
     buildShelfCountBadge. */
  if (solo && soloHasMovies) {
    const userColor = v.color || '#0000ee';
    const isActive = activeTab === solo.id;
    const soloCount = movieCountForList(solo.id);
    html += '<div class="tab tab-user tab-shelf-solo'
      + (isActive ? ' tab-active' : '')
      + (solo.ready ? '' : ' tab-dimmed')
      + '" data-shelf-tab="' + escapeHtml(solo.id) + '" '
      + 'style="color:' + escapeHtml(userColor) + ';">'
      + '<span class="tab-ready-btn ' + (solo.ready ? 'ready' : 'not-ready') + '" '
      +   'data-shelf-rdy-list="' + escapeHtml(solo.id) + '">'
      +   (solo.ready ? 'Rdy' : 'Naw')
      + '</span>'
      + '<span class="tab-count">' + soloCount + '</span>'
      + '<span class="tab-name">Solo</span>'
      + '</div>';
  }

  /* List tabs — solid bg per list, sticky-saved server-side as
     lists.tab_color (mixed from member colors when first seen). Unnamed
     lists get noname1, noname2, … by chronological order among
     unnamed-only lists. */
  let nonameCounter = 0;
  listTabs.forEach(l => {
    const hasName = !!(l.list_name && l.list_name.trim());
    const label   = hasName ? l.list_name : 'noname' + (++nonameCounter);
    const isActive = activeTab === l.id;
    const ready   = l.ready;
    const tabColor = l.tab_color || '#cccccc';
    const count   = movieCountForList(l.id);

    html += '<div class="tab tab-user tab-shelf-list'
      + (isActive ? ' tab-active' : '')
      + (ready ? '' : ' tab-dimmed')
      + '" data-shelf-tab="' + escapeHtml(l.id) + '" '
      + 'style="background:' + escapeHtml(tabColor) + ';">'
      + '<span class="tab-ready-btn ' + (ready ? 'ready' : 'not-ready') + '" '
      +   'data-shelf-rdy-list="' + escapeHtml(l.id) + '">'
      +   (ready ? 'Rdy' : 'Naw')
      + '</span>'
      + buildShelfCountBadge(l.id, count);

    if (isActive) {
      html += '<input class="tab-name-input shelf-list-name-input" type="text" '
        +   'value="' + escapeHtml(l.list_name || '') + '" '
        +   'placeholder="' + escapeHtml(label) + '" '
        +   'autocomplete="off" maxlength="12" '
        +   'data-list-id="' + escapeHtml(l.id) + '">';
    } else {
      html += '<span class="tab-name">' + escapeHtml(label) + '</span>';
    }
    html += '</div>';
  });

  /* "+" tab — always rightmost. Tap to drop into couch mode on a brand
     new virtual list, preserving the visitor cookie. Mirrors the list-mode
     plus-tab visually, different action. */
  html += '<div class="tab tab-plus" data-shelf-tab="plus" aria-label="Start a new list">'
    + '<span class="tab-plus-icon">+</span>'
    + '</div>';

  tabBar.innerHTML = html;
}

/* Shared count-badge builder for shelf-mode tabs. count > 0 → numeric
   info-only pill; count === 0 → red ✕ that calls the delete-list confirm
   flow via the tab-bar click handler. */
function buildShelfCountBadge (listId, count) {
  if (count === 0) {
    return '<span class="tab-count tab-count-empty" '
      + 'data-action="delete-list" data-list-id="' + escapeHtml(listId) + '" '
      + 'title="Delete this empty list">✕</span>';
  }
  return '<span class="tab-count">' + count + '</span>';
}

/* Resolve which list_id the shelf-mode "Couch" side button should navigate to.
   Returns null when no candidate exists (brand-new visitor with no lists). */
function pickCouchLinkTarget () {
  if (!shelfData) return null;

  /* On a real list-tab (incl. solo's actual id once it exists) — that list. */
  const direct = shelfData.lists.find(l => l.id === activeTab);
  if (direct) return direct.id;

  /* On All / My Shelf — server-side last_list_id (must still be a non-solo
     list this visitor is on), else first joined non-solo list. */
  const lastViewed = visitor && visitor.last_list_id;
  if (lastViewed && shelfData.lists.some(l => l.id === lastViewed && !l.private)) {
    return lastViewed;
  }
  const firstList = shelfData.lists.find(l => !l.private);
  return firstList ? firstList.id : null;
}

async function commitShelfListName (listId, newName) {
  await fetch(API + '/list/' + listId + '/list-name', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitor_id: visitorId, list_name: newName })
  });
  await loadShelf();
}

/* My Shelf tab username commit. PUT /api/visitor/:id is the same endpoint
   handleColorChange uses; we round-trip name + the visitor's existing
   color so the server's UPDATE doesn't blank one when we set the other. */
async function commitShelfUserName (newName) {
  if (!visitor) return;
  visitor.name = newName;
  if (shelfData && shelfData.visitor) shelfData.visitor.name = newName;
  await fetch(API + '/visitor/' + visitorId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName, color: visitor.color })
  });
  await loadShelf();
}

function renderShelfMovieList () {
  const ml = document.getElementById('movie-list');

  /* default: nothing checked. Drop stale selections that no longer apply
     (e.g. data refresh removed the entry). */
  const visible = shelfVisibleKeys();
  const sel = shelfSelected();
  const visibleSet = new Set(visible);
  Array.from(sel).forEach(k => { if (!visibleSet.has(k)) sel.delete(k); });

  if (activeTab === 'all') {
    /* "All" — every movie that lives on at least one currently-RDY list
       (any adder). RDY off everywhere → empty view; turn lists RDY (via
       the All pip or per-tab) to populate. */
    const rdy = rdyListIdSet();
    const filtered = shelfData.movies.filter(m =>
      m.list_entries.some(le => rdy.has(le.list_id)));
    if (filtered.length === 0) {
      const msg = (rdy.size === 0)
        ? 'Toggle a list RDY to see its movies here.'
        : 'No movies on the currently-RDY lists.';
      ml.innerHTML = '<div class="shelf-empty">' + msg + '</div>';
      refreshShelfSelectAllLabel();
      return;
    }
    ml.innerHTML = '';
    filtered.forEach((m, i) => {
      ml.appendChild(renderShelfEntry(m, i + 1, null, null));
    });
    refreshShelfSelectAllLabel();
    return;
  }

  if (activeTab === 'me') {
    /* "My Shelf" — All tab's RDY filter, narrowed to movies this visitor
       added. Solo's RDY pip is honored the same way. */
    const rdy = rdyListIdSet();
    const myMovies = shelfData.movies.filter(m =>
      m.added_by_me && m.list_entries.some(le => rdy.has(le.list_id)));
    if (myMovies.length === 0) {
      const hasAnyAdds = shelfData.movies.some(m => m.added_by_me);
      const msg = !hasAnyAdds
        ? 'No movies added yet. Visit a list and add something — it will show up here.'
        : (rdy.size === 0)
          ? 'Toggle a list RDY to see your adds here.'
          : 'Nothing you added is on a currently-RDY list.';
      ml.innerHTML = '<div class="shelf-empty">' + msg + '</div>';
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

  /* list-tab (incl. solo's actual id once created) */
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
   rendering inside a list-tab (incl. solo); null when rendering inside the
   "all" or "my shelf" tabs.
   Layout (7 cells, matches #movie-list.shelf-mode grid):
     rank  grab  poster  title  note  checkbox  X
   The note is a textarea bound to (visitor, tmdb_id, media_type) — saved on
   blur via PUT /visitor/:id/note. Visible only to this visitor. */
function renderShelfEntry (movie, position, listId, listEntry) {
  const entry = document.createElement('div');
  entry.className = 'entry shelf-entry';
  entry.dataset.tmdbId    = movie.tmdb_id;
  entry.dataset.mediaType = movie.media_type;
  if (listEntry) entry.dataset.movieId = listEntry.movie_id;       // list-tab drag commits by movie_id

  const key = shelfEntryKey(movie, listEntry);
  entry.dataset.shelfKey = key;
  const checked = shelfSelected().has(key);

  const posterUrl = movie.poster ? TMDB_IMG + 'w92' + movie.poster : '';
  const yearText  = (movie.year != null) ? movie.year : '';

  /* X-to-remove. On list-tabs only entries the visitor added show one.
     On the all / my-shelf tab the X opens a multi-list confirm popup. */
  let removeHtml = '';
  if (listEntry) {
    if (listEntry.added_here) {
      removeHtml = '<button class="remove-btn" data-movie-id="' + listEntry.movie_id
        + '" data-list-id="' + escapeHtml(listId) + '">✕</button>';
    }
  } else if (movie.added_by_me) {
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
    + '<div class="entry-comments">'                  /* doubles as note column slot */
      + '<div class="shelf-note-box' + (movie.note ? '' : ' shelf-note-empty') + '" '
      +     'data-tmdb-id="' + movie.tmdb_id + '" '
      +     'data-media-type="' + escapeHtml(movie.media_type) + '">'
      +   (movie.note ? escapeHtml(movie.note) : 'note:')
      + '</div>'
    + '</div>'
    + '<div class="shelf-checkbox-cell">'
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
  const payload = {
    tmdb_id: tmdbMovie.id,
    media_type: tmdbMovie.media_type || 'movie',
    title: tmdbMovie.title,
    year: year,
    poster: tmdbMovie.poster_path
  };

  /* Routing:
       - real list-tab (incl. solo's actual id) → /list/:id/movies
       - all / my-shelf                          → /solo-add
         (lazily creates the solo list on first add) */
  const targetList = shelfData.lists.find(l => l.id === activeTab);
  let resp;
  if (targetList) {
    payload.visitor_id = visitorId;
    resp = await fetch(API + '/list/' + targetList.id + '/movies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    resp = await fetch(API + '/visitor/' + visitorId + '/solo-add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  /* Solo guard: server returns { skipped:true, list_id, list_name } when
     the movie is already on another non-solo list of theirs. Surface as a
     standalone popup since the user is doing a single-movie search-add. */
  let data = null;
  try { data = await resp.json(); } catch (_) { /* non-JSON ignored */ }
  if (data && data.skipped) {
    const listLabel = (data.list_name && data.list_name.trim())
      ? data.list_name : data.list_id;
    alert('"' + (payload.title || data.title || 'Movie')
      + '" not added to solo, you have already added it to "'
      + listLabel + '".');
  }

  document.getElementById('search-box').value = '';
  searchResults = [];
  renderSearchResults();
  hideMoviePopup();
  await loadShelf();
}

/* Save a private note. Empty/whitespace clears it on the server. */
async function saveShelfNote (tmdbId, mediaType, note) {
  await fetch(API + '/visitor/' + visitorId + '/note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tmdb_id: tmdbId,
      media_type: mediaType,
      note: note
    })
  });
  /* Patch local cache so a subsequent re-render keeps the saved value. */
  if (shelfData) {
    const m = shelfData.movies.find(mm =>
      mm.tmdb_id === tmdbId && mm.media_type === mediaType);
    if (m) m.note = (note && note.trim()) || '';
  }
}

/* Click-to-expand for shelf notes — mirrors expandComment(): backdrop + modal-
   sized box with a textarea and Done/X. The note textarea is only ever in the
   popup, never inline (so focusout-on-row no longer applies). */
let shelfNoteUnbindWidth = null;
let expandedShelfNote    = null;                                   // { tmdbId, mediaType } | null

function expandShelfNote (tmdbId, mediaType) {
  if (expandedShelfNote) return;
  expandedShelfNote = { tmdbId: tmdbId, mediaType: mediaType };

  const box = document.querySelector(
    '.shelf-note-box[data-tmdb-id="' + tmdbId + '"]'
    + '[data-media-type="' + mediaType + '"]'
  );
  if (!box) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'comment-backdrop';
  backdrop.addEventListener('click', () => collapseShelfNote());
  document.body.appendChild(backdrop);

  box.classList.add('shelf-note-expanded');
  applyViewportLayout(box);
  if (shelfNoteUnbindWidth) shelfNoteUnbindWidth();
  shelfNoteUnbindWidth = bindViewportWidthTracking(box);

  const m = shelfData && shelfData.movies.find(mm =>
    mm.tmdb_id === tmdbId && mm.media_type === mediaType);
  const existing = m ? (m.note || '') : '';

  box.innerHTML =
      '<strong>Note:</strong>'
    + '<textarea class="comment-edit shelf-note-edit">' + escapeHtml(existing) + '</textarea>'
    + '<button class="comment-done-btn">Done</button>';

  const ta = box.querySelector('.shelf-note-edit');
  ta.focus();
  /* place caret at end so editing existing text feels natural */
  ta.setSelectionRange(ta.value.length, ta.value.length);

  box.querySelector('.comment-done-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const newText = ta.value;
    const oldVal  = existing;
    if (newText.trim() !== oldVal.trim()) {
      await saveShelfNote(tmdbId, mediaType, newText);
    }
    collapseShelfNote();
  });

  const xBtn = document.createElement('button');
  xBtn.className = 'modal-close';
  xBtn.setAttribute('aria-label', 'Close');
  xBtn.textContent = '✕';
  xBtn.addEventListener('click', (e) => { e.stopPropagation(); collapseShelfNote(); });
  box.appendChild(xBtn);
}

function collapseShelfNote () {
  if (!expandedShelfNote) return;
  const box = document.querySelector('.shelf-note-expanded');
  if (box) {
    box.classList.remove('shelf-note-expanded');
    box.style.removeProperty('--modal-top');
    box.style.removeProperty('--modal-left');
    box.style.removeProperty('--modal-width');
  }
  const backdrop = document.querySelector('.comment-backdrop');
  if (backdrop) backdrop.remove();
  if (shelfNoteUnbindWidth) { shelfNoteUnbindWidth(); shelfNoteUnbindWidth = null; }
  expandedShelfNote = null;
  loadShelf();
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

/* Bulk RDY/NAW fan-out triggered by the "All" tab's RDY pip. The set of
   lists controlled = same set the All pip is derived from: every non-private
   list, plus the visitor's solo list when its tab is currently visible
   (solo exists AND has at least one movie). */
async function shelfToggleAllReady () {
  const v = shelfData.visitor;
  const listTabs = shelfData.lists.filter(l => !l.private);
  const solo = shelfData.lists.find(l => l.private && l.owner_visitor_id === v.id);
  const soloHasMovies = solo
    ? shelfData.movies.some(m => m.list_entries.some(le => le.list_id === solo.id))
    : false;
  const lists = soloHasMovies ? listTabs.concat([solo]) : listTabs;

  const everyRdy = lists.length > 0 && lists.every(l => l.ready);
  const newReady = !everyRdy;
  /* optimistic */
  const targetIds = new Set(lists.map(l => l.id));
  shelfData.lists.forEach(l => { if (targetIds.has(l.id)) l.ready = newReady; });
  renderShelfTabs();
  /* fire all PUTs in parallel */
  await Promise.all(lists.map(l =>
    fetch(API + '/list/' + l.id + '/ready', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitorId, ready: newReady })
    }).catch(() => null)
  ));
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

  /* Search — wire the existing TMDB search infrastructure once. */
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

  /* Color picker — the dedicated #color-picker <input type=color> lives
     in the DOM; the side-btn-color triggers it. (We reuse the existing
     handleColorChange flow.) */
  let colorPickerEl = document.getElementById('color-picker');
  if (!colorPickerEl) {
    colorPickerEl = document.createElement('input');
    colorPickerEl.type = 'color';
    colorPickerEl.id = 'color-picker';
    colorPickerEl.style.display = 'none';
    document.body.appendChild(colorPickerEl);
  }
  colorPickerEl.addEventListener('change', e => {
    /* In shelf mode `visitor` and `shelfData.visitor` are the same record.
       handleColorChange wants `visitor` set + the global state, which is. */
    handleColorChange(e.target.value);
    if (shelfData && shelfData.visitor) shelfData.visitor.color = e.target.value;
    renderShelf();
  });

  /* Help / Move / Color / Couch / All-RDY / search-row clicks. */
  document.addEventListener('click', e => {
    if (e.target.closest('.action-btn[data-action="howto"]')) {
      openHowToModal();
      return;
    }
    /* Color button → trigger native picker */
    if (e.target.closest('.action-btn.side-btn-color')) {
      const picker = document.getElementById('color-picker');
      if (visitor && picker) {
        picker.value = visitor.color || '#3366ff';
        picker.click();
      }
      return;
    }
    /* Couch button → navigate to active list's couchlist URL */
    const couchBtn = e.target.closest('.action-btn.side-btn-couch');
    if (couchBtn) {
      if (couchBtn.dataset.listLink) {
        window.location.href = '/?ListId=' + encodeURIComponent(couchBtn.dataset.listLink);
      }
      return;
    }

    /* "All" RDY pip — bulk fan-out RDY/NAW to every list-tab list. */
    const rdyAll = e.target.closest('.tab-ready-btn[data-shelf-rdy-all]');
    if (rdyAll) {
      e.stopPropagation();
      shelfToggleAllReady();
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

    /* Red ✕ count-badge on a shelf tab (solo or list) → confirm-and-delete
       the empty list. Numeric .tab-count without -empty is informational
       and falls through to the tab-switch handler below. */
    const shelfDeleteX = e.target.closest('.tab-count.tab-count-empty');
    if (shelfDeleteX && shelfDeleteX.dataset.action === 'delete-list') {
      e.stopPropagation();
      confirmDeleteList(shelfDeleteX.dataset.listId);
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

    /* "+" tab → couch mode on a brand new virtual list. Clearing the
       virtual placeholder names forces fresh Couch#NNN / CouchM8#NNN values
       on the destination so it actually feels new instead of recycling the
       previous virtual session. ?New=1 tells initApp to skip the
       last_list_id resolve so we land in virtual mode even though the
       visitor cookie already knows about other lists. */
    const plusTab = e.target.closest('.tab[data-shelf-tab="plus"]');
    if (plusTab) {
      e.stopPropagation();
      clearLocalStorage('wtw_virtual_user_name');
      clearLocalStorage('wtw_virtual_list_name');
      clearLocalStorage('wtw_virtual_user_color');
      window.location.href = '/?New=1';
      return;
    }

    /* Tab switch — clicking anywhere on a shelf tab (except buttons handled
       above) makes it active. Each tab keeps its own (session-only) checkbox
       selection — see shelfSelectedByTab. renderShelf() repaints the tab
       strip + entry list AND refreshes search-box placeholder / couch link. */
    const tab = e.target.closest('.tab[data-shelf-tab]');
    if (tab) {
      const newTab = tab.dataset.shelfTab;
      if (newTab !== activeTab) {
        activeTab = newTab;
        renderShelf();
      }
      return;
    }

    /* ALL/NONE — toggle all visible checkboxes. */
    if (e.target.closest('.action-btn[data-action="select-all"]')) {
      const visible = shelfVisibleKeys();
      const sel = shelfSelected();
      const allSelected = visible.length > 0 && visible.every(k => sel.has(k));
      if (allSelected) sel.clear();
      else             visible.forEach(k => sel.add(k));
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

    /* Movie popup show — clicking poster or title text only (not the
       whitespace next to the title). Dataset lives on parent .entry-title. */
    const popupHit = e.target.closest('.entry-poster, .entry-title-text');
    if (popupHit) {
      const src       = popupHit.classList.contains('entry-poster') ? popupHit : popupHit.closest('.entry-title');
      const tmdbId    = parseInt(src.dataset.tmdbId);
      const mediaType = src.dataset.mediaType || 'movie';
      if (tmdbId) showMoviePopup(tmdbId, mediaType);
      return;
    }

    /* Note box — open modal-style editor (parallel to comment expand). */
    const noteBox = e.target.closest('.shelf-note-box');
    if (noteBox && !noteBox.classList.contains('shelf-note-expanded') && !expandedShelfNote) {
      e.stopPropagation();
      expandShelfNote(parseInt(noteBox.dataset.tmdbId), noteBox.dataset.mediaType || 'movie');
      return;
    }
    /* clicks inside the expanded note shouldn't bubble to the popup-hide path */
    if (e.target.closest('.shelf-note-expanded')) return;

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
    const sel = shelfSelected();
    if (cb.checked) sel.add(k);
    else            sel.delete(k);
    refreshShelfSelectAllLabel();
  });

  /* Enter commits via blur for both the list-tab nickname input and the
     My Shelf tab username input (focusout listener below handles both). */
  document.addEventListener('keydown', async (e) => {
    if (!e.target || !e.target.classList) return;
    if ((e.target.classList.contains('shelf-list-name-input')
         || e.target.classList.contains('shelf-username-input'))
        && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();                                              /* triggers focusout commit */
    }
  });

  /* commit the list-nickname / username inputs when the user moves focus
     away. Both routes: bail if value unchanged or empty. */
  document.addEventListener('focusout', async (e) => {
    if (!e.target || !e.target.classList) return;

    if (e.target.classList.contains('shelf-list-name-input')) {
      const listId = e.target.dataset.listId;
      const newName = (e.target.value || '').trim();
      const lst = shelfData && shelfData.lists.find(l => l.id === listId);
      const oldName = lst ? (lst.list_name || '') : '';
      if (newName === oldName) return;                              /* no-op */
      await commitShelfListName(listId, newName);
      return;
    }

    if (e.target.classList.contains('shelf-username-input')) {
      const newName = (e.target.value || '').trim().slice(0, NAME_MAX_LEN);
      const oldName = (shelfData && shelfData.visitor && shelfData.visitor.name) || '';
      if (!newName || newName === oldName) {
        /* Revert displayed value if user blanked it — visitor must always have a name. */
        e.target.value = oldName;
        return;
      }
      await commitShelfUserName(newName);
      return;
    }
  });
}


/* ============================================================================
   SECTION 16b: SHELF MANAGE MODAL
   ============================================================================
   The shelf-mode "Move" button opens this modal. Three columns:

     - LEFT  — editable snapshot blob (#manage-blob). Lists every joined
               non-private list with its RDY snapshot, plus every selected
               movie. RDY is frozen at modal-open via shelfReadySnap.
     - MID   — action buttons aligned to the relevant blob lines:
               • Change User         — read "Your ID:" line, swap cookie,
                                       reload as that visitor.
               • Add Couchlists      — read "## Lists" lines, join any list
                                       you aren't on, set their nicknames.
               • Copy/Remove movies  — only render when there's a selection;
                                       operate on (selected entries) ×
                                       (checked dest-list checkboxes).
     - RIGHT — destination-list checkboxes (incl. the visitor's solo list,
               labeled "Solo (only you)"). Default unchecked.

   The user-tab X (the per-movie multi-list confirm) is rendered separately
   in openShelfMultiRemove() further down — same #copy-paste-modal slot,
   different markup.
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

  modal.querySelector('#manage-btn-user').addEventListener('click', shelfManageChangeUser);
  modal.querySelector('#manage-btn-lists').addEventListener('click', shelfManageAddCouchlists);
  const copyBtn   = modal.querySelector('#manage-btn-copy');
  const removeBtn = modal.querySelector('#manage-btn-remove');
  if (copyBtn)   copyBtn.addEventListener('click', shelfManageCopy);
  if (removeBtn) removeBtn.addEventListener('click', shelfManageRemove);

  refreshDestToggleLabel();
  alignManageButtons();
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
  const blob = buildShelfBlob();
  const hasMovies = shelfSelected().size > 0;

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

  /* Movie-action buttons only render when there's a selection — otherwise
     the middle column shows just Change User and Add Couchlists. */
  const movieBtns = hasMovies
    ? '<button id="manage-btn-copy"   class="manage-col-btn">Copy movies to selected lists</button>'
    + '<button id="manage-btn-remove" class="manage-col-btn">Remove movies from selected lists</button>'
    : '';

  return ''
    + '<div class="modal-content shelf-manage-modal">'
    +   '<button class="modal-close" aria-label="Close">✕</button>'
    +   '<h2 class="manage-title">Move</h2>'

    +   '<div class="manage-grid">'

    +     '<div class="manage-col manage-col-blob">'
    +       '<textarea id="manage-blob" spellcheck="false">' + escapeHtml(blob) + '</textarea>'
    +     '</div>'

    +     '<div class="manage-col manage-col-buttons">'
    +       '<button id="manage-btn-user"  class="manage-col-btn">Change User</button>'
    +       '<button id="manage-btn-lists" class="manage-col-btn">Add Couchlists</button>'
    +       movieBtns
    +     '</div>'

    +     '<div class="manage-col manage-col-dests">'
    +       '<div class="manage-section-header">'
    +         '<span class="manage-label">Lists</span>'
    +         '<button id="manage-dest-toggle" class="manage-mini-btn">All</button>'
    +       '</div>'
    +       '<div id="manage-dest-list">' + destsHtml + '</div>'
    +     '</div>'

    +   '</div>'

    + '</div>';
}

/* Position the middle-column buttons so each one sits next to the row in
   the textarea blob it acts on. Measures the textarea's font / padding,
   finds the line index of "Your ID:", "## Lists", "## Selected movies",
   and absolute-positions each button at that y. Skipped at narrow widths
   (where the layout falls back to stacked rows). */
function alignManageButtons () {
  const ta   = document.getElementById('manage-blob');
  const grid = document.querySelector('.manage-grid');
  if (!ta || !grid) return;
  /* Mobile fallback: when the grid stacks (single column), let buttons
     flow naturally — clear any leftover absolute positioning. */
  const stacked = window.getComputedStyle(grid).gridTemplateColumns
    .split(' ').filter(Boolean).length < 3;
  const ids = ['manage-btn-user', 'manage-btn-lists',
               'manage-btn-copy', 'manage-btn-remove'];
  if (stacked) {
    ids.forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.style.position = ''; b.style.top = ''; }
    });
    return;
  }

  const lines = ta.value.split('\n');
  const idxUser   = lines.findIndex(l => /^Your ID:/.test(l));
  const idxLists  = lines.findIndex(l => /^##\s+Lists\b/.test(l));
  const idxMovies = lines.findIndex(l => /^##\s+Selected movies\b/.test(l));

  const cs = window.getComputedStyle(ta);
  const padTop     = parseFloat(cs.paddingTop)  || 0;
  const lineHeight = parseFloat(cs.lineHeight)  || 17;
  const yOf = (i) => padTop + Math.max(0, i) * lineHeight;

  const place = (id, y) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.style.position = 'absolute';
    b.style.top = y + 'px';
    b.style.left  = '0';
    b.style.right = '0';
  };
  place('manage-btn-user',  yOf(idxUser   >= 0 ? idxUser   : 1));
  place('manage-btn-lists', yOf(idxLists  >= 0 ? idxLists  : 5));
  if (idxMovies >= 0) {
    place('manage-btn-copy',   yOf(idxMovies));
    place('manage-btn-remove', yOf(idxMovies) + 36);
  }
}

function buildShelfBlob () {
  const lines = [];
  const v = shelfData.visitor;
  const solo = shelfData.lists.find(l => l.private && l.owner_visitor_id === v.id);
  const soloId = solo ? solo.id : null;
  lines.push('# My Shelf snapshot');
  lines.push('Your ID:    ' + v.id + (v.name ? ' (' + v.name + ')' : ''));
  lines.push('Snapshot:   ' + new Date().toISOString().split('T')[0]);
  const activeLabel = activeTab === 'me'      ? '(your tab)'
                    : activeTab === soloId    ? '(solo)'
                    : activeTab;
  lines.push('Active tab: ' + activeLabel);
  lines.push('');

  /* Lists section — show joined non-solo lists; mark RDY snapshot.
     Solo (private) lists are intentionally omitted from the blob. */
  lines.push('## Lists');
  shelfData.lists.forEach(l => {
    if (l.private) return;
    const label = l.list_name && l.list_name.trim() ? l.list_name : '(no nickname)';
    const rdy = shelfReadySnap[l.id] ? 'Rdy' : 'Naw';
    lines.push('- ' + l.id + '  ' + label + '  [' + rdy + ']');
  });
  lines.push('');

  /* Selected movies — match selection at the time of open */
  lines.push('## Selected movies');
  const visible = shelfVisibleKeys();
  const sel = shelfSelected();
  visible.forEach(k => {
    if (!sel.has(k)) return;
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
      const label = listEntry.list_id === soloId ? '(solo)' : listEntry.list_id;
      lines.push('- on list: ' + label
        + (listEntry.added_here ? ' (you added)' : ''));
    } else {
      const onLists = movie.list_entries
        .filter(le => le.list_id !== soloId)
        .map(le => le.list_id).join(', ');
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
  btn.textContent = allChecked ? 'None' : 'All';
}

function getSelectedDestListIds () {
  return Array.from(document.querySelectorAll('.manage-dest-cb'))
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.listId);
}

/* Build the {tmdb_id, media_type, ...} item array for currently selected
   shelf entries. Each selected key resolves to one movie object in
   shelfData.movies. Used by both Copy and Remove. */
function getSelectedShelfMovies () {
  const out = [];
  const seen = new Set();
  shelfSelected().forEach(k => {
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
  const m = movies.length, l = dests.length;
  const c = data.copied || 0;
  const skippedArr = data.skipped || [];
  const soloSkips = skippedArr.filter(s => s.reason === 'already-on-another-list');
  const otherSkips = skippedArr.length - soloSkips.length;
  const mw = m === 1 ? 'movie' : 'movies';
  const lw = l === 1 ? 'list'  : 'lists';
  let msg = 'Copied ' + m + ' ' + mw + ' to ' + l + ' ' + lw + ': ' + c + ' added';
  if (otherSkips > 0) msg += ', ' + otherSkips + ' already there';
  msg += '.';
  if (soloSkips.length) {
    msg += '\n';
    soloSkips.forEach(sk => {
      const listLabel = (sk.other_list_name && sk.other_list_name.trim())
        ? sk.other_list_name : sk.other_list_id;
      msg += '\n"' + (sk.title || 'Movie')
        + '" not added to solo, you have already added it to "'
        + listLabel + '".';
    });
  }
  alert(msg);
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

/* Read the currently-edited blob from the textarea. Both Change User and
   Add Couchlists work off this — so the user can edit lines (e.g. paste
   in a different ID) before clicking. */
function getManageBlobText () {
  const ta = document.getElementById('manage-blob');
  return ta ? ta.value : '';
}

/* Pull the "## Lists" section out of a shelf snapshot blob.
   Returns [{ id, name }] — name may be empty for "(no nickname)". */
function parseShelfBlobLists (text) {
  const out = [];
  let inLists = false;
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^##\s+Lists\b/i.test(line))      { inLists = true;  continue; }
    if (/^##\s+/.test(line))              { inLists = false; continue; }
    if (!inLists || !line)                { continue; }
    /* "- {id}  {name}  [Rdy/Naw]" — name may contain spaces; [Rdy] is optional. */
    const m = line.match(/^-\s+([A-Za-z0-9]{1,12})\s+(.*?)\s*(?:\[[^\]]*\])?\s*$/);
    if (!m) continue;
    let name = m[2].trim();
    if (name === '(no nickname)') name = '';
    out.push({ id: m[1], name });
  }
  return out;
}

/* "Change User" — read the blob's "Your ID: XXXX (name)" line. If it's a
   different visitor, swap the cookie and reload. */
async function shelfManageChangeUser () {
  const text = getManageBlobText();
  const parsed = parseBlob(text);
  const newId = parsed && parsed.visitor_id;
  if (!newId || !/^[A-Za-z0-9]{10}$/.test(newId)) {
    alert("Couldn't find a 'Your ID:' line with a 10-char visitor ID.");
    return;
  }
  if (newId === visitorId) {
    alert('That is already the current user.');
    return;
  }
  visitorId = newId;
  setCookie('wtw_visitor', visitorId);
  window.location.reload();
}

/* "Add Couchlists" — read the blob's "## Lists" section. For each list
   the current visitor isn't already on, join it; if the blob supplies a
   nickname, set it. (Solo lists in the blob are skipped.) */
async function shelfManageAddCouchlists () {
  const text  = getManageBlobText();
  const lists = parseShelfBlobLists(text);
  if (lists.length === 0) {
    alert("Couldn't find a '## Lists' section in the text.");
    return;
  }
  const currentIds = new Set(shelfData.lists.map(l => l.id));
  const toAdd = lists.filter(l => !currentIds.has(l.id) && /^[A-Za-z0-9]{1,12}$/.test(l.id));
  if (toAdd.length === 0) {
    alert('No new lists to add — you are already on all of these.');
    return;
  }
  for (const l of toAdd) {
    await fetch(API + '/list/' + l.id + '/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: visitorId })
    });
    if (l.name) {
      await fetch(API + '/list/' + l.id + '/list-name', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor_id: visitorId, list_name: l.name.slice(0, 12) })
      });
    }
  }
  closeShelfManageModal();
  await loadShelf();
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
      + '<span>' + escapeHtml(label) + (isRdy ? ' <em>Rdy</em>' : '') + '</span>'
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
