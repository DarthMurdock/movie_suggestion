// Batch job: fetches current streaming availability (subscription,
// rent, and buy — with provider logos) for every movie in
// data/movies.json, writing the result to data/watch-providers.json.
// This is used for BOTH the finder's streaming-service search AND the
// "Where to watch" section on each movie's ticket — the ticket display
// used to fetch this live per-visit; now everything comes from this
// pre-built file instead, so normal site traffic never calls TMDB at all.
//
// Run manually once, then on a monthly cron schedule (see DEPLOY.md).
// Takes roughly 60-100 minutes for ~9,800 movies — two TMDB calls per movie
// (search, then watch/providers), rate-limited to stay well under TMDB's
// 40-requests-per-10-seconds limit.

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
const WATCH_REGION = "US";
const DELAY_MS = 300; // ~3.3 req/sec, safely under TMDB's limit
const CHECKPOINT_EVERY = 200; // save partial progress periodically, in case of a crash

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname);
const MOVIES_FILE = path.join(STATIC_DIR, "data", "movies.json");
const OUTPUT_FILE = path.join(STATIC_DIR, "data", "watch-providers.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function simplifyProviders(list) {
  return (list || []).map((p) => ({
    name: p.provider_name,
    logo: p.logo_path ? `https://image.tmdb.org/t/p/w45${p.logo_path}` : null,
  }));
}

async function fetchProvidersFor(title, year, apiKey) {
  const searchUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const match = (searchData.results || [])[0];
  if (!match) return null;

  await sleep(DELAY_MS);

  const detailsUrl = `${TMDB_BASE}/movie/${match.id}/watch/providers?api_key=${apiKey}`;
  const detailsRes = await fetch(detailsUrl);
  if (!detailsRes.ok) return null;
  const detailsData = await detailsRes.json();

  const regionData = (detailsData.results && detailsData.results[WATCH_REGION]) || {};
  const result = {
    flatrate: simplifyProviders(regionData.flatrate),
    rent: simplifyProviders(regionData.rent),
    buy: simplifyProviders(regionData.buy),
  };
  const hasAny = result.flatrate.length || result.rent.length || result.buy.length;
  return hasAny ? result : null; // null, not an empty structure, if nothing to keep the file smaller
}

async function main() {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("TMDB_API_KEY must be set in the environment to run this script.");
    process.exit(1);
  }

  const movies = JSON.parse(await fs.readFile(MOVIES_FILE, "utf8"));
  console.log(`Loaded ${movies.length} movies. Starting refresh — this will take roughly ${Math.round((movies.length * 2 * DELAY_MS) / 60000)} minutes.`);

  const output = {};
  let processed = 0;
  let withProviders = 0;

  for (const movie of movies) {
    const key = `${movie.t.toLowerCase()}|${movie.y}`;
    try {
      const providers = await fetchProvidersFor(movie.t, movie.y, apiKey);
      if (providers) {
        output[key] = providers;
        withProviders++;
      }
    } catch (err) {
      console.error(`  failed on "${movie.t}" (${movie.y}): ${err.message}`);
    }

    processed++;
    await sleep(DELAY_MS);

    if (processed % CHECKPOINT_EVERY === 0) {
      await atomicWriteFile(OUTPUT_FILE, JSON.stringify(output));
      console.log(`  ...${processed}/${movies.length} processed, ${withProviders} with streaming availability (checkpoint saved)`);
    }
  }

  await atomicWriteFile(OUTPUT_FILE, JSON.stringify(output));
  console.log(`Done. ${withProviders} of ${movies.length} movies have streaming availability. Written to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
