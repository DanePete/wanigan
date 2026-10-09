/**
 * @file
 * The header: the mega menu's panels (click or Enter on a chevron, hover on
 * a wide screen, Escape to close), the phone menu, and a hairline under
 * the header once the page has scrolled.
 */
((Drupal, once) => {
  const wide = () => window.matchMedia('(min-width: 64.01rem)').matches;

  Drupal.behaviors.northstarNav = {
    attach(context) {
      once('northstar-header', '[data-site-header]', context).forEach((header) => {
        const toggle = header.querySelector('.site-header__toggle');
        const items = [...header.querySelectorAll('.mega__item--parent')];

        const close = (except) => items.forEach((item) => {
          if (item !== except) {
            item.classList.remove('is-open');
            item.querySelector('.mega__toggle')?.setAttribute('aria-expanded', 'false');
          }
        });
        const open = (item) => {
          close(item);
          item.classList.add('is-open');
          item.querySelector('.mega__toggle').setAttribute('aria-expanded', 'true');
        };

        items.forEach((item) => {
          const button = item.querySelector('.mega__toggle');
          let timer;
          button.addEventListener('click', () => (item.classList.contains('is-open') ? close() : open(item)));
          item.addEventListener('mouseenter', () => { if (wide()) { clearTimeout(timer); open(item); } });
          item.addEventListener('mouseleave', () => { if (wide()) { timer = setTimeout(() => close(), 160); } });
        });

        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') {
            return;
          }
          const current = items.find((item) => item.classList.contains('is-open'));
          if (current) {
            close();
            current.querySelector('.mega__toggle').focus();
          }
          else if (header.classList.contains('is-open')) {
            toggle.click();
            toggle.focus();
          }
        });
        document.addEventListener('click', (event) => { if (!header.contains(event.target)) { close(); } });

        toggle.addEventListener('click', () => {
          const isOpen = toggle.getAttribute('aria-expanded') !== 'true';
          toggle.setAttribute('aria-expanded', String(isOpen));
          header.classList.toggle('is-open', isOpen);
          document.documentElement.classList.toggle('has-open-menu', isOpen);
        });

        const mark = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
        window.addEventListener('scroll', mark, { passive: true });
        mark();
      });
    },
  };
})(Drupal, once);
