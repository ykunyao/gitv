// gitv frontend: three zones in a pannable world, live via SSE.

import type { RepoModel, ModelEvent } from "./api.ts";
import { getTree } from "./api.ts";
import { Scene, PosStore, el, place } from "./scene.ts";
import { layoutGraph, renderGraph } from "./graph.ts";
import { renderField } from "./field.ts";
import { renderPacks, invalidatePacks } from "./packs.ts";
import { renderFlow, type FlowTarget } from "./flow.ts";
import { Inspector } from "./inspector.ts";
import { searchModel, renderHits, type SearchHit } from "./search.ts";

const stage = document.getElementById("stage")!;
const world = document.getElementById("world")!;
const scene = new Scene(stage, world);
const inspector = new Inspector();

// opening a commit: the inspector offers its changed files; clicking one
// shows that file's diff with a way back
const openObject = (sha: string): void => {
  void inspector.openObject(sha, (s, file) => void inspector.showCommitFileDiff(s, file, () => openObject(s)));
};

// keep the scene's selected node in sync with what the inspector shows,
// and — for commits — dim every field object the commit does not contain
let currentModel: RepoModel | null = null;
let scopeShas: Set<string> | null = null;

const applyScope = (): void => {
  for (const card of document.querySelectorAll<HTMLElement>(".obj-card[data-sha]")) {
    card.classList.toggle("dim", !!scopeShas && !scopeShas.has(card.dataset.sha!));
  }
};

inspector.onChange = (sha): void => {
  for (const n of document.querySelectorAll(".commit-row.selected, .obj-card.selected")) n.classList.remove("selected");
  scopeShas = null;
  applyScope();
  if (!sha) return;
  document.querySelector(`.commit-row[data-sha="${sha}"]`)?.classList.add("selected");
  document.querySelector(`.obj-card[data-sha="${sha}"]`)?.classList.add("selected");
  const c = currentModel?.commits.find((x) => x.sha === sha);
  if (c) {
    void getTree(c.tree, 2500).then((entries) => {
      if (inspector.currentSha !== sha) return;
      scopeShas = new Set([sha, c.tree, ...entries.map((e) => e.sha)]);
      applyScope();
    });
  }
};

const graphZone = el("section", "zone");
graphZone.id = "zone-graph";
graphZone.appendChild(el("div", "zone-label", "HISTORY"));
const flowZone = el("section", "zone");
flowZone.appendChild(el("div", "zone-label", "CHANGES"));
const packsZone = el("section", "zone");
packsZone.appendChild(el("div", "zone-label", "PACKS ON DISK"));
const fieldZone = el("section", "zone");
fieldZone.appendChild(el("div", "zone-label", "OBJECTS ON DISK"));
world.append(graphZone, flowZone, packsZone, fieldZone);

let posStore = new PosStore("boot");
let fitDone = false;
let lastRender: { model: RepoModel; events: ModelEvent[] } | null = null;

function render(model: RepoModel, events: ModelEvent[]): void {
  currentModel = model;
  lastRender = { model, events };
  const gap = 64;
  const graphFlash = new Set<string>();
  for (const e of events) {
    if (e.e === "commit-add") graphFlash.add(e.sha);
    else if (e.e === "head-move" && model.head.sha) graphFlash.add(model.head.sha);
    else if (e.e === "ref-move" || e.e === "ref-add") {
      const r = model.refs.find((x) => x.name === e.name);
      if (r) graphFlash.add(r.kind === "tag" ? r.peeled ?? r.sha : r.sha);
    }
  }

  // graph
  const layout = model.commits.length
    ? layoutGraph(model.commits)
    : { nodes: new Map(), order: [], edges: [], ghosts: new Set<string>(), lanes: 1, rows: 0 };
  const graph = renderGraph(graphZone, layout, model, posStore, scene, graphFlash, inspector.currentSha, (sha) => openObject(sha));

  // flow
  const flowFlash = new Set<string>();
  for (const e of events) {
    if (e.e === "index") for (const p of [...e.added, ...e.modified, ...e.removed]) { flowFlash.add(`index/${p}`); flowFlash.add(`worktree/${p}`); }
  }
  const flow = renderFlow(flowZone, model, flowFlash, () => {
    if (lastRender) render(lastRender.model, []);
  }, (target) => void inspector.openChip(target));

  // packs (only when at least one packfile exists)
  let packsH = 0;
  if (model.packs.length) {
    const packs = renderPacks(packsZone, model, (sha) => openObject(sha));
    const packsY = Math.max(graph.height, flow.height) + gap;
    place(packsZone, 0, packsY);
    packsZone.style.width = `${packs.width}px`;
    packsZone.style.height = `${packs.height}px`;
    packsZone.style.display = "block";
    packsH = packs.height;
  } else {
    packsZone.style.display = "none";
  }

  // field
  const fieldFlash = new Set<string>();
  for (const e of events) if (e.e === "object-add" || e.e === "object-del") fieldFlash.add(e.sha);
  const field = renderField(fieldZone, model, posStore, scene, fieldFlash, inspector.currentSha, (sha) => openObject(sha));
  applyScope();

  // zones: graph top-left, flow to its right, packs + field below
  const flowX = graph.width + gap;
  place(flowZone, flowX, 0);
  flowZone.style.width = `${flow.width}px`;
  flowZone.style.height = `${flow.height}px`;

  place(graphZone, 0, 0);
  graphZone.style.width = `${graph.width}px`;
  graphZone.style.height = `${graph.height}px`;

  const packsY = Math.max(graph.height, flow.height) + gap;
  const fieldY = packsY + (model.packs.length ? packsH + gap : 0);
  const fieldW = Math.max(field.width, graph.width + gap + flow.width);
  place(fieldZone, 0, fieldY);
  fieldZone.style.width = `${fieldW}px`;

  world.style.width = `${fieldW}px`;
  world.style.height = `${fieldY + field.height + 60}px`;

  hud(model);
}

