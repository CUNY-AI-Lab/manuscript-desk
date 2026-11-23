// Writes dist/, the Worker's static assets. MuPDF is copied from web/vendor/mupdf (npm run vendor)
// and loaded at run time from vendor/mupdf/, never bundled.
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('node_modules/mupdf/package.json', 'utf8'));
const vendored = (await readFile('web/vendor/mupdf/VERSION', 'utf8').catch(() => '')).trim();
if (vendored !== version) throw new Error(`web/vendor/mupdf ${vendored ? `is ${vendored}, not ${version}` : 'is missing'}: run npm run vendor.`);

await rm('dist', { recursive: true, force: true });
await mkdir('dist/format', { recursive: true });
await mkdir('dist/shared', { recursive: true });
await cp('web/index.html', 'dist/index.html');
await cp('web/format/index.html', 'dist/format/index.html');
await cp('web/shared/styles.css', 'dist/shared/styles.css');
await cp('web/vendor/mupdf', 'dist/vendor/mupdf', { recursive: true });
await cp('LICENSE', 'dist/LICENSE.txt');
await build({
  entryPoints: ['web/format/app.js', 'web/shared/pdf-worker.js', 'web/shared/guidelines-extractors.js'], outbase: 'web', outdir: 'dist',
  bundle: true, format: 'esm', platform: 'browser', sourcemap: true, target: ['es2022'], minify: false,
  external: ['../vendor/mupdf/*'],
});
