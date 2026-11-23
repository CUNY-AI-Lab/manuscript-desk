// Dragging files onto the pages. Every file input sits in a drop area: a file dropped there goes
// through the same check and the same handler as a file chosen with the button (`fileInput`), so
// the two ways in give the same messages. A file dropped anywhere else is ignored, with a short
// hint, and never opens in the browser in place of the page (`guardWindow`). The real input stays
// as it was, focusable and labelled; the drop area only adds to it.
// The checks and the messages are pure and load under Node; the rest needs a DOM and runs only
// when called.

/** What each kind of file input takes, in words, and the largest file it takes. */
export const FILE_KINDS = Object.freeze({
  guidelines: { what: 'a PDF or Word file (.pdf or .docx)', maxBytes: 100e6 },
  manuscript: { what: 'a Word file (.docx)', maxBytes: 200e6 },
  proofs: { what: 'a PDF file (.pdf)', maxBytes: 500e6 },
  'term-list': { what: 'a plain text file (.txt)', maxBytes: 8e6 },
  'rule-sheet': { what: 'a rule sheet file (.json)', maxBytes: 8e6 },
});

export const STRAY_HINT = 'To add a file, drop it on one of the boxes marked “Drag a file here”.';
export const BUSY = 'This cannot take a file right now. Wait until the work under way is done, then try again.';

/** The words a drop area shows. */
export const dropLabel = multiple => (multiple ? 'Drag files here, or choose them' : 'Drag a file here, or choose one');

/** A size in plain words: "350 KB", "12 MB", "1.5 GB". */
export function sizeText(bytes) {
  const units = [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']];
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${unit}`;
    }
  }
  return `${bytes} bytes`;
}

/** An input's `accept` attribute taken apart: extensions (".pdf"), types ("application/pdf") and families ("text/"). */
export function acceptList(accept = '') {
  const parts = String(accept).split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  return {
    extensions: parts.filter(part => part.startsWith('.')),
    types: parts.filter(part => part.includes('/') && !part.endsWith('/*')),
    families: parts.filter(part => part.endsWith('/*')).map(part => part.slice(0, -1)),
  };
}

/** Whether a file fits an `accept` attribute, by its name's extension or its type. An empty accept takes anything. */
export function fileAccepted(file, accept = '') {
  const { extensions, types, families } = acceptList(accept);
  if (!extensions.length && !types.length && !families.length) return true;
  const name = String(file?.name ?? '').toLowerCase();
  const type = String(file?.type ?? '').toLowerCase();
  return extensions.some(extension => name.endsWith(extension)) || (type !== '' && (types.includes(type) || families.some(family => type.startsWith(family))));
}

/**
 * Checks the files given to an input, chosen or dropped: how many, their type, their size.
 * @param {ArrayLike<{ name: string, type?: string, size: number }>} files
 * @param {{ accept?: string, multiple?: boolean, kind: string }} spec kind: a key of FILE_KINDS
 * @returns {{ ok: true, files: object[] } | { ok: false, message: string }}
 */
export function checkFiles(files, { accept = '', multiple = false, kind }) {
  const list = [...(files ?? [])];
  const { what, maxBytes } = FILE_KINDS[kind] ?? { what: 'a file of the right kind', maxBytes: Infinity };
  if (!list.length) return { ok: false, message: `No file was found there. Drag ${what} itself, not a folder.` };
  if (!multiple && list.length > 1) return { ok: false, message: `This takes one file at a time, and ${list.length} were given. Drag ${what} on its own.` };
  for (const file of list) {
    if (!fileAccepted(file, accept)) return { ok: false, message: `${file.name} is not ${what}.` };
    if (Number(file.size) > maxBytes) return { ok: false, message: `${file.name} is too large (${sizeText(file.size)}). The largest file this takes is ${sizeText(maxBytes)}.` };
  }
  return { ok: true, files: list };
}

/** Whether a drag carries files (not text or a link dragged from the page). */
export const draggingFiles = dataTransfer => [...(dataTransfer?.types ?? [])].includes('Files');

// --- The page ---

const ZONE = '.drop-zone';
const OVER = 'drag-over';
const PAGE_DRAGGING = 'dragging-files';

/**
 * Wires one file input and its drop area: a file chosen or dropped is checked (checkFiles) and
 * then handed to `onFiles`; a problem goes to `onProblem` with its message.
 * @param {{ input: HTMLInputElement, zone: HTMLElement, onFiles: (files: File[]) => unknown, onProblem: (message: string) => void, clear?: boolean }} options
 *   clear: empty the input after each choice, so the same file can be chosen again
 */
export function fileInput({ input, zone, onFiles, onProblem, clear = false }) {
  const spec = () => ({ accept: input.accept, multiple: input.multiple, kind: input.dataset.fileKind });
  const take = async (files, { dropped = false } = {}) => {
    if (input.matches(':disabled')) { onProblem(BUSY); return; }
    const checked = checkFiles(files, spec());
    if (!checked.ok) { onProblem(checked.message); return; }
    // A dropped file is shown in the input as a chosen one is, where the input keeps what it holds.
    if (dropped && !clear && !input.hidden) {
      try { const transfer = new DataTransfer(); checked.files.forEach(file => transfer.items.add(file)); input.files = transfer.files; } catch {}
    }
    await onFiles(checked.files);
  };
  input.addEventListener('change', async () => {
    const files = [...input.files];
    if (clear) input.value = '';
    if (files.length) await take(files);
  });
  let depth = 0;
  const leave = () => { depth = 0; zone.classList.remove(OVER); };
  zone.addEventListener('dragenter', event => {
    if (!draggingFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth += 1;
    zone.classList.add(OVER);
  });
  zone.addEventListener('dragover', event => {
    if (!draggingFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    zone.classList.add(OVER);
  });
  zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) leave(); });
  zone.addEventListener('drop', event => {
    if (!draggingFiles(event.dataTransfer)) return;
    event.preventDefault();
    leave();
    void take([...event.dataTransfer.files], { dropped: true });
  });
  return { take };
}

let guarded = false;
/**
 * Keeps a file dropped outside the drop areas from replacing the page, and says where to drop it.
 * Marks the page while a file is dragged over it, so the drop areas stand out. Once per page.
 */
export function guardWindow({ onStray = showHint } = {}) {
  if (guarded) return;
  guarded = true;
  const root = document.documentElement;
  let timer = null;
  const dragging = () => { root.classList.add(PAGE_DRAGGING); clearTimeout(timer); timer = setTimeout(() => root.classList.remove(PAGE_DRAGGING), 200); };
  const inZone = target => target instanceof Element && target.closest(ZONE) !== null;
  globalThis.addEventListener('dragover', event => {
    if (!draggingFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragging();
  });
  globalThis.addEventListener('drop', event => {
    if (!draggingFiles(event.dataTransfer)) return;
    event.preventDefault();
    clearTimeout(timer);
    root.classList.remove(PAGE_DRAGGING);
    if (!inZone(event.target)) onStray(STRAY_HINT);
  });
}

let hintTimer = null;
/** A short notice at the foot of the window, read out by screen readers, gone after a few seconds. */
export function showHint(message) {
  let hint = document.getElementById('drop-hint');
  if (!hint) {
    hint = document.createElement('p');
    hint.id = 'drop-hint';
    hint.className = 'drop-hint';
    hint.setAttribute('role', 'status');
    document.body.append(hint);
  }
  hint.textContent = message;
  hint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint.hidden = true; }, 5000);
}
