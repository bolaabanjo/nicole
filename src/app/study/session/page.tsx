"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Source {
  id: string;
  title: string;
  type: string;
}

const MODE_LABELS: Record<string, string> = {
  socratic: "Socratic Dialogue",
  feynman: "Feynman Mode",
  review: "Review",
};

const MODE_STARTERS: Record<string, string> = {
  socratic:
    "I've read through your source material. Let's test your understanding. Ready?",
  feynman:
    "Go ahead — explain this concept in your own words. I'll tell you where you're right, where you're oversimplifying, and where you're off.",
  review:
    "Let's review what you've studied. I'll ask questions to find where your understanding is strongest and where it needs work.",
};

export default function StudySessionPage() {
  return (
    <Suspense
      fallback={
        <div className="text-xs text-[var(--muted)] font-mono">Loading...</div>
      }
    >
      <StudySession />
    </Suspense>
  );
}

function StudySession() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const mode = searchParams.get("mode") || "socratic";
  const sourceId = searchParams.get("source") || "";

  const [source, setSource] = useState<Source | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [started, setStarted] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fetch source info
  useEffect(() => {
    if (!sourceId) return;
    fetch("/api/sources")
      .then((r) => r.json())
      .then((data: Source[]) => {
        const found = data.find((s) => s.id === sourceId);
        if (found) setSource(found);
      })
      .catch(() => {});
  }, [sourceId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Start session with Nicole's opening message
  const startSession = async () => {
    setStarted(true);
    const opener: Message = {
      role: "assistant",
      content: MODE_STARTERS[mode] || MODE_STARTERS.socratic,
    };
    setMessages([opener]);
    inputRef.current?.focus();
  };

  const sendMessage = async () => {
    if (!input.trim() || streaming) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setStreaming(true);

    try {
      const res = await fetch("/api/study", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          sourceId,
          messages: updatedMessages,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: err.error || "Something went wrong.",
          },
        ]);
        setStreaming(false);
        return;
      }

      // Handle streaming response
      const reader = res.body?.getReader();
      if (!reader) {
        setStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let assistantContent = "";

      // Add empty assistant message to fill in
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });

        // Parse SSE chunks — handle both raw text and SSE format
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta =
                parsed.choices?.[0]?.delta?.content ||
                parsed.content ||
                parsed.text ||
                "";
              assistantContent += delta;
            } catch {
              // Raw text chunk
              assistantContent += data;
            }
          } else if (line.trim() && !line.startsWith(":")) {
            // Raw streaming text (not SSE formatted)
            try {
              const parsed = JSON.parse(line);
              const delta =
                parsed.choices?.[0]?.delta?.content ||
                parsed.content ||
                parsed.text ||
                "";
              assistantContent += delta;
            } catch {
              assistantContent += line;
            }
          }
        }

        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: assistantContent,
          };
          return updated;
        });
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Nicole is offline. Check your internet connection.",
        },
      ]);
    } finally {
      setStreaming(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!sourceId) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[var(--muted)]">
          No source selected.
        </p>
        <button
          onClick={() => router.push("/study")}
          className="text-sm underline underline-offset-4 text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Back to Study
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 120px)" }}>
      {/* Header */}
      <div className="flex items-baseline justify-between pb-4 border-b border-[var(--border)]">
        <div>
          <div className="text-sm font-medium">
            {MODE_LABELS[mode] || mode}
          </div>
          <div className="text-xs text-[var(--muted)] font-mono mt-1">
            {source?.title || "Loading..."}
          </div>
        </div>
        <button
          onClick={() => router.push("/study")}
          className="text-xs text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
        >
          End session
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-4">
        {!started && (
          <div className="flex items-center justify-center h-full">
            <button
              onClick={startSession}
              className="px-6 py-3 text-sm border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)] hover:text-[var(--background)] transition-colors"
            >
              Start session
            </button>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-[var(--foreground)] text-[var(--background)] px-4 py-3"
                  : "text-[var(--foreground)]"
              }`}
            >
              {msg.role === "assistant" && (
                <span className="text-xs text-[var(--muted)] font-mono block mb-2">
                  nicole
                </span>
              )}
              {msg.content}
              {streaming && i === messages.length - 1 && msg.role === "assistant" && (
                <span className="inline-block w-1.5 h-4 bg-[var(--muted)] ml-0.5 animate-pulse" />
              )}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {started && (
        <div className="border-t border-[var(--border)] pt-4">
          <div className="flex gap-3">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === "feynman"
                  ? "Explain the concept in your own words..."
                  : "Type your response..."
              }
              rows={2}
              className="flex-1 bg-transparent border border-[var(--border)] px-3 py-2 text-sm outline-none focus:border-[var(--muted)] transition-colors resize-none"
            />
            <button
              onClick={sendMessage}
              disabled={streaming || !input.trim()}
              className="px-4 py-2 text-sm border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)] hover:text-[var(--background)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed self-end"
            >
              Send
            </button>
          </div>
          <div className="text-xs text-[var(--muted)] mt-2 font-mono opacity-50">
            shift+enter for new line
          </div>
        </div>
      )}
    </div>
  );
}
