import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  // 使用绝对路径，确保 SPA 子路由刷新时资源能正确加载
  // 生产环境由 FastAPI 提供静态文件服务，支持 /assets/ 路径
  // Electron 构建时需单独处理（使用 base: './' 或自定义协议）
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // 确保代理正确转发 multipart/form-data
        rewrite: (path) => path,
        // 工参更新操作（如应用到工参）对大文件处理可能超过120s
        timeout: 600000, // 10分钟超时，避免 Proxy Read Timeout
      },
      // 图层制作生成的文件（tab/mif/kml）下载，dev 模式由 FastAPI 静态服务提供
      '/layer-files': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
    // 生产优化配置
    minify: 'esbuild',
    esbuild: {
      drop: ['console', 'debugger']
    },
    rollupOptions: {
      output: {
        // 代码分割优化 - 由 Rollup 自动处理
        // 不设置 manualChunks 避免跨块 TDZ 错误
        // 文件名优化
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]'
      }
    },
    // chunk 大小警告阈值 (KB)
    chunkSizeWarningLimit: 1000,
    // CSS 代码分割
    cssCodeSplit: true,
    // sourcemap (生产环境关闭以减小体积)
    sourcemap: false
  },
  // 优化依赖预构建
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      'zustand',
      'axios',
      'leaflet'
    ]
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html']
    }
  }
})
