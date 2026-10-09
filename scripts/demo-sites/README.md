# Demo sites

Two made-up sites for Wanigan's public video and screenshots, so the live
view can be shown on a real Drupal and a real WordPress without showing anyone's
real site. Every name, word and picture in them is invented here; nothing is
downloaded but Drupal, WordPress, their CLIs and one npm package that renders
the pictures.

| Site | Built with | Local | Live stand-in |
| --- | --- | --- | --- |
| Northstar Storefront, an outdoor-goods shop | Drupal 11 | https://northstar-demo.ddev.site | https://northstar-live.127.0.0.1.nip.io |
| Fieldnotes, a field journal | WordPress | https://fieldnotes-demo.ddev.site | https://fieldnotes-live.127.0.0.1.nip.io |

The names match the demo's own projects (`src/core/demo.ts`).

## Build

You need [ddev](https://ddev.com) and Docker (or OrbStack), and an internet
connection for Composer, WP-CLI and npm.

```sh
scripts/demo-sites/build.sh drupal      # or wordpress, or all
```

Sites go in `~/Projects/wanigan-demo/` (`WANIGAN_DEMO_DIR` changes that), one
ddev project each. The script starts and stops only those two projects.

Running it again is safe and is how a site is reset after a take: theme,
module, settings and content go back to what these files say, matched by
stable keys, so ids stay the same and nothing is duplicated. Each site is a
local git repository (never pushed) so Wanigan's Changes view has one; a
rebuild commits what it changed.

The admin user is `admin`. Its password is generated on the first build, kept
in the site's `.demo-admin` file (ignored by the site's git) and printed at the
end. It is never written into this repository.

## What is in them

**Northstar** (`drupal/`) uses Drupal core only, plus its own theme and one
small module:

- Content: sixteen products, eight journal entries, four events, three pages
  and two landing pages; French translations of most of it with a language
  switcher; the editorial workflow with a product draft waiting over its
  published version, a journal entry that is still a draft, and an about page
  with revision history; Editor and Author roles.
- Model: products with Media Library pictures shown through responsive image
  styles, price and earlier price, multi-value highlights and badges, category
  and materials, related products, a date and a link; journal entries with a
  date range and products to shop; events with a date range; seven block types
  (hero, callout, feature, number, question, quote, picture and text).
- Layout Builder: the front page (reusable, translated blocks, a field block
  and two views blocks) and the workshop (inline blocks and a field block in
  one-, two- and three-column sections).
- Theme `northstar`: nineteen single-directory components, nested (a product
  card in a card grid in a section) with variants and slots; preprocess
  functions that visibly shape prices, bylines, date tiles and blocks;
  suggestions by region, block type, view mode and bundle; behaviors for the
  mega menu, the phone menu, the gallery, tabs and an accordion.
- Views: the shop with category and price filters, a sort and a pager; the
  journal with a topic filter; open days; bestsellers; "More like this"; term
  pages. Also core search, a contact form, and a welcome block for signed-in
  people built by a lazy builder, so BigPipe streams it (`northstar_account`).
- Twig debug is on and render caches are off, so the live view names every
  template and an edit shows on the next load.

**Fieldnotes** (`wordpress/`) is a block theme, a child of Twenty Twenty-Five,
with a small plugin of ours; see `wordpress/build.sh` for its parts.

## Live stand-ins

To show Local beside Live, each site also answers at a second address that
resolves to this Mac (nip.io answers `*.127.0.0.1.nip.io` with 127.0.0.1). It
is the same code serving a copy of the database, made on each build, with
production's settings (no Twig debug, aggregated CSS) and a few differences
to find: older hero words, a different shipping threshold, one price, one
product not yet published. The sites' own files name it, as a real project's
would: a Drush alias and a README table for Northstar, a WP-CLI alias for
Fieldnotes.

## Pictures

`images/` draws every picture as SVG and renders it to JPEG with resvg inside
the web container: products as studio shots with one backdrop and framing,
and landscapes and maps for the journals. The same seed always draws the same
picture. Only missing pictures are drawn; delete a site's `.demo-images/` to
draw them all again.

## HTTPS

ddev serves each site with a certificate from this Mac's mkcert authority. If
that authority is not in the system keychain (`mkcert -install`), browsers
refuse it, but Wanigan's live view trusts it for these hosts. To check from a
terminal: `curl --cacert "$(mkcert -CAROOT)/rootCA.pem" https://northstar-demo.ddev.site/`.

## Removing them

```sh
ddev delete -O -y northstar-demo
ddev delete -O -y fieldnotes-demo
rm -rf ~/Projects/wanigan-demo
```
