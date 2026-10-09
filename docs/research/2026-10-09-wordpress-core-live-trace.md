# WordPress core and the live view's trace

How Wanigan's WordPress helper (`src/core/live-helper-wordpress.ts`, written into
a site as `wp-content/mu-plugins/wanigan-live.php`) learns what made every part
of a page and changes it, through WordPress core's own hooks and APIs only. Read
line by line against WordPress 7.1's source on 9 October 2026; each section names
the core file and function an interception point depends on, and what differs in
6.x. The contract it serves is `src/shared/live-trace.ts` (trace, edits,
collections) and `src/shared/live-find.ts` (Go to).

The rule throughout: no plugin or theme is named or special-cased. A page
builder, block library, custom post type or registered meta shows up because it
goes through the template hierarchy, the block API, theme.json, shortcodes,
widgets, menus, options and the REST API, which is what is hooked.

## When the helper acts at all

| Request | What runs |
|---|---|
| No `X-Wanigan-Live` header, or a wrong one | Only the change counter (`save_post`, `updated_option` and the rest), as in version 1. No output, header, query log or error handler changes; the unit test loads the plugin under a stand-in WordPress and checks the hooks it adds. Measured byte-for-byte on four pages of a test site, with and without the plugin. |
| Token, `index.php` page render | The trace. Decided in two steps: at must-use plugin load (`wp-settings.php` loads mu-plugins after the database and object cache, before plugins, `vars.php`, the theme or any block), from `SCRIPT_FILENAME` and the path; then at `wp` (`class-wp.php WP::main()`, after the query is parsed), which drops admin, AJAX, cron, REST, XML-RPC, feeds, robots, favicon and trackbacks. |
| Token, `/_wanigan/trace|edit|move|insert|undo|find` | Only the route, at `wp_loaded` (post types, meta, blocks and settings registered, the user known). Never traced. |
| Token, wp-admin, admin-ajax, REST, cron | Not traced. Version 1's `data-wl-block` attribute still rides on block renders, as before. |

A page cache that serves a stored page before WordPress loads
(`advanced-cache.php`) answers without the helper: no `X-Wanigan-Trace` header,
so the view knows there is no trace. A traced page defines `DONOTCACHEPAGE` and
sends `nocache_headers()`, so no cache keeps a page with marks in it for anyone
else.

## Hooks: timing every callback without changing behaviour

**Core path.** `plugin.php apply_filters()` / `do_action()` count the firing
(`$wp_filters`, `$wp_actions`), push the hook onto `$wp_current_filter`, call
`_wp_call_all_hook()` (the `all` hook) with `($hook_name, ...$args)` — or
`($hook_name, $args)` for the `*_ref_array` variants — and only then check
whether the hook has callbacks. `class-wp-hook.php WP_Hook::apply_filters()`
walks `$this->priorities` with a per-nesting-level iteration, and at each
priority `foreach`es over `$this->callbacks[$priority]`, calling
`$the_['function']` with the arguments sliced to `accepted_args`.
`has_filter()` and `remove_filter()` look callbacks up by the key
`_wp_filter_build_unique_id()` builds (the function name, `Class::method`, or
`spl_object_id()` since 7.1, `spl_object_hash()` before); they never compare
the callable stored under it.

**Interception.** One `all` callback counts every firing, tells actions from
filters by whether `$wp_actions[$hook]` moved, and lists each hook's callbacks
the first time it fires (the request-wide list: hook, priority, callback,
file:line by Reflection, whose code). For the filters that shape a part's
output (the `CHAIN` list in the plugin: `the_content`, `render_block`,
`render_block_{name}`, `do_shortcode_tag`, widget and menu filters, the
template hierarchy and others) it then swaps each callback's `'function'` for a
wrapper **under the same key**. The wrapper receives exactly what WP_Hook
passes, calls the original, records milliseconds and whether the value changed
(`!==`; for arrays, which keys; for parsed blocks, which `attrs.*`), and returns
the original's answer.

**Ordering consequences.**
- The swap happens in `all`, before WP_Hook starts iterating, so every callback
  present at that moment is timed. A callback added while the hook runs (as
  `do_blocks()` adds `_restore_wpautop_hook` to `the_content`) runs unwrapped;
  the next wrapped callback sees the changed value as its input, so nothing is
  misattributed, but that callback has no step.
