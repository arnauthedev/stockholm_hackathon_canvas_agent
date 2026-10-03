import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const root = path.resolve(import.meta.dirname, "..");

export default defineConfig(({ mode }) => {
  // Only non-secret values are read here; nothing from .env is exposed to the client.
  const env = loadEnv(mode, root, "");
  const runner = `http://127.0.0.1:${env.PORT || 18787}`;
  return {
    envDir: root,
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        // No service worker in dev: the quick-tunnel origin changes on every restart and a stale
        // dev SW serves a cached shell whose module scripts no longer exist → blank page.
        devOptions: { enabled: false },
        includeAssets: ["icons/*.png", "sounds/*"],
        manifest: {
          name: "Canvas Agent",
          short_name: "Canvas",
          description: "A canvas your voice agent builds.",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          background_color: "#f7f9fe",
          theme_color: "#f7f9fe",
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          navigateFallback: "/index.html",
          importScripts: ["sw-push.js"], // push + notification clicks in the production SW
          navigateFallbackDenylist: [/^\/api\//, /^\/bus/, /^\/voice/, /^\/files\//],
          runtimeCaching: [
            // Last known state for offline shell
            { urlPattern: /\/api\/state/, handler: "NetworkFirst", options: { cacheName: "state", networkTimeoutSeconds: 3 } },
          ],
        },
      }),
    ],
    server: {
      host: "127.0.0.1", // tunnel connects locally; binding loopback makes port clashes fail loudly
      port: Number(env.APP_PORT || 15180),
      strictPort: true,
      allowedHosts: true, // reached through the tunnel host
      proxy: {
        "/api": { target: runner, changeOrigin: false },
        "/bus": { target: runner, ws: true },
        "/voice": { target: runner, ws: true }, // Gemini voice relay (audio both ways)
        "/files": { target: runner },
      },
    },
  };
});
