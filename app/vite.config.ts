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
})
