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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret, X-Admin-Username",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

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
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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

    const providedUser = req.headers["x-admin-username"];
    const providedSecret = req.headers["x-admin-secret"];
    if (providedUser !== username || providedSecret !== secret) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }

    if (payload && payload.verifyOnly === true) {
      const code = String(payload.totp || "").trim();
      if (!isValidTotp(totpSecret, code)) {
        return sendJson(res, 401, { error: "Invalid or expired authentication code." });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (!payload || !Array.isArray(payload.rules) || typeof payload.overrides !== "object") {
      return sendJson(res, 400, { error: "Payload missing expected 'rules' array or 'overrides' object." });
    }

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

  const cacheKey = `moviedetails:${title.toLowerCase()}|${year}`;

  try {
    const cached = await readCache(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return sendJson(res, 200, cached.data);
    }

    const searchUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) throw new Error(`TMDB search failed: ${searchRes.status}`);
    const searchData = await searchRes.json();

    const match = (searchData.results || [])[0];
    if (!match) {
      const empty = { found: false };
      await writeCache(cacheKey, { fetchedAt: Date.now(), data: empty });
      return sendJson(res, 200, empty);
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
    return sendJson(res, 200, data);
  } catch (err) {
    return sendJson(res, 502, { error: `TMDB lookup failed: ${err.message}` });
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
