// The tours' state for this window: which have been seen (kept in this viewer's
// storage, like the panels' sizes), whether first-visit tours are on, and which
// tour is playing now. components/Tour.tsx draws it; tours/ holds the tours.
import { useSyncExternalStore } from 'react';
import { bridge } from './api';
import { markDismissed, markSeen, readTourState, writeTourState, NO_TOURS_SEEN, TOURS_KEY, type TourState } from './tour-model';

let state: TourState = load();
let playing: string | null = null;
const listeners = new Set<() => void>();

function load(): TourState {
  try { return readTourState(localStorage.getItem(TOURS_KEY)); } catch { return { ...NO_TOURS_SEEN }; }
}

function save(next: TourState): void {
  state = next;
  try { localStorage.setItem(TOURS_KEY, writeTourState(next)); } catch { /* storage unavailable: it lasts this window */ }
  tell();
}

function tell(): void { for (const l of listeners) l(); }

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * Whether tours may start on their own (the welcome tour, first-visit offers).
 * Automation (the smoke test, the sweeps) turns that off through the bridge;
 * replaying a tour by hand always works.
 */
export function toursOnTheirOwn(): boolean {
  return !bridge().toursOff;
}

export function useTourState(): TourState {
  return useSyncExternalStore(subscribe, () => state);
}

/** The tour playing now, if any. */
export function usePlayingTour(): string | null {
  return useSyncExternalStore(subscribe, () => playing);
}

export function startTour(id: string): void {
  playing = id;
  tell();
}

/** Ended, by Done or early: either way it is seen, and never offered again. */
export function endTour(): void {
  if (playing) state = markSeen(state, playing);
  playing = null;
  save(state);
}

/** Not now, on a first-visit offer. */
export function dismissTourOffer(id: string): void {
  save(markDismissed(state, id));
}

export function setToursOff(off: boolean): void {
  save({ ...state, off });
}

/** Every tour offers itself again, the welcome tour included. */
export function resetTours(): void {
  save({ ...NO_TOURS_SEEN, off: state.off });
}
