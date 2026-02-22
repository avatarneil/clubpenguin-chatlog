'use strict';

const DB_NAME    = 'CPChatLog';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
    // If DB doesn't exist yet (no game visit), resolve null
    req.onblocked = () => resolve(null);
  });
}

async function getAll(db, search = '') {
  if (!db) return [];
  return new Promise(resolve => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req   = store.getAll();
    req.onsuccess = e => {
      let r = e.target.result;
      if (search) {
        const q = search.toLowerCase();
        r = r.filter(m =>
          m.message.toLowerCase().includes(q) ||
          m.username.toLowerCase().includes(q)
        );
      }
      resolve(r);
    };
    req.onerror = () => resolve([]);
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function csvEscape(val) {
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString([], { month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit' });
}

(async () => {
  let db;
  try { db = await openDB(); } catch { db = null; }

  const all = await getAll(db);

  // Stats
  const rooms = new Set(all.map(m => m.room));
  const users  = new Set(all.map(m => m.username));
  document.getElementById('stat-total').textContent = all.length.toLocaleString();
  document.getElementById('stat-rooms').textContent = rooms.size;
  document.getElementById('stat-users').textContent = users.size;

  // Search
  const searchEl  = document.getElementById('popup-search');
  const resultsEl = document.getElementById('popup-results');

  function renderResults(records) {
    if (records.length === 0) {
      resultsEl.innerHTML = '<div class="popup-empty">No messages found.</div>';
      return;
    }
    // Show most recent 30
    const shown = records.slice(-30).reverse();
    resultsEl.innerHTML = shown.map(r => `
      <div class="popup-result-item">
        <div>
          <span class="popup-result-user">${escHtml(r.username)}</span>
          <span class="popup-result-room">${escHtml(r.room)}</span>
          <span class="popup-result-time">${escHtml(formatTime(r.timestamp))}</span>
        </div>
        <div class="popup-result-text">${escHtml(r.message)}</div>
      </div>
    `).join('');
  }

  // Initial render (most recent 30)
  renderResults(all);

  let debounceTimer;
  searchEl.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const q       = searchEl.value.trim();
      const results = await getAll(db, q);
      renderResults(results);
    }, 200);
  });

  // Export
  document.getElementById('btn-export').addEventListener('click', async () => {
    const records = await getAll(db);
    if (!records.length) { alert('No messages to export.'); return; }

    const format = document.getElementById('export-format').value;
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
    a.href = url; a.download = `cp-chat-${new Date().toISOString().slice(0,10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Clear
  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!db) return;
    if (!confirm('Clear ALL chat history? This cannot be undone.')) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear().onsuccess = () => {
      document.getElementById('stat-total').textContent = '0';
      document.getElementById('stat-rooms').textContent = '0';
      document.getElementById('stat-users').textContent = '0';
      renderResults([]);
    };
  });
})();
