// Builds a real repository with git itself, so parsers can be checked
// against git's own output (cat-file, verify-pack, ls-files, for-each-ref).

import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Fixture {
  dir: string;
  shas: Record<string, string>;
  dispose(): void;
}

const AUTHOR = ["-c", "user.name=Fixture", "-c", "user.email=fixture@test", "-c", "commit.gpgsign=false"];

export function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const res = spawnSync("git", [...AUTHOR, ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T10:00:00+08:00", GIT_COMMITTER_DATE: "2026-01-01T10:00:00+08:00", ...env },
    encoding: "buffer",
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
  return res.stdout.toString();
}

export function buildFixture(base: string, name = "fixture"): Fixture {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const shas: Record<string, string> = {};

  git(dir, ["init", "-b", "main"]);

  const write = (rel: string, content: string | Buffer) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  const commit = (msg: string, date: string) => {
    git(dir, ["commit", "-m", msg], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  };

  write("README.md", "# fixture\n\nA repository built for gitv parser tests.\n");
  write("src/a.ts", "export const a = 1;\nexport const b = 2;\n");
  write("src/b.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  write("big.txt", Array.from({ length: 6000 }, (_, i) => `line ${i}: ${"x".repeat(i % 40)}`).join("\n") + "\n");
  write("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0xff, 0xee]));
  git(dir, ["add", "-A"]);
  commit("initial commit", "2026-01-01T10:00:00+08:00");
  shas.initial = git(dir, ["rev-parse", "HEAD"]).trim();

  // 20 near-identical files committed one by one → guaranteed delta chains on repack
  for (let i = 0; i < 20; i++) {
    write(`docs/notes-${String(i).padStart(2, "0")}.txt`, `version ${i}\n` + Array.from({ length: 200 }, (_, k) => `note line ${k} for version ${i} with some filler text`).join("\n"));
    git(dir, ["add", "-A"]);
    commit(`notes v${i}`, `2026-01-02T10:${String(i).padStart(2, "0")}:00+08:00`);
  }
  shas.notes = git(dir, ["rev-parse", "HEAD"]).trim();

  git(dir, ["checkout", "-b", "feature"]);
  write("src/a.ts", "export const a = 1;\nexport const b = 2;\nexport const feature = true;\n");
  git(dir, ["add", "-A"]);
  commit("feature work", "2026-01-03T10:00:00+08:00");
  shas.feature = git(dir, ["rev-parse", "HEAD"]).trim();

  git(dir, ["checkout", "main"]);
  write("README.md", "# fixture\n\nA repository built for gitv parser tests.\n\nEdited on main.\n");
  git(dir, ["add", "-A"]);
  commit("main edit", "2026-01-04T10:00:00+08:00");
  shas.mainEdit = git(dir, ["rev-parse", "HEAD"]).trim();

  git(dir, ["merge", "--no-ff", "feature", "-m", "merge feature"], { GIT_AUTHOR_DATE: "2026-01-05T10:00:00+08:00", GIT_COMMITTER_DATE: "2026-01-05T10:00:00+08:00" });
  shas.merge = git(dir, ["rev-parse", "HEAD"]).trim();

  git(dir, ["tag", "v1"]);
  git(dir, ["tag", "-a", "v2", "-m", "release v2"]);

  // pack everything reachable, deep delta chains
  git(dir, ["repack", "-adf", "--window=20", "--depth=20"]);

  // ...then make a fresh commit so loose objects exist alongside the pack
  write("loose.txt", "created after the repack\n");
  git(dir, ["add", "-A"]);
  commit("loose commit", "2026-01-06T10:00:00+08:00");
  shas.loose = git(dir, ["rev-parse", "HEAD"]).trim();

  return {
    dir,
    shas,
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
