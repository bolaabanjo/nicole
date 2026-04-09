export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 z-50 flex w-full items-center justify-between border-b border-border/30 bg-background/90 px-[max(0.75rem,env(safe-area-inset-left))] py-2 pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur-lg">
      <div className="flex items-center gap-4">
        <a href="/" className="flex items-center gap-2" aria-label="Home">
          <span className="text-sm font-semibold text-foreground">Nicole</span>
        </a>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <a href="/library" className="transition-colors hover:text-foreground">
            Library
          </a>
        </div>
      </div>
    </nav>
  );
}
