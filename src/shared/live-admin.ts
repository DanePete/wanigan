// Hiding a site's own admin bars in the live view, so the page looks as a visitor sees it while the owner stays
// logged in. One stylesheet goes into each page the view loads, inert until the page's root carries ADMIN_ATTR; the
// switch only sets or takes away the attribute, so it is instant and needs no reload. Each rule is what the core on
// disk does to the page, undone:
// - Drupal core Navigation (11.x): the fixed top bar (`aside.top-bar[data-drupal-admin-styles]`, `data-offset-top`)
//   and the sidebar (`aside.admin-toolbar`), which shift the page through Drupal.displace's
//   `--drupal-displace-offset-*` on <html> and `.admin-toolbar ~ .dialog-off-canvas-main-canvas`'s margin
//   (core/modules/navigation/css/components/admin-toolbar.css, top-bar.css).
// - Drupal core Toolbar: `#toolbar-administration`, which writes `body.style.paddingTop` (ToolbarVisualView.js) and
//   moves the body aside for its vertical tray (toolbar.module.css).
// - WordPress: `#wpadminbar`, and core's bump `html { margin-top: 32px !important }` (46px narrow)
//   (wp-includes/admin-bar.php, _admin_bar_bump_cb).
// A theme's own allowance for an admin bar (a sticky header moved down under `.admin-bar`, say) is the theme's, and
// stays: nothing here guesses at it.

/** The attribute on the page's root that switches the hiding on. */
export const ADMIN_ATTR = 'data-wl-no-admin';

const on = `html[${ADMIN_ATTR}]`;

/** The stylesheet, inserted as a user-origin sheet (its !important outranks the page's, an inline one included). */
export const ADMIN_CSS = [
  `${on} aside.top-bar[data-drupal-admin-styles], ${on} aside.admin-toolbar, ${on} .admin-toolbar-control-bar, ${on} #toolbar-administration, ${on} #wpadminbar { display: none !important; }`,
  `${on} { --drupal-displace-offset-top: 0px !important; --drupal-displace-offset-right: 0px !important; --drupal-displace-offset-bottom: 0px !important; --drupal-displace-offset-left: 0px !important; margin-top: 0 !important; }`,
  `${on} .admin-toolbar ~ .dialog-off-canvas-main-canvas { margin-inline-start: 0 !important; }`,
  `${on} body.toolbar-fixed, ${on} body.toolbar-horizontal { padding-top: 0 !important; }`,
  `${on} body.toolbar-vertical, ${on} body.toolbar-tray-open { margin-inline-start: 0 !important; margin-inline-end: 0 !important; }`,
].join('\n');

/** The page script line that switches the hiding on or off in the page shown. */
export const adminSwitch = (hide: boolean): string => `document.documentElement.toggleAttribute(${JSON.stringify(ADMIN_ATTR)}, ${hide ? 'true' : 'false'}); ${hide ? 'true' : 'false'}`;
