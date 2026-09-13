// Watches a repository (worktree + git dir) and reports changes.

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

export interface RepoWatcher {
  close(): void;
  /** Suppress change events for a while (used while gitv itself scans). */
  muteFor(ms: number): void;
}

export function watchRepo(worktree: string, gitDir: string, onChange: () => void, debounceMs = 120): RepoWatcher {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let mutedUntil = 0;

  const kick = (): void => {
    if (closed || Date.now() < mutedUntil) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  // git's own *.lock files flicker on every git invocation; reacting to them
  // creates a scan → status → index.lock → scan feedback loop.
  const isNoise = (filename: string | null): boolean => !!filename && String(filename).endsWith(".lock");

  const add = (dir: string): void => {
    try {
      const w = watch(dir, { recursive: true }, (event, filename) => {
        if (isNoise(filename)) return;
        kick();
      });
      w.on("error", () => {
        if (!poller) poller = setInterval(kick, 1500);
      });
      watchers.push(w);
    } catch {
      if (!poller) poller = setInterval(kick, 1500);
    }
  };

  add(worktree);
  const same = resolve(worktree).toLowerCase() === resolve(gitDir).toLowerCase();
  if (!same) add(gitDir);

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      for (const w of watchers) w.close();
    },
    muteFor(ms) {
      mutedUntil = Date.now() + ms;
    },
  };
}
