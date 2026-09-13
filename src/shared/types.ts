import type { PriorityChange } from './priority.ts';
export type Stage =
  'clarifying' | 'ready' | 'developing' | 'reviewing' | 'merging' | 'done' | 'cancelled';
export type RunStatus =
  'queued' | 'running' | 'waiting' | 'paused' | 'interrupted' | 'failed' | 'completed';
export type Role = 'pm' | 'dev' | 'review';
export type ProfileName = 'backend' | 'frontend' | 'fullstack' | 'complex' | 'pm' | 'review';
export interface Profile {
  model: string;
  effort: string;
}
export interface Provider {
  id: string;
  kind: 'codex' | 'custom';
  name: string;
  baseUrl?: string;
  hasKey: boolean;
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
}
export interface Project {
  id: string;
  name: string;
  description: string;
  devLimit: number;
  primaryRepoId?: string;
  githubProjectId?: string;
  githubProjectUrl?: string;
  pmThreadId?: string;
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
export interface Message {
  id: string;
  projectId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  intent?: 'discuss' | 'implement' | 'feedback';
  createdAt: string;
  status?: 'queued' | 'running' | 'completed' | 'failed';
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
  branch?: string;
  worktree?: string;
  devThreadId?: string;
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
  createdAt: string;
  updatedAt: string;
}
export interface ReviewResult {
  axis: 'standards' | 'spec';
  head: string;
  base: string;
  approved: boolean;
  summary: string;
  findings: string[];
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
  threadId?: string;
  turnId?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
}
export interface Event {
  id: number;
  at: string;
  type: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  message: string;
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
  providers: Provider[];
  projects: Project[];
  repos: Repo[];
  tasks: Task[];
  runs: Run[];
  messages: Message[];
  events: Event[];
  settings: Settings;
  documents: DesignDocument[];
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
