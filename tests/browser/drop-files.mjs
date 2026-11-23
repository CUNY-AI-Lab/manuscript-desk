// Drags files onto an element of a page as a person would, for the browser smoke tests: dragenter,
// dragover and drop with a DataTransfer holding the files. Says whether the element was marked as
// the target while the files were over it.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {Array<string | { name: string, mimeType?: string, buffer: Buffer }>} files paths or contents
 * @returns {Promise<boolean>} whether the element had the class drag-over before the drop
 */
export async function dropFiles(page, selector, files) {
  const items = await Promise.all(files.map(async file => (typeof file === 'string'
    ? { name: basename(file), type: '', data: (await readFile(file)).toString('base64') }
    : { name: file.name, type: file.mimeType ?? '', data: file.buffer.toString('base64') })));
  const transfer = await page.evaluateHandle(list => {
    const data = new DataTransfer();
    for (const item of list) data.items.add(new File([Uint8Array.from(atob(item.data), char => char.charCodeAt(0))], item.name, { type: item.type }));
    return data;
  }, items);
  await page.dispatchEvent(selector, 'dragenter', { dataTransfer: transfer });
  await page.dispatchEvent(selector, 'dragover', { dataTransfer: transfer });
  const marked = await page.locator(selector).evaluate(node => node.classList.contains('drag-over'));
  await page.dispatchEvent(selector, 'drop', { dataTransfer: transfer });
  await transfer.dispose();
  return marked;
}

/**
 * Drops a file on an element outside every drop area. Says whether the page stopped the browser's
 * own handling (opening the file in place of the page) for the dragover and the drop.
 * @returns {Promise<[boolean, boolean]>}
 */
export function dropStray(page, selector) {
  return page.evaluate(target => {
    const data = new DataTransfer();
    data.items.add(new File(['stray'], 'stray.txt', { type: 'text/plain' }));
    const node = document.querySelector(target);
    return ['dragover', 'drop'].map(type => !node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })));
  }, selector);
}
