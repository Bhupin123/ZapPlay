// ═══════════════════════════════════════════════════════
// ZapPlay — Professional Frontend
// ═══════════════════════════════════════════════════════

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL  = 'https://smeojiblxibcbkactmps.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtZW9qaWJseGliY2JrYWN0bXBzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0OTUxMzgsImV4cCI6MjA5NDA3MTEzOH0.KBNwPZNVVpl6eNA0hJG0hQl_alLp-FGS6LM0R4CQ1Jk';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

// ── SESSION ──
const Session = (() => {
  let _token = null, _refreshToken = null, _user = null, _refreshTimer = null;

  function scheduleRefresh(expiresAt) {
    clearTimeout(_refreshTimer);
    const ms = (expiresAt * 1000) - Date.now() - 60_000;
    if (ms > 0) _refreshTimer = setTimeout(refresh, ms);
  }

  async function refresh() {
    if (!_refreshToken) return;
    try {
      const res = await api('auth', 'refresh', { refresh_token: _refreshToken });
      _token = res.access_token;
      _refreshToken = res.refresh_token;
      scheduleRefresh(res.expires_at);
    } catch {
      Session.clear();
      UI.onSignedOut();
    }
  }

  return {
    set(data) {
      _token = data.access_token;
      _refreshToken = data.refresh_token;
      _user = data.user;
      scheduleRefresh(data.expires_at);
      sessionStorage.setItem('zp_rt', data.refresh_token);
    },
    get token()  { return _token; },
    get user()   { return _user; },
    get isAuth() { return !!_token; },
    setUser(u)   { _user = u; },
    clear() {
      _token = null; _refreshToken = null; _user = null;
      clearTimeout(_refreshTimer);
      sessionStorage.removeItem('zp_rt');
    },
    async restoreFromSession() {
      const rt = sessionStorage.getItem('zp_rt');
      if (!rt) return false;
      try {
        const res = await api('auth', 'refresh', { refresh_token: rt });
        _token = res.access_token;
        _refreshToken = res.refresh_token;
        scheduleRefresh(res.expires_at);
        const verified = await api('auth', 'verify');
        _user = verified.user;
        return true;
      } catch {
        sessionStorage.removeItem('zp_rt');
        return false;
      }
    },
  };
})();

// ── API CLIENT ──
async function api(endpoint, action, body = null, method = 'POST') {
  const url = `/api/${endpoint}${action ? `?action=${action}` : ''}`;
  const headers = { 'Content-Type': 'application/json' };
  if (Session.token) headers['Authorization'] = `Bearer ${Session.token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!data.ok) { const err = new Error(data.error || 'Request failed'); err.status = res.status; throw err; }
  return data.data;
}

const API = {
  auth:          (action, body)   => api('auth', action, body),
  games:         (params = {})    => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`/api/games?${qs}`, {
      headers: Session.token ? { Authorization: `Bearer ${Session.token}` } : {},
    }).then(r => r.json()).then(d => d.data);
  },
  addFav:        (game_id)        => api('favorites', null, { game_id }),
  removeFav:     (game_id)        => api('favorites', null, { game_id }, 'DELETE'),
  getFavs:       ()               => fetch('/api/favorites', { method: 'GET', headers: { Authorization: `Bearer ${Session.token}` } }).then(r => r.json()).then(d => d.data),
  rate:          (game_id, score) => api('ratings', null, { game_id, score }),
  trackPlay:     (game_id)        => api('play', null, { game_id }),
  getProfile:    ()               => fetch('/api/profile', { method: 'GET', headers: { Authorization: `Bearer ${Session.token}` } }).then(r => r.json()).then(d => d.data),
  updateProfile: (updates)        => api('profile', null, updates, 'PATCH'),
};

// ── REALTIME ──
const Realtime = {
  channels: {},
  subscribeToGame(gameId, onUpdate) {
    this.unsubscribeGame();
    const ch = sb.channel(`game:${gameId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, p => onUpdate(p.new))
      .subscribe();
    this.channels.game = ch;
  },
  subscribeToNewGames(onNewGame) {
    this.unsubscribeNewGames();
    const ch = sb.channel('new_games')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'games' }, p => onNewGame(p.new))
      .subscribe();
    this.channels.newGames = ch;
  },
  subscribeToPresence(gameId, onCountUpdate) {
    this.unsubscribePresence();
    const ch = sb.channel(`presence:${gameId}`, {
      config: { presence: { key: Session.user?.id || 'anon_' + Math.random() } },
    });
    ch.on('presence', { event: 'sync' }, () => {
      onCountUpdate(Object.keys(ch.presenceState()).length);
    }).subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await ch.track({ game_id: gameId, online_at: new Date().toISOString() });
    });
    this.channels.presence = ch;
  },
  unsubscribeGame()     { if (this.channels.game)     { sb.removeChannel(this.channels.game);     delete this.channels.game; } },
  unsubscribeNewGames() { if (this.channels.newGames) { sb.removeChannel(this.channels.newGames); delete this.channels.newGames; } },
  unsubscribePresence() { if (this.channels.presence) { sb.removeChannel(this.channels.presence); delete this.channels.presence; } },
  unsubscribeAll()      { Object.values(this.channels).forEach(ch => sb.removeChannel(ch)); this.channels = {}; },
};

