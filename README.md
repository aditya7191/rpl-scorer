# RPL Scorer – Rohidas Premier League

Live cricket scoring web app. **One admin scores, everyone else watches live (read-only).**

- `/` – **the one link for everyone**: big *Register Your Team* button at the top, then live score, scorecards, past matches and registered teams (year-wise), and a small *Admin Login* link at the bottom
- `/register` – team registration form (mobile-first)
- `/registration/<token>` – a team's private page: thank-you card (download / share), details, upload payment later
- `/teams?year=YYYY` – public read-only list of registered teams per year (no mobile numbers, no screenshots)
- `/admin` – scoring panel + **Teams** tab (password protected)

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

## Team registration
- **Form** (`/register`): team name (unique per year, case/space-insensitive), captain + vice-captain names and 10-digit mobiles, exactly **15 players = Playing XI (11, captain and VC are players 1 and 2) + 4 substitutes (injury replacement)**, payment done Yes / Not yet, payment screenshot (required if Yes) and optional UTR. Names must be in English letters. The form shows the entry fee, UPI ID (with a *Pay with UPI app* link) and payment QR **only when the admin has set them**.
- Screenshots are made smaller in the phone browser, then checked on the server (real image check by magic bytes, max 8 MB), auto-rotated, resized to max 1600 px and saved as JPEG **in Postgres (`rpl_images`, BYTEA)**, never on Render's disk. Only the admin can view them.
- After submitting, the server draws a 1080x1350 **thank-you card** PNG (`reg/image.js`, @napi-rs/canvas, bundled fonts in `assets/fonts`, RPL logo, no network) with team name, captain, VC and registration number (e.g. `RPL7-001`, from the season number). The success page has Download and Share (Web Share with the image file; falls back to "long-press to save" on phones that cannot share files). The private link `/registration/<token>` keeps working, and teams can upload the payment screenshot there later.
- **Admin → Teams tab**: year selector (all years with data), status filter and search, details (Playing XI / substitutes split, mobiles, UTR, screenshot), Verify / Reject / Undo, Edit, Delete (with confirm), upload a screenshot for a team, Export CSV (per year or all years; split columns), **Settings**: registration open/closed, registration year, season name, entry fee (default ₹7000), UPI ID + payee name, payment QR image, Playing XI count (11) and substitutes count (4), note on the form. In **New**, a registered team's name and Playing XI can be loaded into a new match.
- Every team belongs to a year (`settings.year`). Changing the year starts a new registration year, old years stay in the history and team names only need to be unique within a year.
- Security: all input is validated and cleaned on the server, all output is HTML-escaped, submissions are rate-limited per IP (`RPL_REG_RATE`, default `10/600` = 10 per 10 minutes), admin writes need the login cookie plus a JSON body or `X-RPL-Admin` header (CSRF guard), private pages send `Referrer-Policy: no-referrer` and `noindex`.
- Storage: Postgres tables `rpl_teams` (one row per team, JSONB, unique `(year, name_key)`), `rpl_images`, and settings/counters in `rpl_meta`. Created automatically. JSON fallback: `data/registrations.json` + `data/images/`.
- Logo: header of every page and a faint fixed watermark behind every page (`public/logo-wm.webp`, made from the RPL channel picture with the white background removed).

## Tests
```bash
npm test     # engine + registration unit tests, restart/durability tests, registration API test,
             # full headless browser E2E (scorer + registration at phone size: Android Chrome and,
             # if Playwright WebKit is installed, iPhone Safari). Needs Chrome (CHROME_PATH).
             # Registration screenshots are saved to ../registration-shots (RPL_SHOTS_DIR)
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
