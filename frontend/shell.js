// ==== OrderFlow Command Center â€” shell ====
// Each section runs inside its own iframe (own DOM/JS/CSS scope), so the
// three OrderFlow Trader variants â€” which reuse the same element ids and
// globals â€” never collide. Switching tabs only toggles visibility; it
// never unloads an iframe, so a section keeps running/minimized in the
// background exactly like the platform-wide "don't close on switch" spec.
//
// New-tab mode: when the "Open in new browser tab" checkbox is on, clicking
// a section tab opens it as a real separate browser tab (window.open)
// instead of the embedded pane, so the currently open section is never
// interrupted. This applies going forward from the moment it's checked â€”
// sections already opened as embedded panes stay embedded â€” and it stays
// in effect (persisted across reloads) until the box is unchecked again.

const SECTIONS = [
  { id: "pro-single-display", label: "Pro · Single Display", src: "sections/pro-single-display/index.html?v=20261017-build-controls-v1" },
  { id: "taq-pro",            label: "TAQ Pro",              src: "sections/taq-pro/index.html?v=20260919-v312" },
  { id: "tas-regime",         label: "TAS Regime AutoFix",   src: "sections/tas-regime/index.html?v=20260918-v7" }
];

const NEWTAB_STORAGE_KEY = "cc_open_in_new_tab";
const VIEW_MODE_STORAGE_KEY = "cc_view_mode"; // "auto" | "desktop" | "mobile"

const tabbar = document.getElementById("cc-tabbar");
const workspace = document.getElementById("cc-workspace");
const emptyState = document.getElementById("cc-empty");
const clockEl = document.getElementById("cc-clock");
const newTabToggle = document.getElementById("cc-newtab-toggle");

const state = {}; // id -> { tabEl, paneEl, loaded, externalWin }

// ---- new-tab mode toggle (persisted) ----
function isNewTabMode() {
  return newTabToggle.checked;
}

try {
  newTabToggle.checked = localStorage.getItem(NEWTAB_STORAGE_KEY) === "1";
} catch (e) {
  // localStorage unavailable (e.g. file:// in some browsers) â€” default off
}

newTabToggle.addEventListener("change", () => {
  try {
    localStorage.setItem(NEWTAB_STORAGE_KEY, newTabToggle.checked ? "1" : "0");
  } catch (e) {}
});

// ==== Device detection: automatic, with manual override ====
// "auto" reads the real device (touch capability + viewport width) and
// re-checks on resize/orientation change. Choosing Desktop or Mobile
// pins the layout regardless of the actual device, and that choice is
// remembered (localStorage) until switched back to Auto.
const viewToggle = document.getElementById("cc-view-toggle");
const viewButtons = viewToggle.querySelectorAll(".cc-view-btn");

function detectDevice() {
  const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  const isNarrow = window.innerWidth <= 820;
  return (isTouch && isNarrow) ? "mobile" : "desktop";
}

function getViewModePref() {
  try {
    return localStorage.getItem(VIEW_MODE_STORAGE_KEY) || "auto";
  } catch (e) {
    return "auto";
  }
}

function applyViewMode() {
  const pref = getViewModePref();
  const effective = pref === "auto" ? detectDevice() : pref;
  document.documentElement.setAttribute("data-view", effective);
  viewButtons.forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.mode === pref);
  });
}

viewButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, btn.dataset.mode);
    } catch (e) {}
    applyViewMode();
  });
});

window.addEventListener("resize", () => {
  if (getViewModePref() === "auto") applyViewMode();
});

applyViewMode();

function buildTab(section) {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "cc-tab";
  tab.dataset.id = section.id;
  tab.innerHTML = `<span class="cc-tab-dot"></span><span class="cc-tab-label">${section.label}</span>`;
  tab.addEventListener("click", () => handleTabClick(section));
  tabbar.appendChild(tab);
  return tab;
}

function buildPane(section) {
  const pane = document.createElement("div");
  pane.className = "cc-pane";
  pane.dataset.id = section.id;

  const loading = document.createElement("div");
  loading.className = "cc-pane-loading";
  loading.textContent = `Loading ${section.label}...`;
  pane.appendChild(loading);

  workspace.appendChild(pane);
  return pane;
}

function loadSection(id) {
  const s = state[id];
  if (s.loaded) return;

  const section = SECTIONS.find(x => x.id === id);
  const iframe = document.createElement("iframe");
  iframe.src = section.src;
  iframe.title = section.label;
  iframe.addEventListener("load", () => {
    const loadingEl = s.paneEl.querySelector(".cc-pane-loading");
    if (loadingEl) loadingEl.remove();
  });

  s.paneEl.appendChild(iframe);
  s.loaded = true;
  s.tabEl.classList.add("is-loaded");
}

function activate(id) {
  Object.values(state).forEach(s => {
    s.tabEl.classList.remove("is-active");
    s.paneEl.classList.remove("is-active");
  });

  const s = state[id];
  if (!s) return;

  s.tabEl.classList.add("is-active");
  s.paneEl.classList.add("is-active");
  emptyState.style.display = "none";

  loadSection(id); // no-op if already loaded â€” pane/iframe stay alive
}

