import { contextBridge, ipcRenderer } from 'electron';
import type { LaunchOptions, Project, ProviderInfo, Session, RunConfig, SourceConfig } from '../shared/types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Unwraps the main process envelope so callers see values or thrown errors. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

const api = {
  providers: {
    list: () => call<ProviderInfo[]>('providers:list'),
  },
  projects: {
    list: () => call<Project[]>('projects:list'),
    refresh: () => call<Project[]>('projects:refresh'),
    add: (dir: string) => call<Project>('projects:add', dir),
    pick: () => call<Project | null>('projects:pick'),
    remove: (id: string) => call<Project[]>('projects:remove', id),
  },
  sessions: {
    list: () => call<Session[]>('sessions:list'),
    create: (opts: LaunchOptions) => call<Session>('sessions:create', opts),
    scrollback: (id: string) => call<string>('sessions:scrollback', id),
    kill: (id: string) => call<boolean>('sessions:kill', id),
    close: (id: string) => call<boolean>('sessions:close', id),
    markRead: (id: string) => call<boolean>('sessions:markRead', id),
    reveal: (p: string) => call<boolean>('sessions:reveal', p),
    write: (id: string, data: string) => ipcRenderer.send('sessions:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('sessions:resize', id, cols, rows),
  },
  batch: {
    presets: (projectId?: string) => call<any>('batch:presets', projectId),
    refreshModels: () => call<{ models: unknown[]; fetchedAt: number; source: string }>('batch:refreshModels'),
    insights: () => call<any>('batch:insights'),
    preview: (source: SourceConfig, userTemplate: string) => call<any>('batch:preview', source, userTemplate),
    estimate: (config: RunConfig, observed?: number) => call<any>('batch:estimate', config, observed),
    dryRun: (config: RunConfig, rowIndex?: number) => call<any>('batch:dryRun', config, rowIndex),
    runs: () => call<any[]>('batch:runs'),
    run: (id: string) => call<any>('batch:run', id),
    results: (id: string, status: string, q: string, offset: number) =>
      call<any>('batch:results', id, status, q, offset),
    submit: (config: RunConfig, est?: { input: number; output: number; cost: number }) =>
      call<{ runId: string; batchIds: string[]; requests: number }>('batch:submit', config, est),
    cancel: (id: string) => call<any>('batch:cancel', id),
    retry: (id: string) => call<{ runId: string }>('batch:retry', id),
    remove: (id: string) => call<boolean>('batch:delete', id),
    poll: () => call<any>('batch:poll'),
    exportTo: (id: string, format: 'jsonl' | 'csv') => call<string | null>('batch:export', id, format),
  },
  key: {
    status: () => call<{ present: boolean; fingerprint: string | null; encryptionAvailable: boolean; fromEnv: boolean }>('key:status'),
    set: (k: string) => call<{ detail: string; batches: boolean; fingerprint: string | null }>('key:set', k),
    verify: () => call<{ ok: boolean; detail: string; batches: boolean }>('key:verify'),
    clear: () => call<boolean>('key:clear'),
  },
  on: {
    batchChanged: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on('batch:changed', h);
      return () => ipcRenderer.removeListener('batch:changed', h);
    },
    data: (cb: (p: { sessionId: string; data: string }) => void) => {
      const h = (_e: unknown, p: { sessionId: string; data: string }) => cb(p);
      ipcRenderer.on('session:data', h);
      return () => ipcRenderer.removeListener('session:data', h);
    },
    exit: (cb: (p: { sessionId: string; exitCode: number }) => void) => {
      const h = (_e: unknown, p: { sessionId: string; exitCode: number }) => cb(p);
      ipcRenderer.on('session:exit', h);
      return () => ipcRenderer.removeListener('session:exit', h);
    },
    sessions: (cb: (s: Session[]) => void) => {
      const h = (_e: unknown, s: Session[]) => cb(s);
      ipcRenderer.on('session:list', h);
      return () => ipcRenderer.removeListener('session:list', h);
    },
  },
};

contextBridge.exposeInMainWorld('foreman', api);
export type ForemanApi = typeof api;
