// Grows data/movies.json by pulling additional movies directly from TMDB's
// full catalog (not just the original curated snapshot), fully enriched on
// the way in — runtime, cast, director, keywords, and streaming
// availability all come from ONE details call per movie via
// append_to_response, so new entries don't need a separate backfill step.
//
// Quality bar: only pulls movies with at least MIN_VOTE_COUNT votes on
// TMDB, to avoid extremely obscure/incomplete entries.
//
// Safe to re-run later — dedupes against what's already in movies.json
// (by title+year), so running it again just tops up with anything new
// (including movies released since the last run) rather than duplicating.
//
// Long-running: expect several hours for a large TARGET_NEW_COUNT. Uses
// the same rate-limited pattern as the other batch scripts, with frequent
// checkpointing so an interruption doesn't lose progress.

const fs = require("fs/promises");
const path = require("path");

// Writes atomically: to a temp file first, then rename()s it into place —
// a filesystem-guaranteed all-or-nothing swap. Protects against a crash
// or kill mid-write leaving this file truncated and unparseable, which
// would otherwise take down the whole site until manually fixed.
async function atomicWriteFile(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tmpPath, content);
  await fs.rename(tmpPath, filePath);
}


const TMDB_BASE = "https://api.themoviedb.org/3";
const DELAY_MS = 300; // ~3.3 req/sec, safely under TMDB's limit
const CHECKPOINT_EVERY = 250;
const WATCH_REGION = "US";

const MIN_VOTE_COUNT = Number(process.env.MIN_VOTE_COUNT) || 50;
const TARGET_NEW_COUNT = Number(process.env.TARGET_NEW_COUNT) || 40000;

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname);
const MOVIES_FILE = path.join(STATIC_DIR, "data", "movies.json");
const PROVIDERS_FILE = path.join(STATIC_DIR, "data", "watch-providers.json");

// Decades to partition discovery across — TMDB's /discover/movie caps out
// at 500 pages (10,000 results) per single query, so one query covering
// all years would silently miss anything past that cap. Splitting by
// decade works around it, and recent decades (with far more catalog
// coverage) naturally get the deepest pagination.
const DECADES = [];
for (let d = 1920; d <= 2020; d += 10) DECADES.push(d);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGenreMap(apiKey) {
  const res = await fetch(`${TMDB_BASE}/genre/movie/list?api_key=${apiKey}`);
  const data = await res.json();
  const map = {};
  for (const g of data.genres || []) map[g.id] = g.name;
  return map;
}

async function discoverPage(apiKey, decadeStart, page) {
  const url = `${TMDB_BASE}/discover/movie?api_key=${apiKey}&sort_by=popularity.desc&vote_count.gte=${MIN_VOTE_COUNT}&primary_release_date.gte=${decadeStart}-01-01&primary_release_date.lte=${decadeStart + 9}-12-31&page=${page}`;
  const res = await fetch(url);
  if (!res.ok) return { results: [], total_pages: 0 };
  return res.json();
}

