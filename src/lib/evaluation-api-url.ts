/**
 * Review Models 页面使用的相对 Evaluation API 地址。
 * 从 `review/models` 回退一级可让 Next 自动保留任意 basePath（当前为 `/ai`），不硬编码部署前缀。
 */
const EVALUATION_API_BASE = "../api/evaluation";

export function evaluationApiUrl(path = "", params?: URLSearchParams): string {
  const query = params?.toString();
  return `${EVALUATION_API_BASE}${path}${query ? `?${query}` : ""}`;
}
