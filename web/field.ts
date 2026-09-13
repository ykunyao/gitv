// Object field: every object in the database, grouped by type, sized by
// content, draggable. Loose objects read as clean cards; packed objects
// carry a dashed border and a darker fill.

import type { RepoModel, ObjSummary, ObjectDetail } from "./api.ts";
import { getObjectDetail, rawUrl } from "./api.ts";
import { el, place, keyedSync, fmtBytes, drawTapestry, type PosStore, type Scene } from "./scene.ts";

const GROUPS: { type: ObjSummary["type"]; name: string; color: string }[] = [
  { type: "commit", name: "COMMITS", color: "var(--commit)" },
  { type: "tag", name: "TAGS", color: "var(--tag)" },
  { type: "tree", name: "TREES", color: "var(--tree)" },
  { type: "blob", name: "BLOBS", color: "var(--blob)" },
];

const GAP = 14;
const PAD = 20;
// The field is a DOM scene; beyond a few hundred cards it degrades pan/zoom.
// Loose objects always make the cut (they are the live ones), then the
// biggest named/largest packed objects. Counts show the true totals.
const GROUP_CAPS: Record<string, number> = { commit: 240, tag: 60, tree: 220, blob: 280 };

interface CardSpec {
  w: number;
  h: number;
  preview: "text" | "tapestry" | "image" | "none";
}

function cardSpec(type: string, size: number, namedAs?: string): CardSpec {
  if (type === "commit") return { w: 220, h: 36, preview: "none" };
  if (type === "tag") return { w: 150, h: 36, preview: "none" };
  if (type === "tree") return { w: 132, h: 64, preview: "none" };
  if (namedAs && /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(namedAs)) return { w: 172, h: 158, preview: "image" };
  if (size <= 1536) return { w: 168, h: 104, preview: "text" };
  if (size <= 49152) return { w: 212, h: 122, preview: "text" };
  return { w: 212, h: 112, preview: "tapestry" };
}

interface CardState extends HTMLElement {
  __xy?: { x: number; y: number };
  __dragged?: boolean;
  __base?: { dx: number; dy: number };
  __previewLoaded?: boolean;
}

interface GroupState {
  groupEl: HTMLElement;
  container: HTMLElement;
  cards: Map<string, HTMLElement>;
}

interface FieldStore extends HTMLElement {
  __groups?: Map<string, GroupState>;
  __pad?: HTMLElement;
}

