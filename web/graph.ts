// Commit graph: lanes, curved edges, ref pills. Layout runs on the client
// from the commit list the scanner assembled.

import type { CommitInfo, RepoModel } from "./api.ts";
import { el, place, keyedSync, type PosStore, type Scene } from "./scene.ts";

export const PALETTE = ["#ff7a45", "#3da5f5", "#2fbf71", "#9d7bf5", "#f2b705", "#ff5c8a", "#00b5c3"];
export const LANE_W = 42;
export const ROW_H = 44;
const PAD = 22;

export interface GraphNode {
  sha: string;
  row: number;
  lane: number;
  color: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  color: string;
}

export interface GraphLayout {
  nodes: Map<string, GraphNode>;
  order: string[]; // shas in row order
  edges: GraphEdge[];
  ghosts: Set<string>; // commits whose parents are outside the visible set
  lanes: number;
  rows: number;
}

export function layoutGraph(commits: CommitInfo[]): GraphLayout {
  const present = new Set(commits.map((c) => c.sha));
  const bySha = new Map(commits.map((c) => [c.sha, c]));

  // --- rows: topological via Kahn (children before parents), newest first ---
  const indeg = new Map<string, number>();
  const parentEdges = new Map<string, string[]>();
  for (const c of commits) {
    const ps = c.parents.filter((p) => present.has(p));
    parentEdges.set(c.sha, ps);
    for (const p of ps) indeg.set(p, (indeg.get(p) ?? 0) + 1);
  }
  const ready = commits.filter((c) => !indeg.has(c.sha)).map((c) => c.sha);
  const rowOf = new Map<string, number>();
  let row = 0;
  while (ready.length) {
    ready.sort((a, b) => {
      const ca = bySha.get(a)!, cb = bySha.get(b)!;
      return cb.committer.when - ca.committer.when || (a < b ? -1 : 1);
    });
    const sha = ready.shift()!;
    rowOf.set(sha, row++);
    for (const p of parentEdges.get(sha) ?? []) {
      const left = (indeg.get(p) ?? 1) - 1;
      if (left === 0) {
        indeg.delete(p);
        ready.push(p);
      } else {
        indeg.set(p, left);
      }
    }
  }
  for (const c of commits) if (!rowOf.has(c.sha)) rowOf.set(c.sha, row++);

  const order = [...rowOf.entries()].sort((a, b) => a[1] - b[1]).map(([sha]) => sha);

  // --- lanes: gitgraph columns ---
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const ghosts = new Set<string>();
  const columns: { sha: string; color: number }[] = [];
  let nextColor = 0;

  for (const sha of order) {
    const c = bySha.get(sha)!;
    let lane = columns.findIndex((col) => col.sha === sha);
    let colorIdx: number;
    if (lane === -1) {
      columns.push({ sha, color: nextColor });
      colorIdx = nextColor++;
      lane = columns.length - 1;
    } else {
      colorIdx = columns[lane]!.color;
    }
    nodes.set(sha, { sha, row: rowOf.get(sha)!, lane, color: PALETTE[colorIdx % PALETTE.length]! });
    columns.splice(lane, 1);

    (parentEdges.get(sha) ?? []).forEach((p, i) => {
      const existing = columns.findIndex((col) => col.sha === p);
      if (existing !== -1) {
        edges.push({ from: sha, to: p, color: PALETTE[colorIdx % PALETTE.length]! });
        return;
      }
      const col = i === 0 ? { sha: p, color: colorIdx } : { sha: p, color: nextColor++ };
      columns.push(col);
      edges.push({ from: sha, to: p, color: PALETTE[col.color % PALETTE.length]! });
    });
    if (c.parents.some((p) => !present.has(p))) ghosts.add(sha);
  }

  return {
    nodes,
    order,
    edges,
    ghosts,
    lanes: Math.max(1, ...[...nodes.values()].map((n) => n.lane + 1)),
    rows: row,
  };
}

// ---- rendering ---------------------------------------------------------------

export interface GraphRefs {
  branches: string[];
  remotes: string[];
  tags: string[];
  isHead: boolean;
  headDetached: boolean;
}

export function refsByCommit(model: RepoModel): Map<string, GraphRefs> {
  const map = new Map<string, GraphRefs>();
  const ensure = (sha: string): GraphRefs => {
    let r = map.get(sha);
    if (!r) {
      r = { branches: [], remotes: [], tags: [], isHead: false, headDetached: false };
      map.set(sha, r);
    }
    return r;
  };
  for (const ref of model.refs) {
    const target = ref.kind === "tag" ? ref.peeled ?? ref.sha : ref.sha;
    if (!target) continue;
    const r = ensure(target);
    if (ref.kind === "branch") r.branches.push(ref.short);
    else if (ref.kind === "remote") r.remotes.push(ref.short);
    else if (ref.kind === "tag") r.tags.push(ref.short);
  }
  if (model.head.sha) {
    const r = ensure(model.head.sha);
    r.isHead = true;
    r.headDetached = model.head.detached;
  }
  return map;
}

