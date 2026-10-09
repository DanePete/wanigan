# How the Drupal helper hooks Drupal core (11.4)

The live view's Drupal helper (`wanigan_live`, written by
`src/core/live-helper-drupal*.ts`) traces what made every part of a page,
offers each part's edit through Drupal's own forms, moves and inserts in the
collections Drupal itself can reorder, and answers the Go to launcher. The
owner's rule: everything through Drupal core's own hooks and APIs. No
contributed or custom module is named or special-cased; a module that renders
through core's render pipeline, theme system, single-directory components,
entity, field and form APIs and config entities shows up, and is editable,
because it goes through them.

This note is the map: every interception point, the core code path it hooks
(file and function, read in Drupal 11.4.7), what it costs in ordering and
caching, and how each edge case is handled or reported. Contracts:
`src/shared/live-trace.ts` (the trace, edits, collections, the routes) and
`src/shared/live-find.ts` (Go to).

## Only a token request, and only then

Every interception point first reads `Recorder::$on`, which is `NULL` for
every request but one: a main `GET` for an HTML page (no `_wrapper_format`
other than `html`, not XHR) carrying `X-Wanigan-Live` equal to the token in
Drupal's state, that is not one of the helper's own routes (except a piece
alone). `TraceSubscriber::start()` sets it at `KernelEvents::REQUEST` priority
1000; `::finish()` clears it at `KernelEvents::RESPONSE` priority -10050,
after every core response subscriber (BigPipe's last is -10000); `::terminate()`
clears it again in case a response never reached it.

For every other request each overridden method calls the core method it
overrides and returns its result untouched. Five core services run as
subclasses of their own classes; the output of a request without the token
is byte for byte what core produces. `WaniganLiveServiceProvider::alter()`
swaps a class only when the service still has core's class and every method
the subclass extends has exactly the signature it was written against
(reflection: parameter types, by-reference flags, return type). When a later
core changes one, that service keeps core's class: the trace loses that piece,
and the site never loads a class that no longer fits.

## Interception points

| What | Core code it hooks (11.4) | How |
|---|---|---|
| Every template's output becomes a part | `TwigThemeEngine::renderTemplate()` (core/lib/Drupal/Core/Template/TwigThemeEngine.php; a service since 11.3, `ThemeManager::getThemeEngine()`) | `TraceThemeEngine` subclass: the one place a template's final variables, its file and its output meet. Wraps non-empty output in `<!-- wl:part id="pN" -->` … `<!-- /wl:part id="pN" -->`, outside core's own Twig debug comments, so those stay as they are. The document (`html`) is not a part. |
| What shaped a template, in order | `ThemeManager::render()` (core/lib/Drupal/Core/Theme/ThemeManager.php) reads every definition from `Registry::getRuntime()` | `TraceRegistry` returns `TracedRuntime` around core's runtime registry for a traced request. Its copies of each definition replace `initial preprocess` (which `render()` calls first) with a closure that opens the template's frame and then runs the original, and replace `preprocess functions` with closures that run each entry exactly as `render()` would (through the `preprocess invokes` map: `ModuleHandler::invoke()` for modules, `ThemeManager::invoke()` for themes, `call_user_func_array()` otherwise), timing each and diffing the variables before and after. Core calls the global preprocess callbacks just before the first entry that is not a `template_` function, or after the loop when there is none; the wrapped list folds them in at that same place, and `getGlobalPreprocess()` answers none, so nothing runs twice or out of order. Core's runtime registry, which is cached, never holds a closure. |
| Suggestions and suggestion alters | `ThemeManager::buildThemeHookSuggestions()`: `hook_theme_suggestions_HOOK` (invokeAll), then `hook_theme_suggestions_alter` and `_HOOK_alter` (modules), then themes | Recorded by the module handler and theme manager (below) into the current Fiber's pending list, which the next template frame takes as its first chain steps: suggestions are built immediately before that template's initial preprocess, in the same Fiber. An alter's `changed` lists the suggestions it added. |
| Every hook implementation, timed | `ModuleHandler::invokeAllWith()`, `::invoke()`, `::alter()` (core/lib/Drupal/Core/Extension/ModuleHandler.php) | `TraceModuleHandler`. Which implementations run and in what order stays core's: OOP `#[Hook]` and procedural alike come from `getHookImplementationList()`, alters from `getCombinedListeners()` with its ordering rules. `invokeAllWith()` times the callback core hands each implementation to (nearly every caller calls the implementation there once; a caller that only lists implementors, as `Registry::collectModulePreprocess()` does, shows as a turn of almost no time). `alter()` builds core's own listener list fresh and calls each in turn, so each is timed; the module of each listener is matched from the per-hook implementation lists. Wrapping the listeners themselves was rejected: a closure cannot mirror a listener's by-reference parameters, and `getCombinedListeners()` keys listeners by name. |
| Themes' hook implementations | `ThemeManager::invokeAllWith()`, `::invoke()`, `::alterForTheme()`, with `getImplementationsForTheme()` and `getThemeChain()` | `TraceThemeManager`, the same way: core's chain (base themes first) and order. |
| Cost, cache metadata, assets per element | `Renderer::doRender()` (core/lib/Drupal/Core/Render/Renderer.php) | `TraceRenderer` opens a frame per element. After core renders it, the element carries its bubbled `#cache` and `#attached` (`RenderContext::update()`), which is what each part reports. An entity shown by an entity type with no theme hook of its own (`EntityViewBuilder::getBuildDefaults()` sets `#theme` only when the registry has one) becomes a part here. |
| Render cache | `Renderer::doRender()` reads `RenderCache::get()` for keyed elements and writes after rendering | A traced render reads and writes no render cache: a hit would skip everything that made the part (preprocess, template), and a write would store this request's marks for others. The keys are taken off after asking the render cache whether a normal request would be served this element (`hit` or `miss`), with `required_cache_contexts` merged as core merges them. |
| Fibers | `Renderer::executeInRenderContext()` runs each isolated render in a new Fiber; `::replacePlaceholders()` renders placeholders in Fibers that may suspend and interleave | Frames are kept per Fiber (a `WeakMap`). `executeInRenderContext()` hands the new Fiber the frame it started from; `doRenderPlaceholder()` hands a placeholder's Fiber the frame it was cut out of (by its lazy builder). |
| Placeholders and BigPipe | `ChainedPlaceholderStrategy` asks strategies by priority; BigPipe streams its placeholders after the response is sent | `TracePlaceholderStrategy`, tagged above every strategy, keeps every placeholder of a traced request (as the single-flush strategy would), so `HtmlResponseAttachmentsProcessor::renderPlaceholders()` renders them into the page before it leaves, and nothing streams after the trace is stored. Other requests: it keeps none. Parts rendered from a placeholder say `status: 'placeholder'`. |
| Single-directory components | Component templates, found as `ComponentNodeVisitor` finds them (template name is a component id `plugin.manager.sdc` knows) | A Twig extension (`TraceTwigExtension`, tagged `twig.extension` like core's `ComponentsTwigExtension`) whose node visitor runs after core's (priority 260 > 250) and adds an open call at `display_start` and a close call at `display_end` of every component template. They print nothing unless traced. This covers a component from a render element (`ComponentElement` embeds it in an inline template) and from Twig code (`include`, `embed`) alike. Twig keys compiled templates by its extension set, so they are compiled afresh when the helper comes or goes. |
| Queries | `StatementBase::dispatchStatementExecutionStartEvent()` / `EndEvent` (core/lib/Drupal/Core/Database/Statement/StatementBase.php), only when enabled on the connection | `Connection::enableEvents()` for the traced request's connection only (the way `Database::startLog()` does), switched off again at the end; a subscriber to `StatementExecutionEndEvent` keeps the SQL (never its arguments), time, `caller` (core's `findCallerFromDebugBacktrace()`), and the frame open when it ran. A part's count includes everything that ran inside it. |
| Log entries | `LoggerChannelFactory` adds every service tagged `logger` to every channel | `TraceLogger`, as dblog is. |
| Assets | `library.dependency_resolver`, `library.discovery` | Every library the page's parts attached, with dependencies, as files with sizes; per part, the libraries it attached itself (its bubbled set less its children's). |
| Field items and menu links as parts | `FieldPreprocess::preprocessField()` puts formatter element N in `items[N]['content']`; `MenuLinkTree::buildItems()` gives each link a `title` | The helper's own last preprocess step (after every module's and theme's) adds the marks as each item's `#prefix`/`#suffix` (filtered as `Renderer::doRender()` filters them; a `#lazy_builder` element, which may carry no other property, is wrapped instead), and around each link's title. |
| Layout Builder | `LayoutBuilderEntityViewDisplay::buildMultiple()` puts the sections in `_layout_builder`, each keyed by delta, regions by name, components by uuid (`Section::toRenderArray()`) | The last preprocess step of the entity's template tells each component where it sits, so its block part knows its delta, region and uuid. |

