import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { saveJson } from '../../src/collectors/gmail/auth.js';
import { Message, parseMessage, type ParsedMessage } from '../../src/collectors/gmail/mail.js';

import {
  DEFAULT_QUERY,
  errorType,
  validateSelection,
  type GmailReader,
} from '../../src/collectors/gmail/client.js';
export {
  DEFAULT_QUERY,
  errorType,
  validateSelection,
  gmailReader,
  retry,
  type GmailReader,
} from '../../src/collectors/gmail/client.js';
const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(id);

export async function processSample(directory: string, id: string, raw: unknown) {
  if (!safeId(id)) throw new Error('sample_invalid_id');
  // Persist the unmodified full API response before parsing, even if parsing later fails.
  await saveJson(join(directory, 'raw', `${id}.json`), raw);
  try {
    const validated = Message.parse(raw);
    if (validated.id !== id) throw new Error('sample_id_mismatch');
    const parsed = await parseMessage(raw);
    await saveJson(join(directory, 'parsed', `${id}.json`), parsed);
    return parsed;
  } catch {
    await saveJson(join(directory, 'parsed', `${id}.json`), {
      gmailMessageId: id,
      parseStatus: 'failed',
      errors: ['sample_parse_failed'],
    });
    return null;
  }
}

/** Reports contain IDs/counts only, never bodies, subjects, addresses or link URLs. */
export function report(
  samples: ParsedMessage[],
  context: {
    query: string;
    limit: number;
    apiSuccess: number;
    apiFailed: number;
    parseFailed: number;
    errors: Record<string, number>;
  },
  directory: string,
) {
  const count = samples.length + context.parseFailed;
  const html = samples.filter((s) => s.html).length;
  const plain = samples.filter((s) => s.plainText).length;
  const structure: Record<string, number> = {};
  const mimeTypes: Record<string, number> = {};
  const errorTypes = { ...context.errors };
  const linkHints: Record<string, number> = {};
  for (const sample of samples) {
    structure[sample.mimeType] = (structure[sample.mimeType] ?? 0) + 1;
    for (const [mime, n] of Object.entries(sample.mimeTypes))
      mimeTypes[mime] = (mimeTypes[mime] ?? 0) + n;
    for (const error of sample.errors) errorTypes[error] = (errorTypes[error] ?? 0) + 1;
    for (const link of sample.links)
      for (const hint of link.hints) linkHints[hint] = (linkHints[hint] ?? 0) + 1;
  }
  return {
    query: context.query.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi, '[email-redacted]'),
    queryHash: createHash('sha256').update(context.query).digest('hex'),
    requestedLimit: context.limit,
    apiSuccess: context.apiSuccess,
    apiFailed: context.apiFailed,
    parseSuccess: samples.filter((s) => s.parseStatus === 'success').length,
    parsePartial: samples.filter((s) => s.parseStatus === 'partial').length,
    parseFailed: context.parseFailed + samples.filter((s) => s.parseStatus === 'failed').length,
    htmlAvailable: html,
    plainAvailable: plain,
    htmlRatio: count ? html / count : null,
    plainRatio: count ? plain / count : null,
    availabilityDenominator: count,
    distributions: samples.map((s) => ({
      id: s.gmailMessageId,
      status: s.parseStatus,
      htmlCharacters: [...(s.html ?? '')].length,
      plainCharacters: [...(s.plainText ?? '')].length,
      links: s.links.length,
      uniqueLinks: new Set(s.links.map((l) => l.url)).size,
      unavailableBodies: s.unavailableBodies,
      ignoredAttachments: s.ignoredAttachments,
    })),
    rootMimeStructures: structure,
    mimePartTypes: mimeTypes,
    errorTypes,
    linkHints,
    paths: { raw: join(directory, 'raw'), parsed: join(directory, 'parsed') },
    interpretation: {
      mimeVariation:
        Object.keys(structure).length > 1
          ? 'Multiple root MIME structures observed.'
          : 'No root MIME variation demonstrated in this sample.',
      bodyCompleteness:
        'Availability is not proof of completeness. Inspect unavailableBodies/errors and raw MIME; no body is synthesized from another format.',
      links:
        'Navigation/advertising/unsubscribe/tracking counts are overlapping heuristics, not final article labels.',
      nextStep:
        'Inspect local MIME parts and anchors before designing article segmentation. Missing bodies must be resolved explicitly; attachments were not fetched.',
      possibleFutureFields: [
        'gmailMessageId',
        'gmailThreadId',
        'messageIdHeader',
        'receivedAt',
        'dateHeader',
        'from',
        'to',
        'subject',
        'labels',
        'html',
        'plainText',
        'parseStatus',
      ],
    },
  };
}

