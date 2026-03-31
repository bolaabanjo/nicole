export default function Research() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Research</h1>
        <p className="text-[var(--muted)] text-sm">
          Research threads — living workspaces around a question.
        </p>
      </div>

      {/* New thread */}
      <div className="border border-[var(--border)] p-4">
        <div className="text-sm font-medium mb-2">Start a new thread</div>
        <input
          type="text"
          placeholder="What question are you investigating?"
          className="w-full bg-transparent border border-[var(--border)] px-3 py-2 text-sm outline-none focus:border-[var(--muted)] transition-colors"
          disabled
        />
      </div>

      {/* Threads list */}
      <div className="text-xs text-[var(--muted)] font-mono">
        No research threads yet.
      </div>
    </div>
  );
}
