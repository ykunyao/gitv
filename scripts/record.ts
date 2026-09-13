// Records docs/live.gif: opens gitv on a fresh demo repo and drives real
// git activity — edit → add → commit → branch → merge — while capturing
// frames, then encodes them into an animated GIF.

import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = join(import.meta.dir, "..");
const DEMO = join(ROOT, "demo-repo");
const PORT = 8180;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

// fresh demo repo
rmSync(DEMO, { recursive: true, force: true });
spawnSync(process.execPath, ["run", "scripts/demo.ts"], { cwd: ROOT });

// server
const server = spawn(process.execPath, ["run", "src/cli.ts", "serve", DEMO, "--port", String(PORT), "--no-open"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/model`);
    if (r.ok) break;
  } catch { /* not up yet */ }
  await sleep(300);
}

// browser
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage({ viewport: { width: 1080, height: 700 } });
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".commit-row");
await sleep(1600);

// capture loop
const frames: { png: Buffer; at: number }[] = [];
let recording = true;
const recorder = (async (): Promise<void> => {
  while (recording) {
    const at = Date.now();
    const png = await page.screenshot({ type: "png" });
    frames.push({ png, at });
    await sleep(200);
  }
})();

const git = (args: string[]): void => {
  const r = spawnSync("git", ["-c", "user.name=Demo Author", "-c", "user.email=demo@gitv.dev", ...args], { cwd: DEMO, encoding: "buffer" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
};
const write = (rel: string, content: string): void => {
  writeFileSync(join(DEMO, rel), content);
};

// ---- the live story ----------------------------------------------------------

write("README.md", "# demo\n\nA repository to look at through gitv.\n\nSomeone is editing live right now.\n");
await sleep(1500); // unstaged chip appears

git(["add", "-A"]);
await sleep(1400); // chip hops to INDEX

git(["commit", "-m", "docs: live edit while watching"]);
await sleep(1700); // commit pops, main slides, HEAD moves

git(["checkout", "-b", "feature/live"]);
await sleep(900); // new branch pill

write("src/live.ts", "export const live = true;\nexport const energy = Infinity;\n");
git(["add", "-A"]);
git(["commit", "-m", "feat: live module"]);
await sleep(1500); // commits on a new lane

git(["checkout", "main"]);
await sleep(700);
git(["merge", "--no-ff", "feature/live", "-m", "merge feature/live"]);
await sleep(2000); // merge curve + both pills land

// ---- encode ------------------------------------------------------------------

recording = false;
await sleep(400);

const gif = GIFEncoder();
let last = frames[0]!.at;
for (const f of frames) {
  const png = PNG.sync.read(f.png);
  const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength);
  const palette = quantize(rgba, 256);
  const index = applyPalette(rgba, palette);
  gif.writeFrame(index, png.width, png.height, { palette, delay: Math.max(80, f.at - last) });
  last = f.at;
}
gif.finish();
mkdirSync(join(ROOT, "docs"), { recursive: true });
const out = gif.bytes();
writeFileSync(join(ROOT, "docs", "live.gif"), out);

await browser.close();
server.kill();

console.log(`live.gif: ${frames.length} frames, ${(out.length / 1024 / 1024).toFixed(2)} MB`);
