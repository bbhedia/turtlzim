// Builds the pages in test/lab/ the way the app is built (same bundler, same Worker and wasm handling,
// so what the browser tests run is what production bundling makes of the vault), into dist-lab/,
// which is only ever served to the tests.
import { defineConfig } from "vite";

export default defineConfig({
  root: "test/lab",
  base: "./",
  build: { target: "es2022", outDir: "../../dist-lab", emptyOutDir: true },
});
