"use client";

import { useState, useEffect, useRef } from "react";

interface Source {
  id: string;
  title: string;
  type: string;
  scope: "personal" | "study";
  url: string | null;
  ingestedAt: string;
  chunkCount: number;
}

export default function Library() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [mode, setMode] = useState<"pdf" | "url" | "note">("note");
  const [scope, setScope] = useState<"study" | "personal">("study");
  const [scopeFilter, setScopeFilter] = useState<"all" | "study" | "personal">(
    "all"
  );
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchSources = async () => {
    try {
      const params =
        scopeFilter === "all"
          ? ""
          : `?scope=${encodeURIComponent(scopeFilter)}`;
      const res = await fetch(`/api/sources${params}`);
      if (res.ok) {
        const data = await res.json();
        setSources(data);
      }
    } catch {
      // DB might not be ready yet
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSources();
  }, [scopeFilter]);

  const handleIngest = async () => {
    if (!title.trim()) return;
    setIngesting(true);

    try {
      const formData = new FormData();
      formData.append("type", mode);
      formData.append("title", title);
      formData.append("scope", scope);

      if (mode === "pdf" && fileRef.current?.files?.[0]) {
        formData.append("file", fileRef.current.files[0]);
      } else if (mode === "url") {
        formData.append("url", url);
      } else if (mode === "note") {
        formData.append("content", noteContent);
      }

      const res = await fetch("/api/ingest", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        setTitle("");
        setUrl("");
        setNoteContent("");
        if (fileRef.current) fileRef.current.value = "";
        await fetchSources();
      }
    } catch (error) {
      console.error("Ingest failed:", error);
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Library</h1>
        <p className="text-[var(--muted)] text-sm">
          Keep Nicole's personal context separate from study material.
        </p>
      </div>

      {/* Ingest form */}
      <div className="border border-[var(--border)] p-4 space-y-4">
        <div className="text-sm font-medium">Ingest a source</div>

        {/* Type selector */}
        <div className="flex gap-2">
          {(["note", "url", "pdf"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setMode(t)}
              className={`px-3 py-1 text-xs font-mono border transition-colors ${
                mode === t
                  ? "border-[var(--foreground)] text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <div className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--muted)]">
            Source scope
          </div>
          <div className="flex gap-2">
            {(["study", "personal"] as const).map((candidateScope) => (
              <button
                key={candidateScope}
                onClick={() => setScope(candidateScope)}
                className={`px-3 py-1 text-xs font-mono border transition-colors ${
                  scope === candidateScope
                    ? "border-[var(--foreground)] text-[var(--foreground)]"
                    : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]"
                }`}
              >
                {candidateScope}
              </button>
            ))}
          </div>
          <div className="text-xs text-[var(--muted)]">
            `study` stays in the library for source-grounded work. `personal`
            can be used in Nicole's main chat.
          </div>
        </div>

        {/* Title */}
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-transparent border border-[var(--border)] px-3 py-2 text-sm outline-none focus:border-[var(--muted)] transition-colors"
        />

        {/* Type-specific input */}
        {mode === "url" && (
          <input
            type="url"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full bg-transparent border border-[var(--border)] px-3 py-2 text-sm outline-none focus:border-[var(--muted)] transition-colors font-mono"
          />
        )}

        {mode === "pdf" && (
          <input
            ref={fileRef}
            type="file"
            accept=".pdf"
            className="text-sm text-[var(--muted)] file:mr-4 file:py-1 file:px-3 file:border file:border-[var(--border)] file:text-sm file:bg-transparent file:text-[var(--muted)] file:cursor-pointer"
          />
        )}

        {mode === "note" && (
          <textarea
            placeholder="Paste your notes here..."
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            rows={6}
            className="w-full bg-transparent border border-[var(--border)] px-3 py-2 text-sm outline-none focus:border-[var(--muted)] transition-colors resize-none font-mono"
          />
        )}

        <button
          onClick={handleIngest}
          disabled={ingesting || !title.trim()}
          className="px-4 py-2 text-sm border border-[var(--foreground)] text-[var(--foreground)] hover:bg-[var(--foreground)] hover:text-[var(--background)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {ingesting ? "Ingesting..." : "Ingest"}
        </button>
      </div>

      {/* Sources list */}
      <div className="space-y-3">
        <div className="flex gap-2">
          {(["all", "study", "personal"] as const).map((candidateFilter) => (
            <button
              key={candidateFilter}
              onClick={() => setScopeFilter(candidateFilter)}
              className={`px-3 py-1 text-xs font-mono border transition-colors ${
                scopeFilter === candidateFilter
                  ? "border-[var(--foreground)] text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:border-[var(--muted)]"
              }`}
            >
              {candidateFilter}
            </button>
          ))}
        </div>

        <div className="space-y-1">
        {loading && (
          <div className="text-xs text-[var(--muted)] font-mono">
            Loading...
          </div>
        )}

        {!loading && sources.length === 0 && (
          <div className="text-xs text-[var(--muted)] font-mono">
            No sources yet. Ingest something to get started.
          </div>
        )}

        {sources.map((source) => (
          <div
            key={source.id}
            className="flex items-baseline justify-between py-3 border-b border-[var(--border)]"
          >
            <div>
              <div className="text-sm">{source.title}</div>
              <div className="text-xs text-[var(--muted)] font-mono mt-1">
                {source.scope} · {source.type} · {source.chunkCount} chunks ·{" "}
                {new Date(source.ingestedAt).toLocaleDateString()}
              </div>
            </div>
          </div>
        ))}
        </div>
      </div>

      {/* Count */}
      {sources.length > 0 && (
        <div className="text-xs text-[var(--muted)] font-mono opacity-50">
          {sources.length} {sources.length === 1 ? "source" : "sources"}
        </div>
      )}
    </div>
  );
}
