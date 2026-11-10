import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true 로 개발 서버를 네트워크(0.0.0.0)에 노출해, 같은 Wi-Fi의 폰에서
    // http://<컴퓨터IP>:5173 으로 바로 접속할 수 있음 (--host 플래그 없이도).
    host: true,
    port: 5173,
    // allowedHosts: true 로 외부 도메인 접속을 허용 (cloudflared/ngrok 같은 터널의
    // https://xxx.trycloudflare.com 주소로 폰에서 열 때 Vite가 막지 않도록).
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  }
});
