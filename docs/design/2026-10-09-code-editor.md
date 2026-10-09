# Code editor

A real editor inside Wanigan, for changing the owner's own files by hand: pick
a part in the live view, open its template, CSS or PHP, edit it with full
highlighting, save, and watch the page follow. It also opens from the Changes
view, from a turn's diff, and with ⌘P anywhere in a project.

Asked for by the owner on 9 October 2026, with breadcrumbs and Back and
Forward added the same day ("so you can go back and forth easier").

## The editor: CodeMirror 6

Measured on 9 October 2026 (npm registry, and bundles built with the esbuild
in this repository's node_modules, minified, gzip -9):

| | CodeMirror 6 | Monaco 0.57.0 | Others looked at |
|---|---|---|---|
| Licence | MIT | MIT | Ace: BSD-3; prism-code-editor, CodeJar: MIT |
| Weight in the window | core (state, view, language, commands, search, completion) 406 KB min / 131 KB gzip; all ten languages 427 KB / 151 KB; merge view 57 KB / 20 KB; Vim 161 KB / 52 KB, only when switched on | editor 2.47 MB min / 617 KB gzip, plus 1.29 MB / 317 KB of services, 362 KB / 111 KB worker host and 391 KB / 127 KB of CSS: about 4.5 MB / 1.17 MB before a language worker | Ace 55 MB unpacked (builds); prism-code-editor 3 MB unpacked; CodeJar 26 KB but no folding, search, completion or merge |
| Installed size | 39 packages, all pure JavaScript, no install scripts | 101.7 MB unpacked, plus web workers to wire into the CSP and the build | |
| Theming | CSS: the theme is written with `var(--token)`, so light and dark follow `tokens.css` with nothing to redefine | `defineTheme` takes hex colours; every theme switch means reading the tokens and redefining | |
| Languages we need | Official, maintained: PHP, HTML, CSS, Sass/SCSS, JavaScript/TypeScript, JSON, YAML, Markdown, XML, Jinja; legacy modes for shell, TOML, .env/ini, Dockerfile, nginx | Monarch grammars for PHP and Twig (regex only: no syntax tree, so no breadcrumbs from it) | |
| Merge view | `@codemirror/merge`, official | built in | |
| Accessibility | ARIA textbox, screen-reader tested upstream, Escape then Tab leaves the editor (built into the view since 6.28) | good, heavier | |

Monaco would be heavier by a factor of four to five, needs workers, and
fights the token-based theming the whole app is built on. Nothing newer was
better: `modern-monaco` (0.4.2) is Monaco underneath; prism-code-editor and
CodeJar lack a syntax tree, merge view and the completion we need. CodeMirror 6
gives a real syntax tree for every language here, which is what the
breadcrumbs read.

The editor loads lazily: the first time a file shows, `CodeSurface` and
CodeMirror arrive as one chunk (231 KB gzip), and each language as its own
small chunk when a file of that kind first opens. The window's main bundle
carries none of it. Vim keys load only when switched on.

### Twig

Three candidates, each parsing one Drupal-style template (blocks, `extends`,
`embed`, `include … with { … } only`, filters, `~`, `??`, `is not empty`,
arrow functions, `{% trans %}`, a `<style>` element) with every node coloured
by the same tags:

| | Twig and HTML coloured | HTML tags, attributes | CSS inside `<style>` | Twig-only tags (`extends`, `embed`, `trans`) | Parse errors |
|---|---|---|---|---|---|
| `@codemirror/lang-jinja` 6.0.1 (official, MIT, April 2026, 68 KB unpacked) | 625 of 841 characters | yes | yes | keywords | 5, each local: `a ? b` without `:`, an arrow function, `??`, a bare key in a hash |
| `@ssddanbrown/codemirror-lang-twig` 1.0.0 (MIT, March 2023, unmaintained by its own README) | 354 | no: HTML is plain text | no | `embed` and `trans` as variables | 7 |
| legacy `jinja2` stream mode | 656, but none of it HTML | no | no | plain | none reported (a stream mode does not report them) |

`lang-jinja` is the one that highlights Twig inside HTML correctly: Jinja's
syntax is Twig's (`{{ }}`, `{% %}`, `{# #}`, filters, tests, `~`), it lays an
HTML parser over the template's text, and Lezer's error recovery keeps the few
Twig-only expressions local. It is what `.twig` files open as.

### Extras

- **Vim keys** (`@replit/codemirror-vim` 6.4.0, MIT, July 2026): behind a
  switch in the status line, loaded only when on.
- **Minimap**: left out. `@replit/codemirror-minimap` is 0.x, and a drawer a
  few hundred pixels high has no room for one to help.

## Where files are read and written: the core

Owner methods in `src/shared/protocol.ts`, implemented in `src/core/files.ts`:

- `files.read`: the text (line endings as `\n`, no byte order mark), its
  sha256, size, line endings, BOM, final newline, encoding, and why it opens
  read-only. It also names the agent session whose hooks last reported writing
  it (`session_edits`), so a banner can say who changed it.
- `files.write`: saves only if the file is still the version `baseHash` names.
  Otherwise nothing is written and the file as it is now comes back, for the
  merge view. Atomic (a temporary file beside it, fsynced, renamed over it);
  the file's line endings, BOM and mode are put back exactly.
- `files.stat`: the hash now (cached by stat), polled for files that are open.
- `files.list`: quick open's list. In a repository, what git tracks plus
  untracked files it does not ignore, minus deleted files; elsewhere a walk.
  vendor and node_modules only when asked (then a walk of everything on disk
  but `.git`). At most 40,000 files, and a walk stops after 3 seconds; either
  says it was cut.
- `files.dir`: one folder's entries, folders first, for the breadcrumbs.

Rules, all enforced in the core: a path is relative to the project folder or
a card's own worktree; `..`, an absolute path, an empty or `.` segment and
anything named `.git` are refused before touching the disk, and the real path
(links resolved) must still be inside the real root and not inside a `.git`
folder. Only UTF-8 text (with or without a BOM) opens: NUL bytes, invalid
UTF-8 and UTF-16 are refused, as is anything over 2 MB.

Someone else's code opens read-only with the reason, told by markers on disk
rather than a folder's name: Drupal core (`core/lib/Drupal.php` beside it),
contributed modules, themes and profiles, a vendor folder (Composer's when a
`composer.json` sits beside it), node_modules, WordPress core
(`wp-includes/version.php`) and its plugins (not mu-plugins, which are the
site's own). **Edit anyway** sends `anyway`, and the activity says so. A file
the disk will not let the owner write stays read-only.

A save is recorded (`You edited <file>` in Activity) and emitted as the same
`live` edit event an agent's edit is, with `sessionId: null`; the live view
follows it exactly (a reload, or stylesheets swapped in place), a session's
split view included. It also emits `files` (never sent to phones: it names
files) and `git`, so Changes refetches.

## The editor in the window

- **The drawer** sits beneath the view, or beside it (a button), opens and
  closes with ⌘J, and is resized by its edge (dragged, or with the arrow keys,
  Home and End on it). Its height and width, the dock, wrap and Vim are kept
  on this Mac. In the live view the page above it shrinks with it; in a
  session it sits under the terminal (and the live view beside it).
- **One CodeMirror view** for every open file; each file keeps its own state
  (text, undo, cursor, scroll) while another shows. The editor stays loaded
  while the window is open, across views and projects.
- **Tabs** with a dot on unsaved files (in the text colour: an unsaved file
  does not need the owner, so it is not amber); closing an unsaved one asks.
  ⌘S saves, Revert puts the saved text back (undoable).
- **Editing**: line numbers, folding, bracket matching and closing, several
  cursors (⌥-click, ⌘D), rectangular selection, search and replace (⌘F), go to
  line (⌃G), completion from the language (CSS properties, HTML tags and
  attributes, JavaScript) and from words in the file, indentation read from
  the file, soft wrap (⌥Z), light and dark from the tokens, the app's mono
  font.
- **Someone else's change**: an agent's edit is noticed at once (the live event
  names the file); any other program's within a few seconds (the hash is
  polled, and checked when the window comes forward). With nothing unsaved the
  file reloads, keeping the cursor where the text did not change, and a calm
  banner names who changed it with Compare. With unsaved changes nothing is
  touched: the banner offers Compare and merge, Reload theirs (undoable), or
  Save mine over it. A save the core refuses (the file changed first) opens
  the merge view straight away: the version on disk on the left, the owner's
  text on the right as the result, arrows to take a change across, and Save
  merged.
- **Unsaved text survives** the window closing: it is kept on this Mac until it
  is saved or thrown away, and comes back when the file opens again (with
  Compare when the file changed meanwhile).

### Breadcrumbs, Back and Forward

Above the text: Back, Forward and Recent places, then the file's folders, the
file, and the symbols around the cursor, read from CodeMirror's syntax tree
(`src/renderer/src/editor/code/symbols.ts`): a PHP class and method, a Twig
block and the HTML elements inside it (even past a Twig tag), a CSS rule
inside its at-rule and Sass nesting, a JavaScript function, class, method or a
function kept in a constant, a YAML key path with list items by place, a JSON
key, a Markdown heading under the ones above it. Outside every symbol, `…`
lists the file's top-level ones.

Every crumb opens a menu of what is beside it: a folder's other files and
folders (folders open in place, `..` goes up), a method's sibling methods, a
rule's sibling rules. ⌘⇧. moves to the breadcrumbs; ← and → move between
crumbs; Enter or ↓ opens one; in a menu, typing narrows it, → enters a folder
and ← or Backspace leaves it; Escape goes back to the text.

Back and Forward (`src/shared/nav-history.ts`) remember every jump across
files: quick open, go to line, a breadcrumb, Edit code from the live view, a
search result, switching tabs, and any move of the cursor ten or more lines at
once. Places a few lines apart are one place; a place the cursor wandered to
before going Back is kept, so Forward returns to it. ⌃- and ⌃⇧- (Alt+← and
Alt+→ off a Mac) while the editor has focus, the mouse's own back and forward
buttons over it, the two buttons, and a long press or right-click on either
(or the clock) for the recent places.

### Where it opens from

- **The live view**: a picked part's template has **Edit code** beside Show in
  Finder, opening at the words picked when the template writes them; a
  component's files are each a button. In a session's split view the strip has
  the same.
- **Changes**: **Edit** on every file there is to change, in the checkout shown
  (the project folder or a card's worktree).
- **A turn's changes**: **Edit** on the file shown, in the folder the session
  worked in.
- **⌘P** (and Go › Open File…, and ⌘K): quick open over the project, or over
  the card's worktree the Changes view shows.
- **`openInEditor({ projectId, cardId?, path, line?, col?, find? })`** from
  `src/renderer/src/editor/store.ts`, for any other surface.

⌘P was Push. Push moves to ⌥⌘P: the owner asked for ⌘P as quick open, the
editor convention, and Push still shows what it sends before anything goes.

## Not built

- Creating, renaming or deleting files from the editor.
- Searching the contents of every file (quick open finds files by name).
- Language servers (go to definition, PHP diagnostics).
- Two files side by side, or one file in two places.
