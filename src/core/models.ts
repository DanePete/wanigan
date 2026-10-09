// The models each agent offers, for the New session dialog. Claude Code's are
// Wanigan's published list (the CLI cannot be asked without a turn); Codex's are
// read from the installed CLI's app-server as the chosen account, which costs
// nothing and is cached for a few minutes.
import { CLAUDE_EFFORTS, CLAUDE_MODELS, GEMINI_MODELS, type ModelCatalogue, type ModelChoice } from '../shared/models.ts';
import type { Provider } from '../shared/model.ts';
import { localChoices } from '../shared/local-models.ts';
import type { Accounts } from './accounts.ts';
import type { LocalModels } from './local-models.ts';
import { readCodexModels } from './codex-server.ts';
import { requireCli } from './environment.ts';

const CACHE_MS = 10 * 60_000;
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

export type CodexModelReader = (configDir: string | null) => Promise<ModelChoice[]>;

const readInstalledCodex: CodexModelReader = async (configDir) => {
  const { bin, path } = await requireCli('codex');
  return readCodexModels(bin, configDir, path);
};

export class Models {
  private readonly accounts: Accounts;
  private readonly readCodex: CodexModelReader;
  private readonly cache = new Map<string, { at: number; value: ModelCatalogue }>();
  private readonly local: Pick<LocalModels, 'status'> | null;

  constructor(accounts: Accounts, readCodex: CodexModelReader = readInstalledCodex, local: Pick<LocalModels, 'status'> | null = null) {
    this.accounts = accounts;
    this.readCodex = readCodex;
    this.local = local;
  }

  /** The agent's own models, then any on this Mac. */
  async catalogue(provider: Provider, accountId: string | null, projectId: string | null): Promise<ModelCatalogue> {
    const own = await this.own(provider, accountId, projectId);
    if (!this.local || (provider !== 'claude' && provider !== 'codex')) return own;
    let status;
    try { status = await this.local.status(); } catch { return own; }
    const local = localChoices(status, provider);
    return local.length ? { ...own, models: [...own.models, ...local] } : own;
  }

  private async own(provider: Provider, accountId: string | null, projectId: string | null): Promise<ModelCatalogue> {
    if (provider === 'shell') return { provider, models: [], efforts: [], source: 'none', note: null };
    if (provider === 'gemini') {
      return { provider, models: [...GEMINI_MODELS], efforts: [], source: 'published', note: 'Gemini CLI’s aliases and models. A newer one works if you type it.' };
    }
    if (provider === 'claude') {
      return {
        provider, models: [...CLAUDE_MODELS], efforts: [...CLAUDE_EFFORTS], source: 'published',
        note: 'Claude Code cannot say which models it runs without a turn, so these are the aliases and models it accepts. A newer one works if you type it.',
      };
    }
    const account = this.accounts.resolve(projectId ?? '', 'codex', accountId);
    const key = account?.configDir ?? '';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value: ModelCatalogue;
    try {
      const models = await this.readCodex(account?.configDir ?? null);
      const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))];
      value = {
        provider, models, efforts: efforts.length ? efforts : CODEX_EFFORTS, source: 'live',
        note: models.length ? null : 'Codex listed no models for this account.',
      };
      this.cache.set(key, { at: Date.now(), value });
    } catch (error) {
      value = {
        provider, models: [], efforts: CODEX_EFFORTS, source: 'none',
        note: `Wanigan could not read Codex’s models (${(error as Error).message}). Its default model still works.`,
      };
    }
    return value;
  }
}
