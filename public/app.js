const grid = document.getElementById("grid");
const nowPlayingEl = document.getElementById("now-playing");
const statusEl = document.getElementById("status");

const modal = document.getElementById("tile-modal");
const tileForm = document.getElementById("tile-form");
const tileNameInput = document.getElementById("tile-name");
const tileUrlInput = document.getElementById("tile-url");
const tileIconInput = document.getElementById("tile-icon");
const tileFormError = document.getElementById("tile-form-error");

let tiles = [];
let editMode = false;

const editToggle = document.getElementById("edit-toggle");
editToggle.addEventListener("click", () => {
  editMode = !editMode;
  editToggle.classList.toggle("active", editMode);
  render();
});

function getStoredToken() {
  try { return localStorage.getItem("editToken") || ""; } catch { return ""; }
}

function setStoredToken(token) {
  try { localStorage.setItem("editToken", token); } catch { /* ignore */ }
}

// Wraps fetch for the mutating endpoints (add/remove a tile). Viewing the
// dashboard is never gated, so this is only used for POST/DELETE. If the
// backend has EDIT_TOKEN set and we get a 401, prompt once and retry; the
// token is then cached in this browser's localStorage so it's not asked
// again until it stops matching (e.g. the backend's token changed).
async function authedFetch(url, options = {}) {
  options.headers = { ...(options.headers || {}), "X-Edit-Token": getStoredToken() };
  let res = await fetch(url, options);
  if (res.status === 401) {
    const token = prompt("Enter the edit token to add/remove apps:");
    if (token === null) return res;
    setStoredToken(token);
    options.headers["X-Edit-Token"] = token;
    res = await fetch(url, options);
  }
  return res;
}

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", !!isError);
}

function openModal() {
  tileForm.reset();
  tileFormError.classList.add("hidden");
  modal.classList.remove("hidden");
  tileNameInput.focus();
}

function closeModal() {
  modal.classList.add("hidden");
}

document.getElementById("tile-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

tileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  tileFormError.classList.add("hidden");
  const formData = new FormData();
  formData.append("name", tileNameInput.value.trim());
  formData.append("url", tileUrlInput.value.trim());
  if (tileIconInput.files[0]) formData.append("icon", tileIconInput.files[0]);

  try {
    const res = await authedFetch("/api/tiles", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "couldn't add that app");
    tiles.push(data.tile);
    closeModal();
    render();
  } catch (err) {
    tileFormError.textContent = err.message;
    tileFormError.classList.remove("hidden");
  }
});

async function removeTile(tile) {
  if (!confirm(`Remove "${tile.name}"?`)) return;
  try {
    const res = await authedFetch(`/api/tiles/${tile.id}`, { method: "DELETE" });
    if (!res.ok) throw new Error("couldn't remove that app");
    tiles = tiles.filter((t) => t.id !== tile.id);
    render();
  } catch (err) {
    setStatus(err.message, true);
  }
}

function buildTile(tile) {
  const el = document.createElement("button");
  el.className = "tile";
  el.type = "button";

  if (tile.icon) {
    const img = document.createElement("img");
    img.src = tile.icon;
    img.alt = tile.name;
    img.onerror = () => { img.replaceWith(Object.assign(document.createElement("div"), {
      className: "placeholder-icon", textContent: "\u{1F310}" })); };
    el.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "placeholder-icon";
    ph.textContent = "\u{1F310}";
    el.appendChild(ph);
  }

  const label = document.createElement("div");
  label.textContent = tile.name;
  el.appendChild(label);

  const remove = document.createElement("span");
  remove.className = "tile-remove";
  remove.textContent = "×";
  remove.title = `Remove ${tile.name}`;
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    removeTile(tile);
  });
  el.appendChild(remove);

  el.addEventListener("click", () => window.open(tile.url, "_blank"));

  return el;
}

function buildAddTile() {
  const el = document.createElement("button");
  el.className = "tile add-tile";
  el.type = "button";
  const ph = document.createElement("div");
  ph.className = "placeholder-icon";
  ph.textContent = "+";
  el.appendChild(ph);
  const label = document.createElement("div");
  label.textContent = "Add app";
  el.appendChild(label);
  el.addEventListener("click", openModal);
  return el;
}

const MIN_TILE_SIZE = 110;
const MAX_TILE_SIZE = 380;
const GRID_PADDING = 16; // matches .grid's padding in style.css

