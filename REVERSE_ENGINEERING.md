# Reverse Engineering Notes: newcp.net / Yukon CP Client

> Brain-dump of everything discovered while building the CP Chat Log extension.
> Not exhaustive — reflects observations from live traffic and open-source code.

---

## 1. Stack Overview

| Layer | Technology | Notes |
|---|---|---|
| Frontend framework | Next.js (App Router) | Game served at `/play` |
| Game engine | Phaser 4 | Canvas-rendered, no DOM chat nodes |
| Flash emulator | Ruffle (WASM) | Legacy Flash content only |
| Network | Socket.io v3 + Engine.io v4 | Single persistent WS connection |
| Bundler | webpack 5 | Chunk array: `webpackChunkncp` |
| Game client base | **Yukon** (open-source) | See §3 |

The game client self-identifies in the console:
```
Yukon Client https://github.com/wizguin/yukon
```

---

## 2. Transport Layer

### WebSocket / Engine.io

One WebSocket connection is maintained for the entire session. All game traffic flows through it. Engine.io uses its own framing on top of the raw WS frames (e.g. `42[...]` for socket.io message events).

### Socket.io Event Model

Vanilla Yukon uses multiple named socket.io events (`sendSafeMessage`, `sendPhraseChatMessage`, etc.). **newcp.net does not.** Instead, every payload — in both directions — is sent as a single socket.io event named `"message"`:

```
42["message", "<base64-AES-ciphertext>"]
```

This means filtering by event name is useless. The only way to read the payload is to intercept at the crypto layer.

---

## 3. Encryption Layer

newcp.net adds a symmetric AES encryption layer on top of the base Yukon protocol. Every socket.io payload (both inbound and outbound) is:

1. Serialized to JSON
2. Encrypted with AES (CBC or GCM — key negotiated at session init)
3. Base64-encoded
4. Sent as the sole argument to the `"message"` socket.io event

The Web Crypto API (`window.crypto.subtle`) is used for all crypto operations. This means we can intercept plaintext by hooking:

- `crypto.subtle.decrypt` → captures **incoming** messages after decryption
- `crypto.subtle.encrypt` → captures **outgoing** messages before encryption

Because these are async functions on `window.crypto.subtle`, patching them at `document_start` (before any page scripts run) gives us reliable interception with no race condition.

```js
const _origDecrypt = window.crypto.subtle.decrypt.bind(window.crypto.subtle);
window.crypto.subtle.decrypt = async function (algorithm, key, data) {
  const result = await _origDecrypt(algorithm, key, data);
  // result is ArrayBuffer — decode to UTF-8 to get JSON
  handleYukonMessage(new TextDecoder().decode(result), 'in');
  return result;
};
```

---

## 4. Yukon Protocol

### Envelope Format

All messages (after decryption) use the same JSON envelope:

```json
{ "action": "<action_name>", "args": { ... } }
```

`action` is a snake_case string. `args` is an object whose schema varies by action.

### Key Actions Observed

#### Auth / Identity

| Action | Direction | Notes |
|---|---|---|
| `login` | in | Server response after credential auth. `args` (or `args.user`) contains own penguin object with `id`, `username`, `nickname`. |
| `token_login` | out→in | Token-based re-auth. Response same shape as `login`. |
| `game_auth` | in | Seen during session establishment. Also carries own penguin data. |
| `load_player` | in | Full player data load; `args.user` or `args` directly has `id`/`username`. |

**Critical:** outgoing `send_message` carries **no `id` field**. The sender's identity must be captured from auth responses and held in state.

#### Room Management

| Action | Direction | Notes |
|---|---|---|
| `join_room` | in | Server confirms room entry. `args.room` = numeric room ID. `args.users` = array of all penguins currently in the room. |
| `add_player` | in | A penguin entered the room after you. `args.user` or `args` is the penguin object. |
| `remove_player` | in | Penguin left the room. `args.user` = numeric penguin ID. |

#### Chat

| Action | Direction | Notes |
|---|---|---|
| `send_message` | **out** | Free-text chat. `args.message` = string. **No `id` field** — sender is implicitly you. |
| `send_message` | **in** | Someone else's chat. `args.id` = sender's penguin ID. `args.message` = string. |
| `send_safe` | in/out | Safe-chat message by index. `args.safe` = integer index. Text must be resolved from a lookup table (not yet captured). |
| `send_emote` | in/out | Emote. `args.emote` = integer ID. |
| `send_joke` | in/out | Joke. `args.joke` = integer ID. |
| `send_tour` | in/out | Tour guide speech. `args.message` = string. |

#### Other Actions Seen in the Wild

`heartbeat`, `get_player`, `update_player`, `set_color`, `set_head`, `set_face`, `set_neck`, `set_body`, `set_hand`, `set_feet`, `set_flag`, `set_photo`, `set_frame`, `get_inventory`, `buy_item`, `send_position`, `send_snowball`, `igloo_*`, `get_igloos`, `music_*`, `stamp_*`

