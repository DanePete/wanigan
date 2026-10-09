#!/usr/bin/env bash
# Builds Wanigan's two demo sites with ddev, for screenshots and video:
#   drupal     Northstar Storefront, Drupal 11  https://northstar-demo.ddev.site
#   wordpress  Fieldnotes, WordPress            https://fieldnotes-demo.ddev.site
#   all        both
#
# Everything in them is made up: names, words, pictures. Safe to run again: a
# rerun puts the theme, content and settings back to what these scripts say,
# keeps node and post ids, and does not duplicate anything.
#
# Needs ddev (and Docker or OrbStack). Sites go in $WANIGAN_DEMO_DIR, by
# default ~/Projects/wanigan-demo. Admin passwords are made on first build,
# kept in each site's .demo-admin file (never in this repository) and printed
# at the end.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="${WANIGAN_DEMO_DIR:-$HOME/Projects/wanigan-demo}"

usage() { echo "usage: $(basename "$0") drupal|wordpress|all" >&2; exit 64; }
[ $# -eq 1 ] || usage
case "$1" in drupal|wordpress|all) ;; *) usage ;; esac

if ! command -v ddev >/dev/null 2>&1 && [ -x "$HOME/.local/bin/ddev" ]; then PATH="$HOME/.local/bin:$PATH"; fi
for tool in ddev git rsync; do
  command -v "$tool" >/dev/null 2>&1 || { echo "build.sh needs $tool on PATH." >&2; exit 69; }
done

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# The admin password for a site: made once, kept in <site>/.demo-admin (mode 600).
admin_password() {
  local file="$1/.demo-admin"
  if [ ! -s "$file" ]; then
    (umask 077; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 >"$file")
  fi
  cat "$file"
}

# Copies what a site's seed needs into <site>/.demo-build, where the container sees it.
stage() {
  local site="$1"; shift
  rm -rf "$site/.demo-build"
  mkdir -p "$site/.demo-build/images"
  cp "$HERE/images/make-images.mjs" "$site/.demo-build/images/"
  for part in "$@"; do cp -R "$HERE/$part" "$site/.demo-build/"; done
}

# Draws the pictures inside the web container (Node, ImageMagick and fonts are there).
# They are kept between builds in <site>/.demo-images, and only missing ones are drawn.
draw_images() {
  local site="$1" set="$2"
  mkdir -p "$site/.demo-images"
  ddev exec -d /var/www/html/.demo-build/images bash -c "
    set -e
    if [ ! -d node_modules/@resvg/resvg-js ]; then
      npm init -y >/dev/null
      npm install --no-audit --no-fund --loglevel=error @resvg/resvg-js@2.6.2 >/dev/null
    fi
    node make-images.mjs $set /var/www/html/.demo-images
  "
}

# A local git repository for the site, so Wanigan's Changes view and the live
# view's helper (which writes to .git/info/exclude) have one. Never pushed.
git_init() {
  local site="$1" message="$2"
  cd "$site"
  if [ ! -d .git ]; then
    git init -q -b main
    git config user.name "Northstar Demo"
    git config user.email "demo@northstar.example"
  fi
  if ! git rev-parse -q --verify HEAD >/dev/null; then
    git add -A
    git commit -q -m "$message"
    echo "  · git: first commit"
  else
    echo "  · git: $(git status --short | wc -l | tr -d ' ') changed paths left as they are"
  fi
}

