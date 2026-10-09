<?php
/**
 * The pages. Home and the Almanac are built from the theme's registered
 * patterns, expanded into blocks as the editor does when one is inserted;
 * the rest are written here. key => fields.
 */

return array(

	'home'           => array(
		'title'    => 'Home',
		'slug'     => 'home',
		'order'    => 0,
		'template' => '',
		'content'  => static fn () => fn_expand(
			pattern( 'fieldnotes/hero-journal' )
			. pattern( 'fieldnotes/latest-notes' )
			. pattern( 'fieldnotes/trail-finder-section' )
			. pattern( 'fieldnotes/essay-feature' )
			. pattern( 'fieldnotes/weather-strip' )
			. pattern( 'fieldnotes/season-figures-section' )
		) . group( synced( 'field-letter' ), array( 'tagName' => 'section', 'align' => 'full', 'className' => 'fn-letter-band', 'name' => 'Field letter' ) ),
	),

	'journal'        => array(
		'title'    => 'Journal',
		'slug'     => 'journal',
		'order'    => 1,
		'template' => '',
		'content'  => static fn () => '',
	),

	'almanac'        => array(
		'title'    => 'The Almanac',
		'slug'     => 'almanac',
		'order'    => 2,
		'template' => 'page-landing',
		'excerpt'  => 'A year in the lake country, bound to lie flat: fourteen route maps, fifty-two weeks of weather pages, kit lists by season and room for your own notes.',
		'content'  => static fn () => fn_expand(
			pattern( 'fieldnotes/almanac-hero' )
			. pattern( 'fieldnotes/almanac-contents' )
			. pattern( 'fieldnotes/almanac-spread' )
			. pattern( 'fieldnotes/almanac-quotes' )
			. pattern( 'fieldnotes/almanac-faq' )
			. pattern( 'fieldnotes/almanac-order' )
		),
	),

	'about'          => array(
		'title'    => 'About',
		'slug'     => 'about',
		'order'    => 3,
		'template' => '',
		'picture'  => 'camp-morning',
		'content'  => static fn () =>
			p( 'Fieldnotes is kept by two people, a cabin on Tamarack Lake, and thirty-one notebooks with pencil marks in the margins. We started it in the spring of 2019 to keep a record of the weather, and it grew, as these things do, to take in the trails we walk, the kit we carry and, now and then, an essay when something will not fit in a table.', array( 'className' => 'fn-standfirst', 'fontSize' => 'large' ) )
			. columns(
				array(
					array( '50%', h( 2, 'Maren Holt', array( 'fontSize' => 'x-large' ) ) . p( 'Keeps the weather log and walks most of the trails twice, once to learn them and once to write them up. Trained as a surveyor, which explains the tables. Will stop on any trail for a lichen.', array( 'textColor' => 'muted' ) ) ),
					array( '50%', h( 2, 'Jonah Reyes', array( 'fontSize' => 'x-large' ) ) . p( 'Draws the maps, mends the kit, and writes the essays when the weather keeps us in. Has paddled every lake in the region at least once and capsized in two of them.', array( 'textColor' => 'muted' ) ) ),
				),
				array( 'align' => 'wide' )
			)
			. h( 2, 'How we work' )
			. items(
				array(
					'<strong>We write it down there.</strong> Every entry starts as a page in a notebook, written on the trail, not afterwards.',
					'<strong>We say what we measured.</strong> Temperatures come from a thermometer, distances from walking them. When we guess, we say so.',
					'<strong>We go back.</strong> Every trail on the site has been walked at least twice, in the season we recommend.',
					'<strong>We take nothing for it.</strong> No advertising, no gear sent to us to try, no links that pay.',
				),
				array( 'ordered' => true )
			)
			. dynamic( 'fieldnotes/season-figures', array( 'align' => 'wide' ) )
			. pullquote( 'Write down what you saw, when you saw it, and what measured it. Everything else is weather.', 'The first page of the first notebook' )
			. p( 'The site itself is described in the <a href="' . fn_link( 'page', 'about/colophon' ) . '">colophon</a>. To write to us, see <a href="' . fn_link( 'page', 'contact' ) . '">Contact</a>.' ),
	),

	'colophon'       => array(
		'title'    => 'Colophon',
		'slug'     => 'colophon',
		'parent'   => 'about',
		'order'    => 4,
		'template' => '',
		'content'  => static fn () =>
			p( 'How this site is made, and the small print.', array( 'className' => 'fn-standfirst', 'fontSize' => 'large' ) )
			. h( 2, 'Type' )
			. table(
				array( 'Face', 'Used for', 'Licence' ),
				array(
					array( 'Literata', 'Titles, standfirsts and figures', 'SIL Open Font License' ),
					array( 'Manrope', 'Reading text and the interface', 'SIL Open Font License' ),
					array( 'Fira Code', 'Dates, labels and every number in a table', 'SIL Open Font License' ),
				),
				'All three are served from this site; nothing is fetched from elsewhere.'
			)
			. h( 2, 'Pictures' )
			. p( 'The plates, maps, kit pictures and weather charts are drawn by a short program from a fixed set of inks: the same few colours as the site itself. Nothing is photographed, and every picture can be drawn again, identically, from its name.' )
			. h( 2, 'Built with' )
			. items(
				array(
					'WordPress, with a block theme of our own built on Twenty Twenty-Five',
					'A small plugin for the trails, their facts and the trail finder',
					'Patterns, synced patterns, block bindings and the Interactivity API, all from WordPress itself',
				)
			)
			. group(
				p( 'Fieldnotes is a demonstration site. The lake country, its trails, the people who write here and the readers who comment are all invented, and so is every reading in the weather log. Any resemblance to a real place is a coincidence of names.', array( 'fontSize' => 'small' ) ),
				array(
					'className' => 'is-style-card fn-pad',
					'name'      => 'A note on what is real',
					'layout'    => array( 'type' => 'default' ),
				)
			),
	),

	'gear-checklist' => array(
		'title'    => 'Gear checklist',
		'slug'     => 'gear-checklist',
		'order'    => 5,
		'template' => '',
		'picture'  => 'kit-day',
		'content'  => static fn () =>
			p( 'What we carry, by season. Ticked items go on every walk; the rest depend on the day. Weights are what our own things weigh on the kitchen scale.', array( 'className' => 'fn-standfirst', 'fontSize' => 'large' ) )
			. columns(
				array(
					array(
						'',
						h( 2, 'Always', array( 'fontSize' => 'x-large' ) )
						. items(
							array(
								'<strong>Map and compass</strong> <em>Paper, in a zip bag. 98 g.</em>',
								'<strong>Notebook and pencil</strong> <em>Waterproof paper. 95 g.</em>',
								'<strong>Headlamp</strong> <em>Fresh batteries. 82 g.</em>',
								'<strong>Water and a filter</strong> <em>A litre each. 1,120 g.</em>',
								'<strong>Rain shell</strong> <em>310 g.</em>',
								'<strong>First-aid pouch</strong> <em>180 g.</em>',
								'<strong>Whistle</strong> <em>9 g.</em>',
							),
							array( 'className' => 'is-style-checklist' )
						),
					),
					array(
						'',
						h( 2, 'Above the trees', array( 'fontSize' => 'x-large' ) )
						. items(
							array(
								'Warm layer <em>Thin wool. 240 g.</em>',
								'Wind shirt <em>For the open ridge. 95 g.</em>',
								'Sun hat and cream <em>There is no shade on the crest. 120 g.</em>',
								'Spare food <em>More than you think. 300 g.</em>',
								'Sit mat <em>Rock is cold, even in July. 60 g.</em>',
							),
							array( 'className' => 'is-style-checklist' )
						),
					),
					array(
						'',
						h( 2, 'Cold months', array( 'fontSize' => 'x-large' ) )
						. items(
							array(
								'Insulated jacket <em>420 g.</em>',
								'Hat, gloves, spare gloves <em>The spares are the point. 210 g.</em>',
								'Thermos <em>Filled to the top. 650 g.</em>',
								'Microspikes <em>For Lookout Spur and the slabs. 390 g.</em>',
								'Ice picks and throw rope <em>On the lake only. 520 g.</em>',
							),
							array( 'className' => 'is-style-checklist' )
						),
					),
				),
				array( 'align' => 'wide' )
			)
			. img( 'kit-winter', 'The winter kit, before the first walk on the ice.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. h( 2, 'What it adds up to' )
			. table(
				array( 'Kit', 'Items', 'Grams' ),
				array(
					array( 'Always', '7', '1,894' ),
					array( 'Above the trees', '5', '815' ),
					array( 'Cold months', '5', '2,190' ),
				),
				'Before food and water for the day, which outweigh everything else on a long walk.',
				array( 'A winter day on the ridge', '17', '4,899' )
			)
			. h( 2, 'Why we carry what we carry' )
			. details( 'Why paper maps?', p( 'Because they do not run out of battery, they show the whole day at once, and they make you look at the ground. We carry a phone too, switched off.' ) )
			. details( 'Why spare gloves?', p( 'Because the first pair will get wet. Every winter, without fail, on the first day.' ) )
			. details( 'Why a whistle, when there is a phone?', p( 'There is no signal on half the trails on this site, and three blasts on a whistle carry further than a voice and need no battery.' ) )
			. details( 'What do you leave behind?', p( 'Anything we have not used on the last three walks, unless it is on the “Always” list. The pack is lighter every year.' ) )
			. fn_expand( pattern( 'fieldnotes/featured-trails' ) ),
	),

	'contact'        => array(
		'title'    => 'Write to us',
		'slug'     => 'contact',
		'order'    => 6,
		'template' => '',
		'content'  => static fn () =>
			p( 'We read everything and answer most of it, usually on a wet evening. Corrections are especially welcome: if a trail has changed since we walked it, we would rather hear it from you than find out from a reader who turned back.', array( 'className' => 'fn-standfirst', 'fontSize' => 'large' ) )
			. columns(
				array(
					array( '', h( 3, 'Letters' ) . p( '<a href="mailto:hello@fieldnotes.example">hello@fieldnotes.example</a>', array( 'fontSize' => 'large' ) ) . p( 'For anything at all. We answer within a week, or two in October.', array( 'textColor' => 'muted', 'fontSize' => 'small' ) ) ),
					array( '', h( 3, 'Trail reports' ) . p( 'Leave a note on the trail’s own page.', array( 'fontSize' => 'large' ) ) . p( 'It helps the next person more than an email to us. We add the useful ones to the conditions log.', array( 'textColor' => 'muted', 'fontSize' => 'small' ) ) ),
					array( '', h( 3, 'By post' ) . p( 'Fieldnotes, Box 7, Tamarack Lake', array( 'fontSize' => 'large' ) ) . p( 'Pressed leaves and old maps gratefully received.', array( 'textColor' => 'muted', 'fontSize' => 'small' ) ) ),
				),
				array( 'align' => 'wide' )
			)
			. img( 'map-region', 'Plate 00 — Where we are: the lake country, and the eight trails on this site.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. h( 2, 'Before you write' )
			. details( 'Can we use your trail notes or maps?', p( 'For a club newsletter or a school, yes, with a line saying where they came from. For anything you sell, ask first.' ) )
			. details( 'Will you review my gear?', p( 'No. We buy our own kit and write only about what we have carried for at least a season.' ) )
			. details( 'Can you recommend a guide?', p( 'We are not guides and do not recommend any. The trail pages say what we found; the decision to go is yours.' ) ),
	),
);