## The trace's parts

Parent links are read from the final page, not guessed from the render: the
marks are scanned in order with a stack, so a placeholder rendered last sits
where the page shows it. A part rendered but not in the page (rendered to a
string and discarded, or printed into an attribute) is left out.

Kind and label come only from what core puts in render arrays and template
variables: an entity (`#<type>` and `#view_mode`, labelled "Bundle: label"),
a field (`#field_name`, `#object`; its label), a block (`#plugin_id`,
`#configuration`, `#block`), a region (`#region`, its name from the theme's
info), a view (`view`), a menu (`menu_name`), a form (`#form_id`), a component
(its `.component.yml` name); anything else is a template named by its theme
hook, as Twig debug names it.

Variables are those the template received (not the theme system's own
`theme_hook_*`), each with its type and a preview of at most 400 characters:
render arrays are summarised, never rendered; an entity is its type, id and
label; anything whose name is key-, token-, password-, secret-, hash-, salt-,
nonce-, session- or cookie-like, a form token or build id, a long run of
token characters, or a password hash, is `[redacted]`. `setBy` is the last
step whose diff changed it.

Alternatives are the suggestions core offered, most specific first as Twig
debug lists them, each saying whether a template exists for it in the active
theme's registry (core registers a suggestion only when a template exists)
and which was chosen.

