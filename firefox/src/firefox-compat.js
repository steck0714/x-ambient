// Firefox build only: use the Promise-based `browser` API through the `chrome` name,
// so the shared code (chrome.storage.local.get(...).then(...)) runs unchanged.
(() => {
  "use strict";
  try {
    if (typeof browser !== "undefined" && browser.storage) globalThis.chrome = browser;
  } catch {
    // Keep the native `chrome` namespace.
  }
})();
