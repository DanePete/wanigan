import type { RunConfig } from '../../shared/types';

/**
 * Presets are templates — the project a run targets is chosen in the UI from
 * the same project list the Sessions view uses, so `ROOT` is only a placeholder
 * that gets replaced the moment a project is picked.
 */
const ROOT = '{{PROJECT_PATH}}';

export type Preset = {
  id: string;
  label: string;
  blurb: string;
  config: Omit<RunConfig, 'name'>;
};

export const PRESETS: Preset[] = [
  {
    id: 'blank',
    label: 'Blank',
    blurb: 'Start from nothing. Bring a CSV or JSONL and write your own prompt.',
    config: {
      model: 'claude-sonnet-5',
      maxTokens: 2048,
      cacheTtl: '1h',
      system: [{ text: '', cache: false }],
      userTemplate: '',
      source: { kind: 'csv', text: '' },
    },
  },
  {
    id: 'content-ops',
    label: 'Content ops (Drupal)',
    blurb:
      'Rewrite, summarise or normalise node content in bulk. Feed it a drush SQL export; get structured JSON back that a follow-up drush script can write.',
    config: {
      preset: 'content-ops',
      model: 'claude-sonnet-5',
      effort: 'medium',
      maxTokens: 1500,
      cacheTtl: '1h',
      keyColumn: 'nid',
      system: [
        {
          cache: true,
          text: `You are editing content for a Drupal site. You will be given one node at a time.

Rules:
- Preserve every fact. Never invent dates, names, places, numbers or credits.
- Keep the author's voice. You are copy-editing, not rewriting from scratch.
- Do not add marketing language, calls to action, or engagement bait.
- If the source is already good, say so and return it unchanged rather than
  changing it for the sake of changing it.
- If the source is too thin to work with, set "skip": true and explain why.

Return only the JSON object described by the schema.`,
        },
      ],
      userTemplate: `Node {{nid}} — "{{title}}"

Body:
{{body}}`,
      schemaJson: JSON.stringify(
        {
          type: 'object',
          additionalProperties: false,
          required: ['nid', 'skip', 'reason', 'title', 'summary', 'body', 'changed'],
          properties: {
            nid: { type: 'string', description: 'Echo the node id exactly as given.' },
            skip: { type: 'boolean', description: 'True when the source is too thin to edit safely.' },
            reason: { type: 'string', description: 'Why it was skipped, if skipped.' },
            title: { type: 'string' },
            summary: { type: 'string', description: 'One sentence, max 160 characters.' },
            body: { type: 'string' },
            changed: { type: 'boolean', description: 'False when the original needed no change.' },
          },
        },
        null,
        2
      ),
      source: {
        kind: 'command',
        cwd: ROOT,
        format: 'jsonl',
        command: `drush sql:query --extra=-B "SELECT n.nid, n.title, b.body_value AS body FROM node_field_data n JOIN node__body b ON b.entity_id = n.nid WHERE n.status = 1 LIMIT 50" \\
  | python3 -c 'import sys,json
for line in sys.stdin:
    p = line.rstrip("\\n").split("\\t")
    if len(p) >= 3 and p[0] != "nid":
        print(json.dumps({"nid": p[0], "title": p[1], "body": p[2]}))'`,
      },
    },
  },
  {
    id: 'repo-audit',
    label: 'Repo audit',
    blurb:
      'Fan one audit prompt across every file in a tree. The whole ruleset rides in the cached prefix, so you pay to read it once and it is read back at a tenth of the price on every other file.',
    config: {
      preset: 'repo-audit',
      model: 'claude-sonnet-5',
      effort: 'high',
      maxTokens: 3000,
      cacheTtl: '1h',
      keyColumn: 'relpath',
      system: [
        {
          cache: true,
          text: `You are auditing one file from a codebase. Report only defects you can point at a specific line for.

Report:
- Correctness bugs that would misbehave at runtime.
- Security issues: injection, missing authorisation, data exposure.
- Code that silently does nothing (a guard that can never fire, a class that
  compiles to nothing, a comparison that is always false).

Do not report:
- Style, formatting, or naming preferences.
- Anything you are speculating about. If you cannot name the concrete input
  that triggers it, leave it out.

An empty findings list is a good answer. Do not pad it.

Return only the JSON object described by the schema.`,
        },
      ],
      userTemplate: `File: {{relpath}}

\`\`\`{{ext}}
{{content}}
\`\`\``,
      schemaJson: JSON.stringify(
        {
          type: 'object',
          additionalProperties: false,
          required: ['relpath', 'findings'],
          properties: {
            relpath: { type: 'string' },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['line', 'severity', 'category', 'summary', 'failure_scenario'],
                properties: {
                  line: { type: 'integer' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  category: { type: 'string' },
                  summary: { type: 'string' },
                  failure_scenario: { type: 'string', description: 'Concrete inputs or state that produce the wrong result.' },
                },
              },
            },
          },
        },
        null,
        2
      ),
      source: {
        kind: 'glob',
        root: `${ROOT}/web/modules/custom`,
        pattern: '**/*.php',
        maxBytes: 120_000,
      },
    },
  },
];

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
