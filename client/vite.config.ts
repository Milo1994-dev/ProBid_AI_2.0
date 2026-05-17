import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
      "/r": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
      "/estimate": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Function form keeps react subpaths (jsx-runtime, react-dom/client,
        // scheduler) in the react-vendor chunk; the object form leaks them
        // into whichever non-react chunk imports them first.
        manualChunks: (id) => {
          if (!id.includes("/node_modules/")) return undefined;
          if (id.includes("@tanstack/react-query")) return "react-query";
          if (id.includes("framer-motion")) return "framer-motion";
          if (
            /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(
              id,
            )
          ) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
    modulePreload: {
      // Default Vite preloads every transitive dep of the entry, including
      // async chunks reachable through React.lazy(). Restrict the entry HTML
      // to react-vendor; let runtime-resolved deps preload in parallel to
      // avoid waterfalls when a lazy chunk actually loads.
      resolveDependencies: (_filename, deps, { hostType }) => {
        if (hostType === "html") {
          return deps.filter((d) => /react-vendor/.test(d));
        }
        return deps;
      },
    },
  },
});
