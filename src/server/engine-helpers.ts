import { z } from 'zod';
import type { Codex, ToolSpec } from './codex.ts';
import type { AgentBackend, AgentProfile, AgentUsage } from './agent-backend.ts';
import type { DeliveryRuntime } from './delivery-runtime.ts';
import type { GitHub } from './github.ts';
import type { Intake } from './intake.ts';
import type { Maintenance } from './maintenance.ts';
import { readProjectRecordsInput, RECALL_TOOL } from './pm-context.ts';
import {
  commandSchema,
  jsonSchema,
  reviewPayloadSchema,
  taskInput,
  validReviewQuestions,
} from './schemas.ts';
import { Fault, redact, type Store } from './store.ts';
import type { Workspaces } from './workspaces.ts';
import type {
  Message,
  MessageDescriptor,
  ReviewResult,
  Role,
  Run,
  Task,
  TaskControlContext,
} from '../shared/types.ts';

/** The host only depends on this narrow adapter seam; Codex fakes remain valid constructors. */
export type AgentRuntime = Pick<
  AgentBackend,
  'start' | 'stop' | 'thread' | 'turn' | 'forkReadOnlyThread'
> &
  Partial<Pick<AgentBackend, 'steer' | 'followUp' | 'abort' | 'reconcileSteer' | 'on' | 'off'>>;

export type AgentFactory = () => AgentRuntime;

export type AgentHooks = {
  pmSteer?: true;
  onDelta?: (text: string) => void;
  onUsage?: (usage: AgentUsage) => void;
};

export type PMSteerPhase =
  | { kind: 'preparing' }
  | { kind: 'ready'; threadId: string; turnId: string }
  | { kind: 'ended'; reason: 'completed' | 'cancelled' | 'failed' | 'shutdown' };

export type PMSteerGate = {
  phase: PMSteerPhase;
  changed: Promise<void>;
  wake: () => void;
  tail: Promise<unknown>;
};

export type ActiveExecution = {
  abort: AbortController;
  agent?: AgentRuntime;
  codex?: Codex;
  pmSteer?: PMSteerGate;
};

export const recallTool: ToolSpec = {
  name: RECALL_TOOL,
  description:
    'Read-only recall of this project: full task/message/document records by ids, or summaries of earlier history with "before" (an id) and "limit". Use it when the inline context is clipped or omits something you need.',
  inputSchema: jsonSchema(readProjectRecordsInput),
};

export const ROLE_ALLOWED_TOOLS: Record<Role, string[]> = {
  pm: ['read', 'grep', 'glob'],
  dev: ['read', 'bash', 'edit', 'write', 'grep', 'glob'],
  review: ['read', 'bash', 'grep', 'glob'],
  oncall: ['read', 'bash', 'grep', 'glob'],
};

/** A host-initiated stop for a Run that made no progress; reported as a failure, not a pause. */
export class WatchdogTrip extends Fault {}

export const FAILURE_LIMIT = 3;

export const tripOf = (signal: AbortSignal) =>
  signal.aborted && signal.reason instanceof WatchdogTrip ? signal.reason : undefined;

export interface EngineOptions {
  /** A Run with no backend event for this long is stopped (default 20 minutes). */
  stallMs?: number;
  /** The same command repeated this many times in a row with no edit is a loop (default 5). */
  loopRepeats?: number;
}

/** Loop evidence from one completed item: a command signature, an edit, or nothing relevant. */
export function loopSignal(item: any): string | 'edit' | undefined {
  if (item?.type === 'fileChange') return 'edit';
  if (item?.type === 'commandExecution') return `${item.command} -> ${item.exitCode}`;
  if (item?.type === 'dynamicToolCall') {
    if (['edit', 'write'].includes(item.tool)) return 'edit';
    if (item.tool === 'bash') return `${JSON.stringify(item.arguments)} -> ${item.status}`;
  }
  return undefined;
}

export class ClarificationPause extends Error {
  constructor(readonly clarificationId: string) {
    super(`Clarification ${clarificationId} is waiting for the user`);
    this.name = 'ClarificationPause';
  }
}

export const configureInput = z
  .object({ repoId: z.string(), commands: commandSchema, requiredChecks: z.array(z.string()) })
  .strict();

export const resolveInput = z
  .object({ taskId: z.string(), guidance: z.string().min(1), upgrade: z.boolean() })
  .strict();

export const reconcileIssueInput = z.object({ taskId: z.string() }).strict();

export const feedbackSchema = z
  .object({ action: z.enum(['rework', 'ignore', 'clarify']), reason: z.string().min(1) })
  .strict();

export const documentInput = z
  .object({
    repoId: z.string(),
    path: z.string(),
    content: z.string().min(1).max(30000),
    accepted: z.boolean(),
  })
  .strict();

