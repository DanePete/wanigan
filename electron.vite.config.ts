import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // Native addons must stay external and be loaded from node_modules at
        // runtime. Bundling one rewrites its dynamic require of the .node
        // binary to a path that does not exist, and every call through it
        // throws at runtime rather than at build time.
        external: ['node-pty', 'better-sqlite3'],
      },
    },
  },
  preload: {},
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
