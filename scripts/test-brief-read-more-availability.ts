import type { Pool } from "pg";
import { getDailyBriefForDailyDate } from "../src/lib/daily-brief.js";

const queries: string[] = [];
const pool = {
  query: async (text: string) => {
    queries.push(text);
    if (text.includes("pc.routing = 'digest'")) return { rows: [{
      id: "digest-1", rank: 1, title: "Digest", title_zh: null, summary: null, summary_zh: null,
      category: "Technology", source: "Source", url: null, published_at: null,
      created_at: "2026-10-10T00:00:00.000Z", hasFullContent: true,
    }] };
    if (text.includes("pc.routing = 'long_form'")) return { rows: [{
      id: "long-1", rank: 1, title: "Long", title_zh: null, summary: null, summary_zh: null,
      category: "General", source: "Source", url: null, published_at: null,
      created_at: "2026-10-10T00:00:00.000Z", hasFullContent: false,
    }] };
    return { rows: [] };
  },
} as Pool;

const brief = await getDailyBriefForDailyDate(pool, "2026-10-10");
const contentQueries = queries.filter((query) => query.includes("content_read_more"));
const passed =
  brief.digests.Technology?.[0]?.has_full_content === true &&
  brief.long_form[0]?.has_full_content === false &&
  !("read_more_available" in (brief.digests.Technology?.[0] ?? {})) &&
  contentQueries.length === 2 &&
  contentQueries.every((query) => query.includes("char_length(btrim(coalesce(ra.content_text, ''))) >= 3000")) &&
  contentQueries.every((query) => query.includes("as \"hasFullContent\"") && !query.includes("readMoreAvailable")) &&
  contentQueries.every((query) => !query.includes('ra.content_text as'));

console.log(JSON.stringify({ success: passed, contentQueryCount: contentQueries.length }, null, 2));
if (!passed) process.exitCode = 1;