// ── STATE ──
const State = {
  games: [], favIds: new Set(),
  recent: JSON.parse(sessionStorage.getItem('zp_recent') || '[]'),
  curGame: null, curView: 'home', loading: false,
  addRecent(id) {
    this.recent = [id, ...this.recent.filter(x => x !== id)].slice(0, 12);
    sessionStorage.setItem('zp_recent', JSON.stringify(this.recent));
  },
};

// ── UI HELPERS ──
const UI = {
  onSignedIn(user) {
    const username = user.username || user.email?.split('@')[0] || 'Player';
    const initials = username.slice(0, 2).toUpperCase();
    document.getElementById('navLoggedOut').style.display = 'none';
    document.getElementById('navLoggedIn').style.display  = 'flex';
    document.getElementById('navAvatar').textContent      = initials;
    document.getElementById('udName').textContent         = username;
    document.getElementById('udEmail').textContent        = user.email;
    document.getElementById('favCount').textContent       = State.favIds.size;
  },
  onSignedOut() {
    document.getElementById('navLoggedOut').style.display = 'flex';
    document.getElementById('navLoggedIn').style.display  = 'none';
    State.favIds.clear();
    document.getElementById('favCount').textContent = '0';
  },
  toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = msg;
    el.className = `toast show ${type === 'error' ? 'error-toast' : ''}`;
    clearTimeout(UI._tt);
    UI._tt = setTimeout(() => el.classList.remove('show'), 2800);
  },
  setLoading(on) {
    document.getElementById('loadingScreen').classList.toggle('hidden', !on);
  },
};

// ── INIT ──
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(localStorage.getItem('zp_t') || 'dark');
  buildSidebar();
  const restored = await Session.restoreFromSession();
  if (restored) { UI.onSignedIn(Session.user); await loadFavorites(); }
  await loadGames();
  Realtime.subscribeToNewGames(game => {
    State.games.unshift(game);
    buildHome();
    UI.toast(`New game added: ${game.title}!`);
  });
  UI.setLoading(false);
});

// ── LOAD GAMES ──
async function loadGames() {
  try {
    const { games } = await API.games({ limit: 200 });
    State.games = games || [];
    buildHome();
  } catch (e) {
    UI.toast('Failed to load games', 'error');
  }
}

async function loadFavorites() {
  if (!Session.isAuth) return;
  try {
    const { favorites } = await API.getFavs();
    State.favIds = new Set((favorites || []).map(f => f?.id).filter(Boolean));
    document.getElementById('favCount').textContent = State.favIds.size;
  } catch { }
}

