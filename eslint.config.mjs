import js from '@eslint/js';
import { includeIgnoreFile } from '@eslint/compat';
import path from 'node:path';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/*
 * Wanigan's linter. It is deliberately not a style tool.
 *
 * Formatting is already settled by review, `scripts/check-renderer-style.cjs`
 * owns the renderer's structural rules, and `tsconfig` already runs `strict`
 * plus noUnusedLocals, noUnusedParameters, noImplicitReturns and
 * allowUnreachableCode:false. Adding a second opinion about quote marks would
 * cost every contributor a fight and catch nothing. So every rule below earns
 * its place by catching a defect those three cannot see.
 *
 * The type-aware half is the reason this exists at all. `no-floating-promises`
 * needs the type checker, and this codebase is full of `void somePromise()` —
 * a deliberate idiom for "start this and do not wait". The idiom is only safe
 * while every one of them is written down: a promise that loses its `void` and
 * its `.catch` swallows the rejection entirely, and in the main process that is
 * a session that silently never launches.
 */

export default tseslint.config(
  // Whatever git already ignores, the linter ignores. Three bundled artifacts
  // sitting at the repo root — gitignored, never reviewed, never shipped from
  // here — accounted for 2,446 of the first run's 4,303 problems. Keeping the
  // two lists in step by hand is how that happens again.
  includeIgnoreFile(path.resolve(import.meta.dirname, '.gitignore')),
  {
    // Vendored numeric code kept byte-identical with upstream, and the
    // ambient type declarations tsc already owns.
    ignores: ['src/renderer/src/orb/vendor/**', '**/*.d.ts'],
  },

  js.configs.recommended,

  // ── TypeScript, with the type checker on ────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The four that need types, and the reason this is type-aware at all.
      // `node:test` returns a promise from `test()` that the runner itself
      // awaits; the fast-lane suites call it at top level forty-odd times, and
      // recording those as debt would be recording noise. This is the option
      // typescript-eslint added for exactly that shape.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [
          { from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] },
        ],
      }],
      // `checksVoidReturn.attributes` is off deliberately. It fires on every
      // `onClick={async () => …}` in the renderer — 66 of this rule's 76 hits —
      // and React genuinely ignores that return value. The hazard is real but
      // small and belongs to a separate sweep; what is left is the ten places a
      // promise is handed to something that will never await it.
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { attributes: false },
      }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-array-delete': 'error',

      // Electron runs renderer input through main. These are the string-to-code
      // paths, and none of them has a legitimate use here.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // Real defects rather than taste.
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',

      // Measured against this tree and turned off rather than suppressed,
      // because a baseline of entries nobody will ever fix is noise in the
      // ratchet rather than debt in it:
      //   no-promise-executor-return — all 12 hits are
      //     `new Promise(r => setTimeout(r, 500))`, where the arrow returns a
      //     timer id nobody reads. Idiomatic, and not what the rule is for.
      //   no-control-regex — 17 hits, all in the parsers for terminal and gh
      //     output, where a control character in the pattern is the point.
      //   require-atomic-updates — 54 hits, the rule's well-known false
      //     positives on sequential awaited assignments.
      //   no-fallthrough — tsconfig already sets noFallthroughCasesInSwitch,
      //     and that one correctly allows the empty grouped `case` labels in
      //     settings.ts that this rule flags.
      'no-promise-executor-return': 'off',
      'no-control-regex': 'off',
      'require-atomic-updates': 'off',
      'no-fallthrough': 'off',
      'no-regex-spaces': 'off',

      // tsconfig already reports unused locals and parameters, and says it in
      // better words. Two tools shouting the same thing trains people to skim.
      '@typescript-eslint/no-unused-vars': 'off',
      // `any` is a judgement call this repository makes per site, and the
      // untrusted-input boundaries deliberately take unknown and narrow.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // ── The renderer ─────────────────────────────────────────────────────────
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      // A hook called conditionally is a crash, not a smell.
      'react-hooks/rules-of-hooks': 'error',
      // The stale-closure rule. HandoverBubble needed a ref to keep `showing`
      // from going stale inside a callback; this is the check that finds the
      // next one before it ships.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // ── Main and preload run in Node ─────────────────────────────────────────
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // ── Probes, harnesses and packaging scripts ──────────────────────────────
  // Plain Node, no type information, and not shipped. They still get the
  // correctness rules: a probe that lies is worse than no probe.
  {
    files: ['scripts/**/*.{mjs,cjs,js}'],
    languageOptions: {
      // Both, and legitimately so: a probe is a Node program whose
      // `page.evaluate` bodies are serialised and run inside the window, so
      // `document` and `window` are real there and `process` is real around
      // them. Declaring only Node made every DOM reference an undefined global.
      globals: { ...globals.node, ...globals.browser },
      sourceType: 'module',
      ecmaVersion: 2023,
    },
    rules: {
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-unreachable-loop': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
);
