// The kinds of change the formatter declares, by name, so that later stages (the To-do checks, the
// comments and the To-dos list) can find the changes the author must verify. Pure data.

export const DECLARED = Object.freeze({
  emptyRemoved: 'empty paragraph removed',
  emptyKept: 'empty paragraph kept because it holds a field, a note or other markup',
  linesJoined: 'lines of a quotation pasted one per paragraph joined into its paragraph',
  stanzaBreak: 'empty paragraph kept as a stanza break',
  titleSplit: 'title split at a colon into a title and a subtitle',
  authorSplit: 'author line split from the affiliation on the same line',
  markerRewritten: 'figure placement marker rewritten in the form the rule sheet asks for',
  markerAdded: 'figure placement marker added',
  captionAdded: 'figure caption line added with its number',
  captionNumbered: 'figure number added to its caption',
  breakInsideRemoved: 'section break inside a chapter removed',
  emptySectionRemoved: 'empty section removed',
  breakAdded: 'section break added at the start of a chapter',
  carrierAdded: 'empty paragraph added to carry a section break',
  headingNumbers: 'heading numbers added through Word numbering (no typed text)',
  duplicateStyle: 'duplicate style definition removed',
});
