"use client";

import { useState, useRef, useEffect } from "react";
import { ArrowRightIcon } from "@heroicons/react/24/solid";

interface Message {
  role: "user" | "assistant";
  content: string;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning, Roy. ";
  if (hour < 17) return "Hey, Roy. ";
  if (hour < 21) return "Evening, Roy. ";
  return "Late one tonight, Roy. ";
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input on load
  useEffect(() => {
    inputRef.current?.focus();
    setGreeted(true);
  }, []);

  const sendMessage = async () => {
    if (!input.trim() || sending) return;

    const userMessage: Message = { role: "user", content: input.trim() };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setSending(true);

    // Auto-resize textarea back to default
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    try {
      const res = await fetch("/api/nicole", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedMessages }),
      });

      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.error || "Something went wrong." },
        ]);
        return;
      }

      const content =
        typeof data.content === "string"
          ? data.content
          : data.content?.toString() || "...";

      setMessages((prev) => [...prev, { role: "assistant", content }]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I'm offline right now." },
      ]);
    } finally {
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
    // Auto-resize
    const textarea = e.target;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
  };

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 100px)" }}>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {/* Nicole's greeting */}
        {greeted && messages.length === 0 && (
          <div className="py-8">
            <div className="text-sm text-[var(--muted)] mb-1 font-mono">
              nicole
            </div>
            <div className="text-sm leading-relaxed">
              {getGreeting()} What&apos;s on your mind?
            </div>
          </div>
        )}

        {/* Conversation */}
        <div className="space-y-6 py-4">
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === "assistant" ? (
                <div>
                  <div className="text-sm text-[var(--muted)] mb-1 font-mono">
                    nicole
                  </div>
                  <div className="text-sm leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                    {sending && i === messages.length - 1 && (
                      <span className="inline-block w-1.5 h-4 bg-[var(--muted)] ml-0.5 animate-pulse" />
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <div className="text-sm leading-relaxed text-[var(--muted)] max-w-[85%] whitespace-pre-wrap">
                    {msg.content}
                  </div>
                </div>
              )}
            </div>
          ))}

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

      {/* Input */}
      <div className="pb-4 pt-2">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Talk to Nicole..."
            rows={1}
            className="w-full bg-transparent border-b border-[var(--border)] px-1 py-3 text-sm outline-none focus:border-[var(--muted)] transition-colors resize-none overflow-hidden pr-12"
            style={{ minHeight: "40px" }}
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
