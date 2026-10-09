// Models on this Mac, through LM Studio, and the ones a running Ollama (or NVIDIA
// PAIR, which answers at Ollama's address) offers. What is shared about them —
// modules, values, what the window is told — is in shared/local-models.ts.
//
// Rules learned running them:
// - LM Studio's server is not always on 1234 (another app may hold it): its
//   port is read from `lms server status --json`, never assumed.
// - `lms get` starts downloading at once when the model is unambiguous; it never
//   asks first. So the size is shown, and the disk checked, before it is run.
// - Hugging Face rate-limits large downloads (HTTP 429). A failed download says
//   why, and Get resumes where it stopped.
// - An agent's instructions and tools alone take tens of thousands of tokens,
//   so a model is loaded with its module's context, not LM Studio's default.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCAL_MODULES, formatBytes, moduleById, moduleFor, parseLmsProgress, parseLocalModel,
  type DownloadState, type LocalAgent, type LocalModelInfo, type LocalStatus,
} from '../shared/local-models.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Ctx } from './context.ts';

/** Free space a download must leave behind, so the Mac is never filled to the brim. */
const DISK_HEADROOM = 10_000_000_000;
/** A context for a local model no module describes. */
const DEFAULT_CONTEXT = 32_768;
const STATUS_CACHE_MS = 3_000;

export interface LmsResult { code: number; stdout: string; stderr: string }
export type RunLms = (bin: string, args: string[], timeoutMs: number) => Promise<LmsResult>;
export type SpawnLms = (bin: string, args: string[]) => ChildProcess;
export type FetchJson = (url: string, timeoutMs: number) => Promise<unknown>;

interface DownloadAttempt { child: ChildProcess | null; cancelled: boolean }

export interface LocalModelsOptions {
  home: string;
  /** Where `lms` is, or null to look in the home's LM Studio folder. Tests pass a stand-in. */
  lmsBin?: string | null;
  /** Ollama's address (NVIDIA PAIR answers here too). */
  ollamaUrl?: string;
  runLms?: RunLms;
  spawnLms?: SpawnLms;
  fetchJson?: FetchJson;
  /** Bytes free where models are kept; a seam for tests. */
  freeBytes?: (path: string) => number;
}

/** What a session needs to run on a local model. */
export interface LocalLaunch {
  args: string[];
  env: Record<string, string>;
  /** Variables the agent must not inherit (the account's own key would win over the local server). */
  unset: string[];
  /** For the session's record and the owner: "Qwen3-Coder 30B on LM Studio". */
  label: string;
}

const runLmsDefault: RunLms = (bin, args, timeoutMs) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

const spawnLmsDefault: SpawnLms = (bin, args) => spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });

const fetchJsonDefault: FetchJson = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const freeBytesDefault = (path: string): number => {
  const s = statfsSync(path);
  return s.bavail * s.bsize;
};

/** Terminal output as text: colours and cursor moves out, carriage-return redraws as lines. */
export function plainLines(chunk: string): string[] {
  return chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
}

export class LocalModels {
  private readonly ctx: Ctx;
  private readonly options: LocalModelsOptions;
  private readonly runLms: RunLms;
  private readonly spawnLms: SpawnLms;
  private readonly fetchJson: FetchJson;
  private readonly freeBytes: (path: string) => number;
  private readonly downloads = new Map<string, DownloadState>();
  private readonly attempts = new Map<string, DownloadAttempt>();
  private stopping = false;
  private cached: { at: number; value: Promise<LocalStatus> } | null = null;
  private lastEmit = 0;

  constructor(ctx: Ctx, options: LocalModelsOptions) {
    this.ctx = ctx;
    this.options = options;
    this.runLms = options.runLms ?? runLmsDefault;
    this.spawnLms = options.spawnLms ?? spawnLmsDefault;
    this.fetchJson = options.fetchJson ?? fetchJsonDefault;
    this.freeBytes = options.freeBytes ?? freeBytesDefault;
  }

  /** The `lms` command, or null when LM Studio is not installed. */
  lmsBin(): string | null {
    if (this.options.lmsBin !== undefined) return this.options.lmsBin;
    const bin = join(this.options.home, '.lmstudio', 'bin', 'lms');
    return existsSync(bin) ? bin : null;
  }

  get busy(): boolean {
    return this.attempts.size > 0;
  }

  /** What is on this Mac. Cached for a moment: the window asks often. */
  status(fresh = false): Promise<LocalStatus> {
    if (!fresh && this.cached && this.ctx.now() - this.cached.at < STATUS_CACHE_MS) return this.cached.value;
    const value = this.read();
    this.cached = { at: this.ctx.now(), value };
    value.catch(() => { if (this.cached?.value === value) this.cached = null; });
    return value;
  }

