// Byte-level helpers shared by the parsers. Everything here works on raw
// bytes exactly as they sit in .git — no libgit2, no shelling out.

import type { ObjType } from "../model.ts";

export const PACK_TYPE_NAMES: Record<number, string> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
  6: "ofs-delta",
  7: "ref-delta",
};

export function packTypeToObjType(t: number): ObjType | null {
  if (t === 1) return "commit";
  if (t === 2) return "tree";
  if (t === 3) return "blob";
  if (t === 4) return "tag";
  return null;
}

export function toHex(bytes: Uint8Array, start = 0, len = bytes.length - start): string {
  let out = "";
  for (let i = start; i < start + len; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

export function isHex(s: string, len?: number): boolean {
  if (len !== undefined && s.length !== len) return false;
  return /^[0-9a-f]+$/.test(s);
}

/** OFS_DELTA-style varint: 7-bit big-endian groups, each continuation biased +1. */
export function readOfsVarint(buf: Uint8Array, pos: number): { value: number; read: number } {
  let c = buf[pos]!;
  let value = c & 0x7f;
  let read = 1;
  while (c & 0x80) {
    c = buf[pos + read]!;
    value = ((value + 1) << 7) | (c & 0x7f);
    read++;
  }
  return { value, read };
}

/** LSB-first 7-bit groups varint (used inside delta instructions). */
export function readLeVarint(buf: Uint8Array, pos: number): { value: number; read: number } {
  let value = 0;
  let shift = 0;
  let read = 0;
  for (;;) {
    const c = buf[pos + read]!;
    value |= (c & 0x7f) << shift;
    read++;
    if (!(c & 0x80)) break;
    shift += 7;
  }
  return { value, read };
}

/** Binary-search in a sorted ascending number array; returns index or -1. */
export function bisect(arr: number[], x: number): number {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid]!;
    if (v === x) return mid;
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** First offset strictly greater than x in a sorted array (or arr.length). */
export function nextGreater(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
