// Payload parsers: commit / tree / tag object bodies (blob has no structure).
// Each parsed field also carries its byte range inside the payload, so the
// UI can highlight the exact bytes a value was parsed from.

import type { CommitInfo, ObjType, Person } from "../model.ts";
import { toHex } from "../gitformat.ts";

export interface FieldRange {
  key: string; // "tree", "parent", "author", "committer", "message", tag keys…
  start: number; // offset in the object payload (after "<type> <size>\0")
  end: number;
}

/** Split a commit/tag header block into keyed byte ranges. */
function walkHeader(content: Buffer): { lines: { key: string; start: number; end: number }[]; messageStart: number } {
  const lines: { key: string; start: number; end: number }[] = [];
  let messageStart = content.length;
  let p = 0;
  while (p < content.length) {
    const nl = content.indexOf(0x0a, p);
    const end = nl < 0 ? content.length : nl;
    if (end === p) {
      messageStart = p + 1; // blank line: headers over, message begins
      break;
    }
    const sp = content.indexOf(0x20, p);
    const key = sp > p && sp < end ? content.subarray(p, sp).toString("latin1") : "";
    if (key === "" && lines.length) {
      // continuation line (e.g. gpgsig) — fold into the previous field
      lines[lines.length - 1]!.end = end;
    } else if (key) {
      lines.push({ key, start: p, end });
    }
    if (nl < 0) break;
    p = end + 1;
  }
  return { lines, messageStart };
}

export interface TreeEntry {
  mode: string; // e.g. "100644", "40000"
  name: string;
  sha: string;
  kind: ObjType | "gitlink";
  start: number; // entry byte range in the tree payload
  end: number;
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
    const start = p;
    const sp = content.indexOf(0x20, p);
    const nul = content.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0) throw new Error("tree: truncated entry");
    const mode = content.subarray(p, sp).toString("latin1");
    const name = content.subarray(sp + 1, nul).toString("utf8");
    const sha = toHex(content, nul + 1, hashLen);
    p = nul + 1 + hashLen;
    out.push({ mode, name, sha, kind: treeEntryKind(mode), start, end: p });
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
  ranges: FieldRange[];
}

export function parseCommit(content: Buffer): ParsedCommit {
  const { lines, messageStart } = walkHeader(content);

  let tree = "";
  const parents: string[] = [];
  let author = { name: "", email: "", when: 0, tz: "" };
  let committer = author;
  const headers: [string, string][] = [];

  for (const l of lines) {
    const value = content.subarray(content.indexOf(0x20, l.start) + 1, l.end).toString("utf8");
    headers.push([l.key, value]);
    if (l.key === "tree") tree = value;
    else if (l.key === "parent") parents.push(value);
    else if (l.key === "author") author = parsePerson(value);
    else if (l.key === "committer") committer = parsePerson(value);
  }

  const ranges: FieldRange[] = lines.map((l) => ({ key: l.key, start: l.start, end: l.end }));
  if (messageStart < content.length) {
    ranges.push({ key: "message", start: messageStart, end: content.length });
  }
  const message = messageStart < content.length ? content.subarray(messageStart).toString("utf8") : "";

  return { tree, parents, author, committer, headers, message, ranges };
}

export interface ParsedTag {
  object: string;
  type: ObjType;
  tag: string;
  tagger?: Person;
  message: string;
  ranges: FieldRange[];
}

export function parseTag(content: Buffer): ParsedTag {
  const { lines, messageStart } = walkHeader(content);

  let object = "", type = "blob" as ObjType, tag = "", tagger: Person | undefined;
  for (const l of lines) {
    const value = content.subarray(content.indexOf(0x20, l.start) + 1, l.end).toString("utf8");
    if (l.key === "object") object = value;
    else if (l.key === "type") type = value as ObjType;
    else if (l.key === "tag") tag = value;
    else if (l.key === "tagger") tagger = parsePerson(value);
  }

  const ranges: FieldRange[] = lines.map((l) => ({ key: l.key, start: l.start, end: l.end }));
  if (messageStart < content.length) {
    ranges.push({ key: "message", start: messageStart, end: content.length });
  }
  const message = messageStart < content.length ? content.subarray(messageStart).toString("utf8") : "";

  return { object, type, tag, tagger, message, ranges };
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
