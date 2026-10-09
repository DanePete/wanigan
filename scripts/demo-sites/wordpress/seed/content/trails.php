<?php
/**
 * The trails: eight routes in three regions. The facts are post meta (shown
 * on the page through block bindings), the conditions log is the
 * _fieldnotes_conditions meta (shown by the trail-conditions block).
 * Every route, place and report is invented.
 */

$route = static fn ( array $stops ) => h( 2, 'The route' ) . items( $stops, array( 'ordered' => true ) );

return array(

	'birch-hollow-loop'       => array(
		'title'      => 'Birch Hollow Loop',
		'order'      => 1,
		'date'       => '2025-05-03 10:00:00',
		'region'     => 'tamarack-lakes',
		'picture'    => 'route-birch-hollow',
		'excerpt'    => 'A gentle loop through one stand of paper birch, past a beaver pond and over a short boardwalk: the walk we use to see what a season is doing.',
		'facts'      => array( '6.4 km', '120 m', 'Easy', 'Autumn', 'Birch Hollow lot, end of Forest Road 12' ),
		'conditions' => array(
			array( '2026-10-04', 'open', 'First hard frost. Boardwalk boards icy until mid-morning; the rest firm and dry.' ),
			array( '2026-09-26', 'wet', 'Mud at the bottom of the hill after Thursday’s rain. Passable in boots.' ),
			array( '2026-09-12', 'open', 'Dry throughout. Birch leaves starting to turn on the upper loop.' ),
			array( '2026-08-23', 'open', 'Dry. Mosquitoes heavy by the pond after six.' ),
			array( '2026-07-30', 'closed', 'Footbridge two closed for repair after the July storm. Reopened 4 August.' ),
		),
		'content'    => static fn () =>
			p( 'Birch Hollow is the loop we walk most often and know best. It runs for almost all of its length through a single stand of paper birch, which makes it the best place we know to watch a season change: against the same white trunks, the light, the ground and the leaves are the only things that move.' )
			. p( 'The climb comes early if you walk it clockwise, a steady pull of about a hundred metres up switchbacks to a bench that faces east. From there the trail runs level along the shoulder, drops to a beaver pond, and crosses the wet ground below it on a short boardwalk before returning to the lot.' )
			. $route(
				array(
					'<strong>0.0 km</strong> Birch Hollow lot. Take the left-hand trail, signed with a white blaze.',
					'<strong>1.3 km</strong> The switchbacks. Needle ice here on frosty mornings.',
					'<strong>2.1 km</strong> The bench at the top. East-facing; the warmest place for a mile on a cold morning.',
					'<strong>3.8 km</strong> Footbridge two, over the creek.',
					'<strong>4.9 km</strong> The beaver pond and the boardwalk. Slick when wet or frosted.',
					'<strong>6.4 km</strong> Back at the lot.',
				)
			)
			. h( 2, 'Notes' )
			. p( 'In October the loop is at its best in the first two hours after sunrise, while frost holds in the shade. In summer, walk it early or bring repellent for the pond.' )
			. synced( 'leave-no-trace' ),
	),

	'basswood-ridge-traverse' => array(
		'title'      => 'Basswood Ridge Traverse',
		'order'      => 2,
		'date'       => '2025-06-14 10:00:00',
		'region'     => 'basswood-hills',
		'picture'    => 'route-basswood-ridge',
		'excerpt'    => 'The long walk: up through dense spruce to the bare spine of Basswood Ridge and south along it for eleven open kilometres, with the whole lake country on your left.',
		'facts'      => array( '14.8 km', '610 m', 'Hard', 'Summer, Autumn', 'North Basswood trailhead, Fire Tower Road' ),
		'conditions' => array(
			array( '2026-09-20', 'open', 'Dry and clear. Wind strong on the open ridge; bring a layer.' ),
			array( '2026-08-21', 'open', 'Spring below the fire tower running well.' ),
			array( '2026-07-26', 'open', 'Dry. The first kilometre of the climb is rooty and steep by headlamp.' ),
		),
		'content'    => static fn () =>
			p( 'This is the route for a long summer day. It climbs steeply out of the spruce at the north end, comes out onto the bare rock of the ridge, and then follows the crest south for eleven kilometres with nothing taller than blueberry bushes between you and the sky.' )
			. p( 'It is a one-way walk. Leave a car at the south trailhead on Lookout Road, or arrange a lift; the road back round is twenty-six kilometres.' )
			. $route(
				array(
					'<strong>0.0 km</strong> North Basswood trailhead. The climb starts at once.',
					'<strong>1.2 km</strong> Out of the trees onto the ridge.',
					'<strong>4.5 km</strong> The fire tower, and a spring a hundred metres below it on the east side.',
					'<strong>9.0 km</strong> The saddle, the lowest point on the crest and the only shelter from a west wind.',
					'<strong>12.6 km</strong> The turn for Lookout Spur, worth the detour if you have the legs.',
					'<strong>14.8 km</strong> South trailhead, Lookout Road.',
				)
			)
			. h( 2, 'Notes' )
			. p( 'There is no water on the crest except the spring at the fire tower. Weather arrives from the west and you will see it coming; the saddle at nine kilometres is the place to wait it out.' )
			. synced( 'leave-no-trace' ),
	),

	'cedar-river-ford'        => array(
		'title'      => 'Cedar River Ford',
		'order'      => 3,
		'date'       => '2025-07-19 10:00:00',
		'region'     => 'cedar-river-valley',
		'picture'    => 'route-cedar-ford',
		'excerpt'    => 'Down the cedar valley to a ford that decides the day: easy in a dry August, impossible in May, and the reason most people turn back.',
		'facts'      => array( '9.2 km', '180 m', 'Moderate', 'Summer', 'Mill Pond picnic area' ),
		'conditions' => array(
			array( '2026-09-12', 'open', 'Ford at its lowest on record: 46 cm at the deepest point. Stepping stones exposed and slimy.' ),
			array( '2026-08-15', 'wet', 'Ford knee to thigh deep. Crossable with care and two poles.' ),
			array( '2026-05-24', 'closed', 'Ford waist-deep and fast after the melt. Do not cross.' ),
		),
		'content'    => static fn () =>
			p( 'The valley route follows the Cedar River down from Mill Pond through old cedar and hemlock, crosses at the ford, and comes back on the far bank. The ford is the whole story. Check it before you commit, and if the water is over the top of the split boulder, turn back.' )
			. $route(
				array(
					'<strong>0.0 km</strong> Mill Pond picnic area. Follow the river downstream.',
					'<strong>2.4 km</strong> The cedar flats, the oldest trees on the route.',
					'<strong>4.1 km</strong> The ford. Cross at the shallow riffle just upstream of the split boulder.',
					'<strong>6.0 km</strong> The gravel bar, under water most of the year.',
					'<strong>9.2 km</strong> Back to Mill Pond by the upper bank trail.',
				)
			)
			. h( 2, 'Notes' )
			. p( 'Bring shoes you do not mind soaking and dry socks for the far bank. In spring, walk as far as the ford and back on the same side: it is a fine walk without the crossing.' )
			. synced( 'leave-no-trace' ),
	),

	'kettle-marsh-boardwalk'  => array(
		'title'      => 'Kettle Marsh Boardwalk',
		'order'      => 4,
		'date'       => '2025-04-26 10:00:00',
		'region'     => 'tamarack-lakes',
		'picture'    => 'route-kettle-marsh',
		'excerpt'    => 'A short, flat walk on boards across a kettle-hole marsh, best at dawn in spring and autumn when the basin fills with fog and birds.',
		'facts'      => array( '3.1 km', '10 m', 'Easy', 'Spring, Autumn', 'Kettle Marsh lot on the County 4 causeway' ),
		'conditions' => array(
			array( '2026-10-01', 'open', 'Boards dry. Some loose planks at the far platform, marked with tape.' ),
			array( '2026-08-09', 'open', 'Thick fog at dawn, gone by six. Blackbirds everywhere.' ),
			array( '2026-04-12', 'wet', 'Water over the boards in two places after the melt. Ankle-deep.' ),
		),
		'content'    => static fn () =>
			p( 'Kettle Marsh fills a hollow left by a block of ice when the glaciers went back, and the boardwalk crosses it on a long loop with two viewing platforms. It is flat, short, and suitable for anyone; it is also, at dawn in spring, one of the best places in the region to hear birds you will not see.' )
			. $route(
				array(
					'<strong>0.0 km</strong> The causeway lot. The boards start at the gate.',
					'<strong>0.8 km</strong> The first platform, over open water.',
					'<strong>1.6 km</strong> The far platform, among the cattails.',
					'<strong>3.1 km</strong> Back at the gate, by the alder edge.',
				)
			)
			. h( 2, 'Notes' )
			. p( 'Stay on the boards. The marsh is older than the town and does not recover from footprints. Dogs on leads; the birds nest close to the walkway.' )
			. synced( 'leave-no-trace' ),
	),

	'tamarack-lake-ice-route' => array(
		'title'      => 'Tamarack Lake Ice Route',
		'order'      => 5,
		'date'       => '2025-12-28 10:00:00',
		'region'     => 'tamarack-lakes',
		'picture'    => 'route-tamarack-ice',
		'excerpt'    => 'A winter-only route straight across Tamarack Lake to the far shore and back by the islands, walked only when the auger says the ice will carry you.',
		'facts'      => array( '7.5 km', '30 m', 'Moderate', 'Winter', 'Public landing, Tamarack Lake east shore' ),
		'conditions' => array(
			array( '2026-03-08', 'closed', 'Ice grey and wet near the inflows. Route closed for the season.' ),
			array( '2026-02-14', 'open', '28–32 cm of clear ice on the line. Snow cover light; good walking.' ),
			array( '2026-01-17', 'open', '22 cm at the landing, 19 cm by the islands. Pressure ridge at 2.6 km is crossable at the marked point.' ),
			array( '2025-12-28', 'wet', '11 cm at the landing, 8 cm off the point. Stayed close to shore.' ),
		),
		'content'    => static fn () =>
			p( 'In a cold winter Tamarack Lake becomes the easiest walking in the region: flat, open, and quiet except for the ice itself. This route crosses straight to the far shore, follows it north, and comes back past the islands. It is walked only on ice we have measured, and only in the months when there is enough of it.' )
			. quote( 'We measure before we trust: a hole every fifty metres on a new line, and we turn back at anything under ten centimetres of clear ice.', 'From <a href="' . fn_link( 'post', 'reading-lake-ice' ) . '">Reading lake ice</a>', 'margin-note' )
			. $route(
				array(
					'<strong>0.0 km</strong> The public landing.',
					'<strong>2.6 km</strong> The pressure ridge. Cross only at the flat point marked with a pole.',
					'<strong>3.4 km</strong> The far shore, under the tamaracks.',
					'<strong>5.2 km</strong> The islands. Keep well clear of the narrows between them, which never freeze hard.',
					'<strong>7.5 km</strong> Back at the landing.',
				)
			)
			. h( 2, 'Notes' )
			. p( 'Carry ice picks round your neck, a throw rope and a full change of dry clothes. Never walk it alone.' )
			. synced( 'leave-no-trace' ),
	),

	'portage-loop'            => array(
		'title'      => 'Portage Loop',
		'order'      => 6,
		'date'       => '2025-10-12 10:00:00',
		'region'     => 'tamarack-lakes',
		'picture'    => 'route-portage-loop',
		'excerpt'    => 'Second Lake and Tamarack Lake joined by four carries through the forest: a long day, or a slow weekend with a canoe, at its finest when the tamaracks turn.',
		'facts'      => array( '11.0 km', '240 m', 'Moderate', 'Autumn', 'Second Lake canoe launch' ),
		'conditions' => array(
			array( '2026-10-03', 'open', 'All four carries clear. Tamaracks at their peak on the east shore.' ),
			array( '2026-09-19', 'wet', 'Carry three muddy for 200 m. Boots, not sandals.' ),
			array( '2026-06-28', 'open', 'Blackflies heavy on the long carry.' ),
		),
		'content'    => static fn () =>
			p( 'The loop can be walked in a long day, but it is meant for a canoe. Four carries link Second Lake and Tamarack Lake through the forest, the longest a little over a kilometre, and the campsites on the point are the best in the region for watching the tamaracks turn in October.' )
			. $route(
				array(
					'<strong>0.0 km</strong> Second Lake launch. Paddle north-west.',
					'<strong>1.9 km</strong> Carry one, behind a boulder the size of a car. Easy to miss.',
					'<strong>4.6 km</strong> Carries two and three, short and muddy, through old spruce.',
					'<strong>6.2 km</strong> The landing on Tamarack Lake, and the campsites on the point.',
					'<strong>9.8 km</strong> The long carry, with a canoe rest at the halfway mark.',
					'<strong>11.0 km</strong> Back at the launch.',
				)
			)
			. p( 'The trip is written up day by day in <a href="' . fn_link( 'post', 'four-days-on-the-portage-loop' ) . '">Four days on the portage loop</a>.' )
			. synced( 'leave-no-trace' ),
	),

	'lookout-spur'            => array(
		'title'      => 'Lookout Spur',
		'order'      => 7,
		'date'       => '2025-08-09 10:00:00',
		'region'     => 'basswood-hills',
		'picture'    => 'route-lookout-spur',
		'excerpt'    => 'Short, steep and worth it at any time of year: straight up a granite spur to a rock that looks down the whole length of the Cedar valley.',
		'facts'      => array( '4.2 km', '260 m', 'Hard', 'All seasons', 'Lookout Road pull-off, mile 3' ),
		'conditions' => array(
			array( '2026-09-28', 'open', 'Dry rock, good grip. The last scramble is easy in dry weather.' ),
			array( '2026-02-07', 'wet', 'Ice on the slabs below the rock. Microspikes needed.' ),
		),
		'content'    => static fn () =>
			p( 'The spur is the fastest way we know to a big view. The trail goes straight up a granite rib from the road, with one short scramble near the top, and comes out on a flat rock that looks down the whole length of the Cedar valley. It is steep enough to be hard and short enough to walk on a winter afternoon.' )
			. $route(
				array(
					'<strong>0.0 km</strong> The pull-off at mile 3 on Lookout Road.',
					'<strong>1.4 km</strong> The slabs. Slippery when wet, icy in winter.',
					'<strong>2.0 km</strong> The scramble: three metres of easy rock with good holds.',
					'<strong>2.1 km</strong> The rock. Return the same way.',
				)
			)
			. h( 2, 'Notes' )
			. p( 'In winter, take microspikes for the slabs. The rock is exposed on three sides; keep children and dogs close.' )
			. synced( 'leave-no-trace' ),
	),

	'night-sky-meadow'        => array(
		'title'      => 'Night Sky Meadow',
		'order'      => 8,
		'date'       => '2025-08-30 10:00:00',
		'region'     => 'cedar-river-valley',
		'picture'    => 'route-night-meadow',
		'excerpt'    => 'An easy loop around a high meadow at the end of Old Quarry Road, far enough from any town for the darkest skies in the region.',
		'facts'      => array( '5.0 km', '90 m', 'Easy', 'Summer', 'Meadow gate, Old Quarry Road' ),
		'conditions' => array(
			array( '2026-08-30', 'open', 'Dry. Minus four overnight in the meadow: bring warm bags even in August.' ),
			array( '2026-06-07', 'wet', 'Low end of the meadow under water after three days of rain.' ),
		),
		'content'    => static fn () =>
			p( 'The meadow sits on a high shelf at the end of Old Quarry Road, a long way from any town, and on a clear night it has the darkest sky we know. The loop around it is easy walking by day; by night it is the way to the camping ground at the top, where the view south is all sky.' )
			. $route(
				array(
					'<strong>0.0 km</strong> The meadow gate. Close it behind you; there are cattle in June.',
					'<strong>1.5 km</strong> The camping ground at the top of the meadow.',
					'<strong>3.2 km</strong> The quarry pond, along the east edge.',
					'<strong>5.0 km</strong> Back at the gate.',
				)
			)
			. h( 2, 'Notes' )
			. p( 'Cold air drains into the meadow on clear nights, and it is often five degrees colder than the road. Red light only after dark, for the sake of everyone’s eyes.' )
			. synced( 'leave-no-trace' ),
	),
);