- `remove_filter()` during the hook (as `do_blocks()` removes `wpautop`) works,
  because the key is unchanged.
- The originals go back as soon as the hook leaves `$wp_current_filter`: an
  application at depth *d* has ended when the next hook fires at depth ≤ *d*.
  Nested applications of the same hook (a block rendered inside a block, a
  `the_content` inside a `the_content`) share the wrappers; each wrapper
  records into the innermost running application of its hook, and an
  application that is not traced (an excerpt's `the_content`) records nothing.
- A wrapper adds one stack frame. Code that reads its caller with
  `debug_backtrace()` sees it; code that reads `$wp_filter[...]->callbacks`
  during the hook sees the wrapper. Both only for token requests, only while
  that hook runs. Only filters with value arguments are wrapped (no
  `*_ref_array` hooks), so by-reference arguments are never involved.
- Hooks that fire before must-use plugins load are not seen (none on a default
  single site).

## Templates

**Classic themes.** `template-loader.php` calls each `get_*_template()` in
order; `template.php get_query_template()` applies
`"{$type}_template_hierarchy"` (the candidate file names), `locate_template()`
(child theme, then parent theme, then `wp-includes/theme-compat/`), then
`locate_block_template()`, then `"{$type}_template"`. `template_include` may
replace the answer. Since 6.9, `template-loader.php` fires
`wp_before_include_template` with the realpath it is about to `include`.
- The hierarchy filters' final lists (a closer at `PHP_INT_MAX`) and each
  type's located file become the main template part's `alternatives`: every
  candidate tried, whether it exists, and which was chosen; a template that
  `template_include` substituted is added as chosen "from template_include",
  with that filter's callbacks in the chain.
- `wp_before_include_template` opens the page template part and prints its
  begin mark. Nothing fires after the include returns, so its end mark is
  printed at `shutdown` priority 0, inside core's output buffer, after
  `</html>`. A comment before `<!DOCTYPE>` or after `</html>` is a Document
  child in the HTML parser and does not change the rendering mode. Before 6.9
  there is no page template part; the template files inside it still are.
- `template.php load_template()` fires `wp_before_load_template` and
  `wp_after_load_template` (6.1+) around every template file it requires:
  `header.php`, `footer.php`, every `get_template_part()`. Each is a part,
  bracketed by marks at the latest and earliest priorities.
  `general-template.php get_header()`/`get_footer()`/`get_sidebar()` compute
  their candidates inline (`header-{name}.php`, `header.php`) and
  `get_template_part()` fires `get_template_part` with its list; both become the
  next template part's alternatives. A `require_once` template loaded twice
  prints nothing the second time; its empty pair of marks is removed.
- **Override (edit).** A file from the parent theme while a child theme is
  active, or from `theme-compat`, can be copied into the active theme at the
  same relative path, where `locate_template()` looks first: an explicit
  `template-override` target naming the destination, refused when the file
  exists, when the user lacks `edit_themes`, or when `DISALLOW_FILE_EDIT` is on.
  A template from a plugin (through `template_include` or its own loader) says
  why a copy would not be used. A theme with no parent says there is nowhere to
  copy it.

**Block themes.** `block-template.php locate_block_template()` resolves a
`wp_template` for the same hierarchy (`resolve_block_template()`, which also
prefers a child theme's PHP template over a parent's block template), sets
`$_wp_current_template_id` and `$_wp_current_template_content`, and returns
`wp-includes/template-canvas.php`. That file calls
`get_the_block_template_html()` **before** `wp_head()` (shortcodes,
`do_blocks()`, `wptexturize()`, the skip link), then prints the result between
`wp_body_open()` and `wp_footer()`.
- The `wp_template` part's frame is open from `wp_before_include_template` to
  the first `wp_head` callback (its render window, so its blocks' cost and
  parent are right); its marks are printed at the last `wp_body_open` and the
  first `wp_footer` callback (where its HTML is).
- Its source is the theme's `templates/*.html` (`_get_block_template_file()`),
  or "edited in the Site Editor" when `source` is `custom`; its history is the
  `wp_template` post's revisions; its edit is a native link to the Site Editor
  (`site-editor.php?p=/wp_template/{id}&canvas=edit`, the `_edit_link` core
  registers for the post type in `post.php`).
- Template activation exists only in the editor's JavaScript in 7.1; PHP
  resolution is unchanged.

**Template parts.** `blocks/template-part.php render_block_core_template_part()`
fires `render_block_core_template_part_post` (a Site Editor copy in the
database), `_file` (the theme's file, with its path) or `_none` (5.9+), then
runs `_wp_apply_block_content_filters()` (7.1; `do_shortcode()`,
`do_blocks()`, `wptexturize()` and friends) on the content. Those actions give
the part its source and history, and make its top-level blocks belong to the
`wp_template_part` the Site Editor would save.

## Blocks

**Core path.** `blocks.php do_blocks()` parses (`parse_blocks()`, filterable
parser class) and calls `render_block()` for each top-level block — freeform
HTML between blocks included, as blocks with a null name. `render_block()`
applies `pre_render_block` (a non-null answer replaces the whole render),
`render_block_data`, `render_block_context`, builds a `WP_Block` and calls
`render()`. `class-wp-block.php WP_Block::render()` applies
`interactivity_process_directives` first (6.6+), resolves block bindings
(`process_block_bindings()`), walks `inner_content` — for each inner block
applying `pre_render_block`, `render_block_data` and `render_block_context`
again (5.9+) and calling its `render()` — calls the `render_callback` of a
dynamic block, enqueues its assets, applies `render_block` then
`"render_block_{$name}"`, processes Interactivity directives on the root
interactive block, and dequeues assets of a block that rendered empty.

**Interception.**
- `pre_render_block` (in `all`) records a pending block: its parsed block, its
  parent `WP_Block` (null at the top), when it started, and its index among
  its siblings, counted per parent in the order `render()` walks them.
- `interactivity_process_directives` (in `all`) is the start of a render: the
  `WP_Block` is the object on that stack frame (one bounded
  `debug_backtrace(DEBUG_BACKTRACE_PROVIDE_OBJECT)`), and the part is bound to
  that instance. Before 6.6 this filter does not exist: blocks are still parts
  (created at their last filter) but without cost or parent from the stack.
- `"render_block_{$name}"` at `PHP_INT_MAX` (added to that dynamic hook name
  from `all` before it iterates) closes the part and wraps its final output.
  Output that is empty or holds no markup is not wrapped: `render()` dequeues
  the assets of a block whose output trims to empty, and plain text may be on
  its way into an attribute.
- A non-null `pre_render_block` answer becomes the part, with the callbacks
  that produced it as its chain.

**Edge cases.**
- *Nested blocks*: the parent is the instance being rendered; cost includes
  inner blocks.
- *Dynamic vs static*: `is_dynamic()` only means a `render_callback` exists;
  many blocks that save markup in the editor (heading, image, cover) also have
  one. The trace says which, and the edit rules below do not trust it alone.
- *Blocks rendered outside `render_block()`*: `post-template.php`,
  `comment-template.php` and `term-template.php` render a `core/null` copy per
  item with `(new WP_Block(...))->render(['dynamic' => false])`; navigation
  blocks render their inner blocks directly. The copies are not parts; their
  inner blocks are, under the nearest real part.
- *Synced patterns*: `blocks/block.php render_block_core_block()` replaces the
  instance's inner blocks with the `wp_block` post's content and calls
  `render()` on the **same instance** again. The second render belongs to the
  first; one part, labelled with the pattern's title, its revisions, and a
  native link to the pattern (changes every page that uses it).
- *Patterns*: `blocks/pattern.php render_block_core_pattern()` renders a
  registered pattern's content with `do_blocks()`. Its blocks are parts, not
  editable here (the content is in a pattern file). A block inserted from a
  pattern carries `metadata.patternName`; the trace names the pattern and its
  file (`WP_Theme::get_block_patterns()`; the registry drops `filePath` once it
  loads content).
- *Block bindings*: `class-wp-block-bindings-source.php get_value()` applies
  `block_bindings_source_value` (6.7+). The bound attribute is shown with its
  source; a `core/post-meta` binding links the meta's edit target, using the
  context `process_block_bindings()` just gave the block. `core/post-data` and
  `core/term-data` (6.9) are shown, not linked. Pattern overrides are read-only.
- *Block hooks*: `apply_block_hooks_to_content_from_post_object()` runs on
  `the_content` at priority 8 and inserts hooked blocks before `do_blocks()`;
  hooked blocks are not in the stored post, which the mapping below handles.
- *Interactivity API*: directives are processed after `"render_block_{$name}"`
  on the root interactive block, with the HTML API, which leaves comments
  alone; a `data-wp-text` element's content is replaced, marks inside it go,
  and the part is dropped from the trace.

**Where a rendered block is stored.** A block rendered in post content, a
`wp_template` or a `wp_template_part` is mapped to its path in that stored tree
(`parse_blocks()` of `post_content`, or `get_block_template()->content` — the
content the Site Editor itself saves, with its injected `theme` attributes):
its parent's path plus its index, checked against the stored block (name,
attributes without `metadata.ignoredHookedBlocks`, inner HTML). When block
hooks or a filter shifted the index, the one stored sibling that matches is
taken, or none. Unmapped blocks get no block edit.

**Block edits** (`block-attributes`, `via: schema`). The schema is built from
the block type's `attributes` (`class-wp-block-type.php`: block.json plus the
attributes block supports register). PHP cannot run a block's JavaScript
`save()`, so a change is offered only where the markup itself carries it:
- a dynamic block whose saved HTML is empty: every attribute in its comment
  delimiter;
