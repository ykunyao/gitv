// .git/config — a tiny INI dialect. Just enough for gitv's needs.

export type GitConfig = Map<string, Map<string, string>>; // section (lowercased, with subsection) → key → value

export function parseConfig(text: string): GitConfig {
  const out: GitConfig = new Map();
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^[ \t]+/, "").replace(/\s*[#;].*$/, "").replace(/\s+$/, "");
    if (!line) continue;
    const sec = line.match(/^\[([^\]]*)\]$/);
    if (sec) {
      const inner = sec[1]!.trim();
      // [remote "origin"] → remote.origin
      section = inner.replace(/"([^"]*)"/, (_m, s) => "." + s).replace(/\s+/g, "").toLowerCase();
      if (!out.has(section)) out.set(section, new Map());
      continue;
    }
    const eq = line.indexOf("=");
    let key: string, value: string;
    if (eq < 0) { key = line.toLowerCase(); value = "true"; }
    else { key = line.slice(0, eq).trim().toLowerCase(); value = line.slice(eq + 1).trim(); }
    if (!out.has(section)) out.set(section, new Map());
    out.get(section)!.set(key, value);
  }
  return out;
}
