import { defineConfig } from 'tsup';

export default defineConfig([
  // Library builds (ESM/CJS with @tracekit/browser external)
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    minify: true,
    sourcemap: true,
    target: 'es2020',
    platform: 'browser',
    external: ['@tracekit/browser'],
  },
  // IIFE bundle for script tag usage (bundles everything except @tracekit/browser)
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    globalName: 'TraceKitReplay',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    platform: 'browser',
    external: ['@tracekit/browser'],
    outExtension: () => ({ js: '.global.js' }),
  },
]);
