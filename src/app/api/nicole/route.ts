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

Deep research: when someone asks you to research a person thoroughly — read multiple pages and remember everything.
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

    // Save the user's message immediately
    await saveChatMessage("user", message);

    // Load context in parallel
    const [memoryText, recentMessages, sourceContext] = await Promise.all([
      loadMemories(),
      loadRecentMessages(),
      loadRelevantSourceContext(message),
    ]);

    // Check if Nicole needs to search the web
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
          // Deep research — read multiple pages, extract facts, store as memories
          const result = await deepResearch(intent.query);
          searchContext = `[Deep research complete: read ${result.pagesRead} pages, extracted ${result.factsExtracted} facts about "${intent.query}". The facts have been saved to your memory. Use them naturally in your response — tell the person what you found out about them.]`;
        } else {
          const results = await searchWeb(intent.query);
          searchContext = formatSearchResults(results);
        }
      }
    } catch {
      // Search intent detection failed — not critical, continue without search
    }

    const systemPrompt = buildSystemPrompt({
      memories: memoryText || undefined,
      sourceContext: sourceContext || undefined,
    });

    // Build full prompt with search results if any
    let fullSystemPrompt = systemPrompt;
    if (searchContext) {
      fullSystemPrompt += `\n\n## Web search results\nYou searched the web for the user's question. Use these results naturally — don't list them as bullet points, weave the information into your response. Cite sources briefly if relevant.\n\n${searchContext}`;
    }

    const fullMessages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...recentMessages,
    ];

    const response = await chat(fullMessages);

    const content =
      typeof response === "string" ? response : String(response);

    // Save Nicole's response
    await saveChatMessage("assistant", content);

    // Extract memories in the background
    const lastExchange: ChatMessage[] = [
      { role: "user", content: message },
      { role: "assistant", content },
    ];
    extractAndStoreMemories(lastExchange).catch(() => {});

    return NextResponse.json({ content });
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
