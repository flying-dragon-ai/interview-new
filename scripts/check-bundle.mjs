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

// ============================================================
// 体积门禁（M7 Phase 0 新增；与密钥扫描共用本脚本，一次 build 两项检查）
//
// 背景：M7 引入 three / @react-three/fiber / @react-three/drei / @pixiv/three-vrm。
// 这些依赖只允许经 React.lazy 进入 ImmersiveRoom 的懒加载 chunk，绝不许进入
// app.html 的静态主图（否则首屏必然超预算）。因此采用「总量 + 单 chunk」双闸：
//
//  - CHUNK_MAX_BYTES：任一 chunk 的硬上限。现主静态包（index-*.js，wagmi/para 栈）
//    约 2.4MB，定为 3.2MB——若 three 被误静态引入主图，主包将超 4MB 并在此处失败；
//    three 懒加载包自身约 1.3MB，远在闸内。
//  - ENTRY_MAX_BYTES：app.html 直连入口 stub（app-*.js）上限 512KB（当前 ~305KB），
//    防止入口 stub 膨胀。
//  - TOTAL_MAX_BYTES：dist 全部 JS 总量上限 14MB（当前 ~9MB + three/drei/vrm ~2MB 预留）。
//
// 调整规则：放宽任何阈值必须在注释里写明原因与当时的实测基线。
// ============================================================
const CHUNK_MAX_BYTES = 3.2 * 1024 * 1024;
const ENTRY_MAX_BYTES = 512 * 1024;
const TOTAL_MAX_BYTES = 14 * 1024 * 1024;

const jsFiles = files.filter((f) => extname(f) === '.js');
let sizeFailures = 0;
let totalJs = 0;
for (const file of jsFiles) {
  const bytes = statSync(file).size;
  totalJs += bytes;
  const kb = (bytes / 1024).toFixed(0);
  if (bytes > CHUNK_MAX_BYTES) {
    sizeFailures += 1;
    console.error(`❌ [体积] ${file} ${kb}KB 超过单 chunk 上限 ${(CHUNK_MAX_BYTES / 1024 / 1024).toFixed(1)}MB（three/R3F/VRM 必须 React.lazy 懒加载，不得进入主静态图）`);
  }
  if (/assets[\\/]app-[^/\\]*\.js$/.test(file) && bytes > ENTRY_MAX_BYTES) {
    sizeFailures += 1;
    console.error(`❌ [体积] 入口 stub ${file} ${kb}KB 超过 ${ENTRY_MAX_BYTES / 1024}KB`);
  }
}
if (totalJs > TOTAL_MAX_BYTES) {
  sizeFailures += 1;
  console.error(`❌ [体积] dist JS 总量 ${(totalJs / 1024 / 1024).toFixed(1)}MB 超过 ${(TOTAL_MAX_BYTES / 1024 / 1024).toFixed(0)}MB`);
}
if (sizeFailures > 0) {
  console.error(`\n❌ 体积门禁失败：${sizeFailures} 处超限（如需放宽请更新本脚本注释说明原因）`);
  process.exit(1);
}
console.log(`✅ 体积门禁通过：${jsFiles.length} 个 JS chunk，总量 ${(totalJs / 1024 / 1024).toFixed(1)}MB / 上限 ${(TOTAL_MAX_BYTES / 1024 / 1024).toFixed(0)}MB`);
