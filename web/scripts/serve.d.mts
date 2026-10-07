import type { Server } from "node:http";

export function createStaticServer(options: { dir: string; auth?: string; log?: (line: string) => void; tls?: { key: Buffer | string; cert: Buffer | string }; authority?: Buffer | string }): Server;
export function urlsFor(host: string, port: number, scheme?: "http" | "https"): string[];
export function certificateName(name: string): string;
export function selfSignedCertificate(
  directory?: string,
  extraNames?: string[],
): { key: Buffer; cert: Buffer; authority: Buffer; authorityFile: string; fingerprint: string; names: string[] };
