import { z } from 'zod';

export const maintenanceRuleInput = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    name: z.string().trim().min(1),
    mode: z.enum(['off', 'observe', 'auto']).default('observe'),
    kind: z.enum(['issue', 'ci']),
    selector: z.string().trim().min(1),
    minimumAgeMinutes: z.number().int().nonnegative(),
    scope: z.string().trim().min(1),
  })
  .strict();

export interface MaintenanceRule extends Omit<
  z.infer<typeof maintenanceRuleInput>,
  'expectedVersion'
> {
  id: string;
  ruleId: string;
  repoId: string;
  projectId: string;
  version: number;
  createdAt: string;
  author: 'user';
}

export interface MaintenanceCandidate {
  id: string;
  repoId: string;
  projectId: string;
  kind: 'issue' | 'ci';
  nativeId: string;
  revision: string;
  title: string;
  body: string;
  url: string;
  sourceAt: string;
  observedAt: string;
  selectorValues: string[];
  ageMinutes: number;
  issue?: number;
  head?: string;
  branch?: string;
  pullRequests: number[];
  selfGenerated: boolean;
  evidence: unknown;
}

export interface MaintenanceObservation {
  id: string;
  candidateId: string;
  repoId: string;
  projectId: string;
  ruleId: string;
  policyVersion: number;
  authorizationVersionId: string;
  mode: MaintenanceRule['mode'];
  createdAt: string;
  judgments: { condition: string; matched: boolean }[];
  sourceAgeMinutes: number;
  proposedScope: string;
  recommendation: string;
  wouldAccept: boolean;
  execution: 'observation_only';
  holdReasons: string[];
  taskIds: string[];
}

export interface MaintenanceHealth {
  id: string;
  checkedAt: string;
  status: 'healthy' | 'unavailable';
  reason?: string;
}

export interface MaintenancePage {
  rules: MaintenanceRule[];
  health?: MaintenanceHealth;
  observations: (MaintenanceObservation & {
    candidate: Omit<MaintenanceCandidate, 'body' | 'evidence'>;
  })[];
  next?: string;
  automaticExecutionAvailable: false;
}

export interface MaintenanceHistory {
  versions: MaintenanceRule[];
  next?: number;
}

export interface MaintenanceDetail {
  observation: MaintenanceObservation;
  candidate: MaintenanceCandidate;
  rule: MaintenanceRule;
}
