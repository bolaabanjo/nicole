"use client";

import { useState, useRef, useEffect } from "react";
import { ArrowRightIcon } from "@heroicons/react/24/solid";
import { Markdown } from "@/components/Markdown";

interface ChatMsg {
  id?: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}

function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor(
    (today.getTime() - msgDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function getDateKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export default function Chat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load chat history on mount
  useEffect(() => {
    fetch("/api/nicole/history")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setMessages(data);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when loaded
  useEffect(() => {
    if (loaded) inputRef.current?.focus();
  }, [loaded]);

  const sendMessage = async () => {
    if (!input.trim() || sending) return;

    const userMsg: ChatMsg = {
      role: "user",
      content: input.trim(),
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    const assistantId = `${Date.now()}-assistant`;
    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const res = await fetch("/api/nicole/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg.content }),
      });

      if (!res.ok) {
        const data = await res.json();
        setMessages((prev) => [
          ...prev.filter((msg) => msg.id !== assistantId),
          {
            id: assistantId,
            role: "assistant",
            content: data.error || "Something went wrong.",
            createdAt: new Date().toISOString(),
          },
        ]);
        return;
      }

      setStreaming(true);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let streamedContent = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          streamedContent += decoder.decode(value, { stream: true });

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantId
                ? { ...msg, content: streamedContent }
                : msg
            )
          );
        }
      }
    } catch {
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: "I'm offline right now.",
              }
            : msg
        )
      );
    } finally {
      setStreaming(false);
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
  };

  // Build messages with date separators
  let lastDateKey = "";

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Conversation */}
        <div className="space-y-6 py-4">
          {messages.map((msg, i) => {
            const dateKey = msg.createdAt ? getDateKey(msg.createdAt) : "";
            const showDateSep = dateKey && dateKey !== lastDateKey;
            if (dateKey) lastDateKey = dateKey;

            return (
              <div key={msg.id || i}>
                {/* Date separator */}
                {showDateSep && msg.createdAt && (
                  <div className="flex justify-center py-4">
                    <span className="text-xs text-[var(--muted)] font-mono opacity-50">
                      {formatDateLabel(msg.createdAt)}
                    </span>
                  </div>
                )}

                {msg.role === "assistant" ? (
                  <div>
                    <div className="text-sm text-[var(--muted)] mb-1 font-mono">
                      nicole
                    </div>
                    <Markdown content={msg.content} />
                    {streaming && msg.id && i === messages.length - 1 && (
                      <span className="inline-block w-1.5 h-4 bg-[var(--muted)] animate-pulse ml-0.5" />
                    )}
                  </div>
                ) : (
                  <div className="flex justify-end">
                    <div className="text-sm leading-relaxed text-[var(--muted)] max-w-[85%] whitespace-pre-wrap">
                      {msg.content}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Thinking indicator */}
          {sending && messages[messages.length - 1]?.role === "user" && (
            <div>
              <div className="text-sm text-[var(--muted)] mb-1 font-mono">
                nicole
              </div>
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-pulse" />
                <span
                  className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-pulse"
                  style={{ animationDelay: "0.2s" }}
                />
                <span
                  className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-pulse"
                  style={{ animationDelay: "0.4s" }}
                />
              </div>
            </div>
          )}
        </div>

        <div ref={messagesEndRef} />
      </div>

      {/* Input — fixed at bottom */}
      <div className="flex-shrink-0 pb-4 pt-2">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Talk to Nicole..."
            rows={1}
            className="w-full bg-transparent border-b border-[var(--border)] px-1 py-3 text-sm outline-none focus:border-[var(--muted)] transition-colors resize-none overflow-hidden pr-12"
            style={{ minHeight: "40px", fontSize: "16px" }}
          />
          <button
            onClick={sendMessage}
            disabled={sending || !input.trim()}
            className="absolute right-0 bottom-2.5 p-1.5 text-[var(--muted)] hover:text-[var(--foreground)] transition-colors disabled:opacity-0"
          >
            <ArrowRightIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
