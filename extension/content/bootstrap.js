/**
 * bootstrap.js — runs in ISOLATED world at document_start.
 *
 * Injects hook.js into the PAGE context as early as possible (before any
 * game scripts execute) so the WebSocket and webpack chunk proxies are in
 * place before Socket.io initialises.
 */

(function () {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected/hook.js');
  script.async = false; // must run synchronously before other scripts
  (document.head || document.documentElement).appendChild(script);
  script.addEventListener('load', () => script.remove());
})();
