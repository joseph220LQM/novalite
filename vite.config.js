// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react({ jsxRuntime: command === "serve" ? "automatic" : "classic" })],
  define: {
    "process.env.NODE_ENV": JSON.stringify(command === "serve" ? "development" : "production"),
  },
  build: {
    lib: {
      entry: "src/index.js",
      name: "MozartAgendaWidget",
      fileName: (format) => (format === "umd" ? "agenda-widget.umd.js" : `agenda-widget.${format}.js`),
      formats: ["es", "umd"],
    },
    // 👇 externalizamos react y react-dom para cargarlos vía unpkg en el demo
    rollupOptions: {
      external: ["react", "react-dom"],
      output: {
        globals: { react: "React", "react-dom": "ReactDOM" },
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "widget.css" : (asset.name || "[name][extname]"),
      },
    },
    cssCodeSplit: true,
    sourcemap: true,
    emptyOutDir: true,
  },
}));



