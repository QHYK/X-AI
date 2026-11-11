/** Transactional in-memory PostgreSQL-shaped fixture. No environment/network access. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { StoredEmail } from '../../src/collectors/gmail/email-store.js';
import { NEWSLETTER_SOURCE_NAMES } from '../../src/collectors/gmail/sources.js';
export function newsletterStore() {
  const emails = new Map<string, StoredEmail>();
  type Raw = {
    id: string;
    source_id: string;
    source_item_origin_id: string;
    title: string;
    url: string | null;
    published_at: Date | null;
    content_text: string | null;
    metadata: Record<string, unknown>;
  };
  let raws: Raw[] = [];
  let failRaw = false;
  let failAfter: number | null = null,
    failSuccess = false;
  let connects = 0,
    queries = 0;
  const sources = [
    ...new Map(
      Object.values(NEWSLETTER_SOURCE_NAMES).map((s) => [
        s.name,
        { id: randomUUID(), name: s.name, url: s.address },
      ]),
    ).values(),
  ];
  const exec = async (sql: string, args: unknown[] = []) => {
    queries++;
    const id = String(args[0]);
    if (sql.startsWith('insert into newsletter_emails')) {
      const existed = emails.has(id);
      if (!existed)
        emails.set(id, {
          gmail_message_id: id,
          raw_message: JSON.parse(String(args[1])),
          subject: args[2] as string | null,
          sender: args[3] as string | null,
          received_at: args[4] as Date | null,
          collected_at: new Date(),
          source_id: null,
          source_name: null,
          parse_status: (args[5] ?? 'collected') as StoredEmail['parse_status'],
          parser_version: null,
          module_mapping: [],
          error_stage: args[6] as string | null,
          error_message: args[7] as string | null,
          parsed_at: null,
          imported_at: null,
        });
      return { rows: [], rowCount: existed ? 0 : 1 };
    }
    if (sql.startsWith('select parse_status,count')) {
      const counts = new Map<string, number>();
      for (const e of emails.values())
        if ((args[0] as string[]).includes(e.gmail_message_id))
          counts.set(e.parse_status, (counts.get(e.parse_status) ?? 0) + 1);
      return { rows: [...counts].map(([parse_status, count]) => ({ parse_status, count })) };
    }
    if (sql.startsWith('select * from newsletter_emails'))
      return { rows: emails.has(id) ? [structuredClone(emails.get(id)!)] : [] };
    if (sql.startsWith('select distinct coalesce'))
      return {
        rows: [...new Set([...emails.values()].map((e) => e.source_name ?? 'Unknown'))].map(
          (source) => ({ source }),
        ),
      };
    if (sql.startsWith('select gmail_message_id from newsletter_emails'))
      return {
        rows: [...emails.values()]
          .filter(
            (e) =>
              e.received_at &&
              new Date(e.received_at).getTime() >= new Date(String(args[0])).getTime() &&
              new Date(e.received_at).getTime() <= new Date(String(args[1])).getTime() &&
              ['collected', 'unsupported', 'failed'].includes(e.parse_status) &&
              !e.imported_at,
          )
          .map((e) => ({ gmail_message_id: e.gmail_message_id })),
      };
    if (sql.startsWith('with ranked_emails'))
      return {
        rows: [...emails.values()]
          .filter(
            (e) =>
              (!args[0] || (e.source_name ?? 'Unknown') === args[0]) &&
              (!args[1] || e.parse_status === args[1]),
          )
          .sort(
            (a, b) =>
              new Date(b.received_at ?? 0).getTime() - new Date(a.received_at ?? 0).getTime() ||
              a.gmail_message_id.localeCompare(b.gmail_message_id),
          )
          .filter(
            (e, _i, all) =>
              all
                .filter(
                  (other) => (other.source_name ?? 'Unknown') === (e.source_name ?? 'Unknown'),
                )
                .indexOf(e) < 10,
          ),
      };
    if (sql.startsWith('select id from sources') && args.length === 2)
      return { rows: sources.filter((s) => s.name === args[0] && s.url === args[1]) };
    if (sql.includes('select id from sources')) return { rows: sources.filter((s) => s.id === id) };
    if (sql.includes('select id from raw_articles'))
      return {
        rows: raws.filter((r) => r.source_id === id && r.source_item_origin_id === args[1]),
      };
    if (sql.startsWith('select id,source_id'))
      return {
        rows: sql.includes('any(')
          ? raws.filter((r) => (args[0] as string[]).includes(r.id))
          : raws.filter(
              (r) =>
                (r.metadata.newsletter as { gmail_message_id: string })?.gmail_message_id === id ||
                r.source_item_origin_id.startsWith(`gmail:${id}:`),
            ),
      };
    if (sql.includes('insert into raw_articles')) {
      if (failRaw || failAfter === 0)
        throw Object.assign(new Error('simulated insert failure'), { code: '23514' });
      if (failAfter !== null) failAfter--;
      raws.push({
        id: randomUUID(),
        source_id: id,
        source_item_origin_id: String(args[1]),
        title: String(args[2]),
        url: args[3] as string | null,
        published_at: args[5] as Date | null,
        content_text: args[6] as string | null,
        metadata: JSON.parse(String(args[9])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('update newsletter_emails')) {
      const e = emails.get(id)!;
      assert.ok(e);
      if (sql.includes('set source_name=')) e.source_name = String(args[1]);
      else if (sql.includes('set source_id=')) e.source_id = String(args[1]);
      else {
        e.parse_status = args[1] as StoredEmail['parse_status'];
        e.parser_version = Number(args[2]);
        e.parsed_at = new Date();
        if (sql.includes('module_mapping=')) {
          if (failSuccess)
            throw Object.assign(new Error('simulated status write failure'), { code: '40001' });
          e.module_mapping = JSON.parse(String(args[3]));
          e.imported_at = new Date();
          e.error_stage = null;
          e.error_message = null;
        } else {
          if (args[5]) e.source_name = String(args[5]);
          if (args[6]) e.source_id = String(args[6]);
          e.error_stage = String(args[3]);
          e.error_message = String(args[4]);
        }
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL ${sql}`);
  };
  let queue = Promise.resolve();
  const pool = {
    query: exec,
    connect: async () => {
      connects++;
      let unlock!: () => void;
      const previous = queue;
      queue = new Promise<void>((r) => {
        unlock = r;
      });
      await previous;
      let initial: { emails: Map<string, StoredEmail>; raws: Raw[] } | null = null;
      const points = new Map<string, { emails: Map<string, StoredEmail>; raws: Raw[] }>();
      const snapshot = () => structuredClone({ emails, raws });
      const restore = (s: NonNullable<typeof initial>) => {
        emails.clear();
        s.emails.forEach((v, k) => emails.set(k, v));
        raws = s.raws;
      };
      return {
        release() {
          unlock();
        },
        query: async (sql: string, args?: unknown[]) => {
          if (sql.startsWith('begin')) initial = snapshot();
          else if (sql === 'commit') initial = null;
          else if (sql === 'rollback' && initial) restore(initial);
          else if (sql.startsWith('savepoint ')) points.set(sql.slice(10), snapshot());
          else if (sql.startsWith('rollback to savepoint ')) restore(points.get(sql.slice(22))!);
          else if (!sql.startsWith('set local')) return exec(sql, args);
          return { rows: [], rowCount: 0 };
        },
      };
    },
  } as unknown as Pool;
  return {
    pool,
    emails,
    get raws() {
      return raws;
    },
    sources,
    get connects() {
      return connects;
    },
    get queries() {
      return queries;
    },
    failAfter(value: number | null) {
      failAfter = value;
    },
    failSuccess(value: boolean) {
      failSuccess = value;
    },
    setFailRaw(value: boolean) {
      failRaw = value;
    },
  };
}
