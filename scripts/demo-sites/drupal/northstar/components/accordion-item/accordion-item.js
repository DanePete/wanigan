/**
 * @file
 * Opens and closes a question smoothly. The browser keeps one question of
 * an accordion open (details with the same name); this only animates it,
 * and not at all for people who ask for less motion.
 */
((Drupal, once) => {
  const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  Drupal.behaviors.northstarAccordion = {
    attach(context) {
      once('northstar-accordion', '.accordion-item', context).forEach((item) => {
        const summary = item.querySelector('summary');
        const answer = item.querySelector('.accordion-item__answer');
        summary.addEventListener('click', (event) => {
          if (still() || !answer.animate) {
            return;
          }
          event.preventDefault();
          if (item.open) {
            const close = answer.animate([{ height: `${answer.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 220, easing: 'ease-out' });
            close.onfinish = () => { item.open = false; };
          }
          else {
            item.open = true;
            answer.animate([{ height: '0px', opacity: 0 }, { height: `${answer.offsetHeight}px`, opacity: 1 }], { duration: 260, easing: 'ease-out' });
          }
        });
      });
    },
  };
})(Drupal, once);
