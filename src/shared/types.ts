import type { PriorityChange } from './priority.ts';

export type Stage =
  'clarifying' | 'ready' | 'developing' | 'reviewing' | 'merging' | 'done' | 'cancelled';
export type RunStatus =
  'queued' | 'running' | 'waiting' | 'paused' | 'interrupted' | 'failed' | 'completed';
export type Role = 'pm' | 'dev' | 'review';
export type AgentKind = 'omp' | 'codex';
export type ProfileName = 'backend' | 'frontend' | 'fullstack' | 'complex' | 'pm' | 'review';
export type ProfileMode = 'inherit' | 'pinned';
export type RecoveryPolicy = 'automatic' | 'manual';
/** A stable host-owned semantic message. Human text remains for display/diagnostics. */
export interface MessageDescriptor {
  code: string;
  params?: Record<string, string | number | boolean | null>;
  detail?: string;
}
export type OmpRoleDefault = 'default' | 'slow' | 'advisor';
export interface OmpProfileInitialization {
  source: 'omp.modelRoles';
  roleDefaults: Record<ProfileName, OmpRoleDefault>;
}
export type AgentSelection = { mode: 'inherit' } | { mode: 'override'; agent: AgentKind };
export interface Profile {
  providerId: string;
  model: string;
  effort: string;
  customModel?: boolean;
  /** Optional provider-side price card captured with a Run when supplied. */
  price?: PriceCard;
}
export interface Provider {
  id: string;
  kind: 'codex' | 'custom';
  name: string;
  baseUrl?: string;
  hasKey: boolean;
  price?: PriceCard;
}
export const officialProvider: Provider = {
  id: 'codex',
  kind: 'codex',
  name: 'Codex 官方登录',
  hasKey: false,
};
export interface ProviderModel {
  id: string;
  reasoningEfforts?: string[];
}
export type ModelDiscovery =
  { ok: true; models: ProviderModel[] } | { ok: false; code: string; error: string };
