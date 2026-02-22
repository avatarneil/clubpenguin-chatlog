# Reverse Engineering Notes: Yukon-based CP Servers

> Brain-dump of everything discovered while building the CP Chat Log extension.
> Covers both **newcp.net** and **cpjourney.net**. Not exhaustive — reflects
> observations from live traffic and open-source code.

---

## 1. Stack Overview

### newcp.net

| Layer | Technology | Notes |
|---|---|---|
| Frontend framework | Next.js (App Router) | Game served at `/play` |
| Game engine | Phaser 4 | Canvas-rendered, no DOM chat nodes |
| Flash emulator | Ruffle (WASM) | Legacy Flash content only |
| Network | Socket.io v3 + Engine.io v4 | Single persistent WS connection |
| Encryption | AES via `crypto.subtle` | All payloads encrypted; see §3 |
| Bundler | webpack 5 | Chunk array: `webpackChunkncp` |
| Game client base | **Yukon** (open-source) | See §4 |
| Bot protection | None observed | Direct API patching works fine |

### cpjourney.net

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Custom | Game served at `play.cpjourney.net` (subdomain) |
| Game engine | Phaser 4.0.0-rc.5 | Canvas-rendered, no DOM chat nodes |
| Network | Socket.io + Engine.io | Single persistent WS connection |
| Serialization | **msgpack** (`socket.io-msgpack-parser`) | Binary frames, no encryption |
| Bundler | webpack 5 | Chunk array: `webpackChunkyukon` |
| Game client base | **Yukon** (open-source) | See §4 |
| Bot protection | **hCaptcha + Cloudflare** | Detects native API tampering; see §8 |

Both clients self-identify in the console:
```
Yukon Client https://github.com/wizguin/yukon
```

---

## 2. Transport Layer

### WebSocket / Engine.io

One WebSocket connection is maintained for the entire session. All game traffic flows through it. Engine.io uses its own framing on top of the raw WS frames.

### Socket.io Event Model

Vanilla Yukon uses multiple named socket.io events (`sendSafeMessage`, `sendPhraseChatMessage`, etc.). **Both newcp.net and cpjourney.net override this.** Instead, every payload — in both directions — is sent as a single socket.io event named `"message"`:

```
// On the wire (before encryption/encoding):
["message", {"action": "<action_name>", "args": {...}}]
```

The two servers differ in how this event is serialized on the wire:

| Server | Wire format | Frame type |
|---|---|---|
| newcp.net | `42["message", "<base64-AES-ciphertext>"]` | Text (JSON) |
| cpjourney.net | msgpack-encoded socket.io packet | Binary (ArrayBuffer) |

---

## 3. Encryption & Serialization

### newcp.net — AES Encryption

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

### cpjourney.net — Msgpack Serialization (No Encryption)

cpjourney.net uses `socket.io-msgpack-parser` instead of the default JSON parser. All WebSocket frames are **binary ArrayBuffers** (only engine.io ping/pong `"2"`/`"3"` are text). There is no encryption.

The msgpack-encoded socket.io packet structure:

```js
{
  type: 2,          // socket.io EVENT type
  data: ["message", { action: "send_message", args: { message: "hi", id: 42 } }],
  options: { compress: true },
  nsp: "/"
}
```

We decode these frames using a custom minimal msgpack decoder that handles the subset used by socket.io-msgpack-parser (maps, arrays, strings, integers, floats, booleans, null, bin/ext). Safety limits: max depth 10, max collection size 1000, frame size cap 8 KB.

---

## 4. Yukon Protocol (Shared)

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
| `send_joke` | in/out | Joke. `args.joke` = integer ID. (newcp.net) |
| `send_tour` | in/out | Tour guide speech. `args.message` = string. (newcp.net) |
| `give_tour` | in/out | Tour guide speech. `args.message` = string. (cpjourney.net) |
| `send_stage` | in/out | Stage performance. `args.message` = string. (cpjourney.net) |

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

### Host-Specific Interception Strategies

The extension detects which server it's running on (`IS_CPJOURNEY` flag) and uses different interception strategies accordingly:

#### newcp.net — Direct API Patching

No bot protection, so we freely patch native APIs:

1. **Layer 1 (primary): `crypto.subtle` hook** — Intercepts `decrypt()` and `encrypt()` to capture plaintext before/after AES.
2. **Layer 2 (debug): `WebSocket.prototype` hooks** — Patches `.send()`, `.addEventListener()`, and the `.onmessage` setter at the prototype level. Captures raw frames for debugging.
3. **Layer 3 (fallback): DOM MutationObserver** — Watches `#cp_html` or `document.body` for Phaser DOMElement chat nodes. Rarely fires since chat is canvas-rendered.

#### cpjourney.net — Stealth Hooks with toString Masking

hCaptcha + Cloudflare detect modifications to browser-native APIs (see §8). We use a combination of `Function.prototype.toString` masking and strategic hook placement to remain invisible:

1. **`Function.prototype.toString` masking** — A `WeakMap` maps each patched function to the original's `.toString()` output. Any code (including bot detection) calling `.toString()` on our patches sees `function send() { [native code] }`.

2. **`EventTarget.prototype.addEventListener` hook** — A generic API that many libraries legitimately modify. Detects when socket.io adds a `message` listener to a WebSocket instance. Less likely to be fingerprinted than `WebSocket.prototype` methods.

3. **`WebSocket.prototype.onmessage` setter hook** — engine.io-client v6 uses `ws.onmessage = fn` (not `addEventListener`). We intercept the property descriptor's setter to wrap incoming message handlers. Masked via toString.

4. **Per-instance `send()` wrapping** — When we detect a WebSocket instance in use (via hooks 2 or 3), we wrap `.send()` on that specific instance only. **`WebSocket.prototype.send` is never modified**, so iframe-based comparison checks pass.

5. **Async msgpack decode queue** — Binary frames are copied (`buf.slice(0)`) and decoded via `setTimeout(0)` to avoid blocking Phaser's render loop.

6. **No crypto.subtle modification** — cpjourney uses no encryption; skipped entirely.
7. **No DOM MutationObserver** — cpjourney renders chat in Phaser canvas, not DOM.

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

## 8. Anti-Bot Detection (cpjourney.net)

cpjourney.net loads **hCaptcha** (`https://hcaptcha.com/1/api.js`) and **Cloudflare Insights** (`https://static.cloudflareinsights.com/beacon.min.js`). These scripts fingerprint the browser environment and detect modifications to native APIs.

### What Triggers Detection (Causes Page Crash/Freeze)

Any of the following, without toString masking, cause the page to freeze immediately — even pre-login before any WebSocket connections exist:

- Modifying `crypto.subtle.decrypt` or `.encrypt`
- Modifying `WebSocket.prototype.send`
- Modifying `WebSocket.prototype.addEventListener`
- Replacing `window.WebSocket` constructor (including via `Proxy`)

The detection is string-based: the bot protection calls `.toString()` on native functions and checks that the result contains `[native code]`. Replacing a native function with a JS wrapper changes the toString output to reveal the wrapper's source code.

### How We Evade Detection

**`Function.prototype.toString` masking** — We patch `Function.prototype.toString` itself (before any page scripts run) to consult a `WeakMap<Function, string>`. Each function we patch is registered in the map with the original native function's toString output. When bot detection calls `.toString()` on our patches, the masked toString returns the original `[native code]` string.

```js
const _fnToStr = Function.prototype.toString;
const _masked  = new WeakMap();

Function.prototype.toString = function () {
  const native = _masked.get(this);
  return native !== undefined ? native : _fnToStr.call(this);
};
// Mask the toString patch itself
_masked.set(Function.prototype.toString, _fnToStr.call(_fnToStr));
```

This also handles `Function.prototype.toString.call(fn)` and `Reflect.apply(Function.prototype.toString, fn, [])` since both go through our patched toString with the correct `this`.

### Detection Vectors Considered

| Vector | Status | Notes |
|---|---|---|
| `fn.toString()` | **Defeated** | WeakMap masking returns native string |
| `Function.prototype.toString.call(fn)` | **Defeated** | Goes through our patched toString |
| `typeof fn` | **Not an issue** | Our wrappers are functions |
| iframe comparison (`fn !== iframe.contentWindow.X.prototype.fn`) | **Mitigated** | We don't modify `WebSocket.prototype.send`; per-instance wrapping only |
| `navigator.webdriver` | **Not relevant** | We're not a bot framework |

### Why newcp.net Doesn't Need This

newcp.net has no hCaptcha or Cloudflare bot detection. Direct prototype patching works without any masking.

---

## 9. What We Don't Know Yet

- **AES key exchange** — How the session key is established. Likely via a handshake in the first few messages after connect. Not yet captured/analyzed.
- **Safe chat message lookup table** — `send_safe` uses an integer index into a predefined list of approved phrases. The list lives somewhere in the client bundle or is fetched from the server.
- **Emote / joke ID tables** — Same situation; integer IDs map to specific emotes/jokes.
- **Server-specific actions** — Actions added on top of base Yukon that aren't in the open-source repo (private server features, seasonal events, etc.).
- **Igloo owner resolution** — Given an igloo room ID (≥ 2000), we can compute the penguin ID but don't yet correlate it to a username in real-time.
- **Complete auth flow** — The exact sequence of messages from socket connect → usable session (which message carries the AES key, token format, etc.).
- **cpjourney.net webpack internals** — The socket.io instance is entirely internal to the `webpackChunkyukon` bundle. It is not reachable from `window` — confirmed by recursive search up to 6 levels deep. Our interception works at the WebSocket transport level instead.
