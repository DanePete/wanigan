# Fieldnotes, a made-up field journal on WordPress, for Wanigan's demo.
# Sourced by ../build.sh inside build_wordpress, so $HERE, $DEMO_DIR, step,
# admin_password, stage, draw_images and git_init are in scope, and so is
# `set -euo pipefail`.
#
#   theme/fieldnotes          the block theme (child of Twenty Twenty-Five)
#   plugin/fieldnotes-trails  the Trail post type, its meta and blocks
#   seed/                     content, run with wp eval-file; live.php for Live
#   site/                     wp-config.php, wp-cli.yml, README.md, .gitignore
#
# A rerun puts the code, settings and content back to what these files say,
# matching every post by a stable key, so ids stay the same and nothing is
# duplicated.

local site="$DEMO_DIR/fieldnotes" name="fieldnotes-demo" live="fieldnotes-live.127.0.0.1.nip.io"
local src="$HERE/wordpress" version="${FIELDNOTES_WP_VERSION:-7.1.3}"
local parent_fonts="wp-content/themes/twentytwentyfive/assets/fonts"

step "Fieldnotes (WordPress $version) in $site"
mkdir -p "$site"
cd "$site"
if [ ! -f .ddev/config.yaml ]; then
  ddev config --project-name="$name" --project-type=wordpress --performance-mode=none \
    --additional-fqdns="$live"
  ddev start -y
elif ! grep -qF "$live" .ddev/config.yaml; then
  # An older build named Live differently: give ddev's router and certificate
  # the current name, which needs a restart of this project.
  ddev config --additional-fqdns="$live"
  ddev restart
else
  ddev start -y
fi
[ -f wp-includes/version.php ] || ddev wp core download --version="$version"
# Ours, not ddev's: it picks Local or Live by address (see site/wp-config.php).
cp "$src/site/wp-config.php" wp-config.php
cp "$src/site/wp-cli.yml" wp-cli.yml
cp "$src/site/README.md" README.md
[ -f .gitignore ] || cp "$src/site/gitignore" .gitignore
local pass; pass="$(admin_password "$site")"

step "WordPress: install"
if ddev wp core is-installed 2>/dev/null; then
  echo "  · already installed"
  ddev wp user update admin --user_pass="$pass" --skip-email --quiet
else
  ddev wp core install --url="https://$name.ddev.site" --title=Fieldnotes \
    --admin_user=admin --admin_password="$pass" --admin_email=admin@fieldnotes.example --skip-email
fi

step "WordPress: the fieldnotes theme and the fieldnotes-trails plugin"
rsync -a --delete --exclude assets/fonts "$src/theme/fieldnotes/" wp-content/themes/fieldnotes/
# The fonts are Twenty Twenty-Five's own (SIL Open Font License), copied so
# the child theme carries what it uses. wp-cli's tar extraction can cut long
# file names short (Vollkorn-Italic-VariableFont_wght, no .woff2), so each is
# found by its stem and copied under its full name.
mkdir -p wp-content/themes/fieldnotes/assets/fonts
local font file
for font in literata/Literata72pt-{Light,LightItalic,Regular,RegularItalic,Medium} manrope/Manrope-VariableFont_wght \
  fira-code/FiraCode-VariableFont_wght vollkorn/Vollkorn-{,Italic-}VariableFont_wght fira-sans/FiraSans-{Regular,Italic,Medium,SemiBold}; do
  file="$(ls "$parent_fonts/$font"* | head -n 1)"
  cp "$file" "wp-content/themes/fieldnotes/assets/fonts/$(basename "$font").woff2"
done
rsync -a --delete "$src/plugin/fieldnotes-trails/" wp-content/plugins/fieldnotes-trails/
ddev wp theme activate fieldnotes --quiet
ddev wp plugin activate fieldnotes-trails --quiet
# Only what the site uses: no sample plugins, no older default themes.
ddev wp plugin delete akismet hello --quiet 2>/dev/null || true
ddev wp theme delete twentytwentythree twentytwentyfour --quiet 2>/dev/null || true

step "WordPress: pictures"
stage "$site" wordpress/seed
draw_images "$site" fieldnotes

step "WordPress: settings, people, pictures, posts, trails, pages, menus, comments"
ddev wp eval-file .demo-build/seed/seed.php
ddev wp rewrite flush --quiet
ddev wp cache flush --quiet

step "WordPress: the Live stand-in at https://$live"
# A copy of the local database, moved to Live's address, with a few things
# Live has not caught up with (seed/live.php).
ddev exec "mysql -uroot -proot -hdb -e 'DROP DATABASE IF EXISTS live; CREATE DATABASE live; GRANT ALL ON live.* TO \"db\"@\"%\";' && mysqldump -uroot -proot -hdb --single-transaction db | mysql -uroot -proot -hdb live"
ddev wp @live search-replace "https://$name.ddev.site" "https://$live" --all-tables --skip-columns=guid --quiet
ddev wp @live eval-file .demo-build/seed/live.php
ddev wp @live cache flush --quiet

git_init "$site" "Fieldnotes, the Wanigan demo field journal" "Fieldnotes Demo" "demo@fieldnotes.example"
rm -rf "$site/.demo-build"
WORDPRESS_DONE="https://$name.ddev.site  (admin / $pass)  Live stand-in: https://$live"
