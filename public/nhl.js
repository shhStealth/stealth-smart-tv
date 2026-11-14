// Optional "next game" widget for one NHL team, shown in the header.
// Which team (or none) is a server-side setting, so every screen shows the
// same one: picked in edit mode by clicking the widget, defaulting to the
// backend's NHL_TEAM env var. With no team, /api/nhl answers
// {enabled:false} and the widget stays hidden, except in edit mode, where
// an "Add NHL team" card stands in for it so there's a way back.
//
// What goes in the big middle slot:
//   - a game in progress (live score, period, clock), else
//   - a game that ended in the last few hours (final score), else
//   - the next scheduled game.
// Whichever upcoming games aren't featured fill the small list on the right.

(() => {
  const widget = document.getElementById("nhl-widget");
  const teamModal = document.getElementById("team-modal");
  const teamGrid = document.getElementById("team-grid");
  const teamError = document.getElementById("team-error");
  const POLL_MS = 60 * 1000;
  // How long a finished game stays featured before the next one takes
  // over — long enough to catch the score after a late game, gone by the
  // next afternoon.
  const SHOW_FINAL_FOR_MS = 12 * 60 * 60 * 1000;
  const LIVE_STATES = ["LIVE", "CRIT"];
  let enabled = false;
  let lastData = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function logo(src, className) {
    const img = el("img", className);
    img.alt = "";
    if (src) img.src = src;
    img.onerror = () => { img.style.visibility = "hidden"; };
    return img;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function timeOf(d) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // "Tonight 7:00 PM" / "Tomorrow 7:30 PM" / "Thursday 7:00 PM" /
  // "Tue, Nov 24 7:30 PM", in the viewer's own time zone.
  function whenLabel(iso) {
    const d = new Date(iso);
    const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 864e5);
    let day;
    if (days === 0) day = d.getHours() >= 17 ? "Tonight" : "Today";
    else if (days === 1) day = "Tomorrow";
    else if (days > 1 && days < 7) day = d.toLocaleDateString(undefined, { weekday: "long" });
    else day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    return `${day} · ${timeOf(d)}`;
  }

  function shortDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function statusLine(game) {
    if (LIVE_STATES.includes(game.state)) {
      const parts = ["Live", game.period];
      if (game.intermission) parts.push("Intermission");
      else if (game.clock) parts.push(game.clock);
      return { text: parts.filter(Boolean).join(" · "), live: true };
    }
    if (game.state === "OFF" || game.state === "FINAL") {
      return { text: game.decidedIn ? `Final · ${game.decidedIn}` : "Final", live: false };
    }
    return { text: whenLabel(game.start), live: false };
  }

  function buildSide(side, showScore, align) {
    const wrap = el("div", `nhl-side nhl-side-${align}`);
    wrap.appendChild(logo(side.logo, "nhl-logo"));
    wrap.appendChild(el("span", "nhl-side-name", side.name));
    if (showScore) wrap.appendChild(el("span", "nhl-score", side.score ?? 0));
    return wrap;
  }

  function buildFeatured(game) {
    const box = el("div", "nhl-featured");
    if (!game) {
      box.appendChild(el("div", "nhl-status", "No upcoming games"));
      return box;
    }
    const status = statusLine(game);
    const statusEl = el("div", "nhl-status");
    if (status.live) statusEl.appendChild(el("span", "nhl-live-dot"));
    statusEl.appendChild(document.createTextNode(status.text));
    box.appendChild(statusEl);

    const showScore = game.state !== "FUT" && game.state !== "PRE";
    const matchup = el("div", "nhl-matchup");
    matchup.appendChild(buildSide(game.away, showScore, "away"));
    matchup.appendChild(el("span", "nhl-at", showScore ? "–" : "at"));
    matchup.appendChild(buildSide(game.home, showScore, "home"));
    box.appendChild(matchup);
    return box;
  }

  function buildUpcomingList(games) {
    const list = el("ul", "nhl-upcoming");
    games.forEach((game) => {
      const opponent = game.isHome ? game.away : game.home;
      const item = el("li");
      item.appendChild(el("span", "nhl-upcoming-date", shortDate(game.start)));
      item.appendChild(el("span", "nhl-upcoming-vs", game.isHome ? "vs" : "@"));
      item.appendChild(logo(opponent.logo, "nhl-logo-sm"));
      item.appendChild(el("span", "nhl-upcoming-team", opponent.name));
      list.appendChild(item);
    });
    return list;
  }

  function pickFeatured(data) {
    const upcoming = data.upcoming || [];
    if (upcoming[0] && LIVE_STATES.includes(upcoming[0].state)) {
      return { featured: upcoming[0], rest: upcoming.slice(1) };
    }
    const last = data.last;
    if (last && Date.now() - new Date(last.start).getTime() < SHOW_FINAL_FOR_MS) {
      return { featured: last, rest: upcoming };
    }
    return { featured: upcoming[0] || null, rest: upcoming.slice(1) };
  }

  const isEditing = () => document.body.classList.contains("editing");

  function renderEmpty() {
    const add = el("div", "nhl-add");
    add.appendChild(el("span", "nhl-add-plus", "+"));
    add.appendChild(document.createTextNode("Add NHL team"));
    widget.replaceChildren(add);
  }

  // Draws whatever we know, and decides visibility: a team's card if one
  // is set, the "Add NHL team" card if not but we're editing, else nothing.
  function render() {
    widget.classList.toggle("nhl-editable", isEditing());
    widget.tabIndex = isEditing() ? 0 : -1;
    if (enabled && lastData) {
      renderTeam(lastData);
      widget.classList.remove("hidden");
    } else if (!enabled && isEditing()) {
      renderEmpty();
      widget.classList.remove("hidden");
    } else {
      widget.classList.add("hidden");
    }
  }

  function renderTeam(data) {
    const { featured, rest } = pickFeatured(data);

    const team = el("div", "nhl-team");
    team.appendChild(logo(data.team.logo, "nhl-team-logo"));
    const teamText = el("div", "nhl-team-text");
    teamText.appendChild(el("div", "nhl-team-name", data.team.name));
    const meta = [data.team.record, data.team.standing].filter(Boolean).join(" · ");
    if (meta) teamText.appendChild(el("div", "nhl-team-meta", meta));
    team.appendChild(teamText);

    widget.replaceChildren(team, buildFeatured(featured));
    if (rest.length) widget.appendChild(buildUpcomingList(rest.slice(0, 2)));
  }

  // Keeps polling even with no team set, so a team picked on another
  // screen shows up here within a minute.
  async function refresh() {
    try {
      const res = await fetch("/api/nhl");
      const data = await res.json();
      if (data.enabled === false) {
        enabled = false;
        lastData = null;
      } else if (res.ok) {
        enabled = true;
        lastData = data;
      }
      // A 502 (NHL unreachable) keeps whatever we last had.
    } catch {
      // Network blip — keep showing whatever we last rendered.
    }
    render();
  }

  // ---- team picker (edit mode only) ----

  let teamsCache = null;

  function showTeamError(msg) {
    teamError.textContent = msg;
    teamError.classList.remove("hidden");
  }

  async function saveTeam(abbrev) {
    teamError.classList.add("hidden");
    try {
      const res = await authedFetch("/api/nhl/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team: abbrev }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "couldn't save that team");
      closePicker();
      lastData = null;
      enabled = !!abbrev;
      render();
      await refresh();
    } catch (err) {
      showTeamError(err.message);
    }
  }

  async function openPicker() {
    teamError.classList.add("hidden");
    teamGrid.replaceChildren(el("p", "team-loading", "Loading teams…"));
    teamModal.classList.remove("hidden");
    try {
      const res = await fetch("/api/nhl/teams");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "couldn't load the team list");
      teamsCache = data;
    } catch (err) {
      if (!teamsCache) {
        teamGrid.replaceChildren();
        showTeamError(`Couldn't load teams: ${err.message}`);
        return;
      }
    }
    const buttons = teamsCache.teams.map((team) => {
      const btn = el("button", "team-option");
      btn.type = "button";
      btn.classList.toggle("current", team.abbrev === teamsCache.current);
      btn.appendChild(logo(team.logo, "team-option-logo"));
      btn.appendChild(el("span", null, team.name));
      btn.addEventListener("click", () => saveTeam(team.abbrev));
      return btn;
    });
    teamGrid.replaceChildren(...buttons);
    (teamGrid.querySelector(".current") || buttons[0])?.focus();
  }

  function closePicker() {
    teamModal.classList.add("hidden");
  }

  widget.addEventListener("click", () => {
    if (isEditing()) openPicker();
  });
  widget.addEventListener("keydown", (e) => {
    if (isEditing() && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openPicker();
    }
  });
  document.getElementById("team-cancel").addEventListener("click", closePicker);
  document.getElementById("team-hide").addEventListener("click", () => saveTeam(""));
  teamModal.addEventListener("click", (e) => {
    if (e.target === teamModal) closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !teamModal.classList.contains("hidden")) closePicker();
  });
  document.addEventListener("editmodechange", render);

  refresh();
  setInterval(refresh, POLL_MS);
})();
