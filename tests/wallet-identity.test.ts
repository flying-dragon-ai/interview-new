import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveIdentity } from '../src/wallet/identity.ts';
import { isEvmAddress, normalizeAddress, shortAddress } from '../src/wallet/config.ts';
import { normalizeWalletAddress, WALLET_ADDRESS_RE } from '../api/_lib/wallet.ts';
import { setPoolForTesting } from '../api/_lib/db.ts';
import sessionHandler from '../api/session.ts';

/**
 * Para 钱包身份（Q-N1）测试
 * deriveIdentity 纯函数 + /api/session wallet_address 透传 + UI 接线静态断言
 */

const ADDR_A = '0x1111111111111111111111111111111111111111';
const ADDR_B = '0xABCDabcdABCDabcdABCDabcdABCDabcdABCDabcd';
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ---------- 纯函数：地址工具 ----------

test('地址工具：isEvmAddress / normalizeAddress / shortAddress', () => {
  assert.equal(isEvmAddress(ADDR_A), true);
  assert.equal(isEvmAddress(ADDR_B), true);
  assert.equal(isEvmAddress('0x1234'), false);
  assert.equal(isEvmAddress('not-an-address'), false);
  assert.equal(isEvmAddress(null), false);
  assert.equal(normalizeAddress(ADDR_B), ADDR_B.toLowerCase());
  assert.equal(shortAddress(ADDR_A), '0x1111…1111');
  assert.equal(shortAddress('0x1234'), '0x1234');
});

test('前后端地址正则一致（src/wallet/config.ts ↔ api/_lib/wallet.ts）', () => {
  const frontend = read('src/wallet/config.ts');
  assert.ok(frontend.includes('^0x[0-9a-fA-F]{40}$'), '前端正则与后端不一致');
  assert.equal(WALLET_ADDRESS_RE.source, '^0x[0-9a-fA-F]{40}$');
});

// ---------- 纯函数：deriveIdentity ----------

test('deriveIdentity：嵌入式 EVM 钱包优先且归一化为小写', () => {
  const id = deriveIdentity({
    isConnected: true,
    embedded: {
      isConnected: true,
      wallets: [
        { type: 'SOLANA', address: 'sol-addr' },
        { type: 'EVM', address: ADDR_B },
      ],
    },
    external: { evm: { address: ADDR_A } },
  });
  assert.equal(id.address, ADDR_B.toLowerCase());
  assert.equal(id.source, 'embedded');
});

test('deriveIdentity：wallets 为 record 形态时同样可取址', () => {
  const id = deriveIdentity({
    embedded: { isConnected: true, wallets: { w1: { type: 'EVM', address: ADDR_A } } },
  });
  assert.equal(id.address, ADDR_A);
  assert.equal(id.source, 'embedded');
});

test('deriveIdentity：嵌入式无 EVM 地址时兜底任意带地址钱包，再走外部钱包', () => {
  const onlySol = deriveIdentity({
    embedded: { isConnected: true, wallets: [{ type: 'COSMOS', address: ADDR_A }] },
  });
  assert.equal(onlySol.address, ADDR_A);
  assert.equal(onlySol.source, 'embedded');

  const ext = deriveIdentity({
    embedded: { isConnected: true, wallets: [] },
    external: { evm: { address: ADDR_B } },
  });
  assert.equal(ext.address, ADDR_B.toLowerCase());
  assert.equal(ext.source, 'external');
});

test('deriveIdentity：嵌入式未连接时不取嵌入地址；全部为空 → 匿名', () => {
  const notReady = deriveIdentity({
    embedded: { isConnected: false, wallets: [{ type: 'EVM', address: ADDR_A }] },
  });
  assert.equal(notReady.address, null);

  const anon = deriveIdentity({ isConnected: false });
  assert.deepEqual(anon, { address: null, source: null });
  assert.deepEqual(deriveIdentity(null), { address: null, source: null });
});

// ---------- /api/session：wallet_address 透传 ----------

function mockPool(responder?: (sql: string, params: unknown[]) => { rows: any[] }) {
  const recorded: { sql: string; params: unknown[] }[] = [];
  const pool: any = {
    query: async (sql: string, params: unknown[] = []) => {
      recorded.push({ sql, params });
      if (responder) return responder(sql, params);
      return { rows: [{ id: 7 }] };
    },
  };
  return { pool, recorded };
}

function mockReq(body: unknown, query: Record<string, string> = {}, method = 'POST') {
  return { method, body, query, headers: {}, socket: {} } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: '',
    writeHead() {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = JSON.stringify(data);
      return res;
    },
    write(c: string) {
      res.body += c;
      return true;
    },
    end() {},
    on() {},
  };
  return res;
}

const originalEnv = process.env.DATABASE_URL;

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/interview_db';
});

