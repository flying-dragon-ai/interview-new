# GitHub Pages 部署

GitHub Pages 只托管静态文件。本项目的介绍页发布在 https://llingqi77-tech.github.io/interview-new/ ，完整应用和服务端 API 运行在 https://www.groupinterview.online/app.html 。

## 发布流程

1. 仓库 Settings → Pages → Source 选择 GitHub Actions。
2. 推送或合并到 main，触发唯一的 Build and Deploy to GitHub Pages 工作流；也可在 Actions 手动运行。
3. 工作流使用 Node.js 24、pnpm 10.28.0 和冻结的锁文件，按 /interview-new/ 基路径构建。
4. scripts/prepare-pages.mjs 将介绍页的三个开始按钮指向正式应用，并生成 app.html 跳转页，兼容旧收藏链接。
5. 只上传 dist/；保留 .nojekyll，避免对 Vite 产物再次执行 Jekyll。

Pages 构建不需要 API 密钥。DEEPSEEK_API_KEY、STEPFUN_API_KEY 和 DATABASE_URL 只配置在 Vercel 的服务端环境变量中。

## 404 的原因与修复

项目站点的根地址包含仓库名。写成 /app.html 会访问 github.io 域名根目录；源码使用 ./app.html 以保留当前目录，Pages 发布时将按钮直接改为正式应用地址。

Pages 不执行 api/*.ts；直接在 Pages 运行应用并请求同源 /api 会失败。因此 Pages 的 app.html 也跳转到正式域名，应用与 API 保持同源，不依赖额外的跨域配置。

保留 .github/workflows/deploy.yml，移除会覆盖同一 Pages 站点的 Jekyll 示例工作流。

## 本地验证

先运行 npm run build。检查 Pages 产物时设置 PAGES_APP_URL=https://www.groupinterview.online/app.html，再运行 node scripts/prepare-pages.mjs。此步骤只用于 Pages 产物，Vercel 构建不运行它。
