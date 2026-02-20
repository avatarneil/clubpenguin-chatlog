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
  // Prevents duplicate rows when multiple interception layers fire for the
  // same event (e.g. WebSocket + EventEmitter both catching the same packet).

  const recentHashes = new Set();
  function makeHash(msg) {
    return `${msg.username}|${msg.message}|${Math.floor(msg.timestamp / 1000)}`;
  }

  // ─── Message ingestion ────────────────────────────────────────────────────

  function ingest(detail) {
    const hash = makeHash(detail);
    if (recentHashes.has(hash)) return;
    recentHashes.add(hash);
    setTimeout(() => recentHashes.delete(hash), 3000);

    const record = {
      timestamp: detail.timestamp,
      username:  detail.username,
      message:   detail.message,
      room:      detail.room,
      eventName: detail.eventName,
      direction: detail.direction,
      session:   SESSION_ID,
    };

    dbPut(record);
    appendToPanel(record);
  }

  // ─── UI Panel ─────────────────────────────────────────────────────────────

  let panel, messageList, searchInput, roomFilter, badge;
  let panelVisible = false;
  let allRooms = new Set();

  function createPanel() {
    // ── Toggle button (the "chat bubble" icon in CP style) ──
    const toggle = document.createElement('div');
    toggle.id        = 'cpcl-toggle';
    toggle.innerHTML = `
      <span class="cpcl-toggle-icon">💬</span>
      <span class="cpcl-badge" id="cpcl-badge">0</span>
    `;
    toggle.title = 'CP Chat Log';
    toggle.addEventListener('click', togglePanel);

    // ── Main panel ──
    panel = document.createElement('div');
    panel.id = 'cpcl-panel';
    panel.innerHTML = `
      <div class="cpcl-header">
        <span class="cpcl-title">📋 Chat Log</span>
        <div class="cpcl-header-controls">
          <button class="cpcl-btn cpcl-btn-sm" id="cpcl-export" title="Export as text">⬇ Export</button>
          <button class="cpcl-btn cpcl-btn-sm cpcl-btn-danger" id="cpcl-clear" title="Clear all history">🗑 Clear</button>
          <button class="cpcl-btn cpcl-btn-sm" id="cpcl-close" title="Close">✕</button>
        </div>
      </div>

      <div class="cpcl-filters">
        <input  type="text"   id="cpcl-search"    class="cpcl-input" placeholder="🔍 Search messages…">
        <select id="cpcl-room-filter" class="cpcl-input cpcl-select">
          <option value="">All rooms</option>
        </select>
        <label class="cpcl-session-label">
          <input type="checkbox" id="cpcl-session-only"> This session only
        </label>
      </div>

      <div class="cpcl-message-list" id="cpcl-messages">
        <div class="cpcl-empty">No messages yet — chat in-game and they'll appear here!</div>
      </div>

      <div class="cpcl-footer">
        <span id="cpcl-count">0 messages</span>
        <span class="cpcl-session-id">Session: ${SESSION_ID}</span>
      </div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

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
  }

  function togglePanel() {
    panelVisible = !panelVisible;
    panel.classList.toggle('cpcl-panel-visible', panelVisible);
    if (panelVisible) {
      unreadCount = 0;
      updateBadge();
      loadHistory();
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

  function renderMessage(record) {
    const isToday = new Date(record.timestamp).toDateString() === new Date().toDateString();
    const el = document.createElement('div');
    el.className = `cpcl-msg ${record.direction === 'out' ? 'cpcl-msg-out' : 'cpcl-msg-in'}`;
    el.dataset.username = record.username;
    el.dataset.room     = record.room;
    el.dataset.session  = record.session;
    el.innerHTML = `
      <div class="cpcl-msg-meta">
        <span class="cpcl-msg-user">${escHtml(record.username)}</span>
        <span class="cpcl-msg-room">${escHtml(record.room)}</span>
        <span class="cpcl-msg-time" title="${new Date(record.timestamp).toLocaleString()}">
          ${isToday ? formatTime(record.timestamp) : formatDate(record.timestamp)}
        </span>
      </div>
      <div class="cpcl-msg-text">${escHtml(record.message)}</div>
    `;
    return el;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

    // If panel isn't visible or filter hides this message, just update badge
    if (!panelVisible) {
      unreadCount++;
      updateBadge();
      return;
    }

    // Check if it passes current filter
    const search      = searchInput.value.toLowerCase();
    const roomVal     = roomFilter.value;
    const sessionOnly = document.getElementById('cpcl-session-only').checked;

    if (search && !record.message.toLowerCase().includes(search) && !record.username.toLowerCase().includes(search)) return;
    if (roomVal && record.room !== roomVal) return;
    if (sessionOnly && record.session !== SESSION_ID) return;

    const empty = messageList.querySelector('.cpcl-empty');
    if (empty) empty.remove();

    const el = renderMessage(record);
    messageList.appendChild(el);
    messageList.scrollTop = messageList.scrollHeight;
    updateCount();
  }

  async function loadHistory() {
    const search      = searchInput.value.toLowerCase();
    const roomVal     = roomFilter.value;
    const sessionOnly = document.getElementById('cpcl-session-only').checked;

    const filter = {};
    if (search)      filter.search  = search;
    if (roomVal)     filter.room    = roomVal;
    if (sessionOnly) filter.session = SESSION_ID;

    const records = await dbGetAll(filter);
    messageList.innerHTML = '';

    if (records.length === 0) {
      messageList.innerHTML = '<div class="cpcl-empty">No messages match — try adjusting your filters.</div>';
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
    const records = await dbGetAll();
    if (records.length === 0) { alert('No messages to export.'); return; }
    const lines = records.map(r => {
      const d = new Date(r.timestamp).toLocaleString();
      return `[${d}] [${r.room}] ${r.username}: ${r.message}`;
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `cp-chat-log-${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function updateCount(n) {
    const counter = document.getElementById('cpcl-count');
    if (!counter) return;
    const shown = n !== undefined ? n : messageList.querySelectorAll('.cpcl-msg').length;
    counter.textContent = `${shown.toLocaleString()} message${shown !== 1 ? 's' : ''}`;
  }

  // ─── Entry point ──────────────────────────────────────────────────────────

  openDB().then(idb => {
    db = idb;
    createPanel();

    // Listen for messages from hook.js (page context → isolated world)
    window.addEventListener(BRIDGE_EVENT, (e) => {
      ingest(e.detail);
    });

    console.debug('[CP Chat Log] Panel ready, DB open');
  }).catch(err => {
    console.error('[CP Chat Log] Failed to open IndexedDB:', err);
  });

})();
