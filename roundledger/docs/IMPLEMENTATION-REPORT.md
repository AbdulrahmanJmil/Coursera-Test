# Implementation report: RoundLedger 0.1.0

Date: 2026-10-25. Branch: `claude/new-session-98slrv` of `abdulrahmanjmil/coursera-test`, directory `roundledger/`.

## 1. Audit of the starting point

The referenced repository `dinethlive/crash-game-RAG` contained five files: a 1,256-line Tampermonkey
userscript, README, LICENSE, screenshot and `.gitignore`. No Manus reports, handoff documents or tests existed.

| Requested capability | State found |
|---|---|
| Chrome extension | Missing (userscript only) |
| Backend, database, auth, subscriptions, licensing, devices, admin dashboard | Missing |
| Gemini integration | Implemented insecurely: API key in page `localStorage`, sent in the URL from the browser |
| Prediction | KNN + LLM "prediction", self-reported "confidence %", BET/SKIP advice. Unvalidated; not carried over |
| MelBet collection | Implemented in the userscript (SignalR over WebSocket), unverified |
| 1xBet | Missing |
| Installer, branding, tests, docs | Missing |
| License | "MIT" with added **personal-use-only, no commercial use, no gambling** conditions → code not reusable |

Decision (agreed with the owner): clean-room implementation with honest positioning (history, statistics,
session tracking; no predictions, no auto-bet).

## 2. What was implemented

**Backend** (`server/`, Node 22, zero npm dependencies, SQLite):
email/password accounts (scrypt), extension Bearer sessions and dashboard cookie sessions, lockout and
rate limits, server-computed entitlements, plans, paid subscriptions (stacking, renew, expiry change,
suspend, revoke), configurable trials (one per account and per installation), activation codes (hashed,
single-use under concurrency, assignable, expiring, revocable), device registration and limits
(self-replacement with cooldown, admin revoke/restore/reassign), round sync with de-duplication and caps,
server statistics, AI explanations through a provider registry (Gemini) with encrypted key storage, usage
accounting, per-user and global caps, maintenance mode, client error reporting, an audit log, health checks,
and versioned migrations. CLI: `create-admin`, `seed-plans`.

**Admin dashboard** (`admin/`): overview, users (search, filter, paging, detail, suspend, reactivate,
unlock, reset password, sign-out-everywhere, grant subscription), subscriptions, plans, activation codes
(generate once and download CSV, assign, revoke), devices, AI providers (write-only key, live model list,
config, free key test, confirmed generation test, usage, errors), settings (maintenance, branding,
registration, trial, licensing, usage, extension versions, platform adapters), audit log and client errors.

**Chrome extension** (`extension/`, MV3 side panel, Chrome 116+): sign-in and registration,
device-limit replacement flow, licence screen (trial, activation code, plans), runtime per-site permission,
passive WebSocket observation, MelBet/1xBet adapters, round tracker, local history (5,000 per platform),
cloud sync, local statistics, compact distribution, recent results, "is it due?" pattern check, AI
explanation, a live log of real events only, a session timer with a break reminder, settings (account,
devices, page access, data, diagnostics), offline, maintenance and update banners, and a decorative header
animation that respects reduced motion. No auto-bet or betting controls exist; the build fails if
betting-automation terms appear.

**Branding** (`branding/`): provisional name RoundLedger, original logo (SVG), extension PNGs 16–128,
Windows `.ico` 16–256, NSIS header and wizard bitmaps.

**Windows installer** (`installer/windows/`): per-user NSIS installer with Windows 10+ check, Chrome
detection and version check, a missing-Chrome message with download link, a notice page, clean upgrade,
checksums with a PowerShell verifier, a setup guide in Chrome, Start-menu shortcuts and an uninstaller.

**Release tooling** (`scripts/`): extension build (version stamping, pinned extension ID, https
enforcement, secret/automation scan, checksums, zip), installer build, release packaging, icon generation,
and two Playwright browser suites.

## 3. Tests executed

| Suite | Result |
|---|---|
| `npm test` (unit + API integration + build + packaging) | **93 passed, 0 failed** |
| `npm run test:ui`, extension suite | **10 passed, 0 failed** |
| `npm run test:ui`, dashboard suite | **12 passed, 0 failed** |
| Release build `ROUNDLEDGER_BACKEND_URL=https://api.example.com npm run release` | succeeded |

Details and the list of manual tests: `TESTING.md`. Screenshots: `docs/screenshots/`.

## 4. Status of key questions

| Question | Answer |
|---|---|
| Does the extension build? | Yes, with manifest validation, and loads and runs in Chromium |
| Does the backend build and run? | Yes, `npm start`; health and dashboard verified |
| Does the admin dashboard work? | Yes, browser-tested end to end against the real backend |
| Gemini tested with real credentials? | **No.** Tested against a local fake implementing the documented API; no key was available and calls may be billed |
| Windows installer built? | **Yes** (`dist/RoundLedger-Setup-0.1.0.exe`, contents verified) |
| Windows installer tested on Windows? | **No.** Never executed on Windows |
| Platform integrations verified? | **None.** MelBet is implemented from third-party observations and exercised only with synthetic frames; 1xBet has no event map |
| Prediction | Intentionally not implemented; see `ANALYSIS.md` |
| Commercially cleared? | **No.** See `LEGAL-AND-LICENSING.md` |

## 5. Remaining blockers and unverified items

1. **Live platform verification** (MelBet, 1xBet) in an authorized environment, including a terms-of-service check.
2. **Gemini with a real key**: run the dashboard tests and one analysis.
3. **Windows test pass** of the installer and the load-unpacked flow (see `TESTING.md`).
4. **Code-signing certificate** for the installer (SmartScreen).
5. **Legal review**: gambling-advertising and consumer law per market, operator ToS, privacy policy, EULA, trademark search.
6. **Not built** (no service chosen): payment processing, email (verification, self-service password reset).
7. Local recording and statistics are gated by a cached licence in the extension and can be bypassed by a modified extension. Cloud history, AI and admin functions are enforced server-side.

## 6. What you must provide before commercial use

- A production host with HTTPS, a persistent disk and backups; set `APP_ENCRYPTION_KEY`, `PUBLIC_BASE_URL`, `EXTENSION_ORIGINS`.
- An admin account (`npm run create-admin`), real plan prices, and support contact details in Settings.
- A Gemini API key (paid tier recommended for data-handling terms) entered in the dashboard.
- Verified platform event maps, or keep the platforms marked unverified.
- An Authenticode certificate; a EULA and privacy policy; legal sign-off.
- A sales channel for activation codes.

## 7. Commands

```bash
cd roundledger
npm test                                    # automated tests
npm run test:ui                             # browser suites (Playwright Chromium)
npm run create-admin -- you@example.com
npm start                                   # http://127.0.0.1:8787/admin/
npm run build:extension                     # dist/extension, dist/roundledger-extension-<v>.zip
ALLOW_LOCAL_BACKEND=1 npm run build:installer   # local test installer
ROUNDLEDGER_BACKEND_URL=https://api.example.com npm run release   # dist/release/<v>/
```

The release package was generated in the build environment at `roundledger/dist/release/0.1.0/`
(built for the placeholder backend `https://api.example.com`). `dist/` is not committed; rebuild with your
real backend URL.
