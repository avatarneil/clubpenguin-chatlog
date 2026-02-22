/**
 * hook.js — runs in PAGE context via "world": "MAIN" content script.
 *
 * Supports multiple Yukon-based CP servers:
 *
 *   newcp.net — Encrypted protocol. All socket.io traffic uses a SINGLE event
 *     named "message"; the payload is AES-encrypted via crypto.subtle.
 *     Decrypted payloads follow Yukon's: {"action":"<type>","args":{...}}
 *
 *   cpjourney.net — Plaintext protocol. Standard socket.io with individual
 *     event names per action (e.g. socket.emit('send_message', {...})).
 *     No encryption. Frames are standard engine.io/socket.io wire format:
 *     42["event_name",{...}]
 *
 * Interception strategy (layered):
 *
 *   Layer 1 — crypto.subtle hook (newcp.net PRIMARY)
 *     Hook window.crypto.subtle.decrypt/encrypt to capture plaintext.
 *     Only fires on servers that encrypt their socket.io traffic.
 *
 *   Layer 2 — WebSocket proxy (cpjourney.net PRIMARY, newcp.net DEBUG)
 *     Intercepts raw WebSocket frames. For plaintext socket.io servers,
 *     parses the engine.io/socket.io wire format to extract event names
 *     and arguments. Also provides debug logging for encrypted servers.
 *
 *   Layer 3 — DOM MutationObserver (fallback)
 *     Watches for any Phaser DOMElement chat nodes added to #cp_html.
 */

