# Fieldnotes

A made-up field journal on WordPress: trail notes, gear checklists, weather
logs and essays from an invented lake country. Built for Wanigan's demo by
`scripts/demo-sites/build.sh` in the Wanigan repository. Every place, person,
word and picture here is invented; the pictures are drawn from code.

## Environments

| Environment | Address |
| --- | --- |
| Local | https://fieldnotes-demo.ddev.site |
| Live | https://fieldnotes-live.127.0.0.1.nip.io |

Live is a stand-in: the same code serving a copy of the database (`live`),
with production's settings and a few differences (an older tagline, one post
not yet published), rebuilt by each build. `wp-config.php` picks the database
by address, and `wp-cli.yml` names both: `ddev wp @live option get blogname`.

## What is here

- `wp-content/themes/fieldnotes`: a block theme, child of Twenty Twenty-Five.
  Templates, template parts (two headers, two footers), patterns, three style
  variations, custom block styles and locally bundled open-licence fonts.
- `wp-content/plugins/fieldnotes-trails`: the Trail post type and its Region
  taxonomy, trail facts as registered post meta shown through block bindings,
  and three blocks (a trail finder on the Interactivity API, a conditions log
  and season figures).
- Content: journal posts, trails, pages, synced patterns, a navigation menu
  and comments.
- Run `ddev wp user list`, or use the admin password in `.demo-admin`.
