import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IntakeSource, SourceInput, InputAssessment, SourceReply } from '../shared/intake.ts';
import type {
  MaintenanceRule,
  MaintenanceCandidate,
  MaintenanceObservation,
  MaintenanceHealth,
} from '../shared/maintenance.ts';
import type { Collaboration, FollowUp } from '../shared/collaboration.ts';
import type {
  AccountAllowance,
  Clarification,
  CostEstimate,
  DesignDocument,
  Event,
  Incident,
  InstructionSuggestion,
  Message,
  MessageDescriptor,
  OwnerMessage,
  Operation,
  PMActivity,
  PriceSnapshot,
  Profile,
  ProfileName,
  Project,
  Provider,
  RecoveryItem,
  Repo,
  Run,
  RunUsage,
  Settings,
  Task,
  TaskControlContext,
  TeamInstructionsVersion,
  UsageAggregate,
} from '../shared/types.ts';
import { redact } from './redaction.ts';
import type { UsageMode } from './usage.ts';

export { redact };

export class Fault extends Error {
  constructor(
    message: string,
    public status = 400,
    public descriptor?: MessageDescriptor,
  ) {
    super(message);
  }
}

export const now = () => new Date().toISOString();
export const id = () => randomUUID();

export type Entities = {
  maintenanceRule: MaintenanceRule;
  maintenanceCandidate: MaintenanceCandidate;
  maintenanceObservation: MaintenanceObservation;
  maintenanceHealth: MaintenanceHealth;
  followUp: FollowUp;
  collaboration: Collaboration;
  intakeSource: IntakeSource;
  sourceInput: SourceInput;
  inputAssessment: InputAssessment;
  sourceReply: SourceReply;
  inputIdentity: { id: string; databaseId: number; nodeId: string };
  event: Event;
  activity: PMActivity;
  provider: Provider;
  project: Project;
  repo: Repo;
  task: Task;
  run: Run;
  message: Message;
  ownerMessage: OwnerMessage;
  operation: Operation;
  incident: Incident;
  clarification: Clarification;
  recovery: RecoveryItem;
  allowance: AccountAllowance;
  settings: Settings;
  document: DesignDocument;
  teamInstructions: TeamInstructionsVersion;
  suggestion: InstructionSuggestion;
};

export interface RunOptions {
  purpose?: Run['purpose'];
  collaborationId?: string;
  workspacePath?: string;
  profile?: ProfileName;
  secondaryReview?: boolean;
  secondaryProfile?: Profile;
  secondaryReviewProfile?: Profile;
  sourceMessageId?: string;
  suppressSource?: boolean;
  source?: { messageId?: string } | string;
  recoveryItemId?: string;
  recovery?: RecoveryItem | string;
  agentVersion?: string;
  priceSnapshot?: PriceSnapshot;
  usage?: RunUsage;
  revision?: { head?: string; base?: string };
  reviewAxis?: Run['reviewAxis'];
  incidentId?: string;
  incidentPhase?: string;
  incidentEvidence?: string;
  ownerMessageId?: string;
}

export interface MessageOptions {
  deliveryMode?: Message['deliveryMode'];
  runId?: string;
  sourceMessageId?: string;
  draftId?: string;
  draftStatus?: Message['draftStatus'];
}

export interface StoreContext {
  readonly db: DatabaseSync;
  get<K extends keyof Entities>(kind: K, key: string): Entities[K] | undefined;
  put<K extends keyof Entities>(kind: K, key: string, value: Entities[K]): void;
  list<K extends keyof Entities>(kind: K): Entities[K][];
  transaction<T>(fn: () => T): T;
  emitChange(): void;
  project(key: string): Project;
  repo(key: string): Repo;
  task(key: string): Task;
  settings(): Settings;
  event(
    type: string,
    message: string,
    refs?: Partial<Pick<Event, 'projectId' | 'taskId' | 'runId' | 'control'>>,
    descriptor?: MessageDescriptor,
  ): number | bigint;
  activeRuns(): Run[];
  assertTaskExecutable(key: string): void;
  updateTask(key: string, patch: Partial<Task>): Task;
  updateTaskControl(
    key: string,
    patch: Partial<Task>,
    action: 'pause' | 'resume' | 'cancel',
    context?: TaskControlContext,
  ): Task;
  taskControlEvent(
    task: Task,
    action: 'pause' | 'resume' | 'cancel',
    context?: TaskControlContext,
  ): void;
  run(
    role: Run['role'],
    projectId: string,
    profile: ProfileName,
    task?: Task,
    options?: RunOptions,
  ): Run;
  finishRun(
    key: string,
    status: Run['status'],
    error?: string,
    options?: {
      usage?: RunUsage;
      usageMode?: UsageMode;
      durationMs?: number;
      priceSnapshot?: PriceSnapshot;
      descriptor?: MessageDescriptor;
    },
  ): Run | undefined;
  activity(
    run: Run,
    key: string,
    patch: Pick<PMActivity, 'kind' | 'title' | 'status'> & Partial<PMActivity>,
  ): PMActivity;
  patchRepo(key: string, patch: Partial<Repo>): Repo;
  addMessage(
    projectId: string,
    role: Message['role'],
    content: string,
    intent?: Message['intent'],
    attachments?: Message['attachments'],
    messageId?: string | MessageOptions,
    options?: MessageOptions,
  ): Message;
  updateMessage(key: string, patch: Partial<Message>): Message;
  sourceAuthority(
    messageId: string,
    projectId: string,
    repoId?: string,
  ): {
    message: Message;
    external?: {
      input: SourceInput;
      assessment: InputAssessment;
    };
  };
  rebindIncidentAssessment(incidentId: string, previousRunId: string, successorRunId: string): void;
  updateIncident(
    keyOrProject: string,
    patchOrKey:
      | string
      | Partial<
          Pick<
            Incident,
            'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
          >
        >,
    maybePatch?: Partial<
      Pick<
        Incident,
        'status' | 'message' | 'evidence' | 'descriptor' | 'assessmentRunId' | 'assessmentAt'
      >
    >,
  ): Incident;
  taskUsage(taskId: string): UsageAggregate;
  taskCost(taskId: string): CostEstimate | undefined;
  runCost(key: string): CostEstimate | undefined;
}
