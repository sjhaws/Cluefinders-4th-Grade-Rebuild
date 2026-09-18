import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** One hash over every game file's path and bytes; it changes whenever any of them does. */
function hashAssets(dir: string): string {
  const hash = createHash('sha256');
  const walk = (sub: string) => {
    for (const name of readdirSync(join(dir, sub)).sort()) {
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) walk(rel);
      else hash.update(rel).update('\0').update(readFileSync(join(dir, rel)));
    }
  };
  walk('');
  return hash.digest('hex').slice(0, 12);
}

export default defineConfig(({ command }) => ({
  root: '.',
  publicDir: 'public',
  define: {
    __ASSET_VERSION__: JSON.stringify(
      command === 'build' ? hashAssets(fileURLToPath(new URL('./public/assets', import.meta.url))) : ''
    ),
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
  server: {
    port: 5173,
  },
}));
