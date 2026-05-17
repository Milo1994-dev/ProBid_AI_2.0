/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Space Grotesk", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      colors: {
        brand: {
          bg: "#0a0e1a",
          card: "#121a2a",
          cardHover: "#1a2740",
          border: "rgba(79,70,229,0.3)",
          green: "#22c55e",
          greenDark: "#16a34a",
          indigo: "#4f46e5",
          indigoDark: "#3730a3",
          textPrimary: "#e8f0ff",
          textMuted: "#94a3b8",
          textSubtle: "#64748b",
          primary: "#22c55e",
          text: "#e8f0ff",
          muted: "#94a3b8",
          error: "#ef4444",
          warning: "#f59e0b",
        },
      },
      backgroundImage: {
        "grid-pattern":
          "linear-gradient(to right, rgba(148, 163, 184, 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.05) 1px, transparent 1px)",
      },
    },
  },
  plugins: [],
};
