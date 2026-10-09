// One row of the commit graph: the lines through the row and the commit's dot,
// drawn from the lanes shared/git.ts laid out. Straight where a line keeps its
// lane, a soft curve where it moves to another.
import type { GraphRow } from '@shared/git';

export const LANE = 14;
const PAD = 9;

const x = (lane: number): number => PAD + lane * LANE;

export function GraphCell({ row, height, width, merge, head }: { row: GraphRow; height: number; width: number; merge: boolean; head: boolean }) {
  const ys = [0, height / 2, height];
  return (
    <svg className="graph" width={PAD * 2 + (width - 1) * LANE} height={height} aria-hidden="true" focusable="false">
      {row.lines.map((l, i) => {
        const x1 = x(l.x1);
        const x2 = x(l.x2);
        const y1 = ys[l.y1] as number;
        const y2 = ys[l.y2] as number;
        const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
        return <path key={i} d={d} className={`lane lane-${l.color}`} />;
      })}
      {head ? <circle cx={x(row.lane)} cy={height / 2} r={7.5} className={`graph-head lane-${row.color}`} /> : null}
      <circle cx={x(row.lane)} cy={height / 2} r={merge ? 4 : 4.5} className={`graph-dot lane-${row.color}${merge ? ' graph-merge' : ''}`} />
    </svg>
  );
}
