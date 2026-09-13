// Scene: pan/zoom of the world, node dragging, and shared DOM utilities.

export interface DragOffset {
  dx: number;
  dy: number;
}

/** Set an element's world position (and the --tf var used by animations). */
export function place(el: HTMLElement, x: number, y: number): void {
  const tf = `translate(${x}px, ${y}px)`;
  el.style.transform = tf;
  el.style.setProperty("--tf", tf);
}

export class PosStore {
  private data = new Map<string, DragOffset>();
  constructor(private repoPath: string) {
    try {
      const raw = localStorage.getItem(key(repoPath));
      if (raw) this.data = new Map(Object.entries(JSON.parse(raw) as Record<string, DragOffset>));
    } catch {
      /* fresh start */
    }
  }
  get(zone: string, node: string): DragOffset | undefined {
    return this.data.get(`${zone}/${node}`);
  }
  set(zone: string, node: string, off: DragOffset): void {
    if (off.dx === 0 && off.dy === 0) this.data.delete(`${zone}/${node}`);
    else this.data.set(`${zone}/${node}`, off);
    try {
      localStorage.setItem(key(this.repoPath), JSON.stringify(Object.fromEntries(this.data)));
    } catch {
      /* storage may be unavailable */
    }
  }
  clear(): void {
    this.data.clear();
    try {
      localStorage.removeItem(key(this.repoPath));
    } catch {
      /* ignore */
    }
  }
}

function key(repoPath: string): string {
  return `gitv.pos.${repoPath}`;
}

export class Scene {
  scale = 1;
  tx = 0;
  ty = 0;
  private stage: HTMLElement;
  private world: HTMLElement;
  onUserTransform: (() => void) | null = null;

  constructor(stage: HTMLElement, world: HTMLElement) {
    this.stage = stage;
    this.world = world;
    this.wire();
  }

  apply(): void {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
  }

  zoomTo(nextScale: number, cx: number, cy: number): void {
    const k = Math.min(2.5, Math.max(0.2, nextScale));
    if (k === this.scale) return;
    this.tx = cx - ((cx - this.tx) * k) / this.scale;
    this.ty = cy - ((cy - this.ty) * k) / this.scale;
    this.scale = k;
    this.apply();
  }

  /** Center the given world rect in the viewport at a comfortable scale. */
  fit(w: number, h: number): void {
    const vw = this.stage.clientWidth - 60;
    const vh = this.stage.clientHeight - 90;
    this.scale = Math.min(1.1, Math.max(0.2, Math.min(vw / w, vh / h)));
    this.tx = (this.stage.clientWidth - w * this.scale) / 2;
    this.ty = Math.max(46, (this.stage.clientHeight - h * this.scale) / 2 - 10);
    this.apply();
  }

  /** Fit the width but anchor the top of the world just under the HUD. */
  fitTop(w: number): void {
    const vw = this.stage.clientWidth - 70;
    this.scale = Math.min(1.05, Math.max(0.2, vw / w));
    this.tx = (this.stage.clientWidth - w * this.scale) / 2;
    this.ty = 58;
    this.apply();
  }

