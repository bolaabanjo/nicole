import { cencori } from "./cencori";
import { ChatMessage, ChatOptions, EmbeddingResponse } from "./types";

const CHAT_MODEL = process.env.CHAT_MODEL || "gemini-2.5-flash";
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-004";

/**
 * Send a chat request through Cencori.
 * All AI inference is routed here — never directly to a provider.
 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string | ReadableStream> {
  if (options.stream) {
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
  const response = await cencori.ai.embeddings({
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
    const res = await fetch("https://cencori.com/api/ai/chat", {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return true;
  } catch {
    return false;
  }
}
