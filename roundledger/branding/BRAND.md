# RoundLedger brand

**Status: provisional working name.** It has not been cleared for trademark use; see `docs/NAMING.md`.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#05080D` | page background (near-black navy) |
| `--panel` | `#0A111B` | panels |
| `--line` | `#16324A` | panel borders |
| `--green` | `#34F08A` | primary accent: status, highlights, the logo |
| `--green-dim` | `#1F8F55` | secondary accent |
| `--text` | `#D7E3EA` | body text |
| `--muted` | `#7C93A3` | secondary text |
| `--warn` | `#F2C14E` | warnings |
| `--danger` | `#FF5D6C` | errors |

Typography: system UI sans for prose, `ui-monospace, "Cascadia Mono", Consolas, monospace` for technical output. No web fonts are loaded, so nothing is fetched from third parties.

Mark: a chamfered square frame (angular panel language) holding three ledger rows, with a dim "cursor" block on the middle row. It stands for a record of rounds, not a chart or a prediction. Source: `logo.svg`. Generated files (`npm run build:icons`):

- `extension/icons/icon{16,32,48,128}.png`: Chrome extension icons
- `installer/windows/assets/roundledger.ico`: Windows application/installer icon (16–256 px)
- `installer/windows/assets/header.bmp` (150×57) and `wizard.bmp` (164×314): NSIS installer bitmaps
- `admin/logo.svg`: dashboard copy of the mark
