// Shared vocabulary between the byte-level parsers, the server and the browser.
// Pure data — no runtime dependencies, safe to import from web code.

export type ObjType = "commit" | "tree" | "blob" | "tag";

export interface Person {
  name: string;
  email: string;
  when: number; // epoch ms
  tz: string; // e.g. "+08:00"
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  subject: string;
  message: string;
}

export type Where =
  | { kind: "loose"; file: string } // relative to .git, e.g. objects/ab/cdef...
  | { kind: "pack"; pack: string; offset: number };

export interface ObjSummary {
  sha: string;
  type: ObjType;
  size: number; // unpacked size in bytes
  where: Where;
  delta: boolean; // stored as ofs/ref delta inside a pack
}

export interface RefInfo {
  name: string; // refs/heads/main
  short: string; // main
  kind: "branch" | "tag" | "remote" | "other";
  sha: string;
  symref?: string; // points at another ref (e.g. HEAD)
  peeled?: string; // for annotated tags: the object the tag points at
  packed?: boolean;
}

export interface IndexEntry {
  path: string;
  sha: string;
  mode: string; // octal, e.g. "100644"
  stage: number;
  size: number;
}

export type ChangeKind = "add" | "mod" | "del" | "ren" | "type";

export interface Change {
  kind: ChangeKind;
  path: string;
  origPath?: string; // for renames
  sha?: string; // blob sha in the index (or HEAD for deletions)
  worktreeSha?: string; // blob sha of the worktree file, when computable
}

export interface RepoModel {
  repo: { path: string; name: string; bare: boolean };
  shaLen: number; // 40 (sha1) or 64 (sha256)
  head: { ref?: string; short?: string; sha?: string; detached: boolean };
  refs: RefInfo[];
  commits: CommitInfo[];
  commitsComplete: boolean; // false => older commits were left out
  objects: ObjSummary[];
  counts: {
    loose: number;
    packed: number;
    byType: Partial<Record<ObjType, number>>;
    objectsProbed: number; // objects with known type/size (may be < total on huge repos)
    objectsTotal: number;
  };
  packs: { name: string; sizeBytes: number; count: number }[];
  index: {
    entries: IndexEntry[];
    version: number;
    checksumOk: boolean;
    truncated: boolean;
  };
  status: {
    staged: Change[];
    unstaged: Change[];
    untracked: string[];
    branch?: string;
    ahead?: number;
    behind?: number;
    available: boolean; // false when the git binary was not usable
  };
  generatedAt: number;
}

// ---- change events between two models -------------------------------------

export type ModelEvent =
  | { e: "object-add"; sha: string; type: ObjType }
  | { e: "object-del"; sha: string; type: ObjType }
  | { e: "commit-add"; sha: string }
  | { e: "ref-add"; name: string; sha: string }
  | { e: "ref-del"; name: string; sha: string }
  | { e: "ref-move"; name: string; from: string; to: string }
  | { e: "head-move"; from?: string; to?: string }
  | { e: "index"; added: string[]; removed: string[]; modified: string[] }
  | { e: "status" };

export function diffModels(prev: RepoModel | null, next: RepoModel): ModelEvent[] {
  const ev: ModelEvent[] = [];
  if (!prev) return ev;

  const prevObjs = new Map(prev.objects.map((o) => [o.sha, o]));
  const nextObjs = new Map(next.objects.map((o) => [o.sha, o]));
  for (const [sha, o] of nextObjs) if (!prevObjs.has(sha)) ev.push({ e: "object-add", sha, type: o.type });
  for (const [sha, o] of prevObjs) if (!nextObjs.has(sha)) ev.push({ e: "object-del", sha, type: o.type });

  const prevCommits = new Set(prev.commits.map((c) => c.sha));
  const nextCommits = new Set(next.commits.map((c) => c.sha));
  for (const sha of nextCommits) if (!prevCommits.has(sha)) ev.push({ e: "commit-add", sha });

  const prevRefs = new Map(prev.refs.map((r) => [r.name, r]));
  const nextRefs = new Map(next.refs.map((r) => [r.name, r]));
  for (const [name, r] of nextRefs) {
    const before = prevRefs.get(name);
    if (!before) ev.push({ e: "ref-add", name, sha: r.sha });
    else if (before.sha !== r.sha) ev.push({ e: "ref-move", name, from: before.sha, to: r.sha });
  }
  for (const [name, r] of prevRefs) if (!nextRefs.has(name)) ev.push({ e: "ref-del", name, sha: r.sha });

  if (prev.head.sha !== next.head.sha) ev.push({ e: "head-move", from: prev.head.sha, to: next.head.sha });

  const prevIdx = new Map(prev.index.entries.map((e) => [e.path, e.sha]));
  const nextIdx = new Map(next.index.entries.map((e) => [e.path, e.sha]));
  const added: string[] = [], removed: string[] = [], modified: string[] = [];
  for (const [path, sha] of nextIdx) {
    const before = prevIdx.get(path);
    if (before === undefined) added.push(path);
    else if (before !== sha) modified.push(path);
  }
  for (const path of prevIdx.keys()) if (!nextIdx.has(path)) removed.push(path);
  if (added.length || removed.length || modified.length)
    ev.push({ e: "index", added, removed, modified });
  else ev.push({ e: "status" });

  return ev;
}
