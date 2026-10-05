import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset URLs, so the built app works from any path (a folder, Tauri, Capacitor).
  base: "./",
  build: { target: "es2022" },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