export async function collect(
  reader: GmailReader,
  directory: string,
  query = DEFAULT_QUERY,
  limit = 20,
  excludedIds: ReadonlySet<string> = new Set(),
) {
  validateSelection(query, limit);
  await mkdir(join(directory, 'raw'), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, 'parsed'), { recursive: true, mode: 0o700 });
  const ids = new Set<string>();
  const pages = new Set<string>();
  let page: string | undefined;
  let listRequests = 0;
  let listError: string | null = null;
  do {
    let result: Awaited<ReturnType<GmailReader['list']>>;
    try {
      listRequests++;
      result = await reader.list(query, page, Math.min(100, limit - ids.size));
    } catch (error) {
      listError = errorType(error);
      break;
    }
    for (const message of result.messages ?? []) {
      if (message.id && safeId(message.id) && !excludedIds.has(message.id)) ids.add(message.id);
      if (ids.size >= limit) break;
    }
    page = result.nextPageToken;
    if (page && pages.has(page)) {
      listError = 'gmail_repeated_page_token';
      break;
    }
    if (page) pages.add(page);
    if (pages.size > limit * 2) {
      listError = 'gmail_pagination_limit';
      break;
    }
  } while (page && ids.size < limit);
  const samples: ParsedMessage[] = [];
  const context = {
    query,
    limit,
    apiSuccess: 0,
    apiFailed: 0,
    parseFailed: 0,
    errors: {} as Record<string, number>,
  };
  const failures: { id: string; stage: string; error: string }[] = [];
  if (listError) context.errors[listError] = 1;
  for (const id of ids) {
    let raw: unknown;
    try {
      raw = await reader.get(id);
      context.apiSuccess++;
    } catch (error) {
      context.apiFailed++;
      const type = errorType(error);
      context.errors[type] = (context.errors[type] ?? 0) + 1;
      failures.push({ id, stage: 'get', error: type });
      continue;
    }
    try {
      const parsed = await processSample(directory, id, raw);
      if (parsed) samples.push(parsed);
      else {
        context.parseFailed++;
        context.errors.sample_parse_failed = (context.errors.sample_parse_failed ?? 0) + 1;
        failures.push({ id, stage: 'parse', error: 'sample_parse_failed' });
      }
    } catch {
      context.parseFailed++;
      context.errors.sample_save_failed = (context.errors.sample_save_failed ?? 0) + 1;
      failures.push({ id, stage: 'save', error: 'sample_save_failed' });
    }
  }
  // Gmail list order is not a historical snapshot guarantee; order fetched samples by receipt time.
  samples.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
  const summary = { ...report(samples, context, directory), listRequests, listError, failures };
  await saveJson(join(directory, 'collection-report.json'), summary);
  return summary;
}

/** Reparse raw samples entirely offline; never trusts cached parsed files or opens external links. */
export async function analyze(directory: string) {
  const samples: ParsedMessage[] = [];
  const context = {
    query: 'offline raw samples',
    limit: 0,
    apiSuccess: 0,
    apiFailed: 0,
    parseFailed: 0,
    errors: {} as Record<string, number>,
  };
  let entries: string[];
  try {
    entries = await readdir(join(directory, 'raw'));
  } catch {
    throw new Error('sample_raw_directory_unavailable');
  }
  const files = entries.filter((f) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(f)).sort();
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(directory, 'raw', file), 'utf8'));
      if (raw.id !== file.slice(0, -5)) throw new Error('sample_id_mismatch');
      samples.push(await parseMessage(raw));
    } catch {
      context.parseFailed++;
      context.errors.sample_parse_failed = (context.errors.sample_parse_failed ?? 0) + 1;
    }
  }
  const summary = report(samples, { ...context, limit: files.length }, directory);
  await saveJson(join(directory, 'analysis-report.json'), summary);
  return summary;
}
