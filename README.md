# gitv

**See your `.git` — every byte, every object, live.**

gitv is a git repository visualizer. It reads the real files on disk — loose
objects, packfiles, the index, refs — parses them byte by byte, and lays the
whole object database out in a bright, minimal, draggable scene. It watches
the repository; when you commit, branch, stage, or rewrite history, the scene
animates the change as it happens.

Work in progress. Powered by [Bun](https://bun.sh).

```sh
bun run src/cli.ts serve path/to/repo
```

MIT licensed.
