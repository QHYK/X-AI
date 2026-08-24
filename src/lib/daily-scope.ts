import { parseBriefDate } from "./brief-date.js";

export const DAILY_TIMEZONE = "Asia/Shanghai";
export const DAILY_BOUNDARY_HOUR = 9;

const SHANGHAI_UTC_OFFSET_HOURS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CollectedAtScope = {
  startAt: string;
  endAt: string;
};

export type DailyScope = CollectedAtScope & {
  dailyDate: string;
  timezone: typeof DAILY_TIMEZONE;
};

export function resolveDailyScope(
  dailyDateOption: string | undefined,
  now: Date = new Date(),
): DailyScope {
  const dailyDate = dailyDateOption
    ? assertDailyDate(dailyDateOption)
    : resolveLatestEndedDailyDate(now);
  const endAt = shanghaiBoundaryForDate(dailyDate);
  const startAt = new Date(endAt.getTime() - DAY_MS);

  return {
    dailyDate,
    timezone: DAILY_TIMEZONE,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  };
}

export function readCollectedAtScopeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CollectedAtScope | undefined {
  const startAt = env.DAILY_SCOPE_START_AT;
  const endAt = env.DAILY_SCOPE_END_AT;
  if (!startAt && !endAt) {
    return undefined;
  }
  if (!startAt || !endAt) {
    throw new Error(
      "DAILY_SCOPE_START_AT and DAILY_SCOPE_END_AT must be provided together.",
    );
  }

  const start = parseTimestamp(startAt, "DAILY_SCOPE_START_AT");
  const end = parseTimestamp(endAt, "DAILY_SCOPE_END_AT");
  if (end.getTime() - start.getTime() !== DAY_MS) {
    throw new Error("Daily collected_at scope must be exactly 24 hours.");
  }

  return {
    startAt: start.toISOString(),
    endAt: end.toISOString(),
  };
}

export function toDailyScopeEnv(scope: DailyScope): Record<string, string> {
  return {
    DAILY_DATE: scope.dailyDate,
    DAILY_TIMEZONE: scope.timezone,
    DAILY_SCOPE_START_AT: scope.startAt,
    DAILY_SCOPE_END_AT: scope.endAt,
  };
}

function resolveLatestEndedDailyDate(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new Error("Current time must be a valid date.");
  }

  const shanghai = new Date(
    now.getTime() + SHANGHAI_UTC_OFFSET_HOURS * 60 * 60 * 1000,
  );
  const currentDate = formatUtcDate(shanghai);
  if (shanghai.getUTCHours() >= DAILY_BOUNDARY_HOUR) {
    return currentDate;
  }

  return formatUtcDate(new Date(Date.UTC(
    shanghai.getUTCFullYear(),
    shanghai.getUTCMonth(),
    shanghai.getUTCDate() - 1,
  )));
}

function assertDailyDate(value: string): string {
  if (!parseBriefDate(value)) {
    throw new Error(`DAILY_DATE must be a valid YYYY-MM-DD date, got "${value}".`);
  }
  return value;
}

function shanghaiBoundaryForDate(dailyDate: string): Date {
  const day = parseBriefDate(dailyDate);
  if (!day) {
    throw new Error(`DAILY_DATE must be a valid YYYY-MM-DD date, got "${dailyDate}".`);
  }

  return new Date(day.startUtc.getTime() + DAILY_BOUNDARY_HOUR * 60 * 60 * 1000);
}

function parseTimestamp(value: string, name: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid timestamp, got "${value}".`);
  }
  return parsed;
}

function formatUtcDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
