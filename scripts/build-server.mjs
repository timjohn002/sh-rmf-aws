// Bundles the API server and the maintenance job into dist-server/.
// Dependencies are bundled too, so the runtime image needs no node_modules.
import { build } from 'esbuild'

await build({
  entryPoints: {
    main: 'server/main.ts',
    maintenance: 'server/jobs/maintenance.ts',
  },
  outdir: 'dist-server',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  // Some bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
