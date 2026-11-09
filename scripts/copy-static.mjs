// Copies non-TypeScript UI files and assets next to the compiled output.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath handles Windows drive letters; URL.pathname gives '/E:/...'.
const root = fileURLToPath(new URL('..', import.meta.url));
const uiSrc = join(root, 'src', 'ui');
const uiOut = join(root, 'dist', 'ui');
mkdirSync(uiOut, { recursive: true });
for (const name of readdirSync(uiSrc)) {
  if (name.endsWith('.html') || name.endsWith('.css')) {
    cpSync(join(uiSrc, name), join(uiOut, name));
  }
}
cpSync(join(root, 'assets'), join(root, 'dist', 'assets'), { recursive: true });
