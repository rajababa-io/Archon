import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskCard } from './AskCard';
import type { AskSpec } from '../primitives/ask';

const noop = (): void => undefined;

function spec(allowOwn?: boolean): AskSpec {
  return {
    questions: [
      {
        title: 'Ship it?',
        options: [{ label: 'Yes' }, { label: 'No' }],
        ...(allowOwn === undefined ? {} : { allowOwn }),
      },
    ],
  };
}

describe('AskCard attachments', () => {
  // The free-text row is the only thing that can carry a file, so a question
  // that refuses free text must not grow an attach control by the side door.
  test('a question with allowOwn: false offers no free-text row to attach to', () => {
    const html = renderToStaticMarkup(<AskCard spec={spec(false)} onAnswer={noop} />);
    expect(html).not.toContain('Type your own');
    expect(html).not.toContain('Attach');
  });

  // A card being read rather than answered — history, or a turn in flight —
  // has no send of its own for a file to ride.
  test('a read-only card offers no free-text row and no attach control', () => {
    const html = renderToStaticMarkup(<AskCard spec={spec()} />);
    expect(html).not.toContain('Type your own');
    expect(html).not.toContain('Attach');
  });

  test('an answerable card offers the free-text row', () => {
    const html = renderToStaticMarkup(<AskCard spec={spec()} onAnswer={noop} />);
    expect(html).toContain('Type your own');
  });
});

describe('AskCard keyboard', () => {
  // The composer's Up finds the card by this marker, so a card that can no
  // longer be answered must not carry it.
  test('only an answerable card is marked as the one Up reaches', () => {
    expect(renderToStaticMarkup(<AskCard spec={spec()} onAnswer={noop} />)).toContain(
      'data-ask-live="true"'
    );
    expect(renderToStaticMarkup(<AskCard spec={spec()} />)).not.toContain('data-ask-live');
  });

  test('a one-question card says Enter sends', () => {
    expect(renderToStaticMarkup(<AskCard spec={spec()} onAnswer={noop} />)).toContain('↵ to send');
  });

  // Nothing is highlighted until the keyboard is actually on the card; a
  // mouse user never sees the highlight.
  test('no row is highlighted before the card has focus', () => {
    expect(renderToStaticMarkup(<AskCard spec={spec()} onAnswer={noop} />)).not.toContain(
      'data-highlighted'
    );
  });
});
