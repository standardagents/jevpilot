import "./style.css";
import {
  createIcons,
  Braces,
  RotateCw,
  Video,
  Pause,
  Play,
  Map,
  Maximize,
  Minimize,
  Sparkles,
  ArrowUp,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  ArrowUpRight,
  X,
  Copy,
  Download,
  RotateCcw,
  CircleHelp,
  Plus,
  Minus,
  Grip,
  Github,
  LogOut,
} from "lucide";
import { Simulation } from "./simulation.js";
import { BackgroundPlanner } from "./background-planner.js";
import { DriveScene } from "./scene.js";
import { MinimapControls } from "./minimap-controls.js";
import { Tooltips } from "./tooltips.js";
import { TouchControls } from "./touch-controls.js";
import {
  showLoading,
  hideLoading,
  loadingFailed,
  nextPaint,
} from "./loading-screen.js";
import { decisionInterval } from "./jev-request.js";
import { prepareDecisionRequest } from "./decision-request.js";
import { THEMES } from "./world.js";
import { candidateName, decisionControls } from "./planning.js";
import { clamp, nearestOnPath } from "./math.js";
const icons = {
  Braces,
  RotateCw,
  Video,
  Pause,
  Play,
  Map,
  Maximize,
  Minimize,
  Sparkles,
  ArrowUp,
  CornerUpLeft,
  CornerUpRight,
  Flag,
  ArrowUpRight,
  X,
  Copy,
  Download,
  RotateCcw,
  CircleHelp,
  Plus,
  Minus,
  Grip,
  Github,
  LogOut,
};
const icon = (name) => `<i data-lucide="${name}"></i>`,
  $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search),
  aliases = { suburb: "town", country: "highway" },
  requested = params.get("world") || "city",
  type = aliases[requested] || requested;
const sim = new Simulation(
  Number(params.get("seed")) || Math.floor(Math.random() * 999999),
  THEMES[type] ? type : "city",
);
let playCredits = null,
  loading = true,
  lastMapDraw = 0;
showLoading("Loading car and scenery…");
let configured = false,
  decisionProvider = "jev",
  decisionName = "Jev",
  authRequired = true,
  busy = false,
  generation = 0,
  lastDecision = null,
  lastInput = null,
  lastContext = null,
  lastApplied = 0,
  nextDecision = 0,
  nextContextCheck = 0,
  errors = 0,
  inspectorTab = "request",
  inspectFrozen = false,
  uiTime = 0,
  lastNow = performance.now(),
  toastTimer,
  crashHandled = false;
const keys = new Set(),
  tally = {
    cost: 0,
    calls: 0,
    constrained_steps: 0,
    request_bytes: 0,
    input: 0,
    output: 0,
    latencies: [],
    intervals: [],
  };
