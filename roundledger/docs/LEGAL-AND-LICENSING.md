# Licensing and legal review

This is an engineering review, not legal advice. Have a lawyer review it before selling the product.

## The original repository (`dinethlive/crash-game-RAG`)

Its `LICENSE` is labelled MIT but adds conditions that override the usual MIT grant:
1. "Personal Use Only … Commercial use, including … resale, or any business purpose, is strictly prohibited."
3. "Not intended for, and should not be used for, gambling or any activity that involves real money betting."

**Consequence:** none of that repository's code, text or images may be used in this commercial product.
RoundLedger is a clean-room implementation. No code, prompt text, UI, CSS or screenshot was copied. The
only things taken from that project are **facts about the MelBet wire protocol** (socket URL substring,
SignalR target names and two field names), which are observations about a third-party system, not
creative expression. They are isolated in the editable, server-side platform configuration and marked
unverified. If you want zero dependency on that source, re-derive these facts yourself (see `PLATFORMS.md`).

## This product's dependencies

| Component | Where | License | Redistributed to customers? |
|---|---|---|---|
| Node.js runtime (incl. SQLite) | server | MIT (Node), public domain (SQLite) | No (server side) |
| npm runtime dependencies | none | — | — |
| NSIS 3 + Modern UI | installer stub | zlib/libpng license | Yes, inside the .exe (permitted, no attribution required) |
| Playwright + Chromium | tests and icon generation only | Apache-2.0 / BSD | No |
| Python Pillow | icon generation only | HPND (MIT-CMU) | No |

`package.json` declares `"license": "UNLICENSED"` (proprietary). Choose and add your own EULA. The
installer currently shows an information notice, not a EULA.

## Product, platform and gambling-law risks

- **Operator terms of service.** Betting sites commonly prohibit third-party tools and automated data collection. Using RoundLedger may breach MelBet's or 1xBet's terms, and accounts could be restricted. Customers should be told this (the installer notice does).
- **Licensing status of the platforms.** 1xBet and MelBet are not licensed in many jurisdictions. Marketing a product built around them may be restricted or unlawful in some markets (e.g. under gambling-advertising rules). Get advice for each market you sell into.
- **Consumer protection.** Selling a paid tool to gamblers carries misrepresentation risk. The product avoids prediction claims, shows no accuracy or confidence figures, labels AI output as non-predictive and links to responsible-gambling help. Keep marketing to the same standard.
- **Age and jurisdiction.** Add age confirmation and region restrictions to your sales channel as required.
- **Privacy.** The server stores email, password hash, device names, IP addresses (audit log) and the rounds a user observed. Publish a privacy policy, define retention, and handle access/deletion requests (GDPR/UK GDPR where applicable). Gemini processing sends aggregate statistics only (no email or identifiers), but the provider's data terms still apply. Use a paid Gemini tier if you need the provider not to use data for training.
- **Trademarks.** See `NAMING.md`. "MelBet" and "1xBet" are third-party marks, used here only descriptively.
