import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectDir = resolve(contractsDir, '..');
const sourceDirs = ['src', 'test'];
const sources = {};

function collect(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) collect(path);
    else if (path.endsWith('.sol')) {
      const key = relative(contractsDir, path).replaceAll('\\', '/');
      sources[key] = { content: readFileSync(path, 'utf8') };
    }
  }
}

for (const dir of sourceDirs) collect(join(contractsDir, dir));

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), {
  import(sourcePath) {
    const path = sourcePath.startsWith('@openzeppelin/contracts/')
      ? resolve(projectDir, 'node_modules', sourcePath)
      : resolve(contractsDir, sourcePath);
    try { return { contents: readFileSync(path, 'utf8') }; }
    catch { return { error: `Import not found: ${sourcePath}` }; }
  },
}));

const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
for (const entry of output.errors ?? []) {
  const stream = entry.severity === 'error' ? process.stderr : process.stdout;
  stream.write(`${entry.formattedMessage}\n`);
}
if (errors.length) process.exit(1);

const contract = output.contracts?.['src/InterviewCredential.sol']?.InterviewCredential;
if (!contract?.evm?.bytecode?.object) {
  process.stderr.write('InterviewCredential bytecode was not produced.\n');
  process.exit(1);
}
process.stdout.write(`Compiled InterviewCredential with solc ${solc.version()}; bytecode ${contract.evm.bytecode.object.length / 2} bytes.\n`);
