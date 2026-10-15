import type { SourceAnalyticsRow } from "./dashboard-analytics.js";

export type SourceAnalyticsSortDirection = "ascending" | "descending";

export function sortSourceRows(rows: SourceAnalyticsRow[], direction: SourceAnalyticsSortDirection): SourceAnalyticsRow[] {
  return [...rows].sort((left, right) => {
    const leftRate = rate(left);
    const rightRate = rate(right);
    if (leftRate === null) return rightRate === null ? left.sourceName.localeCompare(right.sourceName) : 1;
    if (rightRate === null) return -1;
    if (leftRate !== rightRate) return direction === "descending" ? rightRate - leftRate : leftRate - rightRate;
    return left.sourceName.localeCompare(right.sourceName);
  });
}

function rate(value: Pick<SourceAnalyticsRow, "selected" | "ignored">): number | null {
  const denominator = value.selected + value.ignored;
  return denominator === 0 ? null : value.selected / denominator;
}
