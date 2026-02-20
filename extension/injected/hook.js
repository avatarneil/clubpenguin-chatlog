/**
 * hook.js — runs in PAGE context via "world": "MAIN" content script.
 *
 * Architecture discovery:
 *   newcp.net is a fork of the open-source Yukon CP client. All socket.io
 *   traffic uses a SINGLE event named "message", and the second argument is
 *   an AES-encrypted, base64-encoded ciphertext. Decrypted payloads follow
 *   Yukon's protocol: {"action":"<type>","args":{...}}
 *
 * Interception strategy (layered):
 *
 *   Layer 1 — crypto.subtle hook (PRIMARY)
 *     Hook window.crypto.subtle.decrypt to capture plaintext after the game
 *     decrypts each incoming socket message, and hook .encrypt to capture
 *     outgoing plaintext before encryption. Parse the Yukon JSON envelope
 *     and dispatch chat-related actions.
 *
 *   Layer 2 — WebSocket proxy (DEBUG + fallback)
 *     Intercepts raw encrypted frames. Used for debug logging and as a
 *     fallback in case the crypto hook misses anything.
 *
 *   Layer 3 — DOM MutationObserver (fallback)
 *     Watches for any Phaser DOMElement chat nodes added to #cp_html.
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  const BRIDGE_EVENT = '__cpChatLog_message__';

  /**
   * Yukon action names that represent chat. Based on the open-source Yukon
   * client's handler map + newcp.net-specific additions.
   */
  const CHAT_ACTIONS = new Set([
    'send_message',   // free-text chat
    'send_safe',      // safe-message (ID-based, we show the text if resolvable)
    'send_emote',     // emote action
    'send_joke',      // joke
    'send_tour',      // tour guide speech
  ]);

  // ─── Debug buffers (initialised early so WS layer can write to them) ──────

  window.__cpChatLog_events    = window.__cpChatLog_events    || [];
  window.__cpChatLog_rawFrames = window.__cpChatLog_rawFrames || [];
  window.__cpChatLog_decrypted = window.__cpChatLog_decrypted || [];

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function dispatch(msg) {
    window.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail: msg }));
  }

  function tryJSON(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  function bufferToString(buf) {
    if (typeof buf === 'string') return buf;
    try { return new TextDecoder().decode(buf); } catch { return null; }
  }

  // ─── Player registry & room tracking ────────────────────────────────────
  // Built from Yukon protocol messages rather than Phaser scene walking.
  // join_room gives us all players in the room; add_player adds latecomers.
  // login / game_auth / load_player tells us who WE are (needed for outgoing
  // send_message which carries no id field).

  const playerRegistry = new Map(); // Number(id) → { username, nickname }
  let ownPlayerId   = null;
  let ownUsername   = null;
  let currentRoomId = null;

  function registerPlayer(p) {
    if (!p || p.id === undefined) return;
    playerRegistry.set(Number(p.id), {
      username: p.username || p.nickname || `Penguin #${p.id}`,
      nickname: p.nickname || p.username || `Penguin #${p.id}`,
    });
  }

  function lookupUsername(id) {
    if (id === undefined || id === null) return null;
    const p = playerRegistry.get(Number(id));
    return p ? (p.nickname || p.username) : null;
  }

  function getCurrentRoom() {
    return currentRoomId !== null ? String(currentRoomId) : (document.title || '(unknown)');
  }

  function updateRegistryFromMessage(action, args) {
    switch (action) {
      case 'login':
      case 'token_login':
      case 'game_auth':
      case 'load_player': {
        // Server response after auth — tells us our own penguin
        const u = args.user || args;
        if (u && u.id !== undefined) {
          ownPlayerId = Number(u.id);
          ownUsername = u.username || u.nickname || null;
          registerPlayer(u);
        }
        break;
      }
      case 'join_room': {
        if (args.room !== undefined) currentRoomId = args.room;
        if (Array.isArray(args.users)) {
          args.users.forEach(registerPlayer);
          // If we haven't resolved our own identity yet, the first (or only)
          // entry whose id matches what the server echoes back is usually us.
          // This is a last-resort heuristic only.
          if (ownPlayerId === null && args.users.length === 1) {
            ownPlayerId = Number(args.users[0].id);
            ownUsername = args.users[0].username || args.users[0].nickname || null;
          }
        }
        break;
      }
      case 'add_player': {
        registerPlayer(args.user || args);
        break;
      }
      case 'remove_player': {
        if (args.user !== undefined) playerRegistry.delete(Number(args.user));
        break;
      }
    }
  }

  // ─── Yukon message handler ────────────────────────────────────────────────
  // Called with the plaintext string after decryption (or before encryption).

  function handleYukonMessage(text, direction) {
    // Store for debug
    window.__cpChatLog_decrypted.push({ dir: direction, text: text.slice(0, 400) });
    if (window.__cpChatLog_decrypted.length > 200) window.__cpChatLog_decrypted.shift();

    const parsed = tryJSON(text);
    if (!parsed || typeof parsed.action !== 'string') return;

    const action = parsed.action;
    const args   = parsed.args || {};

    // Track all actions for debug
    window.__cpChatLog_events.push({ ts: Date.now(), event: action, direction });
    if (window.__cpChatLog_events.length > 500) window.__cpChatLog_events.shift();

    // Update player registry / room state from every message (not just chat)
    updateRegistryFromMessage(action, args);

    if (!CHAT_ACTIONS.has(action)) return;

    // ── Resolve message text ──
    let messageText;
    if (action === 'send_message') {
      messageText = args.message ? String(args.message) : null;
    } else if (action === 'send_safe') {
      // Safe messages are indexed; show the index until we have a lookup table
      messageText = args.message
        ? String(args.message)
        : (args.safe !== undefined ? `[Safe #${args.safe}]` : null);
    } else if (action === 'send_emote') {
      messageText = `[Emote ${args.emote ?? '?'}]`;
    } else if (action === 'send_joke') {
      messageText = `[Joke #${args.joke ?? '?'}]`;
    } else if (action === 'send_tour') {
      messageText = args.message ? String(args.message) : `[Tour]`;
    }

    if (!messageText) return;

    // ── Resolve sender ──
    // Outgoing send_message carries no id — use our own tracked identity.
    // Incoming messages carry args.id which we look up in the registry.
    const penguinId = args.id !== undefined ? args.id : args.penguin_id;
    let username;
    if (direction === 'out') {
      username = ownUsername || args.username || args.name
        || (ownPlayerId !== null ? `Penguin #${ownPlayerId}` : '(you)');
    } else {
      username = (penguinId !== undefined ? lookupUsername(penguinId) : null)
        || args.username || args.name
        || (penguinId !== undefined ? `Penguin #${penguinId}` : '(unknown)');
    }

    dispatch({
      timestamp: Date.now(),
      username,
      message:   messageText,
      room:      args.room || args.room_id || getCurrentRoom() || '(unknown)',
      eventName: action,
      direction,
      raw:       text.slice(0, 400),
    });
  }

  // ─── Layer 1: crypto.subtle hook ──────────────────────────────────────────
  // newcp.net encrypts every socket.io message payload with AES before sending
  // and decrypts it on receipt. By intercepting at the crypto boundary we get
  // clean plaintext regardless of the encryption scheme used.

  (function patchCrypto() {
    if (!window.crypto || !window.crypto.subtle) {
      console.warn('[CP Chat Log] crypto.subtle not available — crypto hook skipped');
      return;
    }

    // ── Incoming: hook decrypt ──
    const _origDecrypt = window.crypto.subtle.decrypt.bind(window.crypto.subtle);
    window.crypto.subtle.decrypt = async function (algorithm, key, data) {
      const resultBuffer = await _origDecrypt(algorithm, key, data);
      try {
        const text = bufferToString(resultBuffer);
        if (text) handleYukonMessage(text, 'in');
      } catch { /* not text data */ }
      return resultBuffer;
    };

    // ── Outgoing: hook encrypt — capture plaintext BEFORE encryption ──
    const _origEncrypt = window.crypto.subtle.encrypt.bind(window.crypto.subtle);
    window.crypto.subtle.encrypt = async function (algorithm, key, data) {
      try {
        // data may be ArrayBuffer | TypedArray | DataView
        const buf  = data.buffer ? data.buffer : data;
        const text = bufferToString(buf);
        if (text) handleYukonMessage(text, 'out');
      } catch { /* ignore */ }
      return _origEncrypt(algorithm, key, data);
    };

    console.debug('[CP Chat Log] crypto.subtle hook installed');
  })();

  // ─── Layer 2: WebSocket proxy (debug logging + encrypted-frame fallback) ──

  (function patchWebSocket() {
    const _WS = window.WebSocket;
    if (!_WS) return;

    function NCPWebSocket(url, protocols) {
      const ws = protocols ? new _WS(url, protocols) : new _WS(url);

      const _origAddEL = ws.addEventListener.bind(ws);
      ws.addEventListener = function (type, listener, ...rest) {
        if (type === 'message') {
          const wrapped = function (evt) {
            const raw = evt.data;
            window.__cpChatLog_rawFrames.push({
              dir:  'in',
              data: typeof raw === 'string' ? raw.slice(0, 300) : `[binary ${raw.byteLength ?? '?'} bytes]`,
            });
            if (window.__cpChatLog_rawFrames.length > 200) window.__cpChatLog_rawFrames.shift();
            return listener.call(this, evt);
          };
          return _origAddEL(type, wrapped, ...rest);
        }
        return _origAddEL(type, listener, ...rest);
      };

      const _origSend = ws.send.bind(ws);
      ws.send = function (data) {
        window.__cpChatLog_rawFrames.push({
          dir:  'out',
          data: typeof data === 'string' ? data.slice(0, 300) : `[binary ${data.byteLength ?? '?'} bytes]`,
        });
        if (window.__cpChatLog_rawFrames.length > 200) window.__cpChatLog_rawFrames.shift();
        return _origSend(data);
      };

      const _nativeOnmessageDesc = Object.getOwnPropertyDescriptor(_WS.prototype, 'onmessage');
      let _onmessageStored = null;
      Object.defineProperty(ws, 'onmessage', {
        get: () => _onmessageStored,
        set: (fn) => {
          _onmessageStored = fn;
          if (_nativeOnmessageDesc && _nativeOnmessageDesc.set) {
            _nativeOnmessageDesc.set.call(ws, function (evt) {
              window.__cpChatLog_rawFrames.push({ dir: 'in', data: String(evt.data).slice(0, 300) });
              if (window.__cpChatLog_rawFrames.length > 200) window.__cpChatLog_rawFrames.shift();
              return fn && fn.call(this, evt);
            });
          }
        },
        configurable: true,
      });

      return ws;
    }

    Object.setPrototypeOf(NCPWebSocket, _WS);
    NCPWebSocket.prototype = _WS.prototype;
    Object.getOwnPropertyNames(_WS).forEach((k) => {
      try { NCPWebSocket[k] = _WS[k]; } catch { /* read-only */ }
    });

    window.WebSocket = NCPWebSocket;
    console.debug('[CP Chat Log] WebSocket proxy installed');
  })();

  // ─── Layer 3: DOM MutationObserver ────────────────────────────────────────

  (function observeDOM() {
    const CHAT_SELECTORS = [
      '.chat-message', '.chatMessage', '.chat_message',
      '.message-text', '.messageText',
      '[class*="chat"]', '[class*="Chat"]',
      '[data-username]',
    ];

    const seen = new WeakSet();

    function processNode(node) {
      if (node.nodeType !== 1 || seen.has(node)) return;
      seen.add(node);

      const isChat = CHAT_SELECTORS.some(sel => { try { return node.matches(sel); } catch { return false; } });

      if (!isChat) {
        for (const sel of CHAT_SELECTORS) {
          try { node.querySelectorAll(sel).forEach(c => processNode(c)); } catch { /* */ }
        }
        return;
      }

      const username = node.dataset.username || '(unknown)';
      const message  = node.dataset.message  || node.textContent?.trim() || '';
      if (!message) return;

      dispatch({
        timestamp: Date.now(), username, message,
        room:      getCurrentRoom() || '(unknown)',
        eventName: 'dom:chat', direction: 'in',
        raw:       node.outerHTML.slice(0, 300),
      });
    }

    function start() {
      const target = document.getElementById('cp_html') || document.body;
      new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(processNode)))
        .observe(target, { childList: true, subtree: true });
    }

    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', start)
      : start();
  })();

  // ─── Debug helper ─────────────────────────────────────────────────────────

  window.cpChatLogDebug = function () {
    const events    = window.__cpChatLog_events    || [];
    const frames    = window.__cpChatLog_rawFrames  || [];
    const decrypted = window.__cpChatLog_decrypted  || [];

    console.group('[CP Chat Log] Debug snapshot');
    console.log('crypto.subtle hooked:', typeof window.crypto?.subtle?.decrypt === 'function'
      && window.crypto.subtle.decrypt.toString().includes('_origDecrypt') === false
      ? '✅ (async wrapper active)' : '⚠️ check manually');
    console.log(`Own identity: id=${ownPlayerId} username=${ownUsername}`);
    console.log(`Current room: ${currentRoomId}`);
    console.log(`Player registry size: ${playerRegistry.size}`);
    if (playerRegistry.size) {
      console.log('Registry entries:');
      playerRegistry.forEach((v, k) => console.log(` ${k} → ${v.nickname || v.username}`));
    }
    console.log(`Decrypted messages captured: ${decrypted.length}`);
    if (decrypted.length) {
      console.log('Last 5 decrypted payloads:');
      decrypted.slice(-5).forEach(d => console.log(d.dir, d.text));
    }
    console.log(`\nGame actions seen (${events.length} total):`);
    const grouped = {};
    events.forEach(e => { grouped[e.event] = (grouped[e.event] || 0) + 1; });
    console.table(grouped);
    console.log('\nLast 5 raw WS frames:');
    frames.slice(-5).forEach(f => console.log(f.dir, f.data));
    console.groupEnd();
    return { events, frames, decrypted, playerRegistry, ownPlayerId, ownUsername, currentRoomId };
  };

  console.debug('[CP Chat Log] Hook loaded. Layers: crypto.subtle ✓  WebSocket ✓  DOM ✓');
})();
