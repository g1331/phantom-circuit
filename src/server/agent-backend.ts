import type { EventEmitter } from 'node:events';

/** A model/effort pair understood by an Agent backend. */
export interface AgentProfile {
  model: string;
  effort: string;
  /** Optional OMP provider id. Codex keeps provider selection on its connection. */
  provider?: string;
  providerId?: string;
}

/** A host-owned tool exposed to a backend session. */
export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AgentToolHandler = (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Images use the same base64 wire shape as OMP's RPC protocol. */
export interface AgentImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface AgentSessionOptions {
  cwd?: string;
  profile?: AgentProfile;
  instructions?: string;
  writable?: boolean;
  ephemeral?: boolean;
  /** Existing backend session id/path to resume. */
  sessionId?: string;
  /** Alias accepted by callers that persist the OMP session path. */
  sessionPath?: string;
  /** Built-in tools allowed for this role. An omitted list means no built-ins. */
  allowedTools?: string[];
  tools?: AgentToolSpec[];
  toolHandler?: AgentToolHandler;
  /** Optional host callback for OMP extension UI requests. */
  onUserInput?: AgentUserInputHandler;
  dataDir?: string;
}

/** The legacy provider configuration accepted by the Codex adapter. */
export interface AgentProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
}

/** Typed options retained for the existing Codex thread() seam. */
export interface AgentThreadOptions {
  cwd: string;
  profile: AgentProfile;
  instructions: string;
  threadId?: string;
  writable: boolean;
  ephemeral?: boolean;
  tools?: AgentToolSpec[];
  toolHandler?: AgentToolHandler;
  onUserInput?: AgentUserInputHandler;
}

export interface AgentPromptOptions {
  profile?: AgentProfile;
  imagePaths?: string[];
  images?: AgentImage[];
  /** Stable caller id persisted by protocols that support steering reconciliation. */
  clientUserMessageId?: string;
  /** Active-turn precondition used by Codex turn/steer. */
  expectedTurnId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  outputSchema?: unknown;
  /** Called once when a backend assigns a concrete turn id. */
  onTurn?: (id: string) => void;
}

export interface AgentTurnResult {
  sessionId: string;
  turnId?: string;
  text: string;
  status: 'completed' | 'interrupted' | 'failed';
  usage?: AgentUsage;
  raw?: unknown;
}

export interface AgentUsage {
  /** The turn which produced this usage snapshot, when the protocol provides it. */
  turnId?: string;
  /** Model context-window capacity reported for this turn; never task-summed. */
  contextWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  estimatedUsd?: number;
}

export interface AgentLegacyModel {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  provider?: string;
  reasoning?: boolean;
  raw?: unknown;
}

export interface AgentRateLimitWindow {
  usedPercent?: number;
  windowDurationMinutes?: number;
  resetsAt?: string;
}

export interface AgentRateLimitBucket {
  name?: string;
  planType?: string;
  primary?: AgentRateLimitWindow;
  secondary?: AgentRateLimitWindow;
  rateLimitReachedType?: string;
}

export interface AgentAllowanceUsage {
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  longestRunningTurnSeconds?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
  dailyUsageBuckets?: Array<{ startDate: string; tokens: number }>;
  thread?: {
    estimatedUsageCredits?: number;
    estimatedUsageUsd?: number;
    groups?: Array<{
      model?: string;
      reasoningEffort?: string;
      speed?: string;
      estimatedUsageCredits?: number;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }>;
  };
}

export interface AgentAllowance {
  /** `unavailable` means the backend has no allowance RPC; auth/protocol are distinct. */
  status: 'available' | 'unavailable' | 'authentication_error' | 'protocol_error';
  /** Deliberately excludes account ids, email addresses, and credential material. */
  account?: { type: string; planType?: string };
  rateLimits?: {
    ordinaryUsageAllowed?: boolean | null;
    primary?: AgentRateLimitWindow;
    secondary?: AgentRateLimitWindow;
    buckets?: AgentRateLimitBucket[];
  };
  usage?: AgentAllowanceUsage;
  error?: string;
  code?: string;
}

