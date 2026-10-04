# RPL Scorer – Rohidas Premier League

Live cricket scoring web app. **One admin scores, everyone else watches live (read-only).**

- `/` – public live score, scorecards, past matches (auto-updates, no refresh needed)
- `/admin` – scoring panel (password protected)

## Run locally
```bash
npm install
RPL_ADMIN_PASSWORD='choose-a-strong-password' npm start      # http://localhost:8080
```
Without `DATABASE_URL` the app stores everything in `data/db.json` (fine for local use).

Env vars:
| Var | Default | Meaning |
|---|---|---|
| `RPL_ADMIN_PASSWORD` | (required) | admin login password |
| `DATABASE_URL` | empty | Postgres connection string. When set, matches are stored in Postgres (tables `rpl_matches`, `rpl_meta` are created automatically). SSL is used for any non-localhost host and the certificate is verified |
| `SESSION_SECRET` | derived from password | secret used to sign the admin login cookie. Set a long random value in production. Changing it (or the password, when unset) logs the admin out everywhere |
| `PORT` | 8080 | port |
| `RPL_DATA_DIR` | `./data` | where `db.json` is stored when `DATABASE_URL` is not set |
| `DATABASE_SSL` | auto | `disable` to turn SSL off for a non-local DB, `require` to force it for localhost |
| `RPL_PG_SCHEMA` | `public` | Postgres schema to use (the tests use throw-away schemas) |

`GET /healthz` returns `{"ok":true}` (no DB call). `GET /healthz?db=1` also checks the database.

The admin login stays valid for 30 days (an HttpOnly cookie).

## How scoring works
- Every action (ball, bowler pick, batsman pick) is saved as an event on the server. Each match (setup + full event log + Man of the Match) is one row in Postgres (or one entry in `db.json`). The server waits until the write is committed before it replies to the admin, so an acknowledged tap is never lost, even if the server is killed right after. The score is worked out again from all the events each time, so **Undo** just removes the last event and is always exact.
- Live updates reach viewers through Server-Sent Events (`/api/stream`).
- **Delete match** (admin only): in `/admin`, each match in the Matches tab (and the current match on the Score tab) has a Delete button. It asks for confirmation, then calls `DELETE /api/admin/matches/:id`, which removes the match from storage for good. If it was the current match, there is no live match until a new one is started. Viewers' pages update right away (SSE `deleted` + `update` events) and show "No live match". The public page has no delete option.
- If two phones score at once, the server rejects the stale tap (HTTP 409) and sends the latest score back.
- Rules: Wide/No Ball extra runs can be set in setup (default 1). Runs taken on a wide count as wides. No-ball runs off the bat go to the batsman. Byes/leg byes count as a ball faced but are not charged to the bowler. A bowler can't bowl two overs in a row. You can also set a max overs per bowler. Strike changes on odd runs and at the end of each over.
- Man of the Match points: runs 1 each, +1 per four, +2 per six, SR 150+ (min 5 balls) +5, SR 200+ +10, 30+ runs +5, 50+ runs +10, wicket +20, 3+ wickets +10, maiden +10, economy ≤6 (min 1 over) +5, economy ≤4 +10, economy 12+ −5, catch/stumping/run-out +5, winning team +10. The admin can confirm the suggestion or pick another player.

## Tests
```bash
npm test     # engine unit tests + restart/durability test + full headless browser E2E
             # (needs Chrome; set CHROME_PATH if not /usr/bin/google-chrome)
DATABASE_URL='postgres://user:pw@localhost:5432/db' npm test   # same, against Postgres
```
With `DATABASE_URL` set, each test run creates its own temporary schema (`rpl_test_xxxx`) and drops it afterwards. It never touches the real tables.

## Deploy for free: Render + Neon (no card needed)
Render's free web service sleeps after 15 minutes without visitors and wipes its disk, so the data is kept in a free **Neon** Postgres database instead.

1. **Neon database**: sign up at https://neon.tech (free plan). Create a project (region **AWS Asia Pacific (Singapore)**, Postgres 16/17). On the dashboard click **Connect** and copy the connection string. It looks like
   `postgresql://neondb_owner:XXXX@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`
   No tables need to be created. The app creates them on first start.
2. **Push this repo to GitHub** (private is fine).
3. **Render**: sign up at https://render.com with GitHub, then **New → Blueprint**, pick the repo. Render reads `render.yaml` (free Node web service, `npm ci --omit=dev`, `node server.js`, health check `/healthz`, region Singapore) and asks for the 3 secret values:
   - `DATABASE_URL`: the Neon string from step 1
   - `RPL_ADMIN_PASSWORD`: the admin password
   - `SESSION_SECRET`: a long random string, e.g. the output of `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

   (Without Blueprints: **New → Web Service**, Runtime Node, Instance type Free, Build `npm ci --omit=dev`, Start `node server.js`, Health check path `/healthz`, and add the same 3 env vars.)
4. Open `https://<your-service>.onrender.com`. The log should say `Storage: Postgres ep-....neon.tech (SSL)`. Log in at `/admin`.
5. Optional: copy old local matches into Neon: `DATABASE_URL='<neon string>' npm run import-json` (reads `data/db.json`, safe to run twice).

Notes
- The first visit after the app has slept takes about 30-60 seconds (Render wakes up, then Neon wakes up). Open the site a minute before the match starts. After that it is fast.
- Keep **one instance** only. Live updates (SSE) and the cache of matches are held in memory by the single server.
- Render free gives 750 instance-hours a month and Neon free gives 0.5 GB of storage. Both are far more than a cricket league needs. The data stays in Neon even when Render sleeps, restarts or redeploys.
- HTTPS is automatic on Render. The cookie gets marked `Secure` automatically.

## Deploy with Docker (other hosts)
`docker build -t rpl-scorer . && docker run -p 8080:8080 -e RPL_ADMIN_PASSWORD=... -e SESSION_SECRET=... -e DATABASE_URL=... rpl-scorer`
Without `DATABASE_URL`, attach a persistent volume at `/data`, or the data is wiped on every restart.
