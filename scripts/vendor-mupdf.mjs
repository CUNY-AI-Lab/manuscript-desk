// Copy the MuPDF.js files the browser needs from node_modules into web/vendor/mupdf (git-ignored),
// with MuPDF's licence and a VERSION file. npm run check runs it before the build.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const src = 'node_modules/mupdf';
const dest = 'web/vendor/mupdf';
const { version } = JSON.parse(readFileSync(`${src}/package.json`, 'utf8'));

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const file of ['mupdf.js', 'mupdf-wasm.js', 'mupdf-wasm.wasm']) cpSync(`${src}/dist/${file}`, `${dest}/${file}`);
cpSync(`${src}/LICENSE`, `${dest}/LICENSE`);
writeFileSync(`${dest}/VERSION`, `${version}\n`);
console.log(`Vendored mupdf ${version} into ${dest}`);
