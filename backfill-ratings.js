#!/usr/bin/env node
/**
 * backfill-ratings.js
 *
 * Nightly batch job: looks up IMDb / Rotten Tomatoes / Metacritic scores
 * from OMDb for movies that don't have them yet, and saves them into
 * movies.json. Designed to run once a night via cron and respect OMDb's
 * free-tier daily cap (1,000 requests/day).
 *
 * Fix (2026-10-01) — three bugs in the previous version:
 *   1. The old code returned early on any non-200 HTTP status WITHOUT
 *      reading the response body, so OMDb's "daily limit reached"
 *      response was silently treated as an ordinary miss instead of
 *      stopping the run. That meant the job burned through the entire
 *      remaining movie list (tens of thousands of wasted requests)
 *      every night instead of stopping cleanly after a handful of
 *      limit hits.
 *   2. There was no memory of movies OMDb couldn't match, so the same
 *      unmatched titles were retried (and re-failed) every single
 *      night, eating into the real daily quota. Misses are now
 *      recorded and skipped for NOT_FOUND_RETRY_DAYS before being
 *      retried.
 *   3. The work list is now sorted most-popular-first (using each
 *      movie's existing `p` popularity field) so a limited nightly
 *      quota goes toward movies people are actually likely to view.
 *
 * Env vars:
 *   OMDB_API_KEY            required
 *   STATIC_DIR              defaults to ./data (same dir as movies.json)
 *   MAX_PER_RUN             requests to spend this run (default 950,
 *                            just under OMDb's 1,000/day free cap)
 *   DELAY_MS                delay between requests (default 250ms)
 *   CHECKPOINT_EVERY        save progress every N requests (default 25)
 *   NOT_FOUND_RETRY_DAYS    days to skip a miss before retrying (default 30)
 *   DAILY_LIMIT_STOP_THRESHOLD  consecutive limit-responses before
 *                            stopping the run (default 3)
 */

const fs = require("fs/promises");
const path = require("path");

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, "data");
const MOVIES_FILE = path.join(STATIC_DIR, "movies.json");
const NOT_FOUND_FILE = path.join(STATIC_DIR, "ratings-not-found.json");

const OMDB_API_KEY = process.env.OMDB_API_KEY;
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || "950", 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || "250", 10);
const CHECKPOINT_EVERY = parseInt(process.env.CHECKPOINT_EVERY || "25", 10);
const NOT_FOUND_RETRY_DAYS = parseInt(process.env.NOT_FOUND_RETRY_DAYS || "30", 10);
const NOT_FOUND_RETRY_MS = NOT_FOUND_RETRY_DAYS * 24 * 60 * 60 * 1000;
const DAILY_LIMIT_STOP_THRESHOLD = parseInt(process.env.DAILY_LIMIT_STOP_THRESHOLD || "3", 10);

