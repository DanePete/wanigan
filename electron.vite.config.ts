import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Three Node entry points share one bundle config: the Electron main process,
// the core daemon (owns the database and every terminal), and the agents' CLI.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          core: resolve('src/core/index.ts'),
          cli: resolve('src/cli/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts') } } },
  },
  renderer: {
    root: 'src/renderer',
    // src/package.json makes Vite infer src/ as the workspace; fonts live above it.
    server: { fs: { allow: [resolve('src'), resolve('node_modules/@fontsource')] } },
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // The window, the lighter page a paired phone opens (src/core/phone/gateway.ts serves it), and the
    // script the live view injects into the owner's site (src/main/live-view.ts reads it as text).
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          phone: resolve('src/renderer/phone.html'),
          'live-page': resolve('src/renderer/src/live-page-entry.ts'),
        },
        output: { entryFileNames: (chunk) => (chunk.name === 'live-page' ? 'live-page.js' : 'assets/[name]-[hash].js') },
      },
    },
  },
});
