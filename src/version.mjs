import { readFileSync } from 'node:fs';

let resolved = '0.3.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (typeof pkg?.version === 'string' && pkg.version.trim()) {
    resolved = pkg.version.trim();
  }
} catch {}

export const APP_VERSION = resolved;