$("app").innerHTML = `
<main class="drive-area" aria-label="3D driving simulator"><canvas id="world-canvas" aria-label="Interactive three-dimensional driving world"></canvas><div id="vector-labels" aria-label="Jev motion vector probabilities"></div></main>
<header class="topbar glass"><a href="/" class="brand" aria-label="JevPilot by Standard Agents"><img class="brand-mark" src="/brand/standard-agents-mark.svg" alt=""/><b>JevPilot</b></a><div class="world-picker"><select id="world-select" aria-label="World environment"><option value="city">Skyline City</option><option value="town">Small town</option><option value="highway">Interstate 08</option></select><button id="new-world" title="Refresh world" aria-label="Refresh world">${icon("rotate-cw")}</button><a id="github-link" href="https://github.com/standardagents/jevpilot" target="_blank" rel="noopener noreferrer" aria-label="View JevPilot on GitHub (opens in a new tab)" title="View on GitHub">${icon("github")}</a></div></header>
<div class="navigation-hud"><div class="navigation-card glass"><span id="turn-icon">${icon("arrow-up")}</span><div><strong id="next-maneuver">Continue straight</strong><span id="turn-distance"></span></div><span class="nav-divider"></span><span id="remaining"></span><button id="map-toggle" aria-label="Toggle route map" aria-pressed="true" title="Hide route map">${icon("map")}</button></div>
<div id="minimap" class="minimap glass"><div class="minimap-toolbar" role="toolbar" aria-label="Minimap controls"><button id="map-drag" aria-label="Move minimap" title="Move minimap · drag or use arrow keys">${icon("grip")}</button><div><button id="map-zoom-out" aria-label="Zoom out" title="Zoom out">${icon("minus")}</button><button id="map-zoom-in" aria-label="Zoom in" title="Zoom in">${icon("plus")}</button><button id="map-reset" aria-label="Reset minimap" title="Reset map position, zoom and following">${icon("rotate-ccw")}</button></div></div><canvas id="map-canvas" width="380" height="310" aria-label="Route map. Drag to pan, scroll to zoom, double-click to follow the car."></canvas></div></div>
<div id="paused-overlay" hidden><div class="glass"><span>${icon("pause")} Paused</span><button id="resume" class="primary">Resume driving</button></div></div>
<div id="arrival" class="arrival glass" hidden><span class="arrival-mark">${icon("flag")}</span><span class="eyebrow">DESTINATION REACHED</span><h1>You made it.</h1><p id="arrival-summary"></p><button id="next-trip" class="primary">Next drive ${icon("arrow-up-right")}</button><button id="keep-driving" class="subtle">Keep exploring</button></div>
<div class="bottom-hud"><div class="driver-dock glass"><div class="speed-cluster"><div title="Current speed"><strong id="speed">0</strong><span>km/h</span></div><span class="speed-limit" title="Speed limit"><small>LIMIT</small><b id="speed-limit">50</b></span></div><span class="dock-divider"></span><div class="pilot-actions"><button id="autopilot" class="pilot-button" role="switch" aria-checked="false" aria-label="Jev autopilot" title="Engage Jev · J">${icon("sparkles")}<span id="pilot-label">Engage Jev</span><kbd>J</kbd></button><button id="candidates-toggle" class="candidate-button" aria-label="Show steering candidates" aria-pressed="false" title="Show steering candidates"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20V3m-3 3 3-3 3 3M12 20C12 14 7 12 3 8m0 3V8h3M12 20c0-6 5-8 9-12m-3 0h3v3"/><circle cx="12" cy="21" r="1" fill="currentColor" stroke="none"/></svg></button></div><div id="decision-status"><span id="pilot-state">Free play</span><span id="context-message">WASD to drive · Space to brake</span><span class="cost-total" title="Estimated cost from Jev-reported token usage and configured pricing."><span id="cost-label">Session</span> <strong id="cost">$0.000000</strong></span></div><span class="dock-divider"></span><div class="dock-tools" role="group" aria-label="View and driving controls"><button id="camera" title="Change camera · C" aria-label="Change camera">${icon("video")}<span id="camera-name">Chase</span></button><button id="scene-json" aria-label="Inspect live JSON" title="Inspect live JSON">${icon("braces")}</button><button id="fullscreen" aria-label="Enter fullscreen" title="Fullscreen">${icon("maximize")}</button><span class="divider"></span><button id="pause" aria-label="Pause simulation" title="Pause · P">${icon("pause")}</button><button id="sign-out" hidden aria-label="Sign out" title="Sign out">${icon("log-out")}</button></div></div></div>
<dialog id="crash-dialog" aria-labelledby="crash-title" aria-describedby="crash-description"><span class="crash-symbol">${icon("x")}</span><span class="eyebrow">DRIVE ENDED</span><h1 id="crash-title">Game over.</h1><p id="crash-description"></p><div class="crash-stats"><div><strong id="crash-speed"></strong><span>km/h at impact</span></div><div><strong id="crash-distance"></strong><span>meters driven</span></div></div><button id="retry-drive" class="primary">${icon("rotate-ccw")} Restart drive</button><button id="crash-new-world" class="secondary">Try a new world ${icon("arrow-up-right")}</button></dialog>
<dialog id="credit-dialog" aria-labelledby="credit-title"><span class="eyebrow">THANKS FOR TAKING A DRIVE</span><h2 id="credit-title">That's your free lap.</h2><p>Your $0.25 of Jev play credit has been used. You can keep exploring with manual controls.</p><button id="credit-close" class="primary">Keep driving manually</button><a href="https://standardagents.ai/" target="_blank" rel="noopener noreferrer">Explore Standard Agents ↗</a></dialog>
<div id="toast" role="status" hidden></div>
<dialog id="json-dialog"><div class="json-header"><div>${icon("braces")}<strong>Under the hood</strong><span id="json-live">LIVE · 4 Hz</span></div><button id="close-json" aria-label="Close JSON inspector">${icon("x")}</button></div><div class="json-toolbar"><div class="json-tabs"><button data-tab="request" class="active">Jev input</button><button data-tab="sensor">Perception</button><button data-tab="world">Full world</button><button data-tab="decision">Response</button></div><div class="json-actions"><button id="freeze-json">Freeze</button><button id="copy-json" aria-label="Copy displayed JSON">${icon("copy")} <span id="copy-json-label" aria-live="polite">Copy</span></button><button id="download-json">${icon("download")} Download</button></div></div><p id="json-description">Exact Jev API payload, including instructions and offered choices. Full geometry and control details stay local.</p><pre id="json-content"></pre></dialog>
<dialog id="help-dialog"><button id="close-help" class="dialog-close" aria-label="Close help">${icon("x")}</button><span class="eyebrow">YOUR NEXT DRIVE</span><h2>Take the wheel.</h2><p class="touch-help">Use the thumbstick to steer. Push up to accelerate, pull down to brake and reverse. Release to coast; hold Brake to stop.</p><div class="help-keys"><span><kbd>W / ↑</kbd> Hold accelerator</span><span><kbd>S / ↓</kbd> Brake / reverse</span><span><kbd>A / D</kbd> Steer</span><span><kbd>SPACE</kbd> Brake</span><span><kbd>J</kbd> Jev autopilot</span><span><kbd>C</kbd> Camera</span><span><kbd>P</kbd> Pause</span><span><kbd>?</kbd> Keyboard help</span></div><p>Drag the scene to orbit in Chase or Bird’s eye; drag to look around in Driver view. Scroll to zoom outside; double-click to recenter. Tap A/D for small corrections; hold for a sharper turn and release to recenter. Hold W to accelerate; release to coast with drag. S brakes, then reverses once stopped. Space applies the brake. Autopilot sets target speed directly.</p><p>The bright blue line is Jev's selected three-second plan. Use Candidates to see the sampled paths: forward in blue/cyan, reverse in purple, lane departures in amber, and predicted collisions in orange. Choice probabilities are available in the JSON inspector. The safety brake can reduce speed for a missed hazard; interventions are shown beside the autopilot button.</p><p class="asset-credits">Vehicle: <a href="https://sketchfab.com/3d-models/tesla-model-y-2021-c0a86cac582d4b33aba0fb1b1912d970" target="_blank" rel="noreferrer">Tesla Model Y 2021</a> by 763468712, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>. Geometry adapted by Tina 3D Tesla; optimized, re-materialed, and wheel-rigged for JevPilot. Tree, shrub, streetlight, surface textures and sky: <a href="https://polyhaven.com" target="_blank" rel="noreferrer">Poly Haven</a>, CC0.</p><p>Driving keys take back control. Use the JSON button for live inputs, full world state, probabilities, and session telemetry.</p></dialog>`;
$("app").insertAdjacentHTML(
  "beforeend",
  `
<div id="touch-controls" class="touch-controls" role="group" aria-label="Touch driving controls" hidden>
  <div class="touch-steering">
    <div class="touch-stick" role="group" aria-label="Driving joystick: drag up to accelerate, down to brake or reverse, left or right to steer">
      <span class="stick-up" aria-hidden="true">↑</span><span class="stick-down" aria-hidden="true">↓</span>
      <span class="stick-left" aria-hidden="true">‹</span><span class="stick-right" aria-hidden="true">›</span>
      <span class="touch-knob" aria-hidden="true"></span>
    </div>
    <span class="touch-hint">Drag to drive</span>
  </div>
  <button class="touch-brake" aria-label="Hold to brake"><span aria-hidden="true">Ⅱ</span>Brake</button>
</div>`,
);
createIcons({ icons });
const scene = new DriveScene($("world-canvas"), sim, $("vector-labels")),
  map = $("map-canvas").getContext("2d");
