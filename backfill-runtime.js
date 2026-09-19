// One-time batch job: fills in runtime for every movie in data/movies.json
// that doesn't already have it (~7,000 of ~9,800, since only the subset
// overlapping the secondary TMDB export already has this). Unlike
// watch-providers, runtime essentially never changes once set, so this
// only needs to run once — no monthly cron job needed.
//
// Takes roughly 45-70 minutes (two TMDB calls per movie needing a fill:
// search, then a details lookup for the runtime field), rate-limited to
// stay well under TMDB's per-second limit.

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
const CHECKPOINT_EVERY = 200;

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname);
const MOVIES_FILE = path.join(STATIC_DIR, "data", "movies.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRuntimeFor(title, year, apiKey) {
  const searchUrl = `${TMDB_BASE}/search/movie?api_key=${apiKey}&query=${encodeURIComponent(title)}&year=${year}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const match = (searchData.results || [])[0];
  if (!match) return null;

  await sleep(DELAY_MS);

  const detailsUrl = `${TMDB_BASE}/movie/${match.id}?api_key=${apiKey}`;
  const detailsRes = await fetch(detailsUrl);
  if (!detailsRes.ok) return null;
  const detailsData = await detailsRes.json();
  return detailsData.runtime && detailsData.runtime > 0 ? detailsData.runtime : null;
}

async function main() {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    console.error("TMDB_API_KEY must be set in the environment to run this script.");
    process.exit(1);
  }

  const movies = JSON.parse(await fs.readFile(MOVIES_FILE, "utf8"));
  const needsRuntime = movies.filter((m) => !m.rt);
  console.log(`Loaded ${movies.length} movies, ${needsRuntime.length} missing runtime. Starting backfill — this will take roughly ${Math.round((needsRuntime.length * 2 * DELAY_MS) / 60000)} minutes.`);

  let processed = 0;
  let filled = 0;

  for (const movie of needsRuntime) {
    try {
      const runtime = await fetchRuntimeFor(movie.t, movie.y, apiKey);
      if (runtime) {
        movie.rt = runtime;
        filled++;
      }
    } catch (err) {
      console.error(`  failed on "${movie.t}" (${movie.y}): ${err.message}`);
    }

    processed++;
    await sleep(DELAY_MS);

    if (processed % CHECKPOINT_EVERY === 0) {
      await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
      console.log(`  ...${processed}/${needsRuntime.length} processed, ${filled} filled in so far (checkpoint saved)`);
    }
  }

  await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
  console.log(`Done. Filled runtime for ${filled} of ${needsRuntime.length} movies that were missing it. Saved to ${MOVIES_FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
