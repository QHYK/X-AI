/**
 * 人工触发 Model Evaluation 的 CLI 入口。
 * 参数解析后委托给可复用 service；不会被 Daily Workflow 或任何 scheduler 调用。
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import { resolveEvaluationModels } from "../src/lib/evaluation-model-config.js";
import {
  isEvaluationStage,
  resumeEvaluation,
  runEvaluation,
  type EvaluationStage,
} from "../src/lib/model-evaluation.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Model Evaluation.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const result = options.inputId
      ? await resumeEvaluation({ pool, evaluationInputId: options.inputId })
      : await runEvaluation({
        pool,
        date: options.date as string,
        stage: options.stage,
        models: resolveEvaluationModels({ provider: options.provider, model: options.model }),
      });
    console.log(JSON.stringify(result, null, 2));
    if (result.runs.some((run) => run.status === "failed")) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

export function parseEvaluationCliArguments(args: string[]): {
  date?: string;
  stage: EvaluationStage;
  provider?: string;
  model?: string;
  inputId?: string;
} {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match) {
      throw new Error(`Unsupported argument "${argument}". Use --date=YYYY-MM-DD and optional --provider / --model.`);
    }
    const [, key, value] = match;
    if (!key || !value || !["date", "stage", "provider", "model", "input-id"].includes(key)) {
      throw new Error(`Unsupported argument "${argument}".`);
    }
    if (values.has(key)) {
      throw new Error(`Argument --${key} may only be provided once.`);
    }
    values.set(key, value);
  }
  const date = values.get("date");
  const stage = values.get("stage");
  const inputId = values.get("input-id");
  if (!stage || (!date && !inputId)) {
    throw new Error("--stage=... and either --date=YYYY-MM-DD or --input-id=... are required.");
  }
  if (!isEvaluationStage(stage)) {
    throw new Error(`Unsupported Evaluation stage "${stage}".`);
  }
  return {
    date,
    stage,
    provider: values.get("provider"),
    model: values.get("model"),
    inputId,
  };
}

function parseArguments(args: string[]) {
  return parseEvaluationCliArguments(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Model Evaluation failed.", error);
    process.exitCode = 1;
  });
}
