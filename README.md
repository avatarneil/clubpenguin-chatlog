# CP Chat Log

A Chrome extension that captures and persists chat history from Yukon-based Club Penguin private servers across sessions.

## Supported Servers

- [newcp.net](https://newcp.net)
- [cpjourney.net](https://cpjourney.net)

## Features

- Real-time chat capture from in-game WebSocket traffic (read-only — sends nothing, modifies no game state)
- Persistent storage via IndexedDB (survives page reloads and browser restarts)
- Floating in-game panel with search, room filter, and session filter
- Export chat history as plaintext
- Browser action popup with stats and search

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/your-username/clubpenguin-chatlog.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`.

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **Load unpacked** and select the `extension/` directory inside this repository.

5. Navigate to a supported server's game page (e.g. `newcp.net/play` or `play.cpjourney.net`). The chat log toggle button will appear in the bottom-left corner of the page.

## Usage

- Click the chat bubble button (bottom-left) to open the chat log panel.
- Messages appear in real time as players chat in-game.
- Use the search box to filter by username or message text.
- Use the room dropdown to filter by room.
- Check "This session only" to hide messages from previous sessions.
- Click **Export** to download your chat history as a `.txt` file.
- Click the extension icon in the Chrome toolbar for a quick-glance popup with stats and recent messages.

## How It Works

The extension passively observes game traffic — it is strictly **read-only**. It does not send any packets, modify game state, inject chat messages, or interact with game servers in any way. It only reads data that your browser is already receiving.

For technical details on the interception methodology for each server, see [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md).

## Disclaimer

**Use at your own risk.** While this extension is read-only by design and does not modify game behavior or send any data to game servers, the authors make no guarantees about how server operators may view or respond to its use. The authors take no responsibility or liability if your account is restricted, banned, or otherwise actioned as a result of using this extension. YMMV.

## License

[MIT](LICENSE)
