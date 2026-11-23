// Writes the invented manuscripts the browser smoke test chooses as files, from the builder in
// tests/manuscript-fixture.mjs. Run once (node tests/fixtures/make-manuscripts.mjs) and commit the
// output. All text is invented for the tests.
//   manuscript.docx        two chapters typed with direct formatting and no styles
//   manuscript-other.docx  the same with typed heading numbers: another file, with other contents
import { writeFileSync } from 'node:fs';
import { manuscript } from '../manuscript-fixture.mjs';

const here = name => new URL(name, import.meta.url);
writeFileSync(here('manuscript.docx'), manuscript().bytes);
writeFileSync(here('manuscript-other.docx'), manuscript({ typedNumbers: true }).bytes);
