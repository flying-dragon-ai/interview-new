import { writeFileSync } from 'node:fs';

const appUrl = new URL(process.env.PAGES_APP_URL ?? '');
if (appUrl.protocol !== 'https:') throw new Error('PAGES_APP_URL must use HTTPS');
const target = appUrl.href;
const htmlTarget = target.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
// Pages cannot run the backend. Both entry points open the full Vercel app.
// Vercel builds keep index.html as the actual practice application.
const redirect = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>进入 AI 面试练习</title>
  <meta http-equiv="refresh" content="0; url=${htmlTarget}">
</head>
<body>
  <p><a href="${htmlTarget}">进入 AI 面试练习</a></p>
  <script>
    const target = new URL(${JSON.stringify(target)});
    target.search = window.location.search;
    target.hash = window.location.hash;
    window.location.replace(target.href);
  </script>
</body>
</html>
`;
for (const entry of ['index.html', 'app.html']) {
  writeFileSync(`dist/${entry}`, redirect);
}
console.log(`Pages application entry points to ${target}`);
