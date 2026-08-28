/**
 * 人工 Model Evaluation 的独立模型选择。
 * 不读取或覆盖正式 Stage 1–4 的 provider 环境变量，模型名称仍由 shared LLM config 解析。
 */
import {
  resolveLlmProvider,
  resolveProviderLlmModel,
  type LlmProvider,
} from "../processing/llm-client.js";

export type EvaluationModel = {
  provider: LlmProvider;
  model: string;
};

const DEFAULT_EVALUATION_PROVIDERS: LlmProvider[] = ["deepseek", "kimi"];

/**
 * 解析本次人工评测要运行的模型。
 * 未指定时读取 EVALUATION_PROVIDERS（默认 DeepSeek、Kimi）；--model 仅允许配合单一 provider，
 * 避免把一个 model id 错误地发送给多个 Provider。
 */
export function resolveEvaluationModels(options: {
  provider?: string;
  model?: string;
  environment?: Readonly<Record<string, string | undefined>>;
} = {}): EvaluationModel[] {
  const environment = options.environment ?? process.env;
  const providers = options.provider
    ? [resolveLlmProvider(options.provider)]
    : resolveConfiguredProviders(environment);

  if (options.model && providers.length !== 1) {
    throw new Error("--model requires exactly one --provider for Model Evaluation.");
  }

  return providers.map((provider) => ({
    provider,
    model: options.model ?? resolveProviderLlmModel(provider),
  }));
}

function resolveConfiguredProviders(
  environment: Readonly<Record<string, string | undefined>>,
): LlmProvider[] {
  const configured = environment.EVALUATION_PROVIDERS?.trim();
  if (!configured) {
    return DEFAULT_EVALUATION_PROVIDERS;
  }

  const providers = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolveLlmProvider(value));
  if (providers.length === 0) {
    throw new Error("EVALUATION_PROVIDERS must contain at least one supported provider.");
  }
  if (new Set(providers).size !== providers.length) {
    throw new Error("EVALUATION_PROVIDERS must not contain duplicate providers.");
  }
  return providers;
}
