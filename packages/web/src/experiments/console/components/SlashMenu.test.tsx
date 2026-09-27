import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlashMenu } from './SlashMenu';
import { buildSlashEntries } from '../lib/slash-menu';

const noop = (): void => undefined;

describe('SlashMenu', () => {
  const matches = buildSlashEntries({
    commands: [{ command: '/workflow run', args: '<name> [message]', description: 'Run one' }],
    workflows: [{ name: 'archon-plan', summary: 'Plan a change' }],
    provider: null,
  });

  test('shows each entry with its arguments and one-line description', () => {
    const html = renderToStaticMarkup(
      <SlashMenu id="m" matches={matches} active={0} onHover={noop} onChoose={noop} />
    );
    expect(html).toContain('/workflow run');
    expect(html).toContain('&lt;name&gt; [message]');
    expect(html).toContain('Run one');
    expect(html).toContain('Plan a change');
    expect(html).toContain('workflow</span>');
  });

  test('marks only the highlighted entry selected, under the id the textarea points at', () => {
    const html = renderToStaticMarkup(
      <SlashMenu id="m" matches={matches} active={1} onHover={noop} onChoose={noop} />
    );
    expect(html).toContain('id="m-option-1" role="option" aria-selected="true"');
    expect(html).toContain('id="m-option-0" role="option" aria-selected="false"');
  });

  test('headings only the unfiltered list, and shows a notice above it', () => {
    const plain = renderToStaticMarkup(
      <SlashMenu id="m" matches={matches} active={0} onHover={noop} onChoose={noop} />
    );
    const grouped = renderToStaticMarkup(
      <SlashMenu
        id="m"
        matches={matches}
        grouped
        notice="Claude commands unavailable: boom"
        active={0}
        onHover={noop}
        onChoose={noop}
      />
    );
    expect(plain).not.toContain('>Archon</li>');
    expect(grouped).toContain('>Archon</li>');
    expect(grouped).toContain('>Workflows</li>');
    expect(grouped).toContain('Claude commands unavailable: boom');
  });
});
