// quick debug harness (not part of the test suite)
import { buildFixture } from "../tests/fixture.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseIdx, PackFile } from "../src/parse/pack.ts";
import { parseTree } from "../src/parse/objects.ts";

const base = mkdtempSync(join(tmpdir(), "gitv-dbg-"));
const fx = buildFixture(base);
const gitDir = join(fx.dir, ".git");

// --- tree raw content via git cat-file tree ---
const commit = spawnSync("git", ["cat-file", "commit", fx.shas.initial], { cwd: fx.dir, encoding: "buffer" });
console.log("cat-file commit status:", commit.status);
const treeSha = commit.stdout.toString().match(/tree ([0-9a-f]{40})/)![1]!;
const rawTree = spawnSync("git", ["cat-file", "tree", treeSha], { cwd: fx.dir, encoding: "buffer" });
console.log("cat-file tree status:", rawTree.status, "len:", rawTree.stdout.length);
console.log("first 40 bytes:", [...rawTree.stdout.subarray(0, 40)]);
try {
  console.log("parseTree:", parseTree(rawTree.stdout, 20).slice(0, 3));
} catch (e) {
  console.log("parseTree FAILED:", e);
}

// --- pack probe: find the bad entry ---
const packDir = join(gitDir, "objects/pack");
const idxName = [...new Bun.Glob("pack-*.idx").scanSync({ cwd: packDir })][0]!;
const idx = parseIdx(Buffer.from(await Bun.file(join(packDir, idxName)).arrayBuffer()));
const packPath = join(packDir, idxName.replace(/\.idx$/, ".pack"));
const packSize = (await Bun.file(packPath).stat())!.size;
const pf = new PackFile(packPath, idx, packSize);
await pf.load();

const verify = spawnSync("git", ["verify-pack", "-v", packPath], { cwd: fx.dir, encoding: "buffer" }).stdout.toString();
const vp = new Map<string, { type: string; size: number; off: number; depth: number; base?: string }>();
for (const l of verify.split("\n")) {
  const parts = l.trim().split(/\s+/);
  if (parts.length >= 5 && /^[0-9a-f]{40}$/.test(parts[0]!)) {
    vp.set(parts[0]!, { type: parts[1]!, size: Number(parts[2]), off: Number(parts[4]), depth: Number(parts[5] ?? 0), base: parts[6] });
  }
}

for (let i = 0; i < idx.count; i++) {
  const sha = idx.shas[i]!;
  const expect = vp.get(sha)!;
  try {
    const probe = await pf.probe(idx.offsets[i]!);
    if (probe.type !== expect.type || probe.size !== expect.size) {
      console.log("MISMATCH", sha, "mine:", probe.type, probe.size, "git:", expect.type, expect.size, "depth", expect.depth, "off", expect.off);
      if (expect.base) {
        const baseOff = idx.offsets[idx.shas.indexOf(expect.base)];
        console.log("  git base offset:", baseOff, "my chain:", probe.chain.map((c) => ({ t: c.typeName, base: c.baseOffset })));
      }
    }
  } catch (e) {
    console.log("PROBE FAIL", sha, "git:", expect.type, expect.size, "depth", expect.depth, "off", expect.off, "err:", String(e).slice(0, 120));
    const head = await pf.header(idx.offsets[i]!);
    console.log("  my header:", JSON.stringify(head));
    if (expect.base) console.log("  git base offset:", idx.offsets[idx.shas.indexOf(expect.base)]);
    break;
  }
}

rmSync(base, { recursive: true, force: true });
