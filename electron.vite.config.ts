import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    // Deliberately unminified. scripts/smoke.sh builds before it launches real
    // Electron, and when main dies during bootstrap the only thing the harness
    // recovers is what failSmokeBootstrap appended to the smoke log — an
    // error.stack, with no sourcemap shipped. Minified, those frames name `a`
    // and `Kj` instead of the function that threw, which costs an early
    // failure the one diagnostic smoke.sh's own comment says it has left.
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
  // Preload is small, runs across the trust boundary, and is read by anyone
  // auditing what the renderer is actually allowed to call. It stays readable
  // for the same reason main does.
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
    // Minification renames every function, and React composes the component
    // stack out of those names. ErrorBoundary logs that stack and renders it
    // under "Component stack" in its fallback, which is the whole record of a
    // view crash that reproduces once a week. Without keepNames the string
    // "TerminalPane" does not survive into the bundle at all and the stack
    // reads `at i / at Kj`. The preserved names cost about 42KB.
    esbuild: { keepNames: true },
    build: {
      // electron-vite defaults every target to minify: false. For main and
      // preload that is right; for the window it is not. Measured on this
      // tree: JS 2.55MB -> 1.39MB and CSS 252KB -> 165KB on disk. Be honest
      // about what that buys — the DMG and the update zip are already
      // compressed, so the 140MB arm64 download moves by roughly 126KB. The
      // real wins are the installed app on disk and the bytes Chromium parses
      // before the first paint.
      minify: 'esbuild',
      // The window is one chunk and stays one chunk: every view is imported
      // eagerly in App.tsx and none of them is lazy. Expect esbuild's >500KB
      // chunk warning here and do not act on it. The module worth splitting
      // would be the terminal, and it is exactly the one that cannot be:
      // App.tsx calls startTerminalOutputPump from TerminalPane for the
      // window's lifetime, before and regardless of any view mounting, and
      // PTY output that arrives while a lazy chunk is still resolving is
      // simply gone. Splitting the rest would trade a Suspense boundary and a
      // loading state beside a running agent for a fraction of the 1.39MB
      // this line already removed, which is not a trade this app makes.
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
  },
});
