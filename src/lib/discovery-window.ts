import { parseBriefDate } from './brief-date.js';
export function discoveryDatesForEndDate(date: string): [string, string] {
  if (!parseBriefDate(date)) throw new Error('Invalid business date.');
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return [previous.toISOString().slice(0, 10), date];
}
