// How the trace's numbers and owners read in the window: measured times, sizes,
// cache lifetimes. Every time here is what the helper measured in one render
// on this Mac, and is said that way.
import type { TraceOwner, TraceSource } from '@shared/live-trace';

export function ms(n: number): string {
  if (n >= 1000) return `${Math.round(n / 100) / 10} s`;
  if (n >= 100) return `${Math.round(n)} ms`;
  if (n >= 10) return `${Math.round(n * 10) / 10} ms`;
  return `${Math.round(n * 100) / 100} ms`;
}

export function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 102.4) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${n} bytes`;
}

export function maxAge(v: number | 'permanent'): string {
  if (v === 'permanent') return 'kept until its tags are cleared';
  if (v === 0) return 'never cached (max-age 0)';
  if (v < 120) return `${v} seconds`;
  if (v < 7200) return `${Math.round(v / 60)} minutes`;
  if (v < 172_800) return `${Math.round(v / 3600)} hours`;
  return `${Math.round(v / 86_400)} days`;
}

export const OWNER_LABEL: Record<TraceOwner, string> = {
  yours: 'Your code', contrib: 'Contributed', core: 'Core', plugin: 'A plugin', theme: 'A theme', unknown: 'Owner not known',
};

/** The class the owner badge takes: the owner's own code stands out; someone else's is quiet. */
export const ownerClass = (o: TraceOwner): string => (o === 'yours' ? 'yours' : o === 'unknown' ? 'unknown' : 'contrib');

/** A source file and line as the owner would type it into an editor. */
export const where = (s: TraceSource): string => `${s.file}${s.line !== undefined ? `:${s.line}` : ''}`;
