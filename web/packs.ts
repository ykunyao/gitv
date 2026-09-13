// Packfile view: the pack as it lies on disk — one block per object at its
// real byte offset, sized by compressed size, colored by type, with arcs
// linking every delta to its base. Hovering a block lights up its whole
// delta family; clicking opens the object.

import type { RepoModel } from "./api.ts";
import { el, fmtBytes } from "./scene.ts";

const TYPE_COLORS: Record<string, [number, number, number]> = {
  commit: [255, 122, 69],
  tree: [61, 165, 245],
  blob: [47, 191, 113],
  tag: [157, 123, 245],
};
const UNKNOWN: [number, number, number] = [170, 170, 165];

const STRIP_H = 44;
const ARC_H = 46;
const GAP = 8;

interface PackBlock {
  s: string;
  o: number;
  c: number;
  t: string | null;
  d: 0 | 1;
  b?: number;
}

interface PackData {
  name: string;
  sizeBytes: number;
  count: number;
  deltas: number;
  byType: Partial<Record<string, number>>;
  unpackedTotal: number;
  truncated: boolean;
  blocks: PackBlock[];
}

interface PackView {
  name: string;
  data: PackData | null;
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  caption: HTMLElement;
  width: number;
  family: Set<PackBlock> | null;
}

interface PacksStore extends HTMLElement {
  __views?: Map<string, PackView>;
  __pad?: HTMLElement;
  __width?: number;
}

const cache = new Map<string, Promise<PackData>>();

function packData(name: string): Promise<PackData> {
  let p = cache.get(name);
  if (!p) {
    p = fetch(`/api/pack/${name}`).then((r) => r.json()).then((d: PackData) => {
      d.blocks.sort((a, b) => a.o - b.o); // server sorts too; belt and braces
      return d;
    });
    cache.set(name, p);
    p.catch(() => cache.delete(name));
  }
  return p;
}

export function invalidatePacks(): void {
  cache.clear();
}

export function renderPacks(
  zone: HTMLElement,
  model: RepoModel,
  onOpen: (sha: string) => void,
): { width: number; height: number } {
  const width = 1240;
  const store = zone as PacksStore;
  if (!store.__pad) {
    store.__pad = el("div", "field-pad");
    zone.appendChild(store.__pad);
  }
  const pad = store.__pad;
  if (store.__width !== width) {
    store.__width = width;
    pad.replaceChildren();
    store.__views = new Map();
  }
  if (!store.__views) store.__views = new Map();
  const views = store.__views;

  let totalH = 10;

  for (const pack of model.packs) {
    // a gc rewrites the pack under the same name only if content identical —
    // size change means new file, so drop any cached view of it
    const cached = cache.get(pack.name);
    if (cached) {
      void cached.then((d) => {
        if (d.sizeBytes !== pack.sizeBytes) {
          cache.delete(pack.name);
          views.delete(pack.name);
          const v = store.__views!.get(pack.name);
          if (v) {
            v.canvas.remove();
            v.overlay.remove();
            v.caption.remove();
            store.__views!.delete(pack.name);
          }
        }
      });
    }
    let view = views.get(pack.name);
    if (!view) {
      const section = el("div", "pack-section");
      const canvas = document.createElement("canvas");
      canvas.className = "pack-canvas";
      const overlay = document.createElement("canvas");
      overlay.className = "pack-overlay";
      const cap = el("div", "pack-caption");
      cap.textContent = "loading…";
      const holder = el("div", "pack-holder");
      holder.append(canvas, overlay);
      section.append(holder, cap);
      pad.appendChild(section);
      view = { name: pack.name, data: null, canvas, overlay, caption: cap, width, family: null };
      views.set(pack.name, view);
      bindPointer(view, onOpen);
      void packData(pack.name).then((data) => {
        view!.data = data;
        drawBase(view!);
        captionDefault(view!);
      });
    }
    // sizing + device pixel ratio — only touch the canvas when needed,
    // because assigning width/height wipes the painted content
    const h = ARC_H + GAP + STRIP_H + 2;
    const dpr = window.devicePixelRatio || 1;
    const wantW = Math.round(width * dpr);
    const wantH = Math.round(h * dpr);
    if (view.canvas.width !== wantW || view.canvas.height !== wantH) {
      for (const cv of [view.canvas, view.overlay]) {
        cv.width = wantW;
        cv.height = wantH;
        cv.style.width = `${width}px`;
        cv.style.height = `${h}px`;
      }
    }
    view.canvas.style.display = view.data ? "block" : "none";
    view.overlay.style.display = view.data ? "block" : "none";
    if (view.data) {
      drawBase(view);
      captionDefault(view);
      if (view.family) drawOverlay(view);
    }
    totalH += h + 56;
  }

  // drop views of packs that no longer exist
  const names = new Set(model.packs.map((p) => p.name));
  for (const [name, view] of [...views]) {
    if (!names.has(name)) {
      view.canvas.remove();
      view.overlay.remove();
      view.caption.remove();
      views.delete(name);
    }
  }

  return { width, height: totalH };
}

