import type { Config } from "tailwindcss";

/**
 * tailwind.config.ts — neo-brutalist theme scale.
 *
 * Every colour resolves to a CSS custom property declared in app/globals.css, so the palette
 * changes in exactly one place. Components should prefer the semantic aliases (bg, surface,
 * ink, accent) and reach for the raw pop colours (cyan, pink, lime, yellow) only for the
 * deliberate "one loud block per panel" accents.
 *
 * border-radius is pinned to 0 across the entire scale — square corners are part of the
 * design language, not an oversight (RULES.md §2).
 */
const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        /* Canvas + surfaces */
        canvas: "var(--purple)",
        "canvas-deep": "var(--purple-deep)",
        surface: "var(--paper)",
        "surface-alt": "var(--surface-alt)",

        /* Ink */
        ink: "var(--ink)",
        "ink-soft": "var(--text-secondary)",

        /* Pop palette */
        pop: {
          cyan: "var(--cyan)",
          pink: "var(--pink)",
          lime: "var(--lime)",
          yellow: "var(--yellow)",
          "yellow-soft": "var(--yellow-soft)",
          red: "var(--red)",
        },

        /* Back-compat aliases (existing `bg-[var(--bg)]`-style usage) */
        bg: "var(--bg)",
        "bg-elevated": "var(--bg-elevated)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        accent: "var(--accent)",
        error: "var(--error)",
      },
      borderWidth: {
        brutal: "3px",
      },
      boxShadow: {
        /* Hard, zero-blur offsets — the signature of the whole theme. */
        hard: "5px 5px 0 var(--ink)",
        "hard-sm": "3px 3px 0 var(--ink)",
        "hard-lg": "8px 8px 0 var(--ink)",
      },
      borderRadius: {
        DEFAULT: "0",
        none: "0",
        sm: "0",
        md: "0",
        lg: "0",
        xl: "0",
        "2xl": "0",
        "3xl": "0",
        full: "0",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "sans-serif"],
      },
      transitionDuration: {
        /* Interactive state changes stay snappy and hard-edged. */
        snap: "150ms",
      },
    },
  },
  plugins: [],
};
export default config;
