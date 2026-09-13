// Payload parsers: commit / tree / tag object bodies (blob has no structure).

import type { CommitInfo, ObjType, Person } from "../model.ts";
import { toHex } from "../gitformat.ts";

export interface TreeEntry {
  mode: string; // e.g. "100644", "40000"
  name: string;
  sha: string;
  kind: ObjType | "gitlink";
}

/** mode → object kind (no lookup needed: the mode tells the story). */
export function treeEntryKind(mode: string): ObjType | "gitlink" {
  if (mode === "40000" || mode === "040000") return "tree";
  if (mode === "160000") return "gitlink";
  return "blob";
}

export function parseTree(content: Buffer, hashLen: number): TreeEntry[] {
  const out: TreeEntry[] = [];
  let p = 0;
  while (p < content.length) {
    const sp = content.indexOf(0x20, p);
    const nul = content.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0) throw new Error("tree: truncated entry");
    const mode = content.subarray(p, sp).toString("latin1");
    const name = content.subarray(sp + 1, nul).toString("utf8");
    const sha = toHex(content, nul + 1, hashLen);
    p = nul + 1 + hashLen;
    out.push({ mode, name, sha, kind: treeEntryKind(mode) });
  }
  return out;
}

export function parsePerson(line: string): Person {
  // "Name <email> 1726000000 +0800"
  const lt = line.lastIndexOf("<");
  const gt = line.lastIndexOf(">");
  if (lt < 0 || gt < lt) return { name: line.trim(), email: "", when: 0, tz: "" };
  const name = line.slice(0, lt).trim();
  const email = line.slice(lt + 1, gt);
  const rest = line.slice(gt + 1).trim().split(/\s+/);
  const when = rest[0] ? Number.parseInt(rest[0], 10) * 1000 : 0;
  const tz = rest[1] ?? "";
  return { name, email, when, tz };
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  headers: [string, string][];
  message: string;
}

export function parseCommit(content: Buffer): ParsedCommit {
  const text = content.toString("utf8");
  const split = text.indexOf("\n\n");
  const headText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? "" : text.slice(split + 2);

  let tree = "";
  const parents: string[] = [];
  let author = { name: "", email: "", when: 0, tz: "" };
  let committer = author;
  const headers: [string, string][] = [];

  for (const rawLine of headText.split("\n")) {
    if (rawLine.startsWith(" ")) {
      // continuation (e.g. gpgsig); attach to previous header
      const last = headers[headers.length - 1];
      if (last) last[1] += "\n" + rawLine.slice(1);
      continue;
    }
    const sp = rawLine.indexOf(" ");
    if (sp < 0) continue;
    const key = rawLine.slice(0, sp);
    const value = rawLine.slice(sp + 1);
    headers.push([key, value]);
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = parsePerson(value);
    else if (key === "committer") committer = parsePerson(value);
  }
  return { tree, parents, author, committer, headers, message };
}

export interface ParsedTag {
  object: string;
  type: ObjType;
  tag: string;
  tagger?: Person;
  message: string;
}

export function parseTag(content: Buffer): ParsedTag {
  const text = content.toString("utf8");
  const split = text.indexOf("\n\n");
  const headText = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? "" : text.slice(split + 2);
  let object = "", type = "blob" as ObjType, tag = "", tagger: Person | undefined;
  for (const line of headText.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key === "object") object = value;
    else if (key === "type") type = value as ObjType;
    else if (key === "tag") tag = value;
    else if (key === "tagger") tagger = parsePerson(value);
  }
  return { object, type, tag, tagger, message };
}

export function commitInfo(sha: string, parsed: ParsedCommit): CommitInfo {
  const firstBreak = parsed.message.indexOf("\n");
  return {
    sha,
    tree: parsed.tree,
    parents: parsed.parents,
    author: parsed.author,
    committer: parsed.committer,
    subject: firstBreak < 0 ? parsed.message : parsed.message.slice(0, firstBreak),
    message: parsed.message,
  };
}
