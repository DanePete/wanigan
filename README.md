# Wanigan 2

A local production desk for coding agents. Every project you open gets a board;
cards move from Inbox to Done; real Claude Code, Codex and shell sessions work
them in terminals that keep running when the window closes; and one place,
**Needs you**, says what is waiting on you across every project.

This is a ground-up rebuild. The design, including what was kept, merged, cut or
added from Wanigan 1 and the OnTour Production Hub, and why, is in
[docs/design/2026-10-06-wanigan-2.md](docs/design/2026-10-06-wanigan-2.md).

## Try it

This source tree targets Wanigan 2 beta.4, a limited beta for macOS on Apple
silicon. Its scope is the existing project boards, terminal sessions, saved
work and **Needs you** workflow. The known limits below still apply.

[Download the DMG or zip](https://github.com/DanePete/wanigan/releases/tag/v2.0.0-beta.4),
then drag Wanigan 2.app to Applications. The app is ad-hoc signed and not notarized;
macOS may require approval in Privacy & Security before opening it.
Verification status and remaining acceptance checks are recorded in
[the feature matrix](docs/features.md).

The independent review ran on macOS 26.5 with stand-in agents. It did not
repeat the historical real-CLI scenario described below.

You can also build from source. The commands below select the beta.4 tag to
match the download; `main` may contain a
different version.
You need:

- **Xcode Command Line Tools** (`xcode-select --install`). Installing compiles
  the terminal and database modules for Electron.
- **Node 22.23.2.** With nvm, `nvm install` in the folder reads `.nvmrc`.
- **Claude Code, Codex or Gemini CLI**, installed and signed in, to run real
  agents. The demo needs none of them.
- Optional: **`gh`**, signed in, for pull requests, and a **TypeSafe API key**
  for Jev (Settings › Jev).

```sh
git clone --branch v2.0.0-beta.4 https://github.com/DanePete/wanigan.git
cd wanigan
nvm install
npm install           # also compiles SQLite and node-pty for Electron
npm run dev           # the app, with hot reload
```

**Start with the demo:** Help › Open the Demo. It opens a second Wanigan with
sample projects and stand-in agents, in its own data folder; nothing real is
touched and no model is called. Help › Leave the Demo closes it.

**Then open a real project:** the + beside Projects in the sidebar, or
⌘K › Open a project. Pick its Claude Code and Codex accounts with the gear
beside its name, start a session on a card, and keep **Needs you** open.

**To build the app itself:** `npm run dist:mac` writes
`release/mac-arm64/Wanigan 2.app` and a zip. Drag the app to Applications.
The release DMG is assembled separately from that app.

### What it does on your Mac

- Its data lives in `~/Library/Application Support/Wanigan 2/` (the demo's in
  `Wanigan 2 Demo/`). Project discovery and History use the agents' own
  records; no database from a previous Wanigan installation is opened.
- Nothing is written into your projects to make Wanigan work. Hooks,
  instructions and the `wanigan` command are handed to each session when it
  starts. Copying a skill to a project or adding a project's MCP server writes
  there, on your click, after showing exactly what changes. A card's worktree lives in
  Wanigan's data folder, but its branch and git's own record of the worktree are
  in your repository, as with any `git worktree`. The live view's site helper
  is the same: written into the site only when you install it, after showing
  what it writes and runs, kept out of git, and removed on your click.
- A core process keeps running after you quit, so your sessions keep going. It
  exits by itself ten minutes after the last session ends with no window open,
  unless phone access is on.
- Wanigan has no account, no cloud and no telemetry. It calls two services
  itself, each only once you ask: GitHub, to see whether a newer version is out
  (Check for Updates, or the daily check once you say yes to it), and
  TypeSafe, for Jev, once you give it a key: in Settings, or as
  `TYPESAFE_API_KEY` in your shell. Each project can turn Jev off. Everything
  else is the CLIs you already use, run as you: `claude`, `codex`, `gemini`
  and `gh`, LM Studio's `lms` if you run models on this Mac, and `tailscale`
  if you use Wanigan on your phone, whose notifications go through your
  phone's own push service.
- Agents run with your permissions, exactly as they do in your own terminal.
  Wanigan watches and records them; it does not sandbox them.

### Models on this Mac (optional)

Claude Code can run on a model that lives on your Mac, through
[LM Studio](https://lmstudio.ai): prompts and code go to it, not to a model
provider, and no plan's limits apply. It is optional. Without LM Studio,
Wanigan works exactly as it does, and nothing is downloaded until you choose.

- **Settings › Local models** shows whether LM Studio is installed and its
  server running, and the models Wanigan knows how to run. The first is
  **Qwen3-Coder 30B** with Claude Code (17.2 GB, MLX). **Get** shows the size
  before anything is fetched, checks there is room (Wanigan keeps 10 GB of the
  disk free), shows progress and can be stopped; it carries on where it stopped.
- **New session** offers these models under **On this Mac**. A project's
  settings can make one the model its new sessions start on.
- Starting a session starts LM Studio's server if it is off (on whichever port
  it chooses) and loads the model with room for an agent's instructions and
  tools. A model that is not there refuses to start; nothing falls back to a
  cloud model. Claude Code is told to send Anthropic no telemetry either.
- Models a running **Ollama** (or **NVIDIA PAIR**, at Ollama's address) has are
  offered too, with Claude Code or Codex. Wanigan does not download through them.

Each model says whether its pairing with an agent has been proven: a real turn
with a tool call, read back from Wanigan's own record by
`npm run local:check`. A model not yet proven may not use tools
reliably.

### Live view (optional)

Your local Drupal, WordPress or other site, inside Wanigan, following the
agents as they work. Every project has a **Live** tab. The view is off until
you switch it on, from that tab or in **Settings › Live view**, where Drupal,
WordPress and other sites can each be on or off.

- **One bar, three groups.** The site (one menu: Local and the hosted
  environments to show the page on, Compare, Site settings), the page (back,
  forward, reload, the address, the width, the lens) and the tools (Pick, and a
  menu for drag handles, the default browser and a card's before and after). One
  status line under the page says what just happened (what an edit outlined,
  a hosted environment shown read-only, a piece shown alone, a palette entry
  being placed), what the view follows, and the keys that work now. In a
  narrow window, or with the dock beside it, the bar narrows without drawing
  anything over anything: the address field shrinks, then the tools show
  their icons only, then they take a row of their own.
- **Around the page.** The side panel holds the Layers tree (with a chosen
  part's details under it, the tree folded to that part's branch, or beside it
  in a window 1680 px wide or more), Add, the component library and the
  design layer's edits. Beneath the page, a dock shared with the code editor:
  Code, Notes, Problems and Request, opened from its tabs (they wait in a strip
  when it is closed) or ⇧[ and ⇧]. What it shows, its height, its side and
  whether it is open are kept on this Mac. Compare is drawn where the page is,
  and leaving it puts the page back as it was.
- **Keys for everything**, in the view and in its page while nothing is typed
  into: P picks (and stops picking), ⇧L chooses a lens, 1 2 3 the widths,
  [ and ] the side panel's tabs, ⇧[ and ⇧] the dock's, ⇧C Compare, ⇧B the
  component library; on a chosen part E edits, M moves, . opens its code, ⇧A
  shows it alone, ⇧X takes it out; ⌘↩ adds a note, ⇧⌘↩ sends it (or the notes
  waiting). All are on the shortcut sheet (?).
- **Finds the site** from the project's own files (`.ddev`, `wp-config.php`,
  a dev script, `.lando.yml`) and opens the site you already run. It starts
  nothing on its own. A ddev site's certificate is trusted when this Mac's own
  mkcert authority issued it.
- **Says why a site is not shown.** For a ddev site it asks ddev
  (`ddev describe -j`) whether the site is running, as the view opens and
  again when a page fails. A paused or stopped site is said as that ("This
  site isn't running: ddev says it is paused"), never as the certificate ddev's
  router answers with for it, and **Start it** runs `ddev start` in the
  project folder on your click, showing its lines, then loads the page. A
  refused certificate is described as it states itself (who issued it, what it
  covers, when it expires) and named for what it is: made by another machine's
  mkcert (naming that authority), kept in the project's `.ddev/traefik/certs`
  or `.ddev/custom_certs` (naming the file), ddev's router answering for
  another project, expired, for another name, or this Mac having no mkcert
  authority yet. Each says what to do; nothing is changed without your click.
  A Lando site or dev script that does not answer is named, with how it is
  started; Wanigan does not start those. A card's screenshots and the site
  helper's saves give the same reasons.
- **Follows the edits.** When an agent edits a file, the page reloads (or swaps
  only its stylesheets) and the parts that file made are outlined. A session's
  own view says "*file* changed · See it".
- **Layers.** The page's parts as a tree, named the way the site names them:
  Drupal's templates, components, content, fields, blocks and regions (from Twig
  debug's own comments), WordPress's template files and blocks. A part chosen
  there or picked on the page (from the keyboard too: P starts on the chosen
  part, the arrows walk, Enter picks) keeps the tree in view, marked where the
  part is, and offers the same verbs: **Edit ▾**
  (every way to change it, by where the change is saved: in the site, on the
  page, in code), **Move**, **Code** and **Alone**; the note to an agent is
  right under them, and why it looks as it does (whose code it is, how to
  override someone else's template in your theme, its data, cache and cost)
  is folded below.
- **Notes for an agent.** Point at parts across pages, say what should change,
  and send them to a session as one message with a picture of each part. They
  wait in the dock's Notes tab.
- **The design layer** (Edit ▾ › On the page, and Edits, ⇧E). Retyped words
  and tried styles are kept by Wanigan, not written into the site: the page
  shows them at once, through the layer. A style is for one element or every
  instance of its kind (how many, said before you choose it); a custom
  property can change for the whole site. Edits lists every edit by page, with
  before → after, what it reaches, its state, and why when it no longer finds
  its element. Make it real saves words through the site itself to the one
  thing that holds exactly those words. On Drupal: a text field (a plain one,
  or one run of words inside formatted text, spliced in with its markup kept
  and saved only when the field's own text format shows nothing else changed),
  a field's label, a block's title, the site's name and slogan, the words of a
  view's header, footer or empty text, a menu link's text, or the words of a
  Layout Builder inline block, through its layout (a default layout that every
  page of a kind shares is saved only when you make it real again, after it
  says how many pages that reaches); configuration says the next config import
  puts back what is exported. On WordPress a title, an excerpt, a string meta,
  the site's title or tagline, or a menu link's text, each through core's REST
  API with a revision where WordPress keeps one. Or to your own template when
  they are written there exactly once (with a revert). When nothing the page
  offers holds the words (a page builder's, a shortcode's, a contributed
  field's), Wanigan looks where the content keeps them and saves them there
  through core: on WordPress the post's stored content (its markup, a
  shortcode's settings and the words it wraps, a block's settings, changed
  together with the block's markup when it keeps them twice), its excerpt and
  its custom fields (JSON written back token by token with the escapes it was
  written with, a saved list as a list, a field with a row per value by its
  row); on Drupal every field of the content the page showed that its other
  saves do not cover (a contributed field's value, JSON in it, a map, a link's
  title), in that translation, as a new revision. The words must be found
  exactly once, as words; otherwise it says where they are (twice, only in an
  address or a class, made from a template like `%%title%%`, in the site's
  settings) and saves nothing. Elementor's pages are read from the tree
  Elementor renders and saved through Elementor's own save (its caches cleared,
  a revision kept); ACF's fields, repeater rows, blocks and options are saved
  through ACF with its validation (an option every page shows is saved only when
  you make it real again); known copies that never render (Beaver Builder's
  stored-content copy, SiteOrigin's, an SEO plugin's mirror) are never saved
  into, and Beaver Builder's own layout is refused, saying so. After the save the
  page reloads and is read back: if it still shows the old words, it says the
  site has them but whatever renders them may keep its own copy, and Undo puts
  the old value back (custom fields keep no revision, so this is their only way
  back, for ten minutes). Words a plugin computes and never stores, and a
  builder's own cache, are beyond it. What it cannot save
  says why, and which kind of why: Drupal keeps no such thing (words written
  in a Twig template, a menu link written in code, a base field's label), or
  Wanigan does not do it yet (an interface translation, a caption, words
  across formatting). Formatted text on WordPress (a block's, a post's
  content) and words a Drupal template writes go to an agent, as does a style:
  never written into the stylesheets by hand. Then Verify renders the page
  with and without the layer and says what differs, with pictures. Undo, redo,
  discard, and the page shown without the layer to compare. The window has
  been checked against the UI sweep's stand-in; on the Northstar demo, a
  script driving the real app made words in a plain field real and verified
  them. Drupal's formatted text, configuration and Layout Builder saves, and
  WordPress, have been tested with stand-ins only, as have the stored-words
  search and save (Elementor and ACF with stand-ins made in the shape of their
  public code; ACF PRO's repeaters, blocks and options follow ACF's documented
  storage and are not yet checked against ACF PRO itself).
- **Go to**, in the address field (click it, or Shift+Space in the live view,
  ⌘⇧Space anywhere in a project): an address, or any page of the site by
  typing a few letters of its title, an admin or structure page, a path or an id, ranked as you type and by what you choose
  often; Enter opens it in the view, ⌥Enter its edit form, ⌘Enter the default
  browser, → its tasks. It searches the whole site through the helper, and
  without one, the pages the view has seen.
- **The site helper** (Drupal module or WordPress must-use plugin), installed
  on your click: names every piece exactly, shows one piece alone (with sample
  content where there is none), and reloads when content changes too. The
  Drupal helper also traces each render through Drupal core itself: the
  template, suggestions and preprocess steps behind every part, its variables
  (secrets redacted), cache metadata, time, queries and hooks; each part's edit
  through Drupal's own forms (a field's own widget, a block's or a menu link's
  form, Layout Builder's page, or a template copied into your theme when you
  say so); moves, inserts and taking an item out where Drupal itself keeps an
  order (a field's items, a region's blocks, a menu, a display's fields, Layout
  Builder), with undo; and the Go to launcher's list of pages. It names no module: anything
  built on Drupal core shows up through it. How it hooks core:
  [docs/research/2026-10-09-drupal-core-live-trace.md](docs/research/2026-10-09-drupal-core-live-trace.md).
  The WordPress helper traces each render through WordPress core's hooks the
  same way, and saves a part's change through core's REST API as you, where
  core keeps it: a post's fields and meta; a block's words with their
  formatting, or beside its nested blocks, written as that one block (cleaned
  as core cleans bound rich text); words bound to a post field, in that field;
  a synced pattern's words for every page that uses it, or one placement's own;
  a template's or template part's words (the first save copies the theme's
  file into the database, as the Site Editor does); a navigation menu's labels;
  a classic widget's settings; an image's alt in the media library, beside an image
  block's own. Each says where it shows. What WordPress keeps nowhere it can
  write (a static block's settings, words from a theme's pattern file, a
  fallback menu's links) says so, and so does what Wanigan does not do yet.
  How it hooks core:
  [docs/research/2026-10-09-wordpress-core-live-trace.md](docs/research/2026-10-09-wordpress-core-live-trace.md).
- **The component library** (⇧B): everything the site can place, as its core
  lists it through the helper: Drupal's single-directory components and the
  block library's blocks, WordPress's block types, patterns and block styles.
  Each is pictured alone in the site's own theme at a phone's and a desktop's
  width (in a hidden window; kept until its files change), with its props,
  slots, files (opening in the Code tab), where the rest of the site uses it
  (the helper's read-only search of what the site has stored, which says what
  it cannot see: on Drupal placements, Layout Builder layouts and, for a
  component, a parse of the theme's Twig; on WordPress stored block markup,
  theme files, patterns and widgets, followed through synced patterns, parts
  and patterns) and where this page uses it. Add one
  by dragging it onto the page or with Place and a click, through the same
  insert as the palette; what core cannot place alone (a Drupal component
  outside a template or field) says so.
- **Take out** (⇧X) on a chosen part: only its placement or reference goes,
  never what it showed. A Drupal block placement or menu link is switched off
  as its own form does it; a WordPress widget goes to Inactive widgets; a
  WordPress menu item is deleted and Undo makes it again. Anything shared (a
  region's blocks, a menu, a template, a synced pattern, a reusable block) says
  where it shows and asks first. Refused where core would delete what it
  showed. Seen working on both demo sites.
- **A helper another Wanigan set up** (another Mac, a reinstall, a test)
  answers only to that one, so the view says so at the top of its panel, and
  Go to too, with setting it up again here as the way out.
- **Before and after.** With screenshots on, each card shows its page as its
  session began and after each turn that changed files, with what changed
  boxed. Taken and kept on this Mac.
- **Widths and problems.** Phone, tablet and full width; what the page reports
  as wrong (its own error messages, its console), in the dock's Problems tab.
- **Local and Live.** In the site menu beside Local, the site's hosted
  environments (Dev, Test, Live, as the host names them), each showing the same page. Found
  in the project's own files (Drush and WP-CLI aliases, ddev's and Lando's
  Pantheon settings with `pantheon.yml`, Stage File Proxy's origin, environment
  variables in ddev or compose files, a README's tables), each saying which
  file; only the ones you keep (or type) are in the menu. A hosted environment is
  **read-only**: its own private session (no cookies shared with your local
  site), never the helper's token, its certificate checked as any browser
  would, and only requests that read (GET, HEAD, OPTIONS), so no form can be
  sent and nothing in the view can change it (what a page loads by POST stays
  empty); no hand edits and no helper there. Pointing at parts and notes still
  work.
- **Compare.** The page you are on, taken whole on Local and on a hosted
  environment at the same width (phone, tablet or desktop), lined up row by row
  so a section only one side has is a striped band rather than everything below
  it marked as changed. Drawn where the page is, with the side panel and the
  dock beside it; Escape (or ⇧C) puts the page back exactly as it was, not
  loaded again. Slider, onion skin, difference, flip and side by side;
  each changed area boxed, counted and named by the local part it overlaps.
  Keys: ← → or Space flip, S O D T for the modes, J and K for the next and
  previous change, 1 2 3 for the widths, I to ignore a change (a slideshow, a
  clock), remembered for the site. Content that differs usually means the local
  database is older, not that the code changed, and it says so.
- **What reaches a hosted site.** Showing a page on a hosted environment, or
  pressing Compare, sends requests to that site, only when you do it. Wanigan
  asks it for nothing in the background (while it is shown, the page loads
  what it loads, as in any browser), and the local site's helper token never
  goes there.
- **With the helper's trace** (being finished; seen so far only against a
  stand-in): lenses that colour the page by owner, cache, cost, what can be
  edited and what just changed; a part's hooks, data, cache, cost, revisions
  and access; the request behind the page (hooks, queries, assets, logs), in
  the dock's Request tab;
  editing a part where it shows, in the site's own form or a small one;
  dragging parts the site can reorder, with Undo (a part whose order is in a
  template becomes a note for an agent); adding blocks from a palette. All of
  it by keyboard too.
- **Agents see it too.** Every agent session is handed Wanigan's own MCP
  server, `wanigan mcp`, with eight read-only tools: `live_status`, `live_look`
  (a page and its parts, named the way Layers names them, with a picture only
  when asked), `live_find`, `live_part` (what the Inspector shows: whose code
  it is, the override to create, the admin link), `live_problems`,
  `live_diff` (what changed since the session's last turn, each changed area
  matched to the edited file that explains it, or said to be unexplained), and
  `live_site_ai` (the AI the site runs as its core reports it, never a key,
  and the code beyond core that runs when content is saved), and
  `live_library` (the component library above, so a change can name a real
  component, block or pattern).
- **The site's AI, before it spends.** The Inspector's AI on this site lists
  WordPress core's AI Client, its connectors (set up or not, where each key
  comes from, never the key) and abilities; Drupal core has no AI API, and it
  says so. Before an edit, a move or an insert saves, the live view says whose
  code also runs on that save (found through each platform's own hook lists),
  and on WordPress it says afterwards which prompts core's AI Client sent and
  which abilities ran. Every write is read back after the page reloads, and
  one that changed nothing is said plainly.
  Pages are rendered in a hidden window, so your own view never moves, and
  only the project's own local site is ever opened. Every call shows on the
  card, under **Looked at the live view**.

#### What each agent gets, and what has been seen working

Checked on 9 October 2026 without a sign-in or a model call, each CLI in a
throwaway home, against the real `wanigan mcp`:

- **Claude Code 2.1.293**: `--mcp-config` with a file in Wanigan's data folder,
  beside your own servers. Seen: `claude mcp list` and `get` connect, agree on
  protocol 2025-11-25 (after a `server/discover` probe the server answers as
  unknown) and list the six tools; started with Wanigan's exact flags and no
  sign-in, it loaded the server, listed its tools and resources, and stopped at
  "Not logged in". Wanigan's settings file allows the six tools by name, so a
  look does not stop the agent to ask; Claude Code skips an invalid rule rather
  than the whole file (read from its binary), but a tool running unasked has
  not been seen in a signed-in session.
- **Codex 0.155.1**: `--config mcp_servers.wanigan.…` for that launch, with
  `env_vars` naming the session's socket and token (without it Codex passes
  the server neither: seen). Seen through its app-server's
  `mcpServerStatus/list`: connected, protocol 2025-06-18, six tools marked
  read-only, three resources. Not seen: whether Codex asks before calling them,
  and whether its sandbox lets the server reach Wanigan's socket in a real
  session.
- **Gemini CLI 0.46**: in Wanigan's own Gemini home, trusted, with the socket
  and token passed by name (Gemini hides variables named like tokens from an
  MCP server otherwise). Seen: `gemini mcp list` connects (protocol 2025-11-25)
  and the token reaches the server. A Gemini session listing the tools needs a
  sign-in and has not been seen.
- The listings above were seen with the first six tools; `live_site_ai` and
  `live_library` came later and have been seen only through Wanigan's own
  tests, not in a CLI's listing.
- With no real agent has a tool call been seen through a model's turn, or a
  look at a real site; the tools' answers are tested against a real core with a
  stand-in for the app. No installed CLI subscribes to MCP resources, so the
  server does not offer subscriptions.

### Code editor

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
  Problems and Request beside Code.
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

### Gemini CLI

Gemini CLI runs in a terminal like Claude Code and Codex, and reports its turns,
its tools and what it asks you through hooks. Gemini takes hooks only from its
own settings, so Wanigan keeps a Gemini home in its data folder
(`GEMINI_CLI_HOME`) holding Wanigan's hooks; your own `~/.gemini` is never
written. Your sign-in stays where Gemini keeps it. As each session starts,
your chosen sign-in method, trusted folders and MCP servers are copied in, but
only servers holding nothing that could be a credential: a key written into a
server's settings keeps it out (the MCP view says so; write it as `$NAME` from
your environment to use it). Your own skills (`~/.gemini/skills` and
`~/.agents/skills`) are linked in, so Gemini reads them where they are. The Skills and MCP views list Gemini's with
each project's `.gemini/skills`, `.agents/skills` and `.gemini/settings.json`,
and add or copy to them on your click. Your own Gemini extensions and global
`GEMINI.md` live in your home and are not loaded there.

- In a folder Gemini has not been told to trust, it asks first, and loads no
  hooks until you answer; Needs you shows it as not yet started.
- The composer works from Gemini's second message: its first screen may ask you
  to sign in or to trust the folder, so the first message goes in its terminal.
- Nothing reports a refused permission or a cancel; its window title going back
  to Ready does, and Wanigan reads it.
- Nothing reports its usage limit either: Gemini draws a dialog (keep trying,
  switch model, or stop). Wanigan reads that dialog's exact words in a turn, so
  the session shows as limited, with the reset Gemini printed, and Needs you
  sends you to its terminal. Stopping keeps it limited until the next prompt.
  It is screen text: if Gemini rewords it, Wanigan misses it.
- Its tokens are counted from its own chat file, the one its hook names inside
  Wanigan's Gemini home: each reply once, cached input apart, thoughts as
  output.

What was proven and how is in
[docs/research/2026-10-07-gemini-and-grok.md](docs/research/2026-10-07-gemini-and-grok.md).

### On your phone (optional)

Wanigan has a page for your phone: what needs you, answered there; your
sessions, with their terminals, typed into; a new session on any project, with
any account and model; and your boards, with new cards, accepting, approving
and sending back. Your phone reaches your Mac through
[Tailscale](https://tailscale.com), a private network between your own devices,
free for personal use. Nothing is put on the internet, there is nothing to
install from an app store, and there is no Wanigan server in between.

1. Install Tailscale on your Mac and on your phone, and sign in to both with
   the same account.
2. In **Settings › Phone**, choose **Turn on phone access**. If Tailscale still
   needs something (signing in, or HTTPS certificates turned on for your
   network), Settings says what and links to it.
3. Choose **Show a pairing code** and point your phone's camera at the QR code.
   On an iPhone, add Wanigan to your Home Screen (Share › Add to Home Screen),
   open it from there and enter the code: iPhones only send notifications to
   Home Screen apps. Name the phone and tap **Pair**.
4. On the phone, **This phone › Turn on notifications**. Then **Send a test
   notification** from Settings › Phone on your Mac.

What it does:

- Wanigan listens on `127.0.0.1:47832` only, and runs one command, shown before
  you turn it on, so that Tailscale serves it at
  `https://<your-mac>.<your-tailnet>.ts.net/wanigan/` to your own devices:
  `tailscale serve --bg --https=443 --set-path=/wanigan http://127.0.0.1:47832`.
  Anything else you serve with Tailscale is left alone, and **Turn off**
  removes only `/wanigan`.
- A pairing code works once, for ten minutes; after ten wrong codes in a minute
  pairing waits. Each phone gets its own key, kept on the Mac only as a hash.
  **Forget** cuts a phone off at once, open connections included. **Can act**
  off makes a phone read-only.
- A phone never reaches settings, accounts, sign-ins, git, skills, MCP servers,
  files on the Mac, Jev's key or pairing. What it does is in Activity as "You,
  from" the phone's name.
- Notifications go through your phone's push service (Apple's for an iPhone,
  Google's for Chrome, Mozilla's for Firefox), encrypted to your phone so the
  service cannot read them. They say what the Mac's banners say.
- A session started from the phone runs on the Mac, in the project's folder,
  exactly like one started there. A terminal is drawn at the size it has on the
  Mac, scaled to fit; **Fit to this phone** resizes it, on the Mac too.
- While phone access is on, Wanigan's core keeps running with the window
  closed, so your phone can reach it. The Mac has to be awake.

### Updating

**Wanigan 2 › Check for Updates…**, or **Settings › Updates**, asks GitHub
whether a newer version is out. Wanigan can also check once a day: the sidebar
asks you once, and nothing is checked until you say yes. A check reads GitHub's
public list of releases. No project, conversation or usage data is included;
GitHub receives normal connection metadata. Someone running a prerelease
(alpha, beta or release candidate) is offered newer prereleases and stable
releases; someone on a stable release is offered only stable releases.

To install a new version, quit Wanigan, open the disk image and drag Wanigan 2
into Applications, replacing the old one. Your projects, boards and history live
in the data folder, not in the app, so they stay. Sessions run in Wanigan's
core, which outlives the window: if any are running when the new version opens,
it asks before restarting the core, because a restart ends them.

This ad-hoc-signed build offers manual downloads; automatic installation is not implemented.

A version without Check for Updates in its Wanigan 2 menu cannot tell you
about new ones: watch the repository's releases on GitHub (Watch › Custom ›
Releases), or download the newest from there once.

### If something goes wrong

- **`npm install` fails compiling node-pty or better-sqlite3:** install the
  Xcode Command Line Tools, then run `npm run rebuild`.
- **The window never opens, or Electron behaves like Node:** your shell sets
  `ELECTRON_RUN_AS_NODE` (VS Code's terminal can). Run
  `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- **Logs:** `core.log` and `core.out.log` in the data folder. They contain
  project paths, so read one before you attach it to an issue.
- **Anything else:** [open an issue](https://github.com/DanePete/wanigan/issues/new/choose).
  It helps to know your macOS version, `claude --version` and `codex --version`.

## How it works

| | |
|---|---|
| **Projects** | A folder you open. It gets a short key (`NS`), its own board, sessions, changes, decisions and history. Nothing is written into it. |
| **Cards** | Task, bug, feature or idea. Inbox → Ready → Working → Review → Done. Agents file into the Inbox and cannot take a card from it; review needs evidence; only you approve. Each card shows its priority, how long it has sat in its column, who holds it and whether they are running. **How this works** on every board draws the whole flow with live numbers. |
| **Board views** | Each board reopens with the filter, card types, priority, agent and order it was left in. Save that view under a name and apply it again in one click, or with its number (1–9) on the board. The toolbar names the saved view the board shows and says when you have changed it since, with Update and Revert. Saved views are kept in Wanigan's database, per project, and only you can read or change them. |
| **Jev** | TypeSafe's decision model reads each new card when enabled: what to do with it, how much it matters, and whether it repeats another card. Advice, unless a project lets it accept confident cards that already have criteria. Each HTTP attempt is counted; cost is estimated from successful responses’ reported usage. Response time varies; the key stays in the core. |
| **Sessions** | Real terminals. Start one on a card (it takes the card) or on its own for quick work; make it a card later. They run in Wanigan's core, not the window. Pick the model and effort; Claude sessions can opt in to Remote Control, to reach them from the Claude app. |
| **Attachments** | Paste, drop or pick images and files into a session, a reply in Needs you, or Talk to Wanigan. They are kept in Wanigan's data, never in the project, and reach the agent the way its CLI takes them: Claude Code and Codex attach a pasted image path as an image. |
| **Watch** | Running's second layout: up to four live terminals at once, the ones that most need you first. A tile never resizes its session; click one to type into it. |
| **Tokens** | Each session's header shows what its conversation used and how much is in context now, read from the CLI's own transcript; a card adds up its conversations. No dollars: a plan is not billed per token. |
| **History** | Earlier Claude Code and Codex conversations discovered in a project's folder and its card worktrees, across configured accounts, including ones run in a terminal or VS Code. Per-file reads and transcript previews are bounded; total discovery still has open limits under review. Read one, or resume it as a live session (⌘⇧T). Read from where the CLIs keep them and never written; a CLI's database is read from a temporary copy, so the CLI is never blocked. |
| **Needs you** | Permission prompts, reviews, questions from agents, failed or interrupted sessions, usage limits, Claude Code's and Codex's (a Claude Code conversation continues on another account in one click), finished turns: ranked, across every project, and announced in the window or as a notification. Reply to a finished turn or answer a question in place; a permission row shows exactly what is asked, with hidden or lookalike characters spelled out. |
| **Accounts** | Claude Code and Codex accounts found in supported config locations, with who each is signed in as according to the CLI. Each project picks its own. |
| **Pause** | Per project: no new sessions or claims, and live agents are asked to wrap up. Nothing running is killed. |
| **Code editor** | A drawer beneath any project view, or the project's Code tab beside its files: open with ⌘P, the tab's tree, Edit in Changes or a turn's diff, or Code on a part in the live view; breadcrumbs and Back and Forward; a save never lands over an agent's change, and the live view follows it. |
| **Changes** | A project's uncommitted git changes, or everything one card's branch changed: syntax colour for PHP, Twig, YAML, JS/TS, CSS and more, unified or side by side, a Viewed mark per file, J/K between files, and notes on lines sent to the agent as one message. |
| **Branches** | A card can work on its own branch in its own git worktree, so agents never share a checkout; merge it back with one button that refuses rather than forces. |
| **AI review** | On request, Claude Code checks a card against its criteria with read-only tools and cites file-and-quote proof; Wanigan checks every quote against the file. Advice only. |
| **Draft with Claude** | Turns a rough note into a clear card with checkable criteria, reading the project read-only. You edit it before it exists. |
| **Talk to Wanigan** | The round button at the bottom right. Ask what needs you, what a card is waiting on, or what the agents did today: Claude Code answers from Wanigan's records (and, in a project, its files, read-only), cites card keys, and continues the conversation. Each message uses a turn of your plan; nothing runs until you send. Advice only. |
| **Usage** | What each Claude Code and Codex account has left (session and weekly limits), read from the CLIs themselves; two folders on one login are flagged. |
| **Decisions** | Rules for a project, told to every session that starts there. |
| **Pull requests** | An approved card's branch is pushed and its pull request opened with `gh`, after a confirm that shows exactly what goes where. |
| **Wanigan** | The 3D water is Wanigan. He swirls while thinking, raises the alarm when a session fails, shows a blue flame when it recovers and celebrates when nothing needs you. |
| **Demo** | Help › Open the Demo: sample projects, stand-in agents, its own data, nothing real touched and no model called. |
| **Skills** | Supported personal and project skills for Claude Code, Codex and Gemini CLI, Claude plugin skills and Claude-synced skills, read in place. Built-in and Codex plugin skills are not listed. Copy one to a project or your own skills, or remove one, after seeing exactly which files change. |
| **MCP servers** | Every MCP server each account and project has (and Gemini CLI's, which has one sign-in), secrets hidden, and a store of twelve well-known ones. Adding or removing runs the agent’s own CLI as that account, only on a click; a server that needs a key is finished in a terminal, never handed to Wanigan. |

### Agents use the board through `wanigan`

Every session Wanigan starts has a `wanigan` command on its `PATH`, acting as
that session and only inside its project:

```
wanigan status                       your card, cards sent back to you, the top of Ready
wanigan claim NS-12                  take a card
wanigan note NS-12 "found the cause"
wanigan review NS-12 --evidence test-output.txt --note "fixed; tests pass"
wanigan file bug "Coupon field accepts expired codes"
wanigan ask NS-12 "Cart drawer too, or only the cart page?"
```

Claude Code is told this, its card and the project's decisions when it starts
(a `SessionStart` hook); Codex is told the same at launch.

`wanigan mcp` is the same command as an MCP server, which Wanigan hands each
agent CLI when it starts a session: the live view's tools (see Live view).
Nothing is written into the project for it.

Search (⌘K) finds projects, cards, sessions and commands, and what agents said
in their sessions' recorded output.

## Architecture

```
renderer (React) ── typed IPC ──▶ Electron main ── socket ──▶ core (SQLite, PTYs, rules)
                                                                ▲
                                          wanigan CLI ── socket ┘  (session token = identity)
```

- **`src/core`** owns the database and every terminal. It is Electron's binary
  in Node mode, started detached, so quitting the app never ends a session.
  Board rules are enforced here.
- **`src/main`** starts or finds the core and forwards an allowlist of methods.
- **`src/renderer`** is the interface. It reaches the core only through
  `window.wanigan`.
- **`src/cli`** is the agents' `wanigan` command.
- **`src/shared`** is the typed protocol (`protocol.ts`, one map of every method
  and who may call it) and the pure rules: board transitions, how hook events
  become session state, Codex's lifecycle, notifications.

Claude Code state comes from hooks injected with `--settings` and relayed by a
three-line `sh` script over `nc`. Codex gets the same hooks from `-c` flags,
trusted by hash for that launch only after Codex's own app server lists them as
trusted (`scripts/codex-hooks-probe.ts` re-checks a new Codex version, spending
nothing); otherwise, and as a fallback, its state comes from the OSC 9
notifications it writes when asked to. A Codex turn that fails (its usage limit
included) or is interrupted fires neither a hook nor a notification; the
thread's rollout records it, and the core reads it there for the turn the
hook named. A shell reports only running, ended, or
failed with its exit code. Any session ended by a signal Wanigan did not send is
failed too.

AI review, Draft with Claude, commit-message drafting and Talk to Wanigan
require Claude Code with
`--safe-mode` and `--setting-sources` support; these flags were checked in
2.1.293's help. Advisory runs request that custom hooks, skills, plugins and
settings be disabled. Custom provider-routing settings may therefore be
unavailable. An unsupported CLI reports an error. This review verified the
launch contract with stand-ins; it did not repeat a real model run with these
flags.

## Tests

```sh
npm test            # typecheck, unit + integration tests, UI and phone sweeps
npm run test:release  # npm test, then the control crawl (before a release)
npm run smoke:app   # the real Electron app: core, window, a terminal, the CLI, outliving a quit
node scripts/app-smoke.mjs --app "release/mac-arm64/Wanigan 2.app"   # the same against a packaged build
npm run scenario    # the whole workflow in the real app on a throwaway shop site; no model is called
npm run scenario -- --spend   # the same with real Claude Code and Codex turns: spends from your plans
```

The unit tests run under Electron's own Node against a real core: real SQLite,
real PTYs, the real CLI through its shim, the real hook relay. The UI sweep
serves the built interface to Chromium against a real, seeded core and checks
seeded routes in both themes at 1440×900, plus selected narrow routes in dark.
Screenshots land in `.artifacts/ui/`. The control crawl checks reachable demo
controls for errors and observable responses. Targeted dialog tests check
initial focus, Tab containment and Escape restoration in both themes. Full
keyboard traversal, control semantics and minimum-window coverage still need
manual review; the independent review records its additional 960px checks.
Its first run downloads Playwright's headless Chromium (about 200 MB, into
Playwright's own cache); later runs reuse it.

Before you open a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md).

Every feature and rule this README and the design claim, and the test that
proves it (or why it can only be checked by hand), is in
[docs/features.md](docs/features.md). The
[independent review](docs/reviews/2026-10-07/README.md) records findings, fixes,
verification results and the behavior that remains unverified.

## Not done yet

- The earlier development report records real AI review, Draft with Claude,
  Talk to Wanigan and an image attached to a reply in the 7 October 2026
  scenario (Claude Code 2.1.292, Codex 0.155.1). The independent review did not
  repeat those model turns; `npm run scenario -- --spend` runs them again.
- Codex's usage limit is read from its own rollout, where Codex records the
  failed turn; no hook or notification says so. Proven with the stand-in
  Codex, and seen from the real 0.155.1 against a stand-in model provider's
  429 (`scripts/codex-hooks-probe.ts --turns`), but not yet from a real account
  hitting a real limit: the server's reply, which carries the reset, is shaped
  from Codex's source. A Codex session without its hooks does not know its
  rollout, so there its limit, a failed turn and Esc are not seen, and it reads
  working until its next prompt.
- A Codex conversation continues only in the account it lives in. Codex
  resumes only a thread in its own CODEX_HOME (`codex resume <path>` is
  refused). A copy or link of the rollout in another account does load the
  history with no model call, but leaves one thread id in two accounts, which
  History refuses to choose between, and whether that account accepts the
  first one's encrypted reasoning is unknown without spending a turn.
- Codex's hooks reported a real turn in the scenario run (SessionStart,
  UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, Stop); OSC 9
  stays on as the fallback. Codex reports nothing until its first turn begins,
  so its composer refuses until lifecycle evidence arrives. Answer startup
  questions and send the first message in the terminal; use the composer for
  later turns.
- Replying to Codex from Needs you needs its hooks: a Codex session read only
  from its OSC 9 notifications (they say a turn ended, never that one began)
  is answered in its terminal, and says so. With its hooks, the reply was
  proven with the stand-in Codex, and Codex 0.155.1 was seen firing its
  start-of-turn hook for a pasted message against a stand-in model provider;
  a reply to a real Codex model turn from Needs you has not been run.
- Gemini CLI: proven with the installed 0.46 up to its first hook (folder trust
  answered, the hook through the relay, its conversation id learnt); a real
  model turn needs a Gemini login and has not been run. Its usage limit and
  token count were proven with the installed CLI against a fake Gemini API on
  this Mac (`scripts/gemini-fake-api-check.ts`); a real account's limit and a
  real model's usage numbers have not been seen. Its MCP servers and skills are
  listed, added and copied by Gemini's own rules, and Gemini itself, pointed at
  Wanigan's Gemini home, lists and connects to them; none has been used in a
  real turn, the store's Gemini commands are Wanigan's translations (not
  checked against each publisher), and the MCP view has no connection check
  for Gemini. Wanigan's own live view server is handed to it too.
- Grok Build: not yet an agent. Its installer was not run (it verifies nothing
  it downloads); what its binary says is in the research note, and its hook
  events are translated and tested, waiting for it to be installed and seen
  running.
- Codex asks you to approve each `wanigan` command its agent runs: its sandbox
  does not let it reach Wanigan's socket, and widening that sandbox is your
  call, not something Wanigan does for you.
- Remote Control and Codex's token counts follow what the CLIs' binaries show;
  neither was run against a real model.
- Live view: proven by hand on the owner's own local Drupal and WordPress
  sites and, in the real app driven by a script, on the two demo sites (moves,
  taking out with Undo, the component library and its pictures, part identity,
  a helper set up by another Wanigan); not by the UI sweeps, which have no view
  to lay over a page and fake the helper's answers with made-up data (they show
  its not-running and certificate states with a stand-in ddev). Telling a
  site that is not running from a certificate problem, and Start it, are
  tested against ddev 1.25's JSON and a stand-in ddev; a real `ddev start` from
  the app has not been run, and ddev's wording when Docker is not running was
  read from its binary, not seen. Not built yet: Serve this card (switching which checkout ddev
  serves), a component's props form, the design layer making words typed on a
  WordPress page real (the window still sends them to a save only the Drupal
  helper answers), and Canvas pieces by their own ids. The WordPress helper's
  newer edits (formatted and nested words, one block written alone, bound
  words, synced patterns and their overrides, template words, navigation
  labels, widgets without REST instances, media alt) are tested under a
  stand-in WordPress only: none has been saved on a real site yet, nor an
  edited block opened in the block editor to see it called valid. The Drupal helper's Layout Builder moves, and
  reordering a field with several items, have not been run against a real
  site. Retyped words saved on WordPress (a title, a menu link's text) are
  tested with stand-in pages, traces and a stand-in site, not yet seen against
  a running WordPress. On Drupal, words saved inside formatted text, to
  configuration (block titles, the site's name and slogan, a view's words, a
  field's label), to a menu link and through a Layout Builder layout are
  tested with a stand-in Drupal, not yet seen against a running one (nor what
  CKEditor 5 does to a stored text the next time it opens it). Agents' looks at it
  (`wanigan mcp`): tested with a real core and a stand-in app; each CLI seen
  connecting and listing the tools, as above, not yet seen calling one in a
  real turn.
- Local and Live: finding environments, keeping them, the lining-up and
  difference maths and the viewer (with two pictures the UI sweep draws) are
  tested. Opening a real hosted site in its tab and taking both pictures in the
  app's hidden windows have not been seen end to end yet.
- On your phone: proven in a phone-sized browser against the real phone
  gateway, with a stand-in Tailscale. A real phone through a real Tailscale
  address, and a notification arriving on one, have not been seen yet: a Mac
  cannot open its own Tailscale Serve address, so that needs a second device.

## Screenshots for posts

`node scripts/showcase.mjs --app "release/mac-arm64/Wanigan 2.app"` takes them
from the packaged app in the calm demo, on the real GPU, in both themes, into
`.artifacts/showcase/`. It refuses any shot where Wanigan is in his needs-you
amber.

## License

MIT, like the first Wanigan. See [LICENSE](LICENSE). The water's light map is
Poly Haven's Studio Small 04 (CC0); see
[src/renderer/src/orb/assets/README.md](src/renderer/src/orb/assets/README.md).

Wanigan 2 is in beta for macOS on Apple silicon. Secrets are scanned with
gitleaks (`gitleaks git . --log-opts=--all`); the fake keys in tests are listed in
`.gitleaksignore`.
