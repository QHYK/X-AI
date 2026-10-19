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
