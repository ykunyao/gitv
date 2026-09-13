// gitv frontend: three zones in a pannable world, live via SSE.

import type { RepoModel, ModelEvent } from "./api.ts";
import { Scene, PosStore, el, place } from "./scene.ts";
import { layoutGraph, renderGraph } from "./graph.ts";
import { renderField } from "./field.ts";
import { renderFlow, type FlowTarget } from "./flow.ts";
import { Inspector } from "./inspector.ts";

const stage = document.getElementById("stage")!;
const world = document.getElementById("world")!;
const scene = new Scene(stage, world);
const inspector = new Inspector();

const graphZone = el("section", "zone");
graphZone.id = "zone-graph";
graphZone.appendChild(el("div", "zone-label", "HISTORY"));
const flowZone = el("section", "zone");
flowZone.appendChild(el("div", "zone-label", "CHANGES"));
const fieldZone = el("section", "zone");
fieldZone.appendChild(el("div", "zone-label", "OBJECTS ON DISK"));
world.append(graphZone, flowZone, fieldZone);

let posStore = new PosStore("boot");
let fitDone = false;

function render(model: RepoModel, events: ModelEvent[]): void {
  const graphFlash = new Set<string>();
  for (const e of events) if (e.e === "commit-add") graphFlash.add(e.sha);

  // graph
  const layout = model.commits.length
    ? layoutGraph(model.commits)
    : { nodes: new Map(), order: [], edges: [], ghosts: new Set<string>(), lanes: 1, rows: 0 };
  const graph = renderGraph(graphZone, layout, model, posStore, scene, graphFlash, (sha) => void inspector.openObject(sha));

  // flow
  const flowFlash = new Set<string>();
  for (const e of events) {
    if (e.e === "index") for (const p of [...e.added, ...e.modified, ...e.removed]) { flowFlash.add(`index/${p}`); flowFlash.add(`worktree/${p}`); }
  }
  const flow = renderFlow(flowZone, model, flowFlash, (target) => void inspector.openChip(target));

  // field
  const fieldFlash = new Set<string>();
  for (const e of events) if (e.e === "object-add" || e.e === "object-del") fieldFlash.add(e.sha);
  const field = renderField(fieldZone, model, posStore, scene, fieldFlash, (sha) => void inspector.openObject(sha));

  // zones: graph top-left, flow to its right, field below both
  const gap = 64;
  const flowX = graph.width + gap;
  place(flowZone, flowX, 0);
  flowZone.style.width = `${flow.width}px`;
  flowZone.style.height = `${flow.height}px`;

  place(graphZone, 0, 0);
  graphZone.style.width = `${graph.width}px`;
  graphZone.style.height = `${graph.height}px`;

  const fieldY = Math.max(graph.height, flow.height) + gap;
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
  head.textContent = `${branch}${model.head.sha ? "@" + model.head.sha.slice(0, 7) : ""}${dirty ? ` · ${dirty} changed` : ""} · ${model.counts.objectsTotal} objects`;
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

// zoom buttons
document.getElementById("zoom-in")!.addEventListener("click", () => scene.zoomTo(scene.scale * 1.25, stage.clientWidth / 2, stage.clientHeight / 2));
document.getElementById("zoom-out")!.addEventListener("click", () => scene.zoomTo(scene.scale / 1.25, stage.clientWidth / 2, stage.clientHeight / 2));
document.getElementById("zoom-fit")!.addEventListener("click", () => scene.fitTop(world.clientWidth || 1500));

void boot();

// debug/test handle (also handy in the console)
declare global {
  interface Window { __gitv?: { scene: Scene; world: HTMLElement; inspector: Inspector } }
}
window.__gitv = { scene, world, inspector };
