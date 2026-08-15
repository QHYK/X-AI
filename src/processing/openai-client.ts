import OpenAI from "openai";

export const DEFAULT_OPENAI_BASE_URL = "https://128api.cn/v1";

export type OpenAiClientOptions = {
  timeoutMs?: number;
  maxRetries?: number;
};

export function createOpenAiClient(options: OpenAiClientOptions = {}) {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries ?? 0,
  });
}

export function getOpenAiBaseUrl(): string {
  return process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL;
}
