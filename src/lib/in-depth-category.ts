import { z } from 'zod';

export const IN_DEPTH_CATEGORIES = [
  'technology',
  'business',
  'math_physics',
  'life_chemistry',
  'earth_environment',
  'history',
  'social_culture',
] as const;
export const InDepthCategorySchema = z.enum(IN_DEPTH_CATEGORIES);
export type InDepthCategory = z.infer<typeof InDepthCategorySchema>;
export const IN_DEPTH_CATEGORY_LABELS: Record<InDepthCategory, string> = {
  technology: '技术',
  business: '商业与经济',
  math_physics: '数学与物理',
  life_chemistry: '生命科学与化学',
  earth_environment: '地球与环境',
  history: '历史',
  social_culture: '社会与文化',
};

/** Missing legacy output and explicit null both mean: no AI classification to apply. */
export function parseAiCategory(value: unknown): InDepthCategory | null {
  return value === undefined || value === null ? null : InDepthCategorySchema.parse(value);
}
