// Reads one PDF page's text from MuPDF's structured text, putting back the spaces between words that
// MuPDF's own plain-text output drops on tightly justified lines of some typeset PDFs. The spaces are recovered
// from the characters' positions: a gap wider than a tenth of the font size between two characters
// on one line is a word break.
// Pure: it is given a MuPDF page (anything with toStructuredText(options) returning an object with
// walk(walker) and destroy()), and imports neither mupdf nor the DOM. The caller releases the page.

// Measured on one publisher's 60,000-character guide against an independent extraction: 0.08 and
// 0.12 produced no wrong words, 0.05 split words apart and 0.18 fixed nothing; a second publisher's
// PDF was unaffected at every value. Do not change it without new measurements.
export const SPACE_GAP = 0.10; // fraction of the font size

const WHITESPACE = /\s/;

// quad is [ulx, uly, urx, ury, llx, lly, lrx, lry].
const leftEdge = quad => Math.min(quad[0], quad[4]);
const rightEdge = quad => Math.max(quad[2], quad[6]);

// Each line ends with a newline and each text block with one more, leaving a blank line between blocks.
export function pageText(page) {
  const stext = page.toStructuredText('preserve-whitespace');
  try {
    const parts = [];
    let previous = null; // the line's last character: { c, right }
    stext.walk({
      beginLine() {
        previous = null;
      },
      onChar(c, origin, font, size, quad) {
        // A negative gap (overlapping or right-to-left glyphs) is never wider than the threshold.
        if (previous && !WHITESPACE.test(previous.c) && !WHITESPACE.test(c)
          && leftEdge(quad) - previous.right > size * SPACE_GAP) parts.push(' ');
        parts.push(c);
        previous = { c, right: rightEdge(quad) };
      },
      endLine() {
        parts.push('\n');
      },
      endTextBlock() {
        parts.push('\n');
      },
    });
    return parts.join('');
  } finally {
    stext.destroy();
  }
}
