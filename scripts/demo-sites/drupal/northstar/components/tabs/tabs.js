/**
 * @file
 * Turns stacked panels into tabs: click or arrow keys to move, Home and End
 * for the ends, as the ARIA authoring practices describe.
 */
((Drupal, once) => {
  Drupal.behaviors.northstarTabs = {
    attach(context) {
      once('northstar-tabs', '[data-tabs]', context).forEach((root) => {
        const list = root.querySelector('[role="tablist"]');
        const tabs = [...list.querySelectorAll('[role="tab"]')];
        const panels = tabs.map((tab) => root.querySelector(`#${CSS.escape(tab.getAttribute('aria-controls'))}`));
        if (panels.some((panel) => !panel)) {
          return;
        }
        const select = (index, focus) => {
          tabs.forEach((tab, i) => {
            const on = i === index;
            tab.setAttribute('aria-selected', String(on));
            tab.tabIndex = on ? 0 : -1;
            panels[i].hidden = !on;
          });
          if (focus) {
            tabs[index].focus();
          }
        };
        panels.forEach((panel, i) => {
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', tabs[i].id);
          panel.tabIndex = 0;
        });
        list.hidden = false;
        root.classList.add('is-ready');
        select(0, false);
        tabs.forEach((tab, i) => {
          tab.addEventListener('click', () => select(i, false));
          tab.addEventListener('keydown', (event) => {
            const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
            if (event.key in keys) {
              event.preventDefault();
              select((keys[event.key] + tabs.length) % tabs.length, true);
            }
          });
        });
      });
    },
  };
})(Drupal, once);
