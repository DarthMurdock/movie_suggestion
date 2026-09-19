# Deploying: self-hosted on a Raspberry Pi

Everything — the static Finder/Calendar/Admin pages *and* the live
"Save & publish" / TMDB lookup backend — is served by one self-contained
process: `server.js`, managed by systemd, exposed to the internet via
Cloudflare Tunnel (no ports opened on your router, no port-forwarding/DDNS
needed).

There's no nginx or other reverse proxy involved — this project turned out
to not need one. `server.js` binds only to `127.0.0.1`; `cloudflared`
(already running on this Pi for your other site) reaches it over loopback
and is the only path in from the outside.

## 1. Check Node version

```bash
node -v
```

Needs to be **18 or newer** — `server.js` uses the built-in `http`, `fs`,
and `crypto` modules with no external dependencies (nothing to
`npm install`). If Node isn't installed system-wide (check with
`ls -la /usr/bin/node` — a personal `nvm` install alone isn't enough,
since systemd services don't use your shell's PATH), install it via
NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 2. Create a dedicated system user and data directory

Running the service as its own unprivileged user (rather than reusing an
existing one) keeps it isolated from whatever else is on this box:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin movie-finder
sudo mkdir -p /var/lib/movie-finder
sudo chown movie-finder:movie-finder /var/lib/movie-finder
```

## 3. Deploy the files

```bash
sudo mkdir -p /var/www/movie-finder
sudo cp -r index.html calendar.html admin.html *.css *.js data /var/www/movie-finder/
sudo chown -R movie-finder:movie-finder /var/www/movie-finder
```

That `*.js` picks up `server.js` and `refresh-watch-providers.js` too,
alongside the client-side scripts — it all lives in the same folder.

## 4. Set up 2FA and the environment file

Generate a random base32 TOTP secret:

```bash
python3 -c "import os, base64; print(base64.b32encode(os.urandom(20)).decode())"
```

Add that secret to your authenticator app (Google Authenticator, Authy,
1Password, etc.) — choose "enter setup key manually" instead of scanning a
QR code, since there isn't one to scan here.

Then create the environment file the systemd service reads from:

```bash
sudo mkdir -p /etc/movie-finder
sudo tee /etc/movie-finder/env << 'EOF'
ADMIN_USERNAME=your-username
ADMIN_SECRET=your-password
TOTP_SECRET=the-base32-secret-from-above
TMDB_API_KEY=your-tmdb-api-key
OMDB_API_KEY=your-omdb-api-key
DATA_DIR=/var/lib/movie-finder
PORT=3001
HOST=127.0.0.1
EOF
sudo chmod 600 /etc/movie-finder/env
```

That `chmod 600` matters — it's the only thing protecting your secrets on
disk, so only root (and the service, via systemd's `EnvironmentFile=`,
which reads it before dropping privileges) can read it.

`OMDB_API_KEY` (get one free at omdbapi.com/apikey.aspx) is optional —
it adds IMDb/Rotten Tomatoes/Metacritic scores to each movie's detail
card. Leave it out and everything else still works, just without ratings.

**Worth knowing:** after 5 failed login attempts (wrong password, wrong
code, anything), the server blocks *all* further attempts — including
correct ones — for 5 minutes. This is a basic guard against automated
password/code guessing. It resets on your next successful login. If you
lock yourself out by fumbling your own password a few times, the fix is
just waiting 5 minutes, not a config problem.

## 5. Set up the systemd service

```bash
sudo cp deploy/movie-finder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now movie-finder
sudo systemctl status movie-finder
```

That last command should show `active (running)`. If not:

```bash
sudo journalctl -u movie-finder -n 50
```

## 6. Point Cloudflare Tunnel at it

First, make sure your domain is added as its own zone in Cloudflare
(**Domains → Add domain**) — if you registered it directly through
Cloudflare, this happens automatically. Otherwise you'll need to point its
nameservers at Cloudflare and wait for that to propagate.

How you connect the tunnel depends on whether it's **dashboard-managed**
or **locally-managed** — check with `sudo systemctl cat cloudflared` and
look at the `--config` flag on `ExecStart`. If there's no `--config` flag
at all, it's dashboard-managed; if it points at a file (typically
`/etc/cloudflared/config.yml`), it's locally-managed.

**If dashboard-managed:** Cloudflare Zero Trust dashboard → **Networks →
Tunnels** → your tunnel → **Public Hostname** → **Add a public hostname**.
Domain: your new domain. Service: **HTTP**, `localhost:3001`.

**If locally-managed** (this is what this Pi actually turned out to be):

1. Edit the config file it points to and add a new ingress rule *before*
   the catch-all line (order matters — first match wins):
   ```yaml
   ingress:
     - hostname: your-existing-site.com
       service: http://localhost:80
     - hostname: your-new-domain.com
       service: http://localhost:3001
     - service: http_status:404
   ```
2. Restart it: `sudo systemctl restart cloudflared`
3. Add the DNS record **directly in the dashboard** — go to
   **your-new-domain.com → DNS → Records → Add record**: type **CNAME**,
   name is your domain itself, target is
   `<your-tunnel-id>.cfargotunnel.com`, proxy status **Proxied** (orange
   cloud, required). Don't use `cloudflared tunnel route dns` for this —
   in testing, that command created the CNAME in the wrong zone (it
   defaulted to whichever zone the tunnel was originally set up under,
   not the new domain).

## Verify

```bash
curl -i http://127.0.0.1:3001/api/calendar-rules
```

Should return `204` (nothing published yet — expected on a fresh setup).
Then:

```bash
curl -i http://127.0.0.1:3001/
```

Should return `200` with your `index.html` content. Once both check out,
visit your actual domain in a browser, confirm the finder and calendar
pages load, and confirm the admin login (username + password + current
6-digit code) unlocks the admin page.

## Using it

- Visit `your-domain/admin.html`, log in, make changes, click
  **Save & publish live**.
- Changes write straight to `/var/lib/movie-finder/rules.json` and are
  visible to everyone on `calendar.html` immediately — no redeploy needed.
- The **"download a local backup file"** link still works as a manual
  export/import option if you ever want a snapshot outside that file.

## Growing the catalog

`grow-catalog.js` pulls additional movies directly from TMDB's full
library (not just the original curated snapshot), fully enriched on the
way in — runtime, cast, director, keywords, and streaming availability
all come from one details call per movie, so new entries don't need a
separate backfill afterward. Only pulls movies with a minimum vote count
on TMDB (default 50), to keep out extremely obscure/incomplete entries.

Safe to re-run later — it dedupes against what's already in
`movies.json`, so running it again just tops up with anything new
(including movies released since the last run).

```bash
cd /var/www/movie-finder
TMDB_API_KEY=your-tmdb-key TARGET_NEW_COUNT=40000 nohup node grow-catalog.js > ~/grow.log 2>&1 &
```

**This is a long one** — adding 40,000 movies takes roughly 3-4 hours
(one details call per new movie, rate-limited the same as the other
scripts). Definitely use the background/`nohup` approach, not a foreground
session. Checkpoints every 250 movies, so an interruption only costs you
back to the last checkpoint, not the whole run.

`MIN_VOTE_COUNT` and `TARGET_NEW_COUNT` are both optional environment
variables — omit either to use the defaults (50 votes minimum, 40,000
new movies).

Once it's done, copy both updated files back to your source directory and
commit:

```bash
cp /var/www/movie-finder/data/movies.json /var/www/movie-finder/data/watch-providers.json /mnt/PI_Projects/movie-finder-v2/data/
cd /mnt/PI_Projects/movie-finder-v2
git add data/movies.json data/watch-providers.json
git commit -m "Grow the movie catalog"
git push
```

## Runtime data (one-time backfill)

Only ~2,800 of the ~9,800 movies ship with runtime out of the box. Unlike
streaming availability, runtime never changes once set, so this is a
one-time job, not a recurring one — `backfill-runtime.js` fills in
whatever's missing and writes straight back into `data/movies.json`. Skips
anything that already has runtime, so it's safe to re-run later if you
ever add more movies to the catalog.

```bash
cd /var/www/movie-finder
TMDB_API_KEY=your-tmdb-key node backfill-runtime.js
```

Takes roughly 45-70 minutes for the ~7,000 movies currently missing it —
same `nohup`/background-process approach as the streaming refresh job
works well here too. Once it's done, copy the updated file back to your
source directory and commit it:

```bash
cp /var/www/movie-finder/data/movies.json /mnt/PI_Projects/movie-finder-v2/data/movies.json
cd /mnt/PI_Projects/movie-finder-v2
git add data/movies.json
git commit -m "Backfill runtime for the full catalog"
git push
```

## Streaming service search (monthly refresh job)

Typing a streaming service name (e.g. "Netflix") into the finder searches
against `data/watch-providers.json` — a mapping of which movies are
currently streaming where, built by `refresh-watch-providers.js`. This
file doesn't exist until you run that script at least once; until then,
service names just get treated as regular search words instead.

**First run** (takes roughly 60-100 minutes for the full ~9,800-movie
catalog — TMDB rate-limits requests, so this can't go faster):

```bash
cd /var/www/movie-finder
TMDB_API_KEY=your-tmdb-key node refresh-watch-providers.js
```

It checkpoints progress every 200 movies, so if it's interrupted partway,
you'll still have partial data rather than nothing.

**Keeping it current** — streaming availability changes constantly (unlike
ratings, which we cache forever), so this needs to actually re-run
regularly, not just once. Set up a monthly cron job:

```bash
sudo crontab -e
```

Add a line to run it at 3am on the 1st of each month:

```
0 3 1 * * TMDB_API_KEY=your-tmdb-key /usr/bin/node /var/www/movie-finder/refresh-watch-providers.js >> /var/log/movie-finder-refresh.log 2>&1
```

No restart needed afterward — `watch-providers.json` is just a static
file the finder fetches fresh on each page load, same as `movies.json`.

## Updating the site later

Since there's no build step and no deploy pipeline here, "deploying an
update" just means copying changed files over and restarting the service
(needed for *any* file change now, since `server.js` serves the static
files itself rather than nginx picking up changes automatically):

```bash
sudo cp <changed files> /var/www/movie-finder/
sudo chown movie-finder:movie-finder /var/www/movie-finder/<changed files>
sudo systemctl restart movie-finder
```

## Hosting without a live backend

If these static files get copied somewhere without `server.js` running
behind them, everything still works *except* live publishing and live TMDB
lookups — the finder, calendar, and admin pages automatically fall back to
the bundled `data/calendar-rules.json` file and the dataset's original
(sometimes rougher) overview text, and the Admin page will show a "Not
connected to live storage" notice.
