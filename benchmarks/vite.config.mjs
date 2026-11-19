import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { editorChunkGroups } from "../scripts/build/vite-editor-chunks.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  worker: { format: "es" },
  build: {
    outDir: "../dist/benchmark",
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: { groups: editorChunkGroups },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
});
