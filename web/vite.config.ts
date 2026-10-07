import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { writeServiceWorker } from "./scripts/pwa.mjs";

/** After a build: the service worker (pwa/sw.js) with the list of the files the build made written into it, so that no build is without one. */
function serviceWorker(): Plugin {
  let out = "";
  return {
    name: "zim-service-worker",
    apply: "build",
    configResolved(config) {
      out = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!existsSync(resolve(out, "index.html"))) return; // (the build failed: nothing to make a worker for)
      const version = writeServiceWorker(out);
      console.log(`service worker: version ${version.id}, ${version.files.length} files`);
    },
  };
}

export default defineConfig({
  // Relative asset URLs, so the built app works from any path (a folder, Tauri, Capacitor).
  base: "./",
  build: { target: "es2022" },
  plugins: [serviceWorker()],
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
