// Where the cursor is inside a file, as the breadcrumbs name it: a PHP class
// and method, a Twig block and the HTML element inside it, a CSS rule inside
// an at-rule, a JavaScript function, a YAML key path, a Markdown heading. Read
// from CodeMirror's own syntax tree, so it is as right as the highlighting.
// Each step knows the others at its level, for the breadcrumb's menu.
//
// Imports only packages and explicit .ts paths: the unit tests load it under
// plain Node (symbols.test.ts).
import { ensureSyntaxTree, language, syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';

type Node = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

export type SymbolKind =
  | 'class' | 'interface' | 'trait' | 'enum' | 'method' | 'function'
  | 'block' | 'macro' | 'rule' | 'at-rule' | 'key' | 'item' | 'heading' | 'element';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** The whole of it, so the path at a position is every symbol around it. */
  from: number;
  to: number;
  /** Where a jump to it puts the cursor: its name. */
  select: number;
  /** A heading's level; 0 for everything else. */
  level: number;
  /** Where its siblings are found (not for showing). */
  node: Node | null;
}

/** How many symbols one level lists at most: a breadcrumb menu, not an index of the file. */
const MAX_LEVEL = 400;
/** How long to parse the rest of a file for its symbols before making do with what is parsed. */
const PARSE_MS = 60;

/** The file's syntax tree, parsed to the end when that is quick; the editor parses the rest as it idles. */
const treeOf = (state: EditorState): ReturnType<typeof syntaxTree> => ensureSyntaxTree(state, state.doc.length, PARSE_MS) ?? syntaxTree(state);

const DECLARED: Record<string, SymbolKind> = {
  ClassDeclaration: 'class', InterfaceDeclaration: 'interface', TraitDeclaration: 'trait', EnumDeclaration: 'enum',
  MethodDeclaration: 'method', FunctionDefinition: 'function', FunctionDeclaration: 'function',
};
const NAME_NODES = ['Name', 'VariableDefinition', 'TypeDefinition', 'PropertyDefinition', 'Definition'];
const HEADING = /^(?:ATX|Setext)Heading(\d)$/;

