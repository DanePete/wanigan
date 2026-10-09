<?php

/**
 * @file
 * Northstar's plain pages. "history" lists earlier revisions, oldest first,
 * saved before the current text when the page is first made.
 */

return [
  'about' => [
    'title' => 'About Northstar',
    'body' => <<<'HTML'
<p>Northstar is a small workshop on the shore of a lake that is not on any map. We make goods for long days outside, a few at a time.</p>
<h2>How we work</h2>
<p>Everything starts as a sketch in a field journal and spends a season being used before it goes in the shop. Mugs go on the dock rail, bags go in the canoe, prints get checked against the water.</p>
<p>We keep runs short so we can change things: a wider handle, a deeper cuff, a lake line that was wrong.</p>
<h2>Who we are</h2>
<p>Dana draws the maps and tests the mugs. Sam sews the bags and answers the email. Mika keeps the stock, the books and the stove going. All three of us would rather be outside, which is why the workshop closes at four.</p>
<p><em>Northstar is made up for Wanigan's demo: the people, the lake and the shop. Nothing here is for sale.</em></p>
HTML,
    'history' => [
      ['dana', 'First version of the about page', '<p>Northstar is a small workshop by a lake. We make goods for being outside.</p>'],
      ['sam', 'Sam: added how we work', '<p>Northstar is a small workshop by a lake. We make goods for being outside.</p><h2>How we work</h2><p>Everything spends a season being used before it goes in the shop.</p>'],
    ],
    'fr' => [
      'title' => 'À propos de Northstar',
      'body' => '<p>Northstar est un petit atelier au bord d’un lac qui ne figure sur aucune carte. Nous fabriquons, en petites séries, des objets pour les longues journées dehors.</p><h2>Notre façon de travailler</h2><p>Tout commence par un croquis dans un carnet de terrain et passe une saison à servir avant d’arriver en boutique.</p><p><em>Northstar est inventé pour la démo de Wanigan : rien n’est à vendre.</em></p>',
    ],
  ],
  'shipping' => [
    'title' => 'Shipping & returns',
    'body' => <<<'HTML'
<p>Orders over $75 ship free. Under that, shipping is a flat $6.</p>
<h2>When it arrives</h2>
<p>We pack orders on Thursdays and Fridays. Most arrive within a week; prints ship flat between boards and can take a day longer.</p>
<h2>Returns</h2>
<p>If something is not right, send it back within a season (ninety days) for a refund or an exchange. Used is fine: we would rather know why it did not work.</p>
HTML,
    'fr' => [
      'title' => 'Livraison et retours',
      'body' => '<p>Livraison offerte dès 75 $. En dessous, forfait de 6 $.</p><h2>Retours</h2><p>Si quelque chose ne va pas, renvoyez-le dans la saison (quatre-vingt-dix jours) pour un remboursement ou un échange.</p>',
    ],
  ],
  'care' => [
    'title' => 'Care guide',
    'body' => <<<'HTML'
<p>Most of what we make gets better with use, as long as it is looked after a little.</p>
<h2>Enamel</h2>
<p>Dishwasher safe. A chip on the rim is cosmetic; a chip inside the cup means it is time to retire it to the pencil pot.</p>
<h2>Waxed canvas</h2>
<p>Brush and wipe with cold water. Re-wax once a year. Never machine wash.</p>
<h2>Wool</h2>
<p>Air it outside after a trip. Hand wash cold when it needs it, and dry flat away from the stove.</p>
HTML,
  ],
];
