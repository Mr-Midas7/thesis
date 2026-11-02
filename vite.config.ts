import { defineConfig, loadEnv, type ViteDevServer } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The offline copy runs with --mode offline (npm run offline), which loads
// .env.offline over .env. The browser then reaches the local Supabase through
// this server at /supabase, so phones on the laptop's hotspot only need the
// app's address. Port 4000 keeps its browser data apart from npm run dev.
export default defineConfig(({ mode }) => ({
  ...(mode === "offline" && {
    server: {
      host: true,
      port: 4000,
      strictPort: true,
      // The local database calls /api/scheduled-notifications from Docker,
      // where this laptop is host.docker.internal (offline/setup.sql).
      allowedHosts: ["host.docker.internal"],
      proxy: {
        "/supabase": {
          target: loadEnv(mode, process.cwd(), "")["SUPABASE_URL"] ?? "http://127.0.0.1:54321",
          changeOrigin: true,
          ws: true,
          rewrite: (path: string) => path.replace(/^\/supabase/, ""),
        },
      },
    },
  }),
  resolve: {
    tsconfigPaths: true,
  },
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          output: {
            inlineDynamicImports: true,
          },
        },
      },
    },
  },
  plugins: [
    tanstackStart({
      server: { entry: "server" },
    }),
    nitro({ preset: "vercel" }),
    react(),
    tailwindcss(),
    mode === "offline" && {
      // Nitro's dev server answers every path before Vite does, except paths
      // another middleware is mounted on. Mounting these pass-throughs lets
      // /supabase reach the proxy above, and /src reach Vite for phones: over
      // the hotspot's plain http address, browsers don't mark module requests
      // as scripts, so Nitro would answer the logo's JSON import with a 404 page.
      name: "offline-pass-through",
      configureServer(server: ViteDevServer) {
        for (const path of ["/supabase", "/src"]) {
          server.middlewares.use(path, (_req, _res, next) => next());
        }
      },
    },
  ],
}));