  private async read(): Promise<LocalStatus> {
    const bin = this.lmsBin();
    const [server, listed, loaded, ollama] = await Promise.all([
      bin ? this.serverStatus(bin) : Promise.resolve({ running: false, port: null }),
      bin ? this.listed(bin) : Promise.resolve([]),
      bin ? this.loadedKeys(bin) : Promise.resolve(new Set<string>()),
      this.ollamaModels(),
    ]);
    const models: LocalModelInfo[] = listed.map((m) => ({ ...m, loaded: loaded.has(m.id) }));
    return {
      lmstudio: { installed: !!bin, server, models },
      ollama,
      modules: LOCAL_MODULES.map((module) => ({
        module,
        downloaded: models.some((m) => m.module === module.id),
        download: this.downloads.get(module.id) ?? null,
      })),
      checkedAt: this.ctx.now(),
    };
  }

  private async serverStatus(bin: string): Promise<{ running: boolean; port: number | null }> {
    const r = await this.runLms(bin, ['server', 'status', '--json'], 10_000);
    try {
      const s = JSON.parse(r.stdout) as { running?: unknown; port?: unknown };
      const port = typeof s.port === 'number' && Number.isInteger(s.port) && s.port > 0 && s.port < 65536 ? s.port : null;
      return { running: s.running === true && port !== null, port };
    } catch {
      return { running: false, port: null };
    }
  }

  /** LLMs on disk. Embedding models are not agents and are left out. */
  private async listed(bin: string): Promise<Omit<LocalModelInfo, 'loaded'>[]> {
    const r = await this.runLms(bin, ['ls', '--llm', '--json'], 15_000);
    let raw: unknown;
    try { raw = JSON.parse(r.stdout); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((m) => {
      const o = m && typeof m === 'object' ? m as Record<string, unknown> : {};
      const id = typeof o.modelKey === 'string' ? o.modelKey : null;
      if (!id || (o.type !== undefined && o.type !== 'llm') || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,90}$/.test(id)) return [];
      return [{ runtime: 'lmstudio' as const, id, sizeBytes: typeof o.sizeBytes === 'number' ? o.sizeBytes : null, module: moduleFor('lmstudio', id)?.id ?? null }];
    });
  }

  private async loadedKeys(bin: string): Promise<Set<string>> {
    const r = await this.runLms(bin, ['ps', '--json'], 10_000);
    try {
      const raw = JSON.parse(r.stdout) as unknown;
      return new Set((Array.isArray(raw) ? raw : []).flatMap((m) => {
        const o = m && typeof m === 'object' ? m as Record<string, unknown> : {};
        return [o.modelKey, o.identifier].filter((v): v is string => typeof v === 'string');
      }));
    } catch {
      return new Set();
    }
  }

