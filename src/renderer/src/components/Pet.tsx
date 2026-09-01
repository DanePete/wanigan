import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The site mascot — a faithful Tamagotchi P1, not an approximation.
 *
 * The original has been dumped and emulated: TamaLIB emulates the Epson
 * E0C6S46 the P1 actually ran on, from a ROM read optically off a die
 * photograph, and Natalie Silvanovich's 29C3 work opened the rest. The
 * mechanics below follow that documented behaviour rather than something
 * plausible, and three of them are the opposite of what a first guess gives:
 *
 *   1. A CARE MISTAKE IS A SPECIFIC EVENT, not a vague neglect score. When a
 *      meter empties, the pet beeps and raises the Attention icon. You have
 *      FIFTEEN MINUTES. Miss the window and one mistake is recorded — and
 *      that is all that is recorded, no matter how long you then ignore it.
 *   2. CARE AND DISCIPLINE ARE SEPARATE CUMULATIVE COUNTERS, and neither
 *      resets on evolution. Discipline mistakes come from a different event
 *      entirely: the pet calls when it needs nothing, and you must discipline
 *      it rather than feed it.
 *   3. NOTHING IS RANDOM. The P1 pooped and fell ill on set patterns. So
 *      these are fixed intervals, seeded from the hatch time — the same pet
 *      cared for the same way behaves the same way twice.
 *
 * Stat decay against the wall clock is ours, not theirs: a pet that pauses
 * when you quit is a progress bar, and coming back to a hungry one is the
 * whole genre.
 */

const KEY = 'wanigan.pet.v2';
const TICK_MS = 15_000;

/** Documented P1 timings, in minutes. */
const HATCH_MIN = 5;             // the 1996 manual: five minutes after the clock is set
const CARE_WINDOW_MIN = 15;      // beep to recorded mistake
const BABY_MIN = 60;             // Babytchi -> Marutchi
const CHILD_MIN = 1380;          // Marutchi -> teen, ~23 hours
const TEEN_MIN = 1380;           // teen -> adult
const POOP_EVERY_MIN = 30;       // set pattern, not a dice roll
const CALL_EVERY_MIN = 190;      // the "needs nothing" call that wants discipline

type Stage = 'egg' | 'baby' | 'child' | 'teen' | 'adult';
type Need = 'none' | 'hungry' | 'unhappy' | 'sick' | 'discipline';

type Pet = {
  name: string; born: number; lastTick: number; generation: number;
  hunger: number; happy: number; energy: number; health: number;
  weight: number; poops: number; sick: boolean; asleep: boolean; lightsOff: boolean;
  /** The two counters that decide what it becomes. Neither resets on evolution. */
  careMistakes: number; disciplineMistakes: number; discipline: number;
  need: Need; needSince: number | null;
  /**
   * The needs that have already cost their one mistake. A need stays listed —
   * flag down, no second charge — until it is actually met, which is what
   * makes the cap a cap rather than a fifteen-minute metronome. Hunger and
   * misery are charged separately, because on the P1 they are separate calls.
   */
  counted: Need[];
  nextPoopAt: number; nextCallAt: number;
  meals: number; dead: boolean; deathAt: number | null;
};

const fresh = (generation = 1): Pet => {
  const now = Date.now();
  return {
    name: 'Chip', born: now, lastTick: now, generation,
    hunger: 20, happy: 80, energy: 90, health: 100,
    weight: 5, poops: 0, sick: false, asleep: false, lightsOff: false,
    careMistakes: 0, disciplineMistakes: 0, discipline: 0,
    need: 'none', needSince: null, counted: [],
    nextPoopAt: now + POOP_EVERY_MIN * 60_000,
    nextCallAt: now + CALL_EVERY_MIN * 60_000,
    meals: 0, dead: false, deathAt: null,
  };
};

function load(): Pet {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const saved = { ...fresh(), ...(JSON.parse(raw) as Partial<Pet>) };
    // A pet saved before the cap existed has no list; a mangled one must not be
    // able to crash the tick that reads it.
    return Array.isArray(saved.counted) ? saved : { ...saved, counted: [] };
  } catch { return fresh(); }
}
function save(p: Pet) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage can be blocked */ }
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/**
 * The documented evolution table. Care and discipline branch separately, which
 * is why "perfect care" alone never produced the top character.
 */
