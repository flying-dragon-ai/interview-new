#!/usr/bin/env node
/**
 * D1/D2 源码回归：扫描仓库源码，确保无硬编码密钥/数据库凭据。
 * 覆盖：api/ services/ src/ components/ engine/ data/ *.ts *.tsx *.json vite.config.ts
 * 用法：node scripts/check-secrets.mjs（npm run check:secrets）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-ssr', 'tododocs', 'screenshots', 'draft_82603e29_folder', '.vercel']);
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.html', '.sql', '.sh', '.md']);

const PATTERNS = [
  { name: 'DeepSeek/OpenAI 风格 key', re: /sk-[A-Za-z0-9]{20,}/, allow: ['.md'] },
  { name: '阿里云 RDS 主机', re: new RegExp('[a-z0-9-]+' + '\\.pg\\.rds\\.aliyuncs\\.com'), allow: ['.md'] },
  { name: '已泄露账号', re: new RegExp('dong' + 'luyao'), allow: ['.md'] },
  { name: '已泄露密码', re: new RegExp('dong' + 'luyao' + '123456'), allow: ['.md'] },
  { name: 'vite define 注入 key', re: /define\s*:\s*\{[^}]*API_KEY/, allow: [] },
  { name: 'Bearer 硬编码', re: /Bearer\s+sk-/, allow: [] },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (SCAN_EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

// .env.example 允许出现变量名占位（值为空），单独放行
const ALLOWED_FILES = new Set(['.env.example', 'package.json', 'package-lock.json', 'pnpm-lock.yaml']);

const files = walk(ROOT);
let findings = 0;
for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (ALLOWED_FILES.has(rel)) continue;
  const content = readFileSync(file, 'utf8');
  for (const { name, re, allow } of PATTERNS) {
    if (allow.includes(extname(file))) continue;
    const match = content.match(re);
    if (match) {
      findings += 1;
      console.error(`❌ [D1/D2] ${rel} 命中 ${name}: ${match[0].slice(0, 50)}`);
    }
  }
}

if (findings > 0) {
  console.error(`\n❌ 源码检查失败：${findings} 处硬编码密钥/凭据`);
  process.exit(1);
}
console.log(`✅ 源码检查通过：${files.length} 个文件中无硬编码密钥/数据库凭据`);
