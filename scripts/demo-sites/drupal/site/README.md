# Northstar Storefront

A made-up outdoor-goods shop on Drupal 11, built for Wanigan's demo by
`scripts/demo-sites/build.sh` in the Wanigan repository. Nothing here is for
sale, and every name, word and picture is invented.

## Environments

| Environment | Address |
| --- | --- |
| Local | https://northstar-demo.ddev.site |
| Live | https://northstar-live.127.0.0.1.nip.io |

Live is a stand-in: the same code serving a copy of the database, with
production's settings and a few differences, rebuilt by each build.

## What is here

- The `northstar` theme (`web/themes/custom/northstar`): single-directory
  components, Twig overrides, preprocess functions and theme suggestions.
- Products, journal entries, plain pages and a Layout Builder front page.
- Run `ddev drush uli` for a login link, or use the password in `.demo-admin`.
