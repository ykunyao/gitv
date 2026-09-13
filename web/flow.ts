// Status flow: worktree → index → HEAD. Every path appears exactly once,
// in the leftmost column where it differs from its neighbor. Chips are
// keyed by path in one shared layer, so `git add` / `git commit` make them
// *fly* between columns instead of vanishing and re-appearing.

import type { RepoModel, Change } from "./api.ts";
import { getTree, type TreeFlatEntry } from "./api.ts";
import { el, keyedSync, place } from "./scene.ts";

export interface FlowTarget {
  kind: "chip";
  column: "worktree" | "index" | "head";
  path: string;
  change?: Change;
  headSha?: string; // blob sha in HEAD tree, when present
  indexSha?: string; // blob sha in index
}

interface FlowState {
  column: "worktree" | "index" | "head";
  kind: string;
  display?: string; // rename label override
  change?: Change;
  headSha?: string;
  indexSha?: string;
}

interface FlowStore extends HTMLElement {
  __bg?: boolean;
  __chips?: Map<string, HTMLElement>;
  __layer?: HTMLElement;
  __relayout?: () => void;
}

const COL_W = 200;
const CHIP_H = 27;
const PAD = 18;
const COL_X = [PAD, PAD + COL_W + 40, PAD + 2 * (COL_W + 40)];

const headTreeCache = new Map<string, TreeFlatEntry[]>();
let lastHeadEntries: TreeFlatEntry[] | null = null; // for optimistic HEAD rendering
let lastHeadSha = "";
let stagedAtHeadMove: Change[] = []; // staged set captured when HEAD moved

export function renderFlow(
  zone: HTMLElement,
  model: RepoModel,
  flashKeys: Set<string>,
  relayout: () => void,
  onOpen: (target: FlowTarget) => void,
): { width: number; height: number } {
  const store = zone as FlowStore;
  store.__relayout = relayout;

  // static column backgrounds, arrows and the shared chip layer
  if (!store.__bg) {
    const mkCol = (label: string): HTMLElement => {
      const col = el("div", "flow-col");
      col.appendChild(el("div", "col-label", label));
      return col;
    };
    const cols = [mkCol("WORKTREE"), mkCol("INDEX"), mkCol("HEAD")];
    const layer = el("div", "chip-layer");
    for (let i = 0; i < 3; i++) {
      cols[i]!.style.left = `${COL_X[i]!}px`;
      cols[i]!.style.top = `${PAD}px`;
      cols[i]!.style.width = `${COL_W}px`;
    }
    const arrows = [arrow(false), arrow(false)];
    for (let i = 0; i < 2; i++) {
      arrows[i]!.style.left = `${COL_X[i]! + COL_W + 4}px`;
      arrows[i]!.style.top = `${PAD + 110}px`;
    }
    store.append(cols[0]!, arrows[0]!, cols[1]!, arrows[1]!, cols[2]!, layer);
    store.__bg = true;
    store.__chips = new Map();
    store.__layer = layer;
  }
  const layer = store.__layer!;
  const chips = store.__chips!;

  // which paths does HEAD contain? cached tree, or an optimistic synthesis
  const headTreeSha = model.commits.find((c) => c.sha === model.head.sha)?.tree;
  if (headTreeSha !== lastHeadSha) {
    stagedAtHeadMove = model.status.staged; // the changes this move carries
    lastHeadSha = headTreeSha ?? "";
  }
  let headEntries = headTreeSha ? headTreeCache.get(headTreeSha) : undefined;
  if (!headEntries) {
    headEntries = synthesizeHead(lastHeadEntries, stagedAtHeadMove, model) ?? undefined;
  } else {
    lastHeadEntries = headEntries;
  }
  if (headTreeSha && !headTreeCache.has(headTreeSha)) {
    void getTree(headTreeSha, 600).then((entries) => {
      headTreeCache.set(headTreeSha, entries);
      lastHeadEntries = entries;
      if (store.__relayout && layer.isConnected) store.__relayout();
    });
  }

  // ---- assign every path to exactly one column ------------------------------

  const files = new Map<string, FlowState>();

  for (const c of model.status.unstaged) {
    files.set(c.path, { column: "worktree", kind: c.kind, change: c, indexSha: c.sha });
  }
  for (const p of model.status.untracked) {
    if (!files.has(p)) files.set(p, { column: "worktree", kind: "untr" });
  }
  for (const c of model.status.staged) {
    if (files.has(c.path)) continue;
    files.set(c.path, {
      column: "index",
      kind: c.kind,
      display: c.origPath ? `${c.origPath} → ${c.path}` : undefined,
      change: c,
      indexSha: c.sha,
      headSha: c.kind === "del" ? undefined : c.sha,
    });
  }
  for (const e of (headEntries ?? []).filter((x) => x.kind === "blob")) {
    if (!files.has(e.path)) {
      files.set(e.path, { column: "head", kind: "clean", headSha: e.sha });
    }
  }

  // ---- layout: stack chips by path inside their column ----------------------

  const byCol: Record<string, { path: string; st: FlowState }[]> = { worktree: [], index: [], head: [] };
  for (const [path, st] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byCol[st.column]!.push({ path, st });
  }

  let contentH = 0;
  const positions = new Map<string, { x: number; y: number }>();
  for (const col of ["worktree", "index", "head"] as const) {
    byCol[col]!.forEach(({ path }, i) => {
      positions.set(path, { x: COL_X[getColumnIndex(col)]! + 10, y: PAD + 30 + i * CHIP_H });
    });
    contentH = Math.max(contentH, byCol[col]!.length * CHIP_H);
  }

  const bgHeight = Math.max(200, contentH + 42);
  const colOrder: ("worktree" | "index" | "head")[] = ["worktree", "index", "head"];
  zone.querySelectorAll<HTMLElement>(".flow-col").forEach((colBg, i) => {
    colBg.style.height = `${bgHeight - 2 * PAD}px`;
    colBg.classList.toggle("empty", byCol[colOrder[i]!]!.length === 0);
  });

  const items = [...files.entries()].map(([path, st]) => ({
    key: path,
    make: (): HTMLElement => makeChip(path, st, onOpen),
    update: (chip: HTMLElement): void => {
      const xy = positions.get(path)!;
      place(chip, xy.x, xy.y);
      chip.className = `chip ${st.kind}`;
      applyChipLabel(chip, path, st);
    },
  }));
  keyedSync(chips, layer, items, flashKeys);

  return { width: PAD * 2 + 3 * COL_W + 2 * 40, height: bgHeight + PAD };
}

function getColumnIndex(col: "worktree" | "index" | "head"): number {
  return col === "worktree" ? 0 : col === "index" ? 1 : 2;
}

function applyChipLabel(chip: HTMLElement, path: string, st: FlowState): void {
  const label = st.display ?? path;
  const dir = label.includes("/") ? label.slice(0, label.lastIndexOf("/") + 1) : "";
  const base = label.slice(dir.length);
  chip.replaceChildren(el("span", "dir", dir), document.createTextNode(base));
}

function makeChip(path: string, st: FlowState, onOpen: (t: FlowTarget) => void): HTMLElement {
  const chip = el("div", `chip ${st.kind}`);
  chip.dataset.key = path;
  applyChipLabel(chip, path, st);
  chip.addEventListener("click", () => {
    onOpen({ kind: "chip", column: st.column, path, change: st.change, headSha: st.headSha, indexSha: st.indexSha });
  });
  return chip;
}

/**
 * When the HEAD tree fetch is still in flight right after a commit, fake the
 * new HEAD listing from the previous one plus the staged changes captured at
 * the moment HEAD moved — chips fly into HEAD immediately instead of
 * blinking out of existence.
 */
function synthesizeHead(prev: TreeFlatEntry[] | null, staged: Change[], model: RepoModel): TreeFlatEntry[] | null {
  if (!prev) return null;
  const synth = new Map<string, TreeFlatEntry>();
  for (const e of prev) if (e.kind === "blob") synth.set(e.path, e);
  for (const c of staged) {
    if (c.kind === "del") synth.delete(c.path);
    else if (c.sha) synth.set(c.path, { path: c.path, sha: c.sha, kind: "blob", mode: "100644" });
  }
  for (const c of model.status.unstaged) {
    if (c.kind === "del") synth.delete(c.path);
  }
  return [...synth.values()];
}

function arrow(flip: boolean): HTMLElement {
  const a = el("div", "flow-arrow");
  a.innerHTML = `<svg width="30" height="10" viewBox="0 0 30 10"><path d="M0 5 H24 M20 1 L25 5 L20 9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" ${flip ? 'transform="scale(-1,1) translate(-30,0)"' : ""}/></svg>`;
  return a;
}
