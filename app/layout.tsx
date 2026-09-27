import type { Metadata } from "next";
import "./globals.css";
import FloatingShapes from "@/components/FloatingShapes";

export const metadata: Metadata = {
  title: "WHAT-IF — Architecture Explorer",
  description:
    "Paste a public GitHub repo and get a structural flowchart, retold as a diner, an airport, or an anime battle arena.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {/* ── Ambient background: shapes (z-0), then the grid redrawn over them (z-1) ── */}
        <FloatingShapes />
        <div className="nb-grid-overlay" aria-hidden="true" />

        {/* z-10 lifts every real surface above the decoration layers. */}
        <header className="relative z-10 border-b-[3px] border-[var(--ink)] bg-[var(--yellow)]">
          <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between gap-4 px-4 py-3 sm:px-6 sm:py-4">
            {/* Brand mark, not a heading — the page's own hero carries the <h1>. */}
            <span className="nb-wordmark text-3xl sm:text-5xl">WHAT-IF</span>
            <span className="hidden text-[0.68rem] font-extrabold uppercase tracking-[0.18em] text-[var(--ink)] sm:block">
              Repo in &rarr; architecture out
            </span>
          </div>
        </header>

        <main className="relative z-10 mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
