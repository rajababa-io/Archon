import { describe, expect, test } from 'bun:test';
import { diffLines } from './diff-lines';

describe('diffLines', () => {
  test('header lines are meta even when they start with + or -', () => {
    // `--- a/x` and `+++ b/x` precede the first hunk; colouring them as a
    // removal and an addition would misstate the change by two lines.
    const patch = [
      'diff --git a/x b/x',
      'index 1..2 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' same',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(diffLines(patch).map(l => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
      'note',
    ]);
  });

  test('a line removed that begins with "--" is still a removal inside a hunk', () => {
    const lines = diffLines('@@ -1 +0,0 @@\n--- a comment\n');
    expect(lines[1]).toEqual({ kind: 'del', text: '--- a comment' });
  });

  test('an empty patch has no lines', () => {
    expect(diffLines('')).toEqual([]);
  });
});
