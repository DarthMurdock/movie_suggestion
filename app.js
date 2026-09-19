(() => {
  "use strict";

  const DATA_ROOT = "data";
  const API_URL = "/api/calendar-rules";
  const MAX_SHOWN = 50;

  const state = {
    allMovies: [],
    genres: [],
    tags: [], // { raw, type: 'decade'|'genre'|'actor'|'director'|'streaming'|'text', value, words, label }
    actorIndex: new Map(), // lowercase name -> canonical name
    directorIndex: new Map(), // lowercase name -> canonical name
    providerIndex: new Map(), // lowercase provider name -> canonical name
    watchProviders: {}, // "title|year" (lowercase title) -> array of provider names
  };

  const el = (id) => document.getElementById(id);
  const tagForm = el("tag-form");
  const tagInput = el("tag-input");
  const tagListEl = el("tag-list");
  const matchCountEl = el("match-count");
  const stateEmpty = el("state-empty");
  const stateStart = el("state-start");
  const movieListEl = el("movie-list");
  const resultsZone = document.querySelector(".results-zone");
  const tagZone = document.querySelector(".tag-zone");
  const panelPicked = el("panel-picked");
  const todaysPickZone = el("todays-pick");

  const SYNONYMS = {
    supernatural: ["ghost", "demon", "possess", "haunt", "curse", "witch", "vampire", "occult", "spirit"],
    ghost: ["haunt", "spirit", "supernatural"],
    haunted: ["ghost", "haunt", "spirit"],
    zombie: ["undead", "infected", "outbreak"],
    heist: ["robbery", "steal", "con", "score"],
    romance: ["love", "falls for", "romantic"],
    twist: ["reveal", "secret", "uncover"],
    war: ["battle", "soldier", "military"],
    revenge: ["vengeance", "avenge"],
    dystopia: ["dystopian", "post-apocalyptic", "totalitarian"],
    spy: ["agent", "espionage", "undercover"],
  };

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Whole-word/phrase match, not a raw substring check — otherwise a synonym like
  // "con" (from heist) matches inside "economic", and "steal" matches inside "stealth".
  function wholeWordIncludes(hay, needle) {
    if (!needle) return false;
    return new RegExp(`\\b${escapeRegex(needle)}\\b`).test(hay);
  }

  function depluralize(word) {
    const stems = new Set();
    if (word.length > 4 && word.endsWith("ies")) stems.add(word.slice(0, -3) + "y");
    if (word.length > 4 && word.endsWith("es")) stems.add(word.slice(0, -2));
    if (word.length > 5 && word.endsWith("s") && !word.endsWith("ss")) stems.add(word.slice(0, -1));
    stems.delete(word);
    return Array.from(stems);
  }

  // Words too generic to carry any real meaning in an AND-combination — "time" is true
  // of almost every movie's overview, so requiring it alongside "travel" barely narrows
  // anything down. Only filtered out of multi-word queries, never single-word ones.
  const STOPWORDS = new Set(["time", "day", "way", "one", "back", "life", "world", "new", "story"]);

  function expandWord(w) {
    // Core forms (what was actually typed, plus its singular/plural stem) stay
    // substring-matched — this is what lets "ghosts" find "Ghostbusters" as a
    // compound word. Synonym alternatives are whole-word-only, since those are
    // broader associative terms (e.g. "con" for heist) that cause false hits
    // inside unrelated words ("economic") if matched as raw substrings.
    const core = new Set([w, ...depluralize(w)]);
    const key = w.replace(/[\s-]/g, "");
    const synonyms = SYNONYMS[key] || [];
    return { core: Array.from(core), synonyms };
  }

  /* ---------- init ---------- */
  async function loadRules() {
    try {
      const res = await fetch(API_URL);
      if (res.status === 200) return await res.json();
      // 204 (nothing published yet) or function unavailable -> fall through to bundled default
    } catch (err) {
      // /api/calendar-rules not reachable -> fall through
    }
    const res = await fetch(`${DATA_ROOT}/calendar-rules.json`);
    return res.json();
  }

  async function init() {
    try {
      const [manifestRes, moviesRes] = await Promise.all([
        fetch(`${DATA_ROOT}/manifest.json`),
        fetch(`${DATA_ROOT}/movies.json`),
      ]);
      const manifest = await manifestRes.json();
      state.genres = manifest.genres;
      state.allMovies = await moviesRes.json();

      // Optional — only present once the monthly refresh job has run at
      // least once. Missing entirely just means "streaming" tags won't be
      // recognized yet; everything else works the same either way.
      try {
        const providersRes = await fetch(`${DATA_ROOT}/watch-providers.json`);
        if (providersRes.ok) state.watchProviders = await providersRes.json();
      } catch (err) {
        // no watch-providers.json yet — fine, just skip it
      }

      for (const m of state.allMovies) {
        if (m.c) {
          for (const name of m.c) {
            if (!state.actorIndex.has(name.toLowerCase())) state.actorIndex.set(name.toLowerCase(), name);
          }
        }
        if (m.d) {
          for (const name of m.d) {
            if (!state.directorIndex.has(name.toLowerCase())) state.directorIndex.set(name.toLowerCase(), name);
          }
        }
      }
      for (const providers of Object.values(state.watchProviders)) {
        for (const p of providers.flatrate || []) {
          if (!state.providerIndex.has(p.name.toLowerCase())) state.providerIndex.set(p.name.toLowerCase(), p.name);
        }
      }

      render();

      // Today's calendar pick is a nice-to-have on this page, not core —
      // if it fails for any reason, the rest of the finder should still
      // work fine, so this is deliberately isolated from the block above.
      try {
        const rules = await loadRules();
        const result = CalendarEngine.pickMovieForDate(new Date(), rules, state.allMovies, 0);
        if (result.movie) renderTodaysPick(result.movie, result.ruleLabel);
      } catch (err) {
        // no calendar data available — just leave the teaser hidden
      }
    } catch (err) {
      stateStart.textContent = "Couldn't load the movie catalog. Check that the data/ folder is next to index.html.";
      console.error(err);
    }
  }

  function renderTodaysPick(movie, ruleLabel) {
    el("todays-pick-title").textContent = movie.t;
    el("todays-pick-meta").textContent = `${movie.y}` + (movie.rt ? ` · ${movie.rt} min` : "");
    el("todays-pick-overview").textContent = movie.o || "";

    const themeEl = el("todays-pick-theme");
    if (ruleLabel) {
      themeEl.textContent = ruleLabel;
      themeEl.hidden = false;
    } else {
      themeEl.hidden = true;
    }

    const posterEl = el("todays-pick-poster");
    if (movie.pu) {
      posterEl.src = movie.pu;
      posterEl.hidden = false;
    } else {
      posterEl.hidden = true;
    }

    el("todays-pick-card").addEventListener("click", () => showPicked(movie));
    todaysPickZone.hidden = false;
  }

  /* ---------- tag parsing ---------- */
  function parseTag(raw) {
    const text = raw.trim();
    if (!text) return null;
    const lower = text.toLowerCase();

    // decade: "80s", "1980s", "1980", "80"
    const decadeMatch = lower.match(/^(\d{2}|\d{4})'?s?$/);
    if (decadeMatch) {
      let n = parseInt(decadeMatch[1], 10);
      let decadeStart;
      if (decadeMatch[1].length === 4) {
        decadeStart = Math.floor(n / 10) * 10;
      } else {
        decadeStart = n <= 29 ? 2000 + n : 1900 + n;
      }
      return {
        raw: text,
        type: "decade",
        value: decadeStart,
        label: `${decadeStart}s`,
      };
    }

    // genre: exact match against known genre list
    const genreMatch = state.genres.find((g) => g.toLowerCase() === lower);
    if (genreMatch) {
      return { raw: text, type: "genre", value: genreMatch, label: genreMatch };
    }

    // actor: exact match against known cast names in the dataset
    const actorMatch = state.actorIndex.get(lower);
    if (actorMatch) {
      return { raw: text, type: "actor", value: actorMatch, label: actorMatch };
    }

    // director: exact match against known director names in the dataset
    const directorMatch = state.directorIndex.get(lower);
    if (directorMatch) {
      return { raw: text, type: "director", value: directorMatch, label: directorMatch };
    }

    // streaming service: exact match against known providers from the monthly refresh.
    // Matching itself uses substring search (see movieMatchesTag) rather than requiring
    // this exact canonical name, since TMDB sometimes splits one real service into
    // multiple named variants (e.g. "Netflix" and "Netflix Standard with Ads" both
    // appear separately) — an exact match alone would undercount real availability.
    const providerMatch = state.providerIndex.get(lower);
    if (providerMatch) {
      return { raw: text, type: "streaming", matchTerm: lower, value: providerMatch, label: providerMatch };
    }

    // free text — build one word-group per word (each group = that word plus its
    // synonyms/stem), phrase must satisfy ALL groups (AND), any alternative within
    // a group counts (OR). This is what stops "time travel" from matching on "time"
    // alone via a title like "No Time to Die".
    const rawWords = lower.split(/[^a-z0-9']+/).filter((w) => w.length > 1);
    if (rawWords.length === 0) return null;
    const meaningfulWords = rawWords.length > 1 ? rawWords.filter((w) => !STOPWORDS.has(w)) : rawWords;
    // If stopword-filtering strips a multi-word query down to just one (or zero)
    // meaningful words, don't fall back to that single word alone — it's too weak
    // a signal on its own (see: "time travel" degrading to just "travel", which
    // matches any movie about going somewhere, not specifically time travel).
    // Require the exact phrase instead; a real match with no phrase hit anywhere
    // is a rarer miss than the false positives that single word would cause.
    const phraseOnly = rawWords.length > 1 && meaningfulWords.length <= 1;
    const finalWords = meaningfulWords.length > 0 ? meaningfulWords : rawWords;
    const wordGroups = finalWords.map((w) => expandWord(w));
    return {
      raw: text,
      type: "text",
      phrase: lower,
      wordGroups,
      phraseOnly,
      label: text,
    };
  }

  function tagAlreadyActive(tag) {
    return state.tags.some((t) => t.label.toLowerCase() === tag.label.toLowerCase());
  }

  /* ---------- matching ---------- */
  function movieMatchesTag(movie, tag) {
    if (tag.type === "decade") {
      return movie.y >= tag.value && movie.y < tag.value + 10;
    }
    if (tag.type === "genre") {
      return movie.g.includes(tag.value);
    }
    if (tag.type === "actor") {
      return !!(movie.c && movie.c.includes(tag.value));
    }
    if (tag.type === "director") {
      return !!(movie.d && movie.d.includes(tag.value));
    }
    if (tag.type === "streaming") {
      const key = `${movie.t.toLowerCase()}|${movie.y}`;
      const providers = state.watchProviders[key];
      if (!providers || !providers.flatrate) return false;
      return providers.flatrate.some((p) => p.name.toLowerCase().includes(tag.matchTerm));
    }
    if (tag.type === "runtime") {
      if (!movie.rt) return false; // no data — can't confirm it fits, so exclude
      return movie.rt >= tag.min && movie.rt <= tag.max;
    }
    // text — search title, overview, cast/director names, and TMDB keyword tags together
    const hay = `${movie.t} ${movie.o} ${movie.c ? movie.c.join(" ") : ""} ${movie.d ? movie.d.join(" ") : ""} ${movie.k ? movie.k.join(" ") : ""}`.toLowerCase();
    // Exact phrase fast path — catches curated keyword-array phrases like "time travel" directly.
    if (tag.phrase.length > 3 && wholeWordIncludes(hay, tag.phrase)) return true;
    if (tag.phraseOnly) return false; // no reliable weaker signal to fall back to
    // Fallback: every word-group must be satisfied — core forms via substring
    // (so "ghost" still finds "Ghostbusters"), synonyms via whole-word only.
    return tag.wordGroups.every(
      (group) => group.core.some((w) => hay.includes(w)) || group.synonyms.some((w) => wholeWordIncludes(hay, w))
    );
  }

  function getFilteredMovies() {
    if (state.tags.length === 0) return [];
    return state.allMovies.filter((m) => state.tags.every((t) => movieMatchesTag(m, t)));
  }

  /* ---------- render ---------- */
  function renderTags() {
    tagListEl.innerHTML = "";
    state.tags.filter((tag) => tag.type !== "runtime").forEach((tag) => {
      const i = state.tags.indexOf(tag);
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      const kindLabel = tag.type === "decade" ? "era" : tag.type === "genre" ? "genre" : tag.type === "actor" ? "actor" : tag.type === "director" ? "director" : tag.type === "streaming" ? "streaming" : "mood";
      chip.innerHTML = `<span class="tag-kind">${kindLabel}</span>${escapeHtml(tag.label)}`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", `Remove ${tag.label}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        state.tags.splice(i, 1);
        render();
      });
      chip.appendChild(removeBtn);
      tagListEl.appendChild(chip);
    });
  }

  function render() {
    renderTags();
    syncRuntimeButtons();
    syncStreamingButtons();

    if (state.tags.length === 0) {
      stateStart.hidden = false;
      stateEmpty.hidden = true;
      movieListEl.hidden = true;
      matchCountEl.textContent = "";
      return;
    }
    stateStart.hidden = true;

    const matches = getFilteredMovies();

    if (matches.length === 0) {
      stateEmpty.hidden = false;
      movieListEl.hidden = true;
      matchCountEl.textContent = "0 movies match";
      return;
    }

    stateEmpty.hidden = true;
    movieListEl.hidden = false;
    matchCountEl.textContent = `${matches.length} movie${matches.length === 1 ? "" : "s"} match${matches.length === 1 ? "es" : ""}`;

    movieListEl.innerHTML = "";
    matches.slice(0, MAX_SHOWN).forEach((m) => {
      const li = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "movie-row";
      const posterImg = m.pu ? `<img class="movie-row-poster" src="${m.pu}" alt="" loading="lazy">` : `<span class="movie-row-poster movie-row-poster-blank"></span>`;
      row.innerHTML = `
        ${posterImg}
        <span class="movie-row-title">${escapeHtml(m.t)}</span>
        <span class="movie-row-year">${m.y}</span>
      `;
      row.addEventListener("click", () => showPicked(m));
      li.appendChild(row);
      movieListEl.appendChild(li);
    });

    if (matches.length > MAX_SHOWN) {
      const more = document.createElement("li");
      more.className = "movie-list-more";
      more.textContent = `+ ${matches.length - MAX_SHOWN} more — add a keyword to narrow it down`;
      movieListEl.appendChild(more);
    }
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  /* ---------- ratings + watch providers (baked into the static data — no live API calls) ---------- */
  function renderRatings(ratings, rowId) {
    const row = el(rowId);
    if (!ratings) { row.hidden = true; return; }

    const badges = [];
    if (ratings.imdb) badges.push(["IMDb", ratings.imdb]);
    if (ratings.rottenTomatoes) badges.push(["RT", ratings.rottenTomatoes]);
    if (ratings.metacritic) badges.push(["Metacritic", ratings.metacritic]);

    if (badges.length === 0) { row.hidden = true; return; }

    row.innerHTML = badges.map(([source, value]) => `
      <span class="rating-badge">
        <span class="rating-badge-source">${source}</span>
        <span class="rating-badge-value">${escapeHtml(value)}</span>
      </span>
    `).join("");
    row.hidden = false;
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

  /* ---------- picked ticket ---------- */
  function showPicked(movie) {
    el("ticket-title").textContent = movie.t;
    el("ticket-meta").textContent = `${movie.y}` + (movie.rt ? ` · ${movie.rt} min` : "");
    el("ticket-tags").innerHTML = movie.g.map((g) => `<span class="tag">${g}</span>`).join("");
    el("ticket-overview").textContent = movie.o || "No synopsis available.";

    renderRatings(movie.rr, "ratings-row");
    const key = `${movie.t.toLowerCase()}|${movie.y}`;
    renderWatchProviders(state.watchProviders[key], "watch-providers", "watch-badges");

    const posterEl = el("ticket-poster");
    if (posterEl) {
      if (movie.pu) {
        posterEl.src = movie.pu;
        posterEl.hidden = false;
      } else {
        posterEl.hidden = true;
      }
    }

    tagZone.hidden = true;
    resultsZone.hidden = true;
    todaysPickZone.hidden = true;
    panelPicked.hidden = false;
  }

  function backToList() {
    panelPicked.hidden = true;
    tagZone.hidden = false;
    resultsZone.hidden = false;
    if (el("todays-pick-title").textContent) todaysPickZone.hidden = false; // only re-show if a pick was actually loaded
  }

  /* ---------- events ---------- */
  function syncRuntimeButtons() {
    const active = state.tags.find((t) => t.type === "runtime");
    document.querySelectorAll(".runtime-btn").forEach((btn) => {
      const isThisOne = active && Number(btn.dataset.min) === active.min && Number(btn.dataset.max) === active.max;
      btn.classList.toggle("is-active", !!isThisOne);
    });
  }

  document.querySelectorAll(".runtime-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const min = Number(btn.dataset.min);
      const max = Number(btn.dataset.max);
      const existingIndex = state.tags.findIndex((t) => t.type === "runtime");
      const alreadyThisOne = existingIndex !== -1 && state.tags[existingIndex].min === min && state.tags[existingIndex].max === max;

      if (existingIndex !== -1) state.tags.splice(existingIndex, 1); // remove any existing runtime tag first

      if (!alreadyThisOne) {
        state.tags.push({ type: "runtime", min, max, label: btn.textContent });
      }
      render();
    });
  });

  // Only one streaming filter active at a time — combining two (e.g. Netflix
  // AND Hulu) would almost always yield zero results anyway, since a movie
  // is rarely on both, so this avoids an easy-to-hit confusing dead end.
  function syncStreamingButtons() {
    const active = state.tags.find((t) => t.type === "streaming");
    document.querySelectorAll(".streaming-btn").forEach((btn) => {
      const isThisOne = active && btn.dataset.term === active.matchTerm;
      btn.classList.toggle("is-active", !!isThisOne);
    });
  }

  function setStreamingTag(matchTerm, label) {
    const existingIndex = state.tags.findIndex((t) => t.type === "streaming");
    const alreadyThisOne = existingIndex !== -1 && state.tags[existingIndex].matchTerm === matchTerm;

    if (existingIndex !== -1) state.tags.splice(existingIndex, 1); // remove any existing streaming tag first

    if (!alreadyThisOne) {
      state.tags.push({ type: "streaming", matchTerm, label });
    }
  }

  document.querySelectorAll(".streaming-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setStreamingTag(btn.dataset.term, btn.textContent);
      render();
    });
  });

  tagForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const tag = parseTag(tagInput.value);
    tagInput.value = "";
    if (!tag) return;
    if (tagAlreadyActive(tag)) return;
    if (tag.type === "streaming") {
      setStreamingTag(tag.matchTerm, tag.label);
    } else {
      state.tags.push(tag);
    }
    render();
  });

  el("back-to-list-btn").addEventListener("click", backToList);
  el("restart-btn").addEventListener("click", () => {
    state.tags = [];
    backToList();
    render();
  });

  init();
})();
