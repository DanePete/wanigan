// Models that run on this Mac. Optional throughout: without LM Studio (or a
// running Ollama or NVIDIA PAIR) nothing here appears, and nothing downloads
// until the owner asks with the size in front of them.
//
// A module is one model Wanigan knows how to run: which agent it runs under,
// how it is loaded, how big it is, and whether that pairing has been proven by
// a real turn with a tool call. A model found on a local server that no module
// describes is offered too, as not proven with that agent.
//
// A local model is chosen like any model: its value is
// `local/<runtime>/<model id>`, kept in the session's model, so resuming keeps
// it. The core turns it into the agent's own settings at launch.
import type { Provider } from './model.ts';
import type { ModelChoice } from './models.ts';

export const LOCAL_RUNTIMES = ['lmstudio', 'ollama'] as const;
export type LocalRuntime = (typeof LOCAL_RUNTIMES)[number];

export const RUNTIME_LABEL: Record<LocalRuntime, string> = { lmstudio: 'LM Studio', ollama: 'Ollama' };

/** The agents a local model can run under. */
export type LocalAgent = Extract<Provider, 'claude' | 'codex'>;

export interface LocalModule {
  id: string;
  label: string;
  /** Who makes it, for grouping: "Qwen". */
  family: string;
  summary: string;
  runtime: 'lmstudio';
  /** The model as LM Studio names it, for `lms get` and `lms load`. */
  key: string;
  format: 'mlx';
  /** What `lms get` downloads, measured. Shown before anything is fetched. */
  downloadBytes: number;
  agent: LocalAgent;
  /** Tokens it is loaded with. An agent's instructions and tools alone take tens of thousands. */
  contextLength: number;
  /** A real turn with a tool call, read back, or null while not yet proven. */
  proven: { on: string; detail: string } | null;
}

export const LOCAL_MODULES: readonly LocalModule[] = [
  {
    id: 'qwen3-coder-30b',
    label: 'Qwen3-Coder 30B',
    family: 'Qwen',
    summary: 'Alibaba’s coding model. 30B parameters with 3.3B active per token, so it is quick on Apple silicon.',
    runtime: 'lmstudio',
    key: 'qwen/qwen3-coder-30b',
    format: 'mlx',
    downloadBytes: 17_190_000_000,
    agent: 'claude',
    contextLength: 65_536,
    proven: null,
  },
];

export function moduleById(id: unknown): LocalModule | null {
  return LOCAL_MODULES.find((m) => m.id === id) ?? null;
}

/* ── model values ────────────────────────────────────────────────────────── */

const PREFIX = 'local/';

export function localModelValue(runtime: LocalRuntime, id: string): string {
  return `${PREFIX}${runtime}/${id}`;
}

/** A local model value's runtime and model id, or null when the value is not a local model. */
export function parseLocalModel(value: string | null | undefined): { runtime: LocalRuntime; id: string } | null {
  if (!value?.startsWith(PREFIX)) return null;
  const rest = value.slice(PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 1) return null;
  const runtime = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (!(LOCAL_RUNTIMES as readonly string[]).includes(runtime) || !id || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,90}$/.test(id)) return null;
  return { runtime: runtime as LocalRuntime, id };
}

/** The module that describes a model on a runtime, if any. */
export function moduleFor(runtime: LocalRuntime, id: string): LocalModule | null {
  return LOCAL_MODULES.find((m) => m.runtime === runtime && (m.key === id || id.startsWith(`${m.key}@`))) ?? null;
}

/** A local model's name for people: the module's label, or the id as the runtime gave it. */
export function localModelLabel(value: string | null | undefined): string | null {
  const local = parseLocalModel(value);
  if (!local) return null;
  return moduleFor(local.runtime, local.id)?.label ?? local.id;
}

/* ── what the core reports ───────────────────────────────────────────────── */

export interface LocalModelInfo {
  runtime: LocalRuntime;
  id: string;
  /** Bytes on disk, when the runtime says. */
  sizeBytes: number | null;
  /** Loaded into memory now (LM Studio). */
  loaded: boolean;
  /** The module that describes it, by id. */
  module: string | null;
}

export interface DownloadState {
  module: string;
  state: 'downloading' | 'failed' | 'done';
  /** 0..1, when known. */
  fraction: number | null;
  /** What LM Studio printed last, cleaned: "11.18 GB / 17.19 GB · 37.69 MB/s · ETA 02:39". */
  detail: string | null;
  error: string | null;
  startedAt: number;
}

export interface LocalStatus {
  lmstudio: {
    installed: boolean;
    server: { running: boolean; port: number | null };
    models: LocalModelInfo[];
  };
  /** Ollama, or NVIDIA PAIR's Ollama-compatible address: detected only, never downloaded through. */
  ollama: { running: boolean; models: LocalModelInfo[] };
  modules: { module: LocalModule; downloaded: boolean; download: DownloadState | null }[];
  checkedAt: number;
}

/** Bytes as people read them: "17.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * One line of `lms get` progress, cleaned of terminal codes:
 * "⠼ [██▍ ] 65.06% | 11.18 GB / 17.19 GB | 37.69 MB/s | ETA 02:39".
 */
export function parseLmsProgress(line: string): { fraction: number; detail: string } | null {
  const m = /(\d+(?:\.\d+)?)%\s*\|\s*([\d.]+\s*[KMGT]?B)\s*\/\s*([\d.]+\s*[KMGT]?B)\s*\|\s*([\d.]+\s*[KMGT]?B\/s)\s*\|\s*ETA\s*([\d:]+)/.exec(line);
  if (!m) return null;
  const fraction = Math.min(1, Math.max(0, Math.round(Number(m[1]) * 100) / 10_000));
  return { fraction, detail: `${m[2]} / ${m[3]} · ${m[4]} · ETA ${m[5]}` };
}

const AGENT_NAME: Record<LocalAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * The local models an agent's picker offers. Nothing without LM Studio or a
 * running Ollama. A module not yet downloaded is listed with its size, and
 * cannot be started until it is on this Mac.
 */
export function localChoices(status: LocalStatus, agent: LocalAgent): ModelChoice[] {
  const choice = (runtime: LocalRuntime, id: string, label: string, detail: string, ready: boolean, proven: boolean): ModelChoice => ({
    value: localModelValue(runtime, id), label, detail, efforts: null, defaultEffort: null, isDefault: false, local: { runtime, ready, proven },
  });
  const out: ModelChoice[] = [];
  if (status.lmstudio.installed) {
    for (const m of status.lmstudio.models) {
      const module = m.module ? moduleById(m.module) : null;
      const proven = !!module && module.agent === agent && module.proven !== null;
      const pairing = module && module.agent === agent ? (proven ? `proven with ${AGENT_NAME[agent]}` : 'not yet proven') : `not proven with ${AGENT_NAME[agent]}`;
      out.push(choice('lmstudio', m.id, module?.label ?? m.id, `On this Mac · LM Studio · ${pairing}`, true, proven));
    }
    for (const { module, downloaded } of status.modules) {
      if (downloaded || module.agent !== agent) continue;
      out.push(choice('lmstudio', module.key, module.label, `Not on this Mac yet · ${formatBytes(module.downloadBytes)} · get it in Settings › Local models`, false, module.proven !== null));
    }
  }
  if (status.ollama.running) {
    for (const m of status.ollama.models) out.push(choice('ollama', m.id, m.id, `On this Mac · Ollama or NVIDIA PAIR · not proven with ${AGENT_NAME[agent]}`, true, false));
  }
  return out;
}
