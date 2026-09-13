// Refs: HEAD, loose refs under refs/, and packed-refs.

import type { RefInfo } from "../model.ts";

export function refKind(name: string): RefInfo["kind"] {
  if (name.startsWith("refs/heads/")) return "branch";
  if (name.startsWith("refs/tags/")) return "tag";
  if (name.startsWith("refs/remotes/")) return "remote";
  return "other";
}

export function shortName(name: string): string {
  if (name.startsWith("refs/heads/")) return name.slice(11);
  if (name.startsWith("refs/tags/")) return name.slice(10);
  if (name.startsWith("refs/remotes/")) return name.slice(13);
  return name;
}

export interface RawHead {
  sha?: string;
  ref?: string;
}

export async function readHead(gitDir: string): Promise<RawHead> {
  try {
    const text = await Bun.file(`${gitDir}/HEAD`).text();
    const line = text.trim();
    if (line.startsWith("ref:")) return { ref: line.slice(4).trim() };
    return { sha: line };
  } catch {
    return {};
  }
}

export async function readRefs(gitDir: string): Promise<RefInfo[]> {
  const byName = new Map<string, RefInfo>();

  // packed-refs first; loose refs shadow them.
  try {
    const text = await Bun.file(`${gitDir}/packed-refs`).text();
    let lastSha = "";
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("^")) {
        const r = byName.get(lastSha);
        if (r) r.peeled = line.slice(1).trim();
        continue;
      }
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const sha = line.slice(0, sp);
      const name = line.slice(sp + 1).trim();
      lastSha = name; // peeled line keys off the ref name that precedes it
      byName.set(name, { name, short: shortName(name), kind: refKind(name), sha, packed: true });
    }
  } catch {
    /* no packed-refs */
  }

  const refsDir = `${gitDir}/refs`;
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[] = [];
    try {
      names = [...new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })];
    } catch {
      return;
    }
    for (const e of names) {
      const full = `${dir}/${e}`;
      const st = await Bun.file(full).stat();
      if (!st) continue;
      if (st.isDirectory()) await walk(full);
      else if (st.isFile()) files.push(full);
    }
  };
  await walk(refsDir);

  for (const full of files) {
    const rel = full.slice(refsDir.length + 1).replaceAll("\\", "/");
    const name = `refs/${rel}`;
    const text = (await Bun.file(full).text()).trim();
    let sha = "";
    let symref: string | undefined;
    if (text.startsWith("ref:")) symref = text.slice(4).trim();
    else sha = text;
    const info: RefInfo = { name, short: shortName(name), kind: refKind(name), sha, packed: false };
    if (symref) info.symref = symref;
    byName.set(name, info);
  }

  const out = [...byName.values()];
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
