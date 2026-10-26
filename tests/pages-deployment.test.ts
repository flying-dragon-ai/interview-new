import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';

const script = resolve('scripts/prepare-pages.mjs');
const homepage = readFileSync('index.html', 'utf8');
const target = 'https://interview-practice-77.vercel.app/';

test('root mounts the practice app and legacy HTML preserves query and fragment', () => {
  assert.match(homepage, /id="root"/);
  assert.match(homepage, /src="\/app-entry\.tsx"/);
  assert.ok(!homepage.includes('./app.html'));
  const legacy = readFileSync('app.html', 'utf8');
  let redirected = '';
  runInNewContext(legacy.match(/<script>([\s\S]*?)<\/script>/)![1], {
    URL,
    window: { location: { href: target + 'app.html?demo=1#setup', search: '?demo=1', hash: '#setup', replace: (url: string) => { redirected = url; } } },
  });
  assert.equal(redirected, target + '?demo=1#setup');
});

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'interview-pages-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/index.html'), homepage);
  return root;
}

test('Pages root and old app.html links redirect to the full practice homepage', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [script], {
    cwd: root, env: { ...process.env, PAGES_APP_URL: target }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const index = readFileSync(join(root, 'dist/index.html'), 'utf8');
  assert.ok(index.includes(`href="${target}"`));
  assert.ok(!/href=["']\.?\/app\.html["']/.test(index));
  const app = readFileSync(join(root, 'dist/app.html'), 'utf8');
  assert.equal(index, app);
  assert.match(app, /http-equiv="refresh"/);
  assert.ok(!app.includes('app-entry.tsx'));
  let redirected = '';
  runInNewContext(app.match(/<script>([\s\S]*?)<\/script>/)![1], {
    URL,
    window: { location: { search: '?demo=1', hash: '#setup', replace: (url: string) => { redirected = url; } } },
  });
  assert.equal(redirected, target + '?demo=1#setup');
});

test('Pages preparation rejects insecure targets without altering the homepage', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [script], {
    cwd: root, env: { ...process.env, PAGES_APP_URL: 'http://example.com/app.html' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must use HTTPS/);
  assert.equal(readFileSync(join(root, 'dist/index.html'), 'utf8'), homepage);
});
