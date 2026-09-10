import { extractFirecrawlContent } from "../src/processing/content-completion.js";

const longBody = Array.from({ length: 90 }, (_, index) => `Paragraph ${index}: ${"useful article detail ".repeat(5)}`).join("\n\n");
const checks = [
  ["abstract wins and does not retain paper full text", `## Abstract\n${"Research finding ".repeat(20)}\n\n## Introduction\n${longBody}`, "abstract", false],
  ["takeaways", `# Article\n\n## Takeaways\n${"Key market development ".repeat(15)}`, "takeaways", false],
  ["key points", `## Key Points\n${"Company result detail ".repeat(15)}`, "key_points", false],
  ["audio description", `## Description\n${"Programme description ".repeat(12)}`, "description", false],
  ["paywall shell is unusable", "# Article\n\nThis is a preview of subscription content\n\n## Subscribe", null, false],
  ["long article has separate full content", longBody, "article_body", true],
] as const;

let failed = false;
for (const [name, markdown, type, hasFull] of checks) {
  const result = extractFirecrawlContent(markdown);
  const passed = result.contentType === type && Boolean(result.fullContentText) === hasFull && (type === null ? result.contentText === null : Boolean(result.contentText));
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  if (!passed) failed = true;
}
if (failed) process.exitCode = 1;
