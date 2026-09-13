// The scanner assembles a full RepoModel from the bytes on disk, keeps
// caches so live rescans are cheap, and serves object detail views.

import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import type { Change, CommitInfo, ObjSummary, ObjType, RefInfo, RepoModel } from "../model.ts";
import { scanLoose, inflateLoose } from "../parse/loose.ts";
import { parseIdx, PackFile } from "../parse/pack.ts";
import { readHead, readRefs } from "../parse/refs.ts";
import { parseIndex } from "../parse/indexfile.ts";
import { parseConfig } from "../parse/config.ts";
import { parseCommit, parseTree, parseTag, commitInfo, type ParsedCommit } from "../parse/objects.ts";

export interface ScanOptions {
  maxCommits?: number; // lay out at most this many commits
  maxObjects?: number; // list at most this many object summaries
  probeBudgetMs?: number; // time budget for probing pack entry headers
}

interface PackEntry {
  name: string; // pack-xxx
  pf: PackFile;
  mtimeMs: number;
  size: number;
}

export interface LoadedObject {
  sha: string;
  type: ObjType;
  size: number;
  content: Buffer;
  where: ObjSummary["where"];
  delta: boolean;
}

export class NotARepository extends Error {}

export class RepoScanner {
  private opts: Required<ScanOptions>;
  private packs = new Map<string, PackEntry>();
  private summaries = new Map<string, { type: ObjType; size: number; delta: boolean }>();
  private commitCache = new Map<string, CommitInfo>();
  private looseBySha = new Map<string, string>(); // sha → relative file
  private shaToPack = new Map<string, { pf: PackFile; offset: number }>();
  gitDir = "";
  commonDir = "";
  worktree = "";
  bare = false;
  shaLen = 40;
  hashLen = 20;

  constructor(opts: ScanOptions = {}) {
    this.opts = { maxCommits: 3000, maxObjects: 12000, probeBudgetMs: 5000, ...opts };
  }

  // ---- repository layout ----------------------------------------------------

  async locate(path: string): Promise<void> {
    this.worktree = resolve(path);
    const dotGit = join(this.worktree, ".git");
    const st = await Bun.file(dotGit).stat().catch(() => null);
    if (st?.isDirectory()) {
      this.gitDir = dotGit;
      this.bare = false;
    } else if (st?.isFile()) {
      const text = await Bun.file(dotGit).text();
      const m = text.match(/^gitdir:\s*(.+)\s*$/m);
      if (!m) throw new NotARepository(`bad .git file at ${dotGit}`);
      this.gitDir = resolve(this.worktree, m[1]!.trim());
      this.bare = false;
    } else {
      const head = await Bun.file(join(this.worktree, "HEAD")).stat().catch(() => null);
      const objects = await Bun.file(join(this.worktree, "objects")).stat().catch(() => null);
      if (head?.isFile() && objects?.isDirectory()) {
        this.gitDir = this.worktree;
        this.bare = true;
      } else {
        throw new NotARepository(`${this.worktree} is not a git repository`);
      }
    }
    const common = await Bun.file(join(this.gitDir, "commondir")).text().catch(() => null);
    this.commonDir = common ? resolve(this.gitDir, common.trim()) : this.gitDir;

    const cfg = parseConfig(await Bun.file(join(this.commonDir, "config")).text().catch(() => ""));
    if (cfg.get("extensions")?.get("objectformat") === "sha256") {
      this.shaLen = 64;
      this.hashLen = 32;
    }
  }

  // ---- object access --------------------------------------------------------

  private async readLoose(sha: string): Promise<LoadedObject | null> {
    const file = this.looseBySha.get(sha);
    if (!file) return null;
    const buf = Buffer.from(await Bun.file(join(this.commonDir, file)).arrayBuffer());
    const obj = inflateLoose(buf);
    return { sha, type: obj.type, size: obj.size, content: obj.content, where: { kind: "loose", file }, delta: false };
  }

