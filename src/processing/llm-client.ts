import OpenAI from "openai";

export type LlmProvider = "openai" | "deepseek" | "kimi";
export type LlmStage = "stage1" | "stage2" | "stage3" | "stage4";

export type LlmClientOptions = {
  provider?: LlmProvider;
  timeoutMs?: number;
  maxRetries?: number;
};

export type LlmConfig = {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
};

type ResponseInput = string | Array<{
  role: string;
  content: string | Array<{
    type: string;
    text?: string;
  }>;
}>;

type ResponseRequest = {
  model: string;
  instructions?: string;
  input: ResponseInput;
  max_output_tokens?: number;
  store?: boolean;
  tools?: Array<{ type: "web_search" }>;
  tool_choice?: "auto";
  text?: {
    format: {
      type: "json_schema";
      name: string;
      description?: string;
      schema: unknown;
      strict?: boolean;
    };
  };
};

type ResponseUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type LlmResponse = {
  id: string;
  output_text: string;
  output: unknown[];
  usage?: ResponseUsage;
  finish_reason?: string | null;
};

type LlmRequestDiagnostic = {
  provider: LlmProvider;
  method: "POST";
  finalUrl: string;
  model: string;
  apiMode: "Responses API" | "Chat Completions API";
  requestHeaders: {
    Authorization: "Bearer ***";
    "Content-Type": "application/json";
  };
  body: {
    model: string;
    instructions: string | null;
    input: string;
    maxOutputTokens: number | null;
    responseFormat: unknown;
    tools: Array<{ type: "web_search" }> | null;
    toolChoice: "auto" | null;
  };
};

const DEFAULT_OPENAI_BASE_URL = "https://128api.cn/v1";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  openai: "gpt-5.4-mini",
  deepseek: "deepseek-v4-pro",
  kimi: "kimi-k3",
};

const DEFAULT_STAGE_PROVIDERS: Record<LlmStage, LlmProvider> = {
  stage1: "openai",
  stage2: "deepseek",
  stage3: "openai",
  stage4: "openai",
};

export function resolveLlmProvider(value = process.env.LLM_PROVIDER): LlmProvider {
  const provider = value?.trim().toLowerCase() || "openai";
  if (provider === "openai" || provider === "deepseek" || provider === "kimi") {
    return provider;
  }
  throw new Error(
    `Unsupported LLM_PROVIDER "${value}". Expected openai, deepseek, or kimi.`,
  );
}

export function resolveLlmConfig(options: {
  provider?: LlmProvider;
  model?: string;
} = {}): LlmConfig {
  const provider = options.provider ?? resolveLlmProvider();
  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error(`${credentialDescription(provider)} is required for LLM_PROVIDER=${provider}.`);
  }

  return {
    provider,
    apiKey,
    baseUrl: resolveBaseUrl(provider),
    model: options.model ?? resolveModel(provider),
  };
}

export function resolveLlmModel(model?: string, provider = resolveLlmProvider()): string {
  return model ?? resolveModel(provider);
}

export function resolveStageLlmProvider(stage: LlmStage): LlmProvider {
  const environmentName = `${stage.toUpperCase()}_LLM_PROVIDER`;
  return resolveLlmProvider(
    process.env[environmentName] ?? DEFAULT_STAGE_PROVIDERS[stage],
  );
}

export function resolveStageLlmModel(stage: LlmStage, model?: string): string {
  return model ?? resolveProviderModel(resolveStageLlmProvider(stage));
}

export function assertLlmConfiguration(provider?: LlmProvider): LlmConfig {
  return resolveLlmConfig({ provider });
}

export function assertStageLlmConfiguration(stage: LlmStage): LlmConfig {
  const provider = resolveStageLlmProvider(stage);
  return resolveLlmConfig({
    provider,
    model: resolveStageLlmModel(stage),
  });
}

