/** Local review is open only in development until a shared admin auth exists. */
export function canAccessInDepthReview(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return nodeEnv === 'development';
}