export interface Settings {
  globalDevLimit: number;
  reviewLimit: number;
  profiles: Record<ProfileName, Profile>;
  /** Backend used by new Projects unless a Project explicitly overrides it. */
  defaultAgent?: AgentKind;
  /** Profiles for the external OMP backend. Provider IDs are OMP IDs, not local Provider IDs. */
  ompProfiles?: Record<ProfileName, Profile>;
  ompProfileInitialization?: OmpProfileInitialization;
  secondaryReviewProfile?: Profile;
  /** Optional secondary reviewer per effective backend. */
  secondaryReviewProfiles?: Partial<Record<AgentKind, Profile>>;
}
export interface Project {
  profiles: Settings['profiles'];
  ompProfiles?: Settings['ompProfiles'];
  agentSelection?: AgentSelection;
  profileModes?: Record<ProfileName, ProfileMode>;
  secondaryReviewProfile?: Profile;
  secondaryReviewProfiles?: Partial<Record<AgentKind, Profile>>;
  recoveryPolicy?: RecoveryPolicy;
  profileVersion?: number;
  id: string;
  name: string;
  description: string;
  devLimit: number;
  primaryRepoId?: string;
  githubProjectId?: string;
  githubProjectUrl?: string;
  pmThreadId?: string;
  pmThreadProviderId?: string;
  pmThreadAgentKind?: AgentKind;
  pmThreadProfileVersion?: number;
  pmThreadProfile?: Profile;
  createdAt: string;
}
export interface Commands {
  install: string;
  build: string;
  test: string;
  start: string;
  port: number;
}
export interface Repo {
  id: string;
  projectId: string;
  name: string;
  path: string;
  github: string;
  defaultBranch: string;
  enabled: boolean;
  authorized: boolean;
  devLimit: number;
  commands: Commands;
  requiredChecks: string[];
  milestone?: number;
  blocked?: string;
  preview?: {
    status: 'starting' | 'running' | 'stopped' | 'failed';
    url?: string;
    pid?: number;
    error?: string;
  };
}
export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  width: number;
  height: number;
}
export interface Message {
  timelineOrder?: number;
  id: string;
  projectId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: ImageAttachment[];
  intent?: 'discuss' | 'implement' | 'feedback';
  createdAt: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
  deliveryMode?: 'queue' | 'steer';
  runId?: string;
  sourceMessageId?: string;
  /** Stable client draft identity; retries keep this value while message IDs may change. */
  draftId?: string;
  draftStatus?: 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  descriptor?: MessageDescriptor;
}
export interface Task {
  id: string;
  projectId: string;
  repoId: string;
  title: string;
  spec: string;
  acceptance: string[];
  dependencies: string[];
  sourceMessageId: string;
  kind: 'backend' | 'frontend' | 'fullstack';
  complexity: 'normal' | 'complex';
  profile: ProfileName;
  routingReason: string;
  priority: number;
  priorityVersion?: number;
  legacyPriorityOrder?: number;
  priorityReason?: string;
  priorityHistory?: PriorityChange[];
  stage: Stage;
  control: 'active' | 'paused';
  blocked?: string;
  blockedDescriptor?: MessageDescriptor;
  branch?: string;
  worktree?: string;
  devThreadId?: string;
  devThreadProviderId?: string;
  devThreadAgentKind?: AgentKind;
  devThreadProfileVersion?: number;
  devThreadProfile?: Profile;
  devPhase?: 'implement' | 'finalize';
  issue?: number;
  issueUrl?: string;
  issueNodeId?: string;
  issueDatabaseId?: number;
  projectItemId?: string;
  issueBody?: string;
  completionDeliveryPending?: boolean;
  pr?: number;
  prUrl?: string;
  head?: string;
  base?: string;
  integratedBase?: string;
  targetBase?: string;
  mergeSourceBranch?: string;
  pendingMerge?: {
    id: string;
    origin: 'legacy' | 'host';
    runId?: string;
    previousRunIds?: string[];
    outsideDigest?: string;
    indexDigest?: string;
    oldHead: string;
    sourceHead: string;
    sourceRef: string;
    targetBase: string;
    integratedBase: string;
    phase: 'merging' | 'conflicted' | 'editing' | 'edited' | 'committing';
    conflictPaths: string[];
  };
  mergeHistory?: (NonNullable<Task['pendingMerge']> & { head: string })[];
  revisionHistory?: { head?: string; base?: string; tests: Evidence[]; reviews: ReviewResult[] }[];
  mergeApproval?: { head: string; base: string };
  reviews: ReviewResult[];
  tests: Evidence[];
  retries: number;
  feedback: string[];
  pendingFeedback?: string[];
  documentChanges?: { path: string; content: string; version: number }[];
  reviewPolicyVersion?: number;
  secondaryReviewRequired?: boolean;
  changeType?: string;
  scope?: string;
  summaryEn?: string;
  cleanup?: CleanupMetadata;
  /** Explicit compatibility flag for clients that only need the user-pause distinction. */
  pausedByUser?: boolean;
  usage?: UsageAggregate;
  cost?: CostEstimate;
  createdAt: string;
  updatedAt: string;
}
export interface ReviewResult {
  axis: 'primary' | 'secondary' | 'standards' | 'spec';
  head: string;
  base: string;
  approved: boolean;
  summary: string;
  findings: string[];
  verdict?: ReviewVerdict;
  model?: ModelIdentity;
  modelIdentity?: ModelIdentity;
  agentKind?: AgentKind;
  agentVersion?: string;
  /** Tests are attached by the host, never supplied as model authority. */
  tests?: Evidence[];
}
export interface Evidence {
  command: string;
  exitCode: number;
  output: string;
  head: string;
  at: string;
}
export interface Run {
  id: string;
  projectId: string;
  repoId?: string;
  taskId?: string;
  role: Role;
  status: RunStatus;
  profile: ProfileName;
  profileConfig?: Profile;
  agentKind: AgentKind;
  agentVersion?: string;
  provider?: Pick<Provider, 'id' | 'name' | 'kind' | 'baseUrl'>;
  model?: ModelIdentity;
  modelIdentity?: ModelIdentity;
  profileVersion?: number;
  resumeThreadId?: string;
  threadId?: string;
  turnId?: string;
  sourceMessageId?: string;
  /** The accepted source intent currently authorizing this Run's PM tools. */
  sourceIntent?: Message['intent'];
  /** Stable protocol id used to reconcile an accepted steering message. */
  clientUserMessageId?: string;
  /** Revision the host pinned this Run to; review identity never crosses it. */
  revision?: { head?: string; base?: string };
  /** Review axis for recovery; absent on PM/Dev Runs. */
  reviewAxis?: ReviewResult['axis'];
  /** Incident assessment context; never infer a user prompt from sourceMessageId. */
  incidentId?: string;
  incidentPhase?: string;
  incidentEvidence?: string;
  reviewPolicyVersion?: number;
  secondaryReview?: boolean;
  usage?: RunUsage;
  durationMs?: number;
  priceSnapshot?: PriceSnapshot;
  /** Legacy-friendly alias; new writers use priceSnapshot. */
  price?: PriceSnapshot;
  recoveryItemId?: string;
  error?: string;
  errorDescriptor?: MessageDescriptor;
  /** Backend diagnostic lines retained as bounded, redacted evidence. */
  diagnostics?: string[];
  /** Singular compatibility alias for callers that only display one diagnostic. */
  diagnostic?: string;
  /** Session is the backend-neutral persisted conversation id. */
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
}

