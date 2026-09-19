// Self-hosted, all-in-one server: serves both the two API routes and the
// static files (HTML/CSS/JS/data) directly. No nginx or other reverse
// proxy involved — this process is the whole thing. Binds to localhost
// only; Cloudflare Tunnel (cloudflared, already running on this Pi)
// reaches it over loopback and is the only path in from outside.
//
// Storage: KV becomes plain JSON files on disk (DATA_DIR/rules.json for
// the calendar config, DATA_DIR/cache/<hash>.json per TMDB lookup).

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/lib/movie-finder";
const CACHE_DIR = path.join(DATA_DIR, "cache");
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const STATIC_DIR = process.env.STATIC_DIR || __dirname;
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "127.0.0.1";

const TMDB_BASE = "https://api.themoviedb.org/3";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const WATCH_REGION = "US";

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — calendar-rules payloads are tiny JSON; generous headroom

// Simple global (not per-IP) rate limit on failed admin logins. Not
// distributed, not IP-aware (IP headers behind a tunnel aren't fully
// trustworthy anyway) — just enough to stop naive automated guessing.
// One real tradeoff: enough failed attempts from anyone temporarily locks
// out the real admin too. Acceptable here since this is a single-admin
// personal site, not a multi-tenant service.
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
let failedAttempts = [];

function isLoginRateLimited() {
  const now = Date.now();
  failedAttempts = failedAttempts.filter((t) => now - t < FAILED_ATTEMPT_WINDOW_MS);
  return failedAttempts.length >= MAX_FAILED_ATTEMPTS;
}

function recordFailedLogin() {
  failedAttempts.push(Date.now());
}

function clearFailedLogins() {
  failedAttempts = [];
}

// Constant-time string comparison, via fixed-length hash digests rather
// than the raw values — crypto.timingSafeEqual throws on mismatched
// buffer lengths, so comparing raw strings of different lengths directly
// isn't safe. Hashing first sidesteps that while keeping the comparison
// itself timing-safe.
function timingSafeStringEqual(a, b) {
  const bufA = crypto.createHash("sha256").update(String(a)).digest();
  const bufB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---------- TOTP (RFC 6238) — same proven implementation as before ---------- */

function base32Decode(b32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = b32.toUpperCase().replace(/=+$/, "");
  let bits = "";
  for (const c of clean) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpAt(secretB32, forTimeSeconds, step = 30, digits = 6) {
  const key = base32Decode(secretB32);
  const counter = Math.floor(forTimeSeconds / step);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(0, 0);
  counterBuf.writeUInt32BE(counter, 4);
  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 10 ** digits).padStart(digits, "0");
}

function isValidTotp(secretB32, providedCode) {
  if (!/^\d{6}$/.test(providedCode)) return false;
  const now = Math.floor(Date.now() / 1000);
  for (const delta of [0, -30, 30]) {
    if (totpAt(secretB32, now + delta) === providedCode) return true;
  }
  return false;
}

/* ---------- file-based storage (replaces KV) ---------- */

async function ensureDataDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

async function readRules() {
  try {
    return JSON.parse(await fs.readFile(RULES_FILE, "utf8"));
  } catch (err) {
    return null; // doesn't exist yet — nothing published
  }
}

async function writeRules(data) {
  await fs.writeFile(RULES_FILE, JSON.stringify(data));
}

function cacheFilename(key) {
  return crypto.createHash("sha256").update(key).digest("hex") + ".json";
}

async function readCache(key) {
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, cacheFilename(key)), "utf8"));
  } catch (err) {
    return null;
  }
}

async function writeCache(key, value) {
  await fs.writeFile(path.join(CACHE_DIR, cacheFilename(key)), JSON.stringify(value));
}

/* ---------- HTTP response helpers ---------- */

// No CORS headers here at all — deliberately. Our own frontend calls these
// routes from the same origin, which never needs CORS in the first place
// (that only governs cross-origin requests). Dropping this entirely means
// no other website's JS can call this API on a visitor's behalf; there's
// no legitimate cross-origin use case for a single-tenant personal site.
const CORS_HEADERS = {};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(body);
}

function sendEmpty(res, status) {
  res.writeHead(status, CORS_HEADERS);
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0; // stop holding onto data we're going to reject anyway
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("body too large"));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/* ---------- route handlers ---------- */

