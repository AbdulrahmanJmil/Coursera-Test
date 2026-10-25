# Customer installation and distribution strategy

## What Chrome on Windows actually allows

| Option | Works for consumers on Windows? | Notes |
|---|---|---|
| Chrome Web Store | Yes | Ruled out by the business decision not to publish there. |
| `.crx` file (drag-and-drop or download) | **No** | Since 2014, Chrome on Windows refuses to install extensions that are not hosted in the Chrome Web Store, except through enterprise policy. CRX packaging is signing, not encryption: the JavaScript stays readable either way. |
| Windows registry "external extensions" | **No** for off-store | Chrome only honours registry-installed extensions whose `update_url` is the Web Store. |
| Enterprise policy (`ExtensionInstallForcelist`) | Only on managed devices | Requires domain join / MDM / Chrome Browser Cloud Management. Not available on ordinary home PCs. |
| **Unpacked extension ("Load unpacked", Developer mode)** | **Yes** | Supported on consumer Chrome. Requires the user to turn on Developer mode once; Chrome may show a reminder banner. Blocked where policy disables developer mode. |

**Chosen approach:** a per-user Windows installer (`RoundLedger-Setup-<version>.exe`, NSIS, no admin
rights) that:
1. checks Windows 10+ and finds Chrome (App Paths registry keys, then standard folders), and refuses with a link to the Chrome download page if Chrome is missing;
2. checks Chrome is 116 or newer (side panel API);
3. copies the extension to `%LOCALAPPDATA%\RoundLedger\extension` with a SHA-256 manifest and a `verify-files.ps1` checker;
4. opens a setup guide in Chrome with copy buttons for `chrome://extensions` and the folder path;
5. registers an uninstaller (Windows Settings → Apps) and Start-menu shortcuts.

It cannot click "Load unpacked" for the user, and does not try to.

## Upgrades

Run the newer installer. It replaces the extension folder in place. The extension ID is pinned by the
manifest `key`, so Chrome keeps the extension's sign-in and local history. Chrome picks up the new files
on its next restart or when the user clicks the reload arrow on the extension card. The side panel shows
an update banner when the server's **latestVersion**/**minimumVersion** settings are newer than the
installed build.

## Uninstall

Remove the card in `chrome://extensions` (Windows cannot do this for the user), then uninstall from
Windows Settings → Apps. The uninstaller removes the files, shortcuts and its registry key.

## Building

```bash
ROUNDLEDGER_BACKEND_URL=https://api.example.com npm run build:extension
npm run build:installer        # needs makensis (NSIS 3) on PATH; works on Linux and Windows
# or everything incl. tests and checksums:
ROUNDLEDGER_BACKEND_URL=https://api.example.com npm run release   # → dist/release/<version>/
```

The installer is **not code-signed**. Until it is signed with an Authenticode certificate,
Windows SmartScreen shows "Windows protected your PC" and users must click *More info → Run anyway*.

## Known limitations

- Developer-mode extensions: Chrome shows warnings and some users will find the steps unfamiliar.
- On managed (work/school) Chrome, developer mode may be disabled by policy; installation is then impossible.
- Google may further restrict unpacked extensions in future Chrome versions; monitor Chrome release notes.
- The installer has been compiled and its contents verified on Linux; it has **not** been run on Windows yet (see `TESTING.md`).
