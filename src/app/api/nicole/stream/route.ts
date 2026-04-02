import { NextRequest, NextResponse } from "next/server";
import { chat } from "@/lib/ai/router";
import { buildSystemPrompt } from "@/lib/ai/personality";
import { ChatMessage } from "@/lib/ai/types";
import {
  loadMemories,
  loadRecentMessages,
  saveChatMessage,
  extractAndStoreMemories,
} from "@/lib/ai/memory";
import { searchWeb, formatSearchResults } from "@/lib/search/web";
import { deepResearch } from "@/lib/search/research";
import { loadRelevantSourceContext } from "@/lib/search/semantic";

const SEARCH_INTENT_PROMPT = `Determine if this message requires a web search or deep research to answer properly. Return ONLY a JSON object:
- If deep research needed (e.g. "look me up", "search me", "find out about me", "research [person]"): {"search": true, "deep": true, "query": "person's full name or search terms"}
- If quick search needed: {"search": true, "deep": false, "query": "optimized search query"}
- If no search needed: {"search": false}

Deep research: when someone asks you to research a person thoroughly - read multiple pages and remember everything.
Quick search: current events, recent news, "look up", "search for", "what's the latest", facts you're unsure about.
Messages that don't need search: personal conversation, opinions, things from memory, study/source material questions, greetings.`;

export async function POST(req: NextRequest) {
  try {
    const { message }: { message: string } = await req.json();

    if (!message?.trim()) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    await saveChatMessage("user", message);

    const [memoryText, recentMessages, sourceContext] = await Promise.all([
      loadMemories(),
      loadRecentMessages(),
      loadRelevantSourceContext(message),
    ]);

    let searchContext = "";

    try {
      const intentResponse = await chat([
        { role: "system", content: SEARCH_INTENT_PROMPT },
        { role: "user", content: message },
      ]);

      const intentText =
        typeof intentResponse === "string"
          ? intentResponse
          : String(intentResponse);
      const cleaned = intentText
        .replace(/```json?\n?/g, "")
        .replace(/```/g, "")
        .trim();
      const intent = JSON.parse(cleaned);

      if (intent.search && intent.query) {
        if (intent.deep) {
          const result = await deepResearch(intent.query);
          searchContext = `[Deep research complete: read ${result.pagesRead} pages, extracted ${result.factsExtracted} facts about "${intent.query}". The facts have been saved to your memory. Use them naturally in your response - tell the person what you found out about them.]`;
        } else {
          const results = await searchWeb(intent.query);
          searchContext = formatSearchResults(results);
        }
      }
    } catch {
      // Search intent detection is optional.
    }

    const systemPrompt = buildSystemPrompt({
      memories: memoryText || undefined,
      sourceContext: sourceContext || undefined,
    });

    let fullSystemPrompt = systemPrompt;
    if (searchContext) {
      fullSystemPrompt += `\n\n## Web search results\nYou searched the web for the user's question. Use these results naturally - don't list them as bullet points, weave the information into your response. Cite sources briefly if relevant.\n\n${searchContext}`;
    }

    const fullMessages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...recentMessages,
      { role: "user", content: message },
    ];

    const stream = await chat(fullMessages, { stream: true });

    if (!(stream instanceof ReadableStream)) {
      return NextResponse.json(
        { error: "Streaming is unavailable right now." },
        { status: 503 }
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const responseStream = new ReadableStream({
      async start(controller) {
        let fullContent = "";

        try {
          const reader = stream.getReader();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            fullContent += chunk;
            controller.enqueue(encoder.encode(chunk));
          }
        } catch (error) {
          console.error("Nicole stream error:", error);
        } finally {
          if (fullContent) {
            await saveChatMessage("assistant", fullContent);

            const lastExchange: ChatMessage[] = [
              { role: "user", content: message },
              { role: "assistant", content: fullContent },
            ];

            extractAndStoreMemories(lastExchange).catch(() => {});
          }

          controller.close();
        }
      },
    });

    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Nicole error:", error);
    return NextResponse.json(
      {
        error:
          "I can't reach my brain right now. Are you connected to the internet?",
      },
      { status: 503 }
    );
  }
}