## Editing through core

| Target | Id | How it saves |
|---|---|---|
| A field of a content entity | `field.<type>.<field>.<langcode>.<id>` | `FieldForm`, a `ContentEntityForm` whose `init()` collects the form display for its operation as core does (`EntityFormDisplay::collectRenderDisplay()`, with its alter hooks) and keeps a copy holding only that field's component, or the field type's default widget when the display has none. Validation is core's: the whole entity is validated and the violations of that field and of the entity as a whole are kept (`getEditedFieldNames()`). It saves a new revision by the logged-in user when the type keeps them, and lands on `/_wanigan/edit/done?target=…`. The entity edited is the active variant (`EntityRepository::getActive()`, as an edit route with `load_latest_revision`), so a newer draft is never overwritten; the form says so when that is not the version visitors see. Its form id is its own and names no base form, so alters aimed at an entity type's full form do not add their extras here. AJAX widgets work: the form is cached and rebuilt by core like any other. |
| A block placement | `config.block.<id>` | The block config entity's own form, in the live view's small page; any submit lands on the done page. |
| Another config entity (a view, a menu) | `config.<type>.<id>` | Its `edit-form` page, with `destination` set, which core honours on every redirect (`RedirectResponseSubscriber`), so saving returns to the done page. |
| A menu link | `link.<plugin id>` | A content menu link's entity form in the small page; any other link through its plugin's `getEditRoute()`. |
| Layout Builder | `layout.<type>.<view mode>.<langcode>.<id>` | Layout Builder's own page for the entity (its override when the default allows one), with `destination`. |
| A template copy | `tpl.<hash>` (`via: 'schema'`) | On the owner's word only: the chosen template (or a more specific suggestion of it) copied into the active theme's `templates` folder, refused when a file of that name exists anywhere in the theme (and the answer names it), when the active theme is core's or contributed, or without `administer themes`. The theme registry is reset and `rendered` invalidated, so the view reloads with the copy in use. |
| A component's props | `props.<hash>` (`via: 'schema'`) | Never saved here: the target carries the component's resolved prop schema and its values, and `why` says where they are written (the field that stores them, or the Twig code to override). |

