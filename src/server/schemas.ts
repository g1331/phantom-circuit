import { priorityLevels } from '../shared/priority.ts';
import { z } from 'zod';
export const priorityUpdateInput = z
  .object({
    taskId: z.string().min(1),
    level: z
      .enum(priorityLevels)
      .describe(
        'low=-5, normal=0, high=5, urgent=10; higher numbers claim first within a project; no preemption',
      ),
    reason: z.string().trim().min(1).max(1000),
    expectedVersion: z.number().int().min(0),
    requestId: z.string().min(1).max(200),
  })
  .strict();
export const limit = z.number().int().min(1).max(32);
export const commandSchema = z
  .object({
    install: z.string().max(2000),
    build: z.string().max(2000),
    test: z.string().max(2000),
    start: z.string().max(2000),
    port: z.number().int().min(1024).max(65535),
  })
  .strict();
export const creationPriorityInput = z
  .object({
    priority: z
      .union([z.enum(priorityLevels), z.number().int().min(-10).max(10)])
      .describe(
        'Use low=-5, normal=0, high=5, urgent=10 and priorityReason. Legacy integer -10..10 accepted; higher numbers first within project, never preempt. Priority cannot replace dependencies.',
      ),
    priorityReason: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe('Required for named priorities; urgent must explain concrete emergency impact'),
  })
  .refine((value) => typeof value.priority === 'number' || !!value.priorityReason, {
    message: 'Named priority requires priorityReason',
  });
export const taskInput = creationPriorityInput
  .safeExtend({
    repoId: z.string(),
    title: z.string().min(1).max(200),
    spec: z.string().min(1).max(30000),
    acceptance: z.array(z.string().min(1)).min(1).max(50),
    dependencies: z.array(z.string()).max(100),
    kind: z.enum(['backend', 'frontend', 'fullstack']),
    complexity: z.enum(['normal', 'complex']),
    documentIds: z.array(z.string()).default([]),
    changeType: z.string().trim().min(1).max(100).optional(),
    scope: z.string().max(10000).optional(),
    summaryEn: z.string().max(10000).optional(),
    cleanup: z
      .object({
        requested: z.boolean().optional(),
        status: z.enum(['pending', 'completed', 'skipped', 'failed']).optional(),
        summary: z.string().max(5000).optional(),
        paths: z.array(z.string().max(2000)).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const profileSchema = z
  .object({
    providerId: z.string().min(1).max(100),
    model: z.string().trim().min(1).max(256),
    effort: z.string().trim().min(1).max(100),
    customModel: z.boolean().optional(),
    price: z
      .object({
        currency: z.string().trim().min(1).max(16),
        inputPerMillion: z.union([z.string(), z.number()]).optional(),
        outputPerMillion: z.union([z.string(), z.number()]).optional(),
        cachedInputPerMillion: z.union([z.string(), z.number()]).optional(),
        cacheWritePerMillion: z.union([z.string(), z.number()]).optional(),
        reasoningOutputPerMillion: z.union([z.string(), z.number()]).optional(),
        inputPerToken: z.union([z.string(), z.number()]).optional(),
        outputPerToken: z.union([z.string(), z.number()]).optional(),
        cachedInputPerToken: z.union([z.string(), z.number()]).optional(),
        cacheWritePerToken: z.union([z.string(), z.number()]).optional(),
        reasoningOutputPerToken: z.union([z.string(), z.number()]).optional(),
        version: z.string().max(256).optional(),
        source: z.string().max(1000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const profileSetSchema = z
  .object({
    backend: profileSchema,
    frontend: profileSchema,
    fullstack: profileSchema,
    complex: profileSchema,
    pm: profileSchema,
    review: profileSchema,
  })
  .strict();
export const settingsSchema = z
  .object({
    globalDevLimit: limit,
    reviewLimit: limit,
    profiles: profileSetSchema,
    defaultAgent: z.enum(['omp', 'codex']).optional(),
    ompProfiles: profileSetSchema.optional(),
    ompProfileInitialization: z
      .object({
        source: z.literal('omp.modelRoles'),
        roleDefaults: z
          .object({
            backend: z.enum(['default', 'slow', 'advisor']),
            frontend: z.enum(['default', 'slow', 'advisor']),
            fullstack: z.enum(['default', 'slow', 'advisor']),
            complex: z.enum(['default', 'slow', 'advisor']),
            pm: z.enum(['default', 'slow', 'advisor']),
            review: z.enum(['default', 'slow', 'advisor']),
          })
          .strict(),
      })
      .strict()
      .optional(),
    secondaryReviewProfile: profileSchema.optional(),
    secondaryReviewProfiles: z
      .object({ omp: profileSchema.optional(), codex: profileSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();
export const reviewSchema = z
  .object({
    approved: z.boolean(),
    summary: z.string().min(1),
    findings: z.array(z.string()),
    verdict: z.enum(['pass', 'rework', 'escalate']).optional(),
    model: z
      .object({
        agentKind: z.enum(['omp', 'codex']),
        providerId: z.string().optional(),
        model: z.string().min(1),
        effort: z.string().optional(),
        agentVersion: z.string().optional(),
      })
      .strict()
      .optional(),
    modelIdentity: z
      .object({
        agentKind: z.enum(['omp', 'codex']),
        providerId: z.string().optional(),
        model: z.string().min(1),
        effort: z.string().optional(),
        agentVersion: z.string().optional(),
      })
      .strict()
      .optional(),
    head: z.string().optional(),
    base: z.string().optional(),
    tests: z.array(z.any()).optional(),
    agentKind: z.enum(['omp', 'codex']).optional(),
    agentVersion: z.string().optional(),
  })
  .strict();
export const mergeSchema = z.object({ approved: z.boolean(), reason: z.string().min(1) }).strict();
export const clarificationQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(100).optional(),
    question: z.string().trim().min(1).max(2000).optional(),
    prompt: z.string().trim().min(1).max(2000).optional(),
    recommendation: z.string().trim().max(2000).optional(),
    options: z
      .array(
        z
          .object({
            value: z.string().trim().min(1).max(500),
            label: z.string().trim().max(500).optional(),
            description: z.string().trim().max(2000).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict()
  .refine((value) => !!(value.question ?? value.prompt), 'Clarification question is required');
export const clarificationInput = z
  .object({
    projectId: z.string().min(1),
    sourceMessageId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    sourceIntent: z.string().trim().min(1).max(100).optional(),
    questions: z.array(clarificationQuestionSchema).min(1).max(3),
  })
  .strict();
export const clarificationAnswerInput = z
  .record(z.string().min(1), z.union([z.string(), z.array(z.string())]))
  .refine((value) => Object.keys(value).length > 0, 'Clarification answer is required');
export const resolveIncidentInput = z
  .object({
    incidentId: z.string().min(1),
    action: z.enum(['resolved', 'paused', 'waiting_user']),
    guidance: z.string().trim().max(16000).optional(),
  })
  .strict();
export const messageDescriptorSchema = z
  .object({
    code: z.string().min(1),
    params: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
    detail: z.string().optional(),
  })
  .strict();
export const incidentInput = z
  .object({
    projectId: z.string().min(1),
    taskId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    phase: z.string().trim().min(1).max(200),
    message: z.string().max(16000),
    descriptor: messageDescriptorSchema.optional(),
    evidence: z.string().max(32000).optional(),
  })
  .strict();
export const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
