import { contextBridge, ipcRenderer } from 'electron';
import type { LaunchOptions, Project, ProviderInfo, Session } from '../shared/types';

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
  on: {
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