// Opens (or refocuses) a section as a genuine separate browser tab/window.
// The currently active embedded pane is left exactly as it is â€” nothing
// here ever touches state[otherId], so nothing already open gets closed.
function openInBrowserTab(section) {
  const s = state[section.id];
  if (s.externalWin && !s.externalWin.closed) {
    s.externalWin.focus();
    return;
  }
  s.externalWin = window.open(section.src, "_blank");
  if (s.externalWin) {
    s.tabEl.classList.add("is-loaded");
  }
}

function handleTabClick(section) {
  if (isNewTabMode()) {
    openInBrowserTab(section);
  } else {
    activate(section.id);
  }
}

SECTIONS.forEach(section => {
  state[section.id] = {
    tabEl: buildTab(section),
    paneEl: buildPane(section),
    loaded: false,
    externalWin: null
  };
});

// open the first section by default (embedded â€” new-tab mode only applies
// to explicit clicks going forward, per the spec)
if (SECTIONS.length) activate(SECTIONS[0].id);

// top-bar clock
function tickClock() {
  const now = new Date();
  clockEl.textContent = now.toLocaleTimeString("en-GB", { hour12: false });
}
tickClock();
setInterval(tickClock, 1000);

// top-bar session uptime â€” "Online: HH:MM:SS" since this Command Center
// page was opened, so anyone glancing at it knows the platform has been
// running continuously (not silently disconnected/reloaded).
const uptimeEl = document.getElementById("cc-uptime-value");
const sessionStart = Date.now();

function tickUptime() {
  const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const s = String(elapsed % 60).padStart(2, "0");
  uptimeEl.textContent = `${h}:${m}:${s}`;
}
tickUptime();
setInterval(tickUptime, 1000);

// ---- One button: choose a folder, then save both existing exports ----
const saveBothButton = document.getElementById("cc-save-both-btn");
const autosaveStatus = document.getElementById("cc-autosave-status");
let autosaveDirectory = null;
let autosaveOwnerWindow = null;

function setAutosaveStatus(text, bad = false) {
  if (autosaveStatus) {
    autosaveStatus.textContent = text || "";
    autosaveStatus.style.color = bad ? "#ff6b6b" : "#79d99b";
  }
  if (autosaveOwnerWindow) {
    autosaveOwnerWindow.postMessage({ type: "of-autosave-ui-status", text: text || "", bad: !!bad }, "*");
  }
}

window.ofChooseFolderAndSave = async frameWindow => {
  try {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error("Use Microsoft Edge or Google Chrome");
    }
    const activeSection = Object.values(state).find(s => s.tabEl.classList.contains("is-active"));
    const frame = activeSection && activeSection.paneEl.querySelector("iframe");
    autosaveOwnerWindow = frameWindow || (frame && frame.contentWindow);
    if (!autosaveOwnerWindow) throw new Error("Open a trading tab first");
    if (saveBothButton) saveBothButton.disabled = true;
    setAutosaveStatus("Select folderâ€¦");
    autosaveDirectory = await window.showDirectoryPicker({ mode: "readwrite" });
    setAutosaveStatus(`Saving to ${autosaveDirectory.name}â€¦`);
    autosaveOwnerWindow.postMessage({ type: "of-save-both" }, "*");
  } catch (err) {
    autosaveDirectory = null;
    if (saveBothButton) saveBothButton.disabled = false;
    const cancelled = err && err.name === "AbortError";
    setAutosaveStatus(cancelled ? "Selection cancelled" : `âš  ${err.message || err}`, !cancelled);
    autosaveOwnerWindow = null;
  }
};

if (saveBothButton) saveBothButton.addEventListener("click", () => window.ofChooseFolderAndSave());

window.addEventListener("message", async event => {
  const msg = event.data || {};
  // The folder picker must be opened by the top-level page. Embedded frames
  // are forbidden from calling showDirectoryPicker, even after a real click.
  if (msg.type === "of-request-save-both") {
    await window.ofChooseFolderAndSave(event.source);
    return;
  }
  if (msg.type === "of-autosave-child-status") {
    setAutosaveStatus(msg.text || "", !!msg.bad);
    if (/^[âœ“âš ]/.test(msg.text || "")) {
      if (saveBothButton) saveBothButton.disabled = false;
      autosaveDirectory = null;
      autosaveOwnerWindow = null;
    }
    return;
  }
  if (msg.type !== "of-autosave-write") return;

  const reply = { type: "of-autosave-result", requestId: msg.requestId, ok: false };
  try {
    if (!autosaveDirectory) throw new Error("Save folder is not selected");
    let permission = await autosaveDirectory.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") permission = await autosaveDirectory.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("Folder write permission was not granted");
    const filename = String(msg.filename || "export.xlsx").replace(/[\\/:*?"<>|]/g, "-");
    const fileHandle = await autosaveDirectory.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(msg.buffer);
      await writable.close();
    } catch (writeError) {
      try { await writable.abort(); } catch (e) {}
      throw writeError;
    }
    reply.ok = true;
    reply.filename = filename;
    reply.path = `${autosaveDirectory.name}\\${filename}`;
  } catch (err) {
    reply.message = err && err.message ? err.message : String(err);
  }
  event.source.postMessage(reply, "*");
});