export type ReviewVerdict = 'pass' | 'rework' | 'escalate';
export interface ModelIdentity {
  agentKind: AgentKind;
  providerId?: string;
  model: string;
  effort?: string;
  agentVersion?: string;
}
export interface RunUsage {
  /** Model context-window capacity reported for this Run; never task-summed. */
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
  /** Source semantics for the last update; persisted for auditability. */
  mode?: 'cumulative' | 'per-run';
  final?: boolean;
}
export interface UsageAggregate extends Omit<RunUsage, 'mode' | 'final'> {
  runs?: number;
  complete?: boolean;
}
export interface PriceCard {
  currency: string;
  inputPerMillion?: string | number;
  outputPerMillion?: string | number;
  cachedInputPerMillion?: string | number;
  cacheWritePerMillion?: string | number;
  reasoningOutputPerMillion?: string | number;
  inputPerToken?: string | number;
  outputPerToken?: string | number;
  cachedInputPerToken?: string | number;
  cacheWritePerToken?: string | number;
  reasoningOutputPerToken?: string | number;
  version?: string;
  source?: string;
}
export interface PriceSnapshot extends PriceCard {
  partial?: boolean;
  capturedAt?: string;
}
export interface CostEstimate {
  amount: string;
  currency: string;
  partial: boolean;
  coverage?: string[];
  source?: string;
}
export interface AccountAllowance {
  providerId: string;
  agentKind: AgentKind;
  state: 'unknown' | 'available' | 'exhausted' | 'unavailable';
  remaining?: string;
  resetAt?: string;
  capturedAt: string;
  currency?: string;
}
export interface CleanupMetadata {
  requested?: boolean;
  status?: 'pending' | 'completed' | 'skipped' | 'failed';
  summary?: string;
  paths?: string[];
}