function stageOf(p: Pet): Stage {
  const mins = (Date.now() - p.born) / 60_000;
  if (mins < HATCH_MIN) return 'egg';
  if (mins < HATCH_MIN + BABY_MIN) return 'baby';
  if (mins < HATCH_MIN + BABY_MIN + CHILD_MIN) return 'child';
  if (mins < HATCH_MIN + BABY_MIN + CHILD_MIN + TEEN_MIN) return 'teen';
  return 'adult';
}

export function characterOf(p: Pet): string {
  const st = stageOf(p);
  if (st === 'egg') return 'Egg';
  if (st === 'baby') return 'Babytchi';
  if (st === 'child') return 'Marutchi';
  const goodCare = p.careMistakes < 3;
  if (st === 'teen') {
    // < 3 care -> Tamatchi, >= 3 -> Kuchitamatchi; discipline picks the type.
    const base = goodCare ? 'Tamatchi' : 'Kuchitamatchi';
    return p.disciplineMistakes >= 3 ? `${base} II` : base;
  }
  // Adult tier is decided by CUMULATIVE DISCIPLINE MISTAKES, not by care —
  // the detail that makes "raise it perfectly" the wrong instruction.
  if (!goodCare) return p.disciplineMistakes >= 2 ? 'Tarakotchi' : 'Kuchipatchi';
  if (p.disciplineMistakes === 0) return 'Mametchi';
  if (p.disciplineMistakes === 1) return 'Ginjirotchi';
  return 'Maskutchi';
}

