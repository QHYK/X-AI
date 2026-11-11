/** Collection is one Daily phase. Always attempt both collectors before applying fail-fast. */
import type { RssCollectionSummary } from '../collectors/rss.js';
import type {
  collectGmailNewsletters,
  GmailCollectionWarning,
} from '../collectors/gmail/collector.js';
import { errorType } from '../collectors/gmail/client.js';
export type CollectionStatus = 'success' | 'partial' | 'failed';
export type CollectorOutcome<T> = {
  status: CollectionStatus;
  overall_failure: boolean;
  summary: T | null;
  error: string | null;
};
export type GmailCollectionSummary = Awaited<ReturnType<typeof collectGmailNewsletters>>;
export type DailyCollectionResult = {
  status: CollectionStatus;
  warning_count: number;
  warnings: GmailCollectionWarning[];
  rss: CollectorOutcome<RssCollectionSummary>;
  gmail: CollectorOutcome<GmailCollectionSummary>;
};
export async function runDailyCollection(options: {
  rss: () => Promise<RssCollectionSummary>;
  gmail: () => Promise<GmailCollectionSummary>;
  onResult?: (
    collector: 'rss' | 'gmail',
    result: CollectorOutcome<RssCollectionSummary> | CollectorOutcome<GmailCollectionSummary>,
  ) => void;
}): Promise<DailyCollectionResult> {
  let rss: CollectorOutcome<RssCollectionSummary>, gmail: CollectorOutcome<GmailCollectionSummary>;
  try {
    const summary = await options.rss();
    const failed = summary.sourceCount > 0 && summary.successSourceCount === 0;
    rss = {
      status: failed ? 'failed' : summary.failureSourceCount ? 'partial' : 'success',
      overall_failure: failed,
      summary,
      error: null,
    };
  } catch (error) {
    rss = { status: 'failed', overall_failure: true, summary: null, error: errorType(error) };
  }
  options.onResult?.('rss', rss);
  try {
    const summary = await options.gmail();
    const failed =
      summary.failures.some((e) => ['label', 'list'].includes(e.stage)) ||
      (summary.fetched === 0 && summary.failures.some((e) => e.stage === 'fetch'));
    const partial =
      summary.failures.length > 0 ||
      summary.outcomes.unsupported >
        new Set(summary.warnings.map((w) => w.gmail_message_id)).size ||
      summary.outcomes.failed > 0 ||
      summary.outcomes.conflict > 0;
    gmail = {
      status: failed ? 'failed' : partial ? 'partial' : 'success',
      overall_failure: failed,
      summary,
      error: null,
    };
  } catch (error) {
    gmail = { status: 'failed', overall_failure: true, summary: null, error: errorType(error) };
  }
  options.onResult?.('gmail', gmail);
  const warnings = gmail.summary?.warnings ?? [];
  return {
    warning_count: warnings.length,
    warnings,
    status:
      rss.overall_failure || gmail.overall_failure
        ? 'failed'
        : rss.status === 'partial' || gmail.status === 'partial'
          ? 'partial'
          : 'success',
    rss,
    gmail,
  };
}
