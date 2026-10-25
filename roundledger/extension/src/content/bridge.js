// Isolated-world relay: forwards frames from sockets that match an enabled
// platform's socket filter to the service worker. Everything else is dropped here.
(() => {
  if (window.__roundledgerBridge) return;
  window.__roundledgerBridge = true;
  let filters = [];
  const load = () => chrome.storage.local.get('publicConfig').then(({ publicConfig }) => {
    filters = (publicConfig?.platforms || []).filter((p) => p.enabled && p.socketUrlContains).map((p) => p.socketUrlContains);
  }).catch(() => {});
  load();
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.publicConfig) load(); });

  document.addEventListener('roundledger:ws', (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (!msg || typeof msg.url !== 'string' || !filters.some((f) => msg.url.includes(f))) return;
    chrome.runtime.sendMessage({ type: 'ws', kind: msg.kind, socketUrl: msg.url, data: msg.kind === 'frame' ? msg.data : undefined, pageUrl: location.href })
      .catch(() => { /* service worker restarting; frame dropped */ });
  });
})();