export function createLlmClient(options: LlmClientOptions = {}) {
  const config = resolveLlmConfig({ provider: options.provider });
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries ?? 0,
  });

  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    responses: {
      create: (
        request: ResponseRequest,
        requestOptions: { timeout?: number } = {},
      ): Promise<LlmResponse> =>
        config.provider === "openai"
          ? createOpenAiResponse(client, request, requestOptions)
          : createChatCompletionResponse(client, config.provider, request, requestOptions),
    },
  };
}

async function createOpenAiResponse(
  client: OpenAI,
  request: ResponseRequest,
  requestOptions: { timeout?: number },
): Promise<LlmResponse> {
  const diagnostic = buildRequestDiagnostic("openai", client.baseURL, request);
  logRequestDiagnostic(diagnostic);
  try {
    const response = await client.responses.create(
      request as OpenAI.Responses.ResponseCreateParamsNonStreaming,
      requestOptions,
    );
    return response as unknown as LlmResponse;
  } catch (error) {
    throw toDiagnosticError(error, diagnostic);
  }
}

async function createChatCompletionResponse(
  client: OpenAI,
  provider: Exclude<LlmProvider, "openai">,
  request: ResponseRequest,
  requestOptions: { timeout?: number },
): Promise<LlmResponse> {
  const format = request.text?.format;
  const instructions = buildChatInstructions(provider, request.instructions, format?.schema);
  const responseFormat = format
    ? provider === "kimi"
      ? {
          type: "json_schema" as const,
          json_schema: {
            name: format.name,
            description: format.description,
            strict: format.strict ?? true,
            schema: format.schema as Record<string, unknown>,
          },
        }
      : { type: "json_object" as const }
    : undefined;
  const diagnostic = buildRequestDiagnostic(provider, client.baseURL, request, responseFormat);
  logRequestDiagnostic(diagnostic);
  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await client.chat.completions.create(
      {
        model: request.model,
        messages: [
          ...(instructions
            ? [{ role: "system" as const, content: instructions }]
            : []),
          { role: "user", content: extractInputText(request.input) },
        ],
        max_tokens: request.max_output_tokens,
        response_format: responseFormat,
      },
      requestOptions,
    );
  } catch (error) {
    throw toDiagnosticError(error, diagnostic);
  }

  const outputText = response.choices[0]?.message.content;

  return {
    id: response.id,
    output_text: typeof outputText === "string" ? outputText : "",
    output: [],
    finish_reason: response.choices[0]?.finish_reason ?? null,
    usage: response.usage
      ? {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
        }
      : undefined,
  };
}

function buildChatInstructions(
  provider: Exclude<LlmProvider, "openai">,
  instructions: string | undefined,
  schema: unknown,
): string {
  const parts = instructions ? [instructions] : [];
  if (provider === "deepseek" && schema) {
    parts.push(
      "Return only one valid JSON object matching this JSON Schema exactly:",
      JSON.stringify(schema),
    );
  }
  return parts.join("\n\n");
}

function extractInputText(input: ResponseInput): string {
  if (typeof input === "string") {
    return input;
  }

  return input
    .filter((message) => message.role === "user")
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content
            .filter((item) => item.type === "input_text" && typeof item.text === "string")
            .map((item) => item.text as string),
    )
    .join("\n");
}

function buildRequestDiagnostic(
  provider: LlmProvider,
  baseUrl: string,
  request: ResponseRequest,
  chatResponseFormat?: unknown,
): LlmRequestDiagnostic {
  const isResponsesApi = provider === "openai";
  return {
    provider,
    method: "POST",
    finalUrl: `${baseUrl.replace(/\/+$/, "")}/${isResponsesApi ? "responses" : "chat/completions"}`,
    model: request.model,
    apiMode: isResponsesApi ? "Responses API" : "Chat Completions API",
    requestHeaders: {
      Authorization: "Bearer ***",
      "Content-Type": "application/json",
    },
    body: {
      model: request.model,
      instructions: truncateDiagnosticText(request.instructions),
      input: truncateDiagnosticText(extractInputText(request.input)) ?? "",
      maxOutputTokens: request.max_output_tokens ?? null,
      responseFormat:
        chatResponseFormat ??
        (request.text?.format
          ? {
              type: request.text.format.type,
              name: request.text.format.name,
              description: request.text.format.description,
              strict: request.text.format.strict,
              schema: request.text.format.schema,
            }
          : null),
      tools: request.tools ?? null,
      toolChoice: request.tool_choice ?? null,
    },
  };
}

