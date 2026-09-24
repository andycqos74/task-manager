import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Emits /sw.js from ./sw.js at build time, filling in the list of files to
// precache (this build's bundles plus everything in public/) and a version
// derived from them, so a new deploy always installs a new worker. Dev builds
// get no worker at all — it would fight with hot reload.
function serviceWorker() {
  return {
    name: 'service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const publicFiles = fs.readdirSync(new URL('./public', import.meta.url))
        .filter((f) => !f.startsWith('.'));
      const files = [
        '/index.html',
        ...publicFiles.map((f) => `/${f}`),
        ...Object.keys(bundle).filter((f) => f !== 'index.html').map((f) => `/${f}`),
      ].sort();
      // Bundle names are content-hashed already; public/ files and index.html
      // are not, so their contents go into the version too.
      const hash = createHash('sha256').update(files.join('\n')).update(bundle['index.html']?.source ?? '');
      for (const f of publicFiles) hash.update(fs.readFileSync(new URL(`./public/${f}`, import.meta.url)));
      const version = hash.digest('hex').slice(0, 12);
      const source = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8')
        .replace('= __VERSION__;', `= ${JSON.stringify(version)};`)
        .replace('= __PRECACHE__;', `= ${JSON.stringify(files)};`);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
