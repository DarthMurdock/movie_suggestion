(() => {
  "use strict";

  const DATA_ROOT = "data";
  const API_URL = "/api/calendar-rules";
  const el = (id) => document.getElementById(id);

  const state = {
    movies: [],
    rules: null,
    selectedMovie: null,
    connectionState: "unknown", // 'live' | 'empty' | 'unreachable'
    verifiedUsername: null,
    verifiedSecret: null,
  };

  const WEEKDAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MONTH_NAMES = ["","January","February","March","April","May","June","July","August","September","October","November","December"];
  const ORDINALS = ["", "1st", "2nd", "3rd", "4th", "5th"];

  async function loadRules() {
    try {
      const res = await fetch(API_URL);
      if (res.status === 200) {
        state.connectionState = "live";
        return await res.json();
      }
      if (res.status === 204) {
        // Function reachable, just nothing published to it yet — not an error.
        state.connectionState = "empty";
        const fallback = await fetch(`${DATA_ROOT}/calendar-rules.json`);
        return fallback.json();
      }
    } catch (err) {
      // /api/calendar-rules not reachable at all (not hosted with the API server running)
    }
    state.connectionState = "unreachable";
    const res = await fetch(`${DATA_ROOT}/calendar-rules.json`);
    return res.json();
  }

  function renderConnectionBanner() {
    const noteEl = el("admin-note");
    const textEl = el("admin-note-text");
    noteEl.classList.remove("is-live", "is-fallback");
    if (state.connectionState === "live") {
      noteEl.classList.add("is-live");
      textEl.innerHTML = `<strong>Connected to live storage.</strong> Changes you publish here go live for visitors immediately — no redeploy needed.`;
    } else if (state.connectionState === "empty") {
      noteEl.classList.add("is-live");
      textEl.innerHTML = `<strong>Connected to live storage — nothing published yet.</strong> You're viewing the bundled defaults for now. Hit "Save &amp; publish live" below to seed it; after that, this message will reflect what's actually live.`;
    } else {
      noteEl.classList.add("is-fallback");
      textEl.innerHTML = `<strong>Not connected to live storage.</strong> You're viewing the bundled defaults. This works when the site's API server (server.js) is running and reachable — otherwise, "Save &amp; publish" won't be able to reach the server, and you'll need the backup-file download instead.`;
    }
  }

  /* ---------- auth gate ---------- */
  async function verifyCredentials(username, secret, totp) {
    // Returns 'ok' | 'wrong' | 'rate-limited' | 'unreachable'
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Username": username, "X-Admin-Secret": secret },
        body: JSON.stringify({ verifyOnly: true, totp }),
      });
      if (res.status === 200) return "ok";
      if (res.status === 401) return "wrong";
      if (res.status === 429) return "rate-limited";
      return "unreachable"; // 500 (server misconfigured) or anything unexpected
    } catch (err) {
      return "unreachable";
    }
  }

  function showGateError(message) {
    const errEl = el("gate-error");
    errEl.textContent = message;
    errEl.hidden = false;
  }

  async function attemptUnlock(username, secret, totp) {
    const btn = el("gate-submit-btn");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Checking…";

    const result = await verifyCredentials(username, secret, totp);

    btn.disabled = false;
    btn.textContent = originalText;

    if (result === "ok") {
      state.verifiedUsername = username;
      state.verifiedSecret = secret;
      // The 2FA challenge is satisfied once per browser session — we don't persist
      // the TOTP code itself (it's single-use and expires in ~30s), just a flag
      // saying this tab already cleared the gate, plus the username/password for
      // reuse on later publish calls.
      sessionStorage.setItem("calendarGateUnlocked", "1");
      sessionStorage.setItem("calendarAdminUsername", username);
      sessionStorage.setItem("calendarAdminSecret", secret);
      el("auth-gate").hidden = true;
      el("admin-content").hidden = false;
      loadAdminContent();
      return;
    }
    if (result === "wrong") {
      showGateError("Wrong username, password, or authentication code.");
      return;
    }
    if (result === "rate-limited") {
      showGateError("Too many failed attempts — wait about 5 minutes and try again.");
      return;
    }
    showGateError("Can't verify right now — the live server isn't reachable, or isn't fully configured. Admin editing requires ADMIN_USERNAME, ADMIN_SECRET, and TOTP_SECRET all set on the server.");
  }

  function clearSession() {
    sessionStorage.removeItem("calendarGateUnlocked");
    sessionStorage.removeItem("calendarAdminUsername");
    sessionStorage.removeItem("calendarAdminSecret");
    state.verifiedUsername = null;
    state.verifiedSecret = null;
  }

  function initGate() {
    el("gate-submit-btn").addEventListener("click", () => {
      const username = el("gate-username").value.trim();
      const secret = el("gate-secret").value.trim();
      const totp = el("gate-totp").value.trim();
      if (!username || !secret || !totp) return;
      el("gate-error").hidden = true;
      attemptUnlock(username, secret, totp);
    });
    ["gate-username", "gate-secret", "gate-totp"].forEach((id) => {
      el(id).addEventListener("keydown", (e) => {
        if (e.key === "Enter") el("gate-submit-btn").click();
      });
    });

    // Already cleared the 2FA challenge earlier in this tab? Skip straight to the
    // content instead of asking for another authenticator code.
    if (sessionStorage.getItem("calendarGateUnlocked") === "1") {
      state.verifiedUsername = sessionStorage.getItem("calendarAdminUsername");
      state.verifiedSecret = sessionStorage.getItem("calendarAdminSecret");
      el("auth-gate").hidden = true;
      el("admin-content").hidden = false;
      loadAdminContent();
    }
  }

  /* ---------- main admin content (only loaded after verification) ---------- */
  async function loadAdminContent() {
    try {
      const [rules, moviesRes] = await Promise.all([
        loadRules(),
        fetch(`${DATA_ROOT}/movies.json`),
      ]);
      state.rules = rules;
      state.movies = await moviesRes.json();
    } catch (err) {
      console.error(err);
      return;
    }

    renderConnectionBanner();
    renderOverrides();
    renderRules();
    bindEvents();
  }

  function init() {
    initGate();
  }

  /* ---------- movie search ---------- */
  function bindEvents() {
    const searchInput = el("movie-search");
    const resultsEl = el("search-results");

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      if (q.length < 2) {
        resultsEl.hidden = true;
        return;
      }
      const matches = state.movies
        .filter((m) => m.t.toLowerCase().includes(q))
        .sort((a, b) => b.p - a.p)
        .slice(0, 8);

      if (matches.length === 0) {
        resultsEl.innerHTML = `<div class="search-result-item">No matches</div>`;
        resultsEl.hidden = false;
        return;
      }

      resultsEl.innerHTML = "";
      matches.forEach((m) => {
        const item = document.createElement("div");
        item.className = "search-result-item";
        item.innerHTML = `<span>${escapeHtml(m.t)}</span><span class="yr">${m.y}</span>`;
        item.addEventListener("click", () => selectMovie(m));
        resultsEl.appendChild(item);
      });
      resultsEl.hidden = false;
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrap")) resultsEl.hidden = true;
    });

    el("clear-selected").addEventListener("click", () => {
      state.selectedMovie = null;
      el("selected-movie").hidden = true;
      updateAddButtonState();
    });

    el("override-date").addEventListener("change", updateAddButtonState);
    el("override-label").addEventListener("input", updateAddButtonState);

    el("label-only-toggle").addEventListener("change", (e) => {
      const isLabelOnly = e.target.checked;
      el("movie-picker-block").hidden = isLabelOnly;
      if (isLabelOnly) {
        state.selectedMovie = null;
        el("selected-movie").hidden = true;
      }
      updateAddButtonState();
    });

    el("add-override-btn").addEventListener("click", addOverride);
    el("download-btn").addEventListener("click", downloadRules);
    el("publish-btn").addEventListener("click", publishRules);
  }

  function selectMovie(m) {
    state.selectedMovie = m;
    el("selected-movie-label").textContent = `${m.t} (${m.y})`;
    el("selected-movie").hidden = false;
    el("search-results").hidden = true;
    el("movie-search").value = "";
    if (!el("override-label").value) el("override-label").value = m.t;
    updateAddButtonState();
  }

  function updateAddButtonState() {
    const dateOk = !!el("override-date").value;
    const isLabelOnly = el("label-only-toggle").checked;
    if (isLabelOnly) {
      el("add-override-btn").disabled = !(dateOk && el("override-label").value.trim());
    } else {
      el("add-override-btn").disabled = !(dateOk && state.selectedMovie);
    }
  }

  /* ---------- overrides ---------- */
  function addOverride() {
    const dateVal = el("override-date").value; // YYYY-MM-DD
    const recur = document.querySelector('input[name="recur"]:checked').value;
    const isLabelOnly = el("label-only-toggle").checked;
    const key = recur === "year" ? dateVal.slice(5) : dateVal; // MM-DD or full date

    if (isLabelOnly) {
      const label = el("override-label").value.trim();
      state.rules.overrides[key] = { type: "label", label };
    } else {
      const label = el("override-label").value.trim() || state.selectedMovie.t;
      state.rules.overrides[key] = {
        type: "pin",
        title: state.selectedMovie.t,
        year: state.selectedMovie.y,
        label,
      };
    }

    renderOverrides();

    // reset form
    state.selectedMovie = null;
    el("selected-movie").hidden = true;
    el("override-label").value = "";
    el("override-date").value = "";
    el("label-only-toggle").checked = false;
    el("movie-picker-block").hidden = false;
    updateAddButtonState();
  }

  function removeOverride(key) {
    delete state.rules.overrides[key];
    renderOverrides();
  }

  function renderOverrides() {
    const listEl = el("override-list");
    const emptyEl = el("override-empty");
    const keys = Object.keys(state.rules.overrides);

    if (keys.length === 0) {
      listEl.innerHTML = "";
      emptyEl.style.display = "block";
      return;
    }
    emptyEl.style.display = "none";

    listEl.innerHTML = "";
    keys.forEach((key) => {
      const ov = state.rules.overrides[key];
      const isRecurring = key.length === 5; // "MM-DD"
      const dateLabel = isRecurring ? `Every ${formatMMDD(key)}` : formatFullDate(key);

      const titlePart = ov.type === "label" ? "(day renamed only)" : `— ${escapeHtml(ov.title)} (${ov.year})`;
      const li = document.createElement("li");
      li.className = "override-row";
      li.innerHTML = `
        <div class="override-row-main">
          <span class="override-row-title">${escapeHtml(ov.label)} ${titlePart}</span>
          <span class="override-row-date">${dateLabel}</span>
        </div>
      `;
      const btn = document.createElement("button");
      btn.className = "remove-btn";
      btn.setAttribute("aria-label", "Remove");
      btn.textContent = "×";
      btn.addEventListener("click", () => removeOverride(key));
      li.appendChild(btn);
      listEl.appendChild(li);
    });
  }

  function formatMMDD(mmdd) {
    const [m, d] = mmdd.split("-").map(Number);
    return `${MONTH_NAMES[m]} ${d}`;
  }

  function formatFullDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${MONTH_NAMES[m]} ${d}, ${y}`;
  }

  /* ---------- built-in rules (read-only reference) ---------- */
  function describeRule(rule) {
    if (rule.monthOnly) return `All of ${MONTH_NAMES[rule.monthOnly]}`;
    if (rule.fixedRange) {
      const fr = rule.fixedRange;
      return `${MONTH_NAMES[fr.startMonth]} ${fr.startDay} – ${MONTH_NAMES[fr.endMonth]} ${fr.endDay}`;
    }
    if (rule.anchor) {
      let anchorDesc;
      if (rule.anchor.type === "fixed") {
        anchorDesc = `${MONTH_NAMES[rule.anchor.month]} ${rule.anchor.day}`;
      } else if (rule.anchor.type === "nth-weekday") {
        anchorDesc = `${ORDINALS[rule.anchor.n]} ${WEEKDAY_NAMES[rule.anchor.weekday]} of ${MONTH_NAMES[rule.anchor.month]}`;
      } else if (rule.anchor.type === "last-weekday") {
        anchorDesc = `last ${WEEKDAY_NAMES[rule.anchor.weekday]} of ${MONTH_NAMES[rule.anchor.month]}`;
      }
      const before = rule.before || 0;
      const after = rule.after || 0;
      let windowDesc = "";
      if (before || after) {
        windowDesc = ` (window: ${before}d before – ${after}d after)`;
      }
      return anchorDesc + windowDesc;
    }
    return "";
  }

  function renderRules() {
    const listEl = el("rule-list");
    listEl.innerHTML = "";
    state.rules.rules.forEach((rule) => {
      const li = document.createElement("li");
      li.className = "rule-row";
      const typeLabel = rule.match.type === "pin" ? "Pinned" : rule.match.type === "curated" ? "Curated list" : "Theme match";
      li.innerHTML = `
        <div class="rule-row-main">
          <span class="rule-row-label">${escapeHtml(rule.label)}</span>
          <span class="rule-row-window">${describeRule(rule)} · ${typeLabel}</span>
        </div>
      `;
      listEl.appendChild(li);
    });
  }

  /* ---------- publish live ---------- */
  async function publishRules() {
    const statusEl = el("save-status");
    const username = state.verifiedUsername;
    const secret = state.verifiedSecret;

    if (!secret || !username) {
      showStatus("Session expired — refresh and log in again.", "error");
      return;
    }

    const btn = el("publish-btn");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Publishing…";

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Username": username, "X-Admin-Secret": secret },
        body: JSON.stringify(state.rules),
      });

      if (res.status === 200) {
        state.connectionState = "live";
        renderConnectionBanner();
        showStatus("Published — changes are live for visitors now.", "success");
      } else if (res.status === 401) {
        // Credentials this tab was holding no longer work (changed server-side,
        // or something's off) — don't just show an error, force a real re-login.
        clearSession();
        el("admin-content").hidden = true;
        el("auth-gate").hidden = false;
        showGateError("Session was rejected — please log in again.");
      } else {
        const body = await res.json().catch(() => ({}));
        showStatus(body.error || `Publish failed (${res.status}).`, "error");
      }
    } catch (err) {
      showStatus("Couldn't reach live storage — check that the API server (server.js) is running. Use the backup download instead.", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function showStatus(message, kind) {
    const statusEl = el("save-status");
    statusEl.textContent = message;
    statusEl.hidden = false;
    statusEl.className = `save-status is-${kind}`;
  }

  /* ---------- export ---------- */
  function downloadRules() {
    const blob = new Blob([JSON.stringify(state.rules, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "calendar-rules.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Plain string replacement rather than the textContent/innerHTML DOM
  // trick — that trick only escapes what's unsafe in a text NODE (<, >,
  // &), not quote characters, which makes it unsafe wherever the result
  // gets used inside an attribute value (title=, alt=, etc.) rather than
  // as text content. This covers both.
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  init();
})();