  private async readPacked(sha: string): Promise<LoadedObject | null> {
    const hit = this.shaToPack.get(sha);
    if (!hit) return null;
    const obj = await hit.pf.read(hit.offset);
    return {
      sha,
      type: obj.type,
      size: obj.size,
      content: obj.content,
      where: { kind: "pack", pack: hit.pf.path, offset: hit.offset },
      delta: obj.chain.length > 0,
    };
  }

  async readObject(sha: string): Promise<LoadedObject | null> {
    return (await this.readLoose(sha)) ?? (await this.readPacked(sha));
  }

  /** sha of "blob <size>\0<content>" — used to identify worktree files. */
  static hashBlob(content: Buffer, hashLen = 20): string {
    const h = createHash(hashLen === 20 ? "sha1" : "sha256");
    h.update(`blob ${content.length}\0`);
    h.update(content);
    return h.digest("hex");
  }

  // ---- full scan ------------------------------------------------------------

  async scan(): Promise<RepoModel> {
    await this.locate(this.worktree);

    // 1. loose objects — typed eagerly (one small inflate each, few in practice);
    // build fresh maps then swap, so detail reads never hit a half-cleared state
    const nextLoose = new Map<string, string>();
    for (const l of await scanLoose(join(this.commonDir, "objects"), this.shaLen)) {
      nextLoose.set(l.sha, l.file);
      if (!this.summaries.has(l.sha)) {
        try {
          const buf = Buffer.from(await Bun.file(join(this.commonDir, l.file)).arrayBuffer());
          const obj = inflateLoose(buf);
          this.summaries.set(l.sha, { type: obj.type, size: obj.size, delta: false });
        } catch {
          /* unreadable — leave untyped, excluded below */
        }
      }
    }
    this.looseBySha = nextLoose;

    // 2. packs — same swap pattern as loose maps
    const packDir = join(this.commonDir, "objects/pack");
    const seenPacks = new Set<string>();
    const nextShaToPack = new Map<string, { pf: PackFile; offset: number }>();
    let probeDeadline = Date.now() + this.opts.probeBudgetMs;
    try {
      for (const idxName of [...new Bun.Glob("pack-*.idx").scanSync({ cwd: packDir })]) {
        const packName = idxName.replace(/\.idx$/, "");
        const packPath = join(packDir, packName + ".pack");
        const st = await Bun.file(packPath).stat();
        const idxSt = await Bun.file(join(packDir, idxName)).stat();
        if (!st || !idxSt) continue;
        seenPacks.add(packName);
        let entry = this.packs.get(packName);
        if (!entry || entry.mtimeMs !== idxSt.mtimeMs || entry.size !== st.size) {
          const idx = parseIdx(Buffer.from(await Bun.file(join(packDir, idxName)).arrayBuffer(), 0, idxSt.size));
          entry = { name: packName, pf: new PackFile(packPath, idx, st.size, this.hashLen), mtimeMs: idxSt.mtimeMs, size: st.size };
          this.packs.set(packName, entry);
          await entry.pf.load();
        }
        const { pf } = entry;
        for (let i = 0; i < pf.idx.count; i++) {
          const sha = pf.idx.shas[i]!;
          nextShaToPack.set(sha, { pf, offset: pf.idx.offsets[i]! });
          if (!this.summaries.has(sha) && Date.now() <= probeDeadline) {
            try {
              const probe = await pf.probe(pf.idx.offsets[i]!);
              this.summaries.set(sha, { type: probe.type, size: probe.size, delta: probe.delta });
            } catch {
              /* leave untyped */
            }
          }
        }
      }
    } catch {
      /* no pack dir */
    }
    for (const name of [...this.packs.keys()]) if (!seenPacks.has(name)) this.packs.delete(name);
    this.shaToPack = nextShaToPack;

    // 3. object summary list (typed objects only; total includes unprobed)
    const all: ObjSummary[] = [];
    let looseCount = 0, packedCount = 0;
    const byType: Partial<Record<ObjType, number>> = {};
    for (const [sha, s] of this.summaries) {
      byType[s.type] = (byType[s.type] ?? 0) + 1;
      if (this.looseBySha.has(sha)) looseCount++;
      else packedCount++;
    }
    const order: ObjType[] = ["commit", "tag", "tree", "blob"];
    const sorted = [...this.summaries.entries()].sort((a, b) => {
      const d = order.indexOf(a[1].type) - order.indexOf(b[1].type);
      return d !== 0 ? d : b[1].size - a[1].size;
    });
    for (const [sha, s] of sorted) {
      if (all.length >= this.opts.maxObjects) break;
      const packHit = this.shaToPack.get(sha);
      const where = this.looseBySha.has(sha)
        ? { kind: "loose" as const, file: this.looseBySha.get(sha)! }
        : { kind: "pack" as const, pack: basename(packHit?.pf.path ?? ""), offset: packHit?.offset ?? 0 };
      all.push({ sha, type: s.type, size: s.size, where, delta: s.delta });
    }

    // 4. commits
    const { commits, complete } = await this.collectCommits(all);

    // 5. refs + HEAD
    const refs = await readRefs(this.commonDir);
    const head = await readHead(this.gitDir);
    let headSha: string | undefined;
    if (head.sha) headSha = head.sha;
    else if (head.ref) {
      let cur = head.ref;
      for (let hop = 0; hop < 4; hop++) {
        const r = refs.find((x) => x.name === cur);
        if (!r) break;
        if (r.symref) { cur = r.symref; continue; }
        headSha = r.sha || undefined;
        break;
      }
    }
    await this.resolveTagTargets(refs);

    // 6. index
    const indexModel = await this.readIndex();

    // 7. status (porcelain v2, NUL-delimited)
    const status = await this.readStatus();

    return {
      repo: { path: this.worktree, name: basename(this.worktree) || this.worktree, bare: this.bare },
      shaLen: this.shaLen,
      head: { ref: head.ref, short: head.ref ? shortRef(head.ref) : undefined, sha: headSha, detached: !head.ref },
      refs,
      commits,
      commitsComplete: complete,
      objects: all,
      counts: {
        loose: looseCount,
        packed: packedCount,
        byType,
        objectsProbed: all.length,
        objectsTotal: this.looseBySha.size + this.shaToPack.size,
      },
      index: indexModel,
      status,
      generatedAt: Date.now(),
    };
  }