// ── SIDEBAR ──
const CAT_ICONS = {
  "All":      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
  "Action":   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  "Puzzle":   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  "Racing":   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v9h-2"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></svg>`,
  "Shooting": `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/><circle cx="12" cy="12" r="2"/></svg>`,
  "Sports":   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`,
  "Adventure":`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`,
  "IO":       `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  "Casual":   `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 12h4m-2-2v4"/><circle cx="16" cy="11" r="1" fill="currentColor"/><circle cx="18" cy="13" r="1" fill="currentColor"/></svg>`,
  "Strategy": `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="8" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/><path d="M12 10v4M8 18H6a2 2 0 0 1-2-2v-2M16 18h2a2 2 0 0 0 2-2v-2"/></svg>`,
};
const CATS = ["All","Action","Puzzle","Racing","Shooting","Sports","Adventure","IO","Casual","Strategy"];

function buildSidebar() {
  const counts = {};
  State.games.forEach(g => counts[g.category] = (counts[g.category] || 0) + 1);
  document.getElementById('sbCats').innerHTML = CATS.map(c => {
    const n = c === 'All' ? State.games.length : (counts[c] || 0);
    return `<button class="citem ${c === 'All' ? 'on' : ''}" onclick="window.filterCat('${c}');setSA(this)">
      <span class="ci">${CAT_ICONS[c] || ''}</span>${c}<span class="cc">${n}</span></button>`;
  }).join('');
}
window.setSA = el => { document.querySelectorAll('.citem').forEach(b => b.classList.remove('on')); el.classList.add('on'); };

// ── HOME ──
function buildHome() {
  buildSidebar();
  renderGrid('g-trending', State.games.filter(g => g.is_hot).slice(0, 6));
  renderGrid('g-new',      State.games.filter(g => g.is_new).slice(0, 6));
  renderGrid('g-action',   State.games.filter(g => g.category === 'Action').slice(0, 6));
  renderGrid('g-puzzle',   State.games.filter(g => g.category === 'Puzzle').slice(0, 6));
  renderGrid('g-racing',   State.games.filter(g => g.category === 'Casual').slice(0, 6));
  buildRecent();
  buildHero();
}

function buildHero() {
  if (!State.games.length) return;
  // Pick a random hot game for the hero
  const hot = State.games.filter(g => g.is_hot);
  const featured = hot[Math.floor(Math.random() * hot.length)] || State.games[0];

  // Update stats
  const statEl = document.getElementById('statGames');
  if (statEl) statEl.textContent = State.games.length + '+';

  // Update hero card
  const heroImg = document.getElementById('heroImg');
  const heroTitle = document.getElementById('heroTitle');
  const heroMeta = document.getElementById('heroMeta');
  if (heroImg) heroImg.src = featured.thumbnail_url || `https://picsum.photos/seed/${featured.id}zp/590/370`;
  if (heroTitle) heroTitle.textContent = featured.title;
  if (heroMeta) heroMeta.textContent = `${featured.category} · ★ ${featured.rating || '—'}`;

  // Wire up play buttons
  const btn1 = document.getElementById('heroPlayBtn');
  const btn2 = document.getElementById('heroPlayBtn2');
  if (btn1) btn1.onclick = () => window.playGame(featured.id);
  if (btn2) btn2.onclick = () => window.playGame(featured.id);
}

function buildRecent() {
  const list = State.recent.map(id => State.games.find(g => g.id === id)).filter(Boolean);
  if (!list.length) { document.getElementById('sec-recent').style.display = 'none'; return; }
  document.getElementById('sec-recent').style.display = 'block';
  renderGrid('g-recent', list.slice(0, 6));
}

// ── CARD HTML ──
function fmtP(n) { return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : (n / 1000).toFixed(0) + 'K'; }

