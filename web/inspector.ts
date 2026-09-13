// Inspector: the byte-by-byte story of an object, and content/diff views
// for files. Everything shown comes from what the parsers actually saw.
// Hovering a parsed field lights up the exact bytes it was read from.

import type { ObjectDetail, CommitParsed, TreeParsedEntry, TagParsed, DiffPayload, CommitDiff } from "./api.ts";
import { getObjectDetail, getTree, getDiff, getWorktreeFile, getCommitDiff, rawUrl } from "./api.ts";
import { el, fmtBytes, drawTapestry } from "./scene.ts";
import type { FlowTarget } from "./flow.ts";

const TYPE_COLORS: Record<string, string> = {
  commit: "var(--commit)",
  tree: "var(--tree)",
  blob: "var(--blob)",
  tag: "var(--tag)",
  gitlink: "var(--dim)",
};

export class Inspector {
  private panel: HTMLElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private glyph: HTMLElement;
  private currentToken = 0;
  /** sha of the object currently being inspected (drives scene selection). */
  currentSha: string | null = null;
  onChange: ((sha: string | null) => void) | null = null;

  constructor() {
    this.panel = document.getElementById("inspector")!;
    this.body = document.getElementById("inspector-body")!;
    this.title = document.getElementById("inspector-title")!;
    this.glyph = document.getElementById("inspector-glyph")!;
    document.getElementById("inspector-close")!.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("search")?.matches("[hidden]")) return; // search owns Esc first
      if (e.key === "Escape") this.close();
    });
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }

  close(): void {
    this.panel.hidden = true;
    this.currentToken++;
    this.currentSha = null;
    this.onChange?.(null);
  }

  private begin(title: string, type: string): number {
    const token = ++this.currentToken;
    this.reset(title, type);
    return token;
  }

  private reset(title: string, type: string): void {
    this.panel.hidden = false;
    this.title.textContent = title;
    this.glyph.style.background = TYPE_COLORS[type] ?? "var(--dim)";
    this.body.replaceChildren();
  }

  private stale(token: number): boolean {
    return token !== this.currentToken;
  }

  private add(node: HTMLElement): void {
    this.body.appendChild(node);
  }

  private stage(label: string): HTMLElement {
    const s = el("div", "stage");
    const l = el("div", "stage-label");
    l.append(el("span", "", label), el("span", "arrow", "↓"));
    s.appendChild(l);
    this.add(s);
    return s;
  }

  // ---- object mode -----------------------------------------------------------

  async openObject(sha: string, openFileDiff?: (sha: string, file: CommitDiff["files"][number]) => void): Promise<void> {
    const token = this.begin(sha.slice(0, 7) + " …", "blob");
    this.currentSha = sha;
    this.onChange?.(sha);
    let detail: ObjectDetail;
    try {
      detail = await getObjectDetail(sha);
    } catch (e) {
      if (this.stale(token)) return;
      this.add(el("div", "more-note", String(e)));
      return;
    }
    if (this.stale(token)) return;
    this.reset(detail.sha.slice(0, 12) + `  ·  ${detail.type}`, detail.type);

    // 1 — where the bytes live
    const srcStage = this.stage("ON DISK");
    const chip = el("div", "source-chip");
    const kind = el("span", `kind ${detail.where.kind === "pack" ? "packed" : ""}`, detail.where.kind === "pack" ? "PACK" : "LOOSE");
    const pathText = detail.where.kind === "loose" ? detail.where.file : `${detail.where.pack} @ ${detail.where.offset}`;
    chip.append(kind, el("span", "mono", pathText));
    srcStage.appendChild(chip);

    // 2 — delta chain, walked hop by hop inside the pack
    if (detail.deltaChain && detail.where.kind === "pack") {
      const dc = detail.deltaChain;
      const packName = detail.where.pack.replace(/^pack-/, "").replace(/\.pack$/, "");
      const dcStage = this.stage(`DELTA CHAIN · depth ${dc.depth} · pack ${packName.slice(0, 8)}`);
      const list = el("div", "dchain");
      dc.entries.forEach((e, i) => {
        const node = el("div", `dchain-node ${e.role}${e.sha ? " link" : ""}`);
        const dot = el("span", "kind-dot");
        dot.style.background = TYPE_COLORS[e.type] ?? "var(--dim)";
        const shaLabel = el("span", "dchain-sha", e.sha ? e.sha.slice(0, 7) : `@${e.offset}`);
        const type = el("span", "dchain-type", e.type);
        const size = el("span", "dchain-size", e.role === "base" ? fmtBytes(e.resultSize) : `Δ ${fmtBytes(e.deltaSize ?? 0)} → ${fmtBytes(e.resultSize)}`);
        node.append(dot, shaLabel, type, size);
        if (e.sha && e.sha !== detail.sha) node.addEventListener("click", () => this.openObject(e.sha!));
        list.appendChild(node);
        if (i < dc.entries.length - 1) list.appendChild(el("div", "dchain-arrow", "↓ stored as delta against"));
      });
      dcStage.appendChild(list);
    }

    // 3 — compressed bytes
    if (detail.compressedHead?.length) {
      const cStage = this.stage(detail.where.kind === "pack" ? "COMPRESSED (zlib, in pack)" : "COMPRESSED (zlib)");
      cStage.appendChild(hexdump(new Uint8Array(detail.compressedHead)).el);
    }

    // 3 — inflated: header + payload; field rows below steer its highlight
    const headBytes = new TextEncoder().encode(`${detail.type} ${detail.size}\0`);
    const contentHead = new Uint8Array(detail.contentHead);
    let shown = new Uint8Array(Math.min(headBytes.length + contentHead.length, headBytes.length + 192));
    shown.set(headBytes, 0);
    shown.set(contentHead.subarray(0, shown.length - headBytes.length), headBytes.length);
    const hex = hexdump(shown, 0, headBytes.length);
    const iStage = this.stage("INFLATED");
    iStage.appendChild(hex.el);
    const hoverField = (start: number | null, end: number | null): void => {
      if (start === null || end === null) {
        hex.set(0, headBytes.length);
        return;
      }
      // grow the window so the highlighted range is actually visible
      const need = headBytes.length + end + 16;
      if (need > shown.length) {
        shown = new Uint8Array(Math.min(need, headBytes.length + contentHead.length));
        shown.set(headBytes, 0);
        shown.set(contentHead.subarray(0, shown.length - headBytes.length), headBytes.length);
        hex.setBuffer(shown);
      }
      hex.set(headBytes.length + start, headBytes.length + end);
    };
    this.hexCtl = hoverField;

    // 4 — integrity
    if (detail.integrity) {
      const gStage = this.stage("INTEGRITY");
      const ok = detail.integrity.ok;
      gStage.appendChild(el("div", ok ? "check-ok" : "check-bad", ok ? `sha ✓  ${detail.sha.slice(0, 12)} — rehashing the bytes reproduces the name` : `sha ✗ expected ${detail.sha.slice(0, 12)}, got ${detail.integrity.computed.slice(0, 12)}`));
    }

    // 5 — parsed payload (rows steer the hexdump highlight)
    const pStage = this.stage("PARSED");
    if (detail.type === "commit") {
      pStage.appendChild(this.commitView(detail, hoverField));
    } else if (detail.type === "tree") {
      pStage.appendChild(this.treeView(detail, hoverField));
    } else if (detail.type === "tag") {
      pStage.appendChild(this.tagView(detail, hoverField));
    } else {
      pStage.appendChild(this.blobView(detail, token));
      this.hexCtl = null;
    }

    // 6 — what this commit changed vs its first parent
    if (detail.type === "commit") {
      const changeStage = this.stage("CHANGED · vs parent");
      changeStage.id = "changed-stage";
      try {
        const d = await getCommitDiff(sha);
        if (this.stale(token)) return;
        this.renderChangedFiles(changeStage, d, sha, openFileDiff);
      } catch {
        if (!this.stale(token)) changeStage.appendChild(el("div", "more-note", "unavailable"));
      }
    }
  }

  private hexCtl: ((start: number | null, end: number | null) => void) | null = null;

  private renderChangedFiles(stage: HTMLElement, d: CommitDiff, commitSha: string, openFileDiff?: (sha: string, file: CommitDiff["files"][number]) => void): void {
    if (!d.files.length) {
      stage.appendChild(el("div", "more-note", d.parent ? "tree identical to parent" : "root commit — first version of everything"));
      return;
    }
    const list = el("div", "cfile-list");
    for (const f of d.files) {
      const row = el("div", "cfile-row");
      const dot = el("span", "kind-dot");
      dot.style.background = f.kind === "add" ? "var(--add-ink)" : f.kind === "del" ? "var(--del-ink)" : "var(--mod-ink)";
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : "";
      row.append(dot, el("span", "dir", dir), document.createTextNode(f.path.slice(dir.length)), el("span", "cfile-kind", f.kind));
      row.addEventListener("click", () => openFileDiff?.(commitSha, f));
      if (openFileDiff) row.classList.add("link");
      list.appendChild(row);
    }
    stage.appendChild(list);
    if (d.files.length >= 300) stage.appendChild(el("div", "more-note", "…300+ files, list truncated"));
  }

  /** Inline view of one changed file inside the current commit inspector. */
  async showCommitFileDiff(commitSha: string, file: CommitDiff["files"][number], back: () => void): Promise<void> {
    const token = this.begin(`${file.path}  ·  ${file.kind}`, "blob");
    const bar = el("div", "cfile-back", "← back to commit");
    bar.addEventListener("click", back);
    this.add(bar);
    if (file.kind === "del" && file.aSha) {
      this.add(el("div", "more-note", "deleted in this commit — content below is the last version"));
      this.add(await this.blobContentEl(file.aSha, token));
      return;
    }
    if (!file.aSha || !file.bSha) {
      const only = file.bSha ?? file.aSha;
      if (only) this.add(await this.blobContentEl(only, token));
      return;
    }
    const d = await getDiff(file.aSha, file.bSha);
    if (this.stale(token)) return;
    if (d.binary || d.tooLarge || !d.ops) {
      this.add(el("div", "more-note", d.binary ? `binary · ${fmtBytes(d.aSize ?? 0)} → ${fmtBytes(d.bSize ?? 0)}` : d.error ?? "diff unavailable"));
      return;
    }
    this.add(diffView(d, file.aSha.slice(0, 7), file.bSha.slice(0, 7)));
  }

  private async blobContentEl(sha: string, token: number): Promise<HTMLElement> {
    try {
      const detail = await getObjectDetail(sha);
      if (this.stale(token)) return el("div");
      if (detail.contentHead.slice(0, 8192).includes(0)) {
        const cv = document.createElement("canvas");
        const wrap = el("div");
        wrap.appendChild(cv);
        drawTapestry(cv, detail.contentHead, 440, 200);
        return wrap;
      }
      const text = new TextDecoder().decode(new Uint8Array(detail.contentHead));
      const view = el("div", "content-view");
      view.appendChild(contentLines(text.replace(/\n$/, "").split("\n"), 0));
      return view;
    } catch {
      return el("div", "more-note", "content unavailable");
    }
  }

  // ---- parsed payload views (each row knows its bytes) ------------------------

  private commitView(detail: ObjectDetail, hover: (start: number | null, end: number | null) => void): HTMLElement {
    const p = detail.parsed as CommitParsed;
    const kv = el("div", "kv");

    const row = (k: string, value: HTMLElement | string, range?: { start: number; end: number }, link?: string): void => {
      const r = el("div", "kv-row");
      r.appendChild(el("span", "k", k));
      let v: HTMLElement;
      if (typeof value === "string") {
        v = el("span", link ? "v link" : "v", value);
        if (link) v.addEventListener("click", () => this.openObject(link));
      } else {
        v = value;
        v.classList.add("v");
      }
      r.appendChild(v);
      if (range) {
        r.addEventListener("mouseenter", () => hover(range.start, range.end));
        r.addEventListener("mouseleave", () => hover(null, null));
      }
      kv.appendChild(r);
    };

    let parentIdx = 0;
    for (const r of p.ranges) {
      if (r.key === "tree") row("tree", p.tree.slice(0, 12), r, p.tree);
      else if (r.key === "parent") {
        const i = parentIdx++;
        row(i === 0 ? "parent" : `parent ${i + 1}`, p.parents[i]?.slice(0, 12) ?? "", r, p.parents[i]);
      }
      else if (r.key === "author") row("author", `${p.author.name} <${p.author.email}> · ${p.author.tz}`, r);
      else if (r.key === "committer") row("committed", new Date(p.committer.when).toLocaleString(), r);
      else if (r.key === "message") row("message", p.message.trim() || "—", r);
    }
    return kv;
  }

  private treeView(detail: ObjectDetail, hover: (start: number | null, end: number | null) => void): HTMLElement {
    const entries = detail.parsed as TreeParsedEntry[];
    const wrap = el("div");
    const table = el("table", "tree-table");
    for (const e of entries.slice(0, 200)) {
      const tr = document.createElement("tr");
      const nm = el("td", "nm");
      const dot = el("span", "kind-dot");
      dot.style.background = TYPE_COLORS[e.kind] ?? "var(--dim)";
      nm.append(dot, document.createTextNode(e.name));
      nm.addEventListener("click", () => this.openObject(e.sha));
      const kind = el("td", "", e.kind === "gitlink" ? "submodule" : e.kind);
      const sha = el("td", "", e.sha.slice(0, 10));
      tr.append(nm, kind, sha);
      tr.addEventListener("mouseenter", () => hover(e.start, e.end));
      tr.addEventListener("mouseleave", () => hover(null, null));
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    if (entries.length > 200) wrap.appendChild(el("div", "more-note", `… ${entries.length - 200} more entries`));
    return wrap;
  }

  private tagView(detail: ObjectDetail, hover: (start: number | null, end: number | null) => void): HTMLElement {
    const p = detail.parsed as TagParsed;
    const kv = el("div", "kv");
    const row = (k: string, v: string, range?: { start: number; end: number }, link?: string): void => {
      const r = el("div", "kv-row");
      r.appendChild(el("span", "k", k));
      const s = el("span", link ? "v link" : "v", v);
      if (link) s.addEventListener("click", () => this.openObject(link));
      r.appendChild(s);
      if (range) {
        r.addEventListener("mouseenter", () => hover(range.start, range.end));
        r.addEventListener("mouseleave", () => hover(null, null));
      }
      kv.appendChild(r);
    };
    for (const r of p.ranges) {
      if (r.key === "object") row("object", p.object.slice(0, 12), r, p.object);
      else if (r.key === "type") row("type", p.type, r);
      else if (r.key === "tag") row("tag", p.tag, r);
      else if (r.key === "tagger") row("tagger", p.tagger ? `${p.tagger.name} <${p.tagger.email}>` : "—", r);
      else if (r.key === "message") row("message", p.message.trim() || "—", r);
    }
    return kv;
  }

  private blobView(detail: ObjectDetail, token: number): HTMLElement {
    const bytes = new Uint8Array(detail.contentHead);
    const binary = bytes.subarray(0, 8192).includes(0);
    const wrap = el("div");

    if (isImageBytes(bytes)) {
      const img = document.createElement("img");
      img.className = "full";
      img.src = rawUrl(detail.sha);
      wrap.appendChild(img);
      wrap.appendChild(el("div", "more-note", `${fmtBytes(detail.size)} — rendered from /api/raw`));
      return wrap;
    }

    if (binary) {
      const cv = document.createElement("canvas");
      cv.className = "tapestry";
      wrap.appendChild(cv);
      drawTapestry(cv, bytes, 440, 220);
      wrap.appendChild(el("div", "more-note", `binary · ${fmtBytes(detail.size)} · first ${bytes.length} bytes woven by value`));
      return wrap;
    }

    const text = new TextDecoder().decode(bytes);
    const lines = text.replace(/\n$/, "").split("\n");
    const view = el("div", "content-view");
    view.appendChild(contentLines(lines, 0));
    wrap.appendChild(view);
    if (detail.size > bytes.length) {
      wrap.appendChild(el("div", "more-note", `showing first ${bytes.length} of ${fmtBytes(detail.size)}`));
      const more = el("button", "", "load full content") as HTMLButtonElement;
      more.style.cssText = "margin-top:8px;border:1px solid var(--hair-strong);background:#fff;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:11px;";
      more.addEventListener("click", async () => {
        const r = await fetch(rawUrl(detail.sha));
        const full = new Uint8Array(await r.arrayBuffer());
        if (this.stale(token)) return;
        const fullText = new TextDecoder().decode(full);
        view.replaceChildren(contentLines(fullText.replace(/\n$/, "").split("\n"), 0));
        more.remove();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  // ---- file/chip mode ---------------------------------------------------------

  async openChip(target: FlowTarget): Promise<void> {
    const token = this.begin(target.path, "blob");
    this.currentSha = target.indexSha ?? target.headSha ?? null;
    this.onChange?.(this.currentSha);

    const sides = await this.resolveSides(target);
    if (this.stale(token)) return;
    this.reset(target.path, "blob");

    if (!sides) {
      this.add(el("div", "more-note", "content unavailable"));
      return;
    }

    const { a, b, aLabel, bLabel } = sides;

    if (a && b && !a.binary && !b.binary) {
      const tabs = el("div", "tabs");
      const diffBtn = el("button", "on", "DIFF");
      const aBtn = el("button", "", "OLD");
      const bBtn = el("button", "", "NEW");
      tabs.append(diffBtn, aBtn, bBtn);
      this.add(tabs);

      const holder = el("div");
      this.add(holder);

      const specOf = (s: Side): string => (s.fromWorktree ? `worktree:${s.path}` : s.sha);
      const d = await getDiff(specOf(a!), specOf(b!));
      if (this.stale(token)) return;
      const renderDiff = (): void => {
        diffBtn.classList.add("on"); aBtn.classList.remove("on"); bBtn.classList.remove("on");
        holder.replaceChildren();
        if (d.binary || d.tooLarge || d.error || !d.ops) {
          holder.appendChild(el("div", "more-note", d.binary ? `binary · ${fmtBytes(d.aSize ?? 0)} → ${fmtBytes(d.bSize ?? 0)}` : d.error ?? "diff unavailable"));
          return;
        }
        holder.appendChild(diffView(d, aLabel, bLabel));
      };
      const renderA = async (): Promise<void> => {
        aBtn.classList.add("on"); diffBtn.classList.remove("on"); bBtn.classList.remove("on");
        holder.replaceChildren();
        const text = a!.fromWorktree ? await decodeBase64((await getWorktreeFile(a!.path)).base64) : await fetchText(a!.sha);
        if (this.stale(token)) return;
        holder.appendChild(simpleContent(text, aLabel));
      };
      const renderB = async (): Promise<void> => {
        bBtn.classList.add("on"); diffBtn.classList.remove("on"); aBtn.classList.remove("on");
        holder.replaceChildren();
        const text = b!.fromWorktree ? await decodeBase64((await getWorktreeFile(b!.path)).base64) : await fetchText(b!.sha);
        if (this.stale(token)) return;
        holder.appendChild(simpleContent(text, bLabel));
      };
      diffBtn.addEventListener("click", renderDiff);
      aBtn.addEventListener("click", () => void renderA());
      bBtn.addEventListener("click", () => void renderB());
      renderDiff();
      return;
    }

    // single side: plain content
    const side = a ?? b;
    if (!side) {
      this.add(el("div", "more-note", "empty"));
      return;
    }
    if (side.binary) {
      const holder = el("div");
      this.add(holder);
      if (isImageBytes(new Uint8Array(side.bytes ?? [])) || /\.(png|jpe?g|gif|webp|svg)$/i.test(target.path)) {
        const img = document.createElement("img");
        img.className = "full";
        img.src = side.fromWorktree ? `/api/worktree-file?path=${encodeURIComponent(target.path)}` : rawUrl(side.sha);
        holder.appendChild(img);
      } else {
        const cv = document.createElement("canvas");
        cv.className = "tapestry";
        holder.appendChild(cv);
        drawTapestry(cv, new Uint8Array(side.bytes ?? []), 440, 220);
        holder.appendChild(el("div", "more-note", `binary · ${fmtBytes(side.size)}`));
      }
      return;
    }
    const text = side.fromWorktree ? await decodeBase64((await getWorktreeFile(side.path)).base64) : await fetchText(side.sha);
    if (this.stale(token)) return;
    this.add(simpleContent(text, side.label));
  }

  private async resolveSides(target: FlowTarget): Promise<{
    a: Side | null;
    b: Side | null;
    aLabel: string;
    bLabel: string;
  } | null> {
    const loadObject = async (sha: string): Promise<Side | null> => {
      const detail = await getObjectDetail(sha);
      return { sha, path: target.path, size: detail.size, binary: detail.contentHead.slice(0, 8192).includes(0), bytes: detail.contentHead, fromWorktree: false, label: sha.slice(0, 7) };
    };
    const loadWorktree = async (): Promise<Side | null> => {
      try {
        const f = await getWorktreeFile(target.path);
        return { sha: "worktree", path: target.path, size: f.size, binary: f.binary, bytes: [...atob(f.base64)].map((c) => c.charCodeAt(0)), fromWorktree: true, label: "worktree" };
      } catch {
        return null;
      }
    };

    if (target.column === "head") {
      const b = target.headSha ? await loadObject(target.headSha) : null;
      return { a: null, b, aLabel: "", bLabel: `HEAD · ${target.path}` };
    }
    if (target.column === "index") {
      const a = target.headSha ? await loadObject(target.headSha) : null;
      const b = target.indexSha ? await loadObject(target.indexSha) : null;
      return { a, b, aLabel: `HEAD · ${target.path}`, bLabel: `index · ${target.path}` };
    }
    // worktree
    if (!target.indexSha && !target.headSha) {
      const b = await loadWorktree();
      return { a: null, b, aLabel: "", bLabel: `worktree · ${target.path}` };
    }
    if (target.change?.kind === "del") {
      const a = target.indexSha ? await loadObject(target.indexSha) : null;
      return { a, b: null, aLabel: `index · ${target.path}`, bLabel: "" };
    }
    const a = target.indexSha ?? target.headSha ? await loadObject((target.indexSha ?? target.headSha)!) : null;
    const b = await loadWorktree();
    return { a, b, aLabel: `index · ${target.path}`, bLabel: `worktree · ${target.path}` };
  }
}

interface Side {
  sha: string;
  path: string;
  size: number;
  binary: boolean;
  bytes: number[] | Uint8Array;
  fromWorktree: boolean;
  label: string;
}

// ---- shared render helpers -----------------------------------------------------

interface HexCtl {
  el: HTMLElement;
  set(from: number, to: number): void;
  setBuffer(bytes: Uint8Array): void;
}

function hexdump(bytes: Uint8Array, hlFrom?: number, hlTo?: number): HexCtl {
  const pre = el("pre", "hexdump");
  let buf = bytes;
  const render = (from: number, to: number): void => {
    const lines: string[] = [];
    const hlLines = new Set<number>();
    for (let off = 0; off < buf.length; off += 16) {
      const chunk = buf.subarray(off, off + 16);
      const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0"));
      const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("");
      lines.push(`${off.toString(16).padStart(4, "0")}  ${hex.join(" ")}`);
      const asciiPadded = hex.length < 16 ? " ".repeat((16 - hex.length) * 3) : "";
      lines[lines.length - 1] += `${asciiPadded}  ${ascii}`;
      for (let i = 0; i < chunk.length; i++) {
        const abs = off + i;
        if (abs >= from && abs < to) hlLines.add(lines.length - 1);
      }
    }
    pre.innerHTML = lines
      .map((l, i) => {
        if (!hlLines.has(i)) return `<span class="off">${l.slice(0, 4)}</span>${l.slice(4)}`;
        const offPart = `<span class="off">${l.slice(0, 4)}</span>`;
        const rest = l.slice(4);
        const bytesPart = rest.slice(0, 49);
        const asciiPart = rest.slice(49);
        return `${offPart}<span class="hl">${bytesPart}</span>  ${asciiPart}`;
      })
      .join("\n");
  };
  render(hlFrom ?? 0, hlTo ?? 0);
  return { el: pre, set: render, setBuffer: (b) => { buf = b; } };
}

function contentLines(lines: string[], startNo: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  const max = Math.min(lines.length, 1500);
  for (let i = 0; i < max; i++) {
    const row = el("div", "line");
    row.appendChild(el("span", "ln-no", String(startNo + i + 1)));
    row.appendChild(el("span", "ln-tx", lines[i] === "" ? " " : lines[i]!));
    frag.appendChild(row);
  }
  if (lines.length > max) frag.appendChild(el("div", "more-note", `… ${lines.length - max} more lines`));
  return frag;
}

function diffView(d: DiffPayload, aLabel: string, bLabel: string): HTMLElement {
  const view = el("div", "diff-view");
  view.appendChild(el("div", "more-note", `${aLabel}  →  ${bLabel}`));
  const frag = document.createDocumentFragment();
  for (const op of d.ops!) {
    const row = el("div", `row ${op.t}`);
    const ga = el("span", "gut-a", op.a >= 0 ? String(op.a + 1) : "");
    const gb = el("span", "gut-b", op.b >= 0 ? String(op.b + 1) : "");
    const tx = op.t === "eq" ? d.aLines![op.a!] ?? "" : op.t === "del" ? d.aLines![op.a!] ?? "" : d.bLines![op.b!] ?? "";
    row.append(ga, gb, el("span", "tx", tx === "" ? " " : tx));
    frag.appendChild(row);
  }
  view.appendChild(frag);
  return view;
}

function simpleContent(text: string, label: string): HTMLElement {
  const wrap = el("div");
  const view = el("div", "content-view");
  const lines = text.replace(/\n$/, "").split("\n");
  view.appendChild(contentLines(lines, 0));
  wrap.appendChild(view);
  wrap.appendChild(el("div", "more-note", `${label} · ${lines.length} lines`));
  return wrap;
}

async function fetchText(sha: string): Promise<string> {
  const r = await fetch(rawUrl(sha));
  return r.text();
}

async function decodeBase64(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function isImageBytes(b: Uint8Array): boolean {
  return (
    b.length > 8 &&
    ((b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) ||
      (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
      (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) ||
      (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57))
  );
}