build_drupal() {
  local site="$DEMO_DIR/northstar" name="northstar-demo" live="northstar-live.localtest.me"
  step "Northstar Storefront (Drupal 11) in $site"
  mkdir -p "$site"
  cd "$site"
  if [ ! -f .ddev/config.yaml ]; then
    ddev config --project-name="$name" --project-type=drupal11 --docroot=web \
      --performance-mode=none --additional-fqdns="$live"
  fi
  ddev start -y
  if [ ! -f composer.json ]; then
    ddev composer create-project 'drupal/recommended-project:^11' --no-interaction
  fi
  [ -x vendor/bin/drush ] || ddev composer require drush/drush --no-interaction
  local pass; pass="$(admin_password "$site")"

  step "Drupal: install"
  if ddev drush status --field=bootstrap 2>/dev/null | grep -q Successful; then
    echo "  · already installed"
    ddev drush user:password admin "$pass" >/dev/null
  else
    ddev drush site:install standard -y --site-name='Northstar Storefront' --site-mail=hello@northstar.example \
      --account-name=admin --account-mail=admin@northstar.example --account-pass="$pass"
  fi
  ddev drush pm:install -y layout_builder layout_discovery link options >/dev/null
  # Drupal 11's standard profile leaves pages, articles and search to core's
  # recipes. Each is applied once; state remembers it, so a rerun skips it.
  for recipe in page_content_type article_content_type article_tags content_search; do
    if [ "$(ddev drush state:get "northstar_demo.recipe.$recipe" 2>/dev/null)" != "1" ]; then
      ddev drush recipe "core/recipes/$recipe"
      ddev drush state:set "northstar_demo.recipe.$recipe" 1
    fi
  done

  step "Drupal: the northstar theme"
  mkdir -p web/themes/custom/northstar/fonts
  rsync -a --delete --exclude fonts "$HERE/drupal/northstar/" web/themes/custom/northstar/
  cp web/core/themes/olivero/fonts/metropolis/*.woff2 web/core/themes/olivero/fonts/lora/*.woff2 web/themes/custom/northstar/fonts/
  ddev drush theme:install -y northstar >/dev/null
  ddev drush config:set -y system.theme default northstar >/dev/null
  cp "$HERE/drupal/site/README.md" README.md
  mkdir -p drush/sites
  cp "$HERE/drupal/site/self.site.yml" drush/sites/self.site.yml
  [ -f .gitignore ] || cp "$HERE/drupal/site/gitignore" .gitignore

  step "Drupal: pictures"
  stage "$site" drupal
  draw_images "$site" northstar

  step "Drupal: content model, content, views, blocks, menus"
  ddev drush php:script /var/www/html/.demo-build/drupal/seed.php
  ddev drush cr >/dev/null
  ddev drush cron >/dev/null 2>&1 || true

  step "Drupal: the Live stand-in at https://$live"
  live_drupal "$site" "$live"

  git_init "$site" "Northstar Storefront, the Wanigan demo store"
  rm -rf "$site/.demo-build"
  DRUPAL_DONE="https://$name.ddev.site  (admin / $pass)  Live stand-in: https://$live"
}

# The Live stand-in: the same code serving a copy of the database at another
# address (settings.php picks the database by host), with production's
# settings and a few differences, so a Local and Live comparison has
# something to find. Rebuilt from the local database on every build.
live_drupal() {
  local site="$1" live="$2"
  if ! grep -q 'northstar-live' web/sites/default/settings.php; then
    chmod u+w web/sites/default web/sites/default/settings.php
    cat "$HERE/drupal/site/settings.live.php" >>web/sites/default/settings.php
  fi
  ddev exec "mysql -uroot -proot -hdb -e 'DROP DATABASE IF EXISTS live; CREATE DATABASE live; GRANT ALL ON live.* TO \"db\"@\"%\";' && mysqldump -uroot -proot -hdb --single-transaction db | mysql -uroot -proot -hdb live"
  ddev drush --uri="https://$live" php:script /var/www/html/.demo-build/drupal/live.php
  ddev drush --uri="https://$live" cr >/dev/null
}

build_wordpress() {
  # shellcheck source=wordpress/build.sh
  source "$HERE/wordpress/build.sh"
}

DRUPAL_DONE=""
WORDPRESS_DONE=""
case "$1" in
  drupal) build_drupal ;;
  wordpress) build_wordpress ;;
  all) build_drupal; build_wordpress ;;
esac

step "Done"
[ -n "$DRUPAL_DONE" ] && echo "  Northstar Storefront: $DRUPAL_DONE"
[ -n "$WORDPRESS_DONE" ] && echo "  Fieldnotes:           $WORDPRESS_DONE"
echo "  Passwords are kept in each site's .demo-admin file."
