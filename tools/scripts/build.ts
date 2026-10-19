import * as esbuild from 'esbuild';
import path from 'path';

const sharedAlias = path.resolve(import.meta.dirname, '../../packages/shared/src');

const commonOptions: esbuild.BuildOptions = {
  platform: 'node',
  packages: 'external',
  bundle: true,
  format: 'esm',
  outdir: 'dist',
  alias: {
    '@shared': sharedAlias,
  },
};

await Promise.all([
  esbuild.build({
    ...commonOptions,
    entryPoints: ['apps/server/src/index.ts'],
  }),
  esbuild.build({
    ...commonOptions,
    entryPoints: ['apps/server/src/workers/worker.ts'],
  }),
  // Stacking runs in a worker thread (dist/stack-thread.js) so the server stays responsive.
  esbuild.build({
    ...commonOptions,
    entryPoints: ['apps/server/src/workers/stack-thread.ts'],
  }),
  esbuild.build({
    ...commonOptions,
    entryPoints: ['tools/scripts/migrate-db.js'],
    outdir: 'dist',
    outbase: '.',
  }),
]);
