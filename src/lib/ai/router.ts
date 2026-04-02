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
    const stream = cencori.ai.chatStream({
      model: CHAT_MODEL,
      messages,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });

    const encoder = new TextEncoder();

    return new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream as AsyncIterable<{ delta?: string }>) {
            if (chunk?.delta) {
              controller.enqueue(encoder.encode(chunk.delta));
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
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
