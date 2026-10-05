import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // 브라우저는 같은 origin(/api)으로 요청 → Vite가 BFF로 프록시. API 키는 BFF에만 존재한다.
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
})
