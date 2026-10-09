// The still drawing of Wanigan, shown while the fluid orb starts and wherever
// WebGPU is unavailable. Its colours follow the same signal as the water's light;
// the lava lamp draws its wax. Spin and celebrate have CSS versions (orb.css).
import { useId } from 'react';
import type { OrbMaterial } from './mood';
import type { OrbSignal } from './signal';

const WATER: Record<OrbSignal, [string, string]> = {
  quiet: ['#7fb5dd', '#3f7fb3'],
  working: ['#5cb2ee', '#1f6fb8'],
  attention: ['#f4b45e', '#c27a17'],
  failed: ['#f08a7e', '#b8463b'],
  finished: ['#7fd9a8', '#2f9466'],
  unavailable: ['#9aa6b4', '#5c6878'],
};

/** Cool wax at the top, hot wax at the heater; the lamp's clear liquid around it. */
const WAX = { liquid: '#2a1b33', cool: '#5e1a52', hot: '#f08a2c' } as const;

export function OrbFallback({ signal, material = 'water', alarm = false }: { signal: OrbSignal; material?: OrbMaterial; alarm?: boolean }) {
  const id = useId().replace(/:/g, '');
  const [top, deep] = WATER[alarm ? 'failed' : signal];
  const level = 55; // the water line, in a 100-unit box
  const wax = material === 'wax';
  return (
    <svg className="orb-still" viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <clipPath id={`c${id}`}><circle cx="50" cy="50" r="46" /></clipPath>
        <radialGradient id={`g${id}`} cx="38%" cy="30%" r="75%">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="0.55" stopColor="#bcd6ea" stopOpacity="0.06" />
          <stop offset="1" stopColor="#0b1a26" stopOpacity="0.28" />
        </radialGradient>
        <linearGradient id={`w${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={top} stopOpacity="0.92" />
          <stop offset="1" stopColor={deep} stopOpacity="0.98" />
        </linearGradient>
        {/* By height in the lamp, not per blob: hot at the heater, cool at the top. */}
        <linearGradient id={`x${id}`} gradientUnits="userSpaceOnUse" x1="0" y1="18" x2="0" y2="88">
          <stop offset="0" stopColor={WAX.cool} />
          <stop offset="1" stopColor={WAX.hot} />
        </linearGradient>
        <radialGradient id={`r${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0.86" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#d8ecfa" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="46" fill={`url(#g${id})`} />
      <g clipPath={`url(#c${id})`}>
        {wax ? (
          <g className="orb-water">
            <rect x="0" y="0" width="100" height="100" fill={WAX.liquid} opacity="0.55" />
            <g fill={`url(#x${id})`}>
              <ellipse cx="34" cy="86" rx="20" ry="9" />
              <ellipse cx="62" cy="88" rx="17" ry="8" />
              <ellipse cx="70" cy="62" rx="8" ry="11" />
              <circle cx="27" cy="62" r="5" />
              <circle cx="63" cy="19" r="6" />
              <circle cx="33" cy="23" r="4" />
            </g>
          </g>
        ) : (
          <g className="orb-water">
            <g className="orb-wave orb-wave-back">
              <path d={wave(level + 2, 5)} fill={deep} opacity="0.55" />
            </g>
            <g className="orb-wave orb-wave-front">
              <path d={wave(level, 4)} fill={`url(#w${id})`} />
            </g>
          </g>
        )}
      </g>
      <g className="orb-eyes" fill="#0d1a24">
        <ellipse cx="41" cy="40" rx="3.2" ry="4.6" />
        <ellipse cx="59" cy="40" rx="3.2" ry="4.6" />
      </g>
      <circle cx="50" cy="50" r="46" fill={`url(#r${id})`} />
      <circle cx="50" cy="50" r="46" fill="none" stroke="#d6e9f7" strokeOpacity="0.35" strokeWidth="1.2" />
      <ellipse cx="33" cy="26" rx="9" ry="5" fill="#ffffff" opacity="0.5" transform="rotate(-28 33 26)" />
      <circle cx="69" cy="78" r="2.4" fill="#ffffff" opacity="0.55" />
    </svg>
  );
}

/** Two periods of a sine wave across a 200-unit strip, filled down to the bottom. */
function wave(level: number, amplitude: number): string {
  let d = `M -100 ${level}`;
  for (let x = -100; x <= 200; x += 10) {
    d += ` L ${x} ${(level + Math.sin((x / 100) * Math.PI * 2) * amplitude).toFixed(2)}`;
  }
  return `${d} L 200 110 L -100 110 Z`;
}
