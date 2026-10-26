import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('deployed session dispatcher imports emitted JavaScript, not TypeScript sources', () => {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  assert.equal(config.error, undefined);
  const { options, errors } = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, '.');
  assert.equal(errors.length, 0);
  const result = ts.transpileModule(readFileSync('api/sessions.ts', 'utf8'), {
    fileName: 'api/sessions.ts',
    compilerOptions: { ...options, noEmit: false },
  });
  assert.match(result.outputText, /from ['"]\.\/_sessions\/\[id\]\/index\.js['"]/);
  assert.match(result.outputText, /from ['"]\.\/_sessions\/\[id\]\/analyze\.js['"]/);
  assert.doesNotMatch(result.outputText, /from ['"][^'"]+\.ts['"]/);
});
