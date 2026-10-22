import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const base = process.env.PAGES_BASE || "/squares-duel/";
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
  throw new Error("PAGES_BASE must be an absolute, trailing-slash path such as /squares-duel/.");
}

const api = new URL(process.env.SQUARES_API_ORIGIN || "https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site");
if (!["http:", "https:"].includes(api.protocol) || api.pathname !== "/" || api.search || api.hash || api.username || api.password) {
  throw new Error("SQUARES_API_ORIGIN must contain only an HTTP(S) origin.");
}

export default defineConfig({
  root: fileURLToPath(new URL("./pages-client", import.meta.url)),
  base,
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react()],
  resolve: { alias: { "@": root } },
  define: {
    __SQUARES_PAGES_API_ORIGIN__: JSON.stringify(api.origin),
    __SQUARES_PUBLIC_BASE__: JSON.stringify(base),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-pages", import.meta.url)),
    emptyOutDir: true,
  },
});
