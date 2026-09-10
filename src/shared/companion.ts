import type { AttentionKind, SessionStatus } from './types';

export type CompanionSource = {
  id: string;
  kind: 'project' | 'session';
  targetId: string;
  projectId: string;
  label: string;
};
export type CompanionSession = {
  id: string;
  projectId: string;
  provider: string;
  state: AttentionKind | 'unknown';
  status: SessionStatus;
  createdAt: number;
};
export type CompanionProject = {
  id: string;
  name: string;
  branch: string | null;
  running: number;
  needsYou: number;
  sessions: CompanionSession[];
};
export type CompanionSnapshot = {
  readAt: number;
  projectId: string | null;
  projects: CompanionProject[];
  sources: CompanionSource[];
  totalProjects: number;
  running: number;
  needsYou: number;
  sessionsTruncated: boolean;
  available: boolean;
  models: { id: string; label: string }[];
  defaultModel: string;
};
export type CompanionTurn = {
  id: string;
  question: string;
  answer: string | null;
  sources: CompanionSource[];
  model: string;
  at: number;
  status: 'pending' | 'answered' | 'failed' | 'cancelled';
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};
export type CompanionAsk = { question: string; projectId: string | null; model: string };
