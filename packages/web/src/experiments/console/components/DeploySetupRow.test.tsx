import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeploySetupRow, saveDeploySetup } from './DeploySetupRow';

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

describe('saveDeploySetup', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  interface Call {
    url: string;
    method: string | undefined;
    body: string | null;
  }

  function answer(status: number, body: unknown): Call[] {
    const calls: Call[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    }) as typeof fetch;
    return calls;
  }

  const INPUT = { branch: 'main', productionBranch: 'production', workflowName: 'deploy' };

  test("PUTs the project's deploy once, with both branches", async () => {
    const calls = answer(200, { ok: true });
    expect(await saveDeploySetup('p1', INPUT)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/projects/p1/deploy');
    expect(calls[0].method).toBe('PUT');
    expect(JSON.parse(calls[0].body ?? 'null')).toEqual(INPUT);
  });

  test("a refusal comes back as the server's own words", async () => {
    answer(403, { error: 'Only a person signed in through Cloudflare Access can do this.' });
    expect(await saveDeploySetup('p1', INPUT)).toBe(
      'Only a person signed in through Cloudflare Access can do this.'
    );
  });
});
