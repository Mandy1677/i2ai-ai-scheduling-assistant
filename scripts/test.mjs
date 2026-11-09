// Runs compiled *.test.js files with Node's test runner inside Electron's
// Node runtime, so node:sqlite matches what the App uses. Works on Windows too.
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import electronPath from 'electron';

const files = globSync('dist/**/*.test.js');
if (files.length === 0) {
  console.error('No compiled test files found. Run the build first.');
  process.exit(1);
}
const result = spawnSync(electronPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(result.status ?? 1);
