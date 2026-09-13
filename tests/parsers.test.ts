import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildFixture, git, type Fixture } from "./fixture.ts";
import { inflateLoose, scanLoose } from "../src/parse/loose.ts";
import { parseIdx, PackFile } from "../src/parse/pack.ts";
import { parseIndex } from "../src/parse/indexfile.ts";
import { readHead, readRefs } from "../src/parse/refs.ts";
import { parseCommit, parseTree, parseTag } from "../src/parse/objects.ts";
import { parseConfig } from "../src/parse/config.ts";
import { diffLines } from "../src/parse/diff.ts";

const base = mkdtempSync(join(tmpdir(), "gitv-test-"));
let fx: Fixture;
const gitDir = () => join(fx.dir, ".git");

const catFile = (sha: string): Buffer =>
  spawnSync("git", ["cat-file", "-p", sha], { cwd: fx.dir, encoding: "buffer" }).stdout;

const catRaw = (type: string, sha: string): Buffer =>
  spawnSync("git", ["cat-file", type, sha], { cwd: fx.dir, encoding: "buffer" }).stdout;

beforeAll(() => {
  fx = buildFixture(base);
});

afterAll(() => {
  fx.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe("loose objects", () => {
  test("inflate and match git cat-file", async () => {
    const loose = await scanLoose(gitDir() + "/objects", 40);
    expect(loose.length).toBeGreaterThan(0);
    for (const { sha, file } of loose) {
      const buf = Buffer.from(await Bun.file(`${gitDir()}/${file}`).arrayBuffer());
      const obj = inflateLoose(buf);
      const expected = catRaw(obj.type, sha);
      expect(Buffer.compare(obj.content, expected)).toBe(0);
      expect(obj.size).toBe(expected.length);
    }
  });

  test("the post-repack commit is loose", async () => {
    const loose = await scanLoose(gitDir() + "/objects", 40);
    expect(loose.map((l) => l.sha)).toContain(fx.shas.loose);
  });
});

describe("packfiles", () => {
  test("idx matches verify-pack census", async () => {
    const packs = Array.fromAsync(new Bun.Glob("pack-*.idx").scan({ cwd: join(gitDir(), "objects/pack") }));
    const names = await packs;
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const idx = parseIdx(Buffer.from(await Bun.file(join(gitDir(), "objects/pack", name)).arrayBuffer()));
      const out = git(fx.dir, ["verify-pack", "-v", join(gitDir(), "objects/pack", name.replace(/\.idx$/, ".pack"))]);
      const lines = out.split("\n").filter((l) => /^[0-9a-f]{40}/.test(l));
      expect(idx.count).toBe(lines.length);
      // every sha+offset pair must match
      const byOffset = new Map<number, string>();
      for (const l of lines) {
        const [sha, , , , offStr] = l.trim().split(/\s+/);
        byOffset.set(Number(offStr), sha!);
      }
      for (let i = 0; i < idx.count; i++) {
        expect(byOffset.get(idx.offsets[i]!)).toBe(idx.shas[i]);
      }
    }
  });

  test("every packed object matches cat-file (including deltas)", async () => {
    const packDir = join(gitDir(), "objects/pack");
    const names = await Array.fromAsync(new Bun.Glob("pack-*.idx").scan({ cwd: packDir }));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const idxBuf = Buffer.from(await Bun.file(join(packDir, name)).arrayBuffer());
      const idx = parseIdx(idxBuf);
      const packPath = join(packDir, name.replace(/\.idx$/, ".pack"));
      const packSize = (await Bun.file(packPath).stat())!.size;
      const pf = new PackFile(packPath, idx, packSize);
      await pf.load();

      const verify = git(fx.dir, ["verify-pack", "-v", packPath]);
      const deltas = new Map<string, string>(); // sha → real type for delta entries
      for (const l of verify.split("\n")) {
        const parts = l.trim().split(/\s+/);
        if (parts.length < 5 || !/^[0-9a-f]{40}$/.test(parts[0]!)) continue;
        if (parts.length >= 7) deltas.set(parts[0]!, parts[1]!);
      }
      expect(deltas.size).toBeGreaterThan(0); // fixture must actually contain deltas

      for (let i = 0; i < idx.count; i++) {
        const sha = idx.shas[i]!;
        const probe = await pf.probe(idx.offsets[i]!);
        const expectedType = deltas.get(sha);
        if (expectedType) expect(probe.type).toBe(expectedType);
        const obj = await pf.read(idx.offsets[i]!);
        const expected = catRaw(obj.type, sha);
        expect(Buffer.compare(obj.content, expected)).toBe(0);
        expect(obj.size).toBe(expected.length);
      }
    }
  });
});

