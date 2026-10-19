import { z } from 'zod';

export const DiscoveryTagSchema = z
  .object({
    zh: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/\p{Script=Han}/u, 'Chinese tag must include Chinese text.'),
    en: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/[a-z]/i, 'English tag must include Latin text.')
      .refine(
        (value) => !/\p{Script=Han}/u.test(value),
        'English tag cannot contain Chinese text.',
      ),
  })
  .strict();

// Deduplicate after validating the original limit; three pairs, not three per language.
export const DiscoveryTagsTransportSchema = z.array(DiscoveryTagSchema).max(3);
export const DiscoveryTagsSchema = DiscoveryTagsTransportSchema.transform((tags) => {
  const zh = new Set<string>();
  const en = new Set<string>();
  return tags.filter((tag) => {
    const chinese = tag.zh.toLowerCase().replace(/\s+/g, '');
    const english = tag.en.toLowerCase().replace(/\s+/g, ' ');
    if (zh.has(chinese) || en.has(english)) return false;
    zh.add(chinese);
    en.add(english);
    return true;
  });
});

export type DiscoveryTag = z.infer<typeof DiscoveryTagSchema>;

export const discoveryTagsJsonSchema = {
  type: 'array',
  maxItems: 3,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['zh', 'en'],
    properties: {
      zh: { type: 'string', minLength: 1, maxLength: 80 },
      en: { type: 'string', minLength: 1, maxLength: 120 },
    },
  },
} as const;

export function safeImageUrl(value: unknown, base?: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export const DiscoveryCoverSchema = z
  .object({
    url: z.string().refine((url) => safeImageUrl(url) !== null),
    source: z.enum(['og:image', 'twitter:image', 'article', 'raw_article']),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  })
  .strict();
export type DiscoveryCover = z.infer<typeof DiscoveryCoverSchema>;

/** Historical records lack these JSON keys; malformed metadata is not renderable content. */
export function readDiscoveryContentMetadata(item: {
  evaluation: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
}): { tags: DiscoveryTag[]; cover: DiscoveryCover | null } {
  const tags = DiscoveryTagsSchema.safeParse(item.evaluation?.tags ?? []);
  const fetch = item.evidence?.fetch;
  const fetchedCover =
    fetch && typeof fetch === 'object' && !Array.isArray(fetch)
      ? (fetch as Record<string, unknown>).coverImage
      : null;
  const cover = DiscoveryCoverSchema.safeParse(item.evidence?.coverImage ?? fetchedCover);
  return { tags: tags.success ? tags.data : [], cover: cover.success ? cover.data : null };
}