export function graphWidth(layout: GraphLayout): number {
  return PAD * 2 + layout.lanes * LANE_W + 430;
}

export function renderGraph(
  zone: HTMLElement,
  layout: GraphLayout,
  model: RepoModel,
  pos: PosStore,
  scene: Scene,
  flashShas: Set<string>,
  onOpen: (sha: string) => void,
): { width: number; height: number } {
  const refMap = refsByCommit(model);
  const width = graphWidth(layout);
  const height = PAD * 2 + Math.max(1, layout.order.length) * ROW_H;

  let svg = zone.querySelector<SVGElement>(".edge-svg");
  if (!svg) {
    svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("edge-svg");
    zone.appendChild(svg);
  }

  const dotX = (sha: string): number => {
    const n = layout.nodes.get(sha)!;
    return PAD + n.lane * LANE_W + (pos.get("graph", sha)?.dx ?? 0);
  };
  const dotY = (sha: string): number => {
    const n = layout.nodes.get(sha)!;
    return PAD + n.row * ROW_H + ROW_H / 2 + (pos.get("graph", sha)?.dy ?? 0);
  };

  const drawEdges = (): void => {
    svg!.innerHTML = "";
    for (const edge of layout.edges) {
      const x1 = dotX(edge.from), y1 = dotY(edge.from);
      const x2 = dotX(edge.to), y2 = dotY(edge.to);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const midY = (y1 + y2) / 2;
      path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
      path.setAttribute("stroke", edge.color);
      path.setAttribute("opacity", "0.75");
      svg!.appendChild(path);
    }
    for (const sha of layout.ghosts) {
      if (!layout.nodes.has(sha)) continue;
      const x = dotX(sha), y = dotY(sha);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${x} ${y + 9} L ${x} ${y + 34}`);
      path.setAttribute("stroke", layout.nodes.get(sha)!.color);
      path.classList.add("ghost");
      svg!.appendChild(path);
    }
  };
  drawEdges();

  const existing = ((zone as GraphZoneStore).__nodes ??= new Map<string, HTMLElement>());

  const items = layout.order.map((sha) => {
    const n = layout.nodes.get(sha)!;
    const c = model.commits.find((x) => x.sha === sha)!;
    const refs = refMap.get(sha);
    return {
      key: sha,
      make: (): HTMLElement => {
        const row = el("div", "commit-row");
        const dot = el("span", "commit-dot");
        const subj = el("span", "subject");
        const shaEl = el("span", "sha", sha.slice(0, 7));
        row.append(dot, subj, shaEl);
        row.addEventListener("click", () => {
          if ((row as DragState).__dragged) return;
          onOpen(sha);
        });
        scene.draggable(row, {
          onStart: () => {
            row.classList.add("dragging");
            (row as DragState).__dragged = true;
            (row as DragState).__base = pos.get("graph", sha) ?? { dx: 0, dy: 0 };
          },
          onMove: (dx, dy) => {
            const base = (row as DragState).__base ?? { dx: 0, dy: 0 };
            place(row, PAD + n.lane * LANE_W + base.dx + dx, PAD + n.row * ROW_H + base.dy + dy);
          },
          onEnd: (dx, dy) => {
            row.classList.remove("dragging");
            const base = (row as DragState).__base ?? { dx: 0, dy: 0 };
            pos.set("graph", sha, { dx: base.dx + dx, dy: base.dy + dy });
            setTimeout(() => ((row as DragState).__dragged = false), 0);
            drawEdges();
          },
        });
        return row;
      },
      update: (row: HTMLElement): void => {
        const off = pos.get("graph", sha) ?? { dx: 0, dy: 0 };
        place(row, PAD + n.lane * LANE_W + off.dx, PAD + n.row * ROW_H + off.dy);
        row.classList.toggle("head-commit", refs?.isHead ?? false);
        const dot = row.querySelector<HTMLElement>(".commit-dot")!;
        dot.style.background = n.color;

        for (const p of [...row.querySelectorAll(".pill")]) p.remove();
        const subj = row.querySelector<HTMLElement>(".subject")!;
        const shaEl = row.querySelector<HTMLElement>(".sha")!;
        if (refs) {
          const pills: HTMLElement[] = [];
          if (refs.isHead) pills.push(el("span", "pill head", "HEAD"));
          for (const b of refs.branches) pills.push(el("span", "pill branch", b));
          for (const t of refs.tags) pills.push(el("span", "pill tag", t));
          for (const r of refs.remotes) pills.push(el("span", "pill remote", r));
          for (const p of pills) row.insertBefore(p, subj);
        }
        subj.textContent = c.subject || "(no message)";
        shaEl.textContent = sha.slice(0, 7);
      },
    };
  });

  keyedSync(existing, zone, items, flashShas);

  return { width, height };
}

interface DragState extends HTMLElement {
  __dragged?: boolean;
  __base?: { dx: number; dy: number };
}
interface GraphZoneStore extends HTMLElement {
  __nodes?: Map<string, HTMLElement>;
}
