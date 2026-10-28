import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // In dev the API server (npm run dev:api) runs separately; Vite forwards /api to it.
  // changeOrigin: false keeps the browser's Host header, so the server's same-origin
  // check matches the page's origin.
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://localhost:${process.env.API_PORT ?? 8080}`, changeOrigin: false } },
  },
})
