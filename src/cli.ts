// gitv — see your .git, every byte, every object, live.

import { resolve } from "node:path";
import { serve } from "./server.ts";

const VERSION = "0.1.0";

function usage(): string {
  return `gitv ${VERSION} — visualize a git repository, live

usage: gitv [serve] [path] [options]

  path          repository path (default: current directory)
  --port N      port to listen on (default 8177)
  --no-open     do not open the browser
  -h, --help    show this help
  -v, --version print version

https://github.com/ykunyao/gitv`;
}

export function parseArgs(argv: string[]): { path: string; port: number; open: boolean; help: boolean; version: boolean } {
  const out = { path: ".", port: 8177, open: true, help: false, version: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "--port") out.port = Number(argv[++i] ?? 8177);
    else if (a.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (a === "--no-open") out.open = false;
    else rest.push(a);
  }
  if (rest[0] === "serve") rest.shift();
  out.path = rest[0] ?? ".";
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  const path = resolve(args.path);
  try {
    const handle = await serve(path, args.port);
    console.log(`gitv  →  ${handle.url}  (${path})`);
    if (args.open) openBrowser(handle.url);
    // keep alive until interrupted
    await new Promise<void>(() => {});
    return 0;
  } catch (e) {
    if (e instanceof Error && e.message.includes("not a git repository")) {
      console.error(`gitv: ${e.message}`);
      return 1;
    }
    console.error("gitv:", e);
    return 1;
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    /* browser opening is best-effort */
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
