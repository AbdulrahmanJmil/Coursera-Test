// Runs in the page's MAIN world at document_start on pages the user granted.
// It observes WebSocket traffic passively: it never sends, modifies or blocks
// a message, and never touches the page's betting UI.
(() => {
  if (window.__roundledgerHook) return;
  Object.defineProperty(window, '__roundledgerHook', { value: true });
  const Native = window.WebSocket;
  if (typeof Native !== 'function') return;
  const MAX = 256 * 1024;
  const emit = (kind, url, data) => {
    try {
      document.dispatchEvent(new CustomEvent('roundledger:ws', { detail: JSON.stringify({ kind, url, data }) }));
    } catch { /* never break the page */ }
  };
  class ObservedWebSocket extends Native {
    constructor(url, protocols) {
      super(url, protocols);
      const u = String(url);
      this.addEventListener('open', () => emit('open', u));
      this.addEventListener('close', () => emit('close', u));
      this.addEventListener('message', (e) => {
        if (typeof e.data === 'string' && e.data.length <= MAX) emit('frame', u, e.data);
      });
    }
  }
  window.WebSocket = ObservedWebSocket;
})();
