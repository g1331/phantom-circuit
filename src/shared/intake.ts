import { z } from 'zod';
import type { Task } from './types.ts';

export const intakeConfigurationInput = z
  .object({
    enabled: z.boolean(),
    command: z.string().regex(/^\/[a-z][a-z0-9-]*$/),
    allowedActors: z.array(z.string().regex(/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i)),
    since: z.iso.datetime(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => !value.enabled || value.allowedActors.length > 0, {
    message: '开启接收前请指定允许发起工作的 GitHub 用户',
    path: ['allowedActors'],
  });

export interface SourceActor {
  id: number;
  login: string;
  kind: 'user' | 'bot' | 'unknown';
}

export interface IntakeSource {
  id: string;
  projectId: string;
  repoId: string;
  kind: 'github.issues';
  enabled: boolean;
  command: string;
  allowedActors: SourceActor[];
  since: string;
  version: number;
  health:
    | { status: 'not_connected' }
    | { status: 'healthy'; checkedAt: string }
    | { status: 'unavailable'; checkedAt: string; reason: string };
  createdAt: string;
  updatedAt: string;
}

/** Facts observed from GitHub are immutable, including the actor responsible for the body. */
export interface SourceInput {
  id: string;
  sourceId: string;
  projectId: string;
  repoId: string;
  kind: 'github.issue';
  nativeId: string;
  revision: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: SourceActor;
  actor: SourceActor;
  state: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
  bodyUpdatedAt?: string;
  observedAt: string;
}

export type InputDisposition =
  | { status: 'queued' }
  | { status: 'refused'; reason: string }
  | { status: 'assessing'; messageId: string }
  | { status: 'accepted'; messageId: string; taskId: string }
  | { status: 'no_action'; messageId: string; reason: string }
  | { status: 'awaiting_decision'; messageId: string; clarificationId: string; reason: string }
  | { status: 'unavailable'; reason: string; messageId?: string }
  | { status: 'context_only'; reason: string; taskId?: string };

export interface InputAssessment {
  id: string;
  inputId: string;
  sourceId: string;
  projectId: string;
  repoId: string;
  policyVersion: number;
  /** Fixed admission evidence survives later source-policy changes. */
  admission?: { actorId: number; command: string; inputId: string; policyVersion: number };
  disposition: InputDisposition;
  createdAt: string;
  updatedAt: string;
}

/** An external human message retains its own origin instead of impersonating a local user. */
export interface ExternalMessageOrigin {
  kind: 'github.issue';
  inputId: string;
  assessmentId: string;
  issue: number;
  url: string;
  actor: SourceActor;
}

export type SourceReplyPurpose =
  | { kind: 'outcome'; taskId: string }
  | { kind: 'question'; clarificationId: string }
  | { kind: 'no_action' };

export interface SourceReply {
  id: string;
  inputId: string;
  projectId: string;
  repoId: string;
  issue: number;
  purpose: SourceReplyPurpose;
  body: string;
  state:
    | { status: 'queued' }
    | { status: 'sent'; url: string; sentAt: string }
    | { status: 'uncertain'; reason: string }
    | { status: 'unavailable'; reason: string };
  createdAt: string;
}

export interface WorkflowPage {
  sources: IntakeSource[];
  admissionPaused: boolean;
  inputs: {
    input: Omit<SourceInput, 'body'>;
    assessment: InputAssessment;
    replies: Omit<SourceReply, 'body'>[];
    task?: Pick<Task, 'id' | 'title' | 'stage' | 'control' | 'blocked' | 'completion'>;
  }[];
  next?: string;
}

export interface WorkflowInputDetail {
  input: SourceInput;
  assessment: InputAssessment;
  replies: SourceReply[];
}
