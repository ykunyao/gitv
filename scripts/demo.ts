// Builds demo-repo/ — a small repository with everything gitv wants to show:
// branches, merges, tags (lightweight + annotated), renames, deletions,
// binary files, large text files, packed history and fresh loose commits.

import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = join(import.meta.dir, "..", "demo-repo");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const G = ["-c", "user.name=Demo Author", "-c", "user.email=demo@gitv.dev", "-c", "commit.gpgsign=false"];

function git(args: string[], date = "2026-03-01T09:00:00+08:00"): void {
  const res = spawnSync("git", [...G, ...args], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    encoding: "buffer",
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
}

const write = (rel: string, content: string | Buffer): void => {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
};

git(["init", "-b", "main"]);
writeFileSync(join(dir, ".gitignore"), "node_modules/\n*.log\n");
write("README.md", "# demo\n\nA repository to look at through gitv.\n");
write("src/server.ts", `import { serve } from "./lib.ts";\n\nconst PORT = 8177;\n\nserve({ port: PORT });\n\nconsole.log("listening on", PORT);\n`);
write("src/lib.ts", `export function serve(opts: { port: number }): void {\n  // pretend\n  void opts;\n}\n`);
git(["add", "-A"]);
git(["commit", "-m", "initial commit: server skeleton"]);

write("README.md", "# demo\n\nA repository to look at through gitv.\n\nSupports: branches, merges, tags.\n");
git(["add", "-A"]);
git(["commit", "-m", "docs: describe the demo"]);

// branch: feature lane
git(["checkout", "-b", "feature/canvas"]);
write("src/canvas.ts", `export class Canvas {\n  private ctx: CanvasRenderingContext2D;\n\n  constructor(el: HTMLCanvasElement) {\n    this.ctx = el.getContext("2d")!;\n  }\n\n  clear(): void {\n    this.ctx.clearRect(0, 0, 1e4, 1e4);\n  }\n}\n`);
git(["add", "-A"]);
git(["commit", "-m", "feat: canvas helper"]);
write("src/canvas.ts", `export class Canvas {\n  private ctx: CanvasRenderingContext2D;\n\n  constructor(el: HTMLCanvasElement) {\n    this.ctx = el.getContext("2d")!;\n  }\n\n  clear(): void {\n    this.ctx.clearRect(0, 0, 1e4, 1e4);\n  }\n\n  dot(x: number, y: number, r: number): void {\n    this.ctx.beginPath();\n    this.ctx.arc(x, y, r, 0, Math.PI * 2);\n    this.ctx.fill();\n  }\n}\n`);
git(["add", "-A"]);
git(["commit", "-m", "feat: canvas dot primitive"]);
git(["checkout", "main"]);

write("src/server.ts", `import { serve } from "./lib.ts";\n\nconst PORT = 9000;\n\nserve({ port: PORT });\n\nconsole.log("listening on", PORT);\n`);
git(["add", "-A"]);
git(["commit", "-m", "chore: bump default port"]);

git(["merge", "--no-ff", "feature/canvas", "-m", "merge feature/canvas"]);

git(["tag", "v0.1"]);
write("src/lib.ts", `export function serve(opts: { port: number }): void {\n  // pretend harder\n  void opts;\n}\n\nexport function shutdown(): void {\n  process.exit(0);\n}\n`);
git(["add", "-A"]);
git(["commit", "-m", "feat: shutdown hook"]);

// rename + delete
git(["mv", "src/lib.ts", "src/runtime.ts"]);
write("README.md", "# demo\n\nA repository to look at through gitv.\n\nSupports: branches, merges, tags, renames, deletions.\n");
git(["add", "-A"]);
git(["commit", "-m", "refactor: lib.ts → runtime.ts"]);
git(["rm", "src/canvas.ts"]);
git(["commit", "-m", "chore: drop canvas experiment"]);
git(["tag", "-a", "v0.2", "-m", "second cut — stable enough for a demo"]);

// binary + big text (they will be loose until the repack below)
const png = Buffer.alloc(2048);
png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
for (let i = 8; i < png.length; i++) png[i] = (i * 7 + (i % 13) * 19) & 0xff;
write("assets/logo.png", png);
const bigLines: string[] = [];
for (let i = 0; i < 20000; i++) bigLines.push(`${i}\t${"lorem ipsum dolor sit amet ".repeat(2)}${i % 97}`);
write("data/words.txt", bigLines.join("\n") + "\n");
git(["add", "-A"]);
git(["commit", "-m", "data: corpus and logo"]);

// pack the past, keep the future loose
git(["repack", "-adf", "--window=20", "--depth=20"]);

write("TODO.md", "# next\n\n- [ ] packfile inspector\n- [ ] drag ghosts back into history\n");
write("src/watch.ts", `export function watch(dir: string): void {\n  void dir;\n}\n`);
git(["add", "-A"]);
git(["commit", "-m", "feat: watcher skeleton (loose objects)"]);

// some working-tree noise for the status flow
write("src/wip.ts", "export const wip = true;\n");
write("README.md", "# demo\n\nA repository to look at through gitv.\n\nSupports: branches, merges, tags, renames, deletions.\n\nWork in progress.\n");

console.log("demo-repo ready at", dir);
