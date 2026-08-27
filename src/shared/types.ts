export type ProviderId = 'claude' | 'codex';

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  bin: string;
  /** Resolved absolute path, or null when the CLI is not installed. */
  path: string | null;
  version: string | null;
};

export type Project = {
  id: string;
  path: string;
  name: string;
  /** Set when the directory is a git repo. */
  branch: string | null;
  addedAt: number;
};

export type SessionStatus = 'starting' | 'running' | 'exited';

export type Session = {
  id: string;
  providerId: ProviderId;
  projectId: string;
  projectPath: string;
  projectName: string;
  title: string;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
  createdAt: number;
  endedAt: number | null;
  /** Bumped on output while the session is not focused. */
  unread: number;
};

export type LaunchOptions = {
  providerId: ProviderId;
  projectId: string;
  /** Extra CLI flags, split on whitespace. */
  extraArgs?: string;
  /** Initial prompt typed into the session once it is ready. */
  initialPrompt?: string;
};

export type SessionOutput = { sessionId: string; data: string };
