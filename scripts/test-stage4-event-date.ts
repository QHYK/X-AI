import { deriveEventDate } from "../src/processing/event-date.js";
import { validateStage4EventEnrichmentOutput } from "../src/processing/stage4-contract.js";

type Check = {
  name: string;
  passed: boolean;
  detail?: unknown;
};

const checks: Check[] = [];

checks.push({
  name: "A. same-day sources derive same Shanghai date",
  passed:
    deriveEventDate({
      publishedAtValues: ["2026-08-16T01:00:00Z", "2026-08-16T15:00:00Z"],
      workflowRunTimestamp: "2026-08-17T00:00:00Z",
    }).eventDate === "2026-08-16",
});

checks.push({
  name: "B. UTC timestamps crossing Shanghai midnight select earliest Shanghai date",
  passed:
    deriveEventDate({
      publishedAtValues: ["2026-08-16T15:50:00Z", "2026-08-16T16:20:00Z"],
      workflowRunTimestamp: "2026-08-17T00:00:00Z",
    }).eventDate === "2026-08-16",
});

checks.push({
  name: "C. null published_at values are ignored",
  passed:
    deriveEventDate({
      publishedAtValues: [null, "2026-08-16T16:20:00Z"],
      workflowRunTimestamp: "2026-08-17T00:00:00Z",
    }).eventDate === "2026-08-17",
});

const fallback = deriveEventDate({
  publishedAtValues: [null, null],
  workflowRunTimestamp: "2026-08-16T17:00:00Z",
});
checks.push({
  name: "D. all null published_at falls back to workflow Shanghai date",
  passed: fallback.eventDate === "2026-08-17" && fallback.source === "workflow_date_fallback",
  detail: fallback,
});

const contract = validateStage4EventEnrichmentOutput({
  event_title: "Test title",
  event_title_zh: "测试标题",
  event_tags: ["tag"],
  event_tags_zh: ["标签"],
  event_entities: ["Entity"],
  event_entities_zh: ["实体"],
  event_summary: "Summary.",
  event_summary_zh: "摘要。",
  source_perspectives: [{ source: "Source", summary: "来源摘要。" }],
  external_context: {
    performed: false,
    sources: [],
    sources_summary: "",
  },
});
checks.push({
  name: "E. Stage 4 output without event_date passes contract",
  passed: contract.success,
  detail: contract,
});

const failures = checks.filter((check) => !check.passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}