export function renderField(
  zone: HTMLElement,
  model: RepoModel,
  pos: PosStore,
  scene: Scene,
  flashShas: Set<string>,
  selectedSha: string | null,
  onOpen: (sha: string) => void,
): { width: number; height: number } {
  const width = 1280;
  const innerW = width - PAD * 2;

  const store = zone as FieldStore;
  if (!store.__pad) {
    store.__pad = el("div", "field-pad");
    zone.appendChild(store.__pad);
  }
  const pad = store.__pad;
  if (!store.__groups) {
    store.__groups = new Map();
    for (const g of GROUPS) {
      const groupEl = el("div", "obj-group");
      const label = el("div", "group-label");
      const swatch = el("span", "swatch");
      swatch.style.background = g.color;
      label.append(swatch, el("span", "name", g.name), el("span", "count", "0"));
      const container = el("div", "obj-canvas");
      groupEl.append(label, container);
      pad.appendChild(groupEl);
      store.__groups.set(g.type, { groupEl, container, cards: new Map() });
    }
  }

  const byName = nameMap(model);
  let totalH = PAD;

  for (const g of GROUPS) {
    const state = store.__groups.get(g.type)!;
    const all = model.objects.filter((o) => o.type === g.type);
    const cap = GROUP_CAPS[g.type] ?? 200;
    let objects = all;
    if (all.length > cap) {
      const loose = all.filter((o) => o.where.kind === "loose");
      const rest = all.filter((o) => o.where.kind === "pack");
      const namedFirst = [...rest].sort((a, b) => {
        const na = byName.has(a.sha) ? 1 : 0, nb = byName.has(b.sha) ? 1 : 0;
        if (na !== nb) return nb - na;
        return b.size - a.size;
      });
      objects = [...loose, ...namedFirst].slice(0, cap);
    }
    const shown = state.groupEl.querySelector<HTMLElement>(".count")!;
    shown.textContent = all.length > objects.length ? `${objects.length} of ${all.length}` : String(all.length);

    // greedy row wrapping, largest first for blobs/trees
    const specs = new Map<string, CardSpec>();
    const positions = new Map<string, { x: number; y: number }>();
    let x = 0, y = 0, rowH = 0;
    for (const o of objects) {
      const spec = cardSpec(o.type, o.size, byName.get(o.sha));
      specs.set(o.sha, spec);
      if (x > 0 && x + spec.w > innerW) {
        x = 0;
        y += rowH + GAP;
        rowH = 0;
      }
      positions.set(o.sha, { x, y });
      x += spec.w + GAP;
      rowH = Math.max(rowH, spec.h);
    }

    const items = objects.map((o) => {
      const spec = specs.get(o.sha)!;
      return {
        key: o.sha,
        make: (): HTMLElement => makeCard(o, spec, g, byName, pos, scene, onOpen),
        update: (card: HTMLElement): void => {
          const c = card as CardState;
          c.__xy = positions.get(o.sha)!;
          const off = pos.get("field", o.sha) ?? { dx: 0, dy: 0 };
          place(card, c.__xy.x + off.dx, c.__xy.y + off.dy);
          card.classList.toggle("packed", o.where.kind === "pack");
          card.classList.toggle("selected", o.sha === selectedSha);
          if (!c.__previewLoaded && spec.preview !== "none") {
            c.__previewLoaded = true;
            void queuePreview(o.sha, spec, card);
          }
        },
      };
    });
    keyedSync(state.cards, state.container, items, flashShas);

    // "+N" ghost marks the hidden remainder of a capped group
    state.container.querySelector(".ghost-card")?.remove();
    const hidden = all.length - objects.length;
    if (hidden > 0) {
      if (x > 0 && x + 110 > innerW) { x = 0; y += rowH + GAP; rowH = 0; }
      const ghost = el("div", "obj-card ghost-card", `+${hidden}`);
      place(ghost, x, y);
      state.container.appendChild(ghost);
      rowH = Math.max(rowH, 36);
    }

    const gh = Math.max(36, y + rowH);
    state.container.style.height = `${gh}px`;
    totalH += gh + 66;
  }

  return { width, height: totalH };
}

function makeCard(
  o: ObjSummary,
  spec: CardSpec,
  g: { type: string; color: string },
  byName: Map<string, string>,
  pos: PosStore,
  scene: Scene,
  onOpen: (sha: string) => void,
): HTMLElement {
  const card = el("div", `obj-card ${o.type}-card`) as CardState;
  card.dataset.sha = o.sha;
  card.style.width = `${spec.w}px`;
  card.style.height = `${spec.h}px`;

  const head = el("div", "card-head");
  const dot = el("span", "type-dot");
  dot.style.background = g.color;
  const label = el("span", "label");
  head.append(dot, label);
  card.appendChild(head);

  if (spec.preview === "text") {
    card.appendChild(el("div", "card-preview", "…"));
  } else if (spec.preview === "tapestry") {
    const cv = document.createElement("canvas");
    cv.className = "tapestry";
    cv.style.margin = "6px 10px";
    card.appendChild(cv);
  }

  const tag = el("div", "card-tag");
  tag.append(el("span", "size", fmtBytes(o.size)));
  if (o.delta) tag.append(el("span", "delta-mark", "Δ"));
  if (o.type === "blob" && byName.has(o.sha)) tag.append(el("span", "", o.sha.slice(0, 7)));
  card.appendChild(tag);

  const name = byName.get(o.sha);
  label.textContent = name ? (name.split("/").pop() ?? name) : o.sha.slice(0, 7);

  card.addEventListener("click", () => {
    if (card.__dragged) return;
    onOpen(o.sha);
  });

  scene.draggable(card, {
    onStart: () => {
      card.classList.add("dragging");
      card.__dragged = true;
      card.__base = pos.get("field", o.sha) ?? { dx: 0, dy: 0 };
    },
    onMove: (dx, dy) => {
      const xy = card.__xy ?? { x: 0, y: 0 };
      const base = card.__base ?? { dx: 0, dy: 0 };
      place(card, xy.x + base.dx + dx, xy.y + base.dy + dy);
    },
    onEnd: (dx, dy) => {
      card.classList.remove("dragging");
      const base = card.__base ?? { dx: 0, dy: 0 };
      pos.set("field", o.sha, { dx: base.dx + dx, dy: base.dy + dy });
      setTimeout(() => (card.__dragged = false), 0);
    },
  });

  return card;
}

