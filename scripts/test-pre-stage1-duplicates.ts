import { ignorePreStage1ExactDuplicates } from "../src/processing/pre-stage1-exact-duplicates.js";

type Row = { id: string; title: string; url: string | null; contentText: string | null; sourceName: string; createdAt: Date };

await check("0 duplicate", [row("a", "A", "https://a"), row("b", "B", "https://b")], [0, 0, 0]);
await check("URL duplicate", [row("a", "A", "https://same", "long"), row("b", "B", "https://same")], [1, 1, 0]);
await check("title duplicate", [row("a", "Same", "https://a", "long"), row("b", "Same", "https://b")], [1, 0, 1]);
await check("URL and title duplicate", [row("a", "Same", "https://same", "long"), row("b", "Same", "https://same")], [1, 0, 0, 1]);

async function check(name: string, rows: Row[], expected: number[]) {
  const updates: string[][] = [];
  const pool = { query: async (text: string, values?: unknown[]) => {
    if (text.includes("select ra.id")) return { rows };
    if (text.includes("update raw_articles")) { updates.push(values?.[0] as string[]); return { rows: [] }; }
    throw new Error(`Unexpected query: ${text}`);
  } };
  const summary = await ignorePreStage1ExactDuplicates(pool as never, { startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-02T00:00:00.000Z" });
  const [duplicates, url, title, both = 0] = expected;
  const passed = summary.inputCount === rows.length && summary.duplicateCount === duplicates
    && summary.outputCount === rows.length - duplicates && summary.sameUrlCount === url
    && summary.sameTitleCount === title && summary.sameUrlAndTitleCount === both
    && summary.duplicateRate === (rows.length === 0 ? 0 : duplicates / rows.length)
    && summary.sameUrlCount + summary.sameTitleCount + summary.sameUrlAndTitleCount === summary.duplicateCount
    && updates.flat().length === duplicates;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  if (!passed) process.exitCode = 1;
}

function row(id: string, title: string, url: string, contentText: string | null = null): Row {
  return { id, title, url, contentText, sourceName: "Source", createdAt: new Date(`2026-01-01T00:00:0${id === "a" ? "0" : "1"}.000Z`) };
}