afterEach(() => {
  setPoolForTesting(null);
  if (originalEnv === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalEnv;
});

const validBody = {
  company: '字节跳动',
  job_title: '产品经理',
  topic: '设计一款面向银发群体的短视频产品',
  wallet_address: ADDR_B,
};

test('Q-N1: POST /api/session 携带钱包地址 → INSERT 写入 wallet_address（小写归一）', async () => {
  const { pool, recorded } = mockPool(() => ({ rows: [{ id: 7, wallet_address: ADDR_B.toLowerCase() }] }));
  setPoolForTesting(pool);
  const res = mockRes();
  await sessionHandler(mockReq(validBody), res);
  assert.equal(res.statusCode, 200);
  const insert = recorded.find((r) => /INSERT INTO sessions/i.test(r.sql));
  assert.ok(insert, '未执行 sessions 插入');
  assert.ok(/wallet_address/i.test(insert.sql), 'INSERT 未包含 wallet_address 列');
  assert.ok(insert.params.includes(ADDR_B.toLowerCase()), 'wallet_address 参数未小写归一');
});

test('Q-N1: POST 非法钱包地址 → 400 且不落库', async () => {
  const { pool, recorded } = mockPool();
  setPoolForTesting(pool);
  const res = mockRes();
  await sessionHandler(mockReq({ ...validBody, wallet_address: '0xnothex' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(recorded.filter((r) => /INSERT/i.test(r.sql)).length, 0, '非法地址不应触发 INSERT');
});

test('Q-N1: 匿名练习（无钱包地址）→ wallet_address 落 NULL', async () => {
  const { pool, recorded } = mockPool(() => ({ rows: [{ id: 8 }] }));
  setPoolForTesting(pool);
  const res = mockRes();
  const body = { ...validBody } as any;
  delete body.wallet_address;
  await sessionHandler(mockReq(body), res);
  assert.equal(res.statusCode, 200);
  const insert = recorded.find((r) => /INSERT INTO sessions/i.test(r.sql));
  assert.ok(insert && insert.params.includes(null), '匿名会话 wallet_address 应为 NULL');
});

test('Q-N1: wallet 列缺失（v0.7.1 未迁移）→ 自动回退无钱包列插入', async () => {
  // v0.8 链路：含 wallet_address 的插入（v08 / v071(true)）失败两次，第三次（无钱包列）成功
  const { pool, recorded } = mockPool((sql) => {
    if (/INSERT INTO sessions/i.test(sql) && /wallet_address/.test(sql)) {
      throw new Error('column "wallet_address" of relation "sessions" does not exist');
    }
    return { rows: [{ id: 9 }] };
  });
  setPoolForTesting(pool);
  const res = mockRes();
  await sessionHandler(mockReq(validBody), res);
  assert.equal(res.statusCode, 200);
  const inserts = recorded.filter((r) => /INSERT INTO sessions/i.test(r.sql));
  assert.equal(inserts.length, 3, '应先尝试含 wallet_address（v08/v071），再回退无钱包列');
  assert.ok(!/wallet_address/i.test(inserts[2].sql), '回退插入不应包含 wallet_address 列');
});

test('Q-N1: GET /api/session?wallet_address= 过滤历史（小写归一）', async () => {
  const { pool, recorded } = mockPool(() => ({ rows: [] }));
  setPoolForTesting(pool);
  const res = mockRes();
  await sessionHandler(mockReq(null, { wallet_address: ADDR_B }, 'GET'), res);
  assert.equal(res.statusCode, 200);
  const select = recorded.find((r) => /SELECT \* FROM sessions/i.test(r.sql));
  assert.ok(select && /WHERE wallet_address = \$1/i.test(select.sql), '列表未按钱包过滤');
  assert.deepEqual(select.params, [ADDR_B.toLowerCase()]);
});

test('Q-N1: GET 非法钱包地址 → 400', async () => {
  const { pool } = mockPool();
  setPoolForTesting(pool);
  const res = mockRes();
  await sessionHandler(mockReq(null, { wallet_address: 'bad' }, 'GET'), res);
  assert.equal(res.statusCode, 400);
});

// ---------- UI 接线静态断言 ----------

test('接线：app-entry 包裹 ParaWalletProvider', () => {
  const entry = read('app-entry.tsx');
  assert.ok(/ParaWalletProvider/.test(entry), 'app-entry 未引入 ParaWalletProvider');
  assert.ok(/<ParaWalletProvider>[\s\S]*<App \/>[\s\S]*<\/ParaWalletProvider>/.test(entry), 'App 未被 provider 包裹');
});

test('接线：App 使用钱包身份并渲染 WalletButton、createSession 传地址', () => {
  const app = read('App.tsx');
  assert.ok(/useWalletIdentity/.test(app), 'App 未使用 useWalletIdentity');
  assert.ok(/<WalletButton \/>/.test(app), 'App 未渲染 WalletButton');
  assert.ok(/walletAddress:\s*wallet\.address/.test(app), 'createSession 未透传钱包地址');
});

test('接线：src/api.ts 发送 wallet_address；迁移 SQL 与 .monskills 就位', () => {
  const api = read('src/api.ts');
  assert.ok(/wallet_address:\s*params\.walletAddress/.test(api), 'createSession 未发送 wallet_address');

  const sql = read('db/migration-v0.7.1-wallet.sql');
  assert.ok(/ALTER TABLE sessions ADD COLUMN IF NOT EXISTS wallet_address/i.test(sql), '迁移缺 wallet_address 列');

  const meta = read('.monskills');
  assert.ok(/built-with=monskills/.test(meta) && /chain=monad-testnet/.test(meta), '.monskills 元数据不正确');
});

test('接线：provider 懒加载与 Monad 默认链（para-monad-wiring）', () => {
  const outer = read('src/wallet/ParaWalletProvider.tsx');
  assert.ok(/lazy\(\(\) => import\('\.\/ParaWalletProviderInner'\)\)/.test(outer), 'Inner 未懒加载');
  assert.ok(/anonymousIdentity/.test(outer), '未配置时缺匿名降级');

  const inner = read('src/wallet/ParaWalletProviderInner.tsx');
  assert.ok(/chains:\s*\[monadTestnet,\s*monad\]/.test(inner), 'Monad Testnet 应为默认链（数组首位）');
  assert.ok(/testnet-rpc\.monad\.xyz/.test(inner) && /rpc\.monad\.xyz/.test(inner), '缺官方 RPC transport');
  assert.ok(!/defaultChain\s*=/.test(inner), 'v2/v3 无 defaultChain prop，不应作为属性传入');
  assert.ok(/@getpara\/react-sdk\/styles\.css/.test(inner), '缺 Para CSS 引入');
});
