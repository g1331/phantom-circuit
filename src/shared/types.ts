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
export interface Operation {
  id: string;
  kind: string;
  status: 'pending' | 'done' | 'uncertain' | 'failed';
  result?: unknown;
  error?: string;
}
export interface Snapshot {
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
