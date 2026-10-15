import type { IncomingMessage, Server, ServerResponse } from "node:http";

export function downloadOption(text: string): { path: string; file: string };
export function createStaticServer(options: { dir: string; auth?: string; log?: (line: string) => void; tls?: { key: Buffer | string; cert: Buffer | string }; authority?: Buffer | string; downloads?: Array<{ path: string; file: string }>; api?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean }): Server;
/** What the page may load and do: the server sends it as a header, and the app's shell (mobile/) puts the same in the page. */
export const CONTENT_SECURITY_POLICY: string;
export function urlsFor(host: string, port: number, scheme?: "http" | "https"): string[];
export function certificateName(name: string): string;
export function selfSignedCertificate(
  directory?: string,
  extraNames?: string[],
): { key: Buffer; cert: Buffer; authority: Buffer; authorityFile: string; fingerprint: string; names: string[] };
