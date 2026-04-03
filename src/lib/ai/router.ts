import { getCencoriClient } from "./cencori";
import { ChatMessage, ChatOptions } from "./types";

type ChatProvider = "cencori" | "ollama";
type EmbedProvider = "cencori" | "none";

const CHAT_PROVIDER = resolveChatProvider();
const EMBED_PROVIDER = resolveEmbedProvider();
const DEFAULT_CHAT_MODEL =
  CHAT_PROVIDER === "ollama" ? "qwen3.5:9b" : "llama-3.3-70b-versatile";
const CHAT_MODEL = process.env.CHAT_MODEL || DEFAULT_CHAT_MODEL;
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-004";
const OLLAMA_BASE_URL = normalizeBaseUrl(
  process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434"
);
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || CHAT_MODEL;
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";
const OLLAMA_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.OLLAMA_REQUEST_TIMEOUT_MS || "120000",
  10
);
const CHAT_FALLBACK_PROVIDER =
  process.env.CHAT_FALLBACK_PROVIDER === "cencori" ? "cencori" : null;
const BACKGROUND_AI_ENABLED = resolveBackgroundAIEnabled();

/**
 * Send a chat request through the configured inference provider.
 * Banjo remains the orchestrator; models can live elsewhere.
 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string | ReadableStream> {
  try {
    if (CHAT_PROVIDER === "ollama") {
      return options.stream
        ? ollamaChatStream(messages, options)
        : ollamaChat(messages, options);
    }

    return options.stream
      ? cencoriChatStream(messages, options)
      : cencoriChat(messages, options);
  } catch (error) {
    if (CHAT_PROVIDER === "ollama" && CHAT_FALLBACK_PROVIDER === "cencori") {
      console.warn(
        "Ollama chat failed, falling back to Cencori:",
        error instanceof Error ? error.message : error
      );

      return options.stream
        ? cencoriChatStream(messages, options)
        : cencoriChat(messages, options);
    }

    throw error;
  }
}

async function cencoriChatStream(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<ReadableStream> {
  const cencori = getCencoriClient();

  const stream = await cencori.ai.chatStream({
    model: CHAT_MODEL,
    messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });

  if (isReadableStream(stream)) {
    return stream;
  }

  return asyncIterableToReadableStream(stream);
}

async function cencoriChat(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  const cencori = getCencoriClient();

  const response = await cencori.ai.chat({
    model: CHAT_MODEL,
    messages,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });

  // Extract text from response — SDK may return different shapes
  const r = response as any;
  if (typeof r === "string") return r;
  if (typeof r?.content === "string") return r.content;
  if (r?.choices?.[0]?.message?.content) return r.choices[0].message.content;
  if (r?.message?.content) return r.message.content;

  console.log("Cencori chat response shape:", JSON.stringify(r, null, 2));
  return String(r);
}

async function ollamaChat(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_CHAT_MODEL,
      messages,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: buildOllamaOptions(options),
    }),
    signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${await readError(response)}`);
  }

  const data = (await response.json()) as {
    error?: string;
    message?: { content?: string };
  };

  if (data.error) {
    throw new Error(`Ollama API error: ${data.error}`);
  }

  return data.message?.content || "";
}

async function ollamaChatStream(
  messages: ChatMessage[],
  options: ChatOptions
): Promise<ReadableStream> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_CHAT_MODEL,
      messages,
      stream: true,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: buildOllamaOptions(options),
    }),
    signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${await readError(response)}`);
  }

  if (!response.body) {
    throw new Error("Ollama did not return a response stream.");
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const reader = response.body!.getReader();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const text = extractOllamaStreamText(line);
            if (text) {
              controller.enqueue(encoder.encode(text));
            }
          }
        }

        const trailingText = extractOllamaStreamText(buffer);
        if (trailingText) {
          controller.enqueue(encoder.encode(trailingText));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function isReadableStream(value: unknown): value is ReadableStream {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream).getReader === "function"
  );
}

function asyncIterableToReadableStream(stream: unknown): ReadableStream {
  const iterable =
    stream && typeof stream === "object"
      ? (stream as AsyncIterable<unknown>)
      : null;

  if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
    throw new Error("Cencori stream response is not readable");
  }

  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of iterable) {
          const text = extractStreamText(chunk);
          if (text) {
            controller.enqueue(encoder.encode(text));
          }
        }
      } catch (error) {
        controller.error(error);
        return;
      }

      controller.close();
    },
  });
}

function extractStreamText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (!chunk || typeof chunk !== "object") {
    return "";
  }

  const candidate = chunk as {
    delta?: string;
    content?: string;
    text?: string;
    choices?: Array<{
      delta?: { content?: string };
      text?: string;
    }>;
  };

  if (typeof candidate.delta === "string") {
    return candidate.delta;
  }

  if (typeof candidate.content === "string") {
    return candidate.content;
  }

  if (typeof candidate.text === "string") {
    return candidate.text;
  }

  const choice = candidate.choices?.[0];
  if (typeof choice?.delta?.content === "string") {
    return choice.delta.content;
  }

  if (typeof choice?.text === "string") {
    return choice.text;
  }

  return "";
}

/**
 * Generate an embedding for a piece of text through Cencori.
 */