---

## 5. Penguin Object Schema

Observed across `join_room.users`, `add_player`, `login`, etc.:

```json
{
  "id": 341,
  "username": "avatarneil",
  "nickname": "Avatarneil",
  "color": 2,
  "head": 0,
  "face": 0,
  "neck": 0,
  "body": 0,
  "hand": 0,
  "feet": 0,
  "flag": 0,
  "photo": 0,
  "x": 760,
  "y": 480,
  "frame": 1,
  "member": false,
  "avatar": null
}
```

- `username` = login name (lowercase)
- `nickname` = display name (title-cased, may differ)
- `id` = stable numeric penguin ID (used as the key in all subsequent references)

---

## 6. Room ID → Name Mapping

Source: `wizguin/yukon-server/data/rooms.json`

### Public Rooms

| ID | Name |
|---|---|
| 100 | Town |
| 110 | Coffee Shop |
| 111 | Book Room |
| 120 | Dance Club |
| 121 | Lounge |
| 130 | Gift Shop |
| 200 | Ski Village |
| 210 | Sport Shop |
| 220 | Ski Lodge |
| 221 | Lodge Attic |
| 230 | Ski Hill |
| 300 | Plaza |
| 310 | Pet Shop |
| 320 | Dojo |
| 321 | Dojo Courtyard |
| 400 | Beach |
| 800 | Dock |
| 801 | Snow Forts |
| 802 | Ice Rink |
| 803 | EPF HQ |
| 805 | Iceberg |
| 806 | Underground Pool |
| 807 | Lighthouse |
| 809 | Forest |
| 810 | Cove |

### Mini-Game / Mission Rooms (900-series)

| ID | Name |
|---|---|
| 900 | Astro-Barrier |
| 901 | Bean Counters |
| 902 | Cattle Roundup |
| 903 | Hydro Hopper |
| 904 | Ice Fishing |
| 907–927 | PSA Missions 1–11 |
| 909 | Thin Ice |
| 912 | Catchin' Waves |
| 916 | Puffle Submarine |
| 951 | Sensei Battle |
| 998 | Card-Jitsu |
| 999 | Sled Racing |

### Special ID Ranges

- **IDs ≥ 2000** — Player igloos. `iglooId = roomId - 2000`. The igloo owner can be resolved from player data if needed.
- **Spawn rooms** — 100, 200, 300, 400, 800, 801, 805 (valid login spawn points per server config).

---

## 7. Interception Architecture

### Why `world: "MAIN"` is Required

Chrome MV3 content scripts run in an isolated world by default — they share the DOM but not the JS heap. `window.crypto.subtle` in the isolated world is a *different object* from the page's `crypto.subtle`. Patching it has no effect on the game.

Setting `"world": "MAIN"` in the manifest makes the content script run in the page's own JS context, sharing the same `window` object. This lets us monkey-patch `crypto.subtle` and `WebSocket` before any page script runs.

### Why `run_at: document_start` is Required

The game establishes its WebSocket and imports the crypto module very early. If the hook script runs even slightly late, the original `crypto.subtle.decrypt` reference is captured by the game's closure before we can patch it, and we miss all traffic.

`document_start` + `world: MAIN` = hook runs synchronously before the first `<script>` tag executes.

### The `bootstrap.js` Dead End

An earlier approach injected `hook.js` via a dynamically-inserted `<script src="chrome-extension://...">` tag. This failed because:
- The `<script src>` element triggers an async fetch (even from `chrome-extension://`)
- By the time the script bytes arrived and executed, the game had already connected to the WebSocket and initialized crypto
- All subsequent traffic used the unpatched originals

Direct `world: MAIN` content script injection from the manifest is synchronous and avoids this entirely.

### `onmessage` Setter Gotcha

Setting `ws.onmessage = fn` on a proxied WebSocket object throws `Illegal invocation` because the native setter expects `this` to be the actual WebSocket instance, not the prototype. Fix:

```js
const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
desc.set.call(ws, wrappedFn); // correct `this`
```

---

## 8. What We Don't Know Yet

- **AES key exchange** — How the session key is established. Likely via a handshake in the first few messages after connect. Not yet captured/analyzed.
- **Safe chat message lookup table** — `send_safe` uses an integer index into a predefined list of approved phrases. The list lives somewhere in the client bundle or is fetched from the server.
- **Emote / joke ID tables** — Same situation; integer IDs map to specific emotes/jokes.
- **newcp.net-specific actions** — Any actions added on top of base Yukon that aren't in the open-source repo (private server features, seasonal events, etc.).
- **Igloo owner resolution** — Given an igloo room ID (≥ 2000), we can compute the penguin ID but don't yet correlate it to a username in real-time.
- **Complete auth flow** — The exact sequence of messages from socket connect → usable session (which message carries the AES key, token format, etc.).