const minimap = new MinimapControls($("minimap"), sim, drawMap);
const tooltips = new Tooltips();
const touch = new TouchControls(
  $("touch-controls"),
  () =>
    !loading &&
    !sim.autopilot &&
    !sim.paused &&
    !sim.crash &&
    !document.hidden &&
    !document.querySelector("dialog[open]") &&
    (sim.freeExplore || !sim.complete),
);
const dockObserver = new ResizeObserver(([entry]) => {
  // Anchor both thumbs above the actual dock, including wrapped mobile layouts.
  const height =
    entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight;
  document.documentElement.style.setProperty("--dock-height", `${height}px`);
});
dockObserver.observe(document.querySelector(".driver-dock"));
for (const element of document.querySelectorAll(
  ".bottom-hud button, .bottom-hud [title], .minimap button, #map-toggle, #github-link",
))
  tooltips.set(element, element.title || element.getAttribute("aria-label"));
const planner = new BackgroundPlanner();
sim.backgroundPlanning = true;
let planningJob = null,
  rerouting = false,
  previewError = false;
async function refreshPlan() {
  if (planningJob) return planningJob;
  const token = generation,
    version = sim.routeVersion;
  const job = planner
    .run("plan", sim)
    .then((result) => {
      if (token !== generation || version !== sim.routeVersion || sim.crash)
        return null;
      sim.lastPlan = result.plan;
      sim.lastDecisionState = result.state;
      sim.routeChoices = result.routeChoices;
      sim.routeChoicesOrigin = result.routeChoicesOrigin;
      sim.nextRouteChoices = result.nextRouteChoices;
      return result;
    })
    .finally(() => {
      if (planningJob === job) planningJob = null;
    });
  planningJob = job;
  return job;
}
function requestPreview() {
  if (sim.autopilot || sim.crash) return;
  refreshPlan()
    .then((result) => {
      if (result && !sim.autopilot) scene.vectors.setCandidates(result.plan);
    })
    .catch((error) => {
      if (!previewError) {
        previewError = true;
        toast(error.message);
      }
    });
}
sim.requestReroute = async () => {
  if (rerouting || !sim.routeChoiceNeeded()) return;
  rerouting = true;
  const token = generation,
    version = sim.routeVersion;
  try {
    const next = await planner.run("reroute", sim);
    if (
      !next ||
      token !== generation ||
      version !== sim.routeVersion ||
      sim.crash ||
      !sim.routeChoiceNeeded()
    )
      return;
    if (next.route.ids.join(",") === sim.player.route.ids.join(",")) return;
    sim.installRoute({
      ...next,
      progress: nearestOnPath(sim.player, next.route.points).s,
    });
  } catch (error) {
    toast(error.message);
  } finally {
    rerouting = false;
  }
};
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    planner.dispose();
    minimap.dispose();
    tooltips.dispose();
    touch.dispose();
    dockObserver.disconnect();
    scene.dispose();
  });

