import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "landing/*"],
      manifest: {
        name: "Uçuş Planı — ajanına imzalı talimatını ver",
        short_name: "Uçuş Planı",
        description: "Kararı ajan verir, izni kontrat verir, emri KULE gönderir.",
        lang: "tr",
        theme_color: "#1d1a16",
        background_color: "#b9773f",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        // deployments/fuji.json asla önbellekten bayat gelmesin: imza ve zincir okuma bu dosyaya bağlı
        navigateFallbackDenylist: [/^\/deployments\//, /^\/rpc/],
        globPatterns: ["**/*.{js,css,html,svg,jpg,png,woff2}"],
        maximumFileSizeToCacheInBytes: 4_000_000,
      },
    }),
  ],
  server: { port: 5180 },
});