- an attribute sourced from markup (`source` `rich-text`, `html`, `text` or
  `attribute`, with a `selector`): the first element the selector matches in
  the block's own HTML (what the editor's parser reads), when it holds plain
  text (rich text) or the attribute itself; written with
  `WP_HTML_Tag_Processor::set_modifiable_text()` (6.7+, escapes) or
  `set_attribute()`. A selector with combinators must match exactly one
  element.

Everything else is listed `readOnly` with the reason (the editor writes the
markup from it; it is bound; it has formatting; it is empty). Saving parses the
stored content, refuses when its hash differs from the trace's (the post
changed since the page was shown) or when
`serialize_blocks(parse_blocks($content)) !== $content` (writing back would
change other blocks), checks the target block's fingerprint, applies the
change, serializes, and saves through the store's REST route. 6.9's
`WP_Block_Processor` could splice one block's bytes instead; the round-trip
check was chosen because it refuses rather than guesses.

## Content, titles, excerpts, featured images

`post-template.php the_content()` applies `the_content` and prints it; so does
`blocks/post-content.php render_block_core_post_content()`, and so may a theme
file that calls `apply_filters('the_content', ...)` itself — on the post's own
content, or on anything else (a custom field, an option), so a theme file's call
counts only when its text is the post's `post_content` or `get_the_content()`. Core also applies it
inside `wp_trim_excerpt()` (excerpts), feeds and the REST API. Only the first
three are parts (the call site, found with a bounded backtrace, decides); each
is its own part, so a post whose content is printed twice has two.
`the_title` is a part only when `the_title()` prints it (and not with
`$display = false`); `get_the_title()` also fills attributes, menus and feeds.
`the_excerpt` (with the `get_the_excerpt` chain that produced it) and
`post_thumbnail_html` from `the_post_thumbnail()` likewise. Titles and excerpts
are marked even as plain text, because those template tags print them between
tags.

