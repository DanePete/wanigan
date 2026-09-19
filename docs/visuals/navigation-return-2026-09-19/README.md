# Restoring hidden navigation

The installed app retained a header button named “Show navigation,” but its
visible content was only a panel icon beside the window controls. This made
returning to the hidden workspace list hard to discover.

The same button now shows **Show navigation** whenever the list is hidden,
including compact windows. The open state keeps its existing icon. The control
lives with `WorkspaceNavigation` in `SpaceNavigation.tsx`; App delegates to it.
The redundant native tooltip was removed, reducing tooltip debt by one.

The existing return routes remain: Option–Command–S on macOS, Search → Show
navigation, and View → Destination List. No visibility preference or shortcut
contract changed.

## Evidence

The `before/` and `after/` directories each contain eight screenshots: hidden
and open navigation at 1440 × 1000 and 720 × 1000, in dark and light themes.
Desktop shots show Sessions; compact shots show Home after a reload. The
fictional Home scene reports its unavailable 3D renderer; that is unrelated
to navigation and is present in both sets.

`verification.json` in each directory records three passing probe groups:

- Desktop restore and hide actions, focus restoration, and preference replay
  across reloads.
- The existing Option–Command–S shortcut in both directions.
- Compact drawer opening and closing without writing the desktop preference,
  with the header fitting the viewport and focus returning to its toggle.

These are production-renderer checks with a fictional preload bridge and
simulated preference persistence. They do not prove SQLite persistence or
start a real agent. The installed app was also inspected read-only to confirm
the original icon-only control and its accessible name.

Reproduce after building:

```sh
nvm use
npm run build
node scripts/probe-navigation-return.mjs
```

Use `--before` with `WANIGAN_RENDERER_ROOT` pointing at the earlier renderer to
produce the before comparison. The final renderer used for these screenshots
was frozen at `/private/tmp/wanigan-navigation-return-final-renderer`.

The complete `npm test` passed in an isolated release checkout: all eight gates,
539 shared tests, six asynchronous credential scenarios and 2,375 main-process
smoke assertions. The release source combines Relay commit `730a880` and this
navigation change. Concurrent Usage-module work in the main checkout was left
untouched and excluded from this local installation.
