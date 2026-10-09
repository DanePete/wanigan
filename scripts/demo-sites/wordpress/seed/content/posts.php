<?php
/**
 * The journal: sixteen entries in four sections. key => fields; 'content' is
 * a closure so its pictures and synced patterns exist by the time it runs.
 * Every place, person and reading is invented.
 */

return array(

	'first-hard-frost'      => array(
		'slug'     => 'first-hard-frost-on-the-birch-trail',
		'title'    => 'The birch trail after the first hard frost',
		'date'     => '2026-10-04 08:12:00',
		'author'   => 'maren',
		'category' => 'trail-notes',
		'tags'     => array( 'frost', 'birch', 'autumn' ),
		'picture'  => 'birch-hollow',
		'sticky'   => true,
		'excerpt'  => 'Minus three at the Birch Hollow lot, every leaf on the path rimed white, and a loop we know by heart sounding completely different underfoot.',
		'content'  => static fn () =>
			p( 'The car said minus three when we pulled into the Birch Hollow lot at seven, and the thermometer clipped to my pack agreed within half a degree. It was the first real frost of the season: not the thin silver on the windscreen we had been scraping all week, but the kind that gets into the ground and stays there until noon.', array( 'dropCap' => true ) )
			. p( 'Birch Hollow is the loop we walk when we want to see what a season is doing. It is six and a half kilometres, it climbs about as much as a church tower, and it runs through the same stand of paper birch for most of its length, so changes show up against a steady background. This morning everything on the path was rimed white: the fallen leaves, the bracken, the boards over the wet ground by the beaver pond.' )
			. img( 'route-birch-hollow', 'Sheet 1 — The loop, walked clockwise from the lot: the climb first, the boardwalk last.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. h( 2, 'What changed overnight' )
			. p( 'Frost changes the sound of a trail more than its look. The leaves that had been soft and quiet on Wednesday cracked like paper. We could hear a red squirrel working on a cone thirty metres off, and the creek under the second footbridge, a murmur all summer, was suddenly the loudest thing in the valley. The air was that still.' )
			. items(
				array(
					'<strong>Ice on the beaver pond</strong>, a skin about two millimetres thick from the inflow to the first lodge.',
					'<strong>Needle ice</strong> lifting the bare soil on the north-facing switchback, in columns as long as a fingernail.',
					'<strong>Birch leaves</strong> mostly down: we guessed six in ten on the ground, up from perhaps a third last weekend.',
					'<strong>No mosquitoes.</strong> The first walk since May without them.',
				)
			)
			. pullquote( 'The creek under the second footbridge had been a murmur all summer. This morning it was the loudest thing in the valley.' )
			. h( 2, 'Underfoot' )
			. p( 'The boardwalk was the only real hazard. Frosted boards are slicker than they look, and we both did the short, flat-footed walk you learn on ice. Everywhere else the frozen ground was firmer and easier than it has been since August; the mud at the bottom of the hill had set hard, ruts and all.' )
			. p( 'By ten the sun had cleared the ridge and the frost went off the open ground in about twenty minutes, leaving the path dark and wet. In the shade of the birches it held on until we left at half past eleven.' )
			. quote( 'Bring a thermos. The bench at the top of the climb faces east, and on a frost morning it is the warmest place for a mile.', 'Maren’s notebook, 4 October', 'margin-note' )
			. details( 'Route notes', p( 'We walked the loop clockwise from the lot, which puts the climb early and the boardwalk last. The map, the facts and the latest conditions are on the <a href="' . fn_link( 'trail', 'birch-hollow-loop' ) . '">Birch Hollow Loop</a> page.' ) )
			. synced( 'field-letter' ),
	),

	'week-the-wind-changed' => array(
		'slug'     => 'weather-log-the-week-the-wind-changed',
		'title'    => 'Weather log: the week the wind changed',
		'date'     => '2026-09-27 19:40:00',
		'author'   => 'maren',
		'category' => 'weather-log',
		'tags'     => array( 'wind', 'rain' ),
		'picture'  => 'chart-wind-change',
		'excerpt'  => 'Seven days of readings from the cabin wall: a slow fall in pressure, one wet Thursday, and a northwest wind that arrived on Friday night and took ten degrees with it.',
		'content'  => static fn () =>
			p( 'This was the week autumn arrived properly, and it arrived on a wind. Monday and Tuesday were the tail of a warm September: still air, haze over Tamarack Lake, and the barometer drifting down so slowly that we did not notice until Wednesday.' )
			. table(
				array( 'Day', 'High °C', 'Low °C', 'Wind', 'hPa', 'Sky', 'Notes' ),
				array(
					array( 'Mon 21', '19.4', '8.1', 'Calm', '1019', 'Haze', 'Warm and still; the lake like glass at six' ),
					array( 'Tue 22', '20.2', '9.0', 'S 2', '1016', 'High cloud', 'Mares’ tails from the southwest by evening' ),
					array( 'Wed 23', '17.8', '10.6', 'S 3', '1010', 'Overcast', 'Pressure falling steadily all day' ),
					array( 'Thu 24', '13.1', '10.2', 'SE 4', '1003', 'Rain', '14 mm in the gauge by six; steady, never heavy' ),
					array( 'Fri 25', '12.4', '7.7', 'NW 5', '1006', 'Clearing late', 'Wind swung northwest after dark and the glass jumped' ),
					array( 'Sat 26', '9.6', '2.3', 'NW 4', '1018', 'Clear, gusty', 'Whitecaps on the lake all day' ),
					array( 'Sun 27', '10.9', '0.8', 'NW 2', '1024', 'Clear', 'First ground frost below the cabin, gone by nine' ),
				),
				'Readings at 18:00 from the north wall of the cabin. Wind by Beaufort force, judged from the end of the dock.',
				array( 'Week', '20.2', '0.8', '—', '1003–1024', '—', '14 mm of rain' )
			)
			. h( 2, 'Reading the week' )
			. p( 'The story is all in the pressure column. A fall of sixteen hectopascals over three days is slow by storm standards, and the rain it brought on Thursday was the patient, all-day kind rather than a front’s downpour. The change came on Friday night: the wind backed through the south, went quiet for an hour around ten, then came in from the northwest and stayed.' )
			. p( 'By Saturday the air had a different texture. Dry, sharp, the far shore suddenly in focus. Pressure rose eighteen hectopascals in two days, and Sunday’s low of 0.8 °C put the first frost on the grass below the cabin.' )
			. quote( 'Northwest wind after rain: clear, cold, and two days of whitecaps. It has been true every autumn we have kept the log.', 'Inside cover of the 2021 log', 'margin-note' )
			. synced( 'weather-method' ),
	),

	'cedar-river-low-water' => array(
		'slug'     => 'crossing-the-cedar-river-at-low-water',
		'title'    => 'Crossing the Cedar River at low water',
		'date'     => '2026-09-12 17:05:00',
		'author'   => 'jonah',
		'category' => 'trail-notes',
		'tags'     => array( 'river', 'summer' ),
		'picture'  => 'river-ford',
		'excerpt'  => 'After six dry weeks the Cedar River ford was knee-deep at its worst, and stepping stones we had only ever seen as ripples stood clear of the water.',
		'content'  => static fn () =>
			p( 'The Cedar River ford is the reason most people turn back on the valley route. In spring it runs waist-deep and fast enough to knock you over; even in an ordinary August it is a cold, slippery crossing on stones you cannot see. This year, after six weeks with barely any rain, we found it at the lowest we have recorded.', array( 'dropCap' => true ) )
			. gallery(
				array(
					array( 'gallery-shore', 'The bar downstream, dry for the first time' ),
					array( 'gallery-landing', 'Where the trail leaves the water' ),
					array( 'route-cedar-ford', 'The route, crossing at the riffle' ),
				),
				array(
					'columns' => 3,
					'align'   => 'wide',
					'caption' => 'Cedar River ford, 12 September. The water line on the far boulders sits about 60 cm above the river.',
				)
			)
			. h( 2, 'How deep, exactly' )
			. p( 'We measured with a walking pole marked in ten-centimetre bands. At the deepest point, just upstream of the big split boulder, the water came to 46 centimetres: knee height on me, a little above on Maren. Most of the crossing was under thirty. The current was gentle enough to stand still in, which is not something we have ever been able to say here.' )
			. columns(
				array(
					array( '50%', h( 3, 'What worked' ) . items( array( 'Crossing at the wide, shallow riffle rather than on the marked line', 'Both poles, planted upstream, moving one thing at a time', 'Old trail shoes we did not mind soaking, then dry socks on the far bank' ) ) ),
					array( '50%', h( 3, 'What did not' ) . items( array( 'The stepping stones: dry on top, green slime on every side', 'Rock-hopping to keep boots dry; one slip and it was all for nothing', 'Stopping mid-river for pictures. The water at the bottom is still only a few degrees above freezing' ) ) ),
				)
			)
			. p( 'The valley was strange in the low water. A gravel bar we had never seen stood clear for two hundred metres downstream, tracked over by herons and at least one mink, and the pools below the ford were so clear we could count the trout holding in the shade of the cut bank.' )
			. quote( 'A low river shows you the floor of the valley, and the floor tells you what the spring floods did. There is a new channel on the inside of the bend, and a whole cedar wedged across the old one.', 'Jonah, back at the car' )
			. details( 'Before you go', p( 'Low water like this does not last. A day of heavy rain upstream can lift the ford by half a metre in a few hours. Check the <a href="' . fn_link( 'trail', 'cedar-river-ford' ) . '">Cedar River Ford</a> page for the latest report, and if the water is over the top of the split boulder, turn back.' ) ),
	),

	'cold-night-clear-sky'  => array(
		'slug'     => 'a-cold-night-under-a-clear-sky',
		'title'    => 'Notes on a cold night under a clear sky',
		'date'     => '2026-08-30 21:15:00',
		'author'   => 'maren',
		'category' => 'essays',
		'tags'     => array( 'night', 'camp' ),
		'picture'  => 'night-meadow',
		'excerpt'  => 'It went down to minus four in the meadow, and the stars came out in an order we had never thought to notice.',
		'content'  => static fn () =>
			p( 'We had gone up to the meadow at the end of Old Quarry Road for the meteors, and we had brought the wrong sleeping bags. The forecast said four degrees. By midnight the thermometer hanging from the ridgeline of the tent read minus one, and by the time the sky began to grey it said minus four.', array( 'dropCap' => true ) )
			. p( 'I do not think either of us slept more than an hour, and I would not trade the night for a warm one. A cold, dry night sky is a different object from a summer one. The haze that sits over the valley in August had frozen out of the air, and the stars did not twinkle so much as stand still.' )
			. h( 2, 'The order of things' )
			. p( 'What struck me, lying with my head out of the tent door, was that the stars arrive in an order. Not all at once as the light goes, but one at a time and then in handfuls. The first was the bright one low in the west that turned out to be a planet. Then the brightest stars, each alone in its patch of sky. Then, within a quarter of an hour, the fainter ones in between, until the gaps I had been looking at were full.' )
			. p( 'Jonah timed it. From the first star to the moment we could see the Milky Way as a band rather than a suspicion took forty-seven minutes.' )
			. pullquote( 'From the first star to the moment we could see the Milky Way as a band rather than a suspicion took forty-seven minutes.' )
			. p( 'We counted nineteen meteors between eleven and two, most of them short and faint, three long enough to say something before they were gone. After two the cold won, and we lay in the bags with the door zipped, listening to frost form on the fly: a faint ticking, like a clock in another room.' )
			. img( 'camp-morning', 'Plate 31 — The meadow at first light. Every guy line had a stripe of frost on its upper side.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. sep( 'contour' )
			. p( 'In the morning the meadow was white, the water bottles had ice in their necks, and a pair of ravens went over discussing us. We packed the tent frozen and drove down to the café at Mill Pond with the heater on full, and I wrote most of this in the notebook while it thawed on my lap.' )
			. quote( 'Next time: the winter bags, a foam mat under the inflatable one, and the thermos filled to the top.', 'Packing list, revised', 'margin-note' ),
	),

	'ten-things-ridge'      => array(
		'slug'     => 'ten-things-for-a-day-on-the-ridge',
		'title'    => 'Ten things for a day on the ridge',
		'date'     => '2026-08-21 12:30:00',
		'author'   => 'jonah',
		'category' => 'gear',
		'tags'     => array( 'maps', 'navigation' ),
		'picture'  => 'kit-day',
		'excerpt'  => 'The kit that goes in the pack for every walk above the trees, whatever the forecast says, and the one thing we have argued about for years.',
		'content'  => static fn () =>
			p( 'A day on Basswood Ridge is not an expedition. You are never more than a few hours from a road. But the ridge is open, the weather comes in from the west faster than you can see it, and the walk out from the far end is long. So the same ten things go in the pack every time, and come out at the end of the day whether we used them or not.' )
			. img( 'route-basswood-ridge', 'Sheet 2 — The Basswood traverse, the walk this kit is packed for.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. h( 2, 'The list' )
			. items(
				array(
					'<strong>Map</strong> <em>The paper one, folded to the day’s route, in a zip bag.</em>',
					'<strong>Compass</strong> <em>A baseplate compass, and the habit of checking it before we are lost rather than after.</em>',
					'<strong>Notebook and pencil</strong> <em>Pencil, because pens freeze and run.</em>',
					'<strong>Headlamp</strong> <em>Fresh batteries, even in June. Days end earlier than plans do.</em>',
					'<strong>Water</strong> <em>A litre each, and a filter for the spring below the fire tower.</em>',
					'<strong>Rain shell</strong> <em>Hood up by the second hour, more often than not.</em>',
					'<strong>Warm layer</strong> <em>A thin wool jumper that weighs almost nothing.</em>',
					'<strong>Knife</strong> <em>Small and folding, mostly for cheese.</em>',
					'<strong>Whistle</strong> <em>Three blasts carry further than any shout.</em>',
					'<strong>First-aid pouch</strong> <em>Blister kit, tape, painkillers and a foil blanket.</em>',
				),
				array( 'className' => 'is-style-checklist' )
			)
			. h( 2, 'What it weighs' )
			. table(
				array( 'Item', 'Grams' ),
				array(
					array( 'Map, in its bag', '60' ),
					array( 'Compass', '38' ),
					array( 'Notebook and pencil', '95' ),
					array( 'Headlamp', '82' ),
					array( 'Water, one litre', '1,040' ),
					array( 'Rain shell', '310' ),
					array( 'Wool layer', '240' ),
					array( 'Knife', '54' ),
					array( 'Whistle', '9' ),
					array( 'First-aid pouch', '180' ),
				),
				'Weighed on the kitchen scale. The water is half of it, and the one thing you cannot leave behind.',
				array( 'Total', '2,108' )
			)
			. h( 2, 'The argument' )
			. p( 'The one thing we disagree about is the phone. Maren counts it as a second map; I count it as a battery that dies at the worst moment. We carry it, switched off, in the lid pocket, and it does not appear on the list.' )
			. buttons(
				array(
					array( 'The full gear checklist', fn_link( 'page', 'gear-checklist' ) ),
					array( 'Basswood Ridge Traverse', fn_link( 'trail', 'basswood-ridge-traverse' ), 'outline' ),
				)
			),
	),

	'fog-kettle-marsh'      => array(
		'slug'     => 'fog-on-kettle-marsh',
		'title'    => 'Fog on Kettle Marsh',
		'date'     => '2026-08-09 09:20:00',
		'author'   => 'maren',
		'category' => 'essays',
		'tags'     => array( 'marsh', 'fog' ),
		'picture'  => 'kettle-marsh',
		'excerpt'  => 'Twenty minutes on the boardwalk at dawn, in fog so thick the far end of each board disappeared, and every sound arriving from a direction it could not have come from.',
		'content'  => static fn () =>
			p( 'Kettle Marsh makes its own fog. On a still August morning after a cool night the water is warmer than the air above it, and by first light the whole basin is full to the brim, as if someone had poured milk into a bowl.', array( 'dropCap' => true ) )
			. p( 'I walked the boardwalk alone at a quarter past five. I could see perhaps fifteen metres. The boards ran out ahead of me into nothing, and the cattails on either side were grey shapes, then outlines, then gone.' )
			. p( 'Sound behaves strangely in fog. Everything seems closer and more muffled at once. A bittern was booming somewhere to the north, that deep, pumping note like someone blowing across a bottle, and a heron called from what I would have sworn was straight ahead, then flew up out of the reeds behind me.' )
			. pullquote( 'A heron called from what I would have sworn was straight ahead, then flew up out of the reeds behind me.' )
			. img( 'route-kettle-marsh', 'Sheet 4 — The boardwalk loop. The fog fills the basin up to about the 300 m contour.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. p( 'The fog lifted the way it always does there: not by thinning, but by rising. At ten to six there was a gap of clear air above the water, a metre deep and getting deeper, with the fog sitting on top of it like a ceiling. Then the sun found the top of the ceiling and it was gone in ten minutes, and it was only a marsh again, loud with red-winged blackbirds, the boards steaming.' )
			. p( 'I stayed until the last of it had burned off the far end, and walked back along boards that had been a road into nowhere an hour before.' ),
	),

	'first-snow'            => array(
		'slug'     => 'weather-log-first-snow',
		'title'    => 'Weather log: the first snow',
		'date'     => '2025-11-16 18:50:00',
		'author'   => 'maren',
		'category' => 'weather-log',
		'tags'     => array( 'snow', 'winter' ),
		'picture'  => 'chart-first-snow',
		'excerpt'  => 'The week the first snow came to stay: four days below freezing, eleven centimetres on Thursday night, and a high afterwards so clear the lake steamed at dawn.',
		'content'  => static fn () =>
			p( 'Every year we bet on the date of the first snow that stays. Jonah said the twentieth; I said the eighth. It came on the thirteenth, so nobody won, and it came the way first snow should: a grey, raw start to the week, a day that smelled of it, and then an afternoon of big, slow flakes that did not stop until after dark.' )
			. table(
				array( 'Day', 'High °C', 'Low °C', 'Wind', 'hPa', 'Sky', 'Notes' ),
				array(
					array( 'Mon 10', '2.1', '−3.4', 'NW 3', '1012', 'Overcast', 'Raw and grey; flurries at noon that did not settle' ),
					array( 'Tue 11', '0.6', '−5.2', 'N 2', '1015', 'Cloudy', 'Puddles frozen all day in the shade' ),
					array( 'Wed 12', '−0.8', '−6.0', 'NE 2', '1008', 'Darkening', 'Glass falling; the smell of snow by evening' ),
					array( 'Thu 13', '−1.5', '−4.4', 'E 3', '998', 'Snow', 'Began at two; 11 cm on the deck rail by ten' ),
					array( 'Fri 14', '−2.9', '−9.1', 'N 2', '1011', 'Clearing', 'Stopped before dawn; blue by noon' ),
					array( 'Sat 15', '−4.0', '−12.3', 'Calm', '1026', 'Clear', 'Lake steaming at sunrise; coldest night of the year so far' ),
					array( 'Sun 16', '−1.2', '−8.6', 'SW 1', '1029', 'Clear', 'Snow squeaking underfoot; first ski on the logging road' ),
				),
				'Readings at 18:00. Snow measured on the deck rail, which is the flattest thing we own.',
				array( 'Week', '2.1', '−12.3', '—', '998–1029', '—', '11 cm of snow' )
			)
			. img( 'first-snow', 'Plate 40 — Friday morning, the spruce behind the woodshed.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. h( 2, 'After the snow' )
			. p( 'The high that followed was the clearest air of the year. On Saturday the lake, not yet frozen, was warmer than the minus twelve above it, and at sunrise it steamed: thin columns of vapour standing up off the water and leaning south in the faintest breeze. By Sunday the snow squeaked underfoot, which in our experience means minus eight or colder, and the thermometer agreed.' )
			. synced( 'weather-method' ),
	),

	'sunrise-basswood'      => array(
		'slug'     => 'sunrise-from-basswood-ridge',
		'title'    => 'Sunrise from Basswood Ridge',
		'date'     => '2026-07-26 11:00:00',
		'author'   => 'jonah',
		'category' => 'trail-notes',
		'tags'     => array( 'sunrise', 'ridge' ),
		'picture'  => 'basswood-ridge',
		'excerpt'  => 'A 3:40 alarm, a headlamp climb through the spruce, and forty minutes on the ridge watching the valleys fill with light one at a time.',
		'content'  => static fn () =>
			p( 'The alarm went at twenty to four. There is no good way to describe getting up at that hour in July except that the birds are already awake and seem to think you are late.', array( 'dropCap' => true ) )
			. p( 'We climbed the north end of the ridge by headlamp, through spruce so dense the lamps lit a tunnel and nothing else. The trail is steep there for about a kilometre, roots and rock, and then it comes out of the trees all at once onto the bare spine of the ridge and the sky is suddenly the biggest thing there is.' )
			. table(
				array( 'Time', 'Where' ),
				array(
					array( '03:40', 'Alarm, in the cabin' ),
					array( '04:10', 'Left the North Basswood trailhead' ),
					array( '05:05', 'Out of the trees onto the ridge' ),
					array( '05:31', 'Sunrise, over the far end of Tamarack Lake' ),
					array( '06:15', 'Started back down' ),
					array( '07:50', 'Back at the car, and the first coffee' ),
				),
				'The morning, by the watch.'
			)
			. h( 2, 'The valleys, one at a time' )
			. p( 'The light did not arrive everywhere at once. The highest ridges to the east turned rose first, while the valleys between them were still full of blue shadow and mist. Then, valley by valley, the mist lit from above and began to move, sliding down towards the lake as the air warmed. It took about forty minutes from the first colour to full daylight, and neither of us said much.' )
			. img( 'lookout-spur', 'Plate 22 — The view south from the rock at Lookout Spur, on the way down.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. p( 'On the way down we took the short detour to the rock at Lookout Spur, which has the better view of the valley and the worse view of the sunrise. By then the mist had gone and it was simply a fine summer morning, the kind you could have had at nine.' )
			. details( 'If you go', p( 'Start early enough to be out of the trees fifteen minutes before sunrise; the colour comes before the sun does. A headlamp is essential for the climb. The <a href="' . fn_link( 'trail', 'basswood-ridge-traverse' ) . '">traverse</a> continues south along the ridge for another eleven kilometres if you have arranged a car at the far end.' ) ),
	),

	'reading-lake-ice'      => array(
		'slug'     => 'reading-lake-ice',
		'title'    => 'Reading lake ice',
		'date'     => '2026-02-14 16:45:00',
		'author'   => 'jonah',
		'category' => 'essays',
		'tags'     => array( 'ice', 'winter' ),
		'picture'  => 'tamarack-ice',
		'excerpt'  => 'What the colours, sounds and cracks of a frozen lake have taught us over six winters, and the one rule that overrides all of it.',
		'content'  => static fn () =>
			p( 'We have walked on Tamarack Lake every winter for six years, and we know less about ice than we thought we did after the first. This is what we look for. None of it replaces the rule at the end.', array( 'dropCap' => true ) )
			. h( 2, 'Colour' )
			. p( 'Ice tells you a little about itself by its colour, if you know what you are looking at.' )
			. table(
				array( 'Ice', 'What we take it to mean' ),
				array(
					array( 'Clear, black ice', 'New, hard ice: the strongest kind, if it is thick enough' ),
					array( 'White, opaque ice', 'Snow ice, full of air, and roughly half as strong' ),
					array( 'Grey, wet-looking ice', 'Water in it or on it. We stay off' ),
					array( 'Dark patches in white', 'Thin spots over springs and inflows' ),
				),
				'What the colour tells us. It is a first look, not a measurement.',
				null,
				''
			)
			. img( 'route-tamarack-ice', 'Sheet 5 — The ice route across Tamarack Lake. The narrows between the islands never freeze hard.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. h( 2, 'Sound' )
			. p( 'A frozen lake is noisy. On a cold, clear night the ice booms and pings and sends long whistling cracks from one shore to the other, a sound like a stretched wire being plucked. It is alarming the first time and almost always harmless: it is the ice contracting as it cools, and loud ice is usually cold, thick ice. The sound to worry about is the quiet, wet one underfoot.' )
			. h( 2, 'The rule' )
			. quote( 'We measure before we trust. A hole with the auger every fifty metres on a new line, and we turn back at anything under ten centimetres of clear ice.', 'The rule, written on the auger handle', 'margin-note' )
			. p( 'Everything above is how we decide where to drill. The drill decides whether we walk. We have turned back from lines we had walked a dozen times, because the hole said so, and we have never once regretted it.' )
			. details( 'What we carry on the ice', items( array( 'Ice picks on a cord round the neck, outside every layer', 'A long pole, carried crosswise', 'A throw rope in a bag', 'A full change of dry clothes, sealed in a dry bag' ) ) ),
	),

	'portage-loop-days'     => array(
		'slug'     => 'four-days-on-the-portage-loop',
		'title'    => 'Four days on the portage loop',
		'date'     => '2025-10-12 20:10:00',
		'author'   => 'maren',
		'category' => 'trail-notes',
		'tags'     => array( 'paddling', 'autumn', 'camp' ),
		'picture'  => 'portage-autumn',
		'excerpt'  => 'Two lakes, four portages, one wrong turn and a campsite with the best view of the tamaracks turning: a long weekend on the loop in the second week of October.',
		'content'  => static fn () =>
			p( 'The portage loop is the trip we do when the tamaracks turn. It joins Second Lake and Tamarack Lake by four carries through the forest, the longest a little over a kilometre, and in the second week of October the larches along every shore go the colour of a struck match.', array( 'dropCap' => true ) )
			. h( 3, 'Day one' )
			. p( 'Put in at the Second Lake launch at ten, into a light headwind. The first carry starts behind a boulder the size of a car and is easy to miss; we missed it, paddled half a kilometre into the wrong bay, and had lunch there to make it look deliberate.' )
			. h( 3, 'Day two' )
			. p( 'Two carries, both short, both muddy. The trail between them runs through old spruce, dark and quiet, and comes out at a landing where the whole of Tamarack Lake opens up gold on both sides. We took the campsite on the point and did nothing else all afternoon.' )
			. gallery(
				array(
					array( 'gallery-spruce', 'The carry through the old spruce' ),
					array( 'gallery-landing', 'The landing on Tamarack Lake' ),
					array( 'gallery-shore', 'The east shore, day three' ),
					array( 'gallery-evening', 'The point, last evening' ),
				),
				array(
					'columns' => 2,
					'align'   => 'wide',
				)
			)
			. h( 3, 'Day three' )
			. p( 'A day without moving camp. We paddled the east shore in the morning, counted fourteen loons gathering for the journey south, and walked the ridge behind the campsite in the afternoon. The night was cold enough for frost on the canoe.' )
			. h( 3, 'Day four' )
			. p( 'The long carry home, the canoe on Jonah’s shoulders and the two packs on mine, with a rest at the halfway rack. Back at the car by three, and already planning the dates for next year.' )
			. details( 'The route', p( 'Eleven kilometres of walking and paddling in all. The map and facts are on the <a href="' . fn_link( 'trail', 'portage-loop' ) . '">Portage Loop</a> page.' ) ),
	),

	'paddling-at-dusk'      => array(
		'slug'     => 'paddling-home-at-dusk',
		'title'    => 'Paddling home at dusk',
		'date'     => '2026-06-20 22:30:00',
		'author'   => 'jonah',
		'category' => 'essays',
		'tags'     => array( 'paddling', 'summer' ),
		'picture'  => 'dusk-paddle',
		'excerpt'  => 'The last hour on Second Lake, after the wind dropped, when the water was so still the paddle made the only sound for a mile.',
		'content'  => static fn () =>
			p( 'The wind had been in our faces all afternoon, and then, at about half past eight, it simply stopped. Not slowly. One moment we were digging in against a chop, and the next the lake went flat from shore to shore and the only sound was the water running off the paddle.', array( 'dropCap' => true ) )
			. p( 'We were still three kilometres from the launch. Neither of us suggested hurrying.' )
			. pullquote( 'The lake went flat from shore to shore, and the only sound was the water running off the paddle.' )
			. p( 'Dusk on still water is a lesson in how little light you need. The sky went from blue to a colour like the inside of a shell, and the lake held all of it, so that we seemed to be paddling across the sky rather than under it. The shores went black. A beaver crossed ahead of us, towing a branch, and slapped its tail once to tell us what it thought.' )
			. p( 'The last kilometre we did by the shape of the shoreline against the sky, and by the one light at the launch. The wake ran out behind us a long way, then closed.' ),
	),

	'rain-in-the-meadow'    => array(
		'slug'     => 'weather-log-three-days-of-rain',
		'title'    => 'Weather log: three days of rain in the meadow',
		'date'     => '2026-06-07 18:30:00',
		'author'   => 'maren',
		'category' => 'weather-log',
		'tags'     => array( 'rain' ),
		'picture'  => 'chart-meadow-rain',
		'excerpt'  => 'Fifty-one millimetres between Tuesday night and Friday morning, a barometer that hardly moved, and a meadow that turned into a lake and back in a week.',
		'content'  => static fn () =>
			p( 'It started on Tuesday night and did not stop until Friday morning: not a storm, just rain, steady and windless, coming straight down. The barometer sat at the bottom of its range all three days and barely twitched. The gauge on the dock fence filled twice.' )
			. table(
				array( 'Day', 'High °C', 'Low °C', 'Wind', 'hPa', 'Rain mm', 'Notes' ),
				array(
					array( 'Mon 1', '21.5', '11.2', 'SW 2', '1011', '0', 'Warm, close, thunder far off' ),
					array( 'Tue 2', '18.9', '12.4', 'S 2', '1004', '3', 'Rain from ten at night' ),
					array( 'Wed 3', '14.2', '11.8', 'Calm', '1001', '22', 'Rain all day, straight down' ),
					array( 'Thu 4', '13.6', '10.9', 'Calm', '1001', '19', 'Rain all day; the meadow pond joined the creek' ),
					array( 'Fri 5', '16.1', '9.4', 'NW 2', '1009', '7', 'Stopped at seven; sun by noon' ),
					array( 'Sat 6', '19.8', '8.2', 'NW 3', '1016', '0', 'Steaming fields, every frog in the county' ),
					array( 'Sun 7', '22.4', '9.9', 'W 2', '1019', '0', 'Dry; the meadow trail still under water at the low end' ),
				),
				'Readings at 18:00. Rain is the day’s total from the gauge on the dock fence.',
				array( 'Week', '22.4', '8.2', '—', '1001–1019', '51', '—' )
			)
			. img( 'meadow-rain', 'Plate 18 — The meadow on Thursday afternoon.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. p( 'By Thursday the low end of the meadow was a pond, then a lake, then part of the creek. On Saturday the sun came out on a landscape that hummed: every frog in the county seemed to be in that meadow, and the steam came off the fields until mid-morning.' )
			. synced( 'weather-method' ),
	),

	'mending-tent-pole'     => array(
		'slug'     => 'mending-a-tent-pole-in-the-field',
		'title'    => 'Mending a tent pole in the field',
		'date'     => '2026-05-17 15:20:00',
		'author'   => 'jonah',
		'category' => 'gear',
		'tags'     => array( 'repair', 'camp' ),
		'picture'  => 'kit-repair',
		'excerpt'  => 'A snapped pole section in the meadow, a repair sleeve that had ridden in the kit for four years unused, and the six steps that had the tent back up in ten minutes.',
		'content'  => static fn () =>
			p( 'The pole went with a crack like a dry stick, in a gust, as I was feeding it through the sleeve. One section split for about five centimetres at the ferrule end. It was getting dark, it was going to rain, and the tent was a heap of nylon on the grass.' )
			. img( 'night-meadow', 'Plate 33 — Night Sky Meadow, an hour after the repair. The tape held.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. h( 2, 'The repair' )
			. items(
				array(
					'Take the broken pole out of the tent entirely. Trying to fix it in place costs more time than it saves.',
					'Find the break and straighten it as far as it will go without forcing it.',
					'Slide the repair sleeve along the pole until it is centred over the break. Some poles need to be taken apart at a joint to do this.',
					'Tape both ends of the sleeve to the pole, tightly, three turns each.',
					'Put the pole back in, gently, and pitch the tent with the guy lines a little slacker than usual on that side.',
					'In the morning, check the tape. Ours had held through a night of wind.',
				),
				array( 'ordered' => true )
			)
			. quote( 'The repair sleeve weighs nine grams and had been in the kit, unused, since 2022. It is the best nine grams we carry.', 'The repair kit inventory', 'margin-note' )
			. h( 2, 'What lives in the repair kit' )
			. items( array( 'A pole repair sleeve, sized for the tent', 'A roll of tape, flattened to save space', 'Two metres of cord', 'A needle and strong thread on a card', 'A spare buckle', 'Self-adhesive patches for the fly and the mats' ) )
			. details( 'When the sleeve is not enough', p( 'A tent stake laid along the break and taped at both ends will do the same job, more clumsily. So will a straight stick. The point is to give the broken section something stiff to lean on.' ) ),
	),

	'field-notebook'        => array(
		'slug'     => 'how-we-keep-a-field-notebook',
		'title'    => 'How we keep a field notebook',
		'date'     => '2026-04-25 10:00:00',
		'author'   => 'maren',
		'category' => 'gear',
		'tags'     => array( 'notebook' ),
		'picture'  => 'kit-notebook',
		'excerpt'  => 'A pencil, a waterproof notebook, and a few habits that keep notes useful years later: the time first, numbers before adjectives, and a page for every walk.',
		'content'  => static fn () =>
			p( 'Everything on this site starts in a notebook. Not a phone, not a voice memo: a small notebook with waterproof paper and a pencil tied to it with a length of cord. We have filled thirty-one of them since 2019, and the ones that are still useful have a few things in common.' )
			. group(
				p( '<strong>Sun 12 Apr · 06:50 · Kettle Marsh boardwalk</strong>' )
				. p( '+1.5 °C (pack). Calm. Fog to ~15 m, lifting by 07:30.' )
				. p( 'First red-winged blackbirds back: 3, all males. Ice gone from open water, still in the reeds.' )
				. p( 'Boards slick. Bittern? Heard once, not sure.' ),
				array(
					'className' => 'is-style-notebook',
					'name'      => 'A notebook page',
				)
			)
			. h( 2, 'The habits' )
			. items(
				array(
					'<strong>Time and place first</strong>, before anything else, every entry.',
					'<strong>Numbers before adjectives.</strong> “−3 °C” is more use in five years than “bitter”.',
					'<strong>One walk, one page</strong>, even when the page is mostly empty.',
					'<strong>Write it there</strong>, not later. Later, you remember what you expected to see.',
					'<strong>Pencil</strong>, always. It works wet, cold and upside down.',
				),
				array( 'ordered' => true )
			)
			. columns(
				array(
					array( '50%', h( 3, 'What we write down' ) . items( array( 'Temperatures, with what measured them', 'Wind, sky and the state of the ground', 'Anything that is first or last of the year', 'Distances and times, when they surprise us' ) ) ),
					array( '50%', h( 3, 'What we leave out' ) . items( array( 'How we felt about it, mostly', 'Anything we did not see ourselves', 'Guesses dressed as measurements', 'Bird names we are not sure of' ) ) ),
				)
			)
			. p( 'The kit itself is small: the notebook, two pencils, an eraser, a short ruler for measuring needle ice and snow, a thermometer, and a hand lens for lichens. It all fits in a chest pocket.' ),
	),

	'quiet-week-then-frost' => array(
		'slug'     => 'weather-log-a-quiet-week-then-the-frost',
		'title'    => 'Weather log: a quiet week, and then the frost',
		'date'     => '2026-10-04 19:00:00',
		'author'   => 'maren',
		'category' => 'weather-log',
		'tags'     => array( 'frost', 'autumn' ),
		'picture'  => 'chart-october-week',
		'excerpt'  => 'Six mild, grey, forgettable days, a little rain, the barometer climbing all week, and then one clear, still night that brought the first hard frost.',
		'content'  => static fn () =>
			p( 'Most weeks in the log are like this one: nothing much, written down carefully. Mild days, two spells of light rain, the barometer climbing a hectopascal or two a day. And then, at the end of it, the high settled overhead, the cloud cleared on Saturday evening, and the wind died. By morning it was minus three.' )
			. table(
				array( 'Day', 'High °C', 'Low °C', 'Wind', 'hPa', 'Sky', 'Notes' ),
				array(
					array( 'Mon 28', '13.8', '6.9', 'W 3', '1008', 'Cloudy', 'Mild, grey, the lake the colour of pewter' ),
					array( 'Tue 29', '12.6', '7.4', 'SW 2', '1010', 'Light rain', '3 mm, most of it before noon' ),
					array( 'Wed 30', '13.1', '5.8', 'W 2', '1013', 'Broken cloud', 'Sun for an hour after lunch' ),
					array( 'Thu 1', '11.4', '6.2', 'NW 2', '1015', 'Light rain', '2 mm; drizzle more than rain' ),
					array( 'Fri 2', '12.0', '4.3', 'N 2', '1019', 'Cloudy', 'Glass still climbing' ),
					array( 'Sat 3', '11.2', '1.6', 'Calm', '1024', 'Clearing', 'Clear and still from sunset' ),
					array( 'Sun 4', '10.3', '−3.1', 'Calm', '1027', 'Clear', 'First hard frost: rime on everything at dawn' ),
				),
				'Readings at 18:00, except Sunday’s low, read off the min–max thermometer at dawn.',
				array( 'Week', '13.8', '−3.1', '—', '1008–1027', '—', '5 mm of rain' )
			)
			. h( 2, 'Why the clear night did it' )
			. p( 'Cloud is a blanket. With it overhead, the ground’s warmth stays close all night; without it, the warmth goes straight up and out. Saturday was the first night of the autumn with a clear sky, no wind to stir the cold air, and a long night to lose heat in. The low fell four and a half degrees below Friday’s.' )
			. p( 'The frost it left is in <a href="' . fn_link( 'post', 'first-hard-frost-on-the-birch-trail' ) . '">this morning’s trail note</a>.' )
			. synced( 'weather-method' ),
	),

	'storm-front'           => array(
		'slug'     => 'caught-by-a-storm-front-on-tamarack-lake',
		'title'    => 'Caught by a storm front on Tamarack Lake',
		'date'     => '2026-07-11 19:25:00',
		'author'   => 'jonah',
		'category' => 'trail-notes',
		'tags'     => array( 'storm', 'paddling', 'wind' ),
		'picture'  => 'weather-front',
		'excerpt'  => 'We watched the shelf cloud cross the lake for twenty minutes before the first gust reached us, and used every one of them.',
		'content'  => static fn () =>
			p( 'It was the kind of July afternoon that makes its own weather: hot, heavy, the air thick enough to lean on. We were on the north shore of Tamarack Lake, two kilometres from the launch, when Maren pointed west and said, quite calmly, that we should go ashore.', array( 'dropCap' => true ) )
			. p( 'The front was a single dark bar across the western sky, flat-bottomed and sharp-edged, with a pale band of light underneath it and grey curtains of rain hanging from its leading edge. It was moving, but slowly, and the lake under it was still calm. We had time. We did not know how much.' )
			. h( 2, 'What we did, in order' )
			. items(
				array(
					'Turned for the nearest landing, a gravel beach about four hundred metres east, and paddled hard.',
					'Pulled the canoe well up the beach, turned it over and tied it to a tree.',
					'Moved away from the tallest trees on the point, into a stand of young spruce of even height.',
					'Put on rain shells, sat on our packs, and watched.',
				),
				array( 'ordered' => true )
			)
			. img( 'gallery-shore', 'Plate 20 — The beach where we waited it out, an hour afterwards.', array( 'align' => 'wide', 'className' => 'is-style-plate' ) )
			. p( 'The first gust reached us twenty minutes after Maren first pointed. The lake went from glass to whitecaps in less than a minute, the temperature dropped by what felt like ten degrees, and the rain came across the water in a wall we could see coming. It lasted forty minutes. Then it was over, the air was cool and clean, and the lake was flat again by the time we paddled back.' )
			. quote( 'The time to get off the water is when you first see it, not when you first feel it.', 'Maren, on the beach' ),
	),
);
