import { z } from 'zod';
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
export const taskInput = z
  .object({
    repoId: z.string(),
    title: z.string().min(1).max(200),
    spec: z.string().min(1).max(30000),
    acceptance: z.array(z.string().min(1)).min(1).max(50),
    dependencies: z.array(z.string()).max(100),
    kind: z.enum(['backend', 'frontend', 'fullstack']),
    complexity: z.enum(['normal', 'complex']),
    priority: z.number().int().min(-10).max(10),
    documentIds: z.array(z.string()).default([]),
  })
  .strict();
export const profileSchema = z
  .object({
    model: z.string().min(1).max(100),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  })
  .strict();
export const settingsSchema = z
  .object({
    globalDevLimit: limit,
    reviewLimit: limit,
    profiles: z
      .object({
        backend: profileSchema,
        frontend: profileSchema,
        fullstack: profileSchema,
        complex: profileSchema,
        pm: profileSchema,
        review: profileSchema,
      })
      .strict(),
  })
  .strict();
export const reviewSchema = z
  .object({ approved: z.boolean(), summary: z.string().min(1), findings: z.array(z.string()) })
  .strict();
export const mergeSchema = z.object({ approved: z.boolean(), reason: z.string().min(1) }).strict();
export const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
