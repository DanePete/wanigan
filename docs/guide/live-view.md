# Live view

The live view in depth: your local site inside Wanigan, the editor laid around it, what each part does, and what has been seen working. Back to the [README](../../README.md). The website takes it step by step: [the editor](https://wanigan.ai/docs/editor).

Your local Drupal, WordPress or other site, inside Wanigan, following the
agents as they work. Every project has a **Live** tab. The view is off until
you switch it on, from that tab or in **Settings › Live view**, where Drupal,
WordPress and other sites can each be on or off.

- **One toolbar.** The site (one menu: Local and the hosted environments to
  show the page on, Compare and Site settings; its tooltip says what the view
  follows), the page (back, forward, reload, and the address, which opens Go
  to), the tools (Select, Type on the page, Style and Move, then Snap, Record
  and Voice), then
  the lens, the widths, the layer's eye (the page without the design layer),
  Edits with its count, and **Make real**, whose menu makes the page's edits
  real, verifies them or opens Edits. A menu at its end holds drag handles,
  the default browser and a card's before and after, and **How this works**
  draws the editor as a picture. The status line under the page says what just
  happened and the mode the view is in (recording, typing, selecting, placing,
  comparing, a hosted environment read-only, the page without the layer), with
  the dock's tabs at its end. In a narrow window, or with the dock beside it,
  the bar narrows without drawing anything over anything: Edits keeps its
  count and How this works its icon.
- **Around the page.** On the left, Structure: Layers (the page's parts as a
  tree), Add (the site's component library, and what this page itself can
  take) and Pages (Go to's list of the site's pages). In the middle, the page
  as a sheet, the chosen part outlined with its name and its action bar
  (Style, Move, Take out, Ask an agent) floating above it. On the right, the
  Inspector: the chosen part's **Design** (every way to change it), **Made
  by** (its files and whose they are, the hooks that shaped it, its cache,
  cost, revisions and access) and **Data** (the fields and values it was
  rendered with); Edits (⇧E) takes its place while open. Structure and the
  Inspector each close to give the page the room. Beneath the page, a dock
  shared with the code editor: Code, Notes, Problems, Request and DevTools,
  closed by default and opened from its tabs at the end of the status line or
  ⇧[ and ⇧]. What it shows, its height, its side and whether it is open are
  kept on this Mac. Compare, a snap being marked up and a recording's review
  are drawn where the page is, and leaving them puts the page back as it was.
- **Keys for everything**, in the view and in its page while nothing is typed
  into: P picks (and stops picking), ⇧L chooses a lens, 1 2 3 the widths,
  [ and ] Structure's tabs, ⇧[ and ⇧] the dock's, ⇧C Compare, ⇧B the
  component library, ⇧S a snap, ⇧R starts or stops a recording; on a chosen
  part E types on its words on the page (or,
  for a part that is more than words, opens Edit ▾), M moves, . opens its
  code, ⇧A shows it alone, ⇧X takes it out, ⇧D shows it in DevTools; ⌘↩ adds
  a note, ⇧⌘↩ sends it (or the notes waiting). All are on the shortcut sheet (?).
- **The page's own DevTools**, in the dock: Chromium's DevTools for the page
  (Elements with its own picker, Console, Network, Sources, Application,
  Performance) in a DevTools tab beneath or beside the page, following the dock
  as you resize or move it. **DevTools** among the dock's tabs, or Chrome's own key (⌥⌘I
  on macOS, Ctrl+Shift+I on Windows and Linux, also from the page and from
  DevTools itself), opens or closes it. **Show in DevTools** on a chosen part,
  on a row of the Layers tree, or ⇧D, scrolls the page to the element when it
  is off screen and selects it in Elements. **Open in its own window** puts it
  on a second screen. Hiding the tab keeps DevTools as it was; leaving the
  project closes it. It is the page's own DevTools, with none of Wanigan's
  privileges. The tab says what of the page is Wanigan's: its page script and
  outlines, and the helper's `wl:` comments and `data-wl-*` attributes, are in
  the page's HTML while the live view is on, and the Network panel shows the
  helper's `X-Wanigan-Live` key on the page's own loads. Wanigan's own
  window's DevTools moved to ⌥⇧⌘I (Ctrl+Alt+Shift+I). Checked in the window
  against a stand-in, and Electron's hosting (DevTools in a view, a point
  selected in Elements, its own window and back) in a throwaway window on
  made-up pages; not yet seen in the app on a site.
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
  part is, and offers the same verbs in the Inspector's Design tab: **Edit ▾**
  (every way to change it, by where the change is saved: in the site, on the
  page, in code), **Move**, **Code**, **Alone** and **Take out**; the note to
  an agent (Tell an agent) is right under them. Why it looks as it does (whose
  code it is, how to override someone else's template in your theme, its
  cache and cost) is the Made by tab, and its data the Data tab.
