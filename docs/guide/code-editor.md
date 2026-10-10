# Code editor

The code editor: the drawer, the Code tab, and how a save never lands over an agent's work. Back to the [README](../../README.md).

Change files by hand without leaving Wanigan: a drawer beneath the view (or
beside it) with a real editor, CodeMirror 6, loaded the first time you open a
file. The project's **Code** tab (G then E) shows the same editor as the whole
view, beside the project's files.

- **Opens from where you are.** ⌘P finds any file in the project by a few
  letters of its name or path (`name:42` for a line). **Edit** on a file in
  Changes or in a turn's diff; **Code** (.) on a part chosen in the live view
  opens its template where it writes the words you picked. ⌘J shows or hides
  the drawer, which stays as you left it (open or closed, beneath or beside,
  its height), kept on this Mac. In the live view it is the dock, with Notes,
  Problems, Request and the page's DevTools beside Code.
- **The Code tab.** The project's folders as a tree beside the editor, read a
  folder at a time, with the open file marked; arrows walk it, Enter opens a
  file, Space opens it and keeps your place in the tree, typing a name jumps to
  it. It is the drawer's own editor and files, not a second one: the drawer
  steps aside while the tab shows and comes back as you left it. ⌘J on the tab
  puts the editor away and goes back to the view you came from.
- **An editor, not a text box.** Highlighting for PHP, Twig (with the HTML,
  CSS and JavaScript around it), CSS and Sass, JavaScript and TypeScript, YAML,
  JSON, Markdown, XML, shell, TOML and .env files; folding, bracket matching,
  several cursors, search and replace (⌘F), go to line (⌃G), completion,
  indentation that matches the file, soft wrap (⌥Z), Vim keys if you switch
  them on. ⌘S saves.
- **Breadcrumbs, Back and Forward.** Above the text: the file's folders and
  where the cursor is (a PHP class and method, a Twig block, a CSS rule, a YAML
  key), each with a menu of what is beside it; ⌘⇧. moves there. Back and
  Forward (⌃- and ⌃⇧-, or the mouse's buttons) go between every place you
  jumped to, across files; hold either for the recent places.
- **Never over an agent's work.** A save names the version it was made from.
  If an agent (or anything else) changed the file since, nothing is written:
  you get both versions side by side to merge. A file an agent changes while
  you have nothing unsaved reloads, saying which session changed it.
- **Your own files only, by default.** Drupal core, contributed modules and
  themes, vendor folders, node_modules and WordPress itself open read-only,
  saying why (an update would lose the change) and how to override it instead;
  **Edit anyway** if you mean it. Nothing outside the project folder (or a
  card's worktree) opens, nor git's own files, nor anything binary or over
  2 MB.
- **The page follows.** A save is in the project's Activity and reaches the
  live view exactly as an agent's edit does: it reloads, or swaps the
  stylesheets in place.
- **Unsaved text survives** closing the window, until you save it or throw it
  away. Esc then Tab leaves the editor for the rest of the window.

⌘P used to be Push; Push is now ⌥⌘P.
