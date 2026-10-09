// The editor's configuration: what every open file gets (line numbers,
// folding, brackets, several cursors, search and replace, go to line,
// completion, indentation that matches the file) and how it looks, drawn
// entirely from the app's tokens (tokens.css), so light and dark follow the
// app and nothing here is a colour of its own.
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  keymap, lineNumbers, rectangularSelection, tooltips, type KeyBinding,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/** What changes per file or with a setting, without rebuilding the editor. */
export const slots = {
  language: new Compartment(),
  readOnly: new Compartment(),
  wrap: new Compartment(),
  indent: new Compartment(),
  vim: new Compartment(),
  label: new Compartment(),
};

/** Syntax in the app's quiet hues: the same names the diffs use (--syn-*), clear of the four meanings. */
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self, t.null, t.bool, t.atom], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue, t.character, t.escape], color: 'var(--syn-string)' },
  { tag: [t.number, t.integer, t.float, t.unit, t.color], color: 'var(--syn-number)' },
  { tag: [t.typeName, t.className, t.namespace, t.macroName, t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--syn-type)' },
  { tag: [t.tagName, t.heading], color: 'var(--syn-tag)' },
  { tag: t.heading, fontWeight: '600' },
  { tag: [t.propertyName, t.attributeName, t.labelName, t.special(t.variableName), t.local(t.variableName)], color: 'var(--syn-attr)' },
  { tag: [t.punctuation, t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace, t.separator, t.derefOperator, t.processingInstruction], color: 'var(--syn-punct)' },
  { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator, t.definitionOperator, t.updateOperator], color: 'var(--syn-punct)' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, textDecoration: 'underline wavy var(--red)' },
]);

/** Gutters, cursor, selection, search, panels and pop-ups, all from tokens. */
const look = EditorView.theme({
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--surface)', fontSize: 'var(--text-code)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: 'var(--lh-md)' },
  '.cm-content': { caretColor: 'var(--fg)', padding: 'var(--space-2) 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--water-soft)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'color-mix(in srgb, var(--water) 28%, transparent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hover) 55%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--faint)', borderRight: '1px solid var(--line)', fontFamily: 'var(--font-mono)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--fg)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--space-2) 0 var(--space-3)', minWidth: 'var(--space-8)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--faint)', cursor: 'pointer', padding: '0 var(--space-1)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--raised)', border: '1px solid var(--line-strong)', color: 'var(--muted)', borderRadius: 'var(--radius-s)', padding: '0 var(--space-1)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'transparent', outline: '1px solid var(--line-strong)', color: 'inherit' },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--red-soft)', color: 'inherit' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--water) 14%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'var(--water-soft)', outline: '1px solid var(--water-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--water) 34%, transparent)' },
  '.cm-specialChar': { color: 'var(--red)' },
  '.cm-panels': { backgroundColor: 'var(--raised)', color: 'var(--fg)', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panel.cm-search, .cm-panel.cm-goto-line': { padding: 'var(--space-2) var(--space-3)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' },
  // CodeMirror draws Go to line as a dialog: a form holding "Go to line:" with its field, then Go.
  '.cm-panel.cm-goto-line form, .cm-panel.cm-goto-line label': { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', whiteSpace: 'nowrap' },
  '.cm-panel input, .cm-panel button, .cm-panel label': { fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)', margin: '0' },
  '.cm-panel .cm-textfield': {
    backgroundColor: 'var(--sunken)', color: 'var(--fg)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-s)',
    padding: 'var(--space-1) var(--space-2)', fontFamily: 'var(--font-mono)',
  },
  '.cm-panel .cm-textfield:focus': { outline: 'none', boxShadow: 'var(--focus)' },
  '.cm-panel .cm-button': {
    backgroundImage: 'none', backgroundColor: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius-s)', padding: 'var(--space-1) var(--space-2)', cursor: 'pointer',
  },
  '.cm-panel .cm-button:hover': { backgroundColor: 'var(--hover)' },
  '.cm-panel .cm-button:focus-visible, .cm-panel input[type=checkbox]:focus-visible': { outline: 'none', boxShadow: 'var(--focus)' },
  '.cm-panel label': { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)', color: 'var(--muted)' },
  '.cm-panel input[type=checkbox]': { accentColor: 'var(--water)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted)', fontSize: 'var(--text-lg)', padding: '0 var(--space-1)', position: 'absolute', top: 'var(--space-1)', right: 'var(--space-2)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--raised)', color: 'var(--fg)', border: '1px solid var(--line-strong)', borderRadius: 'var(--radius-m)',
    boxShadow: 'var(--shadow-overlay)', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-code)', maxHeight: '14em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: 'var(--space-1) var(--space-2)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--water-soft)', color: 'var(--fg)' },
  '.cm-completionDetail': { color: 'var(--faint)', fontStyle: 'normal', marginLeft: 'var(--space-2)' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--water)' },
  '.cm-completionIcon': { color: 'var(--muted)' },
  '.cm-tooltip.cm-tooltip-lint, .cm-diagnostic': { color: 'var(--fg)' },
});

