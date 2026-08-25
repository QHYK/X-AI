/**
 * 用于跨频道去重的文章 URL 规范化。
 * 移除锚点和常见追踪参数，使同一文章的不同推广链接能命中同一个去重键。
 */
const TRACKING_QUERY_KEYS = new Set(["at_medium", "at_campaign", "mod"]);

/** 将可解析 URL 转为稳定比较形式；无法解析时保留原始文本，避免丢失候选。 */
export function normalizeArticleUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";

    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    const keptParams = [...url.searchParams.entries()]
      .filter(([key]) => !isTrackingQueryKey(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const keyCompare = leftKey.localeCompare(rightKey);
        return keyCompare === 0 ? leftValue.localeCompare(rightValue) : keyCompare;
      });

    url.search = "";
    for (const [key, paramValue] of keptParams) {
      url.searchParams.append(key, paramValue);
    }

    return url.toString();
  } catch {
    return trimmed;
  }
}

function isTrackingQueryKey(key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return (
    normalizedKey.startsWith("utm_") ||
    normalizedKey.startsWith("syn-") ||
    normalizedKey.startsWith("syn_") ||
    TRACKING_QUERY_KEYS.has(normalizedKey)
  );
}
