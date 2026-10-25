# Deployment and maintenance

## Runtime

| Component | Requirement |
|---|---|
| Server | Node.js **22.13+** (uses the built-in `node:sqlite`; Node 24 LTS also works). No npm runtime dependencies. |
| Database | SQLite file on persistent storage (WAL mode). One server process per database file. |
| TLS | Terminate HTTPS at a reverse proxy (Caddy, nginx) in front of the Node process. |
| Build machine | Node 22+, `zip`, NSIS 3 (`makensis`) for the installer, Python 3 + Pillow and Playwright only to regenerate icons. |

`node:sqlite` still prints an "experimental" warning on Node 22. The npm scripts silence it with
`--disable-warning=ExperimentalWarning`; the API it exposes is stable enough for this use but
review the Node release notes when upgrading Node.

## Environment variables

See `.env.example`. Required in production (the server refuses to start without them):

- `APP_ENCRYPTION_KEY`: 32 random bytes (hex or base64). Encrypts provider API keys at rest with AES-256-GCM. Back it up separately from the database; if lost, re-enter the Gemini key in the dashboard.
- `PUBLIC_BASE_URL`: the public `https://` URL. Enables `Secure` cookies and HSTS.
- `EXTENSION_ORIGINS`: `chrome-extension://<id>`. The ID is printed by `npm run build:extension` and is fixed by `extension/extension-key.pub.b64`.

Optional: `HOST` (default 127.0.0.1), `PORT` (8787), `DATABASE_PATH`, `TRUST_PROXY=1` behind a proxy, `LOG_REQUESTS=0`.

## First-time setup

```bash
cd roundledger
cp .env.example .env            # fill in the values
npm run create-admin -- you@example.com   # prompts for a password (or set ROUNDLEDGER_ADMIN_PASSWORD)
npm run seed-plans              # optional: two INACTIVE example plans with price 0
npm start
```

Then open `https://<your-host>/admin/`, sign in, and:
1. **Plans**: set real prices and activate at least one plan.
2. **AI providers**: paste the Gemini key, click *Fetch available models*, pick a model, enable, then *Test key*.
3. **Settings**: branding (support email/URL), trial length, device policy, platform page patterns.

## Migrations

Migrations live in `server/migrations/NNN_name.sql` and run automatically, in order, at startup,
each in its own transaction; applied names are stored in `schema_migrations`. Rules:
- Never edit a migration that has shipped; add a new numbered file.
- Prefer additive changes. For destructive changes, back up first and test on a copy.

## Running as a service (Linux example)

```ini
# /etc/systemd/system/roundledger.service
[Unit]
Description=RoundLedger API
After=network.target

[Service]
User=roundledger
WorkingDirectory=/opt/roundledger
ExecStart=/usr/bin/npm start
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Caddy (automatic HTTPS):

```
api.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

With nginx, proxy to `127.0.0.1:8787`, set `X-Forwarded-For`, and set `TRUST_PROXY=1`.

## Scheduled jobs

None are required: expiry is evaluated on every request and rate-limit buckets clean themselves.
Recommended external jobs: the backup below and an uptime check of `GET /api/health`.

## Backups and restore

```bash
# online, consistent copy (safe while the server runs)
sqlite3 /var/lib/roundledger/roundledger.db ".backup '/backups/roundledger-$(date +%F).db'"
```

Restore: stop the service, replace the database file (remove any `-wal`/`-shm` files), start the service.
Keep `APP_ENCRYPTION_KEY` with your secrets manager, not next to the backups.

## Logging and monitoring

- Access log lines (`<time> <method> <path> <status> <ms>`) go to stdout. Query strings, bodies and tokens are never logged.
- Unhandled errors go to stderr with a stack trace.
- `GET /api/health` returns `{status, version, database}` for uptime monitors.
- The dashboard overview shows AI errors, client error reports and config problems.

## Upgrade and rollback

1. Back up the database.
2. Deploy the new code, then restart (migrations apply on start).
3. To roll back code without schema changes: redeploy the previous version.
   If the new version added a migration, restore the pre-upgrade backup as well.
4. Extension updates: build and ship a new installer, then set **Settings → extension → latestVersion**
   (and `minimumVersion` to force an update banner for older builds).

## Rate limiting

In-memory, per client IP (and per user for AI/rounds). For more than one server process, put a
shared limiter (e.g. at the proxy) in front, as the in-memory buckets are per process.
