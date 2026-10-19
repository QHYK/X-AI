import type { submitDiscoveryJob } from './background-jobs.js';
import { parseBriefDate } from '../lib/brief-date.js';

const START_DATE = '2026-10-20';
const shanghaiDate = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function discoveryShanghaiDate(now: Date): string {
  const parts = shanghaiDate.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Gregorian calendar ordinal, independent of timezones and Unix day-length arithmetic. */
function calendarDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const previousYear = year - 1;
  let days =
    365 * previousYear +
    Math.floor(previousYear / 4) -
    Math.floor(previousYear / 100) +
    Math.floor(previousYear / 400) +
    day;
  for (let m = 1; m < month; m++) days += new Date(Date.UTC(year, m, 0)).getUTCDate();
  return days;
}

export function isDiscoveryScheduledDate(date: string): boolean {
  if (!parseBriefDate(date)) throw new Error('Invalid Discovery schedule date.');
  return date >= START_DATE && (calendarDay(date) - calendarDay(START_DATE)) % 2 === 0;
}

/** Submission only: the existing worker owns execution, locks and interruption handling. */
export async function submitScheduledDiscovery(
  now: Date,
  submit: (
    input: Parameters<typeof submitDiscoveryJob>[1],
  ) => ReturnType<typeof submitDiscoveryJob>,
  log: (message: string) => void = console.log,
): Promise<void> {
  const date = discoveryShanghaiDate(now);
  if (!isDiscoveryScheduledDate(date)) {
    log(`Discovery scheduled: ${date} skipped.`);
    return;
  }
  const run = await submit({
    date,
    mode: 'regular',
    triggerSource: 'schedule',
    requestId: `discovery:scheduled:${date}`,
  });
  log(`Discovery scheduled: ${date} Run ${run.id} (${run.status}).`);
}
