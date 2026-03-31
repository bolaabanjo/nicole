"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

interface Source {
  id: string;
  title: string;
  type: string;
  chunkCount: number;
}

const MODES = [
  {
    id: "socratic",
    name: "Socratic Dialogue",
    description:
      "Nicole asks probing questions to expose gaps in your understanding. She never gives answers directly.",
  },
  {
    id: "feynman",
    name: "Feynman Mode",
    description:
      "Explain a concept in your own words. Nicole tells you where you're wrong, oversimplifying, or missing something.",
  },
  {
    id: "review",
    name: "Review",
    description:
      "Revisit concepts you're weakest on. Spaced repetition based on understanding depth, not just time.",
  },
];

export default function Study() {
  const router = useRouter();
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [selectedMode, setSelectedMode] = useState<string>("");

  useEffect(() => {
    fetch("/api/sources")
      .then((r) => r.json())
      .then((data) => {
        setSources(data);
        if (data.length > 0) setSelectedSource(data[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const startSession = () => {
    if (!selectedSource || !selectedMode) return;
    router.push(
      `/study/session?mode=${selectedMode}&source=${selectedSource}`
    );
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Study</h1>
        <p className="text-[var(--muted)] text-sm">
          Pick a source and a mode. Nicole will challenge your understanding.
        </p>
      </div>

      {/* Source selector */}
      <div className="space-y-3">
        <div className="text-sm font-medium">Source material</div>
        {loading ? (
          <div className="text-xs text-[var(--muted)] font-mono">
            Loading sources...
          </div>
        ) : sources.length === 0 ? (
          <div className="text-xs text-[var(--muted)] font-mono">
            No sources yet.{" "}
            <a
              href="/library"
              className="underline underline-offset-4 hover:text-[var(--foreground)]"
            >
              Ingest something first
            </a>
            .
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {sources.map((source) => (
              <button
                key={source.id}
                onClick={() => setSelectedSource(source.id)}
                className={`text-left border p-3 transition-colors ${
                  selectedSource === source.id
                    ? "border-[var(--foreground)]"
                    : "border-[var(--border)] hover:border-[var(--muted)]"
                }`}
              >
                <div className="text-sm">{source.title}</div>
                <div className="text-xs text-[var(--muted)] font-mono mt-1">
                  {source.type} · {source.chunkCount} chunks
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Mode selector */}
      <div className="space-y-3">
        <div className="text-sm font-medium">Study mode</div>
        <div className="grid grid-cols-1 gap-2">
          {MODES.map((mode) => (
            <button
              key={mode.id}
              onClick={() => setSelectedMode(mode.id)}
              className={`text-left border p-4 transition-colors ${
                selectedMode === mode.id
                  ? "border-[var(--foreground)]"
                  : "border-[var(--border)] hover:border-[var(--muted)]"
              }`}
            >
              <div className="text-sm font-medium mb-1">{mode.name}</div>
              <div className="text-xs text-[var(--muted)]">
                {mode.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Start button */}
      <button
        onClick={startSession}
        disabled={!selectedSource || !selectedMode}
        className="px-6 py-3 text-sm border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)] hover:text-[var(--background)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Start session
      </button>
    </div>
  );
}