A content part's source is the template line that printed it; its variables
are the post's fields and meta (registered meta linked to its edit; protected
meta hidden; secret-looking keys redacted); its history is
`revision.php wp_get_post_revisions()` (autosaves marked); its access is
`read_post`.

**Post edits** go through the post's REST route
(`rest_get_route_for_post()`, `rest_do_request()`): title, excerpt, slug,
status, featured image, and registered meta through
`WP_REST_Post_Meta_Fields`, with the schema `register_meta()` gave it
(`get_field_schema()`), so validation, sanitizing, `edit_post` /
`edit_post_meta` capability checks, `wp_update_post()`, kses for users without
`unfiltered_html`, revisions (`wp_save_post_revision()` on `post_updated`) and
the `rest_after_insert_*` hooks are exactly the block editor's. A post type
without `show_in_rest` says so. Meta keeps revisions only when registered with
`revisions_enabled` (6.4+).

**Racing an editor.** `wp-admin/includes/post.php wp_check_post_lock()` reads
`_edit_lock` ("time:user", live for `wp_check_post_lock_window`, 150 seconds).
A post locked by anyone, the owner included, is refused with who holds it: the
open editor holds the old content and would write over the change at its next
save or autosave. Block edits and moves are also refused when the content
changed since the trace. Field edits are last-write-wins, as two editors
saving are. 7.1's PHP has no real-time collaboration.

## Shortcodes

