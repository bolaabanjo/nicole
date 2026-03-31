export default function Dashboard() {
  return (
    <div className="space-y-12">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Good to see you, Roy.
        </h1>
        <p className="text-[var(--muted)] text-sm">
          What are we working on today?
        </p>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-2 gap-3">
        <a
          href="/study"
          className="border border-[var(--border)] p-4 hover:border-[var(--muted)] transition-colors"
        >
          <div className="text-sm font-medium mb-1">Study</div>
          <div className="text-xs text-[var(--muted)]">
            Socratic dialogue or Feynman mode
          </div>
        </a>
        <a
          href="/library"
          className="border border-[var(--border)] p-4 hover:border-[var(--muted)] transition-colors"
        >
          <div className="text-sm font-medium mb-1">Library</div>
          <div className="text-xs text-[var(--muted)]">
            Browse or ingest new sources
          </div>
        </a>
        <a
          href="/research"
          className="border border-[var(--border)] p-4 hover:border-[var(--muted)] transition-colors"
        >
          <div className="text-sm font-medium mb-1">Research</div>
          <div className="text-xs text-[var(--muted)]">
            Threads and literature review
          </div>
        </a>
        <a
          href="/write"
          className="border border-[var(--border)] p-4 hover:border-[var(--muted)] transition-colors"
        >
          <div className="text-sm font-medium mb-1">Write</div>
          <div className="text-xs text-[var(--muted)]">
            Drafts, notes, and thesis work
          </div>
        </a>
      </div>

      {/* Status */}
      <div className="border-t border-[var(--border)] pt-6">
        <div className="text-xs text-[var(--muted)] font-mono space-y-1">
          <div>sources: 0</div>
          <div>concepts: 0</div>
          <div>threads: 0</div>
          <div>sessions: 0</div>
        </div>
      </div>
    </div>
  );
}
