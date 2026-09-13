// Packfiles: .pack entries + .idx v2 lookup tables, including delta
// resolution (ofs-delta and ref-delta), all from raw bytes.

import { inflateSync, constants as ZLIB } from "node:zlib";
import type { ObjType } from "../model.ts";
import { PACK_TYPE_NAMES, packTypeToObjType, readOfsVarint, readLeVarint, toHex, nextGreater } from "../gitformat.ts";

const IDX_MAGIC = 0xff744f63; // \377tOc

export interface PackIndex {
  count: number;
  shas: string[]; // sorted, hex
  offsets: number[]; // parallel to shas, ascending
}

export function parseIdx(buf: Buffer, hashLen = 20): PackIndex {
  if (buf.readUInt32BE(0) !== IDX_MAGIC) throw new Error("pack index: only version 2 is supported");
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack index: unexpected version ${version}`);
  const count = buf.readUInt32BE(8 + 255 * 4);
  let p = 8 + 256 * 4;
  const shas: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    shas[i] = toHex(buf, p, hashLen);
    p += hashLen;
  }
  p += count * 4; // CRC32 table
  const largeSlots: number[] = []; // entries whose offset lives in the 64-bit table
  const largeIdx: number[] = []; // ...and their position in the offsets array
  const offsets: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const v = buf.readUInt32BE(p);
    p += 4;
    if (v & 0x80000000) {
      largeIdx.push(i);
      largeSlots.push(v & 0x7fffffff);
    } else {
      offsets[i] = v;
    }
  }
  if (largeIdx.length) {
    const tableStart = p;
    for (let k = 0; k < largeIdx.length; k++)
      offsets[largeIdx[k]!] = Number(buf.readBigUInt64BE(tableStart + largeSlots[k]! * 8));
  }
  return { count, shas, offsets };
}

export interface PackEntryHeader {
  type: number; // 1..4 solid, 6/7 delta
  typeName: string;
  size: number; // unpacked size of this entry (result size for deltas)
  headerLen: number;
  dataOff: number;
  baseOffset?: number; // ofs-delta
  baseSha?: string; // ref-delta, hex
}

export function parsePackEntryHeader(buf: Uint8Array, off: number, hashLen = 20): PackEntryHeader {
  let p = off;
  let c = buf[p]!;
  p++;
  const type = (c >> 4) & 7;
  let size = c & 0x0f;
  let shift = 4;
  while (c & 0x80) {
    c = buf[p]!;
    p++;
    size |= (c & 0x7f) << shift;
    shift += 7;
  }
  const h: PackEntryHeader = {
    type,
    typeName: PACK_TYPE_NAMES[type] ?? `type-${type}`,
    size,
    headerLen: p - off,
    dataOff: p,
  };
  if (type === 6) {
    const v = readOfsVarint(buf, p);
    h.baseOffset = off - v.value;
    h.headerLen += v.read;
    h.dataOff = p + v.read;
  } else if (type === 7) {
    h.baseSha = toHex(buf, p, hashLen);
    h.headerLen += hashLen;
    h.dataOff = p + hashLen;
  }
  return h;
}

/** Apply a git delta buffer (copy/insert instructions) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const srcSize = readLeVarint(delta, p);
  p += srcSize.read;
  if (srcSize.value !== base.length) throw new Error(`delta: base size ${srcSize.value} != ${base.length}`);
  const dstSize = readLeVarint(delta, p);
  p += dstSize.read;
  const out = Buffer.allocUnsafe(dstSize.value);
  let w = 0;
  while (p < delta.length) {
    const cmd = delta[p]!;
    p++;
    if (cmd & 0x80) {
      // copy from base: bits 0-3 select offset bytes, bits 4-6 select size bytes
      let off = 0, len = 0;
      let extra = 0;
      if (cmd & 0x01) { off |= delta[p + extra]!; extra++; }
      if (cmd & 0x02) { off |= delta[p + extra]! << 8; extra++; }
      if (cmd & 0x04) { off |= delta[p + extra]! << 16; extra++; }
      if (cmd & 0x08) { off |= delta[p + extra]! << 24; extra++; }
      if (cmd & 0x10) { len |= delta[p + extra]!; extra++; }
      if (cmd & 0x20) { len |= delta[p + extra]! << 8; extra++; }
      if (cmd & 0x40) { len |= delta[p + extra]! << 16; extra++; }
      p += extra;
      if (len === 0) len = 0x10000;
      if (off + len > base.length || w + len > out.length) throw new Error("delta: copy out of bounds");
      base.copy(out, w, off, off + len);
      w += len;
    } else if (cmd > 0) {
      if (w + cmd > out.length || p + cmd > delta.length) throw new Error("delta: insert out of bounds");
      delta.copy(out, w, p, p + cmd);
      w += cmd;
      p += cmd;
    } else {
      throw new Error("delta: reserved opcode 0");
    }
  }
  if (w !== out.length) throw new Error(`delta: wrote ${w}, expected ${out.length}`);
  return out;
}

/**
 * Random access to one pack file. Small packs live in memory; larger ones
 * are served through positioned slice reads.
 */
export class PackFile {
  readonly idx: PackIndex;
  private mem: Buffer | null = null;
  private refMap: Map<string, number> | null = null;
  private sortedOffsets: number[] | null = null;
  private file: ReturnType<typeof Bun.file>;

  constructor(readonly path: string, idx: PackIndex, readonly size: number, readonly hashLen = 20) {
    this.idx = idx;
    this.file = Bun.file(path);
  }

  private static readonly MEM_LIMIT = 160 * 1024 * 1024;

  async load(): Promise<void> {
    if (this.size <= PackFile.MEM_LIMIT && !this.mem) this.mem = Buffer.from(await this.file.arrayBuffer());
  }

  /** Raw bytes [off, off+len) from this pack. */
  getBytes = async (off: number, len: number): Promise<Buffer> => {
    if (this.mem) return this.mem.subarray(off, off + len);
    return Buffer.from(await this.file.slice(off, off + len).arrayBuffer());
  };

  async header(off: number): Promise<PackEntryHeader> {
    const head = await this.getBytes(off, 64);
    const h = parsePackEntryHeader(head, 0, this.hashLen);
    h.dataOff += off; // parsed relative to the slice; make absolute
    if (h.baseOffset !== undefined) h.baseOffset += off;
    return h;
  }

  /** End of the entry whose data starts at dataOff: the next entry's start
   * in FILE ORDER (idx offsets are sha-sorted, not offset-sorted!). */
  private entryEnd(dataOff: number): number {
    if (!this.sortedOffsets) this.sortedOffsets = [...this.idx.offsets].sort((a, b) => a - b);
    const k = nextGreater(this.sortedOffsets, dataOff);
    return k < this.sortedOffsets.length ? this.sortedOffsets[k]! : this.size - 20;
  }

  private resolveRef = async (sha: string): Promise<number> => {
    if (!this.refMap) {
      this.refMap = new Map();
      for (let i = 0; i < this.idx.count; i++) this.refMap.set(this.idx.shas[i]!, this.idx.offsets[i]!);
    }
    const off = this.refMap.get(sha);
    if (off === undefined) throw new Error(`ref-delta base ${sha} not found in ${this.path}`);
    return off;
  };

  /** Header-only walk of a delta chain: real type + final size, no inflating. */
  async probe(offset: number): Promise<{ type: ObjType; size: number; delta: boolean; chain: PackEntryHeader[] }> {
    const chain: PackEntryHeader[] = [];
    let cur = offset;
    for (let depth = 0; depth < 128; depth++) {
      const h = await this.header(cur);
      if (h.type === 6) {
        chain.push(h);
        cur = h.baseOffset!;
      } else if (h.type === 7) {
        chain.push(h);
        cur = await this.resolveRef(h.baseSha!);
      } else {
        const t = packTypeToObjType(h.type);
        if (!t) throw new Error(`bad pack type ${h.type}`);
        // For delta entries the header size is the *delta* size; the object's
        // real size is the target size varint at the start of the delta data.
        const outer = chain[0];
        const size = outer ? await this.deltaResultSize(outer) : h.size;
        return { type: t, size, delta: chain.length > 0, chain };
      }
    }
    throw new Error("delta chain too deep");
  }

  /** Partially inflate a delta to read its src/dst size varints. */
  async deltaResultSize(h: PackEntryHeader): Promise<number> {
    const head = await this.getBytes(h.dataOff, 256);
    const partial = inflateSync(head, { finishFlush: ZLIB.Z_SYNC_FLUSH });
    let p = 0;
    const src = readLeVarint(partial, p); p += src.read;
    const dst = readLeVarint(partial, p);
    return dst.value;
  }

  /**
   * Delta chain from the object at `offset` down to its solid base, with
   * every hop resolved to a sha, real type and sizes — raw bytes only.
   */
  async chainOf(offset: number): Promise<{
    entries: {
      sha: string | null;
      offset: number;
      role: "base" | "delta" | "self";
      type: ObjType;
      resultSize: number; // size of the object this entry reconstructs
      deltaSize: number | null; // uncompressed size of the delta instructions
      via: "ofs" | "ref" | null;
    }[];
  }> {
    const rev = new Map<number, string>();
    for (let i = 0; i < this.idx.count; i++) rev.set(this.idx.offsets[i]!, this.idx.shas[i]!);

    const entries: {
      sha: string | null;
      offset: number;
      role: "base" | "delta" | "self";
      type: ObjType;
      resultSize: number;
      deltaSize: number | null;
      via: "ofs" | "ref" | null;
    }[] = [];
    let cur = offset;
    for (let depth = 0; depth < 128; depth++) {
      const h = await this.header(cur);
      if (h.type === 6 || h.type === 7) {
        entries.push({
          sha: rev.get(cur) ?? null,
          offset: cur,
          role: entries.length === 0 ? "self" : "delta",
          type: "blob", // resolved once the base is known
          resultSize: await this.deltaResultSize(h),
          deltaSize: h.size,
          via: h.type === 6 ? "ofs" : "ref",
        });
        cur = h.type === 6 ? h.baseOffset! : await this.resolveRef(h.baseSha!);
      } else {
        const t = packTypeToObjType(h.type);
        if (!t) throw new Error(`bad pack type ${h.type}`);
        entries.push({
          sha: rev.get(cur) ?? null,
          offset: cur,
          role: "base",
          type: t,
          resultSize: h.size,
          deltaSize: null,
          via: null,
        });
        for (const e of entries) e.type = t;
        return { entries };
      }
    }
    throw new Error("delta chain too deep");
  }

  /** Fully resolve the object at offset, inflating and applying any delta chain. */
  async read(offset: number): Promise<{ type: ObjType; size: number; content: Buffer; chain: PackEntryHeader[] }> {
    const chain: PackEntryHeader[] = [];
    let cur = offset;
    for (let depth = 0; depth < 128; depth++) {
      const h = await this.header(cur);
      if (h.type === 6) {
        chain.push(h);
        cur = h.baseOffset!;
      } else if (h.type === 7) {
        chain.push(h);
        cur = await this.resolveRef(h.baseSha!);
      } else {
        const t = packTypeToObjType(h.type);
        if (!t) throw new Error(`bad pack type ${h.type}`);
        let content = await this.inflateRange(h.dataOff, this.entryEnd(h.dataOff), h.size);
        for (let i = chain.length - 1; i >= 0; i--) {
          const d = chain[i]!;
          const delta = await this.inflateRange(d.dataOff, this.entryEnd(d.dataOff));
          content = applyDelta(content, delta);
        }
        return { type: t, size: content.length, content, chain };
      }
    }
    throw new Error("delta chain too deep");
  }

  /** Inflate the zlib stream occupying [off, end); optionally verify size. */
  private async inflateRange(off: number, end: number, expect?: number): Promise<Buffer> {
    const raw = await this.getBytes(off, Math.max(0, end - off));
    const out = inflateSync(raw, { finishFlush: ZLIB.Z_SYNC_FLUSH });
    if (expect !== undefined && out.length !== expect)
      throw new Error(`pack entry: inflated ${out.length}, header said ${expect}`);
    return out;
  }
}