  private async collectCommits(all: ObjSummary[]): Promise<{ commits: CommitInfo[]; complete: boolean }> {
    const commitShas = all.filter((o) => o.type === "commit").map((o) => o.sha);
    let target: string[];
    let complete = true;
    if (commitShas.length <= this.opts.maxCommits) {
      target = commitShas;
    } else {
      complete = false;
      const out = spawnGit(["rev-list", "--max-count", String(this.opts.maxCommits), "HEAD"], this.worktree);
      target = out ? out.split("\n").filter((l) => l) : commitShas.slice(0, this.opts.maxCommits);
    }
    const commits: CommitInfo[] = [];
    for (const sha of target) {
      const cached = this.commitCache.get(sha);
      if (cached) { commits.push(cached); continue; }
      try {
        const obj = await this.readObject(sha);
        if (!obj || obj.type !== "commit") continue;
        const info = commitInfo(sha, parseCommit(obj.content));
        this.commitCache.set(sha, info);
        commits.push(info);
      } catch {
        /* skip unreadable */
      }
    }
    commits.sort((a, b) => b.committer.when - a.committer.when || (a.sha < b.sha ? -1 : 1));
    return { commits, complete };
  }

  private async resolveTagTargets(refs: RefInfo[]): Promise<void> {
    for (const r of refs) {
      if (r.kind !== "tag" || !r.sha) continue;
      if (r.peeled) continue;
      try {
        const obj = await this.readObject(r.sha);
        if (obj?.type === "tag") r.peeled = parseTag(obj.content).object;
        else if (obj) r.peeled = r.sha;
      } catch {
        /* leave unresolved */
      }
    }
  }

