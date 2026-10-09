<?php

/**
 * @file
 * The front page: its introduction and the reusable blocks in its layout,
 * in English and French.
 */

return [
  'title' => 'Home',
  'intro' => <<<'HTML'
<h2>Made slowly, near the lake</h2>
<p>Every piece spends a season outside before it reaches the shop: mugs on the dock rail, bags in the canoe, prints checked against the water they show.</p>
<p>We keep runs short, so when a handle is too narrow or a lake line is wrong, the next batch is better.</p>
HTML,
  'hero' => [
    'kicker' => 'New for autumn',
    'heading' => 'Gear for the long way round',
    'text' => 'Enamel mugs, waxed caps and lake maps drawn by hand, made a few at a time for mornings by the water.',
    'cta' => 'Shop the collection',
    'image' => 'hero-lake.jpg',
    'alt' => 'A canoe on a misty lake at dawn, pines on the far shore',
  ],
  'features' => [
    ['icon' => 'mountain', 'heading' => 'Tested outside', 'text' => 'Every piece spends a season on the dock, in the canoe and at the bottom of a pack before it reaches the shop.'],
    ['icon' => 'compass', 'heading' => 'Drawn by hand', 'text' => 'Our maps start as pencil on a kitchen table and get checked against the water with a weighted line.'],
    ['icon' => 'wave', 'heading' => 'Returns for a season', 'text' => 'Ninety days to change your mind, used or not. We would rather know why something did not work.'],
  ],
  'callout' => [
    'heading' => 'Free shipping over $75',
    'text' => 'And free returns for a whole season, used or not.',
    'cta' => 'Shipping details',
  ],
  'fr' => [
    'title' => 'Accueil',
    'intro' => '<h2>Fabriqué lentement, près du lac</h2><p>Chaque pièce passe une saison dehors avant d’arriver en boutique : les tasses sur la rambarde du ponton, les sacs dans le canoë, les cartes vérifiées sur l’eau qu’elles montrent.</p>',
    'hero' => ['kicker' => 'Nouveau cet automne', 'heading' => 'L’équipement du long chemin', 'text' => 'Tasses émaillées, casquettes cirées et cartes de lacs dessinées à la main, fabriquées en petites séries pour les matins au bord de l’eau.', 'cta' => 'Voir la collection'],
    'features' => [
      ['heading' => 'Testé dehors', 'text' => 'Chaque pièce passe une saison sur le ponton, dans le canoë et au fond d’un sac avant d’arriver en boutique.'],
      ['heading' => 'Dessiné à la main', 'text' => 'Nos cartes commencent au crayon sur une table de cuisine et sont vérifiées sur l’eau.'],
      ['heading' => 'Retours pendant une saison', 'text' => 'Quatre-vingt-dix jours pour changer d’avis, même après usage.'],
    ],
    'callout' => ['heading' => 'Livraison offerte dès 75 $', 'text' => 'Et retours gratuits pendant toute une saison.', 'cta' => 'Livraison et retours'],
  ],
];
