# Vercel 部署

当前 Vercel 项目 interview-second 已连接 GitHub 仓库 llingqi77-tech/interview-new。正式域名为 https://www.groupinterview.online ，应用入口为 /app.html。

## 自动触发机制

- 合并或推送到 main，Vercel Git 集成自动执行生产构建，成功后更新正式域名。
- 其他分支的推送自动生成预览部署，供 PR 验证。
- vercel.json 显式启用 git.deploymentEnabled；构建执行 pnpm run build，发布目录为 dist。
- 无需另外添加 Deploy Hook。独立 Deploy Hook 用于 CMS 等外部事件；再从同一次代码推送调用它会重复构建。
- 如需手动重建，在 Vercel 的 Deployments 中选择对应部署并执行 Redeploy。

GitHub Actions 中的 deploy.yml 负责 GitHub Pages；Vercel 使用自身的 Git 集成。两者都由 main 推送触发，各自发布到对应平台。

## 服务端配置

在 Vercel 项目 Settings → Environment Variables 中配置：

| 名称 | 用途 |
|---|---|
| DEEPSEEK_API_KEY | 题目、讨论和报告生成 |
| STEPFUN_API_KEY | 语音能力；缺失时降级 |
| DATABASE_URL | 会话与报告持久化；缺失时使用本地模式 |

为 Production 和需要验证的 Preview 环境分别配置。密钥不写入源码、不放进 VITE_ 前缀变量，也不提供给 Pages 构建。修改后重新部署对应环境。

## 免费套餐限制

api/ 下可部署函数保持不超过 12 个。四个会话接口共用 api/sessions.ts；下划线目录中的处理模块不单独部署。构建前自动运行 scripts/check-functions.mjs，超限直接失败。

本地检查运行 npm run verify。验证 PR 时同时检查 Vercel 的部署状态和原有 API 地址，避免仅凭构建成功判断服务可用。

## 故障定位

- 开始按钮 404：检查地址是否为 /app.html，Pages 应跳转到正式应用。
- 函数数量超限：合并入口后重新构建，保留现有路径的 rewrite。
- FUNCTION_INVOCATION_FAILED：查看 Runtime Logs；tsconfig.json 的 rewriteRelativeImportExtensions 确保 .ts 导入在部署产物中改写为 .js。
- 推送后未构建：检查 Vercel 项目的 Git 连接、生产分支 main、git.deploymentEnabled 和 Ignored Build Step，不要用重复的 Hook 掩盖连接问题。