  private async ollamaModels(): Promise<{ running: boolean; models: LocalModelInfo[] }> {
    const base = this.options.ollamaUrl ?? 'http://127.0.0.1:11434';
    try {
      const raw = await this.fetchJson(`${base}/api/tags`, 1_500) as { models?: unknown };
      const list = Array.isArray(raw?.models) ? raw.models : [];
      return {
        running: true,
        models: list.flatMap((m) => {
          const o = m && typeof m === 'object' ? m as Record<string, unknown> : {};
          const id = typeof o.name === 'string' ? o.name : typeof o.model === 'string' ? o.model : null;
          if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,90}$/.test(id)) return [];
          return [{ runtime: 'ollama' as const, id, sizeBytes: typeof o.size === 'number' ? o.size : null, loaded: false, module: null }];
        }),
      };
    } catch {
      return { running: false, models: [] };
    }
  }

  /** Start LM Studio's server. */
  async startServer(): Promise<LocalStatus> {
    const bin = this.mustLms();
    const r = await this.runLms(bin, ['server', 'start'], 60_000);
    if (r.code !== 0) throw new CoreError('refused', `LM Studio’s server did not start: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
    this.changed();
    return this.status(true);
  }

  /**
   * Download a module's model through LM Studio. Only a module can be fetched,
   * never a name from the window, and only with room left on the disk.
   */
  async download(moduleId: unknown): Promise<LocalStatus> {
    const module = moduleById(moduleId);
    if (!module) throw new CoreError('invalid', 'Wanigan has no such local model.');
    if (this.stopping) throw new CoreError('refused', 'Wanigan’s core is stopping. Try again after it restarts.');
    const bin = this.mustLms();
    const previous = this.attempts.get(module.id);
    if (previous) throw new CoreError('refused', previous.cancelled ? `${module.label} is still stopping. Try again shortly.` : `${module.label} is already downloading.`);
    // Reserve before the first await: owner RPCs may reach this together.
    const attempt: DownloadAttempt = { child: null, cancelled: false };
    this.attempts.set(module.id, attempt);
    try {
      const status = await this.status(true);
      if (this.stopping) throw new CoreError('refused', 'Wanigan’s core is stopping. Try again after it restarts.');
      if (attempt.cancelled) throw new CoreError('refused', `${module.label} was stopped before downloading.`);
      if (status.modules.find((m) => m.module.id === module.id)?.downloaded) throw new CoreError('refused', `${module.label} is already on this Mac.`);
      const where = join(this.options.home, '.lmstudio');
      let free: number;
      try { free = this.freeBytes(existsSync(where) ? where : this.options.home); }
      catch {
        throw new CoreError('refused', 'Wanigan could not check free disk space. Check that your home and LM Studio folders are accessible, then try again.');
      }
      if (!Number.isFinite(free) || free < 0) throw new CoreError('refused', 'Wanigan did not get valid free disk space. Check that your home and LM Studio folders are accessible, then try again.');
      // What is already on disk of a stopped download is not counted: the check is
      // that the whole model would fit, which is what the owner was shown.
      if (free < module.downloadBytes + DISK_HEADROOM) {
        throw new CoreError('refused', `${module.label} needs ${formatBytes(module.downloadBytes)}, and this Mac has ${formatBytes(free)} free. Wanigan keeps ${formatBytes(DISK_HEADROOM)} spare, so free up some space first.`);
      }
      const state: DownloadState = { module: module.id, state: 'downloading', fraction: null, detail: null, error: null, startedAt: this.ctx.now() };
      this.downloads.set(module.id, state);
      let child: ChildProcess;
      try { child = this.spawnLms(bin, ['get', module.key, `--${module.format}`, '--yes']); }
      catch (error) {
        state.state = 'failed';
        state.error = error instanceof Error ? error.message : String(error);
        this.changed(true);
        throw error;
      }
      attempt.child = child;
      let tail = '';
      const read = (chunk: Buffer): void => {
        for (const line of plainLines(chunk.toString('utf8'))) {
          const progress = parseLmsProgress(line);
          if (progress) { state.fraction = progress.fraction; state.detail = progress.detail; } else tail = line;
        }
        this.changed();
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.on('error', (error) => { tail = error.message; });
      child.on('close', (code) => {
        if (this.attempts.get(module.id) === attempt) this.attempts.delete(module.id);
        if (state.state === 'downloading') {
          if (code === 0 && !/error|failed/i.test(tail)) { state.state = 'done'; state.fraction = 1; }
          else { state.state = 'failed'; state.error = tail.replace(/^Error:\s*/, '') || `LM Studio stopped (exit ${code ?? 'signal'}).`; }
        }
        this.changed(true);
      });
      this.changed(true);
      return await this.status(true);
    } finally {
      if (!attempt.child && this.attempts.get(module.id) === attempt) this.attempts.delete(module.id);
    }
  }

  /** Stop a download. What was fetched stays, so Get carries on from there. */
  cancel(moduleId: unknown): void {
    const module = moduleById(moduleId);
    const attempt = module ? this.attempts.get(module.id) : undefined;
    if (!module || !attempt) return;
    attempt.cancelled = true;
    const state = attempt.child ? this.downloads.get(module.id)! : {
      module: module.id, state: 'failed' as const, fraction: null, detail: null, error: null, startedAt: this.ctx.now(),
    };
    state.state = 'failed';
    state.error = attempt.child ? 'Stopped. Get carries on from where it stopped.' : 'Stopped before downloading.';
    this.downloads.set(module.id, state);
    attempt.child?.kill('SIGTERM');
    this.changed(true);
  }

  /** Stop every download: the core is stopping. */
  stopAll(): void {
    this.stopping = true;
    for (const attempt of this.attempts.values()) {
      attempt.cancelled = true;
      attempt.child?.kill('SIGTERM');
    }
  }

  /**
   * Make a local model ready and say how to launch an agent on it: the runtime
   * running, the model there and loaded with room for an agent's context.
   */
  async prepare(value: string, agent: LocalAgent): Promise<LocalLaunch> {
    const local = parseLocalModel(value);
    if (!local) throw new CoreError('invalid', 'That is not a local model.');
    const module = moduleFor(local.runtime, local.id);
    if (local.runtime === 'ollama') {
      const ollama = await this.ollamaModels();
      if (!ollama.running) throw new CoreError('refused', 'Ollama is not running on this Mac (nor NVIDIA PAIR at its address). Start it, then start the session again.');
      if (!ollama.models.some((m) => m.id === local.id)) throw new CoreError('refused', `Ollama does not have ${local.id}.`);
      const base = this.options.ollamaUrl ?? 'http://127.0.0.1:11434';
      return agent === 'claude'
        ? claudeOn(base, 'ollama', local.id, `${local.id} on Ollama`)
        : { args: ['--oss', '--local-provider', 'ollama', '-m', local.id], env: {}, unset: [], label: `${local.id} on Ollama` };
    }
    const bin = this.mustLms();
    let status = await this.status(true);
    const listed = status.lmstudio.models.find((m) => m.id === local.id);
    if (!listed) {
      throw new CoreError('refused', module
        ? `${module.label} is not on this Mac yet. Get it in Settings › Local models (${formatBytes(module.downloadBytes)}).`
        : `LM Studio does not have ${local.id}.`);
    }
    if (!status.lmstudio.server.running) status = await this.startServer();
    const port = status.lmstudio.server.port;
    if (!port) throw new CoreError('refused', 'LM Studio’s server did not say which port it is on.');
    if (!listed.loaded) {
      const context = module?.contextLength ?? DEFAULT_CONTEXT;
      // LM Studio's own estimate first: `--yes` would load a model its guardrails
      // say will not fit, and the Mac then swaps until nothing answers in time.
      const estimate = await this.runLms(bin, ['load', local.id, '--context-length', String(context), '--estimate-only'], 60_000);
      if (estimate.code !== 0) throw new CoreError('refused', `LM Studio could not estimate memory for ${module?.label ?? local.id}: ${lastLine(estimate.stderr) || lastLine(estimate.stdout) || `exit ${estimate.code}`}. Try again after LM Studio can complete the estimate.`);
      const said = plainLines(`${estimate.stdout}\n${estimate.stderr}`).join('\n');
      if (/will fail to load/i.test(said)) {
        const gib = /Estimated Total Memory:\s*([\d.]+)\s*GiB/i.exec(said)?.[1];
        throw new CoreError('refused', `${module?.label ?? local.id} needs ${gib ? `about ${(Number(gib) * 1.073741824).toFixed(1)} GB` : 'more memory than is free'} with room for an agent, by LM Studio’s estimate, and LM Studio says it will not fit in this Mac’s memory now. Close some apps and try again.`);
      }
      const r = await this.runLms(bin, ['load', local.id, '--context-length', String(context), '--yes'], 180_000);
      if (r.code !== 0) throw new CoreError('refused', `LM Studio could not load ${module?.label ?? local.id}: ${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}`);
      this.changed(true);
    }
    const label = `${module?.label ?? local.id} on LM Studio`;
    const base = `http://127.0.0.1:${port}`;
    return agent === 'claude'
      ? claudeOn(base, 'lmstudio', local.id, label, module?.contextLength ?? DEFAULT_CONTEXT)
      // Codex's own LM Studio provider assumes port 1234, so it is given LM Studio's real address.
      : {
        args: ['-c', `model_providers.wanigan-lmstudio={ name = "LM Studio", base_url = "${base}/v1", wire_api = "responses" }`, '-c', 'model_provider="wanigan-lmstudio"', '-m', local.id],
        env: {}, unset: [], label,
      };
  }

  private mustLms(): string {
    const bin = this.lmsBin();
    if (!bin) throw new CoreError('refused', 'LM Studio is not installed. Get it from lmstudio.ai, open it once, then try again.');
    return bin;
  }

  /** Tell the window; progress at most once a second. */
  private changed(now = false): void {
    this.cached = null;
    const t = this.ctx.now();
    if (!now && t - this.lastEmit < 1000) return;
    this.lastEmit = t;
    this.ctx.emit('local', {});
  }
}

