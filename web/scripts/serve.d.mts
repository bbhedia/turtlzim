import type { Server } from "node:http";

export function createStaticServer(options: { dir: string; auth?: string; log?: (line: string) => void }): Server;
export function urlsFor(host: string, port: number): string[];
