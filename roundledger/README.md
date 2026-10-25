# RoundLedger

Round history, statistics and session tracking for crash games, delivered as a Chrome extension with a
licensing backend, an admin dashboard and a Windows installer. RoundLedger is read-only: it never
places bets and does not predict outcomes. *RoundLedger is a provisional working name.*

| Part | Path | Status |
|---|---|---|
| Backend API (auth, licensing, devices, sync, AI, admin) | `server/` | implemented, automated tests |
| Admin dashboard | `admin/` (served at `/admin/`) | implemented, browser-tested |
| Chrome extension (MV3 side panel) | `extension/`, `shared/` | implemented, browser-tested with synthetic game traffic |
| Gemini integration (server-side) | `server/src/providers/gemini.js` | implemented, tested against a fake endpoint only |
| MelBet adapter | `shared/adapters/melbet.js` | implemented, **unverified** against the live site |
| 1xBet adapter | `shared/adapters/onexbet.js` | **not configured** (no verified event map) |
| Windows installer | `installer/windows/` | builds; **not yet run on Windows** |

## Quick start (local)

```bash
cd roundledger                          # Node 22.13+ required, no npm install needed
npm test                                # 93 automated tests
npm run create-admin -- admin@example.com
npm run seed-plans                      # optional example plans (inactive, price 0)
APP_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm start
# dashboard: http://127.0.0.1:8787/admin/
npm run build:extension                 # → dist/extension (load unpacked in Chrome)
```

## Build deliverables

```bash
npm run build:icons                                           # optional: regenerate icons (Playwright + Pillow)
ROUNDLEDGER_BACKEND_URL=https://api.example.com npm run release
# → dist/release/<version>/RoundLedger-Setup-<version>.exe, roundledger-extension-<version>.zip, SHA256SUMS.txt
npm run test:ui                                               # browser suites (Playwright Chromium)
```

## Documentation

- [Implementation report](docs/IMPLEMENTATION-REPORT.md): what was built, test results, blockers
- [Deployment & maintenance](docs/DEPLOYMENT.md)
- [Administrator guide](docs/ADMIN-GUIDE.md)
- [Customer installation & distribution strategy](docs/INSTALLATION.md)
- [Architecture & security](docs/ARCHITECTURE.md)
- [Platform adapters](docs/PLATFORMS.md)
- [Analysis methodology](docs/ANALYSIS.md)
- [Testing](docs/TESTING.md)
- [Licensing & legal review](docs/LEGAL-AND-LICENSING.md)
- [Naming](docs/NAMING.md) · [Brand](branding/BRAND.md)
