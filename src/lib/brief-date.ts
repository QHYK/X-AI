const SHANGHAI_UTC_OFFSET_HOURS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ShanghaiDayRange = {
  date: string;
  startUtc: Date;
  endUtc: Date;
};

export function parseBriefDate(value: string | null): ShanghaiDayRange | null {
  if (!value) {
    return null;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const normalized = new Date(utcMidnight);

  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    return null;
  }

  const startUtc = new Date(utcMidnight - SHANGHAI_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + DAY_MS);

  return {
    date: value,
    startUtc,
    endUtc,
  };
}