function cardHTML(g) {
  const isFav = State.favIds.has(g.id);
  const badge = g.is_hot
    ? `<span class="gbadge bhot"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c0 0-6 8-6 13a6 6 0 0 0 12 0c0-5-6-13-6-13z"/></svg> Hot</span>`
    : g.is_new ? `<span class="gbadge bnew">&#10022; New</span>` : '';

  return `<div class="gcard" data-id="${g.id}">
    <div class="gthumb">
      <img src="${g.thumbnail_url || `https://picsum.photos/seed/${g.id}zp/320/200`}" alt="${g.title}" loading="lazy"/>
      <div class="govr">
        <button class="gplaybtn" onclick="window.playGame(${g.id})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
      ${badge}
      <button class="gfav ${isFav ? 'on' : ''}" onclick="event.stopPropagation();window.toggleFav(${g.id},this)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
      </button>
    </div>
    <div class="gbody" onclick="window.playGame(${g.id})" style="cursor:pointer">
      <div class="gtitle">${g.title}</div>
      <div class="gfoot">
        <span class="gcat">${g.category}</span>
        <span class="grate">&#9733; ${g.rating || '—'}</span>
      </div>
      <div class="gplays">&#127918; ${fmtP(g.play_count || 0)} plays</div>
    </div>
  </div>`;
}

function renderGrid(id, list) {
  const el = document.getElementById(id); if (!el) return;
  el.innerHTML = list.length ? list.map(cardHTML).join('')
    : `<div class="empty" style="grid-column:1/-1"><div class="ei">&#9786;</div><p>No games found.</p></div>`;
}

// ── VIEW SWITCHING ──
function hideAll() {
  ['home','player','search','cat','fav','recent','profile'].forEach(v => {
    const el = document.getElementById('v-' + v);
    if (el) { el.style.display = 'none'; el.classList.remove('on'); }
  });
  Realtime.unsubscribeGame();
  Realtime.unsubscribePresence();
}

window.showView = n => {
  hideAll();
  const el = document.getElementById('v-' + n);
  el.style.display = 'block';
  if (n === 'player') el.classList.add('on');
  State.curView = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};
window.goHome = () => { showView('home'); buildHome(); document.getElementById('searchInput').value = ''; };

window.goFavs = async () => {
  if (!Session.isAuth) { openAuth('signin'); UI.toast('Sign in to view favorites'); return; }
  showView('fav');
  const favGames = State.games.filter(g => State.favIds.has(g.id));
  document.getElementById('favContent').innerHTML = favGames.length
    ? `<div class="gg">${favGames.map(cardHTML).join('')}</div>`
    : `<div class="empty"><div class="ei">&#9829;</div><p>No favorites yet.</p></div>`;
};

window.goRecent = () => {
  showView('recent');
  renderGrid('g-recent-full', State.recent.map(id => State.games.find(g => g.id === id)).filter(Boolean));
};

window.filterCat = async (cat) => {
  showView('cat');
  let list, title;
  if (cat === 'All')          { list = State.games;                              title = 'All Games'; }
  else if (cat === '__hot__') { list = State.games.filter(g => g.is_hot);        title = 'Trending Games'; }
  else if (cat === '__new__') { list = State.games.filter(g => g.is_new);        title = 'New Arrivals'; }
  else                        { list = State.games.filter(g => g.category === cat); title = cat + ' Games'; }
  document.getElementById('catTitle').textContent = title;
  document.getElementById('catCount').textContent = list.length + ' games';
  renderGrid('g-cat', list);
};

window.handleSearch = q => {
  q = q.trim();
  if (!q) { if (State.curView === 'search') goHome(); return; }
  showView('search');
  const res = State.games.filter(g =>
    g.title.toLowerCase().includes(q.toLowerCase()) ||
    g.category.toLowerCase().includes(q.toLowerCase()) ||
    (g.tags || []).some(t => t.toLowerCase().includes(q.toLowerCase()))
  );
  document.getElementById('srchInfo').textContent = `"${q}" — ${res.length} result${res.length !== 1 ? 's' : ''}`;
  renderGrid('g-search', res);
};

