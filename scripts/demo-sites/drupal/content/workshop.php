<?php

/**
 * @file
 * The Workshop: a landing page built only in Layout Builder, from inline
 * blocks and field blocks, in one-, two- and three-column sections.
 */

return [
  'title' => 'The workshop',
  'intro' => <<<'HTML'
<p>The workshop is a long, low shed on the north shore with a stove at one end and a sewing table at the other. Everything in the shop is made, tested or packed here.</p>
<p>It is open Thursday to Saturday, ten until four, and on the open days below.</p>
HTML,
  'hero' => [
    'kicker' => 'Visit us',
    'heading' => 'Where the goods are made',
    'text' => 'A shed on the north shore, a stove, two sewing machines and a dock to test things on.',
    'cta' => 'See the open days',
    'image' => 'workshop-hero.jpg',
    'alt' => 'Autumn hills and a misty lake with birds in the sky',
  ],
  'media_text' => [
    'heading' => 'A season on the dock',
    'text' => 'Before anything goes in the shop it gets used every day for a season: mugs on the rail, bags in the canoe, prints on the wall by the stove. What survives, we make a few more of.',
    'cta' => 'Read how we test',
    'image' => 'about-workshop.jpg',
    'alt' => 'A misty lake at dusk under a violet sky',
  ],
  'stats' => [
    ['number' => '16', 'label' => 'things in the shop', 'text' => 'Few enough to know each one well.'],
    ['number' => '90', 'label' => 'days to return', 'text' => 'Used or not, for a full season.'],
    ['number' => '1', 'label' => 'lake we test on', 'text' => 'Silverpine, which is also made up.'],
  ],
  'faq' => [
    ['q' => 'Can I visit without booking?', 'a' => '<p>Yes, on any open day and from Thursday to Saturday, ten until four. Evenings need a note so we have enough chairs.</p>'],
    ['q' => 'Do you mend things you made?', 'a' => '<p>Always. Send it back with a note about what happened; most repairs are free.</p>'],
    ['q' => 'Can I buy seconds?', 'a' => '<p>On open days there is a table of seconds at half price: a speckle in the wrong place, a print with a smudge.</p>'],
    ['q' => 'Is the lake real?', 'a' => '<p>No. Silverpine, the workshop and everyone in it are made up for Wanigan\'s demo.</p>'],
  ],
  'quote' => [
    'text' => 'We would rather make sixteen things well than sixty things we have never carried across a portage.',
    'cite' => 'Dana Reyes, who draws the maps',
  ],
];
