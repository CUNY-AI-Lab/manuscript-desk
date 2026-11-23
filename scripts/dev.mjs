// `npm run dev`: builds dist/, then serves the pages and the Worker's real routes at
// http://127.0.0.1:8787/manuscript/ (PORT overrides) in local test mode: sign-in is simulated, and
// model calls go to the public CAIL Gateway charged to the key in CAIL_API_KEY. See dev-server.mjs.
// The key is read only from that variable and is never printed or logged.
import './build.mjs';
import { DEFAULT_PORT, startDevServer } from './dev-server.mjs';

const key = process.env.CAIL_API_KEY?.trim() || undefined;
if (key && !/^[\x21-\x7e]+$/.test(key)) {
  console.error('CAIL_API_KEY contains characters a Gateway key cannot have (spaces or non-ASCII). Check the value and try again.');
  process.exit(1);
}
const port = process.env.PORT === undefined || process.env.PORT === '' ? DEFAULT_PORT : Number(process.env.PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT must be a whole number from 0 to 65535.');
  process.exit(1);
}

let local;
try {
  local = await startDevServer({ port, key });
} catch (error) {
  console.error(error?.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT to another port.` : 'The local server could not start.');
  process.exit(1);
}
console.log(`Manuscript Desk, local test mode: ${local.origin}/manuscript/format/ and ${local.origin}/manuscript/index/`);
if (key) console.log('Sign-in is simulated. Every model call is real and is charged to the allowance of the CAIL_API_KEY owner.');
else console.log('CAIL_API_KEY is not set: the pages are served, but model calls will fail. To use real models, run CAIL_API_KEY=<your CAIL Gateway key> npm run dev');