// ── PLAY GAME ──
window.playGame = async (gameId) => {
  const g = State.games.find(x => x.id === gameId);
  if (!g) return;

  State.curGame = g;
  State.addRecent(g.id);
  showView('player');

  API.trackPlay(g.id).catch(() => {});

  // ── IFRAME: no sandbox so games are fully interactive ──
  document.getElementById('playerFrame').innerHTML =
    `<iframe
      src="${g.game_url}"
      allowfullscreen
      allow="fullscreen"
      referrerpolicy="no-referrer-when-downgrade"
      style="width:100%;height:calc(100% + 56px);margin-top:-56px;border:none;display:block;pointer-events:all;"
    ></iframe>`;

  updatePFB();

  // ── PLAYER META ──
  document.getElementById('playerMeta').innerHTML = `
    <div class="ptitle">${g.title}</div>
    <div class="ptags">${(g.tags || []).map(t => `<span class="ptag"># ${t}</span>`).join('')}</div>
    <p class="pdesc">${g.description || ''}</p>
    <div class="pstats">
      <div class="pstat">
        <div class="pv" id="liveRating">&#9733; ${g.rating || '—'}</div>
        <div class="pk">Rating</div>
      </div>
      <div class="pstat">
        <div class="pv" id="livePlayCount">${fmtP(g.play_count || 0)}</div>
        <div class="pk">Plays</div>
      </div>
      <div class="pstat live">
        <div class="pv" id="liveOnline">1</div>
        <div class="pk">Playing Now</div>
      </div>
    </div>
    <div class="rlabel">&#9733; Rate this game</div>
    <div class="rstars">${[1,2,3,4,5].map(n =>
      `<span class="star ${n <= Math.round(g.rating || 0) ? 'on' : ''}" onclick="window.rateGame(${n})">&#9733;</span>`
    ).join('')}</div>`;

  // ── RELATED GAMES ──
  const rel = State.games
    .filter(x => x.id !== g.id && (x.category === g.category || (x.tags||[]).some(t => (g.tags||[]).includes(t))))
    .slice(0, 8);
  document.getElementById('relList').innerHTML = rel.map(r => `
    <div class="rcard" onclick="window.playGame(${r.id})">
      <div class="rthumb"><img src="${r.thumbnail_url || `https://picsum.photos/seed/${r.id}zp/132/83`}" alt="${r.title}" loading="lazy"/></div>
      <div><div class="rname">${r.title}</div><div class="rcat">${r.category} · &#9733; ${r.rating || '—'}</div></div>
    </div>`).join('');

  Realtime.subscribeToGame(g.id, updated => {
    const pc = document.getElementById('livePlayCount');
    const rt = document.getElementById('liveRating');
    if (pc) pc.textContent = fmtP(updated.play_count || 0);
    if (rt) rt.textContent = `&#9733; ${updated.rating || '—'}`;
    const idx = State.games.findIndex(x => x.id === g.id);
    if (idx >= 0) State.games[idx] = { ...State.games[idx], ...updated };
  });

  Realtime.subscribeToPresence(g.id, count => {
    const ol = document.getElementById('liveOnline');
    if (ol) ol.textContent = count;
  });
};

window.doFullscreen = () => {
  const f = document.querySelector('#playerFrame iframe');
  if (f) (f.requestFullscreen || f.webkitRequestFullscreen || f.mozRequestFullScreen || (() => {})).call(f);
};

window.rateGame = async (n) => {
  if (!Session.isAuth) { openAuth('signin'); UI.toast('Sign in to rate games'); return; }
  document.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('on', i < n));
  try {
    await API.rate(State.curGame.id, n);
    UI.toast(`Rated "${State.curGame.title}" ${n} star${n > 1 ? 's' : ''}!`);
  } catch (e) {
    UI.toast(e.message, 'error');
  }
};

// ── FAVORITES ──
window.toggleFav = async (id, btn) => {
  if (!Session.isAuth) { openAuth('signin'); UI.toast('Sign in to save favorites'); return; }
  try {
    if (State.favIds.has(id)) {
      State.favIds.delete(id);
      if (btn) btn.classList.remove('on');
      await API.removeFav(id);
      UI.toast('Removed from favorites');
    } else {
      State.favIds.add(id);
      if (btn) btn.classList.add('on');
      await API.addFav(id);
      UI.toast('Added to favorites! ♥');
    }
    document.getElementById('favCount').textContent = State.favIds.size;
  } catch (e) {
    UI.toast(e.message, 'error');
    if (State.favIds.has(id)) { State.favIds.delete(id); if (btn) btn.classList.remove('on'); }
    else { State.favIds.add(id); if (btn) btn.classList.add('on'); }
  }
};

