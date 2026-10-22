import path from 'path';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
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

// 修复：视觉 worker 加载 MediaPipe wasm 报
// "Failed to load url /vision/wasm/vision_wasm_module_internal.js ... This file is in /public"
//
// 链路：visionWorker.ts 是 module worker → Chrome 里 importScripts 直接抛 TypeError
// （"Module scripts don't support importScripts()"）→ MediaPipe 回退到动态 import()
// 加载 ESM 版胶水（FilesetResolver.forVisionTasks(dir, useModule=true) 选中的
// vision_wasm_module_internal.js，位于 /public，构建时原样拷贝）。
// Vite dev 会给无法静态分析的动态 import 自动拼接 `?import` 标记，随后又拒绝 transform
// /public 下的文件（ERR_LOAD_PUBLIC_URL → 500），wasm 胶水于是加载失败。
// 这里在 dev server 上剥掉该标记，让请求落到 public 静态服务按原样返回（与生产一致）。
const stripViteImportQueryForVisionWasm = (): PluginOption => ({
  name: 'vision-wasm-public-dev',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? '';
      if (!/(^|\/)vision\/wasm\//.test(url)) return next();
      const queryIndex = url.indexOf('?');
      if (queryIndex === -1) return next();
      const pathname = url.slice(0, queryIndex);
      const params = url
        .slice(queryIndex + 1)
        .split('&')
        .filter((param) => param !== 'import' && !param.startsWith('import='));
      req.url = params.length > 0 ? `${pathname}?${params.join('&')}` : pathname;
      next();
    });
  },
});

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
    plugins: [react(), localApiPlugin(mode), nojekyllPlugin(), stripViteImportQueryForVisionWasm()],
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