(function () {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  const BRIDGE_EVENT = '__cpChatLog_message__';
  const PLAYER_EVENT = '__cpChatLog_playerEvent__';
  const IS_CPJOURNEY = /cpjourney\.net$/.test(location.hostname);

  const EMOTE_NAMES = {
    1: 'Happy', 2: 'Sad', 3: 'Grumpy', 4: 'Sick', 5: 'Surprised',
    6: 'Silly', 7: 'Love', 8: 'Thinking', 9: 'Angry', 10: 'Laughing',
    11: 'Winking', 12: 'Flower', 13: 'Coffee', 14: 'Pizza', 15: 'Coin',
    16: 'Igloo', 17: 'Cake', 18: 'Snowflake', 19: 'Sun', 20: 'Moon',
    21: 'Star', 22: 'Heart', 23: 'Skull', 24: 'Clover', 25: 'Diamond',
    26: 'Game', 27: 'Music', 28: 'Light Bulb', 29: 'Ghost', 30: 'Pumpkin',
  };

  const JOKE_TEXTS = {
    1: 'What do you call a sleeping dinosaur? A dino-snore!',
    2: 'Why did the cookie go to the doctor? It felt crummy!',
    3: 'What do you call a fish without eyes? A fsh!',
    4: 'Why couldn\'t the bicycle stand up? It was two-tired!',
    5: 'What do you get when you cross a snowman with a vampire? Frostbite!',
    6: 'Why did the penguin cross the road? To go to the other slide!',
    7: 'What do penguins eat for lunch? Ice-burgers!',
    8: 'What\'s a penguin\'s favorite relative? Aunt Arctica!',
    9: 'Why don\'t penguins fly? They can\'t afford plane tickets!',
    10: 'What do penguins sing on a birthday? Freeze a jolly good fellow!',
  };

  /**
   * Yukon action names that represent chat. Covers both newcp.net and
   * cpjourney.net action names (they diverge slightly).
   */
  const CHAT_ACTIONS = new Set([
    'send_message',   // free-text chat          (all servers)
    'send_safe',      // safe-message (ID-based)  (all servers)
    'send_emote',     // emote action             (all servers)
    'send_joke',      // joke                     (newcp.net)
    'send_tour',      // tour guide speech        (newcp.net)
    'give_tour',      // tour guide speech        (cpjourney.net)
    'send_stage',     // stage performance        (cpjourney.net)
  ]);

  /**
   * Yukon room ID → display name.
   * Source: https://github.com/wizguin/yukon-server/blob/master/data/rooms.json
   * IDs >= 2000 are player igloos (offset controlled by iglooIdOffset: 2000).
   */
  const ROOM_NAMES = {
    // Town area
    100: 'Town',
    110: 'Coffee Shop',
    111: 'Book Room',
    120: 'Dance Club',
    121: 'Lounge',
    130: 'Gift Shop',
    // Ski Village area
    200: 'Ski Village',
    210: 'Sport Shop',
    220: 'Ski Lodge',
    221: 'Lodge Attic',
    230: 'Ski Hill',
    // Plaza area
    300: 'Plaza',
    310: 'Pet Shop',
    320: 'Dojo',
    321: 'Dojo Courtyard',
    // Beach area
    400: 'Beach',
    // Outdoor / special rooms
    800: 'Dock',
    801: 'Snow Forts',
    802: 'Ice Rink',
    803: 'EPF HQ',
    805: 'Iceberg',
    806: 'Underground Pool',
    807: 'Lighthouse',
    809: 'Forest',
    810: 'Cove',
    // Mini-game / mission rooms
    900: 'Astro-Barrier',
    901: 'Bean Counters',
    902: 'Cattle Roundup',
    903: 'Hydro Hopper',
    904: 'Ice Fishing',
    907: 'PSA Mission 1',
    908: 'PSA Mission 2',
    909: 'Thin Ice',
    911: 'PSA Mission 3',
    912: 'Catchin\' Waves',
    913: 'PSA Mission 4',
    914: 'PSA Mission 5',
    915: 'PSA Mission 6',
    916: 'Puffle Submarine',
    920: 'PSA Mission 7',
    921: 'PSA Mission 8',
    922: 'PSA Mission 9',
    923: 'PSA Mission 10',
    927: 'PSA Mission 11',
    951: 'Sensei Battle',
    998: 'Card-Jitsu',
    999: 'Sled Racing',
  };

  function resolveRoomName(id) {
    if (id === undefined || id === null) return null;
    const n = Number(id);
    if (n >= 2000) return `Igloo #${n - 2000}`;
    return ROOM_NAMES[n] || `Room #${n}`;
  }

  // ─── Debug buffers (initialised early so WS layer can write to them) ──────

  window.__cpChatLog_events    = window.__cpChatLog_events    || [];
  window.__cpChatLog_rawFrames = window.__cpChatLog_rawFrames || [];
  window.__cpChatLog_decrypted = window.__cpChatLog_decrypted || [];

  // ─── Persistent friend/ignore lists (localStorage-backed) ───────────────

  const STORAGE_KEY_FRIENDS = '__cpChatLog_friends__';
  const STORAGE_KEY_IGNORED = '__cpChatLog_ignored__';

  function loadSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* ignore */ }
  }

  const friendList = loadSet(STORAGE_KEY_FRIENDS);
  const ignoreList = loadSet(STORAGE_KEY_IGNORED);

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function dispatch(msg) {
    window.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail: msg }));
  }

  function tryJSON(str) {
    try { return JSON.parse(str); } catch { return null; }
  }

  const _textDecoder = new TextDecoder();

  function bufferToString(buf) {
    if (typeof buf === 'string') return buf;
    try { return _textDecoder.decode(buf); } catch { return null; }
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
    const id = Number(p.id);
    const existing = playerRegistry.get(id);
    playerRegistry.set(id, {
      username:     p.username || p.nickname || (existing && existing.username) || `Penguin #${p.id}`,
      nickname:     p.nickname || p.username || (existing && existing.nickname) || `Penguin #${p.id}`,
      lastSeen:     (existing && existing.lastSeen) || Date.now(),
      roomsVisited: (existing && existing.roomsVisited) || new Set(),
      messageCount: (existing && existing.messageCount) || 0,
    });
  }

  function lookupUsername(id) {
    if (id === undefined || id === null) return null;
    const p = playerRegistry.get(Number(id));
    return p ? (p.nickname || p.username) : null;
  }

  function getCurrentRoom() {
    return currentRoomId !== null
      ? resolveRoomName(currentRoomId)
      : (document.title || '(unknown)');
  }

  function updateRegistryFromMessage(action, args) {
    const now = Date.now();

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
          const entry = playerRegistry.get(Number(u.id));
          if (entry) entry.lastSeen = now;
        }
        break;
      }
      case 'join_room': {
        if (args.room !== undefined) currentRoomId = args.room;
        if (Array.isArray(args.users)) {
          args.users.forEach(u => {
            registerPlayer(u);
            const entry = playerRegistry.get(Number(u.id));
            if (entry) {
              entry.lastSeen = now;
              if (currentRoomId !== null) entry.roomsVisited.add(currentRoomId);
            }
          });
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
        const u = args.user || args;
        registerPlayer(u);
        if (u && u.id !== undefined) {
          const entry = playerRegistry.get(Number(u.id));
          if (entry) {
            entry.lastSeen = now;
            if (currentRoomId !== null) entry.roomsVisited.add(currentRoomId);
          }
        }
        break;
      }
      case 'remove_player': {
        // Update lastSeen before removing, but keep the entry for tracking
        if (args.user !== undefined) {
          const entry = playerRegistry.get(Number(args.user));
          if (entry) entry.lastSeen = now;
          playerRegistry.delete(Number(args.user));
        }
        break;
      }
    }

    // Update lastSeen for any action involving a known player ID
    const actionPlayerId = args.id !== undefined ? args.id : args.penguin_id;
    if (actionPlayerId !== undefined) {
      const entry = playerRegistry.get(Number(actionPlayerId));
      if (entry) entry.lastSeen = now;
    }
  }

  // ─── Yukon message handler ────────────────────────────────────────────────
  // Called either with a JSON text string (newcp.net encrypted protocol) or
  // with a pre-parsed action + args object (cpjourney.net plaintext protocol).

  function handleYukonMessage(text, direction) {
    // Store for debug
    window.__cpChatLog_decrypted.push({ dir: direction, text: text.slice(0, 400) });
    if (window.__cpChatLog_decrypted.length > 200) window.__cpChatLog_decrypted.shift();

    const parsed = tryJSON(text);
    if (!parsed || typeof parsed.action !== 'string') return;

    handleYukonAction(parsed.action, parsed.args || {}, direction, text);
  }

  /** Entry point for pre-parsed messages (used by the socket.io frame parser). */
  function handleYukonAction(action, args, direction, rawText) {
    // Track all actions for debug
    window.__cpChatLog_events.push({ ts: Date.now(), event: action, direction });
    if (window.__cpChatLog_events.length > 500) window.__cpChatLog_events.shift();

    // Update player registry / room state from every message (not just chat)
    updateRegistryFromMessage(action, args);

    // Dispatch player events for join/add/remove actions
    if (action === 'join_room' || action === 'add_player' || action === 'remove_player') {
      if (action === 'join_room' && Array.isArray(args.users)) {
        // Dispatch one event per player in the room
        args.users.forEach(u => {
          if (u && u.id !== undefined) {
            window.dispatchEvent(new CustomEvent(PLAYER_EVENT, { detail: {
              type: 'join',
              player: { id: Number(u.id), username: u.username || u.nickname || `Penguin #${u.id}`, nickname: u.nickname || u.username || `Penguin #${u.id}` },
              room: currentRoomId,
              timestamp: Date.now(),
            }}));
          }
        });
      } else if (action === 'add_player') {
        const u = args.user || args;
        if (u && u.id !== undefined) {
          window.dispatchEvent(new CustomEvent(PLAYER_EVENT, { detail: {
            type: 'add',
            player: { id: Number(u.id), username: u.username || u.nickname || `Penguin #${u.id}`, nickname: u.nickname || u.username || `Penguin #${u.id}` },
            room: currentRoomId,
            timestamp: Date.now(),
          }}));
        }
      } else if (action === 'remove_player') {
        if (args.user !== undefined) {
          // Player was already removed from registry, so build minimal data
          window.dispatchEvent(new CustomEvent(PLAYER_EVENT, { detail: {
            type: 'remove',
            player: { id: Number(args.user), username: lookupUsername(args.user) || `Penguin #${args.user}`, nickname: null },
            room: currentRoomId,
            timestamp: Date.now(),
          }}));
        }
      }
    }

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
      const emoteId = args.emote;
      messageText = emoteId !== undefined && EMOTE_NAMES[emoteId]
        ? `[Emote: ${EMOTE_NAMES[emoteId]}]`
        : `[Emote #${emoteId ?? '?'}]`;
    } else if (action === 'send_joke') {
      const jokeId = args.joke;
      messageText = jokeId !== undefined && JOKE_TEXTS[jokeId]
        ? JOKE_TEXTS[jokeId]
        : `[Joke #${jokeId ?? '?'}]`;
    } else if (action === 'send_tour' || action === 'give_tour') {
      messageText = args.message ? String(args.message) : `[Tour]`;
    } else if (action === 'send_stage') {
      messageText = args.message ? String(args.message) : `[Stage]`;
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

    // Increment messageCount for the sender
    const senderId = penguinId !== undefined ? Number(penguinId) : ownPlayerId;
    if (senderId !== null && senderId !== undefined) {
      const senderEntry = playerRegistry.get(Number(senderId));
      if (senderEntry) senderEntry.messageCount = (senderEntry.messageCount || 0) + 1;
    }

    const rawRoom = args.room !== undefined ? args.room : args.room_id;
    const raw = rawText || JSON.stringify({ action, args }).slice(0, 400);
    dispatch({
      timestamp: Date.now(),
      username,
      message:   messageText,
      room:      rawRoom !== undefined ? resolveRoomName(rawRoom) : (getCurrentRoom() || '(unknown)'),
      eventName: action,
      direction,
      raw:       raw.slice(0, 400),
      playerId:  senderId !== null && senderId !== undefined ? Number(senderId) : null,
      isIgnored: ignoreList.has(username),
      isFriend:  friendList.has(username),
    });
  }

  // ─── Socket.io frame parsers ──────────────────────────────────────────────

  /**
   * Parse a plaintext socket.io v3/v4 text frame.
   * Format: 42["event_name",{...}]  (engine.io message + socket.io EVENT)
   */
  function parseSocketIOTextFrame(frame) {
    if (typeof frame !== 'string' || frame.length < 3) return null;
    if (frame[0] !== '4' || frame[1] !== '2') return null;

    let jsonStart = 2;
    if (frame[2] === '/') {
      const commaIdx = frame.indexOf(',', 2);
      if (commaIdx === -1) return null;
      jsonStart = commaIdx + 1;
    }

    const arr = tryJSON(frame.slice(jsonStart));
    if (!Array.isArray(arr) || arr.length < 1 || typeof arr[0] !== 'string') return null;

    return { eventName: arr[0], payload: arr[1] || {} };
  }

  // ─── Minimal msgpack decoder ────────────────────────────────────────────────
  // Covers the subset used by socket.io-msgpack-parser: maps, arrays, strings,
  // integers, booleans, null, and bin/ext (skipped). Float64 for completeness.

  function decodeMsgpack(buf) {
    const ab    = buf instanceof ArrayBuffer ? buf : buf.buffer;
    const view  = new DataView(ab);
    const bytes = new Uint8Array(ab);
    const len   = bytes.length;
    let pos = 0;
    let depth = 0;
    const MAX_DEPTH = 10;        // prevent stack overflow on nested data
    const MAX_COLLECTION = 1000; // cap array/map entries to avoid OOM

    function check(n) { if (pos + n > len) throw 0; }

    function u8()  { check(1); return view.getUint8(pos++); }
    function u16() { check(2); const v = view.getUint16(pos); pos += 2; return v; }
    function u32() { check(4); const v = view.getUint32(pos); pos += 4; return v; }
    function i8()  { check(1); return view.getInt8(pos++); }
    function i16() { check(2); const v = view.getInt16(pos); pos += 2; return v; }
    function i32() { check(4); const v = view.getInt32(pos); pos += 4; return v; }

    function str(n) {
      check(n);
      const s = _textDecoder.decode(bytes.subarray(pos, pos + n));
      pos += n;
      return s;
    }
    function skip(n) { check(n); pos += n; return null; }

    function readMap(n) {
      if (n > MAX_COLLECTION || ++depth > MAX_DEPTH) throw 0;
      const obj = {};
      for (let i = 0; i < n; i++) { const k = read(); obj[k] = read(); }
      depth--;
      return obj;
    }
    function readArr(n) {
      if (n > MAX_COLLECTION || ++depth > MAX_DEPTH) throw 0;
      const arr = [];
      for (let i = 0; i < n; i++) arr.push(read());
      depth--;
      return arr;
    }

    function read() {
      check(1);
      const b = u8();

      // positive fixint  0x00–0x7f
      if (b <= 0x7f) return b;
      // fixmap  0x80–0x8f
      if ((b & 0xf0) === 0x80) return readMap(b & 0x0f);
      // fixarray  0x90–0x9f
      if ((b & 0xf0) === 0x90) return readArr(b & 0x0f);
      // fixstr  0xa0–0xbf
      if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
      // negative fixint  0xe0–0xff
      if (b >= 0xe0) return b - 256;

      switch (b) {
        case 0xc0: return null;          // nil
        case 0xc2: return false;         // false
        case 0xc3: return true;          // true
        case 0xc4: return skip(u8());    // bin8
        case 0xc5: return skip(u16());   // bin16
        case 0xc6: return skip(u32());   // bin32
        case 0xc7: return skip(u8() + 1);  // ext8
        case 0xc8: return skip(u16() + 1); // ext16
        case 0xc9: return skip(u32() + 1); // ext32
        case 0xca: { check(4); const v = view.getFloat32(pos); pos += 4; return v; }
        case 0xcb: { check(8); const v = view.getFloat64(pos); pos += 8; return v; }
        case 0xcc: return u8();          // uint8
        case 0xcd: return u16();         // uint16
        case 0xce: return u32();         // uint32
        case 0xcf: { check(8); const hi = u32(), lo = u32(); return hi * 0x100000000 + lo; }
        case 0xd0: return i8();          // int8
        case 0xd1: return i16();         // int16
        case 0xd2: return i32();         // int32
        case 0xd3: { check(8); pos += 8; return 0; } // int64 — skip, not needed
        case 0xd4: return skip(2);       // fixext1
        case 0xd5: return skip(3);       // fixext2
        case 0xd6: return skip(5);       // fixext4
        case 0xd7: return skip(9);       // fixext8
        case 0xd8: return skip(17);      // fixext16
        case 0xd9: return str(u8());     // str8
        case 0xda: return str(u16());    // str16
        case 0xdb: return str(u32());    // str32
        case 0xdc: return readArr(u16()); // array16
        case 0xdd: return readArr(u32()); // array32
        case 0xde: return readMap(u16()); // map16
        case 0xdf: return readMap(u32()); // map32
        default:   return null;
      }
    }

    try { return read(); } catch { return null; }
  }

  /**
   * Parse a msgpack-encoded socket.io packet (cpjourney.net).
   * Expected structure: { type: 2, data: ["message", {action, args}], nsp: "/" }
   * Returns the inner Yukon {action, args} or null.
   */
  function parseMsgpackSocketIOFrame(buf) {
    const packet = decodeMsgpack(buf);
    if (!packet || typeof packet !== 'object') return null;
    // socket.io EVENT type = 2
    if (packet.type !== 2) return null;
    const data = packet.data;
    if (!Array.isArray(data) || data.length < 2) return null;
    // data[0] is the event name, data[1] is the payload
    const eventName = data[0];
    const payload   = data[1];
    if (typeof eventName !== 'string' || !payload || typeof payload !== 'object') return null;
    return { eventName, payload };
  }

  // ─── Layer 1: crypto.subtle hook ──────────────────────────────────────────
  // newcp.net encrypts every socket.io message payload with AES before sending
  // and decrypts it on receipt. By intercepting at the crypto boundary we get
  // clean plaintext regardless of the encryption scheme used.

  (function patchCrypto() {
    // cpjourney.net does NOT use crypto — skip to avoid triggering bot protection
    if (location.hostname === 'play.cpjourney.net' || location.hostname === 'cpjourney.net') {
      console.debug('[CP Chat Log] crypto.subtle hook skipped (not needed on cpjourney)');
      return;
    }

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

  // ─── Layer 2a: WebSocket prototype hooks (newcp.net ONLY) ────────────────
  // Modifies WebSocket.prototype — fine on newcp.net which has no hCaptcha,
  // but would trigger bot-detection on cpjourney.net, so we skip it there.

  (function patchWebSocket() {
    if (IS_CPJOURNEY) return; // cpjourney uses Layer 2b instead

    const WSProto = WebSocket.prototype;
    if (!WSProto) return;

    function handleRawFrame(data, direction) {
      if (typeof data === 'string') {
        const parsed = parseSocketIOTextFrame(data);
        if (parsed) {
          processSocketIOEvent(parsed.eventName, parsed.payload, direction, data);
        }
      }
    }

    function processSocketIOEvent(eventName, payload, direction, rawText) {
      if (eventName === 'message' && payload && typeof payload.action === 'string') {
        handleYukonAction(payload.action, payload.args || {}, direction, rawText);
      } else {
        handleYukonAction(eventName, payload || {}, direction, rawText);
      }
    }

    const _origSend = WSProto.send;
    WSProto.send = function (data) {
      try { handleRawFrame(data, 'out'); } catch { /* ignore */ }
      return _origSend.call(this, data);
    };

    const _origAddEL = WSProto.addEventListener;
    WSProto.addEventListener = function (type, listener, ...rest) {
      if (type === 'message' && typeof listener === 'function') {
        const wrapped = function (evt) {
          try { handleRawFrame(evt.data, 'in'); } catch { /* ignore */ }
          return listener.call(this, evt);
        };
        return _origAddEL.call(this, type, wrapped, ...rest);
      }
      return _origAddEL.call(this, type, listener, ...rest);
    };

    const _onmsgDesc = Object.getOwnPropertyDescriptor(WSProto, 'onmessage');
    if (_onmsgDesc && _onmsgDesc.set) {
      const _origSet = _onmsgDesc.set;
      const _origGet = _onmsgDesc.get;
      Object.defineProperty(WSProto, 'onmessage', {
        get: _origGet,
        set: function (fn) {
          if (typeof fn === 'function') {
            const wrapped = function (evt) {
              try { handleRawFrame(evt.data, 'in'); } catch { /* ignore */ }
              return fn.call(this, evt);
            };
            _origSet.call(this, wrapped);
          } else {
            _origSet.call(this, fn);
          }
        },
        configurable: true,
        enumerable: _onmsgDesc.enumerable,
      });
    }

    console.debug('[CP Chat Log] WebSocket prototype hooks installed (newcp mode)');
  })();

  // ─── Layer 2b: stealth EventTarget hook (cpjourney.net ONLY) ─────────────
  // hCaptcha on cpjourney detects modifications to WebSocket.prototype.
  // Instead, we hook EventTarget.prototype.addEventListener (a generic API
  // that many libraries legitimately modify — unlikely to be fingerprinted)
  // and use Function.prototype.toString masking to make our patches invisible.
  // When socket.io adds its 'message' listener to a WebSocket instance, we
  // detect it and piggyback our own listener + send wrapper on that instance.

  (function interceptViaEventTarget() {
    if (!IS_CPJOURNEY) return;

    // ── toString masking: make patched functions report [native code] ──
    const _fnToStr   = Function.prototype.toString;
    const _masked    = new WeakMap();

    Function.prototype.toString = function () {
      const native = _masked.get(this);
      return native !== undefined ? native : _fnToStr.call(this);
    };
    _masked.set(Function.prototype.toString, _fnToStr.call(_fnToStr));

    // ── Msgpack decode queue (reused from earlier definition) ──
    const _msgpackQueue     = [];
    let   _msgpackScheduled = false;

    function drainMsgpackQueue() {
      _msgpackScheduled = false;
      const batch = _msgpackQueue.splice(0, _msgpackQueue.length);
      for (const { buf, direction } of batch) {
        try {
          const parsed = parseMsgpackSocketIOFrame(buf);
          if (parsed) processEvent(parsed.eventName, parsed.payload, direction);
        } catch { /* not parseable */ }
      }
    }

    function processEvent(eventName, payload, direction, rawText) {
      if (eventName === 'message' && payload && typeof payload.action === 'string') {
        handleYukonAction(payload.action, payload.args || {}, direction, rawText);
      } else {
        handleYukonAction(eventName, payload || {}, direction, rawText);
      }
    }

    function handleRawFrame(data, direction) {
      // Text frames (standard socket.io JSON)
      if (typeof data === 'string') {
        const parsed = parseSocketIOTextFrame(data);
        if (parsed) processEvent(parsed.eventName, parsed.payload, direction, data);
        return;
      }
      // Binary frames (msgpack-encoded socket.io) — queue for async decode
      try {
        const buf = data instanceof ArrayBuffer ? data
                  : data.buffer instanceof ArrayBuffer ? data.buffer
                  : null;
        if (!buf || buf.byteLength > 8192) return;
        _msgpackQueue.push({ buf: buf.slice(0), direction });
        if (!_msgpackScheduled) {
          _msgpackScheduled = true;
          setTimeout(drainMsgpackQueue, 0);
        }
      } catch { /* ignore */ }
    }

    // ── Helper: hook a WebSocket instance the first time we see it ──
    function hookWSInstance(ws) {
      if (ws.__cpclHooked) return;
      ws.__cpclHooked = true;
      console.debug('[CP Chat Log] WebSocket instance detected — attaching listeners');

      // Wrap send() on this specific instance (WebSocket.prototype.send untouched)
      const _instanceSend = ws.send.bind(ws);
      ws.send = function (data) {
        try { handleRawFrame(data, 'out'); } catch { /* ignore */ }
        return _instanceSend(data);
      };
    }

    // ── Hook 1: EventTarget.prototype.addEventListener ──
    // Catches socket.io versions that use addEventListener('message', fn).
    const _origAEL = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === 'message' && this instanceof WebSocket) {
        hookWSInstance(this);
        // Also wrap this listener to capture incoming frames
        if (typeof listener === 'function') {
          const origListener = listener;
          listener = function (evt) {
            try { handleRawFrame(evt.data, 'in'); } catch { /* ignore */ }
            return origListener.call(this, evt);
          };
        }
      }
      return _origAEL.call(this, type, listener, options);
    };
    _masked.set(EventTarget.prototype.addEventListener, _fnToStr.call(_origAEL));

    // ── Hook 2: WebSocket.prototype onmessage setter ──
    // engine.io-client v6 uses `ws.onmessage = fn` (not addEventListener).
    // We intercept the setter to wrap the handler and hook the instance.
    const _onmsgDesc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    if (_onmsgDesc && _onmsgDesc.set) {
      const _origSet = _onmsgDesc.set;
      const _origGet = _onmsgDesc.get;

      const maskedSet = function (fn) {
        if (this instanceof WebSocket) {
          hookWSInstance(this);
        }
        if (typeof fn === 'function') {
          const origFn = fn;
          const wrapped = function (evt) {
            try { handleRawFrame(evt.data, 'in'); } catch { /* ignore */ }
            return origFn.call(this, evt);
          };
          return _origSet.call(this, wrapped);
        }
        return _origSet.call(this, fn);
      };

      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        get: _origGet,
        set: maskedSet,
        configurable: true,
        enumerable: _onmsgDesc.enumerable,
      });
      _masked.set(maskedSet, _fnToStr.call(_origSet));
    }

    console.debug('[CP Chat Log] stealth hooks installed (cpjourney mode)');
  })();

  // ─── Layer 3: DOM MutationObserver (newcp.net only) ─────────────────────
  // cpjourney renders chat in Phaser canvas, not DOM, so this is useless there.

  (function observeDOM() {
    if (IS_CPJOURNEY) return;

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

  // ─── Expose data for panel.js ────────────────────────────────────────────

  window.__cpChatLog_friends       = friendList;
  window.__cpChatLog_ignored       = ignoreList;
  window.__cpChatLog_saveFriends   = () => saveSet(STORAGE_KEY_FRIENDS, friendList);
  window.__cpChatLog_saveIgnored   = () => saveSet(STORAGE_KEY_IGNORED, ignoreList);
  window.__cpChatLog_playerRegistry = playerRegistry;

  // ─── Debug helper ─────────────────────────────────────────────────────────

  window.cpChatLogDebug = function () {
    const events    = window.__cpChatLog_events    || [];
    const frames    = window.__cpChatLog_rawFrames  || [];
    const decrypted = window.__cpChatLog_decrypted  || [];

    console.group('[CP Chat Log] Debug snapshot');
    console.log(`Mode: ${IS_CPJOURNEY ? 'cpjourney (socket.io intercept)' : 'newcp (crypto + WS hooks)'}`);
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

  console.debug(`[CP Chat Log] Hook loaded (${IS_CPJOURNEY ? 'cpjourney' : 'newcp'} mode)`);
})();
