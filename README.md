# Movie Suggestion

A small personal movie site: a tag-based finder to narrow down what to
watch, a year-round themed calendar with a pick for every day, and an
admin page to curate it — all in vanilla HTML/CSS/JS, backed by one small
self-hosted Node server.

## Pages

- **`index.html`** — Finder. Add keywords one at a time (genre, decade,
  actor, mood) and the movie list narrows live as tags stack, AND-style.
  Click a movie to see its full detail card, including a live-fetched
  overview and streaming availability from TMDB.
- **`calendar.html`** — A pick for every day of the year. Some windows
  are themed (Horror all of October, a Romance week before Valentine's,
  specific pinned films like *Groundhog Day* on Feb 2), holidays are
  computed by real date math (e.g. "3rd Monday of January" for MLK Day)
  rather than hardcoded, and everything else defaults to a runtime-aware
  grab-bag pick (90 min or under on weekdays, no cap on weekends).
- **`admin.html`** — Username + password + TOTP (authenticator app)
  login, then search any movie and pin it to a date (once, or recurring
  every year), or just rename a day without picking a movie. Changes
  publish live to the server's disk — no redeploy needed to update the
  calendar.

## How it's built

- No framework, no build step — plain HTML/CSS/JS, static files served
  as-is by `server.js` itself.
- **`data/movies.json`** — ~9,800 movies (title, year, genre, overview,
  popularity), enriched with runtime, cast, director, and poster URLs for
  a subset sourced from a secondary TMDB export. See `calendar-engine.js`
  and `app.js` for how matching/filtering works.
- **`data/watch-providers.json`** — which movies are streaming where
  right now (e.g. typing "Netflix" in the finder searches this), built by
  `refresh-watch-providers.js` on a monthly cron job — see DEPLOY.md.
  Doesn't exist until that script's been run at least once.
- **`server.js`** — a single Node process (no external dependencies —
  just the built-in `http`, `fs`, and `crypto` modules) that serves the
  static files directly *and* two API routes:
  - `/api/calendar-rules` — reads/writes the calendar's theme rules and
    admin overrides, stored as a JSON file on disk. Publishing requires a
    username, password, and a valid TOTP code (RFC 6238).
  - `/api/movie-details` — proxies TMDB's search/watch-providers APIs and
    OMDb's ratings API for a given title/year. TMDB results (overview,
    streaming availability) cache for 30 days, since where a movie is
    streaming genuinely changes. Ratings cache indefinitely once found —
    an IMDb/RT/Metacritic score rarely moves, so there's no reason to
    re-fetch it every month like the rest.
- Runs as a systemd service, exposed to the internet via Cloudflare
  Tunnel — no ports opened on the router, no nginx or other reverse proxy
  in front of it.
- Both the calendar and admin pages fall back gracefully to the bundled
  `data/calendar-rules.json` if `server.js` isn't reachable.

## Local development

```bash
DATA_DIR=./local-data PORT=3001 \
ADMIN_USERNAME=you ADMIN_SECRET=devpassword TOTP_SECRET=your-totp-secret TMDB_API_KEY=your-key OMDB_API_KEY=your-omdb-key \
node server.js
```

Then visit `http://localhost:3001` — it serves everything itself, static
files included, no separate web server needed.

See **[DEPLOY.md](./DEPLOY.md)** for the full self-hosting walkthrough —
system user setup, systemd service, and pointing a Cloudflare Tunnel at it.

## Data attribution

This product uses the TMDB API but is not endorsed or certified by
[TMDB](https://www.themoviedb.org). IMDb, Rotten Tomatoes, and Metacritic
scores come from the [OMDb API](https://www.omdbapi.com) (non-commercial
use only, per their CC BY-NC 4.0 license).