function toast(text, type = "info") {
  $("toast").textContent = text;
  $("toast").classList.toggle("error", type === "error");
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4200);
}
function refreshWorld() {
  const w = sim.world;
  $("world-select").value = w.type;
  $("speed-limit").textContent = Math.round(w.theme.limit * 3.6);
  $("arrival").hidden = true;
}
function syncPilot() {
  const on = sim.autopilot;
  $("autopilot").setAttribute("aria-checked", String(on));
  $("pilot-label").textContent = on
    ? `${decisionName} engaged`
    : `Engage ${decisionName}`;
  tooltips.set(
    $("autopilot"),
    `${on ? "Disengage" : "Engage"} ${decisionName} · J`,
  );
  $("autopilot").setAttribute("aria-label", `${decisionName} autopilot`);
  $("autopilot").disabled = !!sim.crash;
  document.body.classList.toggle("piloting", on);
  touch.sync();
}

function setPilot(on) {
  if (loading) return;
  touch.reset();
  if (on && playCredits?.exhausted) {
    $("credit-dialog").showModal();
    return;
  }
  if (on && !configured) {
    toast("Jev is not connected. Check the API key on the server.", "error");
    return;
  }
  if (sim.crash || (on && sim.complete)) return;
  sim.autopilot = on;
  if (on) sim.freeExplore = false;
  generation++;
  lastApplied = 0;
  nextDecision = 0;
  errors = 0;
  sim.player.target = 0;
  sim.player.steering = 0;
  sim.player.steeringProgress = 0;
  sim.player.maneuver = null;
  scene.vectors.clear();
  syncPilot();
}
async function resetWorld(seed = sim.world.seed, type = sim.world.type) {
  if (loading) return;
  loading = true;
  touch.reset();
  showLoading("Building your next drive…");
  generation++;
  crashHandled = false;
  $("crash-dialog").close();
  document.body.classList.remove("crashed");
  keys.clear();
  await nextPaint();
  try {
    sim.reset(seed, type);
    minimap.resetView();
    planner.reset();
    previewError = false;
    lastApplied = 0;
    lastDecision = null;
    lastInput = null;
    lastContext = null;
    scene.build();
    scene.vectors.showCandidates = showCandidates;
    refreshWorld();
    syncPilot();
    $("paused-overlay").hidden = true;
    $("pause").innerHTML = icon("pause");
    $("pause").setAttribute("aria-label", "Pause simulation");
    tooltips.set($("pause"), "Pause simulation · P");
    createIcons({ icons });
    await finishLoading();
  } catch (error) {
    loadingFailed(error);
  }
}
async function finishLoading() {
  showLoading("Loading car and scenery…");
  await scene.ready;
  showLoading("Preparing the road…");
  await nextPaint();
  await scene.prepare();
  await document.fonts.ready;
  await nextPaint();
  lastNow = performance.now();
  loading = false;
  hideLoading();
  touch.sync();
  updateUI();
  drawMap();
}
function changeCamera() {
  const modes = ["chase", "hood", "map"];
  scene.mode = modes[(modes.indexOf(scene.mode) + 1) % 3];
  scene.snap = true;
  $("camera-name").textContent = {
    chase: "Chase",
    hood: "Driver",
    map: "Bird’s eye",
  }[scene.mode];
  tooltips.set(
    $("camera"),
    `Change camera · ${$("camera-name").textContent} · C`,
  );
}
function togglePause() {
  if (sim.crash || loading) return;
  touch.reset();
  keys.clear();
  sim.paused = !sim.paused;
  touch.sync();
  generation++;
  lastApplied = 0;
  nextDecision = 0;
  $("paused-overlay").hidden = !sim.paused;
  $("pause").innerHTML = icon(sim.paused ? "play" : "pause");
  tooltips.set($("pause"), `${sim.paused ? "Resume" : "Pause"} simulation · P`);
  $("pause").setAttribute(
    "aria-label",
    sim.paused ? "Resume simulation" : "Pause simulation",
  );
  createIcons({ icons });
}
$("autopilot").onclick = () => setPilot(!sim.autopilot);
let showCandidates = false,
  candidatePreviewAt = 0;
$("candidates-toggle").onclick = () => {
  showCandidates = !showCandidates;
  scene.vectors.showCandidates = showCandidates;
  $("candidates-toggle").setAttribute("aria-pressed", String(showCandidates));
  const label = `${showCandidates ? "Hide" : "Show"} steering candidates`;
  $("candidates-toggle").setAttribute("aria-label", label);
  tooltips.set($("candidates-toggle"), label);
  if (showCandidates && !scene.vectors.plan) requestPreview();
};
$("new-world").onclick = () => resetWorld(Math.floor(Math.random() * 999999));
$("world-select").onchange = (e) =>
  resetWorld(Math.floor(Math.random() * 999999), e.target.value);
$("retry-drive").onclick = () => {
  resetWorld();
  $("autopilot").focus();
};
$("crash-new-world").onclick = () =>
  resetWorld(Math.floor(Math.random() * 999999));
