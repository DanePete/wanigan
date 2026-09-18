import { validateExtensionManifest } from '../../shared/extension-manifest';
import type { ExtensionManifest } from '../../shared/extension-manifest';
import { installBuiltinExtension } from './store';

/**
 * The extensions Wanigan ships with.
 *
 * These are declared as manifests, not as code, and installed at startup
 * through the same validator, the same transaction and the same tables as a
 * directory somebody chose in a picker. That is the point of them: the five
 * Scout sources used to be a TypeScript constant with its own read path, and
 * a default with a private path is an extension point nobody has proven works.
 * Now the built-in is the first user of the public one, and a stranger's
 * manifest declaring a sixth source lands beside these five rather than in a
 * second table.
 *
 * A change to a source here — a moved changelog, a reworded description — is a
 * change to the canonical JSON, so its digest differs and `installBuiltinExtensions`
 * re-applies it on the next start; `version` is bumped alongside so the owner
 * stamp on the rows says which Wanigan wrote them, though ownership is matched
 * on the id alone and nothing is disowned by a bump.
 */
export const BUILTIN_EXTENSIONS: readonly ExtensionManifest[] = [
  {
    schemaVersion: 1,
    id: 'wanigan.scout-sources',
    label: 'Improvement Scout sources',
    version: '1.0.0',
    description:
      'The official changelogs, release notes and API references Improvement Scout reads every week to propose ' +
      'product changes from. Shipped with Wanigan; disable it to stop all five being read, or switch off one ' +
      'source at a time in Improvement Scout.',
    publisher: { id: 'wanigan', name: 'Wanigan' },
    provides: {
      // The exact fields improvement-scout.ts carried as TRUSTED_SOURCES, so the
      // rows db.ts seeded before extensions existed are adopted with their copy
      // unchanged rather than rewritten.
      scoutSources: [
        {
          id: 'openai-release-notes',
          label: 'OpenAI developer changelog',
          description: 'Official OpenAI developer and product capability changes.',
          url: 'https://learn.chatgpt.com/docs/changelog',
          publisher: 'OpenAI',
          kind: 'changelog',
        },
        {
          id: 'claude-code-changelog',
          label: 'Claude Code changelog',
          description: 'Official Claude Code changes and developer-workflow additions.',
          url: 'https://code.claude.com/docs/en/changelog',
          publisher: 'Anthropic',
          kind: 'changelog',
        },
        {
          id: 'anthropic-platform-release-notes',
          label: 'Anthropic Platform release notes',
          description: 'Official API and platform changes relevant to agent integrations.',
          url: 'https://platform.claude.com/docs/en/release-notes/overview',
          publisher: 'Anthropic',
          kind: 'release-notes',
        },
        {
          id: 'github-changelog',
          label: 'GitHub changelog',
          description: 'Official GitHub platform and MCP ecosystem announcements.',
          url: 'https://github.blog/changelog/',
          publisher: 'GitHub',
          kind: 'changelog',
        },
        {
          id: 'github-releases-rest-docs',
          label: 'GitHub Releases REST API',
          description: 'Official release-discovery API reference and change context.',
          url: 'https://docs.github.com/en/rest/releases',
          publisher: 'GitHub',
          kind: 'documentation',
        },
      ],
    },
  },
];

/**
 * Install every built-in, once, at startup.
 *
 * Each goes through `validateExtensionManifest` first, and one that fails is a
 * startup error naming the field: a bad default caught here is a bad default
 * caught before a stranger's manifest is ever held to the same rule, and a
 * built-in that skipped the validator would be the private path this file
 * exists to remove. The validated manifest — never the literal above — is what
 * gets installed, so what is recorded is what the validator accepted.
 *
 * Idempotent: the store compares the canonical JSON's digest with the row it
 * already holds and a match changes nothing, so a start is not an install.
 */
export function installBuiltinExtensions(): void {
  for (const declared of BUILTIN_EXTENSIONS) {
    const result = validateExtensionManifest(declared);
    if (!result.ok || !result.manifest) {
      throw new Error(
        `The built-in extension "${declared.id}" does not pass Wanigan's own manifest validator:\n` +
        result.errors.join('\n')
      );
    }
    installBuiltinExtension(result.manifest);
  }
}
