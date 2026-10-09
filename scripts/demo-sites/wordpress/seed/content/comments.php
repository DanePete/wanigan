<?php
/**
 * Readers' notes, on entries and on trails. key => [where (seed key), name,
 * email, date, text, reply-to key or '', author login if one of us].
 * The readers are invented; their addresses are on example.test.
 */

return array(
	'frost-1'  => array( 'post:first-hard-frost', 'Walt K.', 'walt@example.test', '2026-10-04 12:40:00', 'Same frost at our end of the lake: minus two and a half at the dock at six. The needle ice on that switchback has been there every first frost I can remember.', '' ),
	'frost-2'  => array( 'post:first-hard-frost', 'Maren Holt', '', '2026-10-04 18:05:00', 'Thank you, Walt. Good to have a second thermometer on the record. We will add your reading to the log.', 'frost-1', 'maren' ),
	'frost-3'  => array( 'post:first-hard-frost', 'Signe A.', 'signe@example.test', '2026-10-05 08:15:00', 'Walked it this morning on the strength of this. The bench at the top was exactly as warm as promised. Boardwalk still white at nine.', '' ),
	'wind-1'   => array( 'post:week-the-wind-changed', 'Dmitri V.', 'dmitri@example.test', '2026-09-28 07:30:00', 'That jump on Friday night showed on my barometer too, about four hours after yours if I read your notes right. We are twenty kilometres east.', '' ),
	'wind-2'   => array( 'post:week-the-wind-changed', 'Maren Holt', '', '2026-09-28 19:10:00', 'That fits: the front was moving at about five kilometres an hour by the time it passed us. Thank you for the reading.', 'wind-1', 'maren' ),
	'night-1'  => array( 'post:cold-night-clear-sky', 'June O.', 'june@example.test', '2026-08-31 22:00:00', 'Forty-seven minutes from first star to the Milky Way is a wonderful thing to have measured. I am going to try it from our garden, though I suspect the town will add an hour.', '' ),
	'night-2'  => array( 'post:cold-night-clear-sky', 'Tomas B.', 'tomas@example.test', '2026-09-02 13:20:00', 'The ticking of frost on the fly: I have heard that and never known what it was. Thank you.', '' ),
	'ten-1'    => array( 'post:ten-things-ridge', 'Priya N.', 'priya@example.test', '2026-08-22 09:45:00', 'I am with Maren on the phone. But I have also had one die at the fire tower in the cold, so the paper map stays in the pack.', '' ),
	'ten-2'    => array( 'post:ten-things-ridge', 'Jonah Reyes', '', '2026-08-22 20:30:00', 'A diplomatic answer, Priya. Maren says thank you.', 'ten-1', 'jonah' ),
	'ten-3'    => array( 'post:ten-things-ridge', 'Ana L.', 'ana@example.test', '2026-08-25 17:00:00', 'Would you add a sit mat? The rock on the crest is cold even in August.', '' ),
	'ice-1'    => array( 'post:reading-lake-ice', 'Walt K.', 'walt@example.test', '2026-02-15 10:10:00', 'The rule on the auger handle is the whole essay, and the right one. I have lived on the lake forty years and still drill every time.', '' ),
	'portage-1' => array( 'post:portage-loop-days', 'Signe A.', 'signe@example.test', '2025-10-14 21:00:00', 'We missed the first carry too, the same way, in the same bay. There should be a sign on that boulder.', '' ),
	'portage-2' => array( 'post:portage-loop-days', 'Maren Holt', '', '2025-10-15 08:20:00', 'There is now, of a kind: someone has painted a small white arrow on it. We saw it in the spring.', 'portage-1', 'maren' ),
	'birch-t1' => array( 'trail:birch-hollow-loop', 'Ana L.', 'ana@example.test', '2026-09-27 16:00:00', 'Walked it today: the mud at the bottom of the hill is bad after Thursday, but the boards over the pond are fine.', '' ),
	'birch-t2' => array( 'trail:birch-hollow-loop', 'Dmitri V.', 'dmitri@example.test', '2026-10-05 11:30:00', 'Footbridge two is solid again after the repair. Lovely morning for it.', '' ),
	'ice-t1'   => array( 'trail:tamarack-lake-ice-route', 'Tomas B.', 'tomas@example.test', '2026-02-15 15:45:00', 'Drilled 30 cm at the islands this afternoon. The narrows are open water, as you say: keep well clear.', '' ),
	'ice-t2'   => array( 'trail:tamarack-lake-ice-route', 'Jonah Reyes', '', '2026-02-15 19:00:00', 'Thank you, Tomas. Added to the conditions log.', 'ice-t1', 'jonah' ),
);
