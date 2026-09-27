/**
 * A second build: the alert engine, for Node.
 *
 * WHY A SEPARATE CONFIG RATHER THAN A SECOND IMPLEMENTATION
 * Browser-closed alerts need the rules to run somewhere the browser is not.
 * Re-writing them in Python next to the data server would give two engines, and
 * the day they disagree you find out on a live trade with no way to tell which
 * one lied. So the daemon runs the SAME TypeScript, compiled to an ES module
 * Node can import. A change to a detector or to the hysteresis rule changes
 * both at once, or neither.
 *
 * Output goes next to the daemon that consumes it, and is committed, so running
 * the daemon does not require a toolchain on the machine doing the alerting.
 */
import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: resolve(__dirname, "../server/engine"),
    emptyOutDir: true,
    // No minification: this file is meant to be readable by whoever has to
    // trust it at 3am, and it is loaded from disk, not over a network.
    minify: false,
    lib: {
      entry: resolve(__dirname, "src/alert/headless.ts"),
      formats: ["es"],
      fileName: () => "alert-engine.mjs",
    },
    rollupOptions: {
      // Everything the engine needs is bundled; it must run with no install.
      external: [],
    },
  },
});
