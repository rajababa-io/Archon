import { isRegisteredProvider, registerProvider } from '../../registry';

import { COPILOT_CAPABILITIES } from './capabilities';
import { parseCopilotConfigStrict } from './config';
import { CopilotProvider } from './provider';

/**
 * Register the GitHub Copilot community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from `registerBuiltinProviders()` because `builtIn: false` is
 * load-bearing: Copilot is a community provider and must not be conflated
 * with core providers until it's explicitly promoted.
 */
export function registerCopilotProvider(): void {
  if (isRegisteredProvider('copilot')) return;
  registerProvider({
    id: 'copilot',
    displayName: 'Copilot (GitHub)',
    factory: () => new CopilotProvider(),
    capabilities: COPILOT_CAPABILITIES,
    builtIn: false,
    parseConfig: parseCopilotConfigStrict,
    // No API exposes Copilot's catalog — the CLI negotiates it per
    // subscription — so this is hand-curated and NOT authoritative.
    suggestedModels: [
      { id: 'auto', note: 'Copilot picks' },
      { id: 'gpt-5' },
      { id: 'gpt-5-mini' },
      { id: 'claude-sonnet-4.5' },
    ],
    credentials: {
      kind: 'static',
      specs: [
        {
          vendor: 'github-copilot',
          displayName: 'GitHub Copilot',
          kinds: ['api_key', 'subscription'],
        },
      ],
    },
  });
}