// Allow tests to inject a fake fetch/clock without touching globals permanently.
const fetchImpl = globalThis.__TEST_FETCH__ || globalThis.fetch;
const now = () => (globalThis.__TEST_NOW__ ? globalThis.__TEST_NOW__() : Date.now());

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function atomicWriteFile(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

/**
 * Calls OMDb for one title/year and classifies the response.
 * Always reads the response body, regardless of HTTP status, so a
 * daily-limit response (which OMDb can return with a non-200 status)
 * is never mistaken for an ordinary "not found" miss.
 *
 * Returns one of:
 *   { status: "ok", ratings: { imdb, rt, metacritic } }
 *   { status: "not_found" }
 *   { status: "limit" }
 *   { status: "bad_key", error }
 *   { status: "http_error", httpStatus, error }
 *   { status: "network_error", error }
 */
async function fetchOmdbRatings(title, year) {
  const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&y=${encodeURIComponent(
    year
  )}&apikey=${OMDB_API_KEY}`;

  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    return { status: "network_error", error: err.message };
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  const errText = (body && body.Error) || "";

  // OMDb's daily-limit response has shown up as both a 401 and other
  // non-200 statuses with "limit" in the error text — check the text
  // first since that's the one reliable signal.
  if (/request limit reached/i.test(errText) || res.status === 429) {
    return { status: "limit" };
  }

  if (/invalid api key/i.test(errText)) {
    return { status: "bad_key", error: errText };
  }

  if (!res.ok) {
    // Some other non-200 we don't specifically recognize. Don't guess —
    // surface it distinctly so a run doesn't silently misfile it as a
    // movie miss, and don't record it in not-found memory.
    return { status: "http_error", httpStatus: res.status, error: errText || `HTTP ${res.status}` };
  }

  if (!body || body.Response === "False") {
    return { status: "not_found", error: errText || "Not found" };
  }

  const ratings = { imdb: null, rt: null, metacritic: null };
  for (const r of body.Ratings || []) {
    if (r.Source === "Internet Movie Database") ratings.imdb = r.Value;
    if (r.Source === "Rotten Tomatoes") ratings.rt = r.Value;
    if (r.Source === "Metacritic") ratings.metacritic = r.Value;
  }
  return { status: "ok", ratings };
}

function keyFor(movie) {
  return `${movie.title_ ?? movie.title}|${movie.year ?? movie.y}`;
}

async function run() {
  if (!OMDB_API_KEY) {
    console.error("OMDB_API_KEY is not set. Aborting.");
    process.exitCode = 1;
    return;
  }

  const movies = await readJson(MOVIES_FILE, null);
  if (!movies) {
    console.error(`Could not read ${MOVIES_FILE}. Aborting.`);
    process.exitCode = 1;
    return;
  }

  const notFound = await readJson(NOT_FOUND_FILE, {});

  const nowTs = now();
  let needsRatings = movies.filter((m) => {
    if (m.rr) return false;
    const k = keyFor(m);
    const lastTried = notFound[k];
    if (lastTried && nowTs - lastTried < NOT_FOUND_RETRY_MS) return false;
    return true;
  });

  // Most-popular-first, so a capped nightly quota goes toward movies
  // people are actually likely to look at.
  needsRatings.sort((a, b) => (b.p || 0) - (a.p || 0));

  const toProcess = needsRatings.slice(0, MAX_PER_RUN);

  console.log(
    `Loaded ${needsRatings.length} missing ratings (${toProcess.length} to attempt this run, ` +
      `${Object.keys(notFound).length} remembered misses skipped).`
  );

  let filled = 0;
  let newMisses = 0;
  let consecutiveLimitHits = 0;
  let consecutiveNetworkErrors = 0;
  let stoppedReason = null;
  let processed = 0;

  for (const movie of toProcess) {
    const title = movie.title_ ?? movie.title;
    const year = movie.year ?? movie.y;
    const result = await fetchOmdbRatings(title, year);
    processed++;

    if (result.status === "ok") {
      movie.rr = result.ratings;
      delete notFound[keyFor(movie)];
      filled++;
      consecutiveLimitHits = 0;
      consecutiveNetworkErrors = 0;
    } else if (result.status === "not_found") {
      notFound[keyFor(movie)] = nowTs;
      newMisses++;
      consecutiveLimitHits = 0;
      consecutiveNetworkErrors = 0;
    } else if (result.status === "limit") {
      consecutiveLimitHits++;
      console.log(`Hit OMDb's daily limit (${consecutiveLimitHits}/${DAILY_LIMIT_STOP_THRESHOLD}).`);
      if (consecutiveLimitHits >= DAILY_LIMIT_STOP_THRESHOLD) {
        stoppedReason = "daily_limit";
        break;
      }
    } else if (result.status === "bad_key") {
      console.error(`OMDb rejected the API key: ${result.error}. Stopping immediately.`);
      stoppedReason = "bad_key";
      break;
    } else if (result.status === "network_error") {
      consecutiveNetworkErrors++;
      console.log(`Network error (${consecutiveNetworkErrors}/${DAILY_LIMIT_STOP_THRESHOLD}): ${result.error}`);
      if (consecutiveNetworkErrors >= DAILY_LIMIT_STOP_THRESHOLD) {
        stoppedReason = "network_outage";
        break;
      }
    } else if (result.status === "http_error") {
      console.log(`Unexpected OMDb response (HTTP ${result.httpStatus}): ${result.error}`);
      consecutiveLimitHits++;
      if (consecutiveLimitHits >= DAILY_LIMIT_STOP_THRESHOLD) {
        stoppedReason = "unexpected_errors";
        break;
      }
    }

    if (processed % CHECKPOINT_EVERY === 0) {
      await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
      await atomicWriteFile(NOT_FOUND_FILE, JSON.stringify(notFound));
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
  await atomicWriteFile(NOT_FOUND_FILE, JSON.stringify(notFound));

  console.log(`Filled ${filled} ratings. ${newMisses} new not-found (remembered for ${NOT_FOUND_RETRY_DAYS} days).`);
  if (stoppedReason === "daily_limit") {
    console.log("Stopped early due to OMDb's daily limit.");
  } else if (stoppedReason === "bad_key") {
    console.log("Stopped early: OMDb API key appears invalid.");
  } else if (stoppedReason === "network_outage") {
    console.log("Stopped early due to repeated network errors.");
  } else if (stoppedReason === "unexpected_errors") {
    console.log("Stopped early due to repeated unexpected OMDb responses.");
  } else {
    console.log("Done.");
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  });
}

module.exports = { fetchOmdbRatings, run };
