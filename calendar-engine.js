/* ============================================================
   calendar-engine.js
   Shared logic: holiday math, rule resolution, movie picking.
   Used by both calendar.js (public page) and admin.js.
   ============================================================ */

const CalendarEngine = (() => {
  "use strict";

  /* ---------- date helpers ---------- */
  function pad2(n) { return String(n).padStart(2, "0"); }

  function toISO(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function toMMDD(date) {
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function dateOnly(y, m, d) {
    // m is 1-indexed here for convenience
    return new Date(y, m - 1, d);
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  // nth weekday of a month. weekday: 0=Sun..6=Sat. n: 1-5.
  function nthWeekdayOfMonth(year, month, weekday, n) {
    const first = dateOnly(year, month, 1);
    const firstWeekday = first.getDay();
    let offset = weekday - firstWeekday;
    if (offset < 0) offset += 7;
    const day = 1 + offset + (n - 1) * 7;
    return dateOnly(year, month, day);
  }

  // last given weekday of a month
  function lastWeekdayOfMonth(year, month, weekday) {
    const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this month
    const last = dateOnly(year, month, lastDay);
    const lastWeekday = last.getDay();
    let offset = lastWeekday - weekday;
    if (offset < 0) offset += 7;
    return addDays(last, -offset);
  }

  function anchorDate(year, anchor) {
    if (anchor.type === "fixed") return dateOnly(year, anchor.month, anchor.day);
    if (anchor.type === "nth-weekday") return nthWeekdayOfMonth(year, anchor.month, anchor.weekday, anchor.n);
    if (anchor.type === "last-weekday") return lastWeekdayOfMonth(year, anchor.month, anchor.weekday);
    return null;
  }

  function sameYMD(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function dateWithinWindow(date, center, before, after) {
    const start = addDays(center, -before);
    const end = addDays(center, after);
    const t = date.setHours ? new Date(date.getFullYear(), date.getMonth(), date.getDate()) : date;
    return t >= new Date(start.getFullYear(), start.getMonth(), start.getDate()) &&
           t <= new Date(end.getFullYear(), end.getMonth(), end.getDate());
  }

  /* ---------- rule resolution ---------- */
  // Returns the matching rule object (plus resolved window) for a given date, or null (grab bag).
  function resolveRuleForDate(date, rulesConfig) {
    const year = date.getFullYear();
    const iso = toISO(date);
    const mmdd = toMMDD(date);

    // 1. exact-date override
    if (rulesConfig.overrides && rulesConfig.overrides[iso]) {
      return { id: `override-${iso}`, label: rulesConfig.overrides[iso].label || "Curated Pick", match: rulesConfig.overrides[iso], isOverride: true };
    }
    // 2. recurring MM-DD override
    if (rulesConfig.overrides && rulesConfig.overrides[mmdd]) {
      return { id: `override-${mmdd}`, label: rulesConfig.overrides[mmdd].label || "Curated Pick", match: rulesConfig.overrides[mmdd], isOverride: true };
    }

    // 3. themed rules
    for (const rule of rulesConfig.rules) {
      if (rule.monthOnly) {
        if (date.getMonth() + 1 === rule.monthOnly) return rule;
        continue;
      }
      if (rule.fixedRange) {
        const fr = rule.fixedRange;
        const start = dateOnly(year, fr.startMonth, fr.startDay);
        const end = dateOnly(year, fr.endMonth, fr.endDay);
        if (date >= start && date <= end) return rule;
        continue;
      }
      if (rule.anchor) {
        const center = anchorDate(year, rule.anchor);
        if (center && dateWithinWindow(date, center, rule.before || 0, rule.after || 0)) return rule;
      }
    }
    return null; // grab bag
  }

  /* ---------- seeded pseudo-random pick (stable per date+rule) ---------- */
  function seedFromString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function seededPick(candidates, seedStr, offset = 0) {
    if (candidates.length === 0) return null;
    const seed = (seedFromString(seedStr) + offset) % candidates.length;
    return candidates[seed];
  }

  /* ---------- movie matching ---------- */
  function textHay(m) {
    return `${m.t} ${m.o} ${m.c ? m.c.join(" ") : ""} ${m.d ? m.d.join(" ") : ""} ${m.k ? m.k.join(" ") : ""}`.toLowerCase();
  }

  function movieMatchesTagRule(m, match) {
    if (match.genres && match.genres.length) {
      const ok = match.genres.every((g) => m.g.includes(g));
      if (!ok) return false;
    }
    if (match.decade) {
      if (m.y < match.decade || m.y >= match.decade + 10) return false;
    }
    if (match.keywords && match.keywords.length) {
      const hay = textHay(m);
      const ok = match.keywords.some((kw) => hay.includes(kw.toLowerCase()));
      if (!ok) return false;
    }
    return true;
  }

  function findMovieByTitleYear(movies, title, year) {
    const lower = title.toLowerCase();
    return movies.find((m) => m.t.toLowerCase() === lower && m.y === year) || null;
  }

  function pickFromGrabBagPool(date, rulesConfig, movies, seedKey, offset) {
    const weekday = date.getDay(); // 0=Sun..6=Sat
    const capped = rulesConfig.grabBag.weekdaysCapped.includes(weekday);
    let pool = movies;
    if (capped) {
      pool = movies.filter((m) => m.rt && m.rt <= rulesConfig.grabBag.weekdayRuntimeCap);
    }
    const sorted = pool.slice().sort((a, b) => b.p - a.p);
    const capPool = sorted.slice(0, Math.max(30, Math.min(sorted.length, 200)));
    const movie = seededPick(capPool, seedKey, offset);
    const note = capped
      ? `Weekday pick — ${rulesConfig.grabBag.weekdayRuntimeCap} min or under`
      : "Weekend pick — no runtime limit";
    return { movie, note };
  }

  // Resolve the actual movie for a given date. `offset` lets you page to alternates.
  function pickMovieForDate(date, rulesConfig, movies, offset = 0) {
    const rule = resolveRuleForDate(date, rulesConfig);
    const iso = toISO(date);

    if (!rule) {
      // plain, unthemed day — no special label
      const { movie, note } = pickFromGrabBagPool(date, rulesConfig, movies, `grabbag-${iso}`, offset);
      return { movie, ruleLabel: null, ruleId: "grab-bag", note };
    }

    const match = rule.match;

    if (match.type === "label") {
      // custom label only — still uses the normal grab-bag pool/runtime rule
      const { movie, note } = pickFromGrabBagPool(date, rulesConfig, movies, `${rule.id}-${iso}`, offset);
      return { movie, ruleLabel: rule.label, ruleId: rule.id, note };
    }

    let movie = null;

    if (match.type === "pin") {
      movie = findMovieByTitleYear(movies, match.title, match.year);
    } else if (match.type === "curated") {
      const found = match.titles
        .map((t) => findMovieByTitleYear(movies, t.title, t.year))
        .filter(Boolean);
      movie = seededPick(found, `${rule.id}-${iso}`, offset);
    } else if (match.type === "tag") {
      const candidates = movies.filter((m) => movieMatchesTagRule(m, match));
      const sorted = candidates.slice().sort((a, b) => b.p - a.p);
      const capPool = sorted.slice(0, Math.max(20, Math.min(sorted.length, 150)));
      movie = seededPick(capPool, `${rule.id}-${iso}`, offset);
    }

    return { movie, ruleLabel: rule.label, ruleId: rule.id, note: null };
  }

  return {
    toISO, toMMDD, dateOnly, addDays,
    nthWeekdayOfMonth, lastWeekdayOfMonth, anchorDate,
    resolveRuleForDate, pickMovieForDate, findMovieByTitleYear,
    seededPick,
  };
})();
