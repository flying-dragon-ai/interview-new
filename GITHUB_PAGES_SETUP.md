# GitHub Pages 快速配置指南

## ⚠️ 错误：`Creating Pages deployment failed` 或 `HttpError: Not Found`

这个错误表示 **GitHub Pages 还没有在你的仓库中启用**。

## 🔧 解决步骤（必须按顺序完成）

### 步骤 1：启用 GitHub Pages

1. **打开仓库设置页面**
   ```
   https://github.com/llingqi77-tech/interview-second/settings/pages
   ```
   或手动操作：
   - 进入仓库：`https://github.com/llingqi77-tech/interview-second`
   - 点击顶部的 **Settings** 标签
   - 在左侧菜单找到 **Pages**

2. **配置部署源**
   - 在 "Source"（源）下拉菜单中
   - **选择 "GitHub Actions"** ⚠️ 重要：不要选择 "Deploy from a branch"
   - 点击 **Save**（保存）

3. **验证启用状态**
   - 保存后，页面应该显示 "Your site is live at..." 或类似信息
   - 如果显示 "GitHub Pages is currently disabled"，说明还没有正确启用

### 步骤 2：检查仓库权限

确保你的仓库设置允许 GitHub Actions：

1. 在 Settings → Actions → General
2. 确保 "Workflow permissions" 设置为：
   - ✅ **Read and write permissions**
   - ✅ **Allow GitHub Actions to create and approve pull requests**

### 步骤 3：添加环境变量

1. **进入 Secrets 设置**
   - Settings → Secrets and variables → Actions
   - 点击 **New repository secret**

2. **添加 DEEPSEEK_API_KEY**
   - Name: `DEEPSEEK_API_KEY`（必须完全匹配，区分大小写）
   - Secret: `<REDACTED_REVOKE_AND_REPLACE>`
   - 点击 **Add secret**

### 步骤 4：重新运行 Workflow

1. **进入 Actions 标签**
   - 点击仓库顶部的 **Actions** 标签

2. **运行 Workflow**
   - 选择 "Build and Deploy to GitHub Pages"
   - 点击 **Run workflow** 按钮
   - 选择 `main` 分支
   - 点击 **Run workflow**

3. **等待部署完成**
   - 查看 workflow 运行日志
   - 确保所有步骤都显示绿色 ✓

## ✅ 配置检查清单

在重新运行 workflow 之前，请确认：

- [ ] **Pages 已启用**：Settings → Pages 显示 "Your site is live at..."
- [ ] **部署源正确**：选择了 "GitHub Actions"（不是 "Deploy from a branch"）
- [ ] **Secrets 已添加**：`DEEPSEEK_API_KEY` 存在于 Secrets 中
- [ ] **Workflow 权限**：Actions → General → Workflow permissions 设置为 "Read and write"
- [ ] **代码已推送**：最新的 workflow 文件已推送到 `main` 分支

## 🌐 访问你的网站

部署成功后，你的网站地址将是：

```
https://llingqi77-tech.github.io/interview-second/
```

**注意：**
- URL 格式：`https://<username>.github.io/<repository-name>/`
- 末尾的斜杠 `/` 很重要
- 首次部署可能需要几分钟才能访问

## 🔍 故障排除

### 问题 1：仍然显示 "Not Found" 错误

**可能原因：**
- Pages 还没有完全启用
- 选择了错误的部署源

**解决方法：**
1. 再次检查 Settings → Pages
2. 确保选择了 "GitHub Actions"
3. 等待 1-2 分钟让 GitHub 处理
4. 重新运行 workflow

### 问题 2：Workflow 运行但网站无法访问

**可能原因：**
- Base path 配置问题
- 文件路径错误

**解决方法：**
1. 检查 workflow 日志中的 base path
2. 确保访问的 URL 包含正确的仓库名路径
3. 尝试访问：`https://llingqi77-tech.github.io/interview-second/`

### 问题 3：环境变量错误

**错误信息：** `DEEPSEEK_API_KEY 环境变量未设置`

**解决方法：**
1. 检查 Secret 名称是否完全匹配：`DEEPSEEK_API_KEY`
2. 确保 Secret 已添加到仓库（不是组织级别）
3. 重新运行 workflow

## 📸 截图参考

### Pages 设置页面应该显示：

```
Source: GitHub Actions
  ↓
[GitHub Actions] ← 选择这个
[Deploy from a branch] ← 不要选这个
```

### 启用后应该显示：

```
✅ Your site is live at https://llingqi77-tech.github.io/interview-second/
```

## 🆘 仍然无法解决？

如果按照以上步骤操作后仍然失败：

1. **检查仓库类型**
   - 确保仓库是 **Public**（公开）或你有 GitHub Pro/Team 账户
   - 免费账户的私有仓库不支持 GitHub Pages

2. **查看详细日志**
   - 在 Actions 中点击失败的 workflow
   - 查看每个步骤的详细日志
   - 寻找具体的错误信息

3. **尝试手动部署**
   - 如果 GitHub Actions 一直失败
   - 可以尝试使用 "Deploy from a branch" 方式
   - 但需要手动构建和提交 `dist` 目录

## 📚 相关文档

- [GitHub Pages 官方文档](https://docs.github.com/en/pages)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [项目部署指南](./DEPLOY_GITHUB_PAGES.md)