export interface Setup {
  save: () => void;
  toggleWrap: () => void;
  mac: boolean;
  /** What a screen reader calls the text: the file's name, and how to leave. */
  label: string;
  describedBy: string;
}

/** Everything a file's editor state is made of, before its language, indentation and read-only are known. */
export function baseExtensions(setup: Setup): Extension[] {
  const keys: KeyBinding[] = [
    { key: 'Mod-s', run: () => { setup.save(); return true; }, preventDefault: true },
    { key: 'Alt-z', run: () => { setup.toggleWrap(); return true; }, preventDefault: true },
    // Go to line where people expect it on a Mac (⌃G), besides CodeMirror's own ⌘⌥G.
    ...(setup.mac ? [{ key: 'Ctrl-g', run: gotoLine, preventDefault: true }] : []),
  ];
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter({ markerDOM: (open) => {
      const el = document.createElement('span');
      el.className = `cm-fold-mark${open ? ' open' : ''}`;
      el.setAttribute('aria-hidden', 'true');
      el.textContent = open ? '⌄' : '›';
      return el;
    } }),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(highlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: true, icons: true }),
    // Words already in the file complete everywhere, beside each language's own (CSS properties, HTML tags).
    EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    // Pop-ups stay inside the editor: above it, the live view's page is drawn by the app and would hide them.
    tooltips({ tooltipSpace: (view) => view.dom.getBoundingClientRect() }),
    Prec.high(keymap.of(keys)),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    look,
    slots.language.of([]),
    slots.readOnly.of([]),
    slots.wrap.of([]),
    slots.indent.of([indentUnit.of('  '), EditorState.tabSize.of(2)]),
    slots.vim.of([]),
    slots.label.of(EditorView.contentAttributes.of({ 'aria-label': setup.label, 'aria-describedby': setup.describedBy })),
  ];
}

export const wrapping = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);
export const readOnly = (on: boolean): Extension => (on ? [EditorState.readOnly.of(true)] : []);
export const indentation = (unit: string, tabSize: number): Extension => [indentUnit.of(unit), EditorState.tabSize.of(tabSize)];
export const labelled = (label: string, describedBy: string): Extension => EditorView.contentAttributes.of({ 'aria-label': label, 'aria-describedby': describedBy });

/** Vim keys, loaded only when the setting is on; they come before every other key. */
export async function vimKeys(): Promise<Extension> {
  const { vim } = await import('@replit/codemirror-vim');
  return Prec.highest(vim({ status: true }));
}

/** The look a side-by-side comparison shares with the editor. */
export const comparisonExtensions = (): Extension[] => [
  lineNumbers(), highlightSpecialChars(), drawSelection(), syntaxHighlighting(highlight), look, EditorView.lineWrapping,
];
