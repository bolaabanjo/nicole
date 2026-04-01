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
      <body className="antialiased min-h-screen" suppressHydrationWarning>
        <div className="max-w-3xl mx-auto px-6">
          {/* Nav */}
          <nav className="flex items-center justify-between py-6 border-b border-[var(--border)]">
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

          <main className="py-4">{children}</main>
        </div>
      </body>
    </html>
  );
}
