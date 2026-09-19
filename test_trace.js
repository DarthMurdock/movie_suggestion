const fs = require("fs");
const { JSDOM } = require("jsdom");

(async () => {
  const movies = JSON.parse(fs.readFileSync("data/movies.json", "utf8"));
  const rulesObj = JSON.parse(fs.readFileSync("data/calendar-rules.json", "utf8"));
  const today = new Date();
  const pad2 = n => String(n).padStart(2,"0");
  const isoDate = `${today.getFullYear()}-${pad2(today.getMonth()+1)}-${pad2(today.getDate())}`;
  rulesObj.overrides = rulesObj.overrides || {};
  rulesObj.overrides[isoDate] = { type: "pin", title: "The Matrix", year: 1999, label: "TEST LABEL" };
  console.log("SETUP: override key:", isoDate, "overrides has key:", isoDate in rulesObj.overrides);

  const html = fs.readFileSync("calendar.html", "utf8")
    .replace(/<link[^>]*>/g, "")
    .replace(/<script src="calendar-engine.js"><\/script>/, "")
    .replace(/<script src="calendar.js"><\/script>/, "");
  const engineJs = fs.readFileSync("calendar-engine.js", "utf8");
  const calJs = fs.readFileSync("calendar.js", "utf8");
  const dom = new JSDOM(html, { url: "http://localhost:8808/calendar.html", runScripts: "dangerously" });
  const { window } = dom;
  window.fetch = async (url) => {
    console.log("FETCH:", url);
    if (url.includes("movies.json")) return { status: 200, ok: true, json: async () => movies };
    if (url.includes("watch-providers.json")) return { ok: true, json: async () => ({}) };
    if (url === "data/calendar-rules.json") { console.log("  -> returning rulesObj with override"); return { status: 200, ok: true, json: async () => rulesObj }; }
    if (url.includes("/api/calendar-rules")) return { status: 204, ok: true, json: async () => null };
    return global.fetch(`http://localhost:8808/${url}`);
  };
  const doc = window.document;
  const inject = (code) => { const s = doc.createElement("script"); s.textContent = code; doc.body.appendChild(s); };
  inject(engineJs); inject(calJs);
  await new Promise(r => setTimeout(r, 1200));

  console.log("detail-kicker text:", doc.getElementById("detail-kicker").textContent);
  console.log("detail-title:", doc.getElementById("detail-title").textContent);

  process.exit(0);
})().catch(e => { console.error("ERROR", e.stack); process.exit(1); });