- **Notes for an agent.** Point at parts across pages, say what should change,
  and send them to a session as one message with a picture of each part. They
  wait in the dock's Notes tab. With no agent running, the composer offers to
  start one (the agent New session would start) with them as its first
  message.
- **Snap** (the camera in the bar, or ⇧S). A picture of the page as the view
  shows it, drawn where the page is: drag over the part that is wrong, or take
  the whole view (W) or the whole page (F, loaded again at the same width in
  a hidden window). Mark it up with a box, an arrow, a highlight, a short
  label and a blur for anything private (B A H T U, each undone with ⌘Z or
  Ctrl+Z); the blur replaces the pixels before the picture is kept or sent.
  **Ask an agent** opens the note composer with the marked-up picture
  attached and the context written out for you to read and change: the
  page's address and the view's width, the parts the area covers and what
  made them (template and file, block or component, module or plugin, from
  the site's trace), and the console's errors. Choose the session and send
  it, or **Save to Notes** to send later. Nothing leaves Wanigan until you do.
- **Record** (in the bar, or ⇧R). A recording of the live view and nothing
  else, from the view's own frames (no screen recording, so no permission is
  asked, on macOS or Windows), at most two minutes. While it runs the bar
  says **Stop** with the time and the status line says it is recording;
  Escape or ⇧R stops it, and so does leaving the live view. Meanwhile a step
  log is kept: each click with the element and the part under it, keys and
  what was typed (never in a password field: only that keys were pressed
  there), scrolls, pages, console errors, and requests that failed or were
  slow (status, path and time; never a body, a header, a cookie or a query).
  Stopped, you see the clip (a WebM video, which Wanigan, Chrome, Edge,
  Firefox and Safari play; QuickTime Player does not), up to eight key frames
  (each click, page and error) and the log. **Ask an agent** sends the key
  frames as pictures and the log as words with your explanation; agents never
  get the video, and the composer says so. Recordings are kept in Wanigan's
  own data, under `live-recordings/` (never in the site), with the same
  limits as attachments; a project keeps its last five, and the review has
  Show in Finder (File Explorer on Windows) and Delete.
