// Scan performance harness: times a cold scan of tmp/big-repo.
import { RepoScanner } from "../src/scan/repo.ts";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "tmp", "big-repo");

let t0 = performance.now();
const s = new RepoScanner();
s.worktree = dir;
const model = await s.scan();
const t1 = performance.now();
console.log(`cold scan: ${(t1 - t0).toFixed(0)} ms`);
console.log(`  objects: ${model.counts.objectsTotal} (loose ${model.counts.loose}, packed ${model.counts.packed})`);
console.log(`  commits laid out: ${model.commits.length} complete=${model.commitsComplete}`);
console.log(`  index entries: ${model.index.entries.length}`);

t0 = performance.now();
const warm = await s.scan();
const t2 = performance.now();
console.log(`warm scan: ${(t2 - t0).toFixed(0)} ms (objects=${warm.counts.objectsTotal})`);

t0 = performance.now();
const detail = await s.objectDetail(model.commits[500]!.sha);
const t3 = performance.now();
console.log(`object detail: ${(t3 - t0).toFixed(1)} ms (type=${detail!.type})`);

const packed = model.objects.find((o) => o.delta && o.type === "blob");
if (packed) {
  t0 = performance.now();
  await s.objectDetail(packed.sha);
  console.log(`delta blob detail: ${(performance.now() - t0).toFixed(1)} ms`);
}