function captionDefault(view: PackView): void {
  const d = view.data!;
  const ratio = d.unpackedTotal > 0 ? (d.unpackedTotal / Math.max(1, d.sizeBytes - 32)).toFixed(1) : "?";
  const typeBits = Object.entries(d.byType)
    .sort((a, b) => b[1]! - a[1]!)
    .map(([t, n]) => `${n} ${t}`)
    .join(" · ");
  view.caption.textContent =
    `${d.name.replace(/^pack-/, "").replace(/\.pack$/, "")} · ${fmtBytes(d.sizeBytes)} · ${d.count} objects (${typeBits})` +
    `${d.deltas ? ` · ${d.deltas} deltas` : ""} · ${ratio}× compression${d.truncated ? " · partially probed" : ""}`;
}

function blockX(view: PackView, b: PackBlock): number {
  const d = view.data!;
  return (b.o / d.sizeBytes) * view.width;
}
function blockW(view: PackView, b: PackBlock): number {
  const d = view.data!;
  return Math.max(1, (b.c / d.sizeBytes) * view.width);
}

function drawBase(view: PackView): void {
  const d = view.data!;
  const ctx = view.canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.canvas.height);
  const stripY = ARC_H + GAP;
  const byOffset = new Map<number, PackBlock>(d.blocks.map((b) => [b.o, b]));

  // delta arcs above the strip
  ctx.lineWidth = 1;
  for (const b of d.blocks) {
    if (!b.b) continue;
    const base = byOffset.get(b.b);
    if (!base) continue;
    const x1 = blockX(view, b) + blockW(view, b) / 2;
    const x2 = blockX(view, base) + blockW(view, base) / 2;
    if (Math.abs(x1 - x2) < 2) continue;
    const mid = (x1 + x2) / 2;
    const c = TYPE_COLORS[b.t ?? ""] ?? UNKNOWN;
    ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.16)`;
    ctx.beginPath();
    ctx.moveTo(x1, stripY - 2);
    ctx.quadraticCurveTo(mid, stripY - ARC_H * 0.9, x2, stripY - 2);
    ctx.stroke();
  }

  // object blocks
  for (const b of d.blocks) {
    const c = TYPE_COLORS[b.t ?? ""] ?? UNKNOWN;
    ctx.fillStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.9)`;
    ctx.fillRect(blockX(view, b), stripY, Math.max(1, blockW(view, b) - 0.5), STRIP_H);
  }
}

/** Which block sits under this x coordinate (blocks are sorted by offset). */
function blockAt(view: PackView, x: number): PackBlock | null {
  const d = view.data!;
  let lo = 0, hi = d.blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = d.blocks[mid]!;
    const x0 = blockX(view, b), x1 = x0 + Math.max(1, blockW(view, b));
    if (x >= x0 && x <= x1) return b;
    if (x < x0) hi = mid - 1;
    else lo = mid + 1;
  }
  return null;
}

