/**
 * @file
 * Gallery: shows one picture at a time and builds a thumbnail button for
 * each, from the picture's own image (the browser picks a small source).
 */
((Drupal, once) => {
  Drupal.behaviors.northstarGallery = {
    attach(context) {
      once('northstar-gallery', '[data-gallery]', context).forEach((gallery) => {
        const items = [...gallery.querySelectorAll('.gallery__item')];
        const thumbs = gallery.querySelector('.gallery__thumbs');
        if (items.length < 2 || !thumbs) {
          return;
        }
        const buttons = items.map((item, i) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'gallery__thumb';
          button.setAttribute('aria-label', Drupal.t('Show picture @n', { '@n': i + 1 }));
          const source = item.querySelector('img');
          if (source) {
            const img = document.createElement('img');
            img.src = source.currentSrc || source.src;
            if (source.srcset) {
              img.srcset = source.srcset;
              img.sizes = '80px';
            }
            img.alt = '';
            img.loading = 'lazy';
            button.append(img);
          }
          button.addEventListener('click', () => show(i));
          thumbs.append(button);
          return button;
        });
        const show = (index) => {
          items.forEach((item, i) => item.classList.toggle('is-active', i === index));
          buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
        };
        gallery.classList.add('is-ready');
        thumbs.hidden = false;
        show(0);
      });
    },
  };
})(Drupal, once);
