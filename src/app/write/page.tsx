export default function Write() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Write</h1>
        <p className="text-[var(--muted)] text-sm">
          Drafts, notes, and thesis work. Nicole critiques against your sources.
        </p>
      </div>

      {/* New note */}
      <div className="border border-[var(--border)] p-4">
        <div className="text-sm font-medium mb-2">New draft</div>
        <div className="text-xs text-[var(--muted)]">
          Editor coming soon. Tiptap with AI critique.
        </div>
      </div>

      {/* Notes list */}
      <div className="text-xs text-[var(--muted)] font-mono">
        No notes yet.
      </div>
    </div>
  );
}
