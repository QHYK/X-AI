import { z } from 'zod';

export const StandaloneOpenContextSchema = z
  .object({
    kind: z.literal('standalone'),
    researchTopic: z.string().trim().min(1).max(16000),
    referenceUrl: z
      .url()
      .max(2048)
      .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
      .nullable(),
    instructions: z.string().trim().max(8000).nullable(),
  })
  .strict();
export type OpenDiscoveryContext =
  { kind: 'linked'; parentRunId: string } | z.infer<typeof StandaloneOpenContextSchema>;