A target carries `why` when it cannot be changed here: the logged-in user may
not (entity `update` and field `edit` access), the field is computed or read
only, no widget edits its type, the content belongs to other content (an
access dependency, `RefinableDependentAccessInterface`, as Layout Builder's
inline blocks have) or is shown through a reference that pins one revision of
it (a field whose items have a `target_revision_id` property), whose own new
revision the page would not show.

## Collections, moves, inserts, undo

Each move first checks the collection is still as the trace saw it (the full
order, including items the page does not show) and answers 409 with the
current order otherwise. Items not shown keep their places: an item moved to
index N among the shown items goes before the shown item now at N.

| Collection | What a move saves |
|---|---|
| A multi-value field's items (`field-items`) | The entity API: the field's values in the new order, the entity validated, a new revision by the logged-in user where the type keeps them. Identity of an item survives a reorder: what it refers to (`target_id`), else its values. Refused when the page shows a different number of items than the field holds (a formatter that groups or limits them). |
| A theme region's blocks (`region-blocks`) | Block config entities' region and weight, ordered as `BlockRepository` orders them (`Block::sort()`: weight, then label). Only the moved block is re-saved when a weight between its neighbours sorts it there; otherwise all are numbered from 0. Every theme region is a collection, so a block can move into an empty one. |
| A menu level (`menu`) | `MenuLinkManager::updateDefinition()` (weight, parent), as `MenuForm::submitOverviewForm()` saves them; the order is core's (weight, title, id, `MenuLinkTreeManipulators::generateIndexAndSort()`), read through `menu.link_tree`. Moves between levels of one menu. |
| An entity's fields (`display`) | The view display's component weights (the same set of weights, reassigned). `reach` is the number of items of that bundle when the display is the full view. Refused when the display is not saved, when Layout Builder arranges it, or when its template prints those fields one by one (read from the template), since weights would not move them. |
| Layout Builder regions (`layout`) | Its Section API as `MoveBlockController::build()` moves a block (out of its section, into the region after the component before it, or first), then saved as its form saves (`SectionStorageInterface::save()`; a revision for an override), and refused while its tempstore holds unsaved changes. Overrides say they change one item (`changes: 'content'`), defaults that they change every item without its own (`'configuration'`). |

Inserts: a block from the block library's own list
(`BlockManager::getFilteredDefinitions('block_ui', …)`, leaving out blocks that
need a context chosen first), placed as `BlockForm` places one (the plugin's
configuration, a machine name from `BlockRepository::getUniqueMachineName()`);
a new item for a field whose own type makes a sample value
(`FieldItemInterface::generateSampleValue()`), never a reference, which would
create content of another kind. Components are offered nowhere: core has no
collection that accepts one as data.

Undo tokens are kept 10 minutes per user, and put things back only while they
are exactly as the move left them.

What a move changes beyond the order, as core's own forms would: re-saving a
block config entity normalises its plugin settings (keys a newer plugin
version added, booleans for 1s), so an export shows them; a menu link's save
stamps its changed time. A move re-saves as few items as its new order needs.

## Go to

