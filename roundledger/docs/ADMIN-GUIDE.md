# Administrator guide

Dashboard: `https://<server>/admin/`. Only accounts with the `admin` role can sign in. Create the first one
with `npm run create-admin -- you@example.com`; the same command promotes an existing account.
Sessions use an HttpOnly, SameSite=Strict cookie and expire after 12 hours.

## Overview
Counts come straight from the database: users (active/suspended/admins), current paid subscriptions and
trials, ended subscriptions, activation codes by status, devices, today's AI requests/errors/tokens,
client error reports in the last 24 hours, system health and recent audit entries. Warnings appear at the
top when the encryption key is missing, configuration is unsafe, or maintenance mode is on.

## Users
Search by email, filter by status and role, page through results. A user's page shows account data,
current entitlement (computed by the server), subscriptions, devices, activation codes, synced round
counts, AI usage, activity (both actions by and about the user) and client errors. Actions:
- **Suspend / Reactivate**: suspension signs the user out everywhere and blocks sign-in.
- **Clear login lock**: after 10 failed passwords the account locks for 15 minutes.
- **Reset password**: sets a new password you give the customer securely; signs them out everywhere.
- **Sign out everywhere**.
- **Grant subscription**: choose plan and optional days. Paid time stacks after the current paid coverage.

## Subscriptions
Filter by state (current, expired, suspended, revoked) and kind. Actions: **Renew** (adds days from the
later of now or current expiry), **Expiry** (set an exact date), **Suspend/Reactivate**, **Revoke**
(permanent). Every change is audited with before/after values.

## Plans
Name, code, description, price and currency, duration, device limit, features (`cloudHistory`,
`aiAnalysis`), active flag, featured flag, display order. Editing a plan affects **new** subscriptions
only: each subscription keeps the device limit and features it was sold with. Plans with subscriptions
cannot change their code and are deactivated rather than deleted. There is no payment integration:
codes are sold through your own channel.

## Activation codes
Generate 1–500 codes for an active plan, optionally with a custom duration, a "redeem by" date, a note, or
assigned to one account. **Codes are displayed once** (copy or download CSV); the server stores only
SHA-256 hashes and a short hint. Redemption is atomic: two people redeeming the same code at the same moment
cannot both succeed. Unused codes can be revoked or (re)assigned.

## Devices
Each signed-in browser installation is a device. The device limit comes from the subscription (or the
licensing default without one). Actions: **Revoke** (signs that installation out; it cannot sign in again
until restored), **Restore**, **Reassign** to another account (subject to that account's limit). Users can
remove their own devices if **Settings → licensing → allowSelfDeviceRemoval** is on, at most once per
`selfRemovalCooldownHours`.

## AI providers
Gemini is the only implemented provider.
1. Paste the API key and **Save key**. It is encrypted at rest, never shown again (only `••••last4`), never sent to the extension and never logged.
2. **Fetch available models** lists models that support `generateContent` from Google's live model list (no tokens generated). Pick one.
3. Set temperature, max output tokens, timeout and the daily cap for all users, tick **Enabled**, **Save configuration**.
4. **Test key** lists models (no generation). **Test generation** sends a one-line prompt and may be billed, so it asks for explicit confirmation.
Usage (requests, errors, prompt/output tokens from Gemini's `usageMetadata`) and the last 10 errors are shown.
Per-user daily limits are under **Settings → usage**.

## Settings
- **Maintenance**: customers get a 503 with your message; admins keep access.
- **Branding**: product name, tagline, support email/URL, responsible-gambling link shown in the extension footer.
- **Registration**: open or close self-service sign-up.
- **Free trial**: on/off, length, device limit and features. One trial per account and per installation, enforced on the server.
- **Licensing**: default device limit without a subscription, self-service device removal and cooldown.
- **Usage**: AI explanations per user per UTC day, max rounds per upload, cloud rounds kept per platform.
- **Extension**: latest and minimum versions (drives the update banner) and download URL.
- **Supported platforms**: JSON per adapter. See `PLATFORMS.md` before marking anything verified.

## Audit log
Records actor, action, affected resource, affected user, outcome, IP, time and scrubbed details for: admin
sign-ins (success and failure), user create/suspend/reactivate/unlock/password reset/session revocation, subscription
grant/renew/update/suspend/reactivate/revoke, plan create/update, code generate/revoke/assign, code
redemptions (success and failure), trial starts, device revoke/restore/reassign/self-removal, settings
changes (before/after), AI key set/delete (hint only), AI configuration changes and AI tests.
Passwords, tokens, codes and API keys are never written to it.

## Client errors
Errors the extension reports (rate-limited, credentials redacted), with user and context.