function hud(model: RepoModel): void {
  document.getElementById("hud-repo")!.replaceChildren(
    el("span", "brand", "gitv "),
    document.createTextNode(model.repo.name),
  );
  const head = document.getElementById("hud-head")!;
  const branch = model.head.detached ? "detached" : model.head.short ?? "…";
  const dirty = model.status.staged.length + model.status.unstaged.length + model.status.untracked.length;
  const ab = model.status.ahead || model.status.behind
    ? ` ${model.status.ahead ? "↑" + model.status.ahead : ""}${model.status.behind ? "↓" + model.status.behind : ""}`
    : "";
  head.textContent = `${branch}${model.head.sha ? "@" + model.head.sha.slice(0, 7) : ""}${ab}${dirty ? ` · ${dirty} changed` : ""} · ${model.counts.objectsTotal} objects`;
  head.title = "";
}

// ---- boot --------------------------------------------------------------------

async function boot(): Promise<void> {
  const r = await fetch("/api/model");
  if (!r.ok) {
    const tip = el("div", "empty-tip", "not a git repository");
    document.body.appendChild(tip);
    return;
  }
  const { model } = (await r.json()) as { model: RepoModel };
  posStore = new PosStore(model.repo.path);
  render(model, []);
  if (!fitDone) {
    fitDone = true;
    requestAnimationFrame(() => scene.fitTop(world.clientWidth || 1500));
  }

  const es = new EventSource("/api/events");
  const live = document.getElementById("hud-live")!;
  es.addEventListener("open", () => live.classList.replace("off", "live"));
  es.addEventListener("error", () => live.classList.replace("live", "off"));
  es.addEventListener("model", (ev) => {
    const payload = JSON.parse((ev as MessageEvent).data) as { model: RepoModel; events: ModelEvent[] };
    posStore = new PosStore(payload.model.repo.path);
    render(payload.model, payload.events);
  });
}

// ---- search -------------------------------------------------------------------

const searchPanel = document.getElementById("search")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchHits = document.getElementById("search-hits")!;

const closeSearch = (): void => {
  searchPanel.hidden = true;
  searchInput.blur();
};
const pickHit = (h: SearchHit): void => {
  closeSearch();
  h.pick();
};

searchInput.addEventListener("input", () => {
  renderHits(searchHits, currentModel ? searchModel(currentModel, searchInput.value) : [], pickHit);
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const hits = currentModel ? searchModel(currentModel, searchInput.value) : [];
  if (hits[0]) pickHit(hits[0]);
});
document.addEventListener("keydown", (e) => {
  if (!searchPanel.hidden) {
    if (e.key === "Escape") closeSearch();
    return;
  }
  if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    searchPanel.hidden = false;
    searchInput.value = "";
    searchHits.replaceChildren();
    searchInput.focus();
  } else if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    searchPanel.hidden = false;
    searchInput.focus();
  }
});
searchPanel.addEventListener("pointerdown", (e) => {
  if (e.target === searchPanel) closeSearch();
});

// search picks jump the camera to the node and pulse it
window.addEventListener("gitv:jump", (e) => {
  const node = (e as CustomEvent).detail.node as HTMLElement;
  const c = scene.worldCenterOf(node);
  scene.centerOn(c.x, c.y);
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1900);
});

// ---- zoom & layout ------------------------------------------------------------

document.getElementById("zoom-in")!.addEventListener("click", () => scene.zoomTo(scene.scale * 1.25, stage.clientWidth / 2, stage.clientHeight / 2));
document.getElementById("zoom-out")!.addEventListener("click", () => scene.zoomTo(scene.scale / 1.25, stage.clientWidth / 2, stage.clientHeight / 2));
document.getElementById("zoom-fit")!.addEventListener("click", () => scene.fitTop(world.clientWidth || 1500));
document.getElementById("layout-reset")!.addEventListener("click", () => {
  posStore.clear();
  if (lastRender) render(lastRender.model, []);
});

void boot();

// debug/test handle (also handy in the console)
declare global {
  interface Window { __gitv?: { scene: Scene; world: HTMLElement; inspector: Inspector } }
}
window.__gitv = { scene, world, inspector };