function ageText(born: number): string {
  const s = Math.floor((Date.now() - born) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** What it is asking for, in priority order. Sickness outranks everything. */
function needOf(p: Pet): Need {
  if (p.sick) return 'sick';
  if (p.hunger >= 100) return 'hungry';
  if (p.happy <= 0) return 'unhappy';
  return 'none';
}

/**
 * Whether one specific need has actually been answered. `needOf` reports only
 * the top of the priority list, so a starving pet that then falls ill stops
 * *saying* it is hungry without anyone having fed it. Reading the meter itself
 * is the only way to tell "satisfied" apart from "outranked", and the mistake
 * cap has to know the difference.
 */
function met(p: Pet, need: Need): boolean {
  if (need === 'sick') return !p.sick;
  if (need === 'hungry') return p.hunger < 100;
  if (need === 'unhappy') return p.happy > 0;
  return true;
}

/**
 * Advance to now. A week away is one calculation rather than a week of ticks.
 */
function advance(p: Pet): Pet {
  if (p.dead) return p;
  const now = Date.now();
  const mins = Math.max(0, (now - p.lastTick) / 60_000);
  if (mins < 0.05) return p;
  const n: Pet = { ...p, lastTick: now };

  if (n.asleep) {
    n.energy = clamp(n.energy + mins * 1.6);
    n.hunger = clamp(n.hunger + mins * 0.25);
    if (n.energy >= 98) n.asleep = false;
  } else {
    n.hunger = clamp(n.hunger + mins * 0.75);
    n.happy = clamp(n.happy - mins * 0.5);
    n.energy = clamp(n.energy - mins * 0.45);
    // Set pattern, not a dice roll.
    while (now >= n.nextPoopAt && n.poops < 4) {
      n.poops += 1;
      n.nextPoopAt += POOP_EVERY_MIN * 60_000;
    }
    if (now >= n.nextPoopAt) n.nextPoopAt = now + POOP_EVERY_MIN * 60_000;

    // The call that wants discipline rather than food. Answering it wrongly is
    // how a pet ends up disciplined badly without ever being neglected.
    if (now >= n.nextCallAt && n.need === 'none' && !n.sick) {
      n.need = 'discipline';
      n.needSince = now;
      n.nextCallAt = now + CALL_EVERY_MIN * 60_000;
    }
  }

  // Sickness follows neglect deterministically: a standing mess, or a need
  // left long enough to have already cost a care mistake.
  if (!n.sick && n.poops >= 3) n.sick = true;

  // A need that has been answered is free to call again later; one that has
  // already been charged stays charged until it actually is.
  if (n.counted.length) n.counted = n.counted.filter((need) => !met(n, need));

  // Raise the attention flag the moment a meter empties.
  const want = needOf(n);
  if (n.need !== 'discipline') {
    if (want === 'none' || n.counted.includes(want)) {
      // Either nothing is wrong, or the only thing wrong has already cost its
      // one mistake and is now waiting to be fixed rather than re-charged.
      if (n.need !== 'none') { n.need = 'none'; n.needSince = null; }
    } else if (n.need !== want) {
      n.need = want; n.needSince = now;
    }
  }

  // Fifteen minutes, then exactly one mistake — no matter how much longer it
  // is ignored. That cap is the mechanic, and getting it wrong turns a missed
  // afternoon into instant death. The flag comes down and the need is recorded
  // as charged, so the same neglect cannot restart the window on the next tick;
  // the health drain below is what keeps costing until you help.
  if (n.need !== 'none' && n.needSince !== null && now - n.needSince >= CARE_WINDOW_MIN * 60_000) {
    if (n.need === 'discipline') {
      // Discipline is on its own schedule: the next call is already booked, so
      // it needs no charge to stay quiet until then.
      n.disciplineMistakes += 1;
    } else {
      n.careMistakes += 1;
      n.counted = [...n.counted, n.need];
    }
    n.need = 'none';
    n.needSince = null;
    n.health = clamp(n.health - 12);
  }

  let drain = 0;
  if (n.hunger > 85) drain += mins * 0.55;
  if (n.happy < 15) drain += mins * 0.4;
  if (n.poops >= 3) drain += mins * 0.5;
  if (n.sick) drain += mins * 0.9;
  n.health = clamp(n.health - drain);

  if (n.health <= 0) { n.dead = true; n.deathAt = now; }
  if (!n.asleep && (n.energy < 8 || (n.lightsOff && n.energy < 55))) n.asleep = true;
  return n;
}

/* ── sprites ─────────────────────────────────────────────────────────────
   Authored as character grids because pixel art in code should be readable as
   pixel art. B body, D outline, A accent, E eye, M mouth, H hat, . empty.
   ──────────────────────────────────────────────────────────────────────── */

const EGG = [
  '......DDDD......',
  '....DDBBBBDD....',
  '...DBBBBBBBBD...',
  '..DBBBBAABBBBD..',
  '..DBBBAAAABBBD..',
  '.DBBBBBAABBBBBD.',
  '.DBBBBBBBBBBBBD.',
  '.DBBBAABBBAABBD.',
  '.DBBAAAABAAAABD.',
  '.DBBBAABBBAABBD.',
  '..DBBBBBBBBBBD..',
  '..DBBBBBBBBBBD..',
  '...DBBBBBBBBD...',
  '....DDBBBBDD....',
  '......DDDD......',
  '................',
];

const BODY = [
  '................',
  '................',
  '.....DDDDDD.....',
  '...DDBBBBBBDD...',
  '..DBBBBBBBBBBD..',
  '..DBBBBBBBBBBD..',
  '.DBBBBBBBBBBBBD.',
  '.DBBBBBBBBBBBBD.',
  '.DBBBBBBBBBBBBD.',
  '..DBBBBBBBBBBD..',
  '..DBBBBBBBBBBD..',
  '...DDBBBBBBDD...',
  '.....DD..DD.....',
  '....DBBD.DBBD...',
  '....DDDD.DDDD...',
  '................',
];

/** The hard hat is the only thing that makes it Wanigan's pet and not a blob. */
const HAT = [
  '................',
  '.....HHHHHH.....',
  '...HHHHHHHHHH...',
  '..HHHHHHHHHHHH..',
  '..HH........HH..',
  '................',
];

const PALETTE: Record<string, string> = {
  B: 'var(--accent)',
  D: 'var(--bg)',
  A: 'var(--accent-soft)',
  E: 'var(--bg)',
  M: 'var(--bg)',
  H: 'var(--warning)',
};

type Mood = 'ok' | 'happy' | 'sad' | 'sick' | 'asleep' | 'hungry' | 'dead';

/*
 * Deliberately blind to real work. This used to poll the session list and the
 * attention queue and render both as feeling — "Anxious — 3 agents are waiting
 * on you" over a real blocked count, a critical-token "!" on the same rail as
 * the attention queue. A toy that narrates operational state is a second,
 * unaccountable status display for the same numbers, and the honest sentence is
 * "3 sessions are blocked", not a mood. The pet now knows only about itself, so
 * it also stops being a third poller on the Sessions tab.
 */
function PetInner() {
  const [pet, setPet] = useState<Pet>(() => advance(load()));
  const [say, setSay] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [game, setGame] = useState<{ round: number; wins: number; face: -1 | 1 } | null>(null);
  /* Collapsed until you ask for it, and remembered after that. The rail's job
     is telling you which session to go to; a mascot that opens itself on every
     launch spends that space before the sessions get a chance to. */
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('wanigan.pet.open') === '1'; } catch { return false; }
  });
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { localStorage.setItem('wanigan.pet.open', next ? '1' : '0'); } catch { /* blocked */ }
    return next;
  });
  const cv = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const fx = useRef<{ kind: string; until: number }>({ kind: '', until: 0 });

  const update = useCallback((fn: (p: Pet) => Pet) => {
    setPet((prev) => { const next = fn(prev); save(next); return next; });
  }, []);

  useEffect(() => { save(pet); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Skipped while the window is hidden, which costs nothing: decay is
    // computed from the wall clock, and the visibility handler below settles
    // the whole hidden stretch in one advance when you come back.
    const t = setInterval(() => { if (!document.hidden) update((p) => advance(p)); }, TICK_MS);
    const onVis = () => { if (!document.hidden) update((p) => advance(p)); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [update]);

  const stage = stageOf(pet);
  const mood: Mood = pet.dead ? 'dead'
    : pet.asleep ? 'asleep'
    : pet.sick ? 'sick'
    : pet.hunger > 80 ? 'hungry'
    : pet.happy < 25 || pet.health < 35 ? 'sad'
    : pet.happy > 75 ? 'happy' : 'ok';

  /* ── drawing ───────────────────────────────────────────────────────── */
  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const px = 6, W = 40, H = 22;
    c.width = W * px; c.height = H * px;

    const cssVar = (v: string) => {
      const m = /var\((--[a-z-]+)\)/.exec(v);
      return m ? getComputedStyle(c).getPropertyValue(m[1]).trim() || '#888' : v;
    };
    const colours: Record<string, string> = {};
    for (const k of Object.keys(PALETTE)) colours[k] = cssVar(PALETTE[k]);

    const put = (x: number, y: number, col: string) => {
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x) * px, Math.round(y) * px, px, px);
    };
    const grid = (rows: string[], ox: number, oy: number, map = colours) => {
      rows.forEach((row, y) => row.split('').forEach((ch, x) => {
        if (ch !== '.' && map[ch]) put(ox + x, oy + y, map[ch]);
      }));
    };

    let raf = 0;
    const draw = () => {
      const f = frame.current;
      ctx.clearRect(0, 0, c.width, c.height);

      // Idle bob. Two positions, like an LCD with two frames.
      const bob = reduce ? 0 : (mood === 'asleep' ? 0 : Math.floor(f / 4) % 2);
      const bx = 12;
      const by = 3 + bob;

      if (pet.dead) {
        grid(['..DD..DD..', '...DDDD...', '..DDDDDD..', '.DDDDDDDD.'], 15, 8, { D: cssVar('var(--text-faint)') });
        ctx.fillStyle = cssVar('var(--text-faint)');
        ctx.font = `${px * 2}px ui-monospace, monospace`;
        ctx.fillText('✝', 19 * px, 16 * px);
      } else if (stage === 'egg') {
        const wob = reduce ? 0 : Math.floor(f / 6) % 2;
        grid(EGG, bx + wob, by);
      } else {
        const small = stage === 'baby';
        grid(BODY, bx, by);
        if (stage === 'adult' || stage === 'teen') grid(HAT, bx, by - 1);

        // Eyes and mouth carry the mood; the body never changes.
        const ey = by + 6, ex = bx + 4;
        const ink = colours.E;
        if (mood === 'asleep') {
          put(ex, ey, ink); put(ex + 1, ey, ink);
          put(ex + 6, ey, ink); put(ex + 7, ey, ink);
        } else if (mood === 'sick' || mood === 'sad') {
          put(ex, ey, ink); put(ex + 1, ey + 1, ink);
          put(ex + 7, ey, ink); put(ex + 6, ey + 1, ink);
        } else {
          const blink = !reduce && f % 40 < 2;
          if (blink) { put(ex, ey + 1, ink); put(ex + 1, ey + 1, ink); put(ex + 6, ey + 1, ink); put(ex + 7, ey + 1, ink); }
          else {
            put(ex, ey, ink); put(ex, ey + 1, ink);
            put(ex + 7, ey, ink); put(ex + 7, ey + 1, ink);
          }
        }
        const my = by + 9, mx = bx + 6;
        if (mood === 'happy') { put(mx, my, ink); put(mx + 1, my + 1, ink); put(mx + 2, my + 1, ink); put(mx + 3, my, ink); }
        else if (mood === 'sad' || mood === 'sick' || mood === 'hungry') { put(mx, my + 1, ink); put(mx + 1, my, ink); put(mx + 2, my, ink); put(mx + 3, my + 1, ink); }
        else if (mood !== 'asleep') { put(mx + 1, my, ink); put(mx + 2, my, ink); }
        if (small) { /* baby keeps the same body; the hat is what grows */ }
      }

      // The mess. Every uncleaned pile raises the chance of sickness, so it
      // has to be visible without opening anything.
      for (let i = 0; i < pet.poops; i++) {
        const px0 = 2 + i * 4, py0 = 17;
        const brown = cssVar('var(--serious)');
        put(px0 + 1, py0, brown); put(px0, py0 + 1, brown);
        put(px0 + 1, py0 + 1, brown); put(px0 + 2, py0 + 1, brown);
      }

      // Status glyphs, always paired with a word in the caption below.
      ctx.fillStyle = cssVar('var(--warning)');
      ctx.font = `bold ${px * 2}px ui-sans-serif, system-ui`;
      if (mood === 'asleep' && !reduce) {
        const zs = ['z', 'Z', 'z'];
        zs.forEach((z, i) => {
          if (Math.floor(f / 5) % 3 >= i) ctx.fillText(z, (26 + i * 2) * px, (6 - i * 2) * px + px * 2);
        });
      }
      if (pet.sick) { ctx.fillStyle = cssVar('var(--bad)'); ctx.fillText('☠', 30 * px, 6 * px); }

      // A critical-token "!" for the real blocked count and a spark per running
      // agent used to be drawn here. Both were removed with the poll: the
      // attention queue above this rail is where a blocked session is reported.

      // Short-lived reaction to a care action.
      if (fx.current.until > Date.now()) {
        ctx.fillStyle = cssVar('var(--good)');
        ctx.font = `bold ${px * 2}px ui-sans-serif, system-ui`;
        ctx.fillText(fx.current.kind, 4 * px, 5 * px);
      }

      frame.current = f + 1;
      raf = window.setTimeout(() => { raf = requestAnimationFrame(draw); }, reduce ? 500 : 125) as unknown as number;
    };
    draw();
    return () => { cancelAnimationFrame(raf); clearTimeout(raf); };
  }, [pet, mood, stage]);

  /* ── care ──────────────────────────────────────────────────────────── */
  const react = (glyph: string, msg: string) => {
    fx.current = { kind: glyph, until: Date.now() + 1400 };
    setSay(msg);
    window.setTimeout(() => setSay(null), 3200);
  };

  const feed = (snack: boolean) => update((p) => {
    if (p.dead || p.asleep) return p;
    react(snack ? '🍬' : '🍖', snack ? 'A treat. Sweet, and not filling.' : 'Fed.');
    return {
      ...p,
      hunger: clamp(p.hunger - (snack ? 8 : 34)),
      happy: clamp(p.happy + (snack ? 9 : 4)),
      weight: p.weight + (snack ? 1 : 2),
      meals: p.meals + 1, need: 'none', needSince: null,
    };
  });

  const clean = () => update((p) => {
    if (p.dead || !p.poops) return p;
    react('✨', 'Cleaned up.');
    return { ...p, poops: 0, happy: clamp(p.happy + 5), sick: p.poops >= 3 ? p.sick : p.sick };
  });

  const medicine = () => update((p) => {
    if (p.dead || !p.sick) return p;
    react('💊', 'Medicine given. It looks better already.');
    return { ...p, sick: false, health: clamp(p.health + 25), happy: clamp(p.happy - 4), need: 'none', needSince: null };
  });

  const light = () => update((p) => {
    if (p.dead) return p;
    const off = !p.lightsOff;
    react(off ? '🌙' : '☀', off ? 'Lights off.' : 'Lights on.');
    return { ...p, lightsOff: off, asleep: off ? p.asleep : false };
  });

  const startGame = () => {
    if (pet.dead || pet.asleep || pet.energy < 12) return;
    setGame({ round: 0, wins: 0, face: Math.random() < 0.5 ? -1 : 1 });
    setSay('Which way will it look? Guess left or right.');
  };

  const guess = (dir: -1 | 1) => {
    if (!game) return;
    const won = dir === game.face;
    const wins = game.wins + (won ? 1 : 0);
    const round = game.round + 1;
    if (round >= 5) {
      setGame(null);
      update((p) => {
        const good = wins >= 3;
        react(good ? '🎉' : '🙂', `${wins} of 5. ${good ? 'It had a great time.' : 'It had an alright time.'}`);
        return {
          ...p,
          happy: clamp(p.happy + (good ? 26 : 12)),
          energy: clamp(p.energy - 14),
          hunger: clamp(p.hunger + 6),
          need: 'none', needSince: null,
        };
      });
    } else {
      setGame({ round, wins, face: Math.random() < 0.5 ? -1 : 1 });
      setSay(won ? `Right! ${wins}/${round}` : `Missed. ${wins}/${round}`);
    }
  };

  /*
   * Discipline answers the call that wants nothing. Feeding it instead is the
   * mistake — and on the P1 that is what decides the adult, not care quality.
   */
  const scold = () => update((p) => {
    if (p.dead || p.need !== 'discipline') return p;
    react('📖', 'Disciplined. That is what it was asking for.');
    return {
      ...p, need: 'none', needSince: null,
      discipline: clamp(p.discipline + 25), happy: clamp(p.happy - 6),
    };
  });

  const hatch = () => update(() => {
    const next = fresh(pet.generation + 1);
    react('🥚', 'A new egg.');
    return next;
  });

  const bar = (k: string, v: number, tone: string, invert = false) => {
    const pct = invert ? 100 - v : v;
    return (
      <div className="pet-bar">
        <span className="k">{k}</span>
        <span className="t"><span className="f" style={{ width: `${pct}%`, background: tone }} /></span>
      </div>
    );
  };

  const left = pet.needSince
    ? Math.max(0, Math.ceil((pet.needSince + CARE_WINDOW_MIN * 60_000 - Date.now()) / 60_000))
    : 0;

  const hatchesIn = Math.max(0, Math.ceil((pet.born + HATCH_MIN * 60_000 - Date.now()) / 60_000));

  const caption = pet.dead
    ? `${pet.name} died at ${ageText(pet.born)} old.`
    : stage === 'egg'
      ? `The egg hatches in ${hatchesIn}m. Nothing to do until it does.`
    : say ?? (
      // The attention flag outranks everything, and says how long is left —
      // fifteen minutes is the whole mechanic, so it should never be a guess.
      pet.need === 'discipline' ? `Calling for nothing. Discipline it — ${left}m left.`
      : pet.need === 'sick' ? `Sick. Medicine — ${left}m before that is a care mistake.`
      : pet.need === 'hungry' ? `Starving. Feed it — ${left}m left.`
      : pet.need === 'unhappy' ? `Miserable. Play with it — ${left}m left.`
      // The flag comes down once the mistake is recorded, but the meter is
      // still empty. Saying "Content." here would be a lie, and the health
      // drain would look like it came from nowhere.
      : pet.sick ? 'Still sick. The care mistake is already recorded — medicine stops the damage, not the record.'
      : pet.hunger >= 100 ? 'Still starving. The care mistake is already recorded — feeding it stops the health drain.'
      : pet.happy <= 0 ? 'Still miserable. The care mistake is already recorded — playing stops the health drain.'
      : pet.poops >= 2 ? 'It has made a mess. Three and it falls ill.'
      : pet.asleep ? 'Asleep.'
      : 'Content.'
    );

  /*
   * Collapsed still says whether the toy has something pending — but quietly,
   * and about the toy. "Needs you" in the warning token, in the rail that
   * carries the attention queue, put a game on the same footing as a session
   * that is actually blocked on an answer.
   */
  const carePending = !pet.dead && (pet.need !== 'none' || needOf(pet) !== 'none' || pet.poops >= 2);

  return (
    <div className={`pet${open ? '' : ' shut'}`}>
      <div className="pet-name">
        <button className="pet-toggle" aria-expanded={open} onClick={toggle}
                title={open ? 'Hide the pet' : 'Show the pet'}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {renaming ? (
          <input autoFocus value={pet.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value.slice(0, 14) }))}
                 onBlur={() => setRenaming(false)} onKeyDown={(e) => { if (e.key === 'Enter') setRenaming(false); }} />
        ) : (
          <>
            <button className="n" style={{ background: 'none', border: 'none', padding: 0, cursor: 'text', color: 'inherit' }}
                    title="Rename" onClick={() => setRenaming(true)}>{pet.name}</button>
            <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
              {characterOf(pet)}{pet.generation > 1 ? ` · gen ${pet.generation}` : ''}
            </span>
            <span className="age">{ageText(pet.born)}</span>
            {!open && carePending && (
              <span className="pet-alert" title={caption}>
                <span aria-hidden="true">◦</span> care due
              </span>
            )}
          </>
        )}
      </div>

      {open && <>
      <div className={`pet-screen${pet.lightsOff && !pet.dead ? ' dark' : ''}`}>
        <canvas ref={cv} className="pet-canvas" role="img"
                aria-label={`${pet.name}, ${stage}, ${caption}`} />
      </div>

      <div className="pet-bars">
        {bar('food', pet.hunger, 'var(--series-4)', true)}
        {bar('mood', pet.happy, 'var(--series-1)')}
        {bar('pep', pet.energy, 'var(--series-3)')}
        {bar('life', pet.health, pet.health < 35 ? 'var(--bad)' : 'var(--good)')}
      </div>

      <div className="pet-say">{caption}</div>
      <div className="pet-bar" style={{ fontSize: 'var(--t-micro)' }}>
        <span className="k" style={{ width: 'auto' }}>
          care miss <b style={{ color: pet.careMistakes >= 3 ? 'var(--bad)' : 'var(--text-dim)' }}>{pet.careMistakes}</b>
          {'  '}· discipline miss <b style={{ color: pet.disciplineMistakes >= 3 ? 'var(--warning)' : 'var(--text-dim)' }}>{pet.disciplineMistakes}</b>
        </span>
      </div>

      {pet.dead ? (
        <button className="btn btn-primary" style={{ fontSize: 'var(--t-micro)' }} onClick={hatch}>Hatch a new egg</button>
      ) : game ? (
        <div className="pet-play">
          <button className="btn" onClick={() => guess(-1)}>◀ left</button>
          <button className="btn" onClick={() => guess(1)}>right ▶</button>
        </div>
      ) : (
        <div className="pet-acts">
          <button className="pet-btn" disabled={pet.asleep} onClick={() => feed(false)}
                  title="A proper meal"><span className="ic">🍖</span>feed</button>
          <button className="pet-btn" disabled={pet.asleep} onClick={() => feed(true)}
                  title="Sweet, not filling"><span className="ic">🍬</span>snack</button>
          <button className="pet-btn" disabled={pet.asleep || pet.energy < 12} onClick={startGame}
                  title="Guess which way it looks"><span className="ic">🎮</span>play</button>
          <button className={`pet-btn${pet.poops ? ' urgent' : ''}`} disabled={!pet.poops} onClick={clean}
                  title="Clear the mess before it makes them sick"><span className="ic">🧹</span>clean</button>
          <button className={`pet-btn${pet.sick ? ' sick' : ''}`} disabled={!pet.sick} onClick={medicine}
                  title="Cure the sickness"><span className="ic">💊</span>meds</button>
          <button className={`pet-btn${pet.need === 'discipline' ? ' urgent' : ''}`}
                  disabled={pet.need !== 'discipline'} onClick={scold}
                  title="It is calling for nothing — discipline decides the adult it becomes">
            <span className="ic">📖</span>scold</button>
          <button className="pet-btn" onClick={light}
                  title="Lights off helps it sleep"><span className="ic">{pet.lightsOff ? '🌙' : '💡'}</span>light</button>
        </div>
      )}
      </>}
    </div>
  );
}

/**
 * The gate. Off by default, and the check wraps the component rather than
 * living inside it: a pet that is switched off should not be running a
 * fifteen-second tick and a canvas loop, it should not exist.
 */
export default function Pet() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => {
      window.wanigan.prefs.all()
        .then((p) => { if (live) setOn(p.pet); })
        .catch(() => { if (live) setOn(false); });
    };
    read();
    window.addEventListener('wanigan:prefs-changed', read);
    return () => { live = false; window.removeEventListener('wanigan:prefs-changed', read); };
  }, []);
  return on ? <PetInner /> : null;
}