$("crash-dialog").addEventListener("cancel", (e) => e.preventDefault());
$("camera").onclick = changeCamera;
$("pause").onclick = togglePause;
$("resume").onclick = togglePause;
$("next-trip").onclick = () => resetWorld(Math.floor(Math.random() * 999999));
$("keep-driving").onclick = () => {
  sim.complete = false;
  sim.freeExplore = true;
  $("arrival").hidden = true;
};
$("map-toggle").onclick = () => {
  $("minimap").hidden = !$("minimap").hidden;
  $("map-toggle").setAttribute("aria-pressed", String(!$("minimap").hidden));
  tooltips.set(
    $("map-toggle"),
    `${$("minimap").hidden ? "Show" : "Hide"} route map`,
  );
  minimap.constrainPosition();
  drawMap();
};
$("fullscreen").onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("Use your browser’s fullscreen shortcut.");
  }
};
document.addEventListener("fullscreenchange", () => {
  $("fullscreen").innerHTML = icon(
    document.fullscreenElement ? "minimize" : "maximize",
  );
  $("fullscreen").setAttribute(
    "aria-label",
    document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen",
  );
  tooltips.set($("fullscreen"), $("fullscreen").getAttribute("aria-label"));
  createIcons({ icons });
});
window.addEventListener("keydown", (e) => {
  if (sim.crash || loading) return;
  if ($("json-dialog").open || $("help-dialog").open) return;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.target.closest("button") && ["Space", "Enter"].includes(e.code)) return;
  const driving = [
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Space",
  ];
  if (driving.includes(e.code)) {
    e.preventDefault();
    keys.add(e.code);
    if (sim.autopilot) setPilot(false);
  }
  if (e.repeat) return;
  if (e.code === "KeyJ") setPilot(!sim.autopilot);
  if (e.code === "KeyC") changeCamera();
  if (e.code === "KeyP") togglePause();
  if (e.key === "?") {
    e.preventDefault();
    touch.reset();
    $("help-dialog").showModal();
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  keys.clear();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    generation++;
    keys.clear();
    sim.player.target = 0;
    lastApplied = 0;
    nextDecision = 0;
  }
});
$("close-help").onclick = () => $("help-dialog").close();
$("scene-json").onclick = () => {
  touch.reset();
  $("json-dialog").showModal();
  renderJSON();
};
$("close-json").onclick = () => $("json-dialog").close();
document.querySelectorAll("[data-tab]").forEach(
  (button) =>
    (button.onclick = () => {
      inspectorTab = button.dataset.tab;
      inspectFrozen = false;
      syncFreeze();
      document
        .querySelectorAll("[data-tab]")
        .forEach((b) => b.classList.toggle("active", b === button));
      $("json-description").textContent = {
        request: `Exact ${decisionName} API payload, including instructions and offered choices. Full geometry and control details stay local.`,
        sensor:
          "Complete forward perception, route guidance, geometry predictions and vehicle telemetry.",
        world:
          "All roads, buildings, vehicles, pedestrians, controls, and the current route.",
        decision: `Actual ${decisionName} probabilities and token usage. Costs accumulate across every completed call.`,
      }[inspectorTab];
      renderJSON();
    }),
);
function syncFreeze() {
  $("freeze-json").textContent = inspectFrozen ? "Resume" : "Freeze";
  $("json-live").textContent = inspectFrozen ? "FROZEN" : "LIVE · 4 Hz";
}
$("freeze-json").onclick = () => {
  inspectFrozen = !inspectFrozen;
  syncFreeze();
};
function inspectRequest(state) {
  const { request, fixed, questions } = prepareDecisionRequest(
    state,
    decisionProvider,
  );
  return Object.keys(questions).length
    ? request
    : {
        status: `No ${decisionName} call needed: only one eligible action.`,
        resolved_locally: fixed,
      };
}
function updateCredits(credits) {
  if (!credits) return;
  playCredits = credits;
  $("cost-label").textContent = "Play credit";
}
$("credit-close").onclick = () => $("credit-dialog").close();
$("sign-out").onclick = async () => {
  setPilot(false);
  sim.paused = true;
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error();
    location.assign("/login");
  } catch {
    toast("Could not sign out. Please try again.", "error");
  }
};
function updateCostTooltip(pricing) {
  const averages = tally.calls
    ? `${Math.round(tally.input / tally.calls).toLocaleString()} input tokens/call · ${(tally.request_bytes / tally.calls / 1024).toFixed(1)} KB/call. `
    : "";
  tooltips.set(
    document.querySelector(".cost-total"),
    `${playCredits ? "Remaining from your one-time $0.25 allowance. " : ""}${averages}Estimated from ${decisionName}-reported tokens at $${pricing.input_per_million}/M input and $${pricing.output_per_million}/M output.${pricing.minimum_per_request ? ` Minimum $${pricing.minimum_per_request.toFixed(6)}/request.` : ""}`,
  );
}
function inspectData() {
  if (inspectorTab === "request") {
    if (
      !sim.lastDecisionState ||
      (!sim.autopilot && !showCandidates && !sim.paused)
    )
      requestPreview();
    return (
      lastInput ||
      (sim.lastDecisionState
        ? inspectRequest(sim.lastDecisionState)
        : { status: "Preparing driving state…" })
    );
  }
  if (inspectorTab === "decision")
    return {
      response: lastDecision,
      last_submitted_input: lastInput,
      session: {
        ...tally,
        average_input_tokens: tally.calls
          ? Math.round(tally.input / tally.calls)
          : 0,
        average_request_bytes: tally.calls
          ? Math.round(tally.request_bytes / tally.calls)
          : 0,
      },
    };
  return sim.observation(inspectorTab === "world");
}
let copyFeedbackTimer;
$("copy-json").onclick = async () => {
  // Copy exactly the snapshot on screen, including when the inspector is frozen.
  const text = $("json-content").textContent;
  const button = $("copy-json");
  clearTimeout(copyFeedbackTimer);
  button.disabled = true;
  try {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Keep the fallback inside the modal so it can receive focus for copying.
      const field = document.createElement("textarea");
      field.value = text;
      field.readOnly = true;
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      $("json-dialog").append(field);
      try {
        field.select();
        if (!document.execCommand("copy")) throw Error("Clipboard unavailable");
      } finally {
        field.remove();
      }
    }
    $("copy-json-label").textContent = "Copied!";
  } catch {
    inspectFrozen = true;
    syncFreeze();
    const range = document.createRange();
    range.selectNodeContents($("json-content"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    $("copy-json-label").textContent = "Press ⌘C / Ctrl+C";
  } finally {
    button.disabled = false;
    button.focus({ preventScroll: true });
    copyFeedbackTimer = setTimeout(() => {
      $("copy-json-label").textContent = "Copy";
    }, 3000);
  }
};
$("download-json").onclick = () => {
  const text = inspectFrozen
      ? $("json-content").textContent
      : JSON.stringify(inspectData(), null, 2),
    a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = `jev-${inspectorTab}-${sim.world.seed}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
function renderJSON() {
  if (inspectFrozen) return;
  const text = JSON.stringify(inspectData(), null, 2);
  $("json-content").innerHTML = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /("(?:\\.|[^"\\])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
      (m) =>
        `<span class="${m.startsWith('"') ? (m.endsWith(":") ? "json-key" : "json-string") : /true|false|null/.test(m) ? "json-bool" : "json-number"}">${m}</span>`,
    );
}
async function decide() {
  if (
    loading ||
    busy ||
    !sim.autopilot ||
    sim.paused ||
    document.hidden ||
    sim.complete ||
    sim.crash
  )
    return;
  const now = performance.now();
  if (now < nextDecision) {
    if (errors || now < nextContextCheck || now - lastApplied < 250) return;
    nextContextCheck = now + 100;
    // Recheck lights/stop memory early while the normal cadence is relaxed.
    if (!lastContext || !sim.decisionContextChanged(lastContext)) return;
  }
  busy = true;
  const token = generation,
    started = performance.now();
  try {
    const planned = await refreshPlan();
    if (
      !planned ||
      token !== generation ||
      !sim.autopilot ||
      sim.paused ||
      sim.crash
    )
      return;
    const { state, plan } = planned;
    scene.vectors.setCandidates(plan);
    lastInput = inspectRequest(state);
    const res = await fetch("/api/decide", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, request_id: crypto.randomUUID() }),
        signal: AbortSignal.timeout(12000),
      }),
      data = await res.json();
    updateCredits(data.credits);
    if (res.status === 401 && authRequired) {
      setPilot(false);
      location.assign("/login");
      return;
    }
    if (res.status === 402 && authRequired) {
      setPilot(false);
      $("credit-dialog").showModal();
      return;
    }
    if (!res.ok) throw Error(data.error || "Jev request failed");
    if (data.decision_source === "only_eligible_action")
      tally.constrained_steps++;
    else tally.calls++;
    tally.request_bytes += data.request_bytes ?? 0;
    tally.cost += data.cost_usd;
    tally.input += data.usage.input_tokens;
    tally.output += data.usage.output_tokens;
    updateCostTooltip(data.pricing);
    tally.latencies.push(data.latency_ms);
    if (tally.latencies.length > 25) tally.latencies.shift();
    if (
      token !== generation ||
      state.route_version !== sim.routeVersion ||
      !sim.autopilot ||
      sim.paused ||
      sim.crash
    )
      return;
    const controls = decisionControls(state, data);
    if (!controls) throw Error("Jev returned a mismatched candidate batch.");
    const now = performance.now();
    if (now - started > 1800)
      throw Error("Jev decision expired before it arrived. Replanning.");
    if (sim.decisionContextChanged(state)) {
      // A changed light or a newly completed stop needs another Jev decision.
      // Keep the previous maneuver briefly instead of inserting a new brake.
      nextDecision = 0;
      return;
    }
    if (
      data.answers.route?.choice &&
      data.answers.route.choice !== "keep" &&
      sim.chooseRoute(data.answers.route.choice)
    ) {
      nextDecision = 0;
      return;
    }
    if (lastApplied) tally.intervals.push(now - lastApplied);
    if (tally.intervals.length > 20) tally.intervals.shift();
    lastDecision = { ...data, received_at_simulation_s: sim.time };
    lastContext = state;
    lastApplied = now;
    errors = 0;
    sim.player.maneuver = state.vectors[data.selection.choice];
    sim.player.steering = controls.steering;
    sim.player.target = controls.velocity;
    scene.vectors.setAnswer(data.selection, plan);
    nextDecision = started + decisionInterval(state);
  } catch (error) {
    if (token === generation) {
      sim.player.target = 0;
      scene.vectors.clear();
      errors++;
      nextDecision = performance.now() + Math.min(15000, 1000 * 2 ** errors);
      toast(error.message, "error");
      sim.event(error.message, "error");
      if (errors >= 3) {
        setPilot(false);
        toast(
          "Jev paused after three failed requests. Toggle autopilot to reconnect.",
          "error",
        );
      }
    }
  } finally {
    busy = false;
  }
}
function drawMap() {
  const w = sim.world,
    v = sim.player,
    W = 380,
    H = 310;
  const view = minimap.view(),
    scale = view.scale;
  const pt = (p) => [
    (p.x - view.center.x) * scale,
    (p.z - view.center.z) * scale,
  ];
  map.clearRect(0, 0, W, H);
  map.fillStyle = "#f3f4f6";
  map.fillRect(0, 0, W, H);
  map.save();
  map.translate(W / 2, H * 0.65);
  map.rotate(-view.heading);
  map.lineCap = "round";
  map.strokeStyle = "#d0d3d8";
  if (w.roadSamples) {
    map.lineWidth = 25 * scale;
    map.beginPath();
    w.roadSamples.forEach((p, i) =>
      i ? map.lineTo(...pt(p)) : map.moveTo(...pt(p)),
    );
    map.stroke();
  }
  if (w.connectorRoads) {
    for (const road of w.connectorRoads) {
      map.lineWidth = road.width * scale;
      map.beginPath();
      road.points.forEach((p, i) =>
        i ? map.lineTo(...pt(p)) : map.moveTo(...pt(p)),
      );
      map.stroke();
    }
  } else if (!w.roadSamples)
    for (const e of w.edges) {
      map.lineWidth = e.width * scale;
      map.beginPath();
      map.moveTo(...pt(w.byId[e.a]));
      map.lineTo(...pt(w.byId[e.b]));
      map.stroke();
    }
  map.strokeStyle = "#3e6ae1";
  map.lineWidth = 4;
  map.beginPath();
  w.route.points.forEach((p, i) =>
    i ? map.lineTo(...pt(p)) : map.moveTo(...pt(p)),
  );
  map.stroke();
  for (const car of sim.traffic) {
    map.fillStyle = car.type === "motorcycle" ? "#e82127" : "#81858d";
    map.beginPath();
    map.arc(...pt(car), 4, 0, Math.PI * 2);
    map.fill();
  }
  const end = pt(w.route.points.at(-1));
  map.fillStyle = "#171a20";
  map.fillRect(end[0] - 3, end[1] - 6, 8, 7);
  map.fillRect(end[0] - 3, end[1] - 6, 1, 14);
  // Following keeps the car pointed up; a panned map keeps its own heading.
  map.save();
  map.translate(...pt(v));
  map.rotate(v.heading);
  map.fillStyle = "#ffffff";
  map.beginPath();
  map.arc(0, 0, 13, 0, Math.PI * 2);
  map.fill();
  map.fillStyle = "#171a20";
  map.beginPath();
  map.moveTo(0, -10);
  map.lineTo(7, 7);
  map.lineTo(0, 4);
  map.lineTo(-7, 7);
  map.closePath();
  map.fill();
  map.restore();
  map.restore();
}

