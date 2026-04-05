import { NextRequest, NextResponse } from "next/server";

const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"
).replace(/\/+$/, "");
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "qwen3-vl:8b";
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";

const VISION_SYSTEM_PROMPT = `You are Nicole's local vision analysis subsystem.

Analyze a screenshot and respond with JSON only. No markdown. No prose before or after the JSON.

Required shape:
{
  "summary": "one short sentence describing what is on screen",
  "visibleText": "important readable text relevant to the question, or null",
  "appOrSurface": "best guess at the app or surface, or null",
  "importantElements": ["short important element", "another"],
  "possibleIssues": ["likely issue if any"],
  "confidence": "high | medium | low",
  "captureNotes": "brief note about uncertainty, occlusion, or readability"
}

Keep the result concise and factual. Avoid personality or assistant phrasing.`;

interface VisionRequestBody {
  image?: string;
  question?: string;
  metadataHint?: string;
}

interface VisionAnalysis {
  summary: string;
  visibleText?: string;
  appOrSurface?: string;
  importantElements?: string[];
  possibleIssues?: string[];
  confidence?: string;
  captureNotes?: string;
}

export async function POST(req: NextRequest) {
  try {
    const { image, question, metadataHint }: VisionRequestBody = await req.json();

    if (!image) {
      return NextResponse.json({ error: "No image provided" }, { status: 400 });
    }

    const userContent = [
      `User question: ${(question || "What is on the screen?").trim()}`,
      metadataHint?.trim() ? `Metadata hint:\n${metadataHint.trim()}` : null,
      "Analyze the screenshot and answer using the required JSON shape only.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: userContent,
            images: [image],
          },
        ],
        stream: false,
        think: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return NextResponse.json(
        { error: `Vision model error: ${errorText}` },
        { status: 502 }
      );
    }

    const payload = (await response.json()) as {
      message?: { content?: string };
    };

    const content = payload.message?.content?.trim();
    if (!content) {
      return NextResponse.json(
        { error: "Vision model returned no analysis." },
        { status: 502 }
      );
    }

    const analysis = parseVisionAnalysis(content);
    return NextResponse.json({ analysis });
  } catch (error) {
    console.error("Vision endpoint error:", error);
    return NextResponse.json(
      { error: "Vision is unavailable right now." },
      { status: 503 }
    );
  }
}

function parseVisionAnalysis(raw: string): VisionAnalysis {
  const direct = decodeVisionAnalysis(raw);
  if (direct) {
    return direct;
  }

  const openBrace = raw.indexOf("{");
  const closeBrace = raw.lastIndexOf("}");
  if (openBrace >= 0 && closeBrace >= openBrace) {
    const extracted = decodeVisionAnalysis(raw.slice(openBrace, closeBrace + 1));
    if (extracted) {
      return extracted;
    }
  }

  return {
    summary: raw.trim() || "The screen is visible, but the vision analysis was incomplete.",
    confidence: "low",
    captureNotes: "The vision model returned an unstructured answer.",
  };
}

function decodeVisionAnalysis(candidate: string): VisionAnalysis | null {
  try {
    const parsed = JSON.parse(candidate) as Partial<VisionAnalysis>;
    const summary = parsed.summary?.trim();

    if (!summary) {
      return null;
    }

    return {
      summary,
      visibleText: parsed.visibleText?.trim() || undefined,
      appOrSurface: parsed.appOrSurface?.trim() || undefined,
      importantElements: normalizeList(parsed.importantElements),
      possibleIssues: normalizeList(parsed.possibleIssues),
      confidence: parsed.confidence?.trim() || undefined,
      captureNotes: parsed.captureNotes?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

function normalizeList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  return normalized.length > 0 ? normalized.slice(0, 8) : undefined;
}