  private async readIndex() {
    try {
      const buf = Buffer.from(await Bun.file(join(this.gitDir, "index")).arrayBuffer());
      const parsed = parseIndex(buf, this.hashLen);
      const truncated = parsed.entries.length > 3000;
      return {
        entries: parsed.entries.slice(0, 3000),
        version: parsed.version,
        checksumOk: parsed.checksumOk,
        truncated,
      };
    } catch {
      return { entries: [], version: 0, checksumOk: true, truncated: false };
    }
  }

  private async readStatus(): Promise<RepoModel["status"]> {
    const empty = { staged: [] as Change[], unstaged: [] as Change[], untracked: [] as string[], available: false };
    if (this.bare) return empty;
    const out = spawnGit(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], this.worktree);
    if (out === null) return empty;

    const staged: Change[] = [];
    const unstaged: Change[] = [];
    const untracked: string[] = [];
    let branch: string | undefined, ahead: number | undefined, behind: number | undefined;

    const fields = out.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      if (f.startsWith("# branch.head ")) branch = f.slice(14);
      else if (f.startsWith("# branch.ab ")) {
        const m = f.slice(12).match(/\+(\d+) -(\d+)/);
        if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
      } else if (f.startsWith("1 ")) {
        // 1 XY sub mH mI mW hH hI path
        const p = f.split(" ");
        const xy = p[1]!, hI = p[7]!, path = p.slice(8).join(" ");
        const kindOf = (c: string): Change["kind"] | null =>
          c === "A" ? "add" : c === "M" ? "mod" : c === "D" ? "del" : c === "R" ? "ren" : c === "T" ? "type" : null;
        const kx = kindOf(xy[0]!), ky = kindOf(xy[1]!);
        if (kx) staged.push({ kind: kx === "ren" ? "ren" : kx, path, origPath: kx === "ren" ? undefined : undefined, sha: hI && hI !== "0".repeat(this.shaLen) ? hI : undefined });
        if (ky) unstaged.push({ kind: ky, path, sha: hI && hI !== "0".repeat(this.shaLen) ? hI : undefined });
      } else if (f.startsWith("2 ")) {
        // 2 XY sub mH mI mW hH hI path\0origPath
        const p = f.split(" ");
        const xy = p[1]!, hI = p[7]!, path = p.slice(8).join(" ");
        const origPath = fields[++i] ?? "";
        const kindOf = (c: string): Change["kind"] | null =>
          c === "A" ? "add" : c === "M" ? "mod" : c === "D" ? "del" : c === "R" ? "ren" : c === "T" ? "type" : null;
        const kx = kindOf(xy[0]!), ky = kindOf(xy[1]!);
        if (kx) staged.push({ kind: kx, path, origPath, sha: hI && hI !== "0".repeat(this.shaLen) ? hI : undefined });
        if (ky) unstaged.push({ kind: ky, path, origPath, sha: hI && hI !== "0".repeat(this.shaLen) ? hI : undefined });
      } else if (f.startsWith("? ")) {
        untracked.push(f.slice(2));
      }
    }

    // worktree blob shas for unstaged files (bounded, small files only)
    await this.attachWorktreeShas(unstaged);
    // untracked files carry no object yet; their chips read from disk on demand
    return {
      staged,
      unstaged,
      untracked,
      branch: branch && branch !== "(detached)" ? branch : undefined,
      ahead,
      behind,
      available: true,
    };
  }

  private async attachWorktreeShas(changes: Change[]): Promise<void> {
    for (const c of changes) {
      if (c.kind === "del") continue;
      try {
        const full = join(this.worktree, c.path);
        const st = await Bun.file(full).stat();
        if (st?.isFile() && st.size <= 8 * 1024 * 1024) {
          const content = Buffer.from(await Bun.file(full).arrayBuffer());
          c.worktreeSha = RepoScanner.hashBlob(content, this.hashLen);
        }
      } catch { /* unreadable */ }
    }
  }

  // ---- detail views ----------------------------------------------------------

  async objectDetail(sha: string): Promise<Record<string, unknown> | null> {
    const obj = await this.readObject(sha);
    if (!obj) return null;

    let integrity: { ok: boolean; computed: string } | null = null;
    if (obj.content.length <= 1024 * 1024) {
      const h = createHash(this.hashLen === 20 ? "sha1" : "sha256");
      h.update(`${obj.type} ${obj.size}\0`);
      h.update(obj.content);
      const computed = h.digest("hex");
      integrity = { ok: computed === sha, computed };
    }

    let parsed: unknown;
    if (obj.type === "commit") parsed = parseCommit(obj.content);
    else if (obj.type === "tree") parsed = parseTree(obj.content, this.hashLen);
    else if (obj.type === "tag") parsed = parseTag(obj.content);
    else {
      const isBinary = obj.content.subarray(0, 8192).includes(0);
      parsed = { binary: isBinary, size: obj.size };
    }

    const where =
      obj.where.kind === "loose"
        ? { kind: "loose", file: obj.where.file }
        : { kind: "pack", pack: basename(obj.where.pack), offset: obj.where.offset };

    const compressedBytes = await (async (): Promise<number[] | null> => {
      try {
        if (obj.where.kind === "loose") {
          const b = new Uint8Array(await Bun.file(join(this.commonDir, obj.where.file)).slice(0, 96).arrayBuffer());
          return Array.from(b);
        }
        const hit = this.shaToPack.get(sha);
        if (hit) {
          const b = await hit.pf.getBytes(obj.where.offset, 96);
          return Array.from(b.subarray(0, 96));
        }
      } catch {
        /* fall through */
      }
      return null;
    })();

    return {
      sha,
      type: obj.type,
      size: obj.size,
      delta: obj.delta,
      where,
      integrity,
      compressedHead: compressedBytes,
      contentHead: [...obj.content.subarray(0, 4096)],
      contentLength: obj.content.length,
      parsed,
    };
  }

  /** Flat recursive listing of a tree, for browsing. */
  async treeFlat(sha: string, cap = 600): Promise<{ path: string; sha: string; kind: string; mode: string }[] | null> {
    const out: { path: string; sha: string; kind: string; mode: string }[] = [];
    const walk = async (treeSha: string, prefix: string, budget: { n: number }): Promise<void> => {
      if (budget.n <= 0) return;
      const obj = await this.readObject(treeSha);
      if (!obj || obj.type !== "tree") return;
      for (const e of parseTree(obj.content, this.hashLen)) {
        if (budget.n <= 0) return;
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        out.push({ path, sha: e.sha, kind: e.kind, mode: e.mode });
        budget.n--;
        if (e.kind === "tree") await walk(e.sha, path, budget);
      }
    };
    const budget = { n: cap };
    await walk(sha, "", budget);
    return out;
  }

  /**
   * Files changed by a commit relative to its first parent — a hand-rolled
   * diff-tree over the two root trees.
   */
  async commitDiff(sha: string): Promise<{ parent: string | null; files: { path: string; kind: "add" | "mod" | "del" | "type"; aSha?: string; bSha?: string }[] } | null> {
    const obj = await this.readObject(sha);
    if (!obj || obj.type !== "commit") return null;
    const c = parseCommit(obj.content);
    const parent = c.parents[0] ?? null;
    const parentObj = parent ? await this.readObject(parent) : null;
    const parentTree = parentObj && parentObj.type === "commit" ? parseCommit(parentObj.content).tree : null;
    const files: { path: string; kind: "add" | "mod" | "del" | "type"; aSha?: string; bSha?: string }[] = [];
    await this.diffTrees(parentTree, c.tree, "", files, { n: 3000 });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { parent, files };
  }

  private async diffTrees(
    aSha: string | null,
    bSha: string | null,
    prefix: string,
    out: { path: string; kind: "add" | "mod" | "del" | "type"; aSha?: string; bSha?: string }[],
    budget: { n: number },
  ): Promise<void> {
    const readTree = async (sha: string | null) => {
      if (!sha) return [];
      const o = await this.readObject(sha);
      return o && o.type === "tree" ? parseTree(o.content, this.hashLen) : [];
    };
    const [aEntries, bEntries] = [await readTree(aSha), await readTree(bSha)];
    const am = new Map(aEntries.map((e) => [e.name, e]));
    const bm = new Map(bEntries.map((e) => [e.name, e]));
    for (const name of [...new Set([...am.keys(), ...bm.keys()])].sort()) {
      if (budget.n <= 0 || out.length >= 300) return;
      const a = am.get(name), b = bm.get(name);
      const path = prefix ? `${prefix}/${name}` : name;
      if (a && b) {
        if (a.sha === b.sha && a.mode === b.mode) continue;
        if (a.kind === "tree" && b.kind === "tree") {
          await this.diffTrees(a.sha, b.sha, path, out, budget);
          continue;
        }
        out.push({
          path,
          kind: a.kind !== b.kind ? "type" : "mod",
          aSha: a.kind === "tree" ? undefined : a.sha,
          bSha: b.kind === "tree" ? undefined : b.sha,
        });
        budget.n--;
      } else if (b) {
        if (b.kind === "tree") await this.diffTrees(null, b.sha, path, out, budget);
        else out.push({ path, kind: "add", bSha: b.sha });
        budget.n--;
      } else if (a) {
        if (a.kind === "tree") await this.diffTrees(a.sha, null, path, out, budget);
        else out.push({ path, kind: "del", aSha: a.sha });
        budget.n--;
      }
    }
  }

  async blobDiff(aSpec: string, bSpec: string): Promise<Record<string, unknown> | null> {
    const load = async (spec: string): Promise<{ content: Buffer; label: string } | null> => {
      if (spec.startsWith("worktree:")) {
        const rel = spec.slice("worktree:".length);
        const safe = join(this.worktree, rel);
        if (!safe.startsWith(this.worktree)) return null;
        const f = Bun.file(safe);
        const st = await f.stat().catch(() => null);
        if (!st?.isFile() || st.size > 8 * 1024 * 1024) return null;
        return { content: Buffer.from(await f.arrayBuffer()), label: "worktree" };
      }
      const obj = await this.readObject(spec);
      return obj ? { content: obj.content, label: spec.slice(0, 7) } : null;
    };
    const a = await load(aSpec);
    const b = await load(bSpec);
    if (!a || !b) return null;
    const binA = a.content.subarray(0, 8192).includes(0);
    const binB = b.content.subarray(0, 8192).includes(0);
    if (binA || binB) return { binary: true, aSize: a.content.length, bSize: b.content.length };
    const { diffLines } = await import("../parse/diff.ts");
    const aLines = a.content.toString("utf8").split("\n");
    const bLines = b.content.toString("utf8").split("\n");
    if (aLines.length > 8000 || bLines.length > 8000) return { tooLarge: true, aLines: aLines.length, bLines: bLines.length };
    const ops = diffLines(aLines, bLines);
    return { aLines, bLines, ops };
  }
}

function spawnGit(args: string[], cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString();
  } catch {
    return null;
  }
}

function shortRef(name: string): string {
  if (name.startsWith("refs/heads/")) return name.slice(11);
  if (name.startsWith("refs/tags/")) return name.slice(10);
  if (name.startsWith("refs/remotes/")) return name.slice(13);
  return name;
}

export type { ParsedCommit };