/**
 * Claude Code on a server that speaks Anthropic's Messages API: every model it
 * might pick (the main one, helpers, subagents) is the local one, and the
 * account's own credentials are kept out so they cannot win over the server.
 */
function claudeOn(base: string, token: string, model: string, label: string, contextTokens?: number): LocalLaunch {
  return {
    args: ['--model', model],
    env: {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: token,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      // A session on this Mac's model sends Anthropic no telemetry or error reports either.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      // A local model reads Claude Code's opening prompt (tens of thousands of
      // tokens) before its first word, which can take minutes. Claude Code
      // (2.1.293) gives up on a stream after 5 minutes and starts over, throwing
      // the work away; these are its own ceilings (30 minutes), read from its binary.
      API_TIMEOUT_MS: '1860000',
      CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: '1800000',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1800000',
      // Claude Code does not know a local model's window and assumes 200k tokens
      // (2.1.293 says so as it starts); compacting before the window it was loaded
      // with is what keeps a long session from overflowing it. Ollama's is not
      // Wanigan's to know, so it is left to the CLI.
      ...(contextTokens ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens) } : {}),
    },
    unset: ['ANTHROPIC_API_KEY'],
    label,
  };
}

function lastLine(text: string): string {
  return plainLines(text).at(-1)?.slice(0, 300) ?? '';
}
