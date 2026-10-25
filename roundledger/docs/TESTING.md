# Testing

## Automated (run in CI or locally)

| Command | What it covers | Result on 2026-10-25 (Linux, Node 22.22, Chromium 1243, NSIS 3.09) |
|---|---|---|
| `npm test` | 93 tests: shared analysis/adapters/tracker; server auth, authorization, rate limiting, maintenance, trials, codes (incl. concurrent redemption), subscriptions, plans, devices, round sync, admin API, audit, AI provider (missing/invalid key, 429, 5xx, timeout, masking, charge confirmation, limits), config and crypto; extension build and manifest validation; installer packaging | **93 passed, 0 failed** |
| `npm run test:ui` | Two browser suites. (1) Loads the built extension in Chromium against a live in-process backend, a fake Gemini endpoint and a mocked game page and WebSocket sending **synthetic** frames: offline state, registration, licence screen, code activation, live round capture with duplicate handling, cloud sync, AI explanation, settings, server-side revocation, 320 px width, no auto-bet controls. (2) Dashboard: login, plans, code generation, user actions, renew, device revoke/restore, AI key/models/tests, settings, audit, mobile width, logout, no CSP/console errors | **10/10 and 12/12 passed** |
| `npm run build:extension` | Build plus validation (manifest references, no provider keys, no direct provider calls, no betting-automation terms) | passes |
| `npm run build:installer` | NSIS compile; contents verified by unpacking with 7-Zip in the test suite | passes, 172 KB .exe |

The AI tests use a local fake that imitates Gemini's documented responses. **No call was made to
the real Gemini API** (no credentials were provided, and real calls can be billed).

## Manual tests still required

| Area | Why it cannot be automated here | How to test |
|---|---|---|
| Windows installer on Windows 10/11 | Built on Linux; never executed on Windows | Run the .exe on a clean Windows VM with and without Chrome, with an old Chrome, and as a standard (non-admin) user; follow the guide; reinstall over the top (upgrade); uninstall |
| Load unpacked from the installed folder | Needs real Chrome on Windows | Confirm the extension ID matches the build output and the side panel opens |
| Real Gemini key | No authorized key available; real calls may be billed | Dashboard → AI providers → Test key, then Test generation (confirm charges), then an analysis from a customer account with 30+ synced rounds |
| MelBet adapter | Requires access to the live site in an authorized environment | Follow `PLATFORMS.md` → "Verifying a platform"; compare 20+ recorded rounds with the game's own history |
| 1xBet adapter | No event map exists | Same procedure, then enter the map in the dashboard |
| Production deployment | No infrastructure was touched | Deploy behind HTTPS per `DEPLOYMENT.md`; check `/api/health`, cookies are `Secure`, CORS only for the extension ID |
| Code-signed installer | No certificate | Sign, then confirm SmartScreen reputation behaviour |
