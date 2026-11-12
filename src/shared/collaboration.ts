import type { ProfileName } from './types.ts';

/** Native input identity includes its revision; edits are new inputs, polling is not. */
export interface FollowUp {
  id: string;
  taskId: string;
  projectId: string;
  source: 'web' | 'github';
  kind: 'comment' | 'review' | 'check';
  nativeId: string;
  revision: string;
  author: string;
  actorId?: number;
  actorAssociation?: string;
  sourceTime?: string;
  url?: string;
  replyIssue?: number;
  head?: string;
  body: string;
  receivedAt: string;
  status: 'queued' | 'processing' | 'accepted' | 'resolved' | 'handed_back';
  runId?: string;
  disposition?: {
    action: 'rework' | 'ignore' | 'clarify';
    reason: string;
    at: string;
  };
  reply?: { status: 'pending' | 'sent' | 'uncertain'; url?: string; error?: string };
}

export interface Collaboration {
  id: string;
  taskId: string;
  projectId: string;
  ownerRunId: string;
  requestKey: string;
  objective: string;
  profile: Exclude<ProfileName, 'pm' | 'review'>;
  mode: 'read' | 'write';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  worktree?: string;
  base?: string;
  runId?: string;
  result?: string;
  error?: string;
  integratedAt?: string;
  createdAt: string;
  updatedAt: string;
}
