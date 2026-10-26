import { readFileSync, writeFileSync } from 'node:fs';

const appUrl = new URL(process.env.PAGES_APP_URL ?? '');
if (appUrl.protocol !== 'https:') throw new Error('PAGES_APP_URL must use HTTPS');
const target = appUrl.href;
const htmlTarget = target.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const index = readFileSync('dist/index.html', 'utf8');
const landing = index.replace(/href=(["'])\.\/app\.html\1/g, `href="${htmlTarget}"`);
if (landing === index) throw new Error('No application links found in dist/index.html');

// Only the Pages workflow runs this step. Vercel keeps its normal app.html.
writeFileSync('dist/index.html', landing);
writeFileSync('dist/app.html', `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>进入群面模拟器</title>
  <meta http-equiv="refresh" content="0; url=${htmlTarget}">
</head>
<body>
  <p><a href="${htmlTarget}">进入群面模拟器</a></p>
  <script>
    const target = new URL(${JSON.stringify(target)});
    target.search = window.location.search;
    target.hash = window.location.hash;
    window.location.replace(target.href);
  </script>
</body>
</html>
`);
console.log(`Pages application entry points to ${target}`);
