/**
 * panel.js — runs in ISOLATED world at document_idle.
 *
 * Responsibilities:
 *   1. Open / manage the IndexedDB database for chat messages.
 *   2. Listen for BRIDGE_EVENT custom events dispatched by hook.js (page context)
 *      and persist them.
 *   3. Inject and control the floating chat-history UI panel.
 */

(function () {
  'use strict';

  const BRIDGE_EVENT  = '__cpChatLog_message__';
  const PLAYER_EVENT  = '__cpChatLog_playerEvent__';
  const SERVER_EVENT  = '__cpChatLog_serverEvent__';
  const DB_NAME       = 'CPChatLog';
  const DB_VERSION    = 1;
  const STORE_NAME    = 'messages';
  const MAX_MESSAGES  = 10_000;
  const SESSION_ID    = Date.now().toString(36); // unique per page load

  // ─── IndexedDB ────────────────────────────────────────────────────────────

  let db = null;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains(STORE_NAME)) {
          const store = idb.createObjectStore(STORE_NAME, {
            keyPath:       'id',
            autoIncrement: true,
          });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('username',  'username',  { unique: false });
          store.createIndex('room',      'room',      { unique: false });
          store.createIndex('session',   'session',   { unique: false });
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  function dbPut(record) {
    if (!db) return;
    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.add(record);

    // Prune oldest messages when we exceed the cap
    store.count().onsuccess = (e) => {
      const count = e.target.result;
      if (count > MAX_MESSAGES) {
        const excess = count - MAX_MESSAGES;
        const idx    = store.index('timestamp');
        idx.openCursor().onsuccess = (ce) => {
          const cursor = ce.target.result;
          if (!cursor || excess <= 0) return;
          cursor.delete();
          cursor.continue();
        };
      }
    };
  }

  function dbGetAll(filter = {}) {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      const tx    = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req   = store.getAll();
      req.onsuccess = (e) => {
        let results = e.target.result;
        if (filter.search) {
          const q = filter.search.toLowerCase();
          results = results.filter(r =>
            r.message.toLowerCase().includes(q) ||
            r.username.toLowerCase().includes(q)
          );
        }
        if (filter.room) {
          results = results.filter(r => r.room === filter.room);
        }
        if (filter.session) {
          results = results.filter(r => r.session === filter.session);
        }
        resolve(results);
      };
      req.onerror = () => resolve([]);
    });
  }

  function dbClear() {
    return new Promise((resolve) => {
      if (!db) return resolve();
      const tx    = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear().onsuccess = resolve;
    });
  }

  function dbGetRooms() {
    return new Promise((resolve) => {
      if (!db) return resolve([]);
      const tx    = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const idx   = store.index('room');
      const rooms = new Set();
      idx.openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { rooms.add(cursor.key); cursor.continue(); }
        else resolve([...rooms].sort());
      };
    });
  }

  // ─── Deduplication ────────────────────────────────────────────────────────

  const recentHashes = new Set();
  function makeHash(msg) {
    return `${msg.username}|${msg.message}|${Math.floor(msg.timestamp / 1000)}`;
  }

  // ─── CSV Escape ──────────────────────────────────────────────────────────

  function csvEscape(val) {
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ─── Message ingestion ────────────────────────────────────────────────────

  function ingest(detail) {
    const hash = makeHash(detail);
    if (recentHashes.has(hash)) return;
    recentHashes.add(hash);
    setTimeout(() => recentHashes.delete(hash), 3000);

    const record = {
      timestamp:  detail.timestamp,
      username:   detail.username,
      message:    detail.message,
      room:       detail.room,
      eventName:  detail.eventName,
      direction:  detail.direction,
      session:    SESSION_ID,
      playerId:   detail.playerId || null,
      isIgnored:  detail.isIgnored || false,
      isFriend:   detail.isFriend || false,
    };

    dbPut(record);
    appendToPanel(record);
  }

  // ─── UI Panel ─────────────────────────────────────────────────────────────

  let panel, messageList, searchInput, roomFilter, badge, toggleBtn;
  let panelVisible = false;
  let allRooms = new Set();
  let activeTab = 'chat';

  // ── Regex search mode ──
  let regexMode = false;

  // ── Keyword alerts ──
  let alertKeywords = [];
  try {
    const stored = localStorage.getItem('__cpChatLog_alertKeywords__');
    if (stored) alertKeywords = JSON.parse(stored);
  } catch (_) {}

  // ── Ignore list ──
  const localIgnored = new Set();
  if (!window.__cpChatLog_ignored) window.__cpChatLog_ignored = new Set();
  if (!window.__cpChatLog_saveIgnored) {
    window.__cpChatLog_saveIgnored = () => {
      localStorage.setItem('__cpChatLog_ignored__',
        JSON.stringify([...window.__cpChatLog_ignored]));
    };
  }
  try {
    const storedIgnored = localStorage.getItem('__cpChatLog_ignored__');
    if (storedIgnored) {
      for (const u of JSON.parse(storedIgnored)) {
        window.__cpChatLog_ignored.add(u);
        localIgnored.add(u);
      }
    }
  } catch (_) {}

  // ── Friends list ──
  const localFriends = new Set();
  if (!window.__cpChatLog_friends) window.__cpChatLog_friends = new Set();
  if (!window.__cpChatLog_saveFriends) {
    window.__cpChatLog_saveFriends = () => {
      localStorage.setItem('__cpChatLog_friends__',
        JSON.stringify([...window.__cpChatLog_friends]));
    };
  }
  try {
    const storedFriends = localStorage.getItem('__cpChatLog_friends__');
    if (storedFriends) {
      for (const u of JSON.parse(storedFriends)) {
        window.__cpChatLog_friends.add(u);
        localFriends.add(u);
      }
    }
  } catch (_) {}

  // ── Bookmarks ──
  const bookmarks = new Set();
  try {
    const storedBookmarks = localStorage.getItem('__cpChatLog_bookmarks__');
    if (storedBookmarks) {
      for (const id of JSON.parse(storedBookmarks)) bookmarks.add(id);
    }
  } catch (_) {}

  function saveBookmarks() {
    localStorage.setItem('__cpChatLog_bookmarks__', JSON.stringify([...bookmarks]));
  }

  function createPanel() {
    // ── Toggle button (the "chat bubble" icon in CP style) ──
    toggleBtn = document.createElement('div');
    toggleBtn.id        = 'cpcl-toggle';
    toggleBtn.innerHTML = `
      <span class="cpcl-toggle-icon">💬</span>
      <span class="cpcl-badge" id="cpcl-badge">0</span>
    `;
    toggleBtn.title = 'CP Chat Log';
    toggleBtn.addEventListener('click', togglePanel);

    // ── Main panel ──
    panel = document.createElement('div');
    panel.id = 'cpcl-panel';
    panel.innerHTML = `
      <div class="cpcl-header">
        <span class="cpcl-title">\u{1F4CB} Chat Log</span>
        <div class="cpcl-header-controls">
          <button class="cpcl-btn cpcl-btn-sm" id="cpcl-keywords" title="Set alert keywords">\u{1F514} Alerts</button>
          <button class="cpcl-btn cpcl-btn-sm" id="cpcl-ignored-btn" title="Show ignored players">\u{1F441} 0 ignored</button>
          <button class="cpcl-btn cpcl-btn-sm" id="cpcl-export" title="Export chat log">\u2B07 Export</button>
          <button class="cpcl-btn cpcl-btn-sm cpcl-btn-danger" id="cpcl-clear" title="Clear all history">\u{1F5D1} Clear</button>
          <button class="cpcl-btn cpcl-btn-sm" id="cpcl-close" title="Close">\u2715</button>
        </div>
      </div>

      <div class="cpcl-filters">
        <input  type="text"   id="cpcl-search"    class="cpcl-input" placeholder="\u{1F50D} Search messages\u2026">
        <button class="cpcl-btn cpcl-btn-sm cpcl-regex-toggle" id="cpcl-regex-toggle" title="Toggle regex search">.*</button>
        <select id="cpcl-room-filter" class="cpcl-input cpcl-select">
          <option value="">All rooms</option>
        </select>
        <label class="cpcl-session-label">
          <input type="checkbox" id="cpcl-session-only"> This session only
        </label>
        <label class="cpcl-session-label">
          <input type="checkbox" id="cpcl-bookmarks-only"> Bookmarks only
        </label>
      </div>

      <div class="cpcl-tabs">
        <button class="cpcl-tab cpcl-tab-active" data-tab="chat">\u{1F4AC} Chat</button>
        <button class="cpcl-tab" data-tab="stats">\u{1F4CA} Stats</button>
        <button class="cpcl-tab" data-tab="players">\u{1F465} Players</button>
        <button class="cpcl-tab" data-tab="server">\u{1F310} Server (WIP)</button>
      </div>

      <div class="cpcl-message-list" id="cpcl-messages">
        <div class="cpcl-empty">No messages yet \u2014 chat in-game and they'll appear here!</div>
      </div>
      <div class="cpcl-stats-view" id="cpcl-stats" style="display:none"></div>
      <div class="cpcl-players-view" id="cpcl-players" style="display:none"></div>
      <div class="cpcl-server-view" id="cpcl-server" style="display:none"></div>

      <div class="cpcl-replay-bar" id="cpcl-replay-bar">
        <button class="cpcl-replay-ctrl" id="cpcl-replay-play">\u25B6</button>
        <input type="range" class="cpcl-replay-slider" id="cpcl-replay-slider" min="0" max="100" value="0">
        <span class="cpcl-replay-time" id="cpcl-replay-time">0:00</span>
        <select class="cpcl-input cpcl-replay-speed" id="cpcl-replay-speed">
          <option value="1">1x</option>
          <option value="2">2x</option>
          <option value="5" selected>5x</option>
          <option value="10">10x</option>
          <option value="50">50x</option>
        </select>
        <button class="cpcl-replay-ctrl" id="cpcl-replay-exit" title="Exit replay">\u2715</button>
      </div>

      <div class="cpcl-footer">
        <span id="cpcl-count">0 messages</span>
        <span class="cpcl-session-id">Session: ${SESSION_ID}</span>
        <button class="cpcl-btn cpcl-btn-sm cpcl-replay-btn" id="cpcl-replay" title="Replay session">\u25B6 Replay</button>
      </div>
    `;

    // ── Export modal ──
    const exportModal = document.createElement('div');
    exportModal.id = 'cpcl-export-modal';
    exportModal.className = 'cpcl-modal';
    exportModal.innerHTML = `
      <div class="cpcl-modal-content">
        <div class="cpcl-modal-title">${escHtml('Export Chat Log')}</div>

        <label class="cpcl-export-label">Format</label>
        <select id="cpcl-export-format" class="cpcl-input cpcl-select">
          <option value="txt">Plain Text (.txt)</option>
          <option value="json">JSON (.json)</option>
          <option value="csv">CSV (.csv)</option>
        </select>

        <label class="cpcl-export-label">Date Range</label>
        <div class="cpcl-export-dates">
          <input type="date" id="cpcl-export-from" class="cpcl-input">
          <span>to</span>
          <input type="date" id="cpcl-export-to" class="cpcl-input">
        </div>

        <label class="cpcl-export-label">Filter</label>
        <select id="cpcl-export-room" class="cpcl-input cpcl-select">
          <option value="">All rooms</option>
        </select>
        <input type="text" id="cpcl-export-player" class="cpcl-input" placeholder="Filter by player (optional)" style="margin-top:6px">

        <div class="cpcl-export-actions">
          <button class="cpcl-btn cpcl-btn-sm" id="cpcl-export-cancel">Cancel</button>
          <button class="cpcl-btn cpcl-export-go" id="cpcl-export-go">\u2B07 Export</button>
        </div>
      </div>
    `;
    panel.appendChild(exportModal);

    // ── Context menu ──
    const ctxMenu = document.createElement('div');
    ctxMenu.id = 'cpcl-context-menu';
    ctxMenu.innerHTML = `
      <div class="cpcl-ctx-item" data-action="ignore">Ignore this player</div>
      <div class="cpcl-ctx-item" data-action="unignore">Unignore this player</div>
      <div class="cpcl-ctx-item" data-action="add-friend">Add friend</div>
      <div class="cpcl-ctx-item" data-action="remove-friend">Remove friend</div>
    `;

    // ── Resize handles (top / right / corner) ──
    const resizeTop    = document.createElement('div');
    resizeTop.className = 'cpcl-resize-top';
    panel.appendChild(resizeTop);

    const resizeRight  = document.createElement('div');
    resizeRight.className = 'cpcl-resize-right';
    panel.appendChild(resizeRight);

    const resizeCorner = document.createElement('div');
    resizeCorner.className = 'cpcl-resize-corner';
    panel.appendChild(resizeCorner);

    function initResize(handle, axis) {
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = panel.offsetWidth;
        const startH = panel.offsetHeight;

        function onMove(ev) {
          if (axis === 'y' || axis === 'both') {
            const dy = startY - ev.clientY;
            panel.style.height = Math.max(300, Math.min(window.innerHeight * 0.9, startH + dy)) + 'px';
          }
          if (axis === 'x' || axis === 'both') {
            const dx = ev.clientX - startX;
            panel.style.width = Math.max(280, Math.min(window.innerWidth * 0.9, startW + dx)) + 'px';
          }
        }

        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }

    initResize(resizeTop, 'y');
    initResize(resizeRight, 'x');
    initResize(resizeCorner, 'both');

    document.body.appendChild(toggleBtn);
    document.body.appendChild(panel);
    document.body.appendChild(ctxMenu);

    badge       = document.getElementById('cpcl-badge');
    messageList = document.getElementById('cpcl-messages');
    searchInput = document.getElementById('cpcl-search');
    roomFilter  = document.getElementById('cpcl-room-filter');

    // Wire up controls
    document.getElementById('cpcl-close').addEventListener('click', togglePanel);
    document.getElementById('cpcl-clear').addEventListener('click', handleClear);
    document.getElementById('cpcl-export').addEventListener('click', handleExport);
    searchInput.addEventListener('input', handleFilter);
    roomFilter.addEventListener('change', handleFilter);
    document.getElementById('cpcl-session-only').addEventListener('change', handleFilter);
    document.getElementById('cpcl-bookmarks-only').addEventListener('change', handleFilter);

    // ── Regex toggle ──
    document.getElementById('cpcl-regex-toggle').addEventListener('click', () => {
      regexMode = !regexMode;
      document.getElementById('cpcl-regex-toggle').classList.toggle('active', regexMode);
      handleFilter();
    });

    // ── Keyword alerts button ──
    document.getElementById('cpcl-keywords').addEventListener('click', () => {
      const current = alertKeywords.join(', ');
      const input = prompt('Enter alert keywords (comma-separated):', current);
      if (input === null) return;
      alertKeywords = input.split(',').map(k => k.trim()).filter(Boolean);
      localStorage.setItem('__cpChatLog_alertKeywords__', JSON.stringify(alertKeywords));
    });

    // ── Ignored players button ──
    document.getElementById('cpcl-ignored-btn').addEventListener('click', handleIgnoredList);
    updateIgnoredCount();

    // ── Export modal controls ──
    document.getElementById('cpcl-export-cancel').addEventListener('click', closeExportModal);
    document.getElementById('cpcl-export-go').addEventListener('click', performExport);
    exportModal.addEventListener('click', (e) => {
      if (e.target === exportModal) closeExportModal();
    });

    // ── Tab switching ──
    panel.querySelectorAll('.cpcl-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => switchTab(tabBtn.dataset.tab));
    });

    // ── Replay controls ──
    document.getElementById('cpcl-replay').addEventListener('click', enterReplay);
    document.getElementById('cpcl-replay-play').addEventListener('click', toggleReplayPlayback);
    document.getElementById('cpcl-replay-exit').addEventListener('click', exitReplay);
    document.getElementById('cpcl-replay-speed').addEventListener('change', handleReplaySpeedChange);

    const slider = document.getElementById('cpcl-replay-slider');
    slider.addEventListener('input', handleSliderScrub);
    slider.addEventListener('mousedown', handleSliderGrab);
    slider.addEventListener('mouseup', handleSliderRelease);
    slider.addEventListener('touchstart', handleSliderGrab);
    slider.addEventListener('touchend', handleSliderRelease);

    // ── Context menu handling ──
    document.addEventListener('click', () => {
      ctxMenu.style.display = 'none';
    });

    ctxMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.cpcl-ctx-item');
      if (!item) return;
      const action   = item.dataset.action;
      const username = ctxMenu.dataset.username;
      if (!username) return;

      if (action === 'ignore') {
        localIgnored.add(username);
        window.__cpChatLog_ignored.add(username);
        window.__cpChatLog_saveIgnored();
        messageList.querySelectorAll('.cpcl-msg').forEach(el => {
          if (el.dataset.username === username) el.classList.add('cpcl-msg-ignored');
        });
        updateIgnoredCount();
      } else if (action === 'unignore') {
        localIgnored.delete(username);
        window.__cpChatLog_ignored.delete(username);
        window.__cpChatLog_saveIgnored();
        messageList.querySelectorAll('.cpcl-msg').forEach(el => {
          if (el.dataset.username === username) el.classList.remove('cpcl-msg-ignored');
        });
        updateIgnoredCount();
      } else if (action === 'add-friend') {
        localFriends.add(username);
        window.__cpChatLog_friends.add(username);
        window.__cpChatLog_saveFriends();
        messageList.querySelectorAll('.cpcl-msg').forEach(el => {
          if (el.dataset.username === username) el.classList.add('cpcl-msg-friend');
        });
      } else if (action === 'remove-friend') {
        localFriends.delete(username);
        window.__cpChatLog_friends.delete(username);
        window.__cpChatLog_saveFriends();
        messageList.querySelectorAll('.cpcl-msg').forEach(el => {
          if (el.dataset.username === username) el.classList.remove('cpcl-msg-friend');
        });
      }

      ctxMenu.style.display = 'none';
    });

    // ── Right-click on username ──
    messageList.addEventListener('contextmenu', (e) => {
      const userEl = e.target.closest('.cpcl-msg-user');
      if (!userEl) return;
      e.preventDefault();

      const msgEl    = userEl.closest('.cpcl-msg');
      const username = msgEl ? msgEl.dataset.username : '';
      if (!username) return;

      ctxMenu.dataset.username = username;

      const isIgnored = localIgnored.has(username) || window.__cpChatLog_ignored.has(username);
      ctxMenu.querySelector('[data-action="ignore"]').style.display   = isIgnored ? 'none' : '';
      ctxMenu.querySelector('[data-action="unignore"]').style.display = isIgnored ? '' : 'none';

      const isFriend = localFriends.has(username) || window.__cpChatLog_friends.has(username);
      ctxMenu.querySelector('[data-action="add-friend"]').style.display    = isFriend ? 'none' : '';
      ctxMenu.querySelector('[data-action="remove-friend"]').style.display = isFriend ? '' : 'none';

      ctxMenu.style.display = 'block';
      ctxMenu.style.left    = e.clientX + 'px';
      ctxMenu.style.top     = e.clientY + 'px';
    });
  }

  // ─── Tab switching ──────────────────────────────────────────────────────────

  function switchTab(tab) {
    activeTab = tab;

    panel.querySelectorAll('.cpcl-tab').forEach(btn => {
      btn.classList.toggle('cpcl-tab-active', btn.dataset.tab === tab);
    });

    messageList.style.display = tab === 'chat' ? '' : 'none';
    document.getElementById('cpcl-stats').style.display = tab === 'stats' ? '' : 'none';
    document.getElementById('cpcl-players').style.display = tab === 'players' ? '' : 'none';
    document.getElementById('cpcl-server').style.display = tab === 'server' ? '' : 'none';

    if (tab === 'stats') populateStats();
    if (tab === 'players') populatePlayers();
    if (tab === 'server') populateServer();
  }

  // ─── Stats View ───────────────────────────────────────────────────────────

  async function populateStats() {
    const statsEl = document.getElementById('cpcl-stats');
    statsEl.innerHTML = '<div class="cpcl-empty">Loading...</div>';

    const records = await dbGetAll();

    if (records.length === 0) {
      statsEl.innerHTML = '<div class="cpcl-empty">No messages recorded yet.</div>';
      return;
    }

    const totalMessages = records.length;
    const uniquePlayers = new Set(records.map(r => r.username));
    const uniqueRooms   = new Set(records.map(r => r.room));

    const todayStr = new Date().toDateString();
    const messagesToday = records.filter(r => new Date(r.timestamp).toDateString() === todayStr).length;

    // Most active room
    const roomCounts = {};
    records.forEach(r => { roomCounts[r.room] = (roomCounts[r.room] || 0) + 1; });
    const mostActiveRoom = Object.entries(roomCounts).sort((a, b) => b[1] - a[1])[0];

    // Most active player
    const playerCounts = {};
    records.forEach(r => { playerCounts[r.username] = (playerCounts[r.username] || 0) + 1; });
    const mostActivePlayer = Object.entries(playerCounts).sort((a, b) => b[1] - a[1])[0];

    // Busiest hour
    const hourCounts = new Array(24).fill(0);
    records.forEach(r => { hourCounts[new Date(r.timestamp).getHours()]++; });
    const busiestHour = hourCounts.indexOf(Math.max(...hourCounts));
    const busiestHourStr = new Date(0, 0, 0, busiestHour).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // Last 7 days chart
    const dayCounts = {};
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString([], { weekday: 'short' });
      const dateStr = d.toDateString();
      dayCounts[key] = 0;
      records.forEach(r => {
        if (new Date(r.timestamp).toDateString() === dateStr) {
          dayCounts[key]++;
        }
      });
    }
    const maxDayCount = Math.max(...Object.values(dayCounts), 1);

    let chartHtml = '';
    for (const [label, count] of Object.entries(dayCounts)) {
      const pct = Math.round((count / maxDayCount) * 100);
      chartHtml += `
        <div class="cpcl-stat-bar-row">
          <span class="cpcl-stat-bar-label">${escHtml(label)}</span>
          <div class="cpcl-stat-bar-track">
            <div class="cpcl-stat-bar-fill" style="width:${pct}%"></div>
          </div>
          <span class="cpcl-stat-bar-count">${count}</span>
        </div>`;
    }

    statsEl.innerHTML = `
      <div class="cpcl-stat-grid">
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${totalMessages.toLocaleString()}</div>
          <div class="cpcl-stat-label">Total Messages</div>
        </div>
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${uniquePlayers.size.toLocaleString()}</div>
          <div class="cpcl-stat-label">Unique Players</div>
        </div>
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${uniqueRooms.size.toLocaleString()}</div>
          <div class="cpcl-stat-label">Unique Rooms</div>
        </div>
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${messagesToday.toLocaleString()}</div>
          <div class="cpcl-stat-label">Messages Today</div>
        </div>
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${escHtml(mostActiveRoom ? mostActiveRoom[0] : 'N/A')}</div>
          <div class="cpcl-stat-label">Most Active Room</div>
        </div>
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${escHtml(mostActivePlayer ? mostActivePlayer[0] : 'N/A')}</div>
          <div class="cpcl-stat-label">Most Active Player</div>
        </div>
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${escHtml(busiestHourStr)}</div>
          <div class="cpcl-stat-label">Busiest Hour</div>
        </div>
        <div class="cpcl-stat-card">
          <div class="cpcl-stat-value">${(totalMessages / Math.max(Object.keys(dayCounts).length, 1)).toFixed(0)}</div>
          <div class="cpcl-stat-label">Avg / Day (7d)</div>
        </div>
      </div>
      <div class="cpcl-stat-section">
        <div class="cpcl-stat-heading">Last 7 Days</div>
        <div class="cpcl-stat-chart">${chartHtml}</div>
      </div>`;
  }

  // ─── Players View ─────────────────────────────────────────────────────────

  function populatePlayers() {
    const playersEl = document.getElementById('cpcl-players');
    const registry = window.__cpChatLog_playerRegistry;
    const friends  = window.__cpChatLog_friends;

    if (!registry || registry.size === 0) {
      playersEl.innerHTML = '<div class="cpcl-empty">No players detected yet. Join a room in-game!</div>';
      return;
    }

    const players = [];
    registry.forEach((info, id) => {
      players.push({ id, ...info });
    });
    players.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

    const frag = document.createDocumentFragment();
    for (const p of players) {
      const isFriend = friends && friends.has(p.username);
      const card = document.createElement('div');
      card.className = 'cpcl-player-card';

      const lastRoom = p.roomsVisited && p.roomsVisited.size
        ? [...p.roomsVisited].pop()
        : '(unknown)';
      const msgCount = p.messageCount || 0;
      const lastSeenStr = p.lastSeen ? relativeTime(p.lastSeen) : 'unknown';

      const pNameStyle = isFriend ? '' : ` style="color:${usernameColor(p.username)}"`;

      card.innerHTML = `
        <div class="cpcl-player-info">
          <span class="cpcl-player-name${isFriend ? ' cpcl-is-friend' : ''}"${pNameStyle}>${escHtml(p.username)}</span>
          <span class="cpcl-player-meta">${msgCount} message${msgCount !== 1 ? 's' : ''} \u00B7 ${escHtml(lastRoom)} \u00B7 ${escHtml(lastSeenStr)}</span>
        </div>
        <button class="cpcl-player-friend${isFriend ? ' cpcl-is-friend' : ''}" title="Toggle friend">${isFriend ? '\u2605' : '\u2606'}</button>
      `;

      const friendBtn = card.querySelector('.cpcl-player-friend');
      friendBtn.addEventListener('click', () => {
        if (!friends) return;
        if (friends.has(p.username)) {
          friends.delete(p.username);
        } else {
          friends.add(p.username);
        }
        if (typeof window.__cpChatLog_saveFriends === 'function') {
          window.__cpChatLog_saveFriends();
        }
        populatePlayers();
      });

      frag.appendChild(card);
    }

    playersEl.innerHTML = '';
    playersEl.appendChild(frag);
  }

  // ─── Server View ──────────────────────────────────────────────────────────
  // State is received via SERVER_EVENT (serialised from MAIN world).

  let cachedServerState = null;

  function populateServer() {
    const serverEl = document.getElementById('cpcl-server');
    const state    = cachedServerState;
    const buddies  = state ? state.buddies : [];
    const worlds   = state ? state.worlds : [];
    const queue    = state ? state.queue : null;
    const actionCounts = state ? state.actionCounts : {};
    const totalActions = state ? state.totalActions : 0;

    let html = '';

    // ── Queue card (only when active) ──
    if (queue && queue.active) {
      html += `
        <div class="cpcl-section-heading">Queue</div>
        <div class="cpcl-queue-card">
          <div class="cpcl-queue-position">${escHtml(String(queue.position))}</div>
          <div class="cpcl-queue-detail">Position ${escHtml(String(queue.position))} of ${escHtml(String(queue.total))}${queue.worldName ? ' \u2014 ' + escHtml(queue.worldName) : ''}</div>
        </div>`;
    }

    // ── Buddies ──
    if (buddies.length > 0) {
      const sorted = [...buddies].sort((a, b) => {
        if (a.online && !b.online) return -1;
        if (!a.online && b.online) return 1;
        return (a.username || '').localeCompare(b.username || '');
      });

      const onlineCount = sorted.filter(b => b.online).length;
      html += `<div class="cpcl-section-heading">Buddies (${onlineCount} online / ${sorted.length} total)</div>`;

      for (const b of sorted) {
        const dotClass = b.online ? 'cpcl-buddy-dot-online' : 'cpcl-buddy-dot-offline';
        const meta = b.online
          ? [b.world, b.room].filter(Boolean).join(' \u2014 ') || 'online'
          : 'offline';
        html += `
          <div class="cpcl-buddy-card">
            <span class="cpcl-buddy-dot ${dotClass}"></span>
            <div class="cpcl-buddy-info">
              <span class="cpcl-buddy-name">${escHtml(b.username)}</span>
              <span class="cpcl-buddy-meta">${escHtml(meta)}</span>
            </div>
          </div>`;
      }
    }

    // ── Worlds ──
    if (worlds.length > 0) {
      const sorted = [...worlds].sort((a, b) => (b.population || 0) - (a.population || 0));
      html += `<div class="cpcl-section-heading">Worlds (${sorted.length})</div>`;

      for (const w of sorted) {
        const pop = w.population || 0;
        const max = w.max || 300;
        const pct = Math.min(100, Math.round((pop / max) * 100));
        const barClass = pct >= 80 ? 'cpcl-world-bar-red' : pct >= 50 ? 'cpcl-world-bar-yellow' : 'cpcl-world-bar-green';
        html += `
          <div class="cpcl-world-card">
            <div class="cpcl-world-header">
              <span class="cpcl-world-name">${escHtml(w.name)}</span>
              <span class="cpcl-world-pop">${pop} / ${max}</span>
            </div>
            <div class="cpcl-world-bar-track">
              <div class="cpcl-world-bar-fill ${barClass}" style="width:${pct}%"></div>
            </div>
          </div>`;
      }
    }

    // ── Protocol Inspector (collapsed by default) ──
    const buddyPat = /^(get_)?budd(y|ies)|^friend|^buddy_(on|off)line|^buddy_(find|list|remove|request|accept)/i;
    const worldPat = /^(get_)?world|^server_list|^world_(list|population)|^get_servers/i;
    const queuePat = /^queue|^join_queue|^queue_(update|position|status)/i;

    const actionNames = Object.entries(actionCounts).sort((a, b) => b[1] - a[1]);

    html += `
      <div class="cpcl-inspector-toggle" id="cpcl-inspector-toggle">
        <span class="cpcl-inspector-arrow">\u25B6</span> Protocol Inspector (${actionNames.length} actions, ${totalActions} total)
      </div>
      <div class="cpcl-inspector-body" id="cpcl-inspector-body" style="display:none">`;

    if (actionNames.length === 0) {
      html += '<div class="cpcl-empty">No protocol actions seen yet. Join a game!</div>';
    } else {
      for (const [name, count] of actionNames) {
        let tag = '';
        if (buddyPat.test(name)) tag = '<span class="cpcl-inspector-tag cpcl-inspector-tag-buddy">BUDDY</span>';
        else if (worldPat.test(name)) tag = '<span class="cpcl-inspector-tag cpcl-inspector-tag-world">WORLD</span>';
        else if (queuePat.test(name)) tag = '<span class="cpcl-inspector-tag cpcl-inspector-tag-queue">QUEUE</span>';

        html += `
          <div class="cpcl-inspector-row">
            <span class="cpcl-inspector-name">${escHtml(name)}</span>
            ${tag}
            <span class="cpcl-inspector-count">\u00D7${count}</span>
          </div>`;
      }
    }

    html += '</div>';

    // ── Empty state ──
    if (buddies.length === 0 && worlds.length === 0 && !(queue && queue.active)) {
      html = '<div class="cpcl-empty">No server data yet \u2014 log in and play to see buddies, worlds & queue info.</div>' + html;
    }

    serverEl.innerHTML = html;

    // Wire up inspector toggle
    const toggleEl = document.getElementById('cpcl-inspector-toggle');
    const bodyEl   = document.getElementById('cpcl-inspector-body');
    if (toggleEl && bodyEl) {
      toggleEl.addEventListener('click', () => {
        const open = bodyEl.style.display !== 'none';
        bodyEl.style.display = open ? 'none' : '';
        toggleEl.querySelector('.cpcl-inspector-arrow').textContent = open ? '\u25B6' : '\u25BC';
      });
    }
  }

  // ─── Panel toggle ─────────────────────────────────────────────────────────

  function togglePanel() {
    panelVisible = !panelVisible;
    panel.classList.toggle('cpcl-panel-visible', panelVisible);
    if (panelVisible) {
      unreadCount = 0;
      updateBadge();
      loadHistory();
    } else if (replayActive) {
      exitReplay();
    }
  }

  let unreadCount = 0;
  function updateBadge() {
    badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
    badge.style.display = unreadCount > 0 ? 'flex' : 'none';
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function relativeTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function renderMessage(record) {
    const isToday = new Date(record.timestamp).toDateString() === new Date().toDateString();
    const el = document.createElement('div');

    let classes = `cpcl-msg ${record.direction === 'out' ? 'cpcl-msg-out' : 'cpcl-msg-in'}`;

    const isIgnored = record.isIgnored || localIgnored.has(record.username) || window.__cpChatLog_ignored.has(record.username);
    if (isIgnored) classes += ' cpcl-msg-ignored';

    const isFriend = record.isFriend || localFriends.has(record.username) || window.__cpChatLog_friends.has(record.username);
    if (isFriend) classes += ' cpcl-msg-friend';

    const msgId = record.id != null ? String(record.id) : null;
    if (msgId && bookmarks.has(msgId)) classes += ' cpcl-msg-bookmarked';

    el.className    = classes;
    el.dataset.username = record.username;
    el.dataset.room     = record.room;
    el.dataset.session  = record.session;
    if (msgId) el.dataset.id = msgId;

    const starChar = (msgId && bookmarks.has(msgId)) ? '\u2605' : '\u2606';

    const nameStyle = isFriend ? '' : ` style="color:${usernameColor(record.username)}"`;

    el.innerHTML = `
      <span class="cpcl-msg-star" title="Bookmark">${starChar}</span>
      <div class="cpcl-msg-meta">
        <span class="cpcl-msg-user"${nameStyle}>${escHtml(record.username)}</span>
        <span class="cpcl-msg-room">${escHtml(record.room)}</span>
        <span class="cpcl-msg-time" title="${new Date(record.timestamp).toLocaleString()}">
          ${isToday ? formatTime(record.timestamp) : formatDate(record.timestamp)}
        </span>
      </div>
      <div class="cpcl-msg-text">${escHtml(record.message)}</div>
    `;

    const starEl = el.querySelector('.cpcl-msg-star');
    starEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.dataset.id;
      if (!id) return;
      if (bookmarks.has(id)) {
        bookmarks.delete(id);
        starEl.textContent = '\u2606';
        el.classList.remove('cpcl-msg-bookmarked');
      } else {
        bookmarks.add(id);
        starEl.textContent = '\u2605';
        el.classList.add('cpcl-msg-bookmarked');
      }
      saveBookmarks();
    });

    return el;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Deterministic username → color via hash ──
  function usernameColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    const hue = ((hash % 360) + 360) % 360;
    return `hsl(${hue}, 70%, 72%)`;
  }

  // ── Search matching (plain text vs regex) ──
  function matchesSearch(search, username, message) {
    if (regexMode) {
      try {
        const re = new RegExp(search, 'i');
        return re.test(username) || re.test(message);
      } catch (_) {
        const q = search.toLowerCase();
        return username.toLowerCase().includes(q) || message.toLowerCase().includes(q);
      }
    } else {
      const q = search.toLowerCase();
      return username.toLowerCase().includes(q) || message.toLowerCase().includes(q);
    }
  }

  // ── Keyword match ──
  function matchesKeyword(record) {
    if (alertKeywords.length === 0) return false;
    const text = (record.username + ' ' + record.message).toLowerCase();
    return alertKeywords.some(kw => text.includes(kw.toLowerCase()));
  }

  // ── Ignored count updater ──
  function updateIgnoredCount() {
    const btn = document.getElementById('cpcl-ignored-btn');
    if (!btn) return;
    const count = window.__cpChatLog_ignored ? window.__cpChatLog_ignored.size : localIgnored.size;
    btn.textContent = '\uD83D\uDC41 ' + count + ' ignored';
  }

  // ── Ignored list popup ──
  function handleIgnoredList() {
    const ignored = [...(window.__cpChatLog_ignored || localIgnored)];
    if (ignored.length === 0) {
      alert('No ignored players.');
      return;
    }
    const choice = prompt(
      'Ignored players (type a name to unignore, or cancel):\n\n' +
      ignored.map((u, i) => (i + 1) + '. ' + u).join('\n')
    );
    if (!choice) return;
    const name = choice.trim();
    if (localIgnored.has(name) || (window.__cpChatLog_ignored && window.__cpChatLog_ignored.has(name))) {
      localIgnored.delete(name);
      if (window.__cpChatLog_ignored) window.__cpChatLog_ignored.delete(name);
      window.__cpChatLog_saveIgnored();
      messageList.querySelectorAll('.cpcl-msg').forEach(el => {
        if (el.dataset.username === name) el.classList.remove('cpcl-msg-ignored');
      });
      updateIgnoredCount();
    } else {
      alert('Player "' + name + '" is not in the ignore list.');
    }
  }

  function appendToPanel(record) {
    // Update room filter
    if (!allRooms.has(record.room)) {
      allRooms.add(record.room);
      const opt = document.createElement('option');
      opt.value       = record.room;
      opt.textContent = record.room;
      roomFilter.appendChild(opt);
    }

    // If panel isn't visible, just update badge
    if (!panelVisible) {
      unreadCount++;
      updateBadge();
      if (matchesKeyword(record)) {
        toggleBtn.classList.add('cpcl-alert-flash');
        setTimeout(() => toggleBtn.classList.remove('cpcl-alert-flash'), 1200);
      }
      return;
    }

    // During replay, capture in background but don't render
    if (replayActive) return;

    // Check if it passes current filter
    const search      = searchInput.value;
    const roomVal     = roomFilter.value;
    const sessionOnly = document.getElementById('cpcl-session-only').checked;
    const bookmarksOnly = document.getElementById('cpcl-bookmarks-only').checked;

    if (search) {
      if (!matchesSearch(search, record.username, record.message)) return;
    }
    if (roomVal && record.room !== roomVal) return;
    if (sessionOnly && record.session !== SESSION_ID) return;
    if (bookmarksOnly) {
      const msgId = record.id != null ? String(record.id) : null;
      if (!msgId || !bookmarks.has(msgId)) return;
    }

    const empty = messageList.querySelector('.cpcl-empty');
    if (empty) empty.remove();

    const el = renderMessage(record);

    if (matchesKeyword(record)) {
      el.classList.add('cpcl-msg-alert');
      toggleBtn.classList.add('cpcl-alert-flash');
      setTimeout(() => toggleBtn.classList.remove('cpcl-alert-flash'), 1200);
    }

    messageList.appendChild(el);
    messageList.scrollTop = messageList.scrollHeight;
    updateCount();
  }

  async function loadHistory() {
    const search        = searchInput.value;
    const roomVal       = roomFilter.value;
    const sessionOnly   = document.getElementById('cpcl-session-only').checked;
    const bookmarksOnly = document.getElementById('cpcl-bookmarks-only').checked;

    const filter = {};
    if (search && !regexMode) filter.search = search;
    if (roomVal)              filter.room    = roomVal;
    if (sessionOnly)          filter.session = SESSION_ID;

    let records = await dbGetAll(filter);

    // Apply regex filter if in regex mode
    if (search && regexMode) {
      records = records.filter(r => matchesSearch(search, r.username, r.message));
    }

    // Apply bookmarks filter
    if (bookmarksOnly) {
      records = records.filter(r => r.id != null && bookmarks.has(String(r.id)));
    }

    messageList.innerHTML = '';

    if (records.length === 0) {
      messageList.innerHTML = '<div class="cpcl-empty">No messages match \u2014 try adjusting your filters.</div>';
      updateCount(0);
      return;
    }

    // Group by date
    let lastDate = '';
    const frag = document.createDocumentFragment();
    for (const r of records) {
      const dateStr = new Date(r.timestamp).toDateString();
      if (dateStr !== lastDate) {
        const sep = document.createElement('div');
        sep.className   = 'cpcl-date-sep';
        sep.textContent = formatDate(r.timestamp);
        frag.appendChild(sep);
        lastDate = dateStr;
      }
      frag.appendChild(renderMessage(r));
    }
    messageList.appendChild(frag);
    messageList.scrollTop = messageList.scrollHeight;
    updateCount(records.length);

    // Populate rooms
    const rooms = await dbGetRooms();
    const existing = new Set([...roomFilter.options].map(o => o.value).filter(Boolean));
    for (const r of rooms) {
      if (!existing.has(r)) {
        const opt = document.createElement('option');
        opt.value = r; opt.textContent = r;
        roomFilter.appendChild(opt);
      }
    }
  }

  function handleFilter() {
    if (replayActive) exitReplay();
    loadHistory();
  }

  async function handleClear() {
    if (!confirm('Clear ALL saved chat history? This cannot be undone.')) return;
    await dbClear();
    messageList.innerHTML = '<div class="cpcl-empty">History cleared.</div>';
    updateCount(0);
    roomFilter.innerHTML  = '<option value="">All rooms</option>';
    allRooms.clear();
  }

  async function handleExport() {
    // Populate export modal room dropdown
    const exportRoomSelect = document.getElementById('cpcl-export-room');
    exportRoomSelect.innerHTML = '<option value="">All rooms</option>';
    const rooms = await dbGetRooms();
    for (const r of rooms) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      exportRoomSelect.appendChild(opt);
    }

    // Reset fields
    document.getElementById('cpcl-export-from').value   = '';
    document.getElementById('cpcl-export-to').value     = '';
    document.getElementById('cpcl-export-player').value = '';
    document.getElementById('cpcl-export-format').value = 'txt';

    // Show modal
    document.getElementById('cpcl-export-modal').classList.add('cpcl-modal-visible');
  }

  function closeExportModal() {
    document.getElementById('cpcl-export-modal').classList.remove('cpcl-modal-visible');
  }

  async function performExport() {
    const format   = document.getElementById('cpcl-export-format').value;
    const fromDate = document.getElementById('cpcl-export-from').value;
    const toDate   = document.getElementById('cpcl-export-to').value;
    const room     = document.getElementById('cpcl-export-room').value;
    const player   = document.getElementById('cpcl-export-player').value.trim().toLowerCase();

    let records = await dbGetAll();
    if (records.length === 0) { alert('No messages to export.'); return; }

    if (fromDate) {
      const from = new Date(fromDate);
      from.setHours(0, 0, 0, 0);
      records = records.filter(r => r.timestamp >= from.getTime());
    }
    if (toDate) {
      const to = new Date(toDate);
      to.setHours(23, 59, 59, 999);
      records = records.filter(r => r.timestamp <= to.getTime());
    }
    if (room) {
      records = records.filter(r => r.room === room);
    }
    if (player) {
      records = records.filter(r => r.username.toLowerCase().includes(player));
    }

    if (records.length === 0) { alert('No messages match the selected filters.'); return; }

    let content, mimeType, ext;

    if (format === 'json') {
      content  = JSON.stringify(records, null, 2);
      mimeType = 'application/json';
      ext      = 'json';
    } else if (format === 'csv') {
      const header = ['timestamp', 'username', 'message', 'room', 'eventName', 'direction', 'session'];
      const rows = records.map(r => header.map(h => csvEscape(r[h] ?? '')).join(','));
      content  = header.join(',') + '\n' + rows.join('\n');
      mimeType = 'text/csv';
      ext      = 'csv';
    } else {
      const lines = records.map(r => {
        const d = new Date(r.timestamp).toLocaleString();
        return `[${d}] [${r.room}] ${r.username}: ${r.message}`;
      });
      content  = lines.join('\n');
      mimeType = 'text/plain';
      ext      = 'txt';
    }

    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `cp-chat-log-${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);

    closeExportModal();
  }

  function updateCount(n) {
    const counter = document.getElementById('cpcl-count');
    if (!counter) return;
    const shown = n !== undefined ? n : messageList.querySelectorAll('.cpcl-msg').length;
    counter.textContent = `${shown.toLocaleString()} message${shown !== 1 ? 's' : ''}`;
  }

  // ─── Replay Mode ─────────────────────────────────────────────────────────

  let replayActive   = false;
  let replayPlaying  = false;
  let replayMessages = [];
  let replayIndex    = 0;
  let replayTimer    = null;
  let replayStartTs  = 0;
  let sliderGrabbed  = false;
  let wasPlayingBeforeGrab = false;

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  async function enterReplay() {
    const search      = searchInput.value.toLowerCase();
    const roomVal     = roomFilter.value;
    const sessionOnly = document.getElementById('cpcl-session-only').checked;

    const filter = {};
    if (search)      filter.search  = search;
    if (roomVal)     filter.room    = roomVal;
    if (sessionOnly) filter.session = SESSION_ID;

    const records = await dbGetAll(filter);
    if (records.length === 0) return;

    records.sort((a, b) => a.timestamp - b.timestamp);

    replayMessages = records;
    replayIndex    = 0;
    replayStartTs  = records[0].timestamp;
    replayActive   = true;
    replayPlaying  = false;

    messageList.innerHTML = '';

    const rSlider = document.getElementById('cpcl-replay-slider');
    rSlider.max   = String(records.length - 1);
    rSlider.value = '0';

    document.getElementById('cpcl-replay-time').textContent = '0:00';
    document.getElementById('cpcl-replay-play').textContent = '\u25B6';

    document.getElementById('cpcl-replay-bar').classList.add('cpcl-replay-active');
    document.getElementById('cpcl-count').style.display = 'none';
    document.getElementById('cpcl-replay').style.display = 'none';

    startReplayPlayback();
  }

  function exitReplay() {
    stopReplayPlayback();
    replayActive   = false;
    replayPlaying  = false;
    replayMessages = [];
    replayIndex    = 0;

    document.getElementById('cpcl-replay-bar').classList.remove('cpcl-replay-active');
    document.getElementById('cpcl-count').style.display = '';
    document.getElementById('cpcl-replay').style.display = '';

    loadHistory();
  }

  function toggleReplayPlayback() {
    if (replayPlaying) {
      stopReplayPlayback();
    } else {
      startReplayPlayback();
    }
  }

  function startReplayPlayback() {
    if (!replayActive) return;
    if (replayIndex >= replayMessages.length) return;

    replayPlaying = true;
    document.getElementById('cpcl-replay-play').textContent = '\u23F8';
    scheduleNextMessage();
  }

  function stopReplayPlayback() {
    replayPlaying = false;
    document.getElementById('cpcl-replay-play').textContent = '\u25B6';
    if (replayTimer !== null) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  }

  function scheduleNextMessage() {
    if (!replayPlaying || !replayActive) return;
    if (replayIndex >= replayMessages.length) {
      stopReplayPlayback();
      return;
    }

    const speed = parseFloat(document.getElementById('cpcl-replay-speed').value) || 5;

    if (replayIndex === 0) {
      showReplayMessage(replayIndex);
      replayIndex++;
      scheduleNextMessage();
      return;
    }

    const prev = replayMessages[replayIndex - 1];
    const curr = replayMessages[replayIndex];
    let gap = curr.timestamp - prev.timestamp;

    if (gap > 3000) gap = 3000;

    let delay = gap / speed;
    if (delay < 50) delay = 50;

    replayTimer = setTimeout(() => {
      replayTimer = null;
      if (!replayPlaying || !replayActive) return;

      showReplayMessage(replayIndex);
      replayIndex++;
      updateReplaySlider();
      scheduleNextMessage();
    }, delay);
  }

  function showReplayMessage(idx) {
    if (idx < 0 || idx >= replayMessages.length) return;
    const record = replayMessages[idx];
    const el = renderMessage(record);
    messageList.appendChild(el);
    messageList.scrollTop = messageList.scrollHeight;

    const elapsed = record.timestamp - replayStartTs;
    document.getElementById('cpcl-replay-time').textContent = formatElapsed(elapsed);
  }

  function updateReplaySlider() {
    if (sliderGrabbed) return;
    const rSlider = document.getElementById('cpcl-replay-slider');
    rSlider.value = String(Math.max(0, replayIndex - 1));
  }

  function handleSliderScrub() {
    if (!replayActive) return;
    const rSlider = document.getElementById('cpcl-replay-slider');
    const targetIdx = parseInt(rSlider.value, 10);

    messageList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i <= targetIdx; i++) {
      frag.appendChild(renderMessage(replayMessages[i]));
    }
    messageList.appendChild(frag);
    messageList.scrollTop = messageList.scrollHeight;

    replayIndex = targetIdx + 1;

    const record = replayMessages[targetIdx];
    const elapsed = record.timestamp - replayStartTs;
    document.getElementById('cpcl-replay-time').textContent = formatElapsed(elapsed);
  }

  function handleSliderGrab() {
    sliderGrabbed = true;
    wasPlayingBeforeGrab = replayPlaying;
    if (replayPlaying) stopReplayPlayback();
  }

  function handleSliderRelease() {
    sliderGrabbed = false;
    if (wasPlayingBeforeGrab) startReplayPlayback();
  }

  function handleReplaySpeedChange() {
    if (replayPlaying && replayActive) {
      if (replayTimer !== null) {
        clearTimeout(replayTimer);
        replayTimer = null;
      }
      scheduleNextMessage();
    }
  }

  // ─── Friend join notification ──────────────────────────────────────────────

  function showFriendNotification(username) {
    if (!messageList) return;
    const notif = document.createElement('div');
    notif.className = 'cpcl-notification';
    notif.textContent = '\uD83D\uDC4B ' + username + ' joined the room!';
    messageList.prepend(notif);
    notif.addEventListener('animationend', () => notif.remove());
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  openDB().then(idb => {
    db = idb;
    createPanel();

    // Listen for messages from hook.js (page context -> isolated world)
    window.addEventListener(BRIDGE_EVENT, (e) => {
      ingest(e.detail);
    });

    // Listen for server events (buddy/world/queue updates)
    // State is serialised in event detail because hook.js (MAIN world) and
    // panel.js (ISOLATED world) have separate window objects.
    window.addEventListener(SERVER_EVENT, (e) => {
      if (e.detail) cachedServerState = e.detail;
      if (activeTab === 'server') populateServer();
    });

    // Listen for player events (friend join notifications)
    window.addEventListener(PLAYER_EVENT, (e) => {
      const detail = e.detail;
      if (!detail) return;
      const action = detail.action || detail.type;
      if (action === 'add_player' || action === 'add') {
        const friends = window.__cpChatLog_friends;
        const username = detail.username
          || (detail.player && detail.player.username)
          || (detail.user && detail.user.username)
          || (detail.args && detail.args.username);
        if (username && friends && friends.has(username)) {
          showFriendNotification(username);
        }
      }
    });

    console.debug('[CP Chat Log] Panel ready, DB open');
  }).catch(err => {
    console.error('[CP Chat Log] Failed to open IndexedDB:', err);
  });

})();
