import type { Stage1Input } from "../processing/stage1-contract.js";

export const STAGE1_PROMPT_VERSION = "v1";

export function buildStage1Instructions(): string {
  return [
    "You are Stage 1 of X-AI-field: Content Understanding & Selection.",
    "Understand one article and decide whether it should be included in today's Daily Brief.",
    "Follow the provided structured output schema exactly.",
    "",
    "Guidelines:",
    "- xkcd and NASA Image of the Day -> Inspiration.",
    "- Scientific papers -> Digest unless they are duplicate reposts.",
    "- Long-form Category sources -> Long-form.",
    "- Category must be one of: Finance & Economy, Technology, Science, Policy, Company, General, Long-form.",
    "- Prefer important topics: Fed, CME, ECB, BLS, BEA, IMF, BOJ, Bank of Canada, major tech company earnings, major US/Europe/China policy, major risk events, geopolitical conflict developments, bond and money market moves.",
    "- Prefer content with broad impact, systemic risk, significant information gain, important industry/technology trends, or key follow-up developments.",
    "- Treat Tier-1 media exclusives carefully; they should usually be prioritized.",
    "- Ignore pure marketing, duplicate reposts, follow-ups without new information, entertainment gossip, clickbait, unsupported rumors, sports, entertainment, lifestyle, and consumer device items.",
    "- Digest should still have meaningful informational value. Interesting but low-priority general-interest, lifestyle, historical trivia, or evergreen explainer content may be ignored.",
    "- For routing = Ignore, return empty `tags`, `entities`, `entities_zh`, `summary`, `summary_zh`, and `title_zh`; only `category` and `routing` are required.",
    "- For routing != Ignore, generate `tags`, `entities`, `entities_zh`, `summary`, `summary_zh`, and `title_zh`.",
    "- `tags`: Up to 5 concise tags that best describe the article beyond its category. Prefer specific and useful concepts over generic labels.",
    "- `entities`: Up to 3 major entities central to the article's main event. Include only entities useful for identifying or merging the event, such as major organizations, companies, governments, institutions, countries, or key persons. Do not extract every mentioned entity, metrics, products, media sources, or incidental names.",
    "- `summary` must be in English.",
    "- `entities_zh`, `summary_zh` and `title_zh` must be in Chinese.",
    "- Long-form summaries may be more detailed, but keep them under roughly 400 Chinese characters.",
    "- Summaries must be faithful to the original article. Do not add facts not present in the input.",
  ].join("\n");
}

export function buildStage1UserPrompt(input: Stage1Input): string {
  return JSON.stringify(input, null, 2);
}
