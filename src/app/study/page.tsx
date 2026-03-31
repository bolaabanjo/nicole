export default function Study() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Study</h1>
        <p className="text-[var(--muted)] text-sm">
          Pick a mode. Nicole will challenge your understanding.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="border border-[var(--border)] p-4">
          <div className="text-sm font-medium mb-1">Socratic Dialogue</div>
          <div className="text-xs text-[var(--muted)]">
            Nicole asks probing questions to expose gaps in your understanding.
            She never gives answers directly.
          </div>
        </div>

        <div className="border border-[var(--border)] p-4">
          <div className="text-sm font-medium mb-1">Feynman Mode</div>
          <div className="text-xs text-[var(--muted)]">
            Explain a concept in your own words. Nicole tells you where
            you&apos;re wrong, oversimplifying, or missing something.
          </div>
        </div>

        <div className="border border-[var(--border)] p-4">
          <div className="text-sm font-medium mb-1">Review</div>
          <div className="text-xs text-[var(--muted)]">
            Revisit concepts you&apos;re weakest on. Spaced repetition based on
            understanding depth, not just time.
          </div>
        </div>
      </div>

      {/* Concepts to review */}
      <div className="border-t border-[var(--border)] pt-6">
        <div className="text-xs text-[var(--muted)] font-mono">
          No concepts tracked yet. Ingest sources to extract concepts.
        </div>
      </div>
    </div>
  );
}
