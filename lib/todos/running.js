// Running-title proposals from a model: the request (the chapter titles, numbered, each with its
// length), the reading of a reply, and the run that asks once more, with the count, for any
// proposal over the limit. A proposal is kept only when it fits the length the rule gives and is
// made of the title's own words, so the model cannot invent one. Pure: no DOM, no network; the
// model call is passed in.

const CODE_FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const wordsOf = text => text.normalize('NFC').toLocaleLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean);
const length = text => Array.from(text).length;
const clean = title => title.replace(/\s+/gu, ' ').trim();

/**
 * The text sent to the model: one line per chapter, "[n] (84 characters) Title: Subtitle", and,
 * for a second request, the length of the proposal that was too long.
 * @param {Array<{ first: number, title: string, tooLong?: number }>} chapters
 * @returns {{ titles: string, asked: Map<number, { first: number, title: string }> }}
 */
export function runningTitlesRequest(chapters) {
  const asked = new Map();
  const lines = chapters.map((chapter, at) => {
    asked.set(at + 1, chapter);
    const note = chapter.tooLong ? `; your proposal had ${chapter.tooLong}, over the limit` : '';
    return `[${at + 1}] (${length(clean(chapter.title))} characters${note}) ${clean(chapter.title)}`;
  });
  return { titles: lines.join('\n'), asked };
}

/**
 * The proposals of a reply, by chapter start, and those dropped: { first, reason, length } with
 * reason 'too-long', 'empty' or 'new-words'. Null when the reply does not parse.
 * @returns {{ proposals: Map<number, string>, dropped: Array<{ first: number, reason: string, length?: number }> } | null}
 */
export function parseRunningTitles(content, asked, max) {
  if (typeof content !== 'string') return null;
  const fenced = CODE_FENCE.exec(content);
  let data;
  try {
    data = JSON.parse(fenced ? fenced[1] : content);
  } catch {
    return null;
  }
  if (!isObject(data) || !isObject(data.titles)) return null;
  const proposals = new Map();
  const dropped = [];
  for (const [number, chapter] of asked) {
    const value = data.titles[String(number)];
    const proposal = typeof value === 'string' ? clean(value).replace(/^["“”'‘’]+|["“”'‘’]+$/gu, '') : '';
    const known = new Set(wordsOf(chapter.title));
    if (!proposal) dropped.push({ first: chapter.first, reason: 'empty' });
    else if (!wordsOf(proposal).every(word => known.has(word))) dropped.push({ first: chapter.first, reason: 'new-words' });
    else if (length(proposal) > max) dropped.push({ first: chapter.first, reason: 'too-long', length: length(proposal) });
    else proposals.set(chapter.first, proposal);
  }
  return { proposals, dropped };
}

/**
 * Proposes running titles: one request for every chapter, then one more for the proposals that
 * were too long, each with the length it had.
 * @param {{ chapters: Array<{ first: number, title: string }>, max: number, call: (request: { titles: string, max: number }) => Promise<string> }} input
 * @returns {Promise<{ proposals: Map<number, string>, dropped: Array<object>, calls: number }>}
 */
export async function proposeRunningTitles({ chapters, max, call }) {
  const first = runningTitlesRequest(chapters);
  const answer = parseRunningTitles(await call({ titles: first.titles, max }), first.asked, max) ?? { proposals: new Map(), dropped: chapters.map(chapter => ({ first: chapter.first, reason: 'unreadable' })) };
  const again = answer.dropped.filter(entry => entry.reason === 'too-long');
  if (!again.length) return { ...answer, calls: 1 };
  const byFirst = new Map(chapters.map(chapter => [chapter.first, chapter]));
  const second = runningTitlesRequest(again.map(entry => ({ ...byFirst.get(entry.first), tooLong: entry.length })));
  const retry = parseRunningTitles(await call({ titles: second.titles, max }), second.asked, max);
  const proposals = new Map(answer.proposals);
  for (const [at, proposal] of retry?.proposals ?? []) proposals.set(at, proposal);
  const dropped = [...answer.dropped.filter(entry => entry.reason !== 'too-long'), ...(retry ? retry.dropped : again)];
  return { proposals, dropped, calls: 2 };
}
