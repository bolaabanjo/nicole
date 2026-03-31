export default function Library() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Library</h1>
        <p className="text-[var(--muted)] text-sm">
          Everything Nicole has ingested. PDFs, URLs, notes, transcripts.
        </p>
      </div>

      {/* Upload area */}
      <div className="border border-dashed border-[var(--border)] p-8 text-center">
        <p className="text-sm text-[var(--muted)]">
          Drop a file here or paste a URL to ingest
        </p>
        <p className="text-xs text-[var(--muted)] mt-2 font-mono">
          PDF, URL, Markdown, YouTube
        </p>
      </div>

      {/* Sources list */}
      <div className="text-xs text-[var(--muted)] font-mono">
        No sources yet. Ingest something to get started.
      </div>
    </div>
  );
}
