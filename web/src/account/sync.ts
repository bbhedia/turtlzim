// Keeping a notebook on the account server: what is compared, and what is decided. A linked notebook remembers the revision it last agreed with the server on and a digest of
// its own files at that moment; from those two and what the server says now, there is only one answer (nothing to do, send, fetch, or both changed). Nothing here touches the
// screen or the stores: the app asks, then does. Only open notebooks are ever kept on the server: an encrypted notebook goes nowhere but the vault.
import type { ImportedFile } from "../notebook/zim-files";
import type { ZipEntry } from "../zip";
import type { WireFile } from "./client";

/** What a notebook remembers of its last agreement with the server. */
export interface Link {
  remoteId: string;
  /** The server's revision then. */
  revision: number;
  /** The digest of the notebook's files then. */
  digest: string;
  /** Whose account (the e-mail address): a link made under another account is not this person's. */
  account: string;
}

export type Decision = "nothing" | "send" | "fetch" | "conflict";

/** What to do, given the link, the digest of the notebook now and the server's revision now. */
export function decide(link: Pick<Link, "revision" | "digest">, localDigest: string, remoteRevision: number): Decision {
  const localChanged = localDigest !== link.digest;
  const remoteChanged = remoteRevision !== link.revision;
  if (localChanged && remoteChanged) return "conflict";
  if (localChanged) return "send";
  if (remoteChanged) return "fetch";
  return "nothing";
}

/** A digest of a notebook's files: their paths and bytes, in the order of the paths (so the order they were listed in does not matter). */
export async function digestOf(entries: ZipEntry[]): Promise<string> {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    const path = encoder.encode(entry.path);
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, path.length);
    new DataView(head.buffer).setUint32(4, entry.bytes.length);
    parts.push(head, path, entry.bytes);
  }
  const all = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", all as BufferSource));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toWire(entries: ZipEntry[]): WireFile[] {
  return entries.map((entry) => {
    let binary = "";
    for (let i = 0; i < entry.bytes.length; i += 0x8000) binary += String.fromCharCode(...entry.bytes.subarray(i, i + 0x8000));
    return { path: entry.path, base64: btoa(binary) };
  });
}

export function fromWire(files: WireFile[]): ImportedFile[] {
  return files.map((file) => {
    const binary = atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { path: file.path, bytes };
  });
}

/** A new id for a notebook on the server (the server asks for 8 to 64 of letters, digits, `_` and `-`). */
export function newRemoteId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
