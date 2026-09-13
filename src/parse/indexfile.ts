// .git/index (DIRC) versions 2, 3 and 4.

import { createHash } from "node:crypto";
import type { IndexEntry } from "../model.ts";
import { toHex, readOfsVarint } from "../gitformat.ts";

export interface ParsedIndex {
  version: number;
  entries: IndexEntry[];
  extensions: string[];
  checksumOk: boolean;
}

export function parseIndex(buf: Buffer, hashLen: number): ParsedIndex {
  if (buf.subarray(0, 4).toString("latin1") !== "DIRC") throw new Error("index: bad signature");
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  if (![2, 3, 4].includes(version)) throw new Error(`index: unsupported version ${version}`);

  const entries: IndexEntry[] = [];
  let p = 12;
  let prevPath = "";
  for (let i = 0; i < count; i++) {
    const start = p;
    const ctime = buf.readUInt32BE(p), mtime = buf.readUInt32BE(p + 8);
    const mode = buf.readUInt32BE(p + 24);
    const size = buf.readUInt32BE(p + 36);
    const sha = toHex(buf, p + 40, hashLen);
    const flags = buf.readUInt16BE(p + 40 + hashLen);
    p += 40 + hashLen + 2;
    let stage = (flags >> 12) & 3;
    if (version >= 3 && flags & 0x4000) {
      p += 2; // extended flags
    }

    let path: string;
    if (version >= 4) {
      const strip = readOfsVarint(buf, p);
      p += strip.read;
      const nul = buf.indexOf(0, p);
      const suffix = buf.subarray(p, nul).toString("utf8");
      p = nul + 1;
      path = prevPath.slice(0, Math.max(0, prevPath.length - strip.value)) + suffix;
    } else {
      let nameLen = flags & 0xfff;
      if (nameLen === 0xfff) nameLen = buf.indexOf(0, p) - p;
      path = buf.subarray(p, p + nameLen).toString("utf8");
      p += nameLen;
      // entries are NUL-padded to a multiple of 8 bytes (incl. the 62-byte fixed part)
      const entryLen = p - start;
      p = start + Math.ceil((entryLen + 1) / 8) * 8;
    }
    prevPath = path;
    entries.push({ path, sha, mode: mode.toString(8), stage, size });
  }

  const extensions: string[] = [];
  let e = p;
  while (e + 8 <= buf.length - hashLen) {
    const sig = buf.subarray(e, e + 4).toString("latin1");
    const len = buf.readUInt32BE(e + 4);
    if (!/^[A-Z]{4}$/.test(sig)) break;
    extensions.push(sig);
    e += 8 + len;
  }

  const body = buf.subarray(0, buf.length - hashLen);
  const digest = createHash(hashLen === 20 ? "sha1" : "sha256").update(body).digest();
  const checksumOk = digest.equals(buf.subarray(buf.length - hashLen));

  return { version, entries, extensions, checksumOk };
}
