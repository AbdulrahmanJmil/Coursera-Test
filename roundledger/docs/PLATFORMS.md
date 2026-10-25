# Platform adapters

| Platform | Adapter | Event map | Verified against live traffic | Default |
|---|---|---|---|---|
| MelBet (crash game 371) | `shared/adapters/melbet.js` | Yes, from third-party observation | **No** | enabled, marked *unverified* |
| 1xBet | `shared/adapters/onexbet.js` | **None** | **No** | disabled, *not configured* |

## How collection works

1. The user grants Chrome host access to the platform's game origin (runtime permission; nothing is requested at install).
2. The extension registers two content scripts for the configured page patterns: a MAIN-world hook that
   **passively** listens to WebSocket messages (it never sends, blocks or modifies anything), and an isolated relay.
3. Only frames from sockets whose URL contains the configured `socketUrlContains` are forwarded.
4. The adapter parses SignalR JSON hub frames and maps invocation targets to events
   (`round_open`, `betting`, `running`, `crashed`, `snapshot`).
5. `shared/round-tracker.js` turns events into round records:
   - a round is recorded only when its id was observed (crash events without a known round are logged and dropped, never guessed);
   - duplicates (repeated crash frames, reconnect history) are ignored by round id;
   - stale `round_open` events for already-recorded rounds are ignored;
   - history snapshots are imported only if each row carries its own round id.
6. Records go to local extension storage (5,000 per platform) and, if the plan includes cloud history, sync to the server, which de-duplicates again on `(user, platform, round_key)`.

## MelBet event map (unverified)

Taken from facts in a public third-party userscript, not from this project's own observation:
socket URL contains `sockets/crash`; SignalR JSON protocol; `OnStage` (field `l` = round id),
`OnBetting`, `OnStart`, `OnCrash` (field `f` = crash multiplier), `OnRegistration` (field `l`; its
history list `h` has multipliers but no round ids, so it is not imported). The test fixture
`shared/test/fixtures/melbet-synthetic-frames.json` is **synthetic**, hand-written to that description.

## Verifying a platform (authorized environment only)

1. Check that using a companion tool is allowed by the platform's terms and your local law.
2. Open the game in Chrome DevTools → Network → WS, select the game socket, and record a few rounds.
3. Confirm the socket URL, the invocation targets and the field names for round id and multiplier.
4. Edit the platform in **Dashboard → Settings → Supported platforms** (page patterns, socket filter, events).
5. Watch the extension's live log for "round … recorded" lines and compare several values with the game's own history.
6. Only then set `"verified": true`. The extension then shows *VERIFIED ADAPTER* instead of *UNVERIFIED ADAPTER*.

Adapter configuration is served by the backend, so fixes do not require a new extension build.
Supporting a different wire protocol (e.g. MessagePack) does require code in the adapter.
