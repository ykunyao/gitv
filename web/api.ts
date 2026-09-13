// Typed access to the gitv API. Types come from the server's own model.

import type { RepoModel } from "../src/model.ts";

export type { RepoModel, ModelEvent, CommitInfo, ObjSummary, RefInfo, IndexEntry, Change } from "../src/model.ts";

export interface ObjectDetail {
  sha: string;
  type: "commit" | "tree" | "blob" | "tag";
  size: number;
  delta: boolean;
  where: { kind: "loose"; file: string } | { kind: "pack"; pack: string; offset: number };
  integrity: { ok: boolean; computed: string } | null;
  compressedHead: number[] | null;
  contentHead: number[];
  contentLength: number;
  deltaChain: {
    depth: number;
    entries: {
      sha: string | null;
      offset: number;
      role: "self" | "delta" | "base";
      type: "commit" | "tree" | "blob" | "tag";
      resultSize: number;
      deltaSize: number | null;
      via: "ofs" | "ref" | null;
    }[];
  } | null;
  parsed: unknown;
}

/** Parsed payload with per-field byte ranges (offsets inside the content). */
export interface CommitParsed {
  tree: string;
  parents: string[];
  author: { name: string; email: string; when: number; tz: string };
  committer: { name: string; email: string; when: number; tz: string };
  message: string;
  ranges: { key: string; start: number; end: number }[];
}

export interface TreeParsedEntry {
  mode: string;
  name: string;
  sha: string;
  kind: string;
  start: number;
  end: number;
}

export interface TagParsed {
  object: string;
  type: string;
  tag: string;
  tagger?: { name: string; email: string; when: number };
  message: string;
  ranges: { key: string; start: number; end: number }[];
}

export interface TreeFlatEntry {
  path: string;
  sha: string;
  kind: string;
  mode: string;
}

export interface CommitDiff {
  parent: string | null;
  files: { path: string; kind: "add" | "mod" | "del" | "type"; aSha?: string; bSha?: string }[];
}

export interface DiffPayload {
  binary?: boolean;
  tooLarge?: boolean;
  aSize?: number;
  bSize?: number;
  aLines?: string[];
  bLines?: string[];
  ops?: { t: "eq" | "ins" | "del"; a: number; b: number }[];
  error?: string;
}

export async function getModel(): Promise<RepoModel> {
  const r = await fetch("/api/model");
  const j = await r.json();
  return j.model as RepoModel;
}

export async function getObjectDetail(sha: string): Promise<ObjectDetail> {
  const r = await fetch(`/api/object/${sha}`);
  if (!r.ok) throw new Error(`object ${sha.slice(0, 7)}: ${r.status}`);
  return r.json();
}

export async function getTree(sha: string, cap = 600): Promise<TreeFlatEntry[]> {
  const r = await fetch(`/api/tree/${sha}?cap=${cap}`);
  const j = await r.json();
  return j.entries as TreeFlatEntry[];
}

export async function getCommitDiff(sha: string): Promise<CommitDiff> {
  const r = await fetch(`/api/commit-diff/${sha}`);
  if (!r.ok) throw new Error(`commit-diff ${sha.slice(0, 7)}: ${r.status}`);
  return r.json();
}

export async function getDiff(a: string, b: string): Promise<DiffPayload> {
  const r = await fetch(`/api/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  return r.json();
}

export async function getWorktreeFile(path: string): Promise<{ binary: boolean; size: number; base64: string; truncated: boolean }> {
  const r = await fetch(`/api/worktree-file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`worktree file ${path}: ${r.status}`);
  return r.json();
}

export function rawUrl(sha: string): string {
  return `/api/raw/${sha}`;
}

export async function pool<T>(jobs: (() => Promise<T>)[], limit = 6): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++]!;
      try {
        await job();
      } catch {
        /* previews are best-effort */
      }
    }
  });
  await Promise.all(workers);
}
