// One-time batch job: fetches IMDb/Rotten Tomatoes/Metacritic ratings from
// OMDb for every movie in data/movies.json that doesn't already have them,
// baking the result directly into each movie record as `rr`. This is what
// lets the live site show ratings without ever calling OMDb itself — the
// ticket display just reads movie.rr directly, no live API call involved.
//
// Skips movies that already have ratings, so it's safe to re-run later
// (e.g. after growing the catalog with new movies) — it'll only fetch
// whatever's actually missing.
//
// OMDb's free tier caps at 1,000 requests/day — for a catalog with tens
// of thousands of movies, this will need multiple daily runs to fully
// cover everything. The script stops cleanly and reports its progress
// when it senses the daily limit has been hit, rather than continuing to
// burn through failed requests.

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


const DELAY_MS = 300;
const CHECKPOINT_EVERY = 200;
const DAILY_LIMIT_STOP_THRESHOLD = 5; // stop after this many consecutive "limit exceeded" responses

const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname);
const MOVIES_FILE = path.join(STATIC_DIR, "data", "movies.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOmdbRatings(title, year, apiKey) {
  const url = `https://www.omdbapi.com/?apikey=${apiKey}&t=${encodeURIComponent(title)}&y=${year}`;
  const res = await fetch(url);
  if (!res.ok) return { ratings: null, limitHit: false };
  const json = await res.json();

  if (json.Response !== "True") {
    // OMDb's daily-limit response looks like {"Response":"False","Error":"Request limit reached!"}
    const limitHit = /limit/i.test(json.Error || "");
    return { ratings: null, limitHit };
  }
  if (!Array.isArray(json.Ratings)) return { ratings: null, limitHit: false };

  const bySource = {};
  for (const r of json.Ratings) bySource[r.Source] = r.Value;
  const ratings = {
    imdb: bySource["Internet Movie Database"] || null,
    rottenTomatoes: bySource["Rotten Tomatoes"] || null,
    metacritic: bySource["Metacritic"] || null,
  };
  if (!ratings.imdb && !ratings.rottenTomatoes && !ratings.metacritic) return { ratings: null, limitHit: false };
  return { ratings, limitHit: false };
}

async function main() {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) {
    console.error("OMDB_API_KEY must be set in the environment to run this script.");
    process.exit(1);
  }

  const movies = JSON.parse(await fs.readFile(MOVIES_FILE, "utf8"));
  const needsRatings = movies.filter((m) => !m.rr);
  console.log(`Loaded ${movies.length} movies, ${needsRatings.length} missing ratings.`);

  let processed = 0;
  let filled = 0;
  let consecutiveLimitHits = 0;
  let stoppedEarly = false;

  for (const movie of needsRatings) {
    try {
      const { ratings, limitHit } = await fetchOmdbRatings(movie.t, movie.y, apiKey);
      if (limitHit) {
        consecutiveLimitHits++;
        if (consecutiveLimitHits >= DAILY_LIMIT_STOP_THRESHOLD) {
          console.log(`Looks like OMDb's daily limit has been hit (${consecutiveLimitHits} limit responses in a row). Stopping cleanly — re-run this same command tomorrow to keep going from here.`);
          stoppedEarly = true;
          break;
        }
      } else {
        consecutiveLimitHits = 0;
        if (ratings) {
          movie.rr = ratings;
          filled++;
        }
      }
    } catch (err) {
      console.error(`  failed on "${movie.t}" (${movie.y}): ${err.message}`);
    }

    processed++;
    await sleep(DELAY_MS);

    if (processed % CHECKPOINT_EVERY === 0) {
      await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
      console.log(`  ...${processed}/${needsRatings.length} processed, ${filled} filled in so far (checkpoint saved)`);
    }
  }

  await atomicWriteFile(MOVIES_FILE, JSON.stringify(movies));
  if (stoppedEarly) {
    console.log(`Stopped early due to OMDb's daily limit. Filled ${filled} of ${needsRatings.length} that were missing ratings this run. Saved to ${MOVIES_FILE}`);
  } else {
    console.log(`Done. Filled ratings for ${filled} of ${needsRatings.length} movies that were missing them. Saved to ${MOVIES_FILE}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