function logRequestDiagnostic(diagnostic: LlmRequestDiagnostic) {
  if (process.env.LLM_DEBUG_HTTP !== "true") {
    return;
  }
  console.error(`LLM HTTP request:\n${JSON.stringify(diagnostic, null, 2)}`);
}

function toDiagnosticError(error: unknown, request: LlmRequestDiagnostic): Error {
  const value = isRecord(error) ? error : {};
  const headers = extractDiagnosticHeaders(value.headers);
  const responseBody = sanitizeDiagnosticValue(value.error ?? value.body ?? null);
  const diagnostic = {
    request: {
      provider: request.provider,
      method: request.method,
      finalUrl: request.finalUrl,
      model: request.model,
      apiMode: request.apiMode,
    },
    response: {
      status: typeof value.status === "number" ? value.status : null,
      headers,
      code:
        typeof value.code === "string"
          ? value.code
          : isRecord(value.error) && typeof value.error.code === "string"
            ? value.error.code
            : null,
      type:
        typeof value.type === "string"
          ? value.type
          : isRecord(value.error) && typeof value.error.type === "string"
            ? value.error.type
            : null,
      message: sanitizeDiagnosticText(
        error instanceof Error ? error.message : String(error),
      ),
      body: responseBody,
    },
  };
  if (process.env.LLM_DEBUG_HTTP === "true") {
    console.error(`LLM HTTP error:\n${JSON.stringify(diagnostic, null, 2)}`);
  }
  return new Error(`LLM HTTP request failed: ${JSON.stringify(diagnostic)}`, {
    cause: error,
  });
}

function extractDiagnosticHeaders(value: unknown): Record<string, string> {
  const headers = isRecord(value) || typeof value === "object" ? value : null;
  const get =
    headers && "get" in headers && typeof headers.get === "function"
      ? headers.get.bind(headers)
      : null;
  if (!get) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const name of [
    "content-type",
    "x-request-id",
    "request-id",
    "server",
    "date",
    "retry-after",
    "cf-ray",
  ]) {
    const headerValue = get(name);
    if (typeof headerValue === "string" && headerValue) {
      output[name] = headerValue;
    }
  }
  return output;
}

function truncateDiagnosticText(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const limit = 500;
  return value.length <= limit
    ? sanitizeDiagnosticText(value)
    : `${sanitizeDiagnosticText(value.slice(0, limit))}… [truncated ${value.length - limit} chars]`;
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/sk-[A-Za-z0-9_*.-]+/g, "sk-***");
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDiagnosticValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        /authorization|api.?key|token/i.test(key) ? "***" : sanitizeDiagnosticValue(nested),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveApiKey(provider: LlmProvider): string | undefined {
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY;
  }
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_API_KEY;
  }
  return process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY;
}

function resolveBaseUrl(provider: LlmProvider): string {
  if (provider === "openai") {
    return process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
  }
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL;
  }
  return process.env.KIMI_BASE_URL ?? DEFAULT_KIMI_BASE_URL;
}

function resolveModel(provider: LlmProvider): string {
  if (process.env.LLM_MODEL) {
    return process.env.LLM_MODEL;
  }
  return resolveProviderModel(provider);
}

function resolveProviderModel(provider: LlmProvider): string {
  if (provider === "openai") {
    return process.env.OPENAI_MODEL ?? DEFAULT_MODELS.openai;
  }
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_MODEL ?? DEFAULT_MODELS.deepseek;
  }
  return process.env.KIMI_MODEL ?? DEFAULT_MODELS.kimi;
}

function credentialDescription(provider: LlmProvider): string {
  if (provider === "openai") {
    return "OPENAI_API_KEY";
  }
  if (provider === "deepseek") {
    return "DEEPSEEK_API_KEY";
  }
  return "KIMI_API_KEY (or MOONSHOT_API_KEY)";
}
