import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The voice worker (src/main/voice-worker.ts) bundles transformers.js and onnxruntime-web, and nothing native:
 * transformers.js's one runtime require of onnxruntime-node becomes an empty object (the worker hands it
 * onnxruntime-web), sharp (images, never needed for audio) becomes a stub that refuses, and onnxruntime's
 * WebAssembly and its loader are copied beside the worker into out/main/voice/. The same files on every OS.
 * Design: docs/design/2026-10-10-voice-input.md, "Packages".
 */
function voiceEngine(): Plugin {
  const ortDist = resolve('node_modules/onnxruntime-web/dist');
  const SHARP = '\0wanigan-voice-sharp';
  const NATIVE_REQUIRE = 'requireFromHere("onnxruntime-node")';
  return {
    name: 'wanigan-voice-engine',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'sharp') return SHARP;
      if (id === 'onnxruntime-web') return resolve(ortDist, 'ort.node.min.mjs');
      if (id === '@huggingface/transformers') return resolve('node_modules/@huggingface/transformers/dist/transformers.node.mjs');
      return null;
    },
    load(id) {
      if (id === SHARP) return 'export default function sharp() { throw new Error(\'Images are not supported in the voice engine.\'); }\n';
      return null;
    },
    transform(code, id) {
      if (!/[\\/]@huggingface[\\/]transformers[\\/]dist[\\/]transformers\.node\.mjs$/.test(id)) return null;
      const found = code.split(NATIVE_REQUIRE).length - 1;
      // A newer transformers.js that loads onnxruntime-node another way must fail the build, not ship a native load.
      if (found !== 1) this.error(`The voice engine expects one ${NATIVE_REQUIRE} in transformers.js, and found ${found}: check how it loads onnxruntime now.`);
      return { code: code.replace(NATIVE_REQUIRE, '({})'), map: null };
    },
    generateBundle() {
      for (const name of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
        this.emitFile({ type: 'asset', fileName: `voice/${name}`, source: readFileSync(resolve(ortDist, name)) });
      }
    },
  };
}

// Four Node entry points share one bundle config: the Electron main process,
// the core daemon (owns the database and every terminal), the agents' CLI, and
// the voice worker (a utilityProcess the main process forks for voice input).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), voiceEngine()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          core: resolve('src/core/index.ts'),
          cli: resolve('src/cli/index.ts'),
          'voice-worker': resolve('src/main/voice-worker.ts'),
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
