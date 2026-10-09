// Which language a file is, from its name, and its CodeMirror support, each
// loaded only when a file of that kind first opens. Twig is CodeMirror's own
// Jinja language over HTML: the same {{ }}, {% %} and {# #}, filters and
// tests, with the HTML (and its CSS and JavaScript) around them highlighted
// too. Why that and not a Twig package is in docs/design/2026-10-09-code-editor.md.
import type { Extension } from '@codemirror/state';

export interface LanguageInfo {
  /** What the status bar calls it. */
  label: string;
  load: () => Promise<Extension>;
}

const legacy = (mode: () => Promise<Parameters<typeof import('@codemirror/language').StreamLanguage.define>[0]>) => async (): Promise<Extension> => {
  const [{ StreamLanguage }, parser] = await Promise.all([import('@codemirror/language'), mode()]);
  return StreamLanguage.define(parser);
};

const PHP: LanguageInfo = { label: 'PHP', load: async () => (await import('@codemirror/lang-php')).php() };
const TWIG: LanguageInfo = { label: 'Twig', load: async () => (await import('@codemirror/lang-jinja')).jinja() };
const HTML: LanguageInfo = { label: 'HTML', load: async () => (await import('@codemirror/lang-html')).html() };
const CSS: LanguageInfo = { label: 'CSS', load: async () => (await import('@codemirror/lang-css')).css() };
const SCSS: LanguageInfo = { label: 'SCSS', load: async () => (await import('@codemirror/lang-sass')).sass() };
const SASS: LanguageInfo = { label: 'Sass', load: async () => (await import('@codemirror/lang-sass')).sass({ indented: true }) };
const JS: LanguageInfo = { label: 'JavaScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }) };
const TS: LanguageInfo = { label: 'TypeScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }) };
const TSX: LanguageInfo = { label: 'TypeScript JSX', load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true }) };
const JSON_: LanguageInfo = { label: 'JSON', load: async () => (await import('@codemirror/lang-json')).json() };
const YAML: LanguageInfo = { label: 'YAML', load: async () => (await import('@codemirror/lang-yaml')).yaml() };
const MARKDOWN: LanguageInfo = { label: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() };
const XML: LanguageInfo = { label: 'XML', load: async () => (await import('@codemirror/lang-xml')).xml() };
const SHELL: LanguageInfo = { label: 'Shell', load: legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell) };
const PROPERTIES: LanguageInfo = { label: 'Properties', load: legacy(async () => (await import('@codemirror/legacy-modes/mode/properties')).properties) };
const TOML: LanguageInfo = { label: 'TOML', load: legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml) };
const DOCKERFILE: LanguageInfo = { label: 'Dockerfile', load: legacy(async () => (await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile) };
const NGINX: LanguageInfo = { label: 'nginx', load: legacy(async () => (await import('@codemirror/legacy-modes/mode/nginx')).nginx) };

const BY_EXTENSION: Record<string, LanguageInfo> = {
  php: PHP, module: PHP, inc: PHP, install: PHP, theme: PHP, profile: PHP, engine: PHP,
  twig: TWIG, html: HTML, htm: HTML,
  css: CSS, scss: SCSS, sass: SASS, less: CSS,
  js: JS, mjs: JS, cjs: JS, jsx: JS, ts: TS, mts: TS, cts: TS, tsx: TSX,
  json: JSON_, jsonc: JSON_, webmanifest: JSON_,
  yml: YAML, yaml: YAML,
  md: MARKDOWN, markdown: MARKDOWN, mdx: MARKDOWN,
  xml: XML, svg: XML, xsl: XML, plist: XML, 'xml.dist': XML,
  sh: SHELL, bash: SHELL, zsh: SHELL,
  ini: PROPERTIES, properties: PROPERTIES, conf: PROPERTIES, cfg: PROPERTIES,
  toml: TOML,
};

/** The language of a file by its name; null for plain text. */
export function languageOf(path: string): LanguageInfo | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return DOCKERFILE;
  if (name === 'nginx.conf' || /\.nginx(\.conf)?$/.test(name)) return NGINX;
  if (name === '.env' || name.startsWith('.env.') || name === '.htaccess' || name === '.editorconfig' || name === '.npmrc') return PROPERTIES;
  if (/^\.(bash|zsh)(rc|_profile)$|^\.profile$/.test(name)) return SHELL;
  if (name === 'composer.lock') return JSON_;
  if (name.endsWith('.phpunit.xml.dist') || name.endsWith('.xml.dist')) return XML;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] ?? null : null;
}
