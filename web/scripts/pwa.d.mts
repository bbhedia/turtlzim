export interface Entry {
  url: string;
  size: number;
  sha256: string;
}
export interface Version {
  id: string;
  files: Entry[];
  replaced?: string;
}
export const WORKER_FILE: string;
export function listFiles(dir: string): string[];
export function workerDigest(workerText: string): string;
export function buildVersion(dir: string, source?: string): Version;
export function remoteProblems(address: string, fetcher?: typeof fetch): Promise<{ version: Version; workerSha256: string; problems: string[] }>;
export function writeServiceWorker(dir: string, source?: string): Version;
export function versionOf(workerSource: string): Version;
export function problemsWith(dir: string): { version: Version; problems: string[] };