export const reviseInput = z
  .object({
    taskId: z.string(),
    spec: z.string().min(1).max(30000),
    acceptance: z.array(z.string().min(1)).min(1),
    documentIds: z
      .array(z.string())
      .optional()
      .describe(
        'Accepted documents this Task must write into the repository verbatim at their paths; the host checks them before validation. Never attach a document only for reference. Omit to keep the current attachments; [] removes them.',
      ),
    guidance: z.string().min(1),
    // Naming decides the branch, so it can only be completed before a branch exists.
    changeType: taskInput.shape.changeType,
    scope: taskInput.shape.scope,
    summaryEn: taskInput.shape.summaryEn,
  })
  .strict();

export const requestClarificationInput = z
  .object({
    sourceMessageId: z.string().min(1),
    sourceIntent: z.enum(['discuss', 'implement', 'feedback']).optional(),
    questions: z.array(z.record(z.string(), z.any())).min(1).max(3),
  })
  .strict();

export const submitReviewInput = reviewPayloadSchema.refine(
  validReviewQuestions,
  'Invalid review questions or needs_user approval',
);

// Strict structured replies require every field, including question and option fields.
export const reviewWireInput = reviewPayloadSchema
  .extend({
    questions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            question: z.string().trim().min(1),
            recommendation: z.string(),
            options: z.array(
              z
                .object({ value: z.string().min(1), label: z.string(), description: z.string() })
                .strict(),
            ),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

// The advertised host tool deliberately exposes only the model-owned verdict. Keep accepting the
// older direct adapter shape at the handler boundary so a legacy Codex adapter cannot bypass the
// pinned-evidence check merely because it still sends redundant evidence fields.
export const submitReviewCallInput = reviewPayloadSchema
  .extend({
    head: z.string().optional(),
    base: z.string().optional(),
    tests: z.array(z.any()).optional(),
  })
  .strict()
  .refine(validReviewQuestions, 'Invalid review questions or needs_user approval');

export const diagnosticDescriptor = (code: string, detail?: string): MessageDescriptor => ({
  code,
  ...(detail ? { detail: redact(detail).slice(-3000) } : {}),
});

export type ReviewPayload = {
  approved: boolean;
  summary: string;
  findings: string[];
  verdict?: ReviewResult['verdict'];
  head?: string;
  base?: string;
  tests?: unknown[];
  questions?: z.infer<typeof reviewPayloadSchema>['questions'];
};

/** Normalize contradictory model claims into a deterministic rework result. */
export function normalizeReviewVerdict(
  axis: ReviewResult['axis'],
  input: ReviewPayload,
): ReviewPayload {
  const summary = input.summary.trim();
  const findings = input.findings.filter(
    (finding) => typeof finding === 'string' && finding.trim(),
  );
  if (input.verdict === 'needs_user') return { ...input, summary, findings };
  if (input.verdict === 'pass' && input.approved && findings.length === 0)
    return { ...input, summary, findings };
  if (input.verdict === 'escalate' && axis === 'primary' && input.approved && findings.length === 0)
    return { ...input, summary, findings };
  if (input.verdict === 'rework' && !input.approved && findings.length > 0)
    return { ...input, summary, findings };
  // A secondary reviewer has no further axis to escalate to. A malformed or contradictory
  // response therefore becomes ordinary concrete rework instead of leaving the task reviewing
  // forever. The same rule makes primary contradictions safe and actionable.
  return {
    ...input,
    approved: false,
    verdict: 'rework',
    summary: summary || 'Review verdict is contradictory',
    findings: findings.length ? findings : [summary || 'Review verdict is contradictory'],
  };
}

export function mergeReady(task: Task): boolean {
  const policy2 = task.reviewPolicyVersion === 2 || task.stage !== 'done';
  const primaryResult = task.reviews.find(
    (review) =>
      !review.supersededByRunId &&
      review.axis === 'primary' &&
      review.head === task.head &&
      review.base === task.base,
  );
  const secondaryRequired =
    task.secondaryReviewRequired === true ||
    task.complexity === 'complex' ||
    task.retries > 0 ||
    primaryResult?.verdict === 'escalate';
  const requiredAxes: ReviewResult['axis'][] = policy2
    ? ['primary', ...(secondaryRequired ? (['secondary'] as const) : [])]
    : ['standards', 'spec'];
  return (
    !task.reviewClarificationId &&
    !task.pendingFeedback?.length &&
    !!task.head &&
    !!task.base &&
    task.tests.length > 0 &&
    task.tests.every((x) => x.exitCode === 0 && x.head === task.head) &&
    requiredAxes.every((axis) =>
      task.reviews.some((r) => {
        if (r.supersededByRunId || r.axis !== axis || r.head !== task.head || r.base !== task.base)
          return false;
        if (!r.approved || r.findings.length > 0) return false;
        if (!policy2) return true;
        // Primary escalation is an explicit request for the required secondary pass; it is not
        // itself a blocking finding. Secondary escalation is normalized to rework before storage.
        return r.verdict === 'pass' || (axis === 'primary' && r.verdict === 'escalate');
      }),
    ) &&
    task.reviews
      .filter(
        (r) =>
          !r.supersededByRunId &&
          r.head === task.head &&
          r.base === task.base &&
          requiredAxes.includes(r.axis),
      )
      .every(
        (r) => !r.tests || r.tests.every((test) => test.exitCode === 0 && test.head === task.head),
      )
  );
}

export function acceptedDocumentChanges(
  store: Store,
  projectId: string,
  repoId: string,
  ids: string[],
) {
  return ids.map((key) => {
    const document = store.get('document', key);
    if (
      !document ||
      document.projectId !== projectId ||
      document.repoId !== repoId ||
      !document.accepted
    )
      throw new Fault('只能发布当前仓库中 PM 已接受的设计记录', 409, {
        code: 'document_snapshot_invalid',
        params: { documentId: key },
      });
    return { path: document.path, content: document.content, version: document.version };
  });
}

export interface EngineHost {
  readonly store: Store;
  readonly github: GitHub;
  readonly workspaces: Workspaces;
  readonly dataDir: string;
  readonly intake: Intake;
  readonly maintenance: Maintenance;
  readonly active: Map<string, ActiveExecution>;
  readonly mergeBusy: Set<string>;
  readonly stopping: boolean;
  syncRetryAt: number;
  syncFailures: number;
  readonly deliveryRuntime: Promise<DeliveryRuntime>;
  track<T>(p: Promise<T>): Promise<T>;
  withAgent<T>(
    run: Run,
    fn: (c: AgentRuntime, signal: AbortSignal) => Promise<T>,
    hostAbort?: AbortController,
    hooks?: AgentHooks,
  ): Promise<T>;
  agentProfile(run: Run): AgentProfile;
  saveThread(run: Run, threadId: string): void;
  onTurn(run: Run): (turnId: string) => void;
  structuredTurn<T>(
    codex: AgentRuntime,
    thread: string,
    prompt: string,
    profile: AgentProfile,
    signal: AbortSignal,
    schema: z.ZodType<T>,
    subject: string,
    onTurn?: (id: string) => void,
    accepted?: () => T | undefined,
    wire?: z.ZodType,
  ): Promise<T>;
  pauseReason(error: unknown): string;
  pmQueue<T>(projectId: string, fn: () => Promise<T>, urgent?: boolean): Promise<T>;
  pmTurn(
    projectId: string,
    content: string,
    source?: Message,
    task?: Task,
    trigger?: string,
    recoveryItemId?: string,
    existingRun?: Run,
    coordinatingOwnerRunId?: string,
  ): Promise<string>;
  pmTrigger(run: Run, source: string, message?: Message, summary?: string): void;
  pmContext(projectId: string): string;
  technical(task: Task, question: string, trigger?: string, urgent?: boolean): Promise<string>;
  block(taskId: string, reason: string, context?: TaskControlContext): void;
  rework(task: Task, reason: string, spend?: boolean, phase?: 'implement' | 'finalize'): void;
  incidentForRun(run: Run, error: unknown, phase: string, incidentId?: string): Promise<unknown>;
  incidentForTask(task: Task, error: unknown, phase: string): Promise<unknown>;
  resolveIncident(
    projectId: string,
    incidentId: string,
    action: 'resolved' | 'paused' | 'waiting_user',
    guidance?: string,
    context?: TaskControlContext,
  ): unknown;
  control(taskId: string, action: 'pause' | 'resume' | 'cancel', context?: TaskControlContext): void;
  reconcileTaskIssue(
    projectId: string,
    taskId: string,
    context?: TaskControlContext,
  ): Promise<unknown>;
  resume(
    taskId: string,
    guidance?: { guidance: string; upgrade: boolean },
    context?: TaskControlContext,
  ): Promise<unknown>;
  holdExternalMerge(taskId: string): void;
  checkExternalMerge(task: Task): Promise<void>;
  collectFeedback(task: Task): Promise<void>;
  startOncall(task: Task, failure: string): boolean;
  primaryPaths(task: Task): Promise<string[]>;
  handoffValidation(run: Run, incidentId: string, reason: string): Promise<void>;
  oncall(run: Run, incidentId: string): Promise<void>;
  ownerAnswer(question: Message | any): Promise<void>;
  completed(task: Task): Promise<void>;
  deliverCompletion(task: Task): Promise<void>;
  cleanupCompleted(task: Task): Promise<void>;
  retrospective(task: Task): Promise<void>;
}
