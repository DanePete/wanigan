import { useEffect, useState } from 'react';
import { fluidTier, type FluidSetting, type FluidTier, type MotionSetting } from '@shared/relay-rig';
import { fluidAvailable } from './fluid';

/**
 * Which of the sluice's three tiers this window renders, read rather than
 * guessed: the operator's fluid and motion settings from the main process,
 * the OS's reduced-motion preference from `matchMedia`, and whether this
 * device can run the fluid module at all. The decision itself is
 * `fluidTier()` in `src/shared/relay-rig.ts`; this hook only gathers its four
 * inputs and follows motion changes while the view is open.
 *
 * Until the settings have answered the tier is `still`. That is the honest
 * default, not a fallback: a surface that animated before it knew whether it
 * was allowed to would be the one that keeps moving for the operator who
 * asked it not to.
 */

export type TierReading = {
  tier: FluidTier;
  setting: FluidSetting;
  webgl2: boolean;
  /** False until the settings bridge has answered; the tier is `still` until then. */
  ready: boolean;
};

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const isMotion = (value: unknown): value is MotionSetting => value === 'auto' || value === 'full' || value === 'off';

/** The root's `data-motion`, which App.tsx keeps in step with the setting, for when the bridge cannot answer. */
function rootMotion(): MotionSetting {
  const value = document.documentElement.dataset.motion;
  return isMotion(value) ? value : 'off';
}

export function useFluidTier(): TierReading {
  const [prefs, setPrefs] = useState<{ fluid: FluidSetting; motion: MotionSetting } | null>(null);
  const [reduced, setReduced] = useState<boolean>(() => window.matchMedia(REDUCED_MOTION).matches);
  // Probed once per mount: the answer is a property of the device, not of the relay.
  const [webgl2] = useState<boolean>(() => fluidAvailable());

  useEffect(() => {
    let live = true;
    window.wanigan.prefs.all()
      .then((all) => {
        if (live) setPrefs({ fluid: all.fluid, motion: isMotion(document.documentElement.dataset.motion) ? rootMotion() : all.motion });
      })
      // Recovery mode: with the settings bridge down the module stays off and
      // the motion setting is whatever the root already carries.
      .catch(() => { if (live) setPrefs({ fluid: 'off', motion: rootMotion() }); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setPrefs((current) => current ? { ...current, motion: rootMotion() } : current);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduced(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  if (!prefs) return { tier: 'still', setting: 'auto', webgl2, ready: false };
  return {
    tier: fluidTier({ setting: prefs.fluid, webgl2, motion: prefs.motion, reducedMotion: reduced }),
    setting: prefs.fluid,
    webgl2,
    ready: true,
  };
}
