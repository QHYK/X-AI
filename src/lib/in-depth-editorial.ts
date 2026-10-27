import { z } from 'zod';

// A transport/storage safety bound, not a requested writing length.
export const EditorialIntroductionSchema = z
  .object({
    summary: z.string().max(32_000),
    whyWorthReading: z.string().max(32_000),
    extra_info: z.string().max(32_000),
  })
  .strict();
export type EditorialIntroduction = z.infer<typeof EditorialIntroductionSchema>;

export function readEditorialIntroduction(
  overrides: Record<string, unknown> | null,
): EditorialIntroduction {
  return {
    extra_info: typeof overrides?.extra_info === 'string' ? overrides.extra_info : '',
    summary: typeof overrides?.summary === 'string' ? overrides.summary : '',
    whyWorthReading:
      typeof overrides?.whyWorthReading === 'string' ? overrides.whyWorthReading : '',
  };
}

export class EditorialConflictError extends Error {
  constructor(readonly currentEditorial: EditorialIntroduction) {
    super('介绍已被其他操作修改，未覆盖已保存内容。请检查最新内容后再保存。');
  }
}