export type AgentSteerReconciliation = 'accepted' | 'not_accepted' | 'unknown';

export interface AgentModelCapability {
  /** Canonical model id used by the backend. */
  id: string;
  /** Legacy Codex callers use `model`; keep it as a normalized alias. */
  model: string;
  provider?: string;
  displayName?: string;
  reasoning?: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  reasoningEfforts: string[];
  contextWindow?: number | null;
  raw?: unknown;
}

export interface AgentCapabilities {
  sessions: boolean;
  streaming: boolean;
  steering: boolean;
  followUp: boolean;
  abort: boolean;
  images: boolean;
  hostTools: boolean;
  usage: boolean;
  accountAllowance: boolean;
  modelListing: boolean;
  nestedAgents: boolean;
  extensions: boolean;
  rules: boolean;
  skills: boolean;
}

export interface AgentProbeResult {
  backend: string;
  protocol?: string;
  protocolVersion?: number;
  version?: string;
  sessionId?: string;
  models: AgentModelCapability[];
  capabilities: AgentCapabilities;
  allowance?: AgentAllowance;
}

export interface AgentUserInputRequest {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export type AgentUserInputResponse =
  { value: string } | { confirmed: boolean } | { cancelled: true };

export type AgentUserInputHandler = (
  request: AgentUserInputRequest,
) => Promise<AgentUserInputResponse | string | boolean | undefined>;

/**
 * The shared seam used by the host when it does not care whether a run uses
 * Codex app-server or OMP RPC. The legacy Codex methods remain part of this
 * contract; the normalized session methods are additive aliases.
 *
 * Event methods are required because the host consumes normalized streaming
 * notifications and failures from either implementation.
 */
export interface AgentBackend {
  start(provider?: unknown): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  thread(options: AgentThreadOptions): Promise<string>;
  turn(
    sessionId: string,
    prompt: string,
    profile: AgentProfile,
    signal?: AbortSignal,
    outputSchema?: unknown,
    onTurn?: (id: string) => void,
    imagePaths?: string[],
  ): Promise<string>;
  models(): Promise<AgentLegacyModel[]>;
  validate(profile: AgentProfile): Promise<void>;
  createSession(options: AgentSessionOptions): Promise<AgentSession>;
  resumeSession(options: AgentSessionOptions): Promise<AgentSession>;
  modelCapabilities(): Promise<AgentModelCapability[]>;
  probe(options?: Partial<AgentSessionOptions>): Promise<AgentProbeResult>;
  accountAllowance(): Promise<AgentAllowance>;
  reconcileSteer(sessionId: string, clientUserMessageId: string): Promise<AgentSteerReconciliation>;
  prompt(sessionId: string, prompt: string, options?: AgentPromptOptions): Promise<AgentTurnResult>;
  steer(sessionId: string, message: string, options?: AgentPromptOptions): Promise<void>;
  followUp(sessionId: string, message: string, options?: AgentPromptOptions): Promise<void>;
  abort(sessionId: string): Promise<void>;
  on(event: string | symbol, listener: (...args: any[]) => void): EventEmitter;
  off(event: string | symbol, listener: (...args: any[]) => void): EventEmitter;
}

/** A live conversation handle. It is deliberately small and backend-neutral. */
export interface AgentSession {
  readonly id: string;
  readonly sessionId: string;
  prompt(message: string, options?: AgentPromptOptions): Promise<AgentTurnResult>;
  steer(message: string, options?: AgentPromptOptions): Promise<void>;
  followUp(message: string, options?: AgentPromptOptions): Promise<void>;
  reconcileSteer(clientUserMessageId: string): Promise<AgentSteerReconciliation>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
  on(event: string | symbol, listener: (...args: any[]) => void): EventEmitter;
  off(event: string | symbol, listener: (...args: any[]) => void): EventEmitter;
}

/** Common turn error used by non-Codex adapters. */
export class AgentTurnError extends Error {
  constructor(
    message: string,
    readonly status: 'failed' | 'interrupted',
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AgentTurnError';
  }
}

export function profileProvider(profile: AgentProfile): string | undefined {
  return profile.provider ?? profile.providerId;
}

export function modelIdFromCapability(model: AgentModelCapability): string {
  return model.id || model.model;
}

export function asAgentModelCapability(raw: any): AgentModelCapability {
  const id = typeof raw?.id === 'string' ? raw.id : typeof raw?.model === 'string' ? raw.model : '';
  const provider = typeof raw?.provider === 'string' ? raw.provider : undefined;
  const displayName =
    typeof raw?.displayName === 'string'
      ? raw.displayName
      : typeof raw?.name === 'string'
        ? raw.name
        : undefined;
  const effortValues: unknown[] = Array.isArray(raw?.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
    : Array.isArray(raw?.reasoningEfforts)
      ? raw.reasoningEfforts
      : Array.isArray(raw?.thinking?.efforts)
        ? raw.thinking.efforts
        : [];
  const efforts: string[] = effortValues
    .map((entry: unknown) =>
      typeof entry === 'string'
        ? entry
        : typeof (entry as any)?.reasoningEffort === 'string'
          ? (entry as any).reasoningEffort
          : undefined,
    )
    .filter((entry: unknown): entry is string => typeof entry === 'string');
  const normalizedEfforts: string[] = [...new Set(efforts)];
  return {
    id,
    model: typeof raw?.model === 'string' ? raw.model : id,
    provider,
    displayName,
    reasoning: raw?.reasoning === true || normalizedEfforts.length > 0,
    supportedReasoningEfforts: normalizedEfforts.map((reasoningEffort) => ({ reasoningEffort })),
    reasoningEfforts: normalizedEfforts,
    contextWindow:
      typeof raw?.contextWindow === 'number' ? raw.contextWindow : (raw?.contextWindow ?? null),
    raw,
  };
}

export function asAgentLegacyModel(raw: unknown): AgentLegacyModel {
  const normalized = asAgentModelCapability(raw as any);
  return {
    id: normalized.id,
    model: normalized.model,
    displayName: normalized.displayName ?? normalized.id,
    supportedReasoningEfforts: normalized.supportedReasoningEfforts,
    provider: normalized.provider,
    reasoning: normalized.reasoning,
    raw,
  };
}

export function assertEffectiveProfile(
  state: { model?: { id?: string; provider?: string }; thinkingLevel?: string },
  profile: AgentProfile,
): void {
  const expectedProvider = profileProvider(profile);
  const requestedModel = profile.model.includes('/')
    ? profile.model.split('/').at(-1)!
    : profile.model;
  if (!state.model || typeof state.model.id !== 'string' || state.model.id.length === 0)
    throw new Error(`实际模型未返回，无法验证请求：${profile.model}`);
  if (state.model.id !== requestedModel && state.model.id !== profile.model)
    throw new Error(`实际模型与请求不一致：${state.model.id} / ${profile.model}`);
  if (typeof state.model.provider !== 'string' || state.model.provider.length === 0)
    throw new Error(`实际 Provider 未返回，无法验证请求：${expectedProvider ?? '未指定'}`);
  if (expectedProvider && state.model.provider !== expectedProvider)
    throw new Error(`实际 Provider 与请求不一致：${state.model.provider} / ${expectedProvider}`);
  if (typeof state.thinkingLevel !== 'string' || state.thinkingLevel.length === 0)
    throw new Error(`实际推理档位未返回，无法验证请求：${profile.effort}`);
  if (state.thinkingLevel !== profile.effort)
    throw new Error(`实际推理档位与请求不一致：${state.thinkingLevel} / ${profile.effort}`);
}
