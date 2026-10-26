import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const script = resolve('scripts/prepare-pages.mjs');
const landing = readFileSync('index.html', 'utf8');
const target = 'https://www.groupinterview.online/app.html';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'interview-pages-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/index.html'), landing);
  return root;
}

test('Pages start buttons and old app.html links reach the same full application', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [script], {
    cwd: root, env: { ...process.env, PAGES_APP_URL: target }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const index = readFileSync(join(root, 'dist/index.html'), 'utf8');
  assert.equal(index.split(`href="${target}"`).length - 1, 3);
  assert.ok(!/href=["']\.?\/app\.html["']/.test(index));
  const app = readFileSync(join(root, 'dist/app.html'), 'utf8');
  assert.match(app, /http-equiv="refresh"/);
  assert.ok(!app.includes('app-entry.tsx'));
  let redirected = '';
  runInNewContext(app.match(/<script>([\s\S]*?)<\/script>/)![1], {
    URL,
    window: { location: { search: '?demo=1', hash: '#setup', replace: (url: string) => { redirected = url; } } },
  });
  assert.equal(redirected, target + '?demo=1#setup');
});

test('Pages preparation rejects insecure targets without altering the landing page', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [script], {
    cwd: root, env: { ...process.env, PAGES_APP_URL: 'http://example.com/app.html' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use HTTPS/);
  assert.equal(readFileSync(join(root, 'dist/index.html'), 'utf8'), landing);
});
