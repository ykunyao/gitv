// Builds tmp/big-repo — a synthetic but realistic mid-size repository
// used to sanity-check scan performance.

import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = join(import.meta.dir, "..", "tmp", "big-repo");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const G = ["-c", "user.name=Big", "-c", "user.email=big@test"];

function git(args: string[]): void {
  const res = spawnSync("git", [...G, ...args], { cwd: dir, encoding: "buffer" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

git(["init", "-b", "main"]);

const FILES = 80;
const COMMITS = 1500;
let clock = Date.UTC(2024, 0, 1) / 1000;

const dateEnv = (t: number): Record<string, string> => ({
  GIT_AUTHOR_DATE: `${t} +0800`,
  GIT_COMMITTER_DATE: `${t} +0800`,
});

function commitAll(msg: string, t: number): void {
  const res = spawnSync("git", [...G, "commit", "-m", msg], {
    cwd: dir,
    encoding: "buffer",
    env: { ...process.env, ...dateEnv(t) },
  });
  if (res.status !== 0) throw new Error(`commit: ${res.stderr.toString()}`);
}

// initial tree
for (let f = 0; f < FILES; f++) {
  mkdirSync(join(dir, "src", `mod${f % 8}`), { recursive: true });
  writeFileSync(join(dir, "src", `mod${f % 8}`, `file${f}.ts`), `export const f${f} = ${f};\n`);
}
git(["add", "-A"]);
commitAll("initial", clock);

for (let c = 1; c <= COMMITS; c++) {
  clock += 60;
  const f = c % FILES;
  const p = join(dir, "src", `mod${f % 8}`, `file${f}.ts`);
  writeFileSync(p, `export const f${f} = ${f};\n// rev ${c}\n${"context line\n".repeat((c % 40) + 5)}`);
  if (c % 97 === 0) {
    writeFileSync(join(dir, "src", `mod${f % 8}`, `new${c}.ts`), `export const n${c} = true;\n`);
  }
  git(["add", "-A"]);
  commitAll(`change file${f} (rev ${c})`, clock);
  if (c % 500 === 0) git(["tag", `t${c}`]);
}

git(["repack", "-adf", "--window=20", "--depth=20"]);
console.log("big-repo ready:", dir);
