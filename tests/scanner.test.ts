import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture, git, type Fixture } from "./fixture.ts";
import { RepoScanner, NotARepository } from "../src/scan/repo.ts";
import { diffModels } from "../src/model.ts";

const base = mkdtempSync(join(tmpdir(), "gitv-scan-"));
let fx: Fixture;

beforeAll(() => {
  fx = buildFixture(base);
}, 120000);

afterAll(() => {
  fx.dispose();
  rmSync(base, { recursive: true, force: true });
});

function scanner(): RepoScanner {
  const s = new RepoScanner();
  s.worktree = fx.dir;
  return s;
}

describe("RepoScanner", () => {
  test("rejects non-repositories", async () => {
    const empty = join(base, "empty");
    mkdirSync(empty, { recursive: true });
    const s = new RepoScanner();
    s.worktree = empty;
    await expect(s.scan()).rejects.toThrow(NotARepository);
  });

  test("full scan assembles a model", async () => {
    const model = await scanner().scan();
    expect(model.repo.name).toBe("fixture");
    expect(model.head.ref).toBe("refs/heads/main");
    expect(model.head.sha).toBeTruthy();
    expect(model.refs.length).toBeGreaterThanOrEqual(4);
    expect(model.commits.length).toBe(25); // initial + 20 notes + feature + main-edit + merge + loose
    expect(model.commits[0]!.sha).toBe(fx.shas.loose!);
    const merge = model.commits.find((c) => c.sha === fx.shas.merge!)!;
    expect(merge.parents.length).toBe(2);
    expect(model.counts.packed).toBeGreaterThan(50);
    expect(model.counts.loose).toBeGreaterThan(0);
    expect(model.index.entries.length).toBe(26);
    expect(model.index.checksumOk).toBe(true);
    expect(model.status.available).toBe(true);
    expect(model.status.branch).toBe("main");
  });

  test("status detects staged, unstaged, untracked", async () => {
    const s = scanner();
    const model1 = await s.scan();

    writeFileSync(join(fx.dir, "staged.txt"), "staged content\n");
    writeFileSync(join(fx.dir, "unstaged-untracked.txt"), "untracked\n");
    writeFileSync(join(fx.dir, "README.md"), "# fixture\n\nA repository built for gitv parser tests.\n\nEdited on main.\n\nMORE\n");
    git(fx.dir, ["add", "staged.txt"]);
    const model2 = await s.scan();

    expect(model2.status.staged.map((c) => c.path)).toContain("staged.txt");
    expect(model2.status.staged.find((c) => c.path === "staged.txt")!.sha).toBeTruthy();
    expect(model2.status.unstaged.map((c) => c.path)).toContain("README.md");
    expect(model2.status.unstaged.find((c) => c.path === "README.md")!.worktreeSha).toBeTruthy();
    expect(model2.status.untracked).toContain("unstaged-untracked.txt");

    const events = diffModels(model1, model2);
    expect(events.some((e) => e.e === "object-add")).toBe(true);
    expect(events.some((e) => e.e === "index")).toBe(true);
  });

  test("object detail returns parse stages", async () => {
    const s = scanner();
    await s.scan();
    const detail = (await s.objectDetail(fx.shas.merge!))!;
    expect(detail.type).toBe("commit");
    expect((detail.integrity as { ok: boolean }).ok).toBe(true);
    const parsed = detail.parsed as { parents: string[] };
    expect(parsed.parents.length).toBe(2);
    expect(Array.isArray(detail.compressedHead)).toBe(true);
  });

  test("object detail on packed delta object", async () => {
    const s = scanner();
    const model = await s.scan();
    const delta = model.objects.find((o) => o.delta);
    expect(delta).toBeTruthy();
    const detail = (await s.objectDetail(delta!.sha))!;
    expect(detail.delta).toBe(true);
    expect((detail.integrity as { ok: boolean }).ok).toBe(true);

    // chain depth must match what git's verify-pack reports
    const detail2 = detail as unknown as { deltaChain: { depth: number; entries: { sha: string | null; role: string; type: string }[] } };
    const chain = detail2.deltaChain!;
    expect(chain).toBeTruthy();
    const verify = git(fx.dir, ["verify-pack", "-v", join(fx.dir, ".git", "objects", "pack", delta!.where.kind === "pack" ? delta!.where.pack : "")]);
    let depth = -1;
    for (const l of verify.split("\n")) {
      const parts = l.trim().split(/\s+/);
      if (parts[0] === delta!.sha && parts.length >= 7) depth = Number(parts[5]);
    }
    expect(depth).toBeGreaterThanOrEqual(1);
    expect(chain.depth).toBe(depth);
    expect(chain.entries.length).toBe(depth + 1);
    expect(chain.entries[0]!.role).toBe("self");
    expect(chain.entries.at(-1)!.role).toBe("base");
    // every hop shares the base's real type
    const baseType = chain.entries.at(-1)!.type;
    for (const e of chain.entries) expect(e.type).toBe(baseType);
    for (const e of chain.entries) expect(e.sha).toBeTruthy();
  });

  test("packDetail byte map", async () => {
    const s = scanner();
    const model = await s.scan();
    expect(model.packs.length).toBeGreaterThan(0);
    const pack = model.packs[0]!;
    const d = (await s.packDetail(pack.name.replace(/\.pack$/, "")))!;
    expect(d.count).toBe(pack.count);
    expect(d.sizeBytes).toBe(pack.sizeBytes);
    expect(d.blocks.length).toBe(d.count);
    // blocks are sorted by offset and tile the file exactly
    expect(d.blocks[0]!.o).toBe(12); // "PACK" + version + count header
    expect(d.blocks.at(-1)!.o).toBeLessThan(d.sizeBytes - 20);
    let sum = 0;
    for (let i = 0; i < d.blocks.length; i++) {
      const b = d.blocks[i]!;
      const end = i + 1 < d.blocks.length ? d.blocks[i + 1]!.o : d.sizeBytes - 20;
      expect(b.c).toBe(end - b.o);
      sum += b.c;
      if (i > 0) expect(b.o).toBeGreaterThan(d.blocks[i - 1]!.o);
    }
    expect(sum + 32).toBe(d.sizeBytes); // 12-byte header + 20-byte trailer
    // typed census matches verify-pack's census
    const verify = git(fx.dir, ["verify-pack", "-v", join(fx.dir, ".git", "objects", "pack", pack.name)]);
    const verifyTypes = new Map<string, string>();
    for (const l of verify.split("\n")) {
      const parts = l.trim().split(/\s+/);
      if (parts.length >= 5 && /^[0-9a-f]{40}$/.test(parts[0]!)) verifyTypes.set(parts[0]!, parts[1]!);
    }
    for (const b of d.blocks) {
      const t = verifyTypes.get(b.s)!;
      if (b.t) expect(b.t as string).toBe(t);
    }
    // compressed sizes match verify-pack's size-in-packfile column
    let checked = 0;
    for (const l of verify.split("\n")) {
      const parts = l.trim().split(/\s+/);
      if (parts.length < 5 || !/^[0-9a-f]{40}$/.test(parts[0]!) || checked >= 20) continue;
      const b = d.blocks.find((x) => x.s === parts[0]!);
      expect(b).toBeTruthy();
      expect(b!.c).toBe(Number(parts[3]));
      checked++;
    }
  });

  test("blob diff", async () => {
    const s = scanner();
    await s.scan();
    const out = git(fx.dir, ["rev-parse", `${fx.shas.initial!}:README.md`, `${fx.shas.mainEdit!}:README.md`]).trim().split("\n");
    const d = (await s.blobDiff(out[0]!, out[1]!))!;
    expect(d.binary).toBeUndefined();
    const ops = d.ops as { t: string }[];
    expect(ops.some((o) => o.t === "ins")).toBe(true);
  });
});