async function fetchFullDetails(apiKey, id) {
  const url = `${TMDB_BASE}/movie/${id}?api_key=${apiKey}&append_to_response=credits,keywords,watch/providers`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function buildMovieRecord(details, genreMap) {
  const year = details.release_date ? parseInt(details.release_date.slice(0, 4), 10) : null;
  if (!year) return null;

  const genres = (details.genres || []).map((g) => g.name);
  const cast = ((details.credits && details.credits.cast) || [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .slice(0, 5)
    .map((c) => c.name);
  const directors = ((details.credits && details.credits.crew) || [])
    .filter((c) => c.job === "Director")
    .map((c) => c.name);
  const keywords = ((details.keywords && details.keywords.keywords) || []).slice(0, 8).map((k) => k.name);

  const record = {
    t: details.title,
    y: year,
    g: genres.length ? genres : (details.genre_ids || []).map((id) => genreMap[id]).filter(Boolean),
    o: (details.overview || "").trim(),
    r: Math.round((details.vote_average || 0) * 10) / 10,
    p: Math.round((details.popularity || 0) * 10) / 10,
  };
  if (details.runtime && details.runtime > 0) record.rt = details.runtime;
  if (keywords.length) record.k = keywords;
  if (details.poster_path) record.pu = `https://image.tmdb.org/t/p/original${details.poster_path}`;
  if (cast.length) record.c = cast;
  if (directors.length) record.d = directors;

  const regionProviders = (details["watch/providers"] && details["watch/providers"].results && details["watch/providers"].results[WATCH_REGION]) || {};
  const simplifyProviders = (list) =>
    (list || []).map((p) => ({ name: p.provider_name, logo: p.logo_path ? `https://image.tmdb.org/t/p/w45${p.logo_path}` : null }));
  const watchProviders = {
    flatrate: simplifyProviders(regionProviders.flatrate),
    rent: simplifyProviders(regionProviders.rent),
    buy: simplifyProviders(regionProviders.buy),
  };

  return { record, watchProviders };
}

async function main() {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("TMDB_API_KEY must be set in the environment to run this script.");
    process.exit(1);
  }

  const movies = JSON.parse(await fs.readFile(MOVIES_FILE, "utf8"));
  let watchProviders = {};
  try {
    watchProviders = JSON.parse(await fs.readFile(PROVIDERS_FILE, "utf8"));
  } catch (err) {
    // doesn't exist yet — fine, we'll create it
  }

  const existingKeys = new Set(movies.map((m) => `${m.t.toLowerCase()}|${m.y}`));
  console.log(`Loaded ${movies.length} existing movies. Target: ${TARGET_NEW_COUNT} new ones (min ${MIN_VOTE_COUNT} votes on TMDB).`);

  const genreMap = await fetchGenreMap(apiKey);
  await sleep(DELAY_MS);

  let addedSinceCheckpoint = 0;
  let totalAdded = 0;
  let totalSkippedDupes = 0;
  let totalFailed = 0;

  for (const decadeStart of DECADES) {
    if (totalAdded >= TARGET_NEW_COUNT) break;
    console.log(`--- ${decadeStart}s ---`);

    for (let page = 1; page <= 500; page++) {
      if (totalAdded >= TARGET_NEW_COUNT) break;

      const pageData = await discoverPage(apiKey, decadeStart, page);
      await sleep(DELAY_MS);
      const results = pageData.results || [];
      if (results.length === 0) break; // ran out of pages for this decade

      for (const candidate of results) {
        if (totalAdded >= TARGET_NEW_COUNT) break;

        const year = candidate.release_date ? parseInt(candidate.release_date.slice(0, 4), 10) : null;
        if (!candidate.title || !year) continue;
        const key = `${candidate.title.toLowerCase()}|${year}`;
        if (existingKeys.has(key)) {
          totalSkippedDupes++;
          continue;
        }

        try {
          const details = await fetchFullDetails(apiKey, candidate.id);
          await sleep(DELAY_MS);
          if (!details) {
            totalFailed++;
            continue;
          }
          const built = buildMovieRecord(details, genreMap);
          if (!built) {
            totalFailed++;
            continue;
          }
          movies.push(built.record);
          existingKeys.add(key);
          const hasAnyProvider = built.watchProviders.flatrate.length || built.watchProviders.rent.length || built.watchProviders.buy.length;
          if (hasAnyProvider) watchProviders[key] = built.watchProviders;
          totalAdded++;
          addedSinceCheckpoint++;
        } catch (err) {
          totalFailed++;
          console.error(`  failed on "${candidate.title}" (${year}): ${err.message}`);
        }

        if (addedSinceCheckpoint >= CHECKPOINT_EVERY) {
          await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
          await atomicWriteFile(PROVIDERS_FILE, JSON.stringify(watchProviders));
          console.log(`  ...${totalAdded} added so far (checkpoint saved, ${totalSkippedDupes} dupes skipped, ${totalFailed} failed)`);
          addedSinceCheckpoint = 0;
        }
      }

      if (page >= (pageData.total_pages || 1)) break; // exhausted this decade's results
    }
  }

  await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
  await atomicWriteFile(PROVIDERS_FILE, JSON.stringify(watchProviders));
  console.log(`Done. Added ${totalAdded} new movies (${movies.length} total). Skipped ${totalSkippedDupes} already-present, ${totalFailed} failed lookups.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
