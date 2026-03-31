import { ChatMessage, ChatOptions, EmbeddingResponse } from "./types";

const CENCORI_BASE = process.env.CENCORI_API_URL;
const CENCORI_KEY = process.env.CENCORI_API_KEY;

/**
 * Send a chat request through Cencori.
 * All AI inference is routed here — never directly to a provider.
 */
export async function chat(
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<string | ReadableStream> {
  const res = await fetch(`${CENCORI_BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CENCORI_KEY}`,
    },
    body: JSON.stringify({ messages, ...options }),
  });

  if (!res.ok) {
    throw new Error(`Cencori error: ${res.status} ${res.statusText}`);
  }

  if (options.stream) {
    return res.body as ReadableStream;
  }

  const data = await res.json();
  return data.content;
}

/**
 * Generate an embedding for a piece of text through Cencori.
 */
export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${CENCORI_BASE}/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CENCORI_KEY}`,
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    throw new Error(`Cencori embed error: ${res.status} ${res.statusText}`);
  }

  const data: EmbeddingResponse = await res.json();
  return data.embedding;
}

/**
 * Check if Cencori is reachable (i.e., we have internet).
 */
export async function isOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${CENCORI_BASE}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
