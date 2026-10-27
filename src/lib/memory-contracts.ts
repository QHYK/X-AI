import { z } from 'zod';

export const MEMORY_TYPES = ['general', 'topic', 'source', 'content'] as const;
export const MemoryTypeSchema = z.enum(MEMORY_TYPES);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;
const content = z.string().trim().min(1, 'Content 不能为空。');
const priority = z.number().int().min(-2147483648).max(2147483647);

export const MemoryCreateSchema = z
  .object({
    content,
    type: MemoryTypeSchema.default('general'),
    priority: priority.default(0),
    enabled: z.boolean().default(true),
  })
  .strict();

export const MemoryEditSchema = z
  .object({ content, type: MemoryTypeSchema, priority, enabled: z.boolean() })
  .strict();
export const MemoryUpdateSchema = z.union([
  MemoryEditSchema.extend({ id: z.uuid() }),
  z.object({ id: z.uuid(), enabled: z.boolean() }).strict(),
]);
export type MemoryCreate = z.infer<typeof MemoryCreateSchema>;
export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;
export type Memory = MemoryCreate & { id: string; createdAt: string; updatedAt: string };