function familyOf(d: PackData, b: PackBlock): Set<PackBlock> {
  const byOffset = new Map<number, PackBlock>(d.blocks.map((x) => [x.o, x]));
  const family = new Set<PackBlock>([b]);
  // walk up to the base
  let cur = b;
  for (let depth = 0; depth < 128 && cur.b; depth++) {
    const base = byOffset.get(cur.b);
    if (!base || family.has(base)) break;
    family.add(base);
    cur = base;
  }
  // walk down to every delta that hangs off the family
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of d.blocks) {
      if (x.b && !family.has(x)) {
        const base = byOffset.get(x.b);
        if (base && family.has(base)) {
          family.add(x);
          grew = true;
        }
      }
    }
  }
  return family;
}

function drawOverlay(view: PackView): void {
  const d = view.data!;
  const family = view.family;
  const ctx = view.overlay.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, view.width, view.overlay.height);
  if (!family || family.size === 0) return;
  const stripY = ARC_H + GAP;
  const byOffset = new Map<number, PackBlock>(d.blocks.map((b) => [b.o, b]));

  // dim everything else
  for (const b of d.blocks) {
    if (family.has(b)) continue;
    ctx.fillStyle = "rgba(246, 246, 241, 0.82)";
    ctx.fillRect(blockX(view, b) - 0.5, stripY - 1, Math.max(1, blockW(view, b) + 1), STRIP_H + 2);
  }
  // arcs inside the family
  ctx.lineWidth = 1.6;
  for (const b of family) {
    if (!b.b) continue;
    const base = byOffset.get(b.b);
    if (!base || !family.has(base)) continue;
    const x1 = blockX(view, b) + blockW(view, b) / 2;
    const x2 = blockX(view, base) + blockW(view, base) / 2;
    if (Math.abs(x1 - x2) < 2) continue;
    const mid = (x1 + x2) / 2;
    ctx.strokeStyle = "rgba(255, 122, 69, 0.75)";
    ctx.beginPath();
    ctx.moveTo(x1, stripY - 2);
    ctx.quadraticCurveTo(mid, stripY - ARC_H * 0.9, x2, stripY - 2);
    ctx.stroke();
  }
  // outline the family blocks
  for (const b of family) {
    ctx.strokeStyle = "rgba(33, 34, 39, 0.85)";
    ctx.lineWidth = 1;
    ctx.strokeRect(blockX(view, b) - 1, stripY - 1, Math.max(1, blockW(view, b)) + 1.5, STRIP_H + 2);
  }
}

function bindPointer(view: PackView, onOpen: (sha: string) => void): void {
  const holder = view.canvas.parentElement!;
  holder.addEventListener("pointermove", (e) => {
    if (!view.data) return;
    const r = holder.getBoundingClientRect();
    const x = e.clientX - r.left;
    const b = blockAt(view, x);
    if (!b) {
      view.family = null;
      drawOverlay(view);
      captionDefault(view);
      return;
    }
    view.family = familyOf(view.data, b);
    drawOverlay(view);
    const depth = countDepth(view.data, b);
    const extra = b.d ? ` · Δ chain depth ${depth}` : "";
    view.caption.textContent = `${b.s.slice(0, 7)} · ${b.t ?? "?"} · ${fmtBytes(b.c)} on disk${extra} · click to inspect`;
  });
  holder.addEventListener("pointerleave", () => {
    view.family = null;
    drawOverlay(view);
    captionDefault(view);
  });
  holder.addEventListener("click", (e) => {
    if (!view.data) return;
    const r = holder.getBoundingClientRect();
    const x = e.clientX - r.left;
    const b = blockAt(view, x);
    if (b) onOpen(b.s);
  });
}

function countDepth(d: PackData, b: PackBlock): number {
  let depth = 0;
  let cur = b;
  while (cur.b && depth < 128) {
    const base = d.blocks.find((x) => x.o === cur.b!);
    if (!base) break;
    cur = base;
    depth++;
  }
  return depth;
}