export interface Incident {
  id: string;
  projectId: string;
  taskId?: string;
  runId?: string;
  phase: string;
  status: 'open' | 'assessing' | 'resolved' | 'waiting_user';
  message: string;
  descriptor?: MessageDescriptor;
  evidence?: string;
  assessmentRunId?: string;
  assessmentAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ClarificationOption {
  value: string;
  label?: string;
  description?: string;
}
export interface ClarificationQuestion {
  id: string;
  question: string;
  recommendation?: string;
  options?: ClarificationOption[];
}
export interface ClarificationAnswer {
  questionId: string;
  value: string | string[];
}
export interface Clarification {
  id: string;
  projectId: string;
  sourceMessageId: string;
  taskId?: string;
  sourceIntent: string;
  questions: ClarificationQuestion[];
  status: 'open' | 'answered' | 'cancelled';
  answers?: ClarificationAnswer[];
  answeredAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface RecoveryItem {
  id: string;
  projectId: string;
  oldRunId: string;
  /** Alias retained for callers that refer to the interrupted Run as runId. */
  runId: string;
  taskId?: string;
  role?: Role;
  threadId?: string;
  revision?: { head?: string; base?: string };
  draftId?: string;
  messageId?: string;
  sourceMessageId?: string;
  /** New Run created to continue this item; one item can never create two successors. */
  successorRunId?: string;
  /** Review axis or incident context needed to continue without replaying user scope. */
  reviewAxis?: ReviewResult['axis'];
  incidentId?: string;
  recoveryPrompt?: string;
  stage?: Stage;
  status: 'pending' | 'recoverable' | 'resumed' | 'cancelled';
  policy: RecoveryPolicy;
  /** Why an interrupted task was kept paused; this is not inferred during bulk recovery. */
  pauseProvenance?: 'user' | 'runtime' | 'terminal';
  /** Explicit compatibility flag for clients that only need the user-pause distinction. */
  pausedByUser?: boolean;
  reason?: string;
  reasonDescriptor?: MessageDescriptor;
  createdAt: string;
  updatedAt: string;
}
export interface Event {
  id: number;
  at: string;
  type: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  message: string;
  descriptor?: MessageDescriptor;
}
/** One operation attempt, as it stood at a moment that mattered. */
export interface OperationAttempt {
  status: Operation['status'];
  error?: string;
  /**
   * The attempt counter at that moment. Status and error can leave and return to the same value -
   * an authorized retry that fails again with the same error restores `{uncertain, error}`
   * exactly - so they cannot identify an attempt on their own. This counter increments for every
   * external write attempt, which is what makes a returned-to state distinguishable.
   */
  attempt: number;
}
export interface Reconciliation {
  /** Stable id of this authorization, so a repeated coordination can be seen to re-affirm it. */
  id: string;
  /**
   * Only an absent remote object authorizes a retry; a present object is adopted instead. This
   * records what the listings read at `at` showed, not an absolute proof that no related PR
   * exists - a PR whose marker was removed and whose head branch was also renamed is visible to
   * neither listing. See `evidence` for the scope that was actually read.
   */
  verdict: 'absent';
  actor: 'user' | 'pm';
  /** The operation attempt the remote verification was performed against. */
  observedOperation: OperationAttempt;
  /** The task revision (repository, branch, head, base) the remote verification was about. */
  taskRevision: string;
  evidence: string;
  at: string;
}
export interface Operation {
  id: string;
  kind: string;
  status: 'pending' | 'done' | 'uncertain' | 'failed';
  runId?: string;
  sessionId?: string;
  turnId?: string;
  clientUserMessageId?: string;
  result?: unknown;
  error?: string;
  /**
   * Monotonic count of external write attempts made for this operation. It changes even when a
   * repeated failure restores an identical status and error, so it is the identity an
   * authorization binds to.
   */
  attempt?: number;
  /**
   * Durable, single-use authorization recorded only after an explicit host coordination step
   * re-read the remote state and proved this operation created no remote object. Automatic
   * lookups never write it, so an unresolved outcome is still never blindly repeated. It is
   * bound to the operation attempt and task revision it was verified against, and is consumed
   * before the controlled retry, so it can never be replayed for a revision nobody checked.
   */
  reconciliation?: Reconciliation;
}
export interface Snapshot {
  activities: PMActivity[];
  providers: Provider[];
  projects: Project[];
  repos: Repo[];
  tasks: Task[];
  runs: Run[];
  messages: Message[];
  events: Event[];
  settings: Settings;
  documents: DesignDocument[];
  incidents?: Incident[];
  clarifications?: Clarification[];
  recoveryItems?: RecoveryItem[];
  accountAllowances?: AccountAllowance[];
}
export interface PMActivity {
  timelineOrder?: number;
  id: string;
  projectId: string;
  runId: string;
  taskId?: string;
  messageId?: string;
  eventId?: number;
  kind:
    'trigger' | 'plan' | 'summary' | 'tool' | 'command' | 'files' | 'search' | 'phase' | 'error';
  status: RunStatus;
  title: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  details: {
    source?: string;
    command?: string;
    cwd?: string;
    paths?: string;
    input?: string;
    output?: string;
    error?: string;
    summary?: string;
  };
}
export interface DesignDocument {
  id: string;
  projectId: string;
  repoId: string;
  path: string;
  content: string;
  accepted: boolean;
  version: number;
  updatedAt: string;
}
export const stageLabels: Record<Stage, string> = {
  clarifying: '待澄清',
  ready: '待认领',
  developing: '开发中',
  reviewing: '评审中',
  merging: '待合并',
  done: '工程完成',
  cancelled: '已取消',
};
export type SchedulingReasonCode =
  | 'paused'
  | 'blocked'
  | 'feedback'
  | 'stage'
  | 'unauthorized'
  | 'repositoryBlocked'
  | 'workSwitch'
  | 'activeRun'
  | 'dependency'
  | 'globalCapacity'
  | 'projectCapacity'
  | 'repositoryCapacity';
export interface SchedulingExplanation {
  projectId: string;
  at: string;
  projectOrder: string[];
  candidates: string[];
  tasks: {
    taskId: string;
    title: string;
    priority: number;
    stage: Stage;
    reasons: { code: SchedulingReasonCode; detail?: string }[];
  }[];
}
