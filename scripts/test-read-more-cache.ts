import type { Pool } from "pg";
import {
  generateReadMoreSummary,
  READ_MORE_CONTENT_TEXT_MIN_LENGTH,
  readMoreTextLength,
  selectReadMoreSourceText,
} from "../src/lib/read-more.js";

type Query = { text: string; values?: unknown[] };
const queries: Query[] = [];
let generatorCalls = 0;
const contentId = "00000000-0000-0000-0000-000000000001";

function poolWith(rows: unknown[][]): Pool {
  let index = 0;
  return { query: (async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    return { rows: rows[index++] ?? [] };
  }) as Pool["query"] } as Pool;
}

const cached = await generateReadMoreSummary(poolWith([[{ summaryZh: "cached" }]]), contentId, {
  generate: async () => { generatorCalls += 1; throw new Error("cache hit must not call LLM"); },
});
const generated = await generateReadMoreSummary(poolWith([
  [], [{ fullContentText: null, contentText: "甲".repeat(READ_MORE_CONTENT_TEXT_MIN_LENGTH) }], [{ summaryZh: "generated" }],
]), contentId, { generate: async (text) => { generatorCalls += 1; return text.length === 3000 ? "generated" : "wrong"; } });
const unavailable = await generateReadMoreSummary(poolWith([[], [{ fullContentText: null, contentText: "甲".repeat(2999) }]]), contentId, {
  generate: async () => { throw new Error("unavailable content must not call LLM"); },
});
const fullPreferred = selectReadMoreSourceText({ fullContentText: " full ", contentText: "甲".repeat(3001) }) === "full";
const boundaries =
  selectReadMoreSourceText({ fullContentText: null, contentText: "甲".repeat(2999) }) === null &&
  selectReadMoreSourceText({ fullContentText: null, contentText: "甲".repeat(3000) })?.length === 3000 &&
  selectReadMoreSourceText({ fullContentText: null, contentText: "甲".repeat(3001) })?.length === 3001;
const unicodeLengthMatchesPostgresCharLength = readMoreTextLength("😀") === 1;
const passed = cached.status === "success" && cached.summary_zh === "cached" &&
  generated.status === "success" && generated.summary_zh === "generated" &&
  unavailable.status === "not_available" && generatorCalls === 1 && fullPreferred && boundaries && unicodeLengthMatchesPostgresCharLength &&
  queries.some((query) => query.text.includes("on conflict (content_id) do update"));

console.log(JSON.stringify({ success: passed, generatorCalls, queryCount: queries.length }, null, 2));
if (!passed) process.exitCode = 1;
