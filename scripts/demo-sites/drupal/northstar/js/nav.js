/**
 * @file
 * Opens and closes the header's navigation on narrow screens.
 */
((Drupal, once) => {
  Drupal.behaviors.northstarNav = {
    attach(context) {
      once('northstar-nav', '.site-header__toggle', context).forEach((button) => {
        const header = button.closest('.site-header');
        button.addEventListener('click', () => {
          const open = button.getAttribute('aria-expanded') !== 'true';
          button.setAttribute('aria-expanded', String(open));
          header.classList.toggle('is-open', open);
        });
      });
    },
  };
})(Drupal, once);
