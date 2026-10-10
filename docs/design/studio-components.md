# Studio components

What the views are built from, for the agents moving each view to Studio. The design and its reasons are in
[2026-10-10-studio.md](2026-10-10-studio.md); the look is the mock in [studio-mock/](studio-mock/). This file says
what each part is, its props, its states, and when to reach for it. If a view needs something none of these do,
add it here (and to `components/`), not to the view.

Everything below is in `src/renderer/src/components/`. The basic parts are in `ui.tsx`; the larger ones each have
their own file, named below. Styles: `styles/controls.css` (buttons, fields, menus, dialogs: shared with the
phone page) and `styles/components.css` (the rest). Both name tokens only.

## Rules every view follows

- **Tokens only.** Colour, size, radius, duration and elevation come from `styles/tokens.css`. No literal in a
  stylesheet; no inline colour. If a size recurs, it becomes a token.
- **One meaning per colour.** Water (`--water`, `--water-fill`, `--water-text`, `--water-soft`) marks the
  selection and the one primary action of a surface. Amber means something needs you, and nothing else: only
  `Count tone="amber"`, `Dot tone="amber"`, `Button tone="attention"` (answering what needs you) and needs-you words
  in `--amber`. Red is failed or refused; green is saved or verified. No decorative colour, no tinted cards.
- **Blue words use `--water-text`**, never `--water` (which is for rings, outlines and the selected tool's icon,
  and is too pale for words in the light theme). White words sit only on `--water-fill`.
- **Depth from surfaces, not borders.** A panel is `--surface` on the ground with one hairline (`--line`). Never a
  bordered box inside a bordered box. What floats uses `--elev-float`; dialogs and the page on the canvas
  `--elev-sheet`; a selected segment `--elev-raise`.
