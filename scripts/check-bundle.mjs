#!/usr/bin/env node
/**
 * TC-00: 构建产物密钥检查（PRD D1/D2 回归 / 附录 H）
 * 扫描 dist/ 下的 js/css/html，确保无任何 API key / 数据库凭据。
 * 用法：node scripts/check-bundle.mjs（npm run check:bundle）
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST = 'dist';

/** 高危凭据模式（含已泄露旧凭据，永久回归） */
const PATTERNS = [
  { name: 'DeepSeek/OpenAI 风格 key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: '阿里云 RDS 主机', re: /pgm-[a-z0-9]+\.pg\.rds\.aliyuncs\.com/ },
  { name: 'RDS 通用主机', re: /[a-z0-9-]+\.pg\.rds\.aliyuncs\.com/ },
  { name: '已泄露账号', re: new RegExp('dong' + 'luyao', 'i') },
  { name: '已泄露密码', re: new RegExp('dong' + 'luyao' + '123456') },
  { name: 'StepFun key 形态', re: /stepfun[_-]?api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{16,}/i },
  { name: '环境变量注入的 key 值', re: /process\.env\.[A-Z_]*API_KEY\s*\)?\s*[:=]\s*["'][^"']{8,}/ },
];

const SCAN_EXTS = new Set(['.js', '.mjs', '.css', '.html', '.map', '.json']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (SCAN_EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error('❌ dist/ 不存在，请先运行 npm run build');
  process.exit(1);
}

const files = walk(DIST);
let findings = 0;
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  for (const { name, re } of PATTERNS) {
    const match = content.match(re);
    if (match) {
      findings += 1;
      console.error(`❌ [TC-00] ${file} 命中 ${name}: ${match[0].slice(0, 40)}...`);
    }
  }
}

if (findings > 0) {
  console.error(`\n❌ TC-00 失败：bundle 中发现 ${findings} 处密钥/凭据（D1/D2 违反）`);
  process.exit(1);
}
console.log(`✅ TC-00 通过：${files.length} 个构建产物文件中无任何 API key / 数据库凭据`);
