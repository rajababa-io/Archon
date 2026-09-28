import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeploySetupRow } from './DeploySetupRow';

const SETUP = { branch: 'main', workflows: ['deploy'], workflow: 'deploy' };

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('DeploySetupRow', () => {
  test('says exactly "Deploys: not set up", then Set up deploys, and nothing else', () => {
    const html = renderToStaticMarkup(<DeploySetupRow projectId="p1" setup={SETUP} canAct />);
    expect(text(html)).toBe('Deploys: not set up Set up deploys');
    expect(html).not.toContain('Live');
    expect(html).not.toContain('Deploy on Merge');
  });

  test('is the deploy bar height, with a hollow dot rather than a filled one', () => {
    const html = renderToStaticMarkup(<DeploySetupRow projectId="p1" setup={SETUP} canAct />);
    expect(html).toContain('h-9');
    expect(html).toContain('ring-inset');
    expect(html).not.toContain('bg-success');
  });

  test('only a person can set up deploys', () => {
    const html = renderToStaticMarkup(
      <DeploySetupRow projectId="p1" setup={SETUP} canAct={false} />
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Only a person/u);
  });
});