export async function embed(text: string): Promise<number[]> {
  if (!isEmbeddingAvailable()) {
    throw new Error(
      "Embeddings are not configured. Set CENCORI_API_KEY or add a local embedding provider."
    );
  }

  const response = await getCencoriClient().ai.embeddings({
    model: EMBED_MODEL,
    input: text,
  });

  return response.embeddings[0];
}

/**
 * Check if Cencori is reachable (i.e., we have internet).
 */
export async function isOnline(): Promise<boolean> {
  try {
    await fetch("https://cencori.com/api/ai/chat", {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}

export function isEmbeddingAvailable(): boolean {
  return EMBED_PROVIDER === "cencori" && Boolean(process.env.CENCORI_API_KEY);
}

export function isBackgroundAIEnabled(): boolean {
  return BACKGROUND_AI_ENABLED;
}

function resolveChatProvider(): ChatProvider {
  const configuredProvider = process.env.CHAT_PROVIDER?.trim().toLowerCase();

  if (configuredProvider === "ollama") {
    return "ollama";
  }

  if (configuredProvider === "cencori") {
    return "cencori";
  }

  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST) {
    return "ollama";
  }

  return "cencori";
}

function resolveEmbedProvider(): EmbedProvider {
  const configuredProvider = process.env.EMBED_PROVIDER?.trim().toLowerCase();

  if (configuredProvider === "none") {
    return "none";
  }

  if (configuredProvider === "cencori") {
    return "cencori";
  }

  if (process.env.CENCORI_API_KEY) {
    return "cencori";
  }

  return "none";
}

function resolveBackgroundAIEnabled(): boolean {
  const configured = process.env.BACKGROUND_AI_ENABLED?.trim().toLowerCase();

  if (configured === "true") {
    return true;
  }

  if (configured === "false") {
    return false;
  }

  return CHAT_PROVIDER !== "ollama";
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildOllamaOptions(options: ChatOptions): Record<string, number> | undefined {
  const ollamaOptions: Record<string, number> = {};

  if (typeof options.temperature === "number") {
    ollamaOptions.temperature = options.temperature;
  }

  if (typeof options.maxTokens === "number") {
    ollamaOptions.num_predict = options.maxTokens;
  }

  return Object.keys(ollamaOptions).length > 0 ? ollamaOptions : undefined;
}

function extractOllamaStreamText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?: string;
      message?: { content?: string };
    };

    if (parsed.error) {
      throw new Error(parsed.error);
    }

    return parsed.message?.content || "";
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to parse Ollama stream chunk.");
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string; message?: string };
    return data.error || data.message || `${response.status} ${response.statusText}`;
  } catch {
    const text = await response.text();
    return text || `${response.status} ${response.statusText}`;
  }
}