`shortcodes.php do_shortcode()` first runs `do_shortcodes_in_html_tags()`
(shortcodes inside attribute values), then `do_shortcode_tag()` for the rest,
which applies `pre_do_shortcode_tag` (a non-false answer replaces the output)
and, after the callback, `do_shortcode_tag`. A shortcode is a part from
`pre_do_shortcode_tag` to `do_shortcode_tag`; one found inside an attribute is
not marked (its output becomes the attribute). In post content `do_shortcode`
runs at priority 11, after `do_blocks` at 9, so a shortcode inside a block
renders after that block has closed: its parent is taken from where its marks
sit in the page, not from the render stack.

## Widgets

`widgets.php dynamic_sidebar()` fires `dynamic_sidebar_before`, then for each
widget applies `dynamic_sidebar_params` and fires `dynamic_sidebar` just before
calling its callback, then `dynamic_sidebar_after`.
`class-wp-widget.php display_callback()` applies `widget_display_callback`.
The widget area is a part bracketed by marks at the two actions; each widget's
marks ride in its own `before_widget` and `after_widget` (a widget that does not
print them is unmarked and dropped). A widget whose class sets
`show_instance_in_rest` (the block, text and HTML widgets do) is editable
through `/wp/v2/widgets`, which runs the widget's own `update()`; others say
so. Reordering and moving between areas use `wp_set_sidebars_widgets()` (which
adds `array_version` to the option).

## Menus

`nav-menu-template.php wp_nav_menu()` applies `wp_nav_menu_args`,
`pre_wp_nav_menu` (short-circuit), and only once it has items
`wp_nav_menu_objects`, then `wp_nav_menu_items`,
`"wp_nav_menu_{$slug}_items"` and `wp_nav_menu`. The menu part opens at
`wp_nav_menu_objects` (its cost counted from `wp_nav_menu_args`) and closes at
`wp_nav_menu`. `class-walker-nav-menu.php Walker_Nav_Menu::start_el()` applies
`nav_menu_item_args` first and `walker_nav_menu_start_el` last for each link;
the link's output (inside its `<li>`) is a part. A custom walker that skips
those filters has no link parts. Links are edited through `/wp/v2/menu-items`
(title; address only for custom links). A menu level's links are reordered,
moved under another link of the same menu, or a link to the page being viewed
inserted; `menu_order` is one depth-first sequence over the menu, so the menu is
renumbered.

## Site title and tagline

`get_option()` applies `"option_{$option}"`. Read for `blogname` or
`blogdescription` while a part renders (not in `wp_head`), the part offers the
option's edit, saved through `/wp/v2/settings` (`register_initial_settings()`
exposes them as `title` and `description`; `manage_options`).

## Styles

`class-wp-theme-json-resolver.php` merges core defaults (`get_core_data()`),
blocks' own (`get_block_data()`, 6.1+), the theme's `theme.json`
(`get_theme_data()`) and the user's global styles (`get_user_data()`, which
does not create the global styles post) in that order. For each block type the
trace flattens `styles.blocks.{name}` per origin and names the last origin that
set each value, applies a block style variation (`is-style-*`) on top, then the
block's own `style` attribute.

## Queries, assets, logs

- `class-wpdb.php wpdb::_do_query()` logs a query only while `SAVEQUERIES` is
  true, read on every query; defining it at must-use plugin load records every
  query of a traced request and no other. `wpdb::log_query()` applies
  `log_query_custom_data` (5.3+); there a bounded backtrace finds the file and
  line that asked (the first frame outside core, else outside wpdb). Core's own
  caller string (`wp_debug_backtrace_summary()`) names functions only. The row
  count comes from the `query` filter of the next query, which runs before
  `flush()`. A `wp-config.php` that defines `SAVEQUERIES` false wins, and the
  trace logs that it has no queries.
- `class-wp-dependencies.php` `done` and `queue` give scripts and styles;
  `script-loader.php wp_maybe_inline_styles()` prints small stylesheets inline
  and sets their `src` to false, keeping `inlined_src` and `path`;
  `class-wp-script-modules.php` keeps script modules apart (`get_queue()`,
  `get_registered()`).
