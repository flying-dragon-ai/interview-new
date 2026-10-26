#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Vercel excludes files/directories beginning with "_" from API discovery.
// This Vite project deploys each remaining .ts/.js API file as one function.
function entrypoints(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (/^[_.]/.test(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entrypoints(path);
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [path] : [];
  });
}

const functions = entrypoints('api');
const limit = 12;
console.log(`Vercel functions: ${functions.length}/${limit} (Hobby)`);
if (functions.length > limit) {
  console.error('Consolidate API entrypoints before deploying:\n' + functions.join('\n'));
  process.exitCode = 1;
}