// Tries every row count (not just "cram as many onto one row as fit"),
// and picks whichever lets tiles be biggest — so it happily wraps to a
// second row sooner if that means bigger tiles. The grid's own width is
// then set (via --grid-width) to exactly fit that many columns, rather
// than the full available width — with flex-wrap, that makes a ragged
// last row (e.g. 2 under a row of 3) center itself under the full rows
// above, instead of packing extra tiles in wherever they still fit (which
// a full-width flex-wrap container would do, ignoring the row count a
// size was chosen for) or hugging the left edge with empty space on the
// right. The height budget for a given row count is always part of
// picking its size, so tiles never end up taller than what actually fits
// — no cutoff top or bottom. Shrinks down to MIN_TILE_SIZE; past that the
// grid scrolls (its own overflow-y) rather than shrinking further.
function fitTiles(tileCount) {
  // Reset to full width before measuring — otherwise a previous call's
  // narrower --grid-width (set below) would still be in effect, and we'd
  // measure our own last output instead of what's actually available.
  grid.style.removeProperty("--grid-width");
  const gap = parseFloat(getComputedStyle(grid).gap) || 48;
  // clientWidth/Height include the grid's own padding, so subtract it back
  // out — tiles are sized to fit the space inside that padding, leaving
  // the padding itself as untouched breathing room around the cluster.
  const width = grid.clientWidth - GRID_PADDING * 2;
  const height = grid.clientHeight - GRID_PADDING * 2;
  if (!width || !height || !tileCount) return;

  let bestSize = MIN_TILE_SIZE;
  let bestColumns = tileCount;
  for (let rows = 1; rows <= tileCount; rows++) {
    const columns = Math.ceil(tileCount / rows);
    const sizeForWidth = (width - gap * (columns - 1)) / columns;
    const sizeForHeight = (height - gap * (rows - 1)) / rows;
    const size = Math.min(sizeForWidth, sizeForHeight, MAX_TILE_SIZE);
    if (size > bestSize) {
      bestSize = size;
      bestColumns = columns;
    }
  }

  const contentWidth = bestColumns * bestSize + (bestColumns - 1) * gap;
  grid.style.setProperty("--tile-size", `${bestSize}px`);
  grid.style.setProperty("--grid-width", `${contentWidth + GRID_PADDING * 2}px`);
}

// Keep the add-tile out of the way once you have apps, so it isn't
// permanently taking up a grid slot — except on a totally empty
// dashboard, where there'd otherwise be no visible way in at all.
function shouldShowAddTile() {
  return editMode || tiles.length === 0;
}

function render() {
  grid.innerHTML = "";
  tiles.forEach((tile) => grid.appendChild(buildTile(tile)));
  if (shouldShowAddTile()) grid.appendChild(buildAddTile());
  fitTiles(tiles.length + (shouldShowAddTile() ? 1 : 0));
  grid.querySelector(".tile")?.focus();
}

window.addEventListener("resize", () => fitTiles(tiles.length + (shouldShowAddTile() ? 1 : 0)));

// Arrow-key / Enter navigation, for a wireless keyboard or a controller
// mapped to arrow keys (most "d-pad to keyboard" utilities do this).
grid.addEventListener("keydown", (e) => {
  const els = Array.from(grid.querySelectorAll(".tile"));
  const idx = els.indexOf(document.activeElement);
  if (idx === -1) return;
  if (e.key === "ArrowRight") els[(idx + 1) % els.length].focus();
  else if (e.key === "ArrowLeft") els[(idx - 1 + els.length) % els.length].focus();
  else return;
  e.preventDefault();
});

async function loadTiles() {
  try {
    const res = await fetch("/api/tiles");
    const data = await res.json();
    tiles = data.tiles || [];
    render();
    setStatus("Connected");
  } catch (e) {
    setStatus("Couldn't load your apps", true);
  }
}

// Only meaningful if the backend's optional ROKU_IP is set; otherwise this
// just quietly reports nothing every 5s and the "On TV" line never updates.
async function pollActiveApp() {
  try {
    const res = await fetch("/api/active-app");
    const data = await res.json();
    if (data.name === "Roku") {
      nowPlayingEl.innerHTML = `On TV: <span class="live">Roku Home / Screensaver</span>`;
    } else if (data.name) {
      nowPlayingEl.innerHTML = `On TV: <span class="live">${data.name}</span>`;
    }
  } catch (e) {
    // silently ignore — this is an optional feature
  }
}

loadTiles();
pollActiveApp();
setInterval(pollActiveApp, 5000);