// ---- async previews -----------------------------------------------------------

const previewCache = new Map<string, ObjectDetail>();
const previewJobs: { sha: string; spec: CardSpec; card: HTMLElement }[] = [];
let previewsRunning = false;

async function queuePreview(sha: string, spec: CardSpec, card: HTMLElement): Promise<void> {
  const cached = previewCache.get(sha);
  if (cached) {
    fillPreview(cached, spec, card);
    return;
  }
  previewJobs.push({ sha, spec, card });
  kickPreviews();
}

function kickPreviews(): void {
  if (previewsRunning) return;
  previewsRunning = true;
  void (async () => {
    while (previewJobs.length) {
      const job = previewJobs.shift()!;
      try {
        let detail = previewCache.get(job.sha);
        if (!detail) {
          detail = await getObjectDetail(job.sha);
          previewCache.set(job.sha, detail);
        }
        if (job.card.isConnected) fillPreview(detail, job.spec, job.card);
      } catch {
        /* preview is best-effort */
      }
    }
    previewsRunning = false;
  })();
}

const IMAGE_MAGIC = (b: number[]): boolean =>
  b.length > 8 &&
  ((b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) ||
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) ||
    (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57));

function fillPreview(detail: ObjectDetail, spec: CardSpec, card: HTMLElement): void {
  const bytes = detail.contentHead;
  const previewEl = card.querySelector<HTMLElement>(".card-preview");

  // images render themselves regardless of the planned preview kind
  if (IMAGE_MAGIC(bytes)) {
    previewEl?.remove();
    if (!card.querySelector("img.thumb")) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = rawUrl(detail.sha);
      img.alt = "";
      card.appendChild(img);
    }
    return;
  }
  if (spec.preview === "tapestry") {
    const cv = card.querySelector<HTMLCanvasElement>("canvas.tapestry");
    if (cv) drawTapestry(cv, bytes, spec.w - 20, spec.h - 52);
    return;
  }
  if (spec.preview === "text" && previewEl) {
    if (bytes.slice(0, 8192).includes(0)) {
      previewEl.classList.add("tapestry-host");
      const cv = document.createElement("canvas");
      cv.className = "tapestry-in-preview";
      previewEl.replaceChildren(cv);
      drawTapestry(cv, bytes, spec.w - 20, Math.max(40, previewEl.clientHeight || spec.h - 50));
      return;
    }
    const text = new TextDecoder().decode(new Uint8Array(bytes));
    const avail = previewEl.clientHeight || spec.h - 50;
    const lines = text.replace(/\n$/, "").split("\n").slice(0, Math.max(2, Math.floor(avail / 14)));
    previewEl.replaceChildren(...lines.map((l) => el("span", "ln", l.slice(0, Math.floor(spec.w / 5.9)) || " ")));
  }
}

/** path → blob sha, from index and staged changes (for friendly labels). */
function nameMap(model: RepoModel): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of model.index.entries) if (!m.has(e.sha)) m.set(e.sha, e.path);
  for (const s of model.status.staged) if (s.sha && !m.has(s.sha)) m.set(s.sha, s.path);
  for (const s of model.status.unstaged) if (s.kind !== "del" && s.worktreeSha && !m.has(s.worktreeSha)) m.set(s.worktreeSha, s.path);
  return m;
}
