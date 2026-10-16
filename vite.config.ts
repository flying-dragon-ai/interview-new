import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { localApiPlugin } from './server/local-api';
import { writeFileSync } from 'fs';

// 插件：在构建后创建 .nojekyll 文件
const nojekyllPlugin = () => {
  return {
    name: 'nojekyll',
    closeBundle() {
      try {
        writeFileSync(path.resolve(__dirname, 'dist/.nojekyll'), '');
      } catch (error) {
        // 忽略错误，文件可能已经存在
      }
    },
  };
};

// D1 修复：不再把 DEEPSEEK_API_KEY 注入前端 bundle。
// 所有 LLM 调用经 /api/llm 服务端代理，key 仅存服务端环境变量（C9）。
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.VITE_BASE_PATH || '/';

  return {
    base,
    server: {
      port: 3000,
      host: '0.0.0.0',
      fs: {
        strict: false,
      },
    },
    plugins: [react(), localApiPlugin(mode), nojekyllPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          app: path.resolve(__dirname, 'app.html'),
        },
        output: {
          manualChunks: undefined,
        },
      },
    },
  };
});
