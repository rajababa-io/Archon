import { isImagePath, isMarkdownPath, languageFor } from '../../primitives/file-entry';

/** How the phone's file viewer draws a file. */
export type FileView = 'image' | 'markdown' | 'code';

export function fileView(path: string): FileView {
  if (isImagePath(path)) return 'image';
  if (isMarkdownPath(path)) return 'markdown';
  return 'code';
}

/**
 * A file's text as one fenced markdown block, so the shared markdown renderer
 * highlights it with the same grammar the chat uses for code. The fence is one
 * backtick longer than the longest run inside the text, which is what stops a
 * file that itself contains a fence (a README, this module's own test) from
 * closing the block early.
 */
export function codeFence(text: string, path: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${languageFor(path)}\n${text}\n${fence}`;
}
