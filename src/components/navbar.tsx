export function Navbar() {
  return (
    <nav className="fixed top-0 left-0 z-50 flex w-full items-center justify-between bg-background/90 backdrop-blur-lg border-b border-border/30 px-4 py-2">
      <div className="flex items-center gap-4">
        <a href="/" className="flex items-center gap-2" aria-label="Home">
          <span className="text-sm font-semibold text-foreground">Nicole</span>
        </a>
      </div>
    </nav>
  );
}