  private wire(): void {
    this.stage.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // pinch / ctrl+wheel zooms (canvas convention)
        const rect = this.stage.getBoundingClientRect();
        this.zoomTo(this.scale * Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        // plain wheel & trackpad scroll pan the sheet, like a document
        this.tx -= e.deltaX + (e.shiftKey ? e.deltaY : 0);
        this.ty -= e.shiftKey ? 0 : e.deltaY;
      }
      this.apply();
      this.onUserTransform?.();
    }, { passive: false });

    let panning = false;
    let sx = 0, sy = 0, stx = 0, sty = 0;
    this.stage.addEventListener("pointerdown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".commit-row, .obj-card, .chip, button, input, a, #inspector")) return;
      e.preventDefault();
      panning = true;
      sx = e.clientX; sy = e.clientY;
      stx = this.tx; sty = this.ty;
      this.stage.classList.add("panning");
      this.stage.setPointerCapture(e.pointerId);
    });
    this.stage.addEventListener("pointermove", (e) => {
      if (!panning) return;
      this.tx = stx + (e.clientX - sx);
      this.ty = sty + (e.clientY - sy);
      this.apply();
    });
    const endPan = (): void => {
      panning = false;
      this.stage.classList.remove("panning");
    };
    this.stage.addEventListener("pointerup", endPan);
    this.stage.addEventListener("pointercancel", endPan);
  }

  /** Make an element draggable in world coordinates; reports total offsets. */
  draggable(
    el: HTMLElement,
    opts: { onMove: (dx: number, dy: number) => void; onStart?: () => void; onEnd?: (dx: number, dy: number) => void },
  ): void {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      el.classList.add("dragging");
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointers cannot be captured; window listeners below still work */
      }
      let moved = false;
      const move = (ev: PointerEvent): void => {
        const dx = (ev.clientX - startX) / this.scale;
        const dy = (ev.clientY - startY) / this.scale;
        if (!moved && Math.abs(dx) * this.scale + Math.abs(dy) * this.scale < 3) return;
        moved = true;
        opts.onStart?.();
        opts.onMove(dx, dy);
      };
      const up = (ev: PointerEvent): void => {
        el.classList.remove("dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        const dx = (ev.clientX - startX) / this.scale;
        const dy = (ev.clientY - startY) / this.scale;
        if (moved) opts.onEnd?.(dx, dy);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }
}

/** Keyed DOM reconciliation with enter/leave animations. */
export function keyedSync<K>(
  existing: Map<K, HTMLElement>,
  container: HTMLElement,
  next: { key: K; make: () => HTMLElement; update: (el: HTMLElement) => void }[],
  flashKeys?: Set<K>,
): void {
  const seen = new Set<K>();
  for (const item of next) {
    seen.add(item.key);
    let el = existing.get(item.key);
    const isNew = !el;
    if (!el) {
      el = item.make();
      existing.set(item.key, el);
      el.classList.add("enter");
      el.addEventListener("animationend", () => el!.classList.remove("enter"), { once: true });
    }
    item.update(el!);
    if (isNew) container.appendChild(el!);
    if (flashKeys?.has(item.key) && !isNew) {
      el!.classList.add("flash");
      setTimeout(() => el!.classList.remove("flash"), 1900);
    }
  }
  for (const [k, el] of [...existing]) {
    if (seen.has(k)) continue;
    existing.delete(k);
    el.classList.remove("enter");
    el.classList.add("leave");
    setTimeout(() => el.remove(), 380);
  }
}

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Byte-value tapestry: every byte becomes a 3px cell colored by its class. */
export function drawTapestry(cv: HTMLCanvasElement, bytes: Uint8Array | number[], w: number, h: number): void {
  const scale = window.devicePixelRatio || 1;
  cv.width = w * scale;
  cv.height = h * scale;
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const ctx = cv.getContext("2d")!;
  ctx.scale(scale, scale);
  const cols = Math.max(24, Math.floor(w / 3));
  const rows = Math.max(8, Math.floor(h / 3));
  ctx.clearRect(0, 0, w, h);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= bytes.length) break;
      const b = bytes[i]!;
      ctx.fillStyle = byteColor(b);
      ctx.fillRect(c * 3, r * 3, 2.4, 2.4);
    }
  }
}

function byteColor(b: number): string {
  if (b === 0) return "#e8e8e0";
  if (b === 0x0a || b === 0x09 || b === 0x0d) return "#d4d4c8";
  if (b >= 0x20 && b < 0x7f) {
    const t = (b - 0x20) / 0x5f;
    return `rgba(33, 34, 39, ${0.22 + t * 0.55})`;
  }
  const hue = 200 + (b % 64) * 2.2;
  return `hsl(${hue} 62% 62%)`;
}
