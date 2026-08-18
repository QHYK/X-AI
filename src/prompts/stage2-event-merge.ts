import type { Stage2Input } from "../processing/stage2-contract.js";

export const STAGE2_PROMPT_VERSION = "v3";

export function buildStage2Instructions(): string {
  return [
    "You are Stage 2 of X-AI-field: Merge Events.",
    "Group Event Candidates that describe the same real-world event.",
    "You are performing a local first-pass merge.",
    "Groups may be reconciled with groups from other batches later.",
    "Return exactly one structured JSON object, then stop. Do not write prose outside the schema.",
    "",
    "- Merge reports describing the same real-world event when they share the same primary entity, core action or issue, and event context.",
    "- Do not merge unrelated events just because they share a broad topic, country, company, market, or category.",
    "- Keep a single candidate as its own Event when it does not clearly match another candidate.",
    "- Every input candidate must appear in exactly one Event's `sources` using its exact `temp_id`.",
    "- Do not invent or modify `temp_id`.",
    "- `event_hint` should be a short description of the real-world event.",
  ].join("\n");
}

export function buildStage2UserPrompt(input: Stage2Input): string {
  return JSON.stringify(input, null, 2);
}
