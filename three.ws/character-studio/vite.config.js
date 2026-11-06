import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  // Hosted at https://three.ws/avatar-studio/ in production — all emitted asset
  // URLs need this prefix. The iframe SDK (avatar-sdk/src/creator.js) loads this
  // base URL directly.
  base: '/avatar-studio/',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: './build',
  },
  resolve: {
    dedupe: ['three'],
    alias: {
      buffer: 'buffer/'
    }
  }
})