`GET /_wanigan/find` lists, for the logged-in user: the `admin` menu tree as
the toolbar loads it (`menu.link_tree` with the `checkAccess` and
`generateIndexAndSort` manipulators), each page with its local tasks
(`LocalTaskManager::getLocalTasksForRoute()`, each task's URL access-checked);
every bundle of every content entity type with its edit form and the tasks
under it (fields, displays, layout, permissions); every view's edit form and
each page display at its path; the front page; the 30 most recently changed
nodes. Its `cacheId` is a hash of the user, their permissions hash, the
language and the checksum of the cache tags that change any of it (the admin
menu, `local_task`, `routes`, the site's config, the views and blocks lists,
every bundle list, the searched entity lists).

`GET /_wanigan/find?q=&limit=` (at most 50) searches the label of content,
terms, users and media, and of any other content entity type with its own
page, edit form and a stored label (shown as content), with access-checked
entity queries (node grants included), newest first across kinds; only the
items shown get their local tasks and entity operations
(`EntityListBuilder::getOperations()`). `total` counts every match.

## Edge cases

- **A render cache hit would skip preprocess.** Traced renders never read or
  write the render cache (above), and report what a normal request would get.
  With the helper's development settings the render cache bins are off anyway,
  so this reads `miss`.
- **Placeholders and BigPipe** render into the page for a traced request
  (above). Status says `placeholder`. Normal requests stream as before.
- **`#lazy_builder` elements** may carry no other property (core asserts it):
  field items built lazily are wrapped instead of given a prefix; Layout
  Builder components built lazily are not told where they sit.
- **AJAX, other wrapper formats, POSTs and the helper's own routes** are not
  traced; the marks of version 1 (`data-wl-*`) still apply to every token
  request.
- **Theme wrappers** (`#theme_wrappers`: region, container, form) are parts of
  their own, nested by the page; the element's own template speaks for its
  cost and cache, else its outermost wrapper.
- **Nested components** nest by their marks; a component rendered from a
  render element inside a field is edited through that field.
- **Empty output** is not a part (no marks), so a template checking
  `content|render|trim` sees what it always saw. Empty fields are not rendered
  by core at all; an entity part offers their edit targets instead.
- **Access-denied parts** are not rendered by core (`#access`), so they are not
  in the trace.
- **A part printed into an attribute or into script, style, textarea or
  title** has its marks removed before the page leaves (the marks' quotes
  would end an attribute early); it is then not in the trace.
- **Several root elements, or none**: marks are comments, so a part is found
  either way.
- **Translations**: targets name the langcode of the translation shown; the
  form edits that translation.
- **Revisions**: the edit form edits the latest revision affecting the
  language, never an older draft; a page showing a pinned revision through a
  reference says to edit it through that reference.
- **Exceptions mid-render** leave frames open; the next template that finishes
  closes any left above it, so a trace stays consistent.
- **Request-wide lists are bounded** (`TRACE_LIMITS`) and say so in
  `truncated`; a part's chain is bounded at 200 steps (`chain:<id>`).
- **Backtraces a site prints** (verbose error display) name the helper's
  subclasses among their frames, for every request, and Twig's compiled class
  names change with its extension set; nothing else a request without the
  token returns changes.
- **Fibers that suspend** while rendering placeholders can make a part's
  wall-clock time include another's; query counts are attributed by frame,
  so they stay right.

## What core does not offer, so neither does the helper

- Editing a component's props as data where Twig code writes them: they are
  code. The target says so and offers the template copy.
- Placing a single-directory component in a region or a field: core has no
  collection that stores one.
- Inserting a new referenced item (a new piece of content of another kind)
  into a reference field.
- Render-cache-hit tracing: a hit has no preprocess or template to trace.
- Theme hooks without a theme engine service (before 11.3): no parts.

## Verified

On a real Drupal 11.4.7 site (ddev, the owner's own; nothing of it is written
here): every swap in place; pages traced anonymously and as an administrator
(116 to 473 parts, every part parsed by `parseTrace`); a field saved through
its narrowed form as a new revision, then put back exactly; a block's and a
menu link's own forms and a menu's edit page reached; a template copied into
the active theme and used at once, a second copy refused with its path, then
deleted; a block moved in its region and a menu link moved within its level,
each with a stale second move refused with the current order, each undone and
compared with a backup; Go to's index and search. Pages fetched without the
token, anonymously and as an administrator, were compared with the same pages
under the previous helper: the same bytes once the values that change on every
render are set aside (the asset query string a cache rebuild renews, `uniqid()`
ids, form build ids and tokens, a time-based cookie lifetime). The one other
difference is where a site prints PHP warnings with their backtraces into its
own pages (verbose error display on a development site): those backtraces list
the helper's subclasses among their frames, and Twig's compiled class names,
which Twig derives from its extension set.

Not verified on a real site: Layout Builder collections, moves and their undo
(the site has no Layout Builder), and a reorder of a multi-value field with
more than one item (none is shown on the site's pages; a one-item move and
its undo, and every refusal, were exercised).
