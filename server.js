// Self-hosted, all-in-one server: serves both the calendar-rules API route
// and the static files (HTML/CSS/JS/data) directly. No nginx or other
// reverse proxy involved — this process is the whole thing. Binds to
// localhost only; Cloudflare Tunnel (cloudflared, already running on this
// Pi) reaches it over loopback and is the only path in from outside.
//
// Deliberately makes NO calls to TMDB or OMDb itself — movie overviews,
// ratings, and streaming availability are all baked into the static data
// files by separate batch scripts (grow-catalog.js, backfill-ratings.js,
// refresh-watch-providers.js, backfill-runtime.js), run manually or on a
// schedule, not triggered by visitor traffic. That means API usage is
// bounded and predictable regardless of how much traffic the site gets.
//
// Storage: KV becomes a plain JSON file on disk (DATA_DIR/rules.json for
// the calendar config).

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || "/var/lib/movie-finder";
const RULES_FILE = path.join(DATA_DIR, "rules.json");
const STATIC_DIR = process.env.STATIC_DIR || __dirname;
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "127.0.0.1";

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
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readRules() {
  try {
    return JSON.parse(await fs.readFile(RULES_FILE, "utf8"));
  } catch (err) {
    return null; // doesn't exist yet — nothing published
  }
}

// Writes atomically: to a temp file first, then rename()s it into place —
// a filesystem-guaranteed all-or-nothing swap. Protects against this
// always-running process getting killed (power loss, OOM, a systemd
// restart) mid-write, which would otherwise leave the calendar config
// truncated and unparseable until manually fixed.
async function writeRules(data) {
  const tmpPath = `${RULES_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(data));
  await fs.rename(tmpPath, RULES_FILE);
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

/* ---------- share links (movie-specific Open Graph previews) ---------- */

// Loaded once at startup rather than re-read per request — movies.json is
// tens of MB at this catalog's size, and re-parsing it on every share-link
// visit would add a real, avoidable delay (measured ~150-200ms even on
// decent hardware, likely worse on a Pi). The service restarts on every
// deploy anyway, so a startup-time load never goes stale in practice.
let moviesCache = [];

async function loadMoviesCache() {
  try {
    const content = await fs.readFile(path.join(STATIC_DIR, "data", "movies.json"), "utf8");
    moviesCache = JSON.parse(content);
    console.log(`Loaded ${moviesCache.length} movies into memory for share links.`);
  } catch (err) {
    console.error("Couldn't load movies.json for share links:", err.message);
    moviesCache = [];
  }
}

function escapeHtmlServer(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function handleShare(req, res, query) {
  const title = (query.get("t") || "").trim();
  const year = parseInt(query.get("y"), 10);
  const movie = moviesCache.find((m) => m.t === title && m.y === year);
  const deepLink = movie ? `/?t=${encodeURIComponent(movie.t)}&y=${movie.y}` : "/";

  if (!movie) {
    // Unknown movie (bad/stale link) — just send them to the homepage
    // rather than erroring, no generic-but-real OG preview needed here.
    res.writeHead(302, { Location: deepLink });
    return res.end();
  }

  const title_ = escapeHtmlServer(movie.t);
  const overview = escapeHtmlServer((movie.o || "").slice(0, 200));
  const image = movie.pu || "https://tonightsflick.com/assets/og-image.png";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title_} (${movie.y}) — Tonight's Pick</title>
<meta name="description" content="${overview}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tonight's Pick">
<meta property="og:title" content="${title_} (${movie.y})">
<meta property="og:description" content="${overview}">
<meta property="og:image" content="${image}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title_} (${movie.y})">
<meta name="twitter:description" content="${overview}">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0; url=${deepLink}">
<link rel="canonical" href="https://tonightsflick.com${deepLink}">
</head>
<body>
<p>Taking you to <a href="${deepLink}">${title_}</a>&hellip;</p>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/calendar-rules") return await handleCalendarRules(req, res);
    if (url.pathname === "/share") return await handleShare(req, res, url.searchParams);
    return await handleStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
});

Promise.all([ensureDataDir(), loadMoviesCache()]).then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`movie-finder server listening on ${HOST}:${PORT}`);
  });
});
