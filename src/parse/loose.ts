// Loose objects: .git/objects/ab/cdef... — a single zlib stream whose
// decompressed bytes are "<type> <size>\0<payload>".

import { inflateSync } from "node:zlib";
import type { ObjType } from "../model.ts";
import { isHex } from "../gitformat.ts";

export interface LooseRead {
  type: ObjType;
  size: number;
  content: Buffer; // payload only (after the NUL)
  headerLen: number; // bytes of "<type> <size>\0" inside the inflated stream
  inflated: Buffer; // full inflated stream (header + payload)
  compressedSize: number;
}

export function inflateLoose(fileBuf: Buffer): LooseRead {
  const inflated = inflateSync(fileBuf);
  const nul = inflated.indexOf(0);
  if (nul < 0) throw new Error("loose object: missing header NUL");
  const header = inflated.subarray(0, nul).toString("latin1");
  const sp = header.indexOf(" ");
  if (sp < 0) throw new Error(`loose object: bad header "${header}"`);
  const type = header.slice(0, sp) as ObjType;
  const size = Number.parseInt(header.slice(sp + 1), 10);
  if (!["commit", "tree", "blob", "tag"].includes(type)) throw new Error(`loose object: unknown type "${type}"`);
  const content = inflated.subarray(nul + 1);
  if (content.length !== size) throw new Error(`loose object: header says ${size}, got ${content.length}`);
  return { type, size, content, headerLen: nul + 1, inflated, compressedSize: fileBuf.length };
}

/** Walk .git/objects and collect every loose object. */
export async function scanLoose(objectsDir: string, shaLen: number): Promise<{ sha: string; file: string; size: number }[]> {
  const out: { sha: string; file: string; size: number }[] = [];
  let dirs: string[];
  try {
    dirs = [...new Bun.Glob("*").scanSync({ cwd: objectsDir, onlyFiles: false })];
  } catch {
    return out;
  }
  await Promise.all(
    dirs.map(async (d) => {
      if (d.length !== 2 || !isHex(d)) return;
      const fan = `${objectsDir}/${d}`;
      let files: string[];
      try {
        files = [...new Bun.Glob("*").scanSync({ cwd: fan, onlyFiles: true })];
      } catch {
        return;
      }
      for (const f of files) {
        const restLen = shaLen - 2;
        if (f.length === restLen && isHex(f)) {
          const full = `${fan}/${f}`;
          const st = await Bun.file(full).stat();
          if (st) out.push({ sha: d + f, file: `objects/${d}/${f}`, size: st.size });
        }
      }
    }),
  );
  return out;
}
