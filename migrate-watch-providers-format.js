// One-time LOCAL migration — no API calls at all. Reshapes an old-format
// watch-providers.json (flat array of provider name strings) into the
// current format ({flatrate, rent, buy}, each an array of {name, logo}).
//
// This exists because the data format changed after the last time
// refresh-watch-providers.js actually ran, leaving old-shaped data on
// disk that the current code can't read. Running this restores full
// functionality (search filtering, a basic "Where to watch" list)
// immediately — the only thing it can't recover is logos and rent/buy
// info, since the old format never captured those. Those fill in
// naturally the next time the real refresh job runs (monthly cron, or
// run it manually if you don't want to wait).
//
// Safe to run even if the file's already in the new format — detects
// that per-entry and leaves those alone.

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


const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname);
const FILE = path.join(STATIC_DIR, "data", "watch-providers.json");

async function main() {
  const data = JSON.parse(await fs.readFile(FILE, "utf8"));

  let migrated = 0;
  let alreadyCurrent = 0;

  for (const key of Object.keys(data)) {
    const value = data[key];
    if (Array.isArray(value)) {
      data[key] = {
        flatrate: value.map((name) => ({ name, logo: null })),
        rent: [],
        buy: [],
      };
      migrated++;
    } else {
      alreadyCurrent++;
    }
  }

  await atomicWriteFile(FILE, JSON.stringify(data));
  console.log(`Migrated ${migrated} entries to the current format (${alreadyCurrent} were already current). Saved to ${FILE}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
