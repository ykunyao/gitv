// Watches a repository (worktree + git dir) and reports changes.

import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

export interface RepoWatcher {
  close(): void;
}

export function watchRepo(worktree: string, gitDir: string, onChange: () => void, debounceMs = 120): RepoWatcher {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const kick = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  const add = (dir: string): void => {
    try {
      const w = watch(dir, { recursive: true }, (event, filename) => {
        // ignore our own churn and editor temp noise handled by debounce
        kick();
      });
      w.on("error", () => {
        // fall back to polling if the watch breaks (e.g. dir replaced)
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
  };
}
