/**
 * Stage 4 单个 Event Group 的共享准备与 enrichment 能力。
 *
 * 正常 Stage 4 Job 与 Human Review 的按需晋级都从这里构造输入并调用同一 LLM / validation 层，
 * 因而不会出现两套 Prompt、工具配置或 Structured Output 处理逻辑。
 */
import type { Pool } from "pg";
import type { Stage4EventEnrichmentInput } from "../prompts/stage4-event-enrichment.js";
import { deriveEventDate, type EventDateDerivation } from "./event-date.js";
import {
  runStage4EventEnrichmentLlm,
  type Stage4LlmOptions,
  type Stage4LlmSuccess,
  type Stage4WebSearchToolUsage,
} from "./stage4-llm.js";

export type Stage4EventGroup = {
  eventGroupId: string;
  eventReviewItemId: string | null;
  eventHint: string;
  aiRank: number;
  displayRank: number;
  processedContentIds: string[];
};

export type Stage4SourceCandidate = {
  processedContentId: string;
  title: string;
  summary: string;
  entities: string[] | null;
  source: string;
  url: string | null;
  publishedAt: Date | null;
};

export type PreparedStage4Event = {
  group: Stage4EventGroup;
  input: Stage4EventEnrichmentInput;
  eventDate: EventDateDerivation;
  publishedAtValues: Array<Date | null>;
};

export type EnrichedStage4Event = PreparedStage4Event & {
  llm: Stage4LlmSuccess;
  output: Stage4LlmSuccess["output"];
  toolUsage: Stage4WebSearchToolUsage;
};

/** 保留既有 retry/耗时信息，供 Stage 4 runtime 与 Review API 在失败时使用。 */
export class Stage4EnrichmentError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly elapsedMs: number,
    readonly rawOutputText: string | null,
  ) {
    super(message);
    this.name = "Stage4EnrichmentError";
  }
}

/** 批量加载构造 Stage 4 输入所需的 Candidate 字段，调用方按原 ranking 成员顺序使用。 */
export async function loadStage4SourceCandidates(
  pool: Pool,
  processedContentIds: string[],
): Promise<Map<string, Stage4SourceCandidate>> {
  if (processedContentIds.length === 0) {
    return new Map();
  }

  const result = await pool.query<Stage4SourceCandidate>(
    `
      select
        pc.id as "processedContentId",
        ra.title,
        pc.summary,
        pc.entities,
        s.name as source,
        ra.url,
        ra.published_at as "publishedAt"
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.id = any($1::uuid[])
    `,
    [processedContentIds],
  );
  return new Map(result.rows.map((row) => [row.processedContentId, row]));
}

/** 以确定性的 Candidate 数据构造单个 Event Group 的 Stage 4 输入和 event_date。 */
export function prepareStage4Event(
  group: Stage4EventGroup,
  sourceCandidates: Map<string, Stage4SourceCandidate>,
  workflowRunTimestamp: Date,
): PreparedStage4Event {
  const candidates = group.processedContentIds.map((id) => {
    const candidate = sourceCandidates.get(id);
    if (!candidate) {
      throw new Error(`Missing DB details for processed_content ${id}.`);
    }
    return candidate;
  });
  const publishedAtValues = candidates.map((candidate) => candidate.publishedAt);

  return {
    group,
    input: {
      event_hint: group.eventHint,
      sources: candidates.map((candidate) => ({
        title: candidate.title,
        summary: candidate.summary,
        entities: candidate.entities ?? [],
        source: candidate.source,
        url: candidate.url,
      })),
    },
    eventDate: deriveEventDate({ publishedAtValues, workflowRunTimestamp }),
    publishedAtValues,
  };
}

/** 调用既有 Stage 4 LLM 层完成单个已准备 Event；失败时不做任何 persistence。 */
export async function enrichStage4Event(
  prepared: PreparedStage4Event,
  options: Stage4LlmOptions = {},
): Promise<EnrichedStage4Event> {
  const result = await runStage4EventEnrichmentLlm(prepared.input, options);
  if (!result.success) {
    throw new Stage4EnrichmentError(
      `Stage 4 enrichment failed for ${prepared.group.eventGroupId}: ${result.error}`,
      result.attempts,
      result.elapsedMs,
      result.rawOutputText,
    );
  }

  return {
    ...prepared,
    llm: result,
    output: result.output,
    toolUsage: result.toolUsage,
  };
}
