/**
 * A third build: the strategy lab, for Node.
 *
 * Same reasoning as `vite.headless.config.ts` — see the note there. The lab is
 * built separately from the alert engine rather than added to it because the
 * two are consumed by different processes with different lifetimes: the alert
 * daemon runs forever and must stay small, and a lab worker is spawned per
 * study and exits.
 */
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: resolve(__dirname, "../server/engine"),
    // The alert engine lives in this directory too and must survive this build.
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve(__dirname, "src/backtest/headless.ts"),
      formats: ["es"],
      fileName: () => "lab-engine.mjs",
    },
    rollupOptions: { external: [] },
  },
});
