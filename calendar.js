(() => {
  "use strict";

  const DATA_ROOT = "data";
  const API_URL = "/api/calendar-rules";
  const el = (id) => document.getElementById(id);

  const state = {
    movies: [],
    rules: null,
    viewMonth: null,   // Date, first of the visible month
    selectedDate: null,
    shuffleOffset: 0,
    liveSource: false,
  };

  const monthLabelEl = el("month-label");
  const dayGridEl = el("day-grid");

  const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  async function loadRules() {
    try {
      const res = await fetch(API_URL);
      if (res.status === 200) {
        state.liveSource = true;
        return await res.json();
      }
      // 204 (nothing published yet) or function unavailable -> fall through to bundled default
    } catch (err) {
      // /api/calendar-rules not reachable (not hosted with the API server running) -> fall through
    }
    state.liveSource = false;
    const res = await fetch(`${DATA_ROOT}/calendar-rules.json`);
    return res.json();
  }

  async function init() {
    const today = new Date();
    state.viewMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    state.selectedDate = today;

    try {
      const [rules, moviesRes] = await Promise.all([
        loadRules(),
        fetch(`${DATA_ROOT}/movies.json`),
      ]);
      state.rules = rules;
      state.movies = await moviesRes.json();
    } catch (err) {
      console.error(err);
      dayGridEl.innerHTML = `<p style="color:var(--text-muted)">Couldn't load calendar data.</p>`;
      return;
    }

    renderGrid();
    renderDetail();

    el("prev-month").addEventListener("click", () => shiftMonth(-1));
    el("next-month").addEventListener("click", () => shiftMonth(1));
    el("shuffle-btn").addEventListener("click", () => {
      state.shuffleOffset += 1;
      renderDetail();
    });
  }

  function shiftMonth(delta) {
    state.viewMonth = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() + delta, 1);
    renderGrid();
  }

  function isSameDate(a, b) {
    return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  const SEASONAL_THEMES = {
    9: { className: "theme-oct", icon: "🎃" },  // October (0-indexed)
    10: { className: "theme-nov", icon: "🍂" }, // November
    11: { className: "theme-dec", icon: "❄️" }, // December
  };

  function applySeasonalTheme(monthIndex) {
    document.body.classList.remove("theme-oct", "theme-nov", "theme-dec");
    const theme = SEASONAL_THEMES[monthIndex];
    if (theme) document.body.classList.add(theme.className);
  }

  function renderGrid() {
    const y = state.viewMonth.getFullYear();
    const m = state.viewMonth.getMonth();
    applySeasonalTheme(m);
    const icon = SEASONAL_THEMES[m] ? `<span class="month-label-icon">${SEASONAL_THEMES[m].icon}</span>` : "";
    monthLabelEl.innerHTML = `${icon}${MONTH_NAMES[m]} ${y}`;

    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = new Date();

    dayGridEl.innerHTML = "";

    for (let i = 0; i < firstWeekday; i++) {
      const filler = document.createElement("div");
      filler.className = "day-cell is-empty";
      dayGridEl.appendChild(filler);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m, d);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "day-cell";

      const rule = CalendarEngine.resolveRuleForDate(date, state.rules);
      if (rule) {
        cell.classList.add(rule.match && rule.match.type === "pin" ? "is-pin" : rule.match && rule.match.type === "curated" ? "is-curated" : "is-tag");
      }
      if (isSameDate(date, today)) cell.classList.add("is-today");
      if (isSameDate(date, state.selectedDate)) cell.classList.add("is-selected");

      cell.innerHTML = `<span class="day-num">${d}</span>` + (rule ? `<span class="day-theme-dot" title="${rule.label}"></span>` : "");
      cell.addEventListener("click", () => {
        state.selectedDate = date;
        state.shuffleOffset = 0;
        renderGrid();
        renderDetail();
      });
      dayGridEl.appendChild(cell);
    }
  }

  function renderDetail() {
    const result = CalendarEngine.pickMovieForDate(state.selectedDate, state.rules, state.movies, state.shuffleOffset);
    const ticket = el("detail-ticket");
    const empty = el("detail-empty");

    if (!result.movie) {
      ticket.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    ticket.hidden = false;

    const dateLabel = state.selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    el("detail-kicker").textContent = result.ruleLabel ? `${dateLabel} · ${result.ruleLabel}` : dateLabel;
    el("detail-title").textContent = result.movie.t;
    el("detail-meta").textContent = `${result.movie.y}` + (result.movie.rt ? ` · ${result.movie.rt} min` : "") + (result.note ? ` · ${result.note}` : "");
    el("detail-tags").innerHTML = result.movie.g.map((g) => `<span class="tag">${g}</span>`).join("");
    el("detail-overview").textContent = result.movie.o || "No synopsis available.";

    const posterEl = el("detail-poster");
    if (posterEl) {
      if (result.movie.pu) {
        posterEl.src = result.movie.pu;
        posterEl.hidden = false;
      } else {
        posterEl.hidden = true;
      }
    }

    el("detail-watch-providers").hidden = true;
    fetchLiveDetails(result.movie);
  }

  /* ---------- live TMDB details (overview + watch providers) ---------- */
  async function fetchLiveDetails(movie) {
    try {
      const res = await fetch(`/api/movie-details?title=${encodeURIComponent(movie.t)}&year=${movie.y}`);
      if (res.status !== 200) return; // API server unreachable — keep static data
      const data = await res.json();
      if (!data.found) return;

      if (data.overview) el("detail-overview").textContent = data.overview;
      renderWatchProviders(data.watchProviders, "detail-watch-providers", "detail-watch-badges");
    } catch (err) {
      // silently keep the static bundled overview
    }
  }

  function renderWatchProviders(providers, sectionId, badgesId) {
    const section = el(sectionId);
    const badgesEl = el(badgesId);
    if (!providers) { section.hidden = true; return; }

    const rows = [];
    if (providers.flatrate && providers.flatrate.length) rows.push(["Stream", providers.flatrate]);
    if (providers.rent && providers.rent.length) rows.push(["Rent", providers.rent]);
    if (providers.buy && providers.buy.length) rows.push(["Buy", providers.buy]);

    if (rows.length === 0) { section.hidden = true; return; }

    badgesEl.innerHTML = rows.map(([label, list]) => `
      <div class="watch-row">
        <span class="watch-row-label">${label}</span>
        <div class="watch-row-providers">
          ${list.map((p) => p.logo
            ? `<img class="watch-logo" src="${p.logo}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}">`
            : `<span class="watch-name-only">${escapeHtml(p.name)}</span>`
          ).join("")}
        </div>
      </div>
    `).join("");
    section.hidden = false;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  init();
})();
