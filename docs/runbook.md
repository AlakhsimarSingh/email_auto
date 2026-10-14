# Runbook

Day-to-day operations for the Outreach Agent. The design lives in the [README](../README.md); this file covers what to do.

## Local development

```powershell
corepack enable
pnpm install
pnpm --filter @outreach/backend db:migrate     # needs DATABASE_URL and DIRECT_URL in backend/.env
pnpm --filter @outreach/backend preflight      # PASS/WARN/FAIL for every config value and the schema
pnpm --filter @outreach/backend dev            # http://localhost:8080
pnpm --filter @outreach/frontend dev           # http://localhost:3000
pnpm --filter @outreach/backend test
```

Ticks don't run on their own locally. To trigger one:

```bash
curl -X POST -H "x-tick-key: $TICK_SECRET" http://localhost:8080/internal/tick
```

## Deploy

1. **Supabase:** set `DATABASE_URL` to the transaction pooler URL and `DIRECT_URL` to the direct or session-pooler URL.
2. **Render backend:** root `backend/`, Node 22. Build with `pnpm install --frozen-lockfile --filter @outreach/backend... && pnpm --filter @outreach/backend build`, start with `node dist/server.js`, and use `/health` as the health check path. Copy every value from `backend/.env.example`.
3. **Migrations:** run `pnpm --filter @outreach/backend db:migrate` against `DIRECT_URL` before you start a new build, then run `preflight`. It must show no `FAIL`.
4. **Frontend (Vercel or an alternative from README §3A):** root `frontend/`. Set `BACKEND_URL` and `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
5. **Tick pinger:** set up cron-job.org to send `POST https://<backend>/internal/tick` every 5 minutes with header `x-tick-key: <TICK_SECRET>`.
6. **Keep-alive:** point UptimeRobot (or an alternative) at `GET https://<backend>/health` every 5 minutes, with email alerts on.
7. **GitHub repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | Used by |
   |---|---|
   | `BACKEND_PUBLIC_URL`, `TICK_SECRET` | `tick-backup.yml`, the 30-minute backup pinger |
   | `BACKUP_DATABASE_URL` (direct or session-pooler URL) and `BACKUP_PASSPHRASE` (long random string, also kept in your password manager) | `db-backup.yml`, the nightly encrypted `pg_dump` |

8. Check the deploy:
   - `/health` returns 200.
   - The Usage page shows a recent "last tick".
   - After 30 minutes with no manual traffic, Render's logs show no sleep or wake cycle.

## Checks

| Where | What to look for |
|---|---|
| **Usage** page | Last tick under 10 minutes old. DB occupancy under 80%. LLM tokens within budget. PageSpeed calls well under 25,000/day. Self-measured awake hours on pace for under 750/month. |
| **Inbox health** page | Status not `red`. Bounce rate under 2% and complaints under 0.1% once there are 30 or more sends. |
| **Inbox** page | No human reply older than the 4-hour SLA. |
| **Brain** page | Pending proposals reviewed. Learning not frozen unless you meant to freeze it. |
| GitHub Actions | `Nightly database backup` is green, and a backup from the last 24 hours exists under Artifacts. |

Awake hours are measured by the backend itself (`usage-meter.ts`), not read from Render billing. Compare them with the Render dashboard once a month.

## Going live (turning `DRY_RUN` off)

Only after all of these are true:

1. `preflight` shows no `FAIL`. `SENDER_NAME`, `POSTAL_ADDRESS`, and an HTTPS `APP_ORIGIN` are set.
2. Gmail is connected as `OWNER_EMAIL`, and the dry-run Send Plans look right.
3. SPF, DKIM, and DMARC pass for the sending domain (check the headers of a test message in Gmail with **Show original**).
4. Three seed test messages to your own Gmail and Outlook addresses landed in Inbox, recorded on the Inbox health page.
5. Set `DRY_RUN=false` on Render and redeploy. The warm-up ramp (`WARMUP_RAMP`) caps daily volume on its own.

To stop sending immediately, set `DRY_RUN=true` and redeploy. To stop one batch, **veto** or **freeze** its Send Plan.

## Incidents

| Symptom | Action |
|---|---|
| Inbox health `red`, or a spike in bounces or complaints | Set `DRY_RUN=true`. Review the suppressions and recent drafts. Don't resume until the cause is understood. |
| Gmail errors (`invalid_grant`) | The refresh token was revoked or expired. Reconnect Gmail from Settings as the owner. Check the OAuth consent screen is **In production**. |
| No ticks | Check cron-job.org, then the `Tick backup pinger` workflow, then the Render logs. If the lease is stuck (a crashed tick), it expires after its timeout on its own. |
| Render sleeping | Check that the keep-alive monitor is "Up" and pointed at `/health`. |
| DB near `SUPABASE_DB_LIMIT_MB` | Ticks already clear expired screenshots (30 days), notifications older than 180 days, and old brain rows. The audit log isn't pruned on its own, so delete old `audit_log` rows by hand if it has grown large. |
| Lost access to the owner account | Sign in with a passkey. If none works, clear `admin_users.google_sub` for the owner in Supabase and sign in with Google again. Note that `OWNER_GOOGLE_SUB` in the env still pins it if set. |
| The learning agent made bad choices | Brain page → **Freeze**. If needed, **Reset** (a snapshot is kept, and **Restore** works until the restore window ends). |

## Restoring a backup

```bash
gh run download <run-id> -n db-<stamp>.dump.gpg
gpg --decrypt --output db.dump db-<stamp>.dump.gpg
# Restore into an EMPTY database first, check it, then repoint DATABASE_URL/DIRECT_URL.
pg_restore --no-owner --no-privileges --dbname "$TARGET_DIRECT_URL" db.dump
```

## Secrets

- `SESSION_SECRET`, `OTP_PEPPER`, `TICK_SECRET`: rotating any of them is safe. Rotating the session secret signs everyone out. After rotating `TICK_SECRET`, update cron-job.org and the GitHub secret.
- `GMAIL_TOKEN_ENCRYPTION_KEY`: **don't rotate it casually.** It decrypts the stored Gmail token and the notification channel targets. If you rotate it, reconnect Gmail and re-add the Telegram and ntfy channels afterwards.
- `TELEGRAM_WEBHOOK_SECRET`: after changing it, relink Telegram from the Notifications page, which calls `setWebhook` again.
- `VAPID_*`: changing the key pair breaks every existing push subscription. Re-enable notifications on each device.
