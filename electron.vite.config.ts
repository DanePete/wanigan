import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // node-pty is a native addon — it must stay external and be loaded
        // from node_modules at runtime, never bundled.
        external: ['node-pty'],
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
