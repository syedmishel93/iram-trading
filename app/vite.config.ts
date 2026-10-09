import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The shipped artefact is ONE self-contained index.html: it must open from a
// double-click with no server, and the Python/Node test harness reads the built
// file as a single blob. Inlining everything is a hard product requirement, not
// a bundling preference.
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  // The version belongs in ONE place. Reading it from package.json at build
  // time stops the About panel drifting from the release it claims to be.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: 'es2022',
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 8000,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  server: { port: 5173, strictPort: false },

  /*
   * THE SUITE'S TIMEOUT IS A PROPERTY OF THE SUITE, NOT OF EACH TEST.
   *
   * Vitest defaults to 5,000ms and there was no `test` block here at all, so
   * that default governed 5,000 tests across 243 files. MEASURED: the suite
   * spawns a worker per file at roughly 640ms of startup each, and under that
   * load tests whose own work is genuinely seconds long began failing on time
   * rather than on behaviour — `opportunity` takes 3,703ms ALONE on an idle
   * machine, 74% of the budget before any neighbour is running.
   *
   * The tell that it was load and not a defect: WHICH test failed moved from
   * run to run — opportunity, then deskrender, then confidence, then survey —
   * while each passed on its own, and the same suite was green on main.
   * Chasing them one at a time means a per-test timeout on every heavy test in
   * the repository, added one incident at a time by whoever is unlucky.
   *
   * 20s is headroom, not blindness: a test that genuinely hangs still fails,
   * four seconds later than it used to. A test that is slow enough to need
   * this is a finding worth making deliberately, not by stopwatch.
   */
  test: { testTimeout: 20_000, hookTimeout: 20_000 },
})