function updateUI() {
  const v = sim.player,
    nav = sim.navigation();
  $("speed").textContent = Math.round(Math.abs(v.speed) * 3.6);
  $("speed-limit").textContent = Math.round(
    (nav.speed_limit_mps ?? sim.world.theme.limit) * 3.6,
  );
  $("remaining").textContent =
    nav.remaining_m >= 1000
      ? `${(nav.remaining_m / 1000).toFixed(1)} km`
      : `${Math.round(nav.remaining_m)} m`;
  $("next-maneuver").textContent =
    nav.instruction ||
    (nav.next_turn === "arrive"
      ? sim.world.type === "highway"
        ? "Follow Interstate 08"
        : "Destination ahead"
      : nav.next_turn === "straight"
        ? "Continue straight"
        : nav.next_turn === "uturn"
          ? "Make a U-turn"
          : `Turn ${nav.next_turn}`);
  $("turn-distance").textContent =
    nav.next_turn === "arrive"
      ? "to your destination"
      : `in ${Math.round(nav.turn_distance_m)} m`;
  const turnIcon = {
    uturn: "rotate-ccw",
    left: "corner-up-left",
    right: "corner-up-right",
    straight: "arrow-up",
    arrive: "flag",
    merge: "corner-up-left",
    exit: "corner-up-right",
  }[nav.next_turn];
  if ($("turn-icon").dataset.icon !== turnIcon) {
    $("turn-icon").innerHTML = icon(turnIcon);
    $("turn-icon").dataset.icon = turnIcon;
    createIcons({ icons });
  }
  const answer = lastDecision?.selection,
    stale = !lastApplied || performance.now() - lastApplied > 1800;
  $("pilot-state").textContent = sim.autopilot
    ? stale
      ? "Reading the road…"
      : `${candidateName(scene.vectors.answeredPlan?.vectors[answer.choice])} · ${Math.round(answer.confidence * 100)}%`
    : sim.crash
      ? "Drive ended"
      : "Free play";
  $("context-message").textContent = sim.autopilot
    ? sim.brakeReason
      ? `Safety brake · ${sim.brakeReason}`
      : stale
        ? "Waiting for a fresh decision"
        : `${Math.round(v.target * 3.6)} km/h target · ${lastDecision.latency_ms} ms`
    : touch.available
      ? "Drag to drive · Hold Brake to stop"
      : "WASD to drive · Space to brake";
  if (
    sim.autopilot &&
    !stale &&
    !sim.brakeReason &&
    v.speed < 0.5 &&
    v.target < 0.5
  ) {
    $("context-message").textContent =
      lastDecision.decision_source === "only_eligible_action"
        ? "Only stop is available · rechecking scene"
        : "Jev chose to wait · evaluating traffic";
  }
  if (nav.rerouted)
    $("context-message").textContent =
      "Route recalculated · continuing to your destination";
  else if (rerouting && sim.routeChoiceNeeded())
    $("context-message").textContent = "Recalculating route…";
  else if (sim.lastPlan?.recovery.active)
    $("context-message").textContent = sim.lastPlan.road.on_road
      ? "Returning to the route"
      : "Finding a way back onto the road";
  $("cost").textContent = playCredits
    ? `$${Math.max(0, playCredits.remaining_usd).toFixed(4)}`
    : `$${tally.cost.toFixed(6)}`;
  if (sim.complete && !sim.freeExplore) {
    $("arrival").hidden = false;
    $("arrival-summary").textContent =
      `${Math.round(sim.distance)} m driven · ${sim.collisions} contacts · ${sim.violations} violations`;
    if ($("autopilot").getAttribute("aria-checked") === "true") {
      generation++;
      syncPilot();
    }
  }
  if ($("json-dialog").open) renderJSON();
}
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastNow) / 1000, 0.2);
  lastNow = now;
  if (document.hidden || loading) return;
  touch.sync();
  if (!sim.paused && !sim.crash) {
    if (!sim.autopilot) {
      let steer = 0;
      const left = keys.has("KeyA") || keys.has("ArrowLeft");
      const right = keys.has("KeyD") || keys.has("ArrowRight");
      if (left || right) steer = Number(right) - Number(left);
      let throttle = 0;
      if (keys.has("KeyW") || keys.has("ArrowUp")) throttle = 1;
      if (keys.has("KeyS") || keys.has("ArrowDown")) throttle = -1;
      sim.pedals.throttle = throttle || touch.throttle;
      sim.pedals.brake = keys.has("Space") ? 1 : touch.brake;
      sim.steeringInput = steer || touch.steering;
      sim.player.target = 0;
    } else if (!lastApplied || now - lastApplied > 1800) sim.player.target = 0;
    // Preserve real elapsed time on slower displays using bounded physics substeps.
    const steps = Math.max(1, Math.ceil(dt / 0.025));
    for (let i = 0; i < steps; i++) sim.step(dt / steps);
  }
  if (scene.routeVersion !== sim.routeVersion) {
    scene.routeVersion = sim.routeVersion;
    generation++;
    lastApplied = 0;
    lastDecision = null;
    lastInput = null;
    lastContext = null;
    nextDecision = 0;
    scene.vectors.clear();
    const destination = sim.player.route.points.at(-1);
    scene.destination.position.set(destination.x, 0.2, destination.z);
  }
  if (sim.crash && !crashHandled) {
    crashHandled = true;
    generation++;
    keys.clear();
    scene.vectors.clear();
    syncPilot();
    $("arrival").hidden = true;
    $("paused-overlay").hidden = true;
    $("json-dialog").close();
    $("help-dialog").close();
    document.body.classList.add("crashed");
    $("crash-description").textContent = {
      building: "You collided with a building.",
      pedestrian: "You struck a pedestrian.",
      car: "You collided with another car.",
      motorcycle: "You collided with a motorcycle.",
    }[sim.crash.type];
    $("crash-speed").textContent = Math.round(sim.crash.impact_speed_mps * 3.6);
    $("crash-distance").textContent = Math.round(sim.distance);
    $("crash-dialog").showModal();
  }
  if (
    showCandidates &&
    !sim.autopilot &&
    !sim.paused &&
    !sim.crash &&
    now - candidatePreviewAt > 500
  ) {
    candidatePreviewAt = now;
    requestPreview();
  }
  scene.render(dt);
  if (!$("minimap").hidden && now - lastMapDraw >= 100) {
    drawMap();
    lastMapDraw = now;
  }
  uiTime += dt;
  if (uiTime > 0.2) {
    uiTime = 0;
    updateUI();
  }
}
refreshWorld();
syncPilot();
updateUI();
requestAnimationFrame(animate);
finishLoading().catch(loadingFailed);
setInterval(decide, 25);
fetch("/api/status", { credentials: "same-origin" })
  .then((r) => r.json())
  .then((data) => {
    authRequired = data.auth_required !== false;
    if (authRequired && data.authenticated !== true) {
      location.replace("/login");
      return;
    }
    updateCredits(data.credits);
    $("sign-out").hidden = !data.authenticated;
    if (data.user) tooltips.set($("sign-out"), `Sign out · ${data.user.email}`);
    configured = data.configured;
    decisionProvider = data.decision_provider ?? "jev";
    decisionName = data.decision_name ?? "Jev";
    document.querySelector('[data-tab="request"]').textContent =
      `${decisionName} input`;
    syncPilot();
    $("json-description").textContent =
      `Exact ${decisionName} API payload, including instructions and offered choices. Full geometry and control details stay local.`;
    updateCostTooltip(data.pricing);
    if (!configured)
      toast(
        `${decisionName} API key is missing. Check the server configuration.`,
        "error",
      );
  })
  .catch(() => {
    toast("Jev server unavailable.", "error");
  });

export { sim, scene };
