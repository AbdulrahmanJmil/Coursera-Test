# RoundLedger Chrome extension

Manifest V3 side-panel extension. Source lives in `src/`; the shared analysis
code in `../shared/` is copied in by the build, so load the **built** folder,
not this one:

```bash
npm run build:extension            # → dist/extension (unpacked) + dist/roundledger-extension-<version>.zip
```

`extension-key.pub.b64` is the public half of an RSA key. It is written into the
manifest's `key` field so the extension ID is identical on every machine, which
lets the backend allow-list it in `EXTENSION_ORIGINS`. The private half was
discarded: it is only needed to sign a `.crx`, which this distribution
does not use. Replacing the file changes the extension ID.

Layout:

| Path | Role |
|---|---|
| `src/background.js` | service worker: auth, license cache, adapters, round tracking, sync |
| `src/api.js` | backend client (bearer token, timeouts, error mapping) |
| `src/content/page-hook.js` | MAIN-world script: passively observes WebSocket frames (never sends) |
| `src/content/bridge.js` | isolated-world relay from the page hook to the service worker |
| `src/panel/*` | side-panel UI |