window.favFromPlayer = () => {
  if (!State.curGame) return;
  toggleFav(State.curGame.id, null).then(() => updatePFB());
};

function updatePFB() {
  if (!State.curGame) return;
  const f = State.favIds.has(State.curGame.id);
  document.getElementById('favPBtn').innerHTML =
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg> ${f ? 'Unfavorite' : 'Favorite'}`;
}

// ── PROFILE ──
window.goProfile = async () => {
  if (!Session.isAuth) return openAuth('signin');
  showView('profile');
  try {
    const { profile } = await API.getProfile();
    const initials = (profile.username || 'ZP').slice(0, 2).toUpperCase();
    const joined   = new Date(profile.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    document.getElementById('profileContent').innerHTML = `
      <div class="profile-header">
        <div class="profile-avatar">${initials}</div>
        <div>
          <div class="profile-info">
            <div class="pname">${profile.username || 'Player'}</div>
            <div class="pemail">${profile.email}</div>
            <div class="pdate">Joined ${joined}</div>
          </div>
          <div class="profile-stats">
            <div class="pstat-box"><div class="psv">${profile.fav_count}</div><div class="psk">Favorites</div></div>
            <div class="pstat-box"><div class="psv">${profile.play_count}</div><div class="psk">Games Played</div></div>
          </div>
        </div>
      </div>
      <div class="section">
        <div class="shead"><div class="stitle">Favorite Games</div></div>
        <div class="gg">${State.games.filter(g => State.favIds.has(g.id)).map(cardHTML).join('') || '<div class="empty"><p>No favorites yet.</p></div>'}</div>
      </div>`;
  } catch (e) {
    UI.toast('Failed to load profile', 'error');
  }
};

// ── AUTH MODAL ──
window.openAuth = (tab = 'signin') => { document.getElementById('authModal').classList.add('open'); switchTab(tab); };
window.closeAuth = () => { document.getElementById('authModal').classList.remove('open'); resetAuthModal(); };
window.switchTab = tab => {
  document.getElementById('signinForm').style.display  = tab === 'signin' ? 'block' : 'none';
  document.getElementById('signupForm').style.display  = tab === 'signup' ? 'block' : 'none';
  document.getElementById('forgotForm').style.display  = 'none';
  document.getElementById('authSuccess').style.display = 'none';
  document.getElementById('authTabs').style.display    = 'flex';
  document.querySelectorAll('.auth-tab').forEach((t, i) =>
    t.classList.toggle('on', (tab === 'signin' && i === 0) || (tab === 'signup' && i === 1)));
  clearFormErrors();
};
window.showForgotPassword = () => {
  document.getElementById('signinForm').style.display = 'none';
  document.getElementById('authTabs').style.display   = 'none';
  document.getElementById('forgotForm').style.display = 'block';
};
function resetAuthModal() {
  switchTab('signin');
  clearFormErrors();
  ['siEmail','siPassword','suUsername','suEmail','suPassword','suConfirm','fpEmail']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}
function clearFormErrors() {
  document.querySelectorAll('.form-error').forEach(e => { e.style.display = 'none'; e.textContent = ''; });
  document.querySelectorAll('.form-input').forEach(i => i.classList.remove('error'));
}
function showFieldError(id, msg) {
  const err = document.getElementById(id + 'Err');
  if (err) { err.textContent = msg; err.style.display = 'block'; }
  const inp = document.getElementById(id);
  if (inp) inp.classList.add('error');
}

window.handleSignIn = async () => {
  clearFormErrors();
  const email    = document.getElementById('siEmail').value.trim();
  const password = document.getElementById('siPassword').value;
  if (!email)    return showFieldError('siEmail', 'Email is required');
  if (!password) return showFieldError('siPassword', 'Password is required');
  const btn = document.getElementById('signinBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…';
  try {
    const data = await API.auth('signin', { email, password });
    Session.set(data);
    UI.onSignedIn(data.user);
    await loadFavorites();
    closeAuth();
    UI.toast(`Welcome back, ${data.user.username || 'Player'}!`);
  } catch (e) {
    showFieldError('siPassword', e.message || 'Incorrect email or password');
  } finally {
    btn.disabled = false; btn.innerHTML = 'Sign In';
  }
};

window.handleSignUp = async () => {
  clearFormErrors();
  const username = document.getElementById('suUsername').value.trim();
  const email    = document.getElementById('suEmail').value.trim();
  const password = document.getElementById('suPassword').value;
  const confirm  = document.getElementById('suConfirm').value;
  let valid = true;
  if (!username || username.length < 3)  { showFieldError('suUsername', 'Min 3 characters'); valid = false; }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) { showFieldError('suUsername', 'Letters, numbers, underscores only'); valid = false; }
  if (!email)                             { showFieldError('suEmail', 'Email is required'); valid = false; }
  if (password.length < 8)               { showFieldError('suPassword', 'Min 8 characters'); valid = false; }
  if (password !== confirm)              { showFieldError('suConfirm', 'Passwords do not match'); valid = false; }
  if (!valid) return;
  const btn = document.getElementById('signupBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating account…';
  try {
    await API.auth('signup', { username, email, password });
    document.getElementById('authTabs').style.display    = 'none';
    document.getElementById('signupForm').style.display  = 'none';
    document.getElementById('authSuccess').style.display = 'block';
  } catch (e) {
    showFieldError('suEmail', e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = 'Create Account';
  }
};

window.handleForgotPassword = async () => {
  clearFormErrors();
  const email = document.getElementById('fpEmail').value.trim();
  if (!email) return showFieldError('fpEmail', 'Email is required');
  const btn = document.getElementById('fpBtn');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Sending…';
  try {
    await API.auth('forgot', { email });
  } finally {
    btn.disabled = false; btn.innerHTML = 'Send Reset Link';
    document.getElementById('forgotForm').style.display  = 'none';
    document.getElementById('authSuccess').style.display = 'block';
    document.getElementById('successTitle').textContent  = 'Email Sent!';
    document.getElementById('successMsg').textContent    = `If an account exists for ${email}, a reset link was sent.`;
  }
};

window.handleSignOut = async () => {
  window.toggleUserMenu();
  try { await API.auth('signout'); } catch {}
  Session.clear();
  UI.onSignedOut();
  goHome();
  UI.toast('Signed out successfully');
};

window.checkPwStrength = pw => {
  let score = 0;
  if (pw.length >= 8)           score++;
  if (pw.length >= 12)          score++;
  if (/[A-Z]/.test(pw))        score++;
  if (/[0-9]/.test(pw))        score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const colors = ['#ff4757','#ff6b35','#ffa502','#2ed573','#00d2d3'];
  const labels = ['Very weak','Weak','Fair','Strong','Very strong'];
  document.getElementById('pwFill').style.cssText = `width:${score/5*100}%;background:${colors[score-1]||'#ff4757'}`;
  document.getElementById('pwLabel').textContent  = score > 0 ? labels[score - 1] : 'Enter a password';
};

window.validateUsername = input => { input.value = input.value.replace(/[^a-zA-Z0-9_]/g, ''); };

window.toggleUserMenu = () => document.getElementById('userDropdown').classList.toggle('open');
document.addEventListener('click', e => {
  if (!e.target.closest('.nav-user-menu')) document.getElementById('userDropdown').classList.remove('open');
});
document.getElementById('authModal').addEventListener('click', e => {
  if (e.target === document.getElementById('authModal')) closeAuth();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAuth(); });

// ── THEME ──
const MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('themeIcon').innerHTML = t === 'light' ? SUN : MOON;
}
window.toggleTheme = () => {
  const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(n);
  localStorage.setItem('zp_t', n);
};
window.setNA = el => { document.querySelectorAll('.nl').forEach(a => a.classList.remove('on')); el.classList.add('on'); };