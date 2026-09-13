// Status flow: worktree → index → HEAD, the three states a change passes
// through. Chips are colored by how they differ from their neighbor.

import type { RepoModel, Change } from "./api.ts";
import { getTree, type TreeFlatEntry } from "./api.ts";
import { el, keyedSync } from "./scene.ts";

export interface FlowTarget {
  kind: "chip";
  column: "worktree" | "index" | "head";
  path: string;
  change?: Change;
  headSha?: string; // blob sha in HEAD tree, when present
  indexSha?: string; // blob sha in index
}

interface FlowStore extends HTMLElement {
  __wrap?: HTMLElement;
  __cols?: Record<"worktree" | "index" | "head", { el: HTMLElement; map: Map<string, HTMLElement> }>;
}

const headTreeCache = new Map<string, TreeFlatEntry[]>();

export function renderFlow(
  zone: HTMLElement,
  model: RepoModel,
  flashKeys: Set<string>,
  onOpen: (target: FlowTarget) => void,
): { width: number; height: number } {
  const store = zone as FlowStore;
  if (!store.__wrap) {
    const wrap = el("div", "flow-wrap");
    const mk = (label: string): { el: HTMLElement; map: Map<string, HTMLElement> } => {
      const col = el("div", "flow-col");
      col.appendChild(el("div", "col-label", label));
      const map = new Map<string, HTMLElement>();
      return { el: col, map };
    };
    const worktree = mk("WORKTREE");
    const index = mk("INDEX");
    const head = mk("HEAD");
    wrap.append(worktree.el, arrow(false), index.el, arrow(false), head.el);
    zone.appendChild(wrap);
    store.__wrap = wrap;
    store.__cols = { worktree, index, head };
  }
  const wrap = store.__wrap;
  const { worktree, index, head } = store.__cols!;

  const headTreeSha = model.commits.find((c) => c.sha === model.head.sha)?.tree;
  let headPaths = headTreeSha ? headTreeCache.get(headTreeSha) : undefined;
  if (headTreeSha && !headPaths) {
    void getTree(headTreeSha).then((entries) => {
      headTreeCache.set(headTreeSha, entries);
      // the tree listing arrives late; paint it into the HEAD column directly
      if (wrap.isConnected && zoneContains(zone, wrap)) {
        headPaths = entries;
        const items = entries.filter((e) => e.kind === "blob").slice(0, 260)
          .map((e) => chipItem(e.path, "clean", undefined, "head", onOpen, e.sha));
        keyedSync(head.map, head.el, items, new Set());
        head.el.classList.toggle("empty", !items.length);
      }
    });
  }

  // WORKTREE: unstaged changes + untracked
  const wItems = [
    ...model.status.unstaged.map((c) => chipItem(c.path, c.kind, c, "worktree", onOpen)),
    ...model.status.untracked.slice(0, 120).map((p) => chipItem(p, "untr", undefined, "worktree", onOpen)),
  ];
  worktree.el.classList.toggle("empty", !wItems.length);
  keyedSync(worktree.map, worktree.el, wItems, flashKeys);

  // INDEX: staged changes
  const iItems = model.status.staged.map((c) => chipItem(c.origPath ? `${c.origPath} → ${c.path}` : c.path, c.kind, c, "index", onOpen));
  index.el.classList.toggle("empty", !iItems.length);
  keyedSync(index.map, index.el, iItems, flashKeys);

  // HEAD: committed files, capped
  const files = (headPaths ?? []).filter((e) => e.kind === "blob");
  const hItems = files.slice(0, 260).map((e) => chipItem(e.path, "clean", undefined, "head", onOpen, e.sha));
  head.el.classList.toggle("empty", !hItems.length);
  keyedSync(head.map, head.el, hItems, flashKeys);

  const rows = Math.max(files.length, iItems.length, wItems.length, 6);
  return { width: 3 * 210 + 2 * 40 + 36, height: Math.min(rows, 260) * 26 + 60 };
}

function zoneContains(zone: HTMLElement, node: HTMLElement): boolean {
  return zone.contains(node);
}

function arrow(flip: boolean): HTMLElement {
  const a = el("div", "flow-arrow");
  a.innerHTML = `<svg width="30" height="10" viewBox="0 0 30 10"><path d="M0 5 H24 M20 1 L25 5 L20 9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" ${flip ? 'transform="scale(-1,1) translate(-30,0)"' : ""}/></svg>`;
  return a;
}

function chipItem(
  path: string,
  kind: string,
  change: Change | undefined,
  column: "worktree" | "index" | "head",
  onOpen: (t: FlowTarget) => void,
  headSha?: string,
): { key: string; make: () => HTMLElement; update: (el: HTMLElement) => void } {
  const key = `${column}/${path}`;
  return {
    key,
    make: (): HTMLElement => {
      const chip = el("div", `chip ${kind}`);
      chip.addEventListener("click", () => {
        onOpen({ kind: "chip", column, path, change, headSha, indexSha: change?.sha });
      });
      return chip;
    },
    update: (chip: HTMLElement): void => {
      chip.className = `chip ${kind}`;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
      const base = path.slice(dir.length);
      chip.replaceChildren(el("span", "dir", dir), document.createTextNode(base));
    },
  };
}