const text = (state: EditorState, from: number, to: number): string => state.doc.sliceString(from, to);
const unquote = (s: string): string => s.replace(/^(['"])(.*)\1$/s, '$2');
const tidy = (s: string, max = 60): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function make(name: string, kind: SymbolKind, node: Node, select: number): CodeSymbol {
  return { name, kind, from: node.from, to: node.to, select, level: 0, node };
}

/** What a syntax node is as a symbol, or null when it is not one. */
function symbolOf(state: EditorState, node: Node): CodeSymbol | null {
  const declared = DECLARED[node.name];
  if (declared) {
    const name = NAME_NODES.map((n) => node.getChild(n)).find(Boolean);
    return name ? make(text(state, name.from, name.to), declared, node, name.from) : null;
  }
  switch (node.name) {
    case 'VariableDeclaration': {
      // const pay = () => …, const Card = class …
      const value = node.getChild('ArrowFunction') ?? node.getChild('FunctionExpression') ?? node.getChild('ClassExpression');
      const name = node.getChild('VariableDefinition');
      return value && name ? make(text(state, name.from, name.to), value.name === 'ClassExpression' ? 'class' : 'function', node, name.from) : null;
    }
    case 'Property': {
      // JSON's keys, and an object's methods in JavaScript.
      const json = node.getChild('PropertyName');
      if (json) return make(unquote(text(state, json.from, json.to)), 'key', node, json.from);
      const name = node.getChild('PropertyDefinition');
      const fn = node.getChild('ParamList') ?? node.getChild('FunctionExpression') ?? node.getChild('ArrowFunction');
      return name && fn ? make(text(state, name.from, name.to), 'method', node, name.from) : null;
    }
    case 'BlockStatement':
    case 'MacroStatement': {
      // Twig's {% block name %} and {% macro name() %}.
      const def = node.getChild('Tag')?.getChild('Definition');
      return def ? make(text(state, def.from, def.to), node.name === 'BlockStatement' ? 'block' : 'macro', node, def.from) : null;
    }
    case 'RuleSet': {
      const body = node.getChild('Block');
      return make(tidy(text(state, node.from, body ? body.from : node.to)) || '(rule)', 'rule', node, node.from);
    }
    case 'Element': {
      const open = node.getChild('OpenTag') ?? node.getChild('SelfClosingTag');
      const tag = open?.getChild('TagName');
      if (!open || !tag) return null;
      let name = text(state, tag.from, tag.to);
      for (const attr of open.getChildren('Attribute')) {
        const key = attr.getChild('AttributeName');
        const value = attr.getChild('AttributeValue');
        if (!key || !value) continue;
        const k = text(state, key.from, key.to);
        const v = unquote(text(state, value.from, value.to)).trim();
        if (k === 'id' && v && !v.includes('{')) { name += `#${v}`; break; }
        if (k === 'class' && v && !v.includes('{') && !name.includes('.')) name += `.${v.split(/\s+/)[0]}`;
      }
      return make(name, 'element', node, tag.from);
    }
    case 'Pair': {
      const key = node.getChild('Key');
      return key ? make(unquote(text(state, key.from, key.to).trim()), 'key', node, key.from) : null;
    }
    case 'Item': {
      if (node.parent?.name !== 'BlockSequence') return null;
      let index = 0;
      for (let p = node.prevSibling; p; p = p.prevSibling) if (p.name === 'Item') index++;
      return make(`[${index}]`, 'item', node, node.from);
    }
    default:
      break;
  }
  // CSS at-rules (@media, @supports, @keyframes, a Sass @mixin): what comes before their block.
  if (node.name.endsWith('Statement') && text(state, node.from, node.from + 1) === '@') {
    const body = node.getChild('Block') ?? node.getChild('KeyframeList');
    if (body) return make(tidy(text(state, node.from, body.from)), 'at-rule', node, node.from);
  }
  return null;
}

/** Symbols on the way up from a node, innermost first. */
function upFrom(state: EditorState, node: Node | null): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  for (let n = node; n; n = n.parent) {
    const s = symbolOf(state, n);
    if (s) out.push(s);
  }
  return out;
}

/** The symbols directly under a node, in document order, not looking inside a symbol. */
function childSymbols(state: EditorState, container: Node): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const visit = (n: Node, depth: number): void => {
    for (let c = n.firstChild; c && out.length < MAX_LEVEL; c = c.nextSibling) {
      const s = symbolOf(state, c);
      if (s) out.push(s);
      else if (depth < 40) visit(c, depth + 1);
    }
  };
  visit(container, 0);
  return out;
}

const isMarkdown = (state: EditorState): boolean => state.facet(language)?.name === 'markdown';

/** Every heading of a Markdown document, each with where its section ends and the heading it sits under. */
function headings(state: EditorState): (CodeSymbol & { parent: number })[] {
  const found: { level: number; from: number; to: number; textFrom: number; textTo: number }[] = [];
  treeOf(state).iterate({
    enter: (n) => {
      const m = HEADING.exec(n.name);
      if (!m) return undefined;
      const mark = n.node.getChild('HeaderMark');
      // An ATX heading's text follows its #s; a Setext heading's comes before its underline.
      const setext = n.name.startsWith('Setext');
      const textFrom = setext || !mark ? n.from : mark.to;
      const textTo = setext && mark ? mark.from : n.to;
      found.push({ level: Number(m[1]), from: n.from, to: n.to, textFrom, textTo });
      return false;
    },
  });
  const out: (CodeSymbol & { parent: number })[] = [];
  const stack: number[] = [];
  found.forEach((h, i) => {
    while (stack.length && (out[stack[stack.length - 1] as number] as CodeSymbol).level >= h.level) stack.pop();
    const next = found.slice(i + 1).find((x) => x.level <= h.level);
    out.push({
      name: tidy(text(state, h.textFrom, h.textTo).replace(/#+\s*$/, '')) || '(heading)', kind: 'heading',
      from: h.from, to: next ? next.from : state.doc.length, select: h.from, level: h.level, node: null,
      parent: stack.length ? stack[stack.length - 1] as number : -1,
    });
    stack.push(i);
  });
  return out;
}

/**
 * The symbols around a position, outermost first. Templates are two languages
 * at once (Twig or PHP with HTML inside), so both the template's own symbols
 * and the HTML elements around the position are found, then put in order.
 */
export function symbolPath(state: EditorState, pos: number): CodeSymbol[] {
  if (isMarkdown(state)) return headings(state).filter((h) => h.from <= pos && pos <= h.to).map(({ parent: _parent, ...h }) => h);
  // Every node around the position, the HTML inside a template included even where a Twig tag sits between.
  const all: CodeSymbol[] = [];
  for (let layer: ReturnType<ReturnType<typeof syntaxTree>['resolveStack']> | null = treeOf(state).resolveStack(pos, 1); layer; layer = layer.next) {
    all.push(...upFrom(state, layer.node));
  }
  const seen = new Set<string>();
  return all
    .filter((s) => s.from <= pos && pos <= s.to)
    .filter((s) => { const k = `${s.from}:${s.to}:${s.kind}:${s.name}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.from - b.from || b.to - a.to);
}

/** The symbols at one symbol's level (it among them), in document order: what its breadcrumb's menu offers. */
export function symbolSiblings(state: EditorState, symbol: CodeSymbol): CodeSymbol[] {
  if (symbol.kind === 'heading') {
    const all = headings(state);
    const me = all.find((h) => h.from === symbol.from);
    return all.filter((h) => h.parent === (me?.parent ?? -1)).map(({ parent: _parent, ...h }) => h);
  }
  const node = symbol.node;
  if (!node) return [symbol];
  // The nearest symbol around it, or the top of its own language (the HTML inside a Twig template is its own tree).
  let container: Node | null = node.parent;
  while (container && !symbolOf(state, container) && !container.type.isTop) container = container.parent;
  if (!container) return [symbol];
  return childSymbols(state, container);
}

/** The symbols at the top of the file, for the breadcrumbs when the cursor is outside them all. */
export function topSymbols(state: EditorState): CodeSymbol[] {
  if (isMarkdown(state)) return headings(state).filter((h) => h.parent === -1).map(({ parent: _parent, ...h }) => h);
  const tree = treeOf(state);
  const own = childSymbols(state, tree.topNode);
  if (own.length) return own;
  // A template with no blocks: its HTML is the outline (a tree of its own, laid over the template's text).
  for (let c = tree.topNode.firstChild; c; c = c.nextSibling) {
    if (c.name !== 'Text') continue;
    for (let n: Node | null = tree.resolveInner(c.from, 1); n; n = n.parent) {
      if (n.type.isTop && n.parent) return childSymbols(state, n);
    }
  }
  return [];
}