- **The design layer** (Edit ▾ › On the page, and Edits, ⇧E). You edit on
  the page itself, as in a site builder. Retype the words (E, or a
  double-click on the chosen part's words) makes those words editable where
  they are: each key shows on the page as you type it, Enter or clicking away
  keeps them, Esc puts back exactly what was there, and the status line says
  you are typing, with Keep and Put back. Retype in a box does the same from
  the Inspector, for the keyboard and screen readers. Try a style shows each
  value on the page as you move its control (over an edit the layer already
  shows there too), and Show it on the page keeps it. What you keep is kept by
  Wanigan, not written into the site: the page goes on showing it through the
  layer. A style is for one element or every instance of its kind (how many,
  said before you choose it, and shown on every one as you try it); a custom
  property can change for the whole site. Edits lists every edit by page, with
  before → after, what it reaches (including "this item, shown twice on this
  page"), its state and what that means, and why when it no longer finds its
  element. Make it real saves words through the site itself to the one thing
  that holds exactly those words. On Drupal: a text field (a plain one, or one
  run of words inside formatted text, spliced in with its markup kept and
  saved only when the field's own text format shows nothing else changed), a
  field's label, a block's title, the site's name and slogan, the words of a
  view's header, footer or empty text, a menu link's text, or the words of a
  Layout Builder inline block, through its layout (a default layout that every
  page of a kind shares is saved only when you make it real again, after it
  says how many pages that reaches), or the words of a paragraph, through the
  page that holds it (Paragraphs keeps each page's paragraphs as versions of
  that page, so the page is saved as a new version with its workflow, log and
  checks; a newer draft, an open Layout Paragraphs builder or a paragraph not
  translated into the page's language is refused, and a Paragraphs Library
  item says how many pages use it first); and, where Webform is installed, a
  form's own words through Webform's own API: an element's title, description,
  help, placeholder, prefix, suffix or option labels, its buttons and its
  confirmation message, in the form's language or its translation. A button
  showing the site's default gets words of its own on that form only; the
  default for every form, and options several forms share, say how many forms
  they reach and save only when you confirm. Configuration says the next config
  import puts back what is exported. A save that gives a page a new address (a
  new title, with Pathauto) takes the view there. On WordPress a title, an
  excerpt, a string meta, the site's title or tagline, a menu link's text, or a
  block's words (a paragraph, a heading, a navigation label), each through
  core's REST API with a revision where WordPress keeps one, and a category's or
  tag's name where a menu or an archive heading shows it, through core's own
  term save (it says first that the name changes everywhere the term shows). A block's words are sent as the HTML
  they are kept as: typed words escaped, so a typed `<` stays a character, and
  words between a link's or bold's tags changed only where the change falls
  inside one run of them, every tag kept. Words kept in something shown beyond
  the page (a template or part, a synced pattern, a menu, a widget, a setting)
  say where they show first, and are saved when you make them real again.
  When nothing the page offers holds the words (a page builder's, a
  shortcode's, a contributed field's), Wanigan looks where the content keeps
  them and saves them there through core: on WordPress the post's stored
  content (its markup, a shortcode's settings and the words it wraps, a
  block's settings, changed together with the block's markup when it keeps
  them twice), its excerpt and its custom fields (JSON written back token by
  token with the escapes it was written with, a saved list as a list, a field
  with a row per value by its row); on Drupal every field of the content the
  page showed that its other saves do not cover (a contributed field's value,
  JSON in it, a map, a link's title), in that translation, as a new revision.
  The words must be found exactly once, as words; otherwise it says where they
  are (twice, only in an address or a class, made from a template like
  `%%title%%`, in the site's settings) and saves nothing. Elementor's pages are
  read from the tree Elementor renders and saved through Elementor's own save
  (its caches cleared, a revision kept); ACF's fields, repeater rows, blocks and
  options are saved through ACF with its validation (an option every page shows
  is saved only when you make it real again); copies that never render (a
  builder's stored-content copy, an SEO plugin's mirror) are never saved into,
  and Beaver Builder's and SiteOrigin's own layouts are refused, saying so.
  After the save the page reloads and is read back: if it still shows the old
  words, it says the site has them but whatever renders them may keep its own
  copy, and Undo puts the old value back (custom fields keep no revision, so
  this is their only way back, for ten minutes). Words a plugin computes and
  never stores, and a builder's own cache, are beyond it.
  What it cannot save says why, and which kind of why: the site keeps no such
  thing (words written in a template, a menu link written in code, a base
  field's label, words a Webform token or computed element makes), or Wanigan
  does not do it yet (a Drupal interface
  translation, a caption, words across formatting). Both helpers read each
  template the page loaded (Drupal's Twig, a WordPress theme's PHP files,
  never run) and list the words typed into it and the strings it prints
  through a translation function, with their file and line: words a template
  writes go to an agent, saying the file and line; on WordPress a translated
  string goes too, with its text domain (a translation file changes it without
  code), and a parent theme's template, when a child theme is active, is to be
  copied into the child theme and changed there, since a theme update would
  overwrite it. What a template's PHP works out is never guessed at: words in
  no template are said to be made by its code, by a plugin or the theme's own
  code (named), or in a template the helper did not read. Only an element outside everything the
  page's trace knows is called unknown. A WordPress change across formatting
  and words in a classic post's content go to an agent too, as does a style:
  never written into the stylesheets by hand. Where neither helper can say
  what writes words nothing stores, you can look in the template that rendered
  the element itself, picked on the page: Wanigan says first that every page
  using that template changes, and writes it only when the words are there
  exactly once (Put back waits while the layer holds the edit as in the site).
  Then Verify renders the page with and without the layer and says what
  differs, with pictures. Undo, redo, discard, and the page shown without the
  layer to compare; nothing runs twice, and undo waits while words are being
  saved. The window has been checked against the UI sweep's stand-in; on the
  Northstar demo, a script driving the real app made words in a plain field
  real and verified them. Typing on the page and a style shown as it changes
  have been checked in headless Chromium on made-up pages and in the window
  against the stand-in, not yet in the app on a site. Drupal's formatted text,
  configuration, Layout Builder and paragraph saves, and WordPress, have been
  tested with stand-ins only, as have the stored-words search and save
  (Elementor and ACF with stand-ins made in the shape of their public code;
  ACF PRO's repeaters, blocks and options follow ACF's documented storage and
  are not yet checked against ACF PRO itself).
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
  [docs/research/2026-10-09-drupal-core-live-trace.md](../research/2026-10-09-drupal-core-live-trace.md).
  The WordPress helper traces each render through WordPress core's hooks the
  same way, and saves a part's change through core's REST API as you, where
  core keeps it: a post's fields and meta; a block's words with their
  formatting, or beside its nested blocks, written as that one block (cleaned
  as core cleans bound rich text); words bound to a post field, in that field;
  a synced pattern's words for every page that uses it, or one placement's own;
  a template's or template part's words (the first save copies the theme's
  file into the database, as the Site Editor does); a navigation menu's labels;
  a classic widget's settings; an image's alt in the media library, beside an image
  block's own. Each says where it shows, and the edit sheet says it again and
  asks before saving anything shown beyond this page (a template or part, a
  synced pattern's own words, a menu, a widget, a setting, a library alt).
  Formatted text is edited as its words when it holds no tag (sent escaped, so
  a typed `<b>` is words, never markup) and as its HTML when it holds inline
  tags, saying which tags WordPress keeps. What WordPress keeps nowhere it can
  write (a static block's settings, words from a theme's pattern file, a
  fallback menu's links) says so, and so does what Wanigan does not do yet.
  How it hooks core:
  [docs/research/2026-10-09-wordpress-core-live-trace.md](../research/2026-10-09-wordpress-core-live-trace.md).
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
  it marked as changed. Drawn where the page is, with the panels and the
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

## What each agent gets, and what has been seen working

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