- PHP warnings and notices come from an error handler that chains to the one
  before it and returns what it returns (so PHP's own handling is unchanged),
  skipping `@`-suppressed errors; `_doing_it_wrong()` and the `_deprecated_*()`
  family fire `doing_it_wrong_run` and friends whether or not `WP_DEBUG` is on,
  and are logged once with their call site.

## Finishing and storing the trace

`template.php` (6.9+) starts an output buffer at `wp_before_include_template`
(priority 1000) when a filter is on `wp_template_enhancement_output_buffer`.
The trace is assembled at `shutdown` priority 0 (`shutdown_action_hook()`),
before `wp_ob_end_flush_all()` flushes at priority 1 and outside any buffer
handler (where `ob_start()` would be fatal). When core's buffer is flushed, its
filter removes empty pairs of marks and notes which parts the page holds and
inside which; `wp_finalized_template_enhancement_output_buffer` stores the
trace, dropping parts the page lost (stripped excerpts, printed nowhere) and
moving their children up. Without that buffer (before 6.9, or a request that
exited before including a template) the trace is stored at shutdown, unpruned.
An HTML minifier that rewrites the page after core's buffer can strip the
marks; the trace then lists parts the view cannot find.

Traces are transients (`set_transient()`, ten minutes, not autoloaded), keyed
by user, the newest twenty kept. With a persistent object cache they live
there, and may be evicted early. A trace over four megabytes loses its longest
lists first and says so in `truncated`. On multisite, traces and edits belong
to the current site; the helper was not run on a multisite.

## Collections and undo

Block lists (a post's top level, a container's inner blocks, a template's or a
template part's), widget areas and menu levels can be reordered, moved and
inserted into. `blocks.php serialize_block()` walks `innerContent`, taking the
next inner block at each `null`; a block moving into or out of a container
moves a placeholder with it (and one whitespace separator), and an empty
container, which has no placeholder to put a block beside, is refused. A move
into a container honours the block type's `parent` and the container's
`allowed_blocks`. The palette is registered patterns
(`WP_Block_Patterns_Registry`, saved markup the editor accepts) and dynamic
blocks that render from attributes alone (no sourced attribute, no inner
blocks), inserted as a void delimiter. A place is counted as the app side does
(`src/shared/live-arrange.ts`): the item's index among the target's items after
the move, from 0, the moving item left out (B in [A,B,C] to 2 is [A,C,B]; into
[X,Y] at 1 is [X,B,Y]; the length appends; past it is refused). Removing a block
also removes a separator beside it, so the block it goes before and the
container it goes into are tagged before the removal and found again after,
rather than trusting shifted paths. A move or insert refuses with HTTP 409
and the list's current order when its store changed since the trace. Undo puts
back exactly the content it replaced, only while the store is still as the move
left it; the first change to a theme's template or template part creates the
Site Editor's database copy, and undoing it deletes that copy (what the Site
Editor's Reset does).

## Go to

`/_wanigan/find` builds the wp-admin menu as `wp-admin/menu.php` and
`wp-admin/includes/menu.php` build it for the logged-in user: core's entries by
capability, `_admin_menu` and `admin_menu` for every plugin's
`add_menu_page()`/`add_submenu_page()`, then removal of entries the user cannot
open. Plugins commonly register their admin pages only when `is_admin()`, so
this one route defines `WP_ADMIN` at must-use plugin load, as
`wp-admin/admin.php` does before WordPress loads; it fires no `admin_init` and
renders no screen. Links follow `wp-admin/menu-header.php _wp_menu_output()`
(`get_plugin_page_hook()`, `admin.php?page=`). Block themes add their templates,
template parts and styles in the Site Editor; the front page and posts page
come from the reading settings; each public or `show_ui` post type adds its ten
most recently changed items. A search (`?q=`) matches post titles only
(`WP_Query` `search_columns`, 6.2+, no meta queries), term names
(`get_terms(['name__like'])`) and users by login, nicename or display name
(`WP_User_Query`, `list_users`), at most 50; each item carries its edit screen,
preview or view, latest revision (one grouped query) and trash link
(`get_delete_post_link()`, with its nonce), and only what `read_post`,
`edit_post`, `edit_term` and `edit_user` allow.

## What was not verified

- WordPress before 6.9 (no page template part, no pruning), before 6.6 (no
  block cost or parents from the render stack) and before 6.2 (no title-only
  search): reasoned from the source, not run.
- Multisite, persistent object caches, page-cache drop-ins and HTML minifiers.
- A custom nav walker, a widget without `before_widget`, block themes with
  template activation (editor-only in 7.1).
- PHP 7.4 itself: the source is kept to 7.4 syntax and checked by a test, and
  linted with PHP 8.5.
