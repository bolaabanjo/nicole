import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nicole",
  description: "Personal Intelligence Network",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased h-dvh overflow-hidden" suppressHydrationWarning>
        <div className="h-full flex flex-col max-w-3xl mx-auto px-6">
          {/* Nav — fixed at top */}
          <nav className="flex-shrink-0 flex items-center justify-between py-4 border-b border-[var(--border)]">
            <a href="/" className="text-lg font-semibold tracking-tight">
              Nicole
            </a>
            <div className="flex gap-6 text-sm text-[var(--muted)]">
              <a
                href="/library"
                className="hover:text-[var(--foreground)] transition-colors"
              >
                Library
              </a>
            </div>
          </nav>

          <main className="flex-1 min-h-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
