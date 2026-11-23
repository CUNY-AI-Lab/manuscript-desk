// What a To-do check reads: the reader's paragraph model, the paragraph roles, the formatter's report
// (its chapters with their title-block parts, its declared changes with the places they were made,
// its figures and settings) and the rule sheet, with small helpers over them. Pure: no DOM, no network.

/**
 * @param {{ paragraphs: Array<object>, roles: Record<number, string>, report: object, sheet: object | null }} input
 */
export function checkContext({ paragraphs = [], roles = {}, report = {}, sheet = null }) {
  const byIndex = new Map(paragraphs.map(entry => [entry.index, entry]));
  const chapters = Array.isArray(report.chapters) ? report.chapters : [];
  const roleOf = index => roles[index] ?? roles[String(index)] ?? null;
  const textOf = index => byIndex.get(index)?.text ?? '';
  const isEmpty = index => byIndex.get(index)?.hints?.empty !== false;
  const chapterOf = index => {
    if (index === null || index === undefined) return null;
    const at = chapters.findIndex(chapter => index >= chapter.first && index <= chapter.last);
    return at < 0 ? null : at;
  };
  // The non-empty paragraphs of a chapter, in order.
  const paragraphsOf = chapter => paragraphs.filter(entry => entry.index >= chapter.first && entry.index <= chapter.last && entry.hints?.empty === false);
  const withRole = (chapter, role) => paragraphsOf(chapter).filter(entry => roleOf(entry.index) === role);
  // The source paragraphs a kind of change was declared at, each once, in order.
  const placesOf = kind => [...new Set((report.declared ?? []).find(entry => entry.kind === kind)?.places ?? [])].sort((a, b) => a - b);
  // The title-block paragraph of a chapter that has a part, or null.
  const partAt = (chapter, part) => {
    const at = (chapter.parts ?? []).indexOf(part);
    return at < 0 ? null : chapter.titleBlock[at];
  };
  const partsAt = (chapter, part) => (chapter.parts ?? []).flatMap((name, at) => (name === part ? [chapter.titleBlock[at]] : []));
  const titleOf = chapter => partAt(chapter, 'title') ?? chapter.titleBlock?.[0] ?? chapter.first;
  return { paragraphs, byIndex, roles, report, sheet, chapters, settings: report.settings ?? {}, roleOf, textOf, isEmpty, chapterOf, paragraphsOf, withRole, placesOf, partAt, partsAt, titleOf };
}

// Plain words for counts and lists in messages.
export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
export function listed(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
