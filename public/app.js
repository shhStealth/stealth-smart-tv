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
    const res = await fetch("/api/tiles", { method: "POST", body: formData });
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
    const res = await fetch(`/api/tiles/${tile.id}`, { method: "DELETE" });
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

function render() {
  grid.innerHTML = "";
  tiles.forEach((tile) => grid.appendChild(buildTile(tile)));
  grid.appendChild(buildAddTile());
  grid.querySelector(".tile")?.focus();
}

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
