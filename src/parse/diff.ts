// Line diff: Myers O(ND) with prefix/suffix trimming and a safety fallback.

export type DiffOp = { t: "eq" | "ins" | "del"; a: number; b: number }; // line indices (0-based); unused side is -1

const MAX_D = 1200; // beyond this we fall back to a coarse replace

export function diffLines(a: string[], b: string[]): DiffOp[] {
  const ops: DiffOp[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  for (let i = 0; i < start; i++) ops.push({ t: "eq", a: i, b: i });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  for (const op of myers(midA, midB)) {
    ops.push({ t: op.t, a: op.a < 0 ? -1 : op.a + start, b: op.b < 0 ? -1 : op.b + start });
  }

  const tailB = endB;
  for (let i = endA; i < a.length; i++) ops.push({ t: "eq", a: i, b: tailB + (i - endA) });
  return ops;
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((_, j) => ({ t: "ins" as const, a: -1, b: j }));
  if (m === 0) return a.map((_, i) => ({ t: "del" as const, a: i, b: -1 }));
  if (n + m > 60000) return coarse(a, b);

  const max = n + m;
  const v = new Int32Array(2 * max + 1);
  const offset = max;
  const trace: Int32Array[] = [];

  let foundD = -1;
  outer: for (let d = 0; d <= Math.min(MAX_D, max); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { foundD = d; break outer; }
    }
  }

  if (foundD < 0) return coarse(a, b);

  // Backtrack from (n, m) to (0, 0).
  const path: DiffOp[] = [];
  let x = n, y = m;
  for (let d = foundD; d >= 1; d--) {
    const vPrev = trace[d]!; // V state after iteration d-1
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[offset + k - 1]! < vPrev[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vPrev[offset + prevK]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) { path.push({ t: "eq", a: x - 1, b: y - 1 }); x--; y--; }
    if (x === prevX) { path.push({ t: "ins", a: -1, b: y - 1 }); y--; }
    else { path.push({ t: "del", a: x - 1, b: -1 }); x--; }
  }
  while (x > 0 && y > 0 && a[x - 1] === b[y - 1]) { path.push({ t: "eq", a: x - 1, b: y - 1 }); x--; y--; }
  while (y > 0) { path.push({ t: "ins", a: -1, b: y - 1 }); y--; }
  while (x > 0) { path.push({ t: "del", a: x - 1, b: -1 }); x--; }

  path.reverse();
  return path;
}

function coarse(a: string[], b: string[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (let i = 0; i < a.length; i++) out.push({ t: "del", a: i, b: -1 });
  for (let j = 0; j < b.length; j++) out.push({ t: "ins", a: -1, b: j });
  return out;
}
