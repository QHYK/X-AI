/**
 * Stage 4 Event 日期推导规则。
 * 优先采用关联稿件最早发布时间；缺失时才回退到 workflow 执行日，保持可解释性。
 */
export type EventDateDerivationSource = "earliest_published_at" | "workflow_date_fallback";

export type EventDateDerivation = {
  eventDate: string;
  source: EventDateDerivationSource;
};

const EVENT_DATE_TIME_ZONE = "Asia/Shanghai";

/** 为一个 Event Group 推导展示日期，并返回所采用的数据来源。 */
export function deriveEventDate(options: {
  publishedAtValues: Array<Date | string | null>;
  workflowRunTimestamp: Date | string;
}): EventDateDerivation {
  const publishedDates = options.publishedAtValues
    .map((value) => toValidDate(value))
    .filter((value): value is Date => value !== null)
    .map((date) => formatDateInTimeZone(date, EVENT_DATE_TIME_ZONE))
    .sort();

  const [earliestPublishedDate] = publishedDates;
  if (earliestPublishedDate) {
    return {
      eventDate: earliestPublishedDate,
      source: "earliest_published_at",
    };
  }

  const workflowDate = toValidDate(options.workflowRunTimestamp);
  if (!workflowDate) {
    throw new Error("workflowRunTimestamp must be a valid date.");
  }

  return {
    eventDate: formatDateInTimeZone(workflowDate, EVENT_DATE_TIME_ZONE),
    source: "workflow_date_fallback",
  };
}

export function formatDateInTimeZone(value: Date, timeZone = EVENT_DATE_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error(`Unable to format date in ${timeZone}.`);
  }

  return `${year}-${month}-${day}`;
}

function toValidDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}
