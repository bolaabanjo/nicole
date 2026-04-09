import { getCencoriClient } from "./cencori";
import { ChatMessage, ChatOptions } from "./types";

type ChatProvider = "cencori" | "ollama";
type EmbedProvider = "cencori" | "ollama" | "none";

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
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const OLLAMA_THINKING_ENABLED =
  process.env.OLLAMA_THINKING_ENABLED?.trim().toLowerCase() === "true";
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";
const OLLAMA_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.OLLAMA_REQUEST_TIMEOUT_MS || "120000",
  10
);
const OLLAMA_EMBED_TIMEOUT_MS = Number.parseInt(
  process.env.OLLAMA_EMBED_TIMEOUT_MS || "45000",
  10
);
const CHAT_FALLBACK_PROVIDER =
  process.env.CHAT_FALLBACK_PROVIDER === "cencori" ? "cencori" : null;
const BACKGROUND_AI_ENABLED = resolveBackgroundAIEnabled();
let lastChatWarmAt = 0;
const CHAT_WARM_TTL_MS = 5 * 60 * 1000;

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

export async function warmChatRuntime(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastChatWarmAt < CHAT_WARM_TTL_MS) {
    return;
  }

  const warmMessages: ChatMessage[] = [
    { role: "system", content: "You are Nicole. Reply with one short word." },
    { role: "user", content: "ready" },
  ];

  try {
    await chat(warmMessages, {
      temperature: 0,
      maxTokens: 4,
    });
    lastChatWarmAt = now;
  } catch (error) {
    console.warn(
      "Voice chat warmup failed:",
      error instanceof Error ? error.message : error
    );
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
      think: OLLAMA_THINKING_ENABLED,
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
      think: OLLAMA_THINKING_ENABLED,
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
 * Generate an embedding through the configured embedding provider.
 */
export async function embed(text: string): Promise<number[]> {
  if (!isEmbeddingAvailable()) {
    throw new Error(
      "Embeddings are not configured. Set CENCORI_API_KEY or add a local embedding provider."
    );
  }

  if (EMBED_PROVIDER === "ollama") {
    return ollamaEmbed(text);
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
  if (EMBED_PROVIDER === "ollama") {
    return Boolean(OLLAMA_BASE_URL);
  }

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

  if (configuredProvider === "ollama") {
    return "ollama";
  }

  if (configuredProvider === "cencori") {
    return "cencori";
  }

  if (CHAT_PROVIDER === "ollama" && (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST)) {
    return "ollama";
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

async function ollamaEmbed(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OLLAMA_EMBED_MODEL,
      input: text,
      keep_alive: OLLAMA_KEEP_ALIVE,
    }),
    signal: AbortSignal.timeout(OLLAMA_EMBED_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Ollama embedding error: ${await readError(response)}`);
  }

  const data = (await response.json()) as {
    error?: string;
    embeddings?: number[][];
    embedding?: number[];
  };

  if (data.error) {
    throw new Error(`Ollama embedding error: ${data.error}`);
  }

  if (Array.isArray(data.embedding) && data.embedding.length > 0) {
    return data.embedding;
  }

  const firstEmbedding = Array.isArray(data.embeddings) ? data.embeddings[0] : null;
  if (Array.isArray(firstEmbedding) && firstEmbedding.length > 0) {
    return firstEmbedding;
  }

  throw new Error("Ollama did not return an embedding vector.");
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