describe("refs", () => {
  test("matches for-each-ref", async () => {
    const refs = await readRefs(gitDir());
    const out = git(fx.dir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const expected = new Map(out.trim().split("\n").map((l) => [l.split(" ")[0]!, l.split(" ")[1]!]));
    for (const r of refs) {
      const exp = expected.get(r.name);
      if (exp) expect(r.sha).toBe(exp); // symrefs (none here) are skipped by for-each-ref
    }
    const names = refs.map((r) => r.name);
    expect(names).toContain("refs/heads/main");
    expect(names).toContain("refs/heads/feature");
    expect(names).toContain("refs/tags/v1");
    expect(names).toContain("refs/tags/v2");
    const v2 = refs.find((r) => r.name === "refs/tags/v2")!;
    const tagObj = catFile(v2.sha).toString();
    expect(tagObj).toContain("object ");
  });

  test("HEAD points at refs/heads/main", async () => {
    const head = await readHead(gitDir());
    expect(head.ref).toBe("refs/heads/main");
  });
});

describe("index", () => {
  test("matches ls-files --stage", async () => {
    const buf = Buffer.from(await Bun.file(join(gitDir(), "index")).arrayBuffer());
    const idx = parseIndex(buf, 20); // 20 raw bytes per sha1
    expect(idx.checksumOk).toBe(true);
    const out = git(fx.dir, ["ls-files", "--stage"]);
    const expected = new Map(
      out.trim().split("\n").map((l) => {
        const [mode, sha, stage, ...path] = l.trim().split(/\s+/);
        return [path.join(" "), { mode, sha, stage: Number(stage) }];
      }),
    );
    expect(idx.entries.length).toBe(expected.size);
    for (const e of idx.entries) {
      const exp = expected.get(e.path)!;
      expect(e.sha).toBe(exp.sha);
      expect(e.stage).toBe(exp.stage);
      expect(BigInt("0o" + e.mode)).toBe(BigInt("0o" + exp.mode));
    }
  });
});

describe("object payloads", () => {
  test("commit fields", () => {
    const c = parseCommit(catFile(fx.shas.merge));
    expect(c.parents.length).toBe(2);
    expect(c.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(c.author.name).toBe("Fixture");
  });

  test("tree entries", async () => {
    const commit = parseCommit(catFile(fx.shas.initial));
    const tree = parseTree(catRaw("tree", commit.tree), 20);
    const names = tree.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["README.md", "src", "big.txt", "img.png"]));
    const src = tree.find((e) => e.name === "src")!;
    expect(src.kind).toBe("tree");
    const png = tree.find((e) => e.name === "img.png")!;
    expect(png.kind).toBe("blob");
    expect(png.mode).toBe("100644");
  });

  test("annotated tag", async () => {
    const refs = await readRefs(gitDir());
    const v2 = refs.find((r) => r.name === "refs/tags/v2")!;
    const t = parseTag(catFile(v2.sha));
    expect(t.tag).toBe("v2");
    expect(t.message.trim()).toBe("release v2");
    expect(t.object).toBe(fx.shas.merge);
  });
});

describe("config", () => {
  test("core section", async () => {
    const cfg = parseConfig(await Bun.file(join(gitDir(), "config")).text());
    expect(cfg.get("core")!.get("repositoryformatversion")).toBe("0");
  });
});

describe("diff", () => {
  test("reconstructs b from a via ops", () => {
    const a = ["one", "two", "three", "four"];
    const b = ["one", "two+", "three", "five", "six", "four"];
    const ops = diffLines(a, b);
    const out: string[] = [];
    for (const op of ops) {
      if (op.t === "eq") out.push(a[op.a]!);
      else if (op.t === "ins") out.push(b[op.b]!);
    }
    expect(out).toEqual(b);
  });

  test("common prefix/suffix preserved", () => {
    const a = ["x", "y", "old", "z"];
    const b = ["x", "y", "new", "z"];
    const ops = diffLines(a, b);
    expect(ops[0]).toEqual({ t: "eq", a: 0, b: 0 });
    expect(ops.at(-1)).toEqual({ t: "eq", a: 3, b: 3 });
  });

  test("large-ish input stays fast and correct", () => {
    const a = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const b = [...a.slice(0, 2000), "inserted", ...a.slice(2000).map((l, i) => (i === 500 ? `edited ${l}` : l))];
    const ops = diffLines(a, b);
    const out: string[] = [];
    for (const op of ops) {
      if (op.t === "eq") out.push(a[op.a]!);
      else if (op.t === "ins") out.push(b[op.b]!);
    }
    expect(out).toEqual(b);
  });
});