async function handleCalendarRules(req, res) {
  if (req.method === "GET") {
    const data = await readRules();
    if (!data) return sendEmpty(res, 204); // nothing published yet — client falls back to bundled default
    return sendJson(res, 200, data);
  }

  if (req.method === "POST") {
    const secret = process.env.ADMIN_SECRET;
    const username = process.env.ADMIN_USERNAME;
    const totpSecret = process.env.TOTP_SECRET;

    if (!secret || !username || !totpSecret) {
      return sendJson(res, 500, { error: "ADMIN_USERNAME, ADMIN_SECRET, and TOTP_SECRET must all be configured on the server." });
    }

    if (isLoginRateLimited()) {
      return sendJson(res, 429, { error: "Too many failed attempts. Try again in a few minutes." });
    }

    const providedUser = req.headers["x-admin-username"] || "";
    const providedSecret = req.headers["x-admin-secret"] || "";
    const credentialsOk = timingSafeStringEqual(providedUser, username) && timingSafeStringEqual(providedSecret, secret);
    if (!credentialsOk) {
      recordFailedLogin();
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    let bodyText;
    try {
      bodyText = await readBody(req);
    } catch (err) {
      return sendJson(res, 413, { error: "Request body too large." });
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }

    if (payload && payload.verifyOnly === true) {
      const code = String(payload.totp || "").trim();
      if (!isValidTotp(totpSecret, code)) {
        recordFailedLogin();
        return sendJson(res, 401, { error: "Invalid or expired authentication code." });
      }
      clearFailedLogins();
      return sendJson(res, 200, { ok: true });
    }

    if (!payload || !Array.isArray(payload.rules) || typeof payload.overrides !== "object") {
      return sendJson(res, 400, { error: "Payload missing expected 'rules' array or 'overrides' object." });
    }

    clearFailedLogins();
    await writeRules(payload);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "OPTIONS") return sendEmpty(res, 204);

  return sendJson(res, 405, { error: "Method Not Allowed" });
}

async function handleMovieDetails(req, res, query) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method Not Allowed" });

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return sendJson(res, 500, { error: "TMDB_API_KEY is not configured on the server." });

  const title = (query.get("title") || "").trim();
  const year = parseInt(query.get("year"), 10);
  if (!title || !year) return sendJson(res, 400, { error: "Both 'title' and 'year' query params are required." });

  try {
    const tmdbData = await getTmdbData(title, year, apiKey);
    if (!tmdbData.found) return sendJson(res, 200, tmdbData);

    // Ratings are cached separately and much longer-lived than the TMDB data
    // above (see getRatingsCached) — a score from OMDb rarely changes, unlike
    // streaming availability, so there's no reason to tie its freshness to
    // the same 30-day cycle as watch providers.
    const ratings = await getRatingsCached(title, year);
    return sendJson(res, 200, { ...tmdbData, ratings });
  } catch (err) {
    return sendJson(res, 502, { error: `TMDB lookup failed: ${err.message}` });
  }
}

async function getTmdbData(title, year, apiKey) {
  const cacheKey = `moviedetails:${title.toLowerCase()}|${year}`;
  const cached = await readCache(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const searchUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`TMDB search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();

  const match = (searchData.results || [])[0];
  if (!match) {
    const empty = { found: false };
    await writeCache(cacheKey, { fetchedAt: Date.now(), data: empty });
    return empty;
  }

  const detailsUrl = `${TMDB_BASE}/movie/${match.id}?api_key=${apiKey}&append_to_response=watch/providers`;
  const detailsRes = await fetch(detailsUrl);
  if (!detailsRes.ok) throw new Error(`TMDB details failed: ${detailsRes.status}`);
  const details = await detailsRes.json();

  const regionProviders = (details["watch/providers"] && details["watch/providers"].results && details["watch/providers"].results[WATCH_REGION]) || {};
  const simplifyProviders = (list) =>
    (list || []).map((p) => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w45${p.logo_path}` : null }));

  const data = {
    found: true,
    tmdbId: match.id,
    overview: details.overview || "",
    watchProviders: {
      flatrate: simplifyProviders(regionProviders.flatrate),
      rent: simplifyProviders(regionProviders.rent),
      buy: simplifyProviders(regionProviders.buy),
    },
    watchLink: regionProviders.link || null,
  };

  await writeCache(cacheKey, { fetchedAt: Date.now(), data });
  return data;
}

// Ratings, once found, are cached indefinitely — no re-fetching a score
// that essentially never changes. A *miss* (OMDb doesn't have it, or the
// lookup failed) is retried after a week rather than cached forever, in
// case it was transient or the title just wasn't in OMDb's database yet.
const RATINGS_RETRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function getRatingsCached(title, year) {
  const key = `ratings:${title.toLowerCase()}|${year}`;
  const cached = await readCache(key);
  if (cached) {
    if (cached.data !== null) return cached.data; // found previously — permanent
    if (Date.now() - cached.fetchedAt < RATINGS_RETRY_TTL_MS) return null; // recent miss — not due for retry yet
  }
  const ratings = await fetchOmdbRatings(title, year);
  await writeCache(key, { fetchedAt: Date.now(), data: ratings });
  return ratings;
}

// OMDb ratings (IMDb, Rotten Tomatoes, Metacritic) — kept separate from the
// TMDB flow above on purpose: OMDb is a much smaller, single-person-run
// service, so a hiccup there shouldn't take down the overview/streaming
// info that TMDB already gave us.
async function fetchOmdbRatings(title, year) {
  const omdbKey = process.env.OMDB_API_KEY;
  if (!omdbKey) return null;

  try {
    const url = `https://www.omdbapi.com/?apikey=${omdbKey}&t=${encodeURIComponent(title)}&y=${year}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.Response !== "True" || !Array.isArray(json.Ratings)) return null;

    const bySource = {};
    for (const r of json.Ratings) bySource[r.Source] = r.Value;

    const ratings = {
      imdb: bySource["Internet Movie Database"] || null,
      rottenTomatoes: bySource["Rotten Tomatoes"] || null,
      metacritic: bySource["Metacritic"] || null,
    };
    // If literally none of the three came back, treat it the same as no data.
    if (!ratings.imdb && !ratings.rottenTomatoes && !ratings.metacritic) return null;
    return ratings;
  } catch (err) {
    return null;
  }
}

/* ---------- static file serving ---------- */

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

async function handleStatic(req, res, pathname) {
  // Default to index.html for the root; otherwise use the requested path as-is.
  let relPath = pathname === "/" ? "/index.html" : pathname;

  // Resolve against STATIC_DIR and refuse anything that would escape it —
  // this is the one thing that actually matters for safety here, since
  // this process is directly reachable from the public internet.
  const resolved = path.normalize(path.join(STATIC_DIR, relPath));
  if (!resolved.startsWith(path.normalize(STATIC_DIR + path.sep)) && resolved !== path.normalize(STATIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }

  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache, must-revalidate",
    });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/calendar-rules") return await handleCalendarRules(req, res);
    if (url.pathname === "/api/movie-details") return await handleMovieDetails(req, res, url.searchParams);
    return await handleStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
});

ensureDataDir().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`movie-finder server listening on ${HOST}:${PORT}`);
  });
});