- **Every control is a real `<button>`, `<a>` or `<input>`** with a name (its text, or `aria-label`) and the focus
  ring (base.css: 2 px water, offset 2 px; don't remove it). An icon alone is an `IconButton`.
- **Keys come from the table** (`shared/shortcuts.ts`): pass a command id or a `Shortcut` to `keys` and the
  tooltip, `aria-keyshortcuts` and caps follow, platform-correct (⌘ on a Mac, Ctrl elsewhere). Never type "⌘"
  into a string; use `KeyCaps` or `keyLabel`.
- **Words where they decide something.** No paragraph on first paint: explanation lives in `EmptyState`, tooltips,
  the ? sheet and `Disclosure`. Refusals and failures keep every word they need.
- **Built for anyone.** No Mac-only words or controls: "Show in Finder" is `fileManager(platform)` (`lib/format.ts`).
  Both themes; reduced motion (the tokens make every duration instant and `--rise` 0).

## Tokens at a glance

| Group | Tokens |
|---|---|
| Surfaces | `--bg` (ground), `--bg-rail`, `--surface` (bars, panels), `--raised` (menus, dialogs), `--sunken` (tracks, chips), `--bg-field` (inputs), `--bg-canvas` (behind the work), `--hover` |
| Lines | `--line` (the hairline), `--line-strong` (a control's edge) |
| Text | `--fg`, `--muted` (secondary), `--faint` (counts, hints) |
| Water | `--water`, `--water-fill`, `--water-text`, `--water-ink` (white on the fill), `--water-soft`, `--water-line` |
| Meanings | `--amber`, `--amber-fill`, `--amber-fill-ink`, `--amber-soft`; `--red`, `--red-soft`; `--green`, `--green-soft` |
| Wanigan's mark | `--orb-water`, `--orb-glass`, `--orb-edge` (never amber) |
| Elevation | `--elev-raise`, `--elev-float`, `--elev-sheet`, `--focus` (the ring as a shadow), `--scrim` |
| Type | `--font-ui`, `--font-mono`; `--text-xs` 11, `--text-sm` 12, `--text-base` 13 (body), `--text-md` 14, `--text-title` 15 (panel titles), `--text-lg` 17 (view titles), `--text-xl` 20, `--text-2xl` 28; `--text-2xs` 10 only inside a count. Weights 400, 500, 600. `--font-display` (Condensed) is retired: move to `--font-ui`. |
| Space and radius | `--space-1…12` (4 px grid), `--gap-hair` 2, `--track-pad` 3; `--radius-s` 6, `-m` 8, `-l` 10, `-xl` 12, `-round` |
| Motion | `--dur-fast` 120 ms (hover, press), `--dur` 180 ms (panels, menus), `--dur-slow`; `--ease` (arriving), `--ease-in` (leaving), `--rise` |
| Frame sizes | `--rail-w` 60, `--rail-tile` 40, `--topbar-h` 48, `--toolbar-h` 50, `--status-h` 34, `--panel-left-w` 248, `--panel-right-w` 292, `--control-s` 28, `--control-m` 32, `--icon-btn-w`/`-h` 32 × 30, `--menu-row` 32, `--count-h` 18, `--dot` 7 |

Changing a colour: run `node scripts/run-electron-node.mjs --test src/shared/contrast.test.ts`. It reads
`tokens.css` and names any text pair under AA in either theme.

## Buttons

### `Button` (ui.tsx)

```tsx
<Button tone="primary" icon="check" size="m" keys="new-session" onClick={save}>Make it real</Button>
```

| Prop | |
|---|---|
| `tone` | `plain` (hairline, the default) · `primary` (water fill, white words: **one per surface**) · `quiet` (words only) · `danger` (red: destructive confirms only) · `attention` (amber fill: only the action that answers what needs you) |
| `size` | `m` 32 px (default) · `s` 28 px |
| `icon` | an `IconName` before the words |
| `keys` | a command id or `Shortcut`: its tooltip says the key |
| `onClick` | return the promise (`onClick={save}`), and the button stays disabled while it runs and ignores a double click |

States: hover (a tint), pressed (a pixel down; still with reduced motion), focus ring, disabled (inert, sunk),
busy (`aria-busy`, disabled). Use for an action with words. A toolbar of icons uses `IconButton`.

### `IconButton` (ui.tsx)

```tsx
<IconButton icon="pick" label="Select" keys={{ id: null, label: 'Select', group: 'In the live view', keys: ['V'] }} pressed={tool === 'select'} onClick={…} />
```

32 × 30 (`size="s"`: 28 × 28). `label` is its `aria-label` and its tooltip; `keys` adds the key to the tooltip and
`aria-keyshortcuts`. `pressed` makes it a toggle: `aria-pressed`, water fill and white icon while on. `tone`
defaults to `quiet`. **Changed:** it no longer sets a native `title`; the tooltip is drawn by `TooltipHost`. `tipSide`
(`top` default, `right`, `bottom`) places the tooltip.

## Choosing and switching

### `Segmented` (ui.tsx)

A radio group: one value among a few. `form="pill"` (default): a sunk track, the chosen segment raised (a mode:
Unified/Split, List/Watch). `form="underline"`: a 2 px water line under the chosen one. Options take `label`,
`hint` (its tooltip) and `count`. Arrow keys, Home and End move and choose. **New props:** `form`, an option's `count`.

### `Tabs` and `TabPanel` (Tabs.tsx)

The WAI-ARIA tabs pattern: what one panel shows (the Inspector's Design, Made by, Data). Underline form by default
(a panel's sections), `form="pill"` for switching a whole area. Give the same `id` to both:

```tsx
<Tabs id="inspector" label="About the title" value={tab} onChange={setTab} tabs={[{ value: 'design', label: 'Design' }, { value: 'made', label: 'Made by', count: 3 }]} />
<TabPanel tabs="inspector" value={tab}>…</TabPanel>
```

Arrow keys move and select (automatic activation); a tab takes `count`, `disabled` and `keys`.
Use `Segmented` for a value (a filter, a mode) and `Tabs` for which content shows.

### `NavTabs` (Tabs.tsx)

Places as pill tabs: links with `aria-current="page"`, not ARIA tabs (each is a page of its own). The project bar
uses it. Items: `href`, `label`, `current`, `count`, `tip` (tooltip), `keys`. `children` go inside the track after
the links (the project bar's ··· `MenuButton`, styled as a tab with `className="… active"` when it holds the
current view). `stripRef` is the strip, for scrolling the current tab into view.

## Bars and panels

### `Toolbar`, `ToolGroup`, `ToolSeparator` (Toolbar.tsx)

```tsx
<Toolbar label="Live view">
  <Button icon="pull" size="s">Local</Button>
  <ToolGroup label="Tools">
    <IconButton icon="pick" label="Select" pressed={…} … />
    <IconButton icon="pencil" label="Type on the page" pressed={…} … />
    <ToolSeparator />
    <IconButton icon="camera" label="Snap" … />
  </ToolGroup>
  <Button tone="primary">Make real</Button>
</Toolbar>
```

`Toolbar` is the 50 px bar under the project bar: `role="toolbar"`, one Tab stop (the last focused, else the
pressed tool, else the first), Left/Right/Home/End along it. A field keeps its arrow keys; a `Segmented` or `Tabs`
inside keeps its own. `ToolGroup` is the sunk track of tools; on its own (not in a `Toolbar`) it is a toolbar
itself. One primary per bar.

### `Panel` and `Section` (Panel.tsx)

```tsx
<Panel side="right" title="Title" tabs={<Tabs … />} open={inspector} onClose={() => setInspector(false)} closeKeys={…}
  resizable sizeKey="live-inspector" minSize={260} maxSize={480}>
  <Section title="Words">…</Section>
  <Section title="Style" actions={<IconButton … />}>…</Section>
</Panel>
```

| Prop | |
|---|---|
| `side` | `left` (`--panel-left-w`, 248), `right` (`--panel-right-w`, 292), `bottom` |
| `title`, `label` | its head (15 px semibold) and accessible name |
| `tabs`, `actions` | underline `Tabs` under the title; small controls at the head's end |
| `open`, `onClose`, `closeKeys` | closed, it renders nothing (the work takes the room); its head's close button carries the key that toggles it |
| `resizable`, `size`, `minSize`, `maxSize`, `sizeKey` | a splitter on the edge that meets the work: drag it, or focus it and use the arrows (Shift: four steps), Home, End; double-click resets. `sizeKey` keeps the size on this computer |

The body scrolls on its own. A panel is a surface with one hairline: never put a bordered box in it. `Section` is
an 11 px semibold label and its content (and optional `actions`); sections space themselves.

### `Popover` (Popover.tsx)

A non-modal dialog beside the control that opened it (the tray, a colour picker, a small form): `anchor` (a ref),
`open`, `onClose`, `label`, `side` (`bottom`, `top`, `right`), `align` (`start`, `end`), `width`, `beside` (a
selector: open clear of the box that holds the control, as the tray clears the rail). Focus moves in (to
`[data-autofocus]` or the first control), Escape and a click outside close it, focus returns. It steps the live
view aside while open. Commands are a `MenuButton`; a value is a `Select`.

## Menus, fields and dialogs

### `MenuButton` (Menu.tsx)

A button that opens a menu of commands (ARIA menu button): float elevation, 10 px corners, 32 px rows, keys
right-aligned in `KeyCaps`, grouped under headings, radio and check items. **New:** `tip` (the button's tooltip)
and an item's `sequence` (its keys are pressed one after the other: G then H).

### `Select` (Select.tsx)

A value from a list (the ARIA select-only combobox), 32 px (`size="s"` 28), 8 px corners, a hairline at rest and
the water ring when focused or open. Options take `detail`, `extra` and `group`. Unchanged props.

### `Field`, `Toggle` (ui.tsx)

`Field` is a real `<label>` for the control it draws: `children` is `(id) => <input id={id} … />`. **New:** `error`
(red, `role="alert"`, the field's edge red) in place of the hint. Inputs, textareas and selects are 32 px, 8 px
corners, `--bg-field`, a hairline at rest and a water ring on focus, from controls.css; don't restyle them.

`Toggle` is a switch: a real checkbox with `role="switch"`, its `label` and an optional `hint` line (read as its
description). Use it for a setting that takes effect at once; a checkbox (`.check-row`) is for a choice inside a
form that is submitted.

### `Dialog` (ui.tsx)

A modal: sheet elevation, 12 px corners, a 15 px title, its content, and a `footer` with **at most one primary**
(Cancel is `quiet`). Focus is trapped, Escape closes, focus returns. `width` in px. A confirmation of something
destructive uses `tone="danger"` for its action.

### `Disclosure` (ui.tsx)

Where detail waits: a heading that is its button, with a quiet `summary` beside the title when closed.

## Marks and counts

| Part | Use |
|---|---|
| `Badge` (ui.tsx) | A small label: `neutral` (what it is), `water`, `green`, `red`. Never amber. |
| `Count` (ui.tsx) | A number in a pill: `sunk` (a plain count), `water` (news), `red` (failures), `amber` (needs you, only). `label` says what it counts to a screen reader. The old `.count` / `.count.hot` classes still work. |
| `Dot` (ui.tsx) | 7 px: `water` live, `amber` needs you (with a ring that keeps it at 3:1), `red`, `green`, `muted`. `label` makes it say something. |
| `StateMark`, `TypeMark`, `PriorityMark` | Unchanged; their name is now a tooltip (`data-tip`), not a native title. |
| `ProjectMark` | A project's key in mono on the sunk tint (water when its project is open). |
| `ProjectTile` | The rail's 40 px tile: the key in mono, a water ring while open, an amber dot when it needs you, a water dot when sessions run, dashed while paused, red when its folder is missing. A link; its name and key are its tooltip. |
| `KeyCaps` | Keys as caps: `shortcut` (from the table) or `keys` (+ `sequence`). `mac` is optional now (it reads the platform). |

## Empty, failing and loading

- `EmptyState` (ui.tsx): `title`, one sentence (`children`), one `action`, an optional `icon`. This is where a
  view's explanation lives. `Empty` is its old name and still works.
- `NotAnswering`: what a view shows when the core did not answer (never a false all-clear).

## What just happened: the status line, the tray, toasts

`useToast()` keeps its signature: `toast(text)`, `toast(text, 'error')`, `toast(text, tone, { action })`. **New tone:
`'done'`** for something saved or verified (a green check). Where it goes:

| | Where |
|---|---|
| Every outcome | The **status line** says the latest; the **notification tray** keeps it with its time until dismissed. |
| An outcome with an action (Undo) | The status line offers the action for 12 s; so does the tray. |
| A failure without an action | The status line, in red, until another outcome or the owner puts it away; the tray (the bell turns red). |
| A failure with an action (Retry) | A **toast** in the status line's own place, above it, until done or dismissed; then it stays in the tray. |

### `StatusLine` and `StatusSlot` (StatusLine.tsx)

The frame draws one `StatusLine` at the bottom of the main column, under every view and the dock (App.tsx); a view
does not draw its own. It holds: the latest outcome (icon, sentence, action), the view's own content at its end,
and the ? that opens the keys. A view fills the end with `StatusSlot`, drawn there while the view is shown:

```tsx
<StatusSlot><Segmented size="s" … /> or the dock's tabs, a count, a mode</StatusSlot>
```

`lib/notices.ts` has the store (`useNotices()`: the list, the latest, unread counts). Every view, the live editor
included, says its outcomes through `toast()` and puts its own tabs, modes and counts at the line's end through
`StatusSlot`; no view draws a status line of its own.

### `NotificationBell` (NotificationTray.tsx)

The rail's bell and the tray it opens. `openNotifications()` opens it from elsewhere (the palette does). The app's
own news lives here too (whether to check for updates, a new version).

## Helping the owner: How this works and tours

Every view that is more than a simple form explains itself two ways (Dane, 10 October: "every page that has more
than a simple form needs the how this works so the user understands what they are doing"; "each one should have a
tour … first visit and then a replay").

### How this works (`components/How.tsx`, `lib/how.ts`)

The view's rules as a picture with live numbers, as the board's (`views/HowItWorks.tsx`) has always been: lanes of
steps, who does each (`HowActor`: you, agents, jev, board, wanigan, site, needs, done), arrows for the usual path,
side notes. Every sentence is a rule the code enforces; a number whose source has not answered is left out.

```tsx
const how = useHow('changes');                     // registers the view, so the palette offers "How this view works"
<HowButton onClick={how.show} />                   // in the view's toolbar, at its end
{how.open ? (
  <HowDialog place="changes" title="How Changes works" intro={…} side={<HowNote title="…">…</HowNote>} onClose={how.hide}>
    <HowLane n={1} title="An agent changes files" actor="agents">
      <HowBox actor="agents" title="…" num={howNum(count, 'file changed', 'files changed')} onClick={…} hint="Show …">…</HowBox>
      <HowArrow label="you review" />
      …
    </HowLane>
  </HowDialog>
) : null}
```

`HowDialog` offers the view's tour in its footer when it has one.

### Tours (`components/Tour.tsx`, `lib/tours.ts`, `tours/`)

- **The welcome tour** (`tours/welcome.ts`) plays once on the first launch.
- **A view's tour** offers itself in the status line on the view's first visit (Take the tour, or Not now: either
  way it is not offered again), and replays from the status line's compass and the palette ("Tour of Board").
- Settings › Appearance turns first-visit offers off and offers every tour again.

A tour is a few stops. Each points at one thing by its `data-tour` name and says what it is for and what you can do
there. A stop whose target is not on the screen is passed over, never pointed at nothing. Write a view's tour in its
scope's file (`tours/live.ts`, `board.ts`, `sessions.ts`, `changes.ts`, `settings.ts`), with the place as its id
(`placeOf(route)`: a project's view by name, else the route's name):

```ts
export const CHANGES_TOURS: Tour[] = [{
  id: 'changes', name: 'Changes', intro: 'Where an agent’s work becomes a commit.',
  steps: [
    { target: 'changes-files', side: 'right', title: 'What changed', body: 'Every file …' },
    { target: 'changes-commit', title: 'Commit', body: (c) => `${keys(c, 'Mod', 'Enter')} commits …` },
  ],
}];
```

and put `data-tour="changes-files"` on the element (`NavTabs` takes `tour` for the strip and each item). Rules:

- Four to seven stops.
- Each body is one or two plain sentences: what it is, and what you can do there, with its key through `keys()`.
- Every stop is something the view really does.
- The live page is a native view: a tour steps it aside like every overlay, so stops can point at the canvas.
- The sweeps never see tours (the stub bridge's `toursOff`); `scripts/tour-sweep.mjs` checks them, and checks that
  every view with a compass offers its tour on the first visit. `WANIGAN_TOURS=off` turns them off for automation
  that drives the real window (the smoke sets it).

## Tooltips

`TooltipHost` (Tooltip.tsx, mounted once in App.tsx) draws the tooltip of anything carrying `data-tip` (and
`data-tip-keys`, `data-tip-side`): under a resting pointer after a moment, at once on keyboard focus. Spread
`tipProps(label, keys, side)` (ui.tsx) onto a control that is not an `IconButton`. Don't add native `title`s to
controls; they double up.

## The frame

| Part | File | |
|---|---|---|
| Rail | `shell/Rail.tsx` | 60 px. See the spec's frame. `SETTINGS_ROUTES` lists the routes its Settings lights for. |
| Project bar | `views/ProjectView.tsx` | 48 px, `.topbar.project-bar`. `ProjectView` now takes `projects` (for the name's menu). |
| Settings' sections | `shell/SettingsNav.tsx` | `SettingsFrame` beside Settings, Accounts, Skills and MCP servers: one section at a time, each a route (`#/settings/general`); `SETTINGS_PLACES` lists them for the palette, and `openSettingsSection(id)` goes to one. A section's page is `views/SettingsPage.tsx` (`SettingsPage`, `SettingsGroup`, `SettingRow`). |
| Palette | `dialogs/Palette.tsx` | Every view, Settings' sections, projects, cards, sessions, commands, each with its key. |
| Status line | `components/StatusLine.tsx` | Above. |

A view's own bar (Settings, Running, a session) is a `.topbar` (48 px, `--surface`, one hairline) with
`.topbar-title` and `.topbar-tools`; a view's tools go in a `Toolbar` under it, not in the bar.

## Moved, renamed, gone

- `IconButton`, `StateMark`, `TypeMark`, `PriorityMark`, `Segmented`'s hint: tooltips are `data-tip`, not `title`.
- The rail's fold (⌘\\, `lib/rail.ts`, `shared/rail.ts`, `--rail-w-folded`, View › Toggle Sidebar) is gone.
- `--rail` is `--bg-rail`; `--shadow-card` is `--elev-raise`; `--shadow-overlay` is `--elev-float` (or `--elev-sheet`
  for a dialog); `--amber-ink` is gone (`--amber-fill-ink`).
- `.rail-update`, `.rail-update-ask`, `.rail-tip`, `.rail-action` are gone: the tray's `.tray-update`,
  `.tray-update-ask`, the shared `.tooltip`.
- `Button`'s `attention` tone stays, for answering what needs you only.
