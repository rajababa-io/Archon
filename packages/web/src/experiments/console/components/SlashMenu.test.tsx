import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlashMenu } from './SlashMenu';
import { buildSlashEntries } from '../lib/slash-menu';

const noop = (): void => undefined;

describe('SlashMenu', () => {
  const matches = buildSlashEntries({
    commands: [{ command: '/workflow run', args: '<name> [message]', description: 'Run one' }],
    workflows: [{ name: 'archon-plan', summary: 'Plan a change' }],
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
});
