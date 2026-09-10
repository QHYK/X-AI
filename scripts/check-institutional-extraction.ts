import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { extractFirecrawlContent } from "../src/processing/content-completion.js";

const runDir =
  "runtime/content-completion/2026-09-10T10-58-05-279Z/firecrawl-raw-markdown";

const cases = [
  {
    sourceName: "CPI",
    file: "97e31be2-7a9d-4bb2-aed5-8834f53b7450.md",
  },
  {
    sourceName: "PPI",
    file: "b096d33d-6726-4716-8f13-99c7250001ab.md",
  },
  {
    sourceName: "PPI",
    file: "119093ee-e937-40ba-a34a-0b6fe7b0b747.md",
  },
  {
    sourceName: "非农报告 Employment Situation",
    file: "debace2a-b01c-4fcb-a2d4-59b696ca0c90.md",
  },
  {
    sourceName: "BEA - 商务部数据",
    file: "b6e5912d-a665-411a-a117-13e5a1838971.md",
  },
  {
    sourceName: "BEA - 商务部数据",
    file: "ac56c1bf-e3d5-4a99-9b15-8afb4c5aaa39.md",
  },
];

for (const item of cases) {
  const markdown = await readFile(join(runDir, item.file), "utf8");

  const result = extractFirecrawlContent(markdown, item.sourceName);

  console.log("\n========================================");
  console.log(item.sourceName);
  console.log(item.file);
  console.log("type:", result.contentType);
  console.log("content length:", result.contentText?.length ?? 0);
  console.log("full length:", result.fullContentText?.length ?? 0);
  console.log("----------------------------------------");
  console.log(result.contentText);
}