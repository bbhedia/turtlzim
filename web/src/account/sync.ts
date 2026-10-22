// Keeping a notebook on the account server: what is compared, and what is decided. A linked notebook remembers the revision it last agreed with the server on and a digest of
// its own files at that moment; from those two and what the server says now, there is only one answer (nothing to do, send, fetch, or both changed). Nothing here touches the
// screen or the stores: the app asks, then does. Only open notebooks are ever kept on the server: an encrypted notebook goes nowhere but the vault.
import type { ImportedFile } from "../notebook/zim-files";
import type { ZipEntry } from "../zip";
import type { WireFile } from "./client";

/** What a notebook remembers of its last agreement with the server. */
export interface Link {
  remoteId: string;
  /** Where the copy is: the account's own space (nothing here), or a folder of a service that was connected. */
  target?: { kind: "connector"; connectorId: number; dir: string };
  /** The version of the copy then: the server's revision (a number) for the account's space, a mark of the folder (a string) for a service. */
  revision: number | string;
  /** A digest of each of this notebook's files when it last agreed with the other copy (the base that this side's changes are told from). */
  files?: Record<string, string>;
  /** The other copy's mark for each of its files then (the base that its changes are told from). */
  marks?: Record<string, string>;
  /** The other copy is a sealed one: an encrypted notebook, whose pages are kept as objects that only this account's key opens (sealed-remote.ts). */
  sealed?: boolean;
  /** For a sealed copy: the highest counter of its index that this device has seen, so that an old copy put back is noticed. */
  counter?: number;
  /** The generation of the server's data then (only for a copy in the account's own space, and only from a server that says it): see `wentBack`. */
  epoch?: string;
  /** The digest of the notebook's files then. */
  digest: string;
  /** Whose account (the e-mail address): a link made under another account is not this person's. */
  account: string;
}

export type Decision = "nothing" | "send" | "fetch" | "conflict";

/** What the two copies have to be told about one file, once the base they last agreed on is known. */
export type PathAction = "push" | "pushDelete" | "pull" | "pullDelete" | "conflict" | "settled";

/** The files of the notebook as the last agreement left them: this side's digest of each, and the other side's mark of each. */
export interface MergeBase {
  local: Record<string, string>;
  remote: Record<string, string>;
}

/**
 * Tell, for each file, what changed since the base on each side, and so what to do: nothing (left out), send it, delete it there, bring it here, delete it here, or ask (both sides
 * changed it); and "settled" for what both sides deleted (nothing to move, but the base must forget it). A file changed on one side only goes to the other; changed on both is a conflict.
 * (A file the other side has that this side never took in, a hidden file, say, is unchanged on both sides as long as its mark is the one remembered: it is never deleted.)
 */
export function planMerge(base: MergeBase, local: Record<string, string>, remote: Record<string, string>): Array<{ path: string; action: PathAction }> {
  const paths = new Set([...Object.keys(base.local), ...Object.keys(base.remote), ...Object.keys(local), ...Object.keys(remote)]);
  const plan: Array<{ path: string; action: PathAction }> = [];
  for (const path of [...paths].sort()) {
    const mine = local[path];
    const theirs = remote[path];
    const mineChanged = mine !== base.local[path];
    const theirsChanged = theirs !== base.remote[path];
    if (!mineChanged && !theirsChanged) continue;
    if (mineChanged && !theirsChanged) plan.push({ path, action: mine === undefined ? "pushDelete" : "push" });
    else if (!mineChanged && theirsChanged) plan.push({ path, action: theirs === undefined ? "pullDelete" : "pull" });
    else plan.push({ path, action: mine === undefined && theirs === undefined ? "settled" : "conflict" });
  }
  return plan;
}

/**
 * Whether the other copy has gone back in time since this device last agreed with it: the server's data was put back to an older state (restored from a backup). That shows as another
 * generation of its data than the one remembered (the server makes a new one at a restore), or, from a server that does not say, as a revision lower than the one remembered. Only a copy in
 * the account's own space can: a service's copy is not the server's data, and a sealed copy checks its own counter (sealed-remote.ts) and refuses what is older than it has seen.
 */
export function wentBack(link: Pick<Link, "revision" | "epoch" | "sealed" | "target">, now: { version: number | string; epoch?: string }): boolean {
  if (link.sealed || link.target) return false;
  if (link.epoch !== undefined && now.epoch !== undefined && now.epoch !== link.epoch) return true;
  return typeof link.revision === "number" && typeof now.version === "number" && now.version < link.revision;
}

/**
 * The base for a link: what was remembered at the last agreement; for a link made before pages were told apart, what can be worked out. A copy that has not changed since (this side:
 * the whole digest is the one remembered; the other: its version is) is its own base; one that has changed has no known base, so every file that differs is then a conflict, which is asked about.
 * A copy that went back in time (`wentBack`) has no base that can be trusted either, on either side: what was agreed is not what it holds now, so every page is told from nothing. A page that
 * only one side has is sent or brought, a page that both have and that differs is asked about, a page that both have the same is left alone, and **nothing is deleted** by either side.
 */
export function baseOf(link: Pick<Link, "files" | "marks" | "digest" | "revision">, local: Record<string, string>, whole: string, version: number | string, marks: Record<string, string>, back = false): MergeBase {
  if (back) return { local: {}, remote: {} };
  return {
    local: link.files ?? (whole === link.digest ? local : {}),
    remote: link.marks ?? (version === link.revision ? marks : {}),
  };
}

/** Where the other copy of a conflicting file is kept here, beside the file: `Help/Page.txt` becomes `Help/Page_(conflict_copy).txt` (the page “Page (conflict copy)”). */
export function conflictCopyPath(path: string, taken: (path: string) => boolean): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const [stem, ext] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 1; ; n++) {
    const candidate = `${stem}_(conflict_copy${n > 1 ? `_${n}` : ""})${ext}`;
    if (!taken(candidate)) return candidate;
  }
}

/** What to do, given the link, the digest of the notebook now and the server's revision now. */
export function decide(link: Pick<Link, "revision" | "digest">, localDigest: string, remoteRevision: number | string): Decision {
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

/** A digest of each file, by its path (what a service has to be sent is what changed). */
export async function fileDigests(entries: ZipEntry[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", entry.bytes as BufferSource));
    out[entry.path] = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return out;
}

/** A folder name for a notebook on a service: its title, made safe, and a short random part so that two notebooks of one name do not meet. */
export function folderNameFor(title: string): string {
  const slug = title.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[._\s]+|\s+$/g, "").slice(0, 60) || "notebook";
  return `${slug}-${newRemoteId().slice(0, 6)}`;
}

/** A new id for a notebook on the server (the server asks for 8 to 64 of letters, digits, `_` and `-`). */
export function newRemoteId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
