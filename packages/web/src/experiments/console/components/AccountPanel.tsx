import { useState, type ReactElement } from 'react';
import { useSession, signOut } from '@/lib/auth-client';
import * as skill from '../skills';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { SettingsSection } from './SettingsSection';

/**
 * Sign out.
 *
 * `signOut()` has existed in lib/auth-client all along, but its only caller was
 * the classic UI's TopNav. Retiring that UI took the affordance with it, so on
 * an install with web auth ON you could sign in and never sign out.
 *
 * Renders NOTHING when auth is disabled, which is the default and every solo
 * install — the same choice GithubIdentityPanel makes for the solo-PAT state.
 * A sign-out button on an install with no sessions is a control that cannot do
 * anything, and an empty panel is worse than no panel.
 */
export function AccountPanel(): ReactElement | null {
  const { data: status } = useEntity(K.authStatus, skill.getAuthStatus);
  const { data: session } = useSession();
  const [busy, setBusy] = useState(false);

  if (status?.enabled !== true) return null;

  const who = session?.user.email ?? session?.user.name ?? null;

  return (
    <SettingsSection title="Account">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-body text-text-primary">{who ?? 'Signed in'}</div>
          <div className="mt-0.5 text-small text-text-tertiary">
            Ends this browser session. Nothing on the server changes.
          </div>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            // No finally-reset: a successful sign-out navigates away, so
            // re-enabling the button would only ever flash on failure.
            void signOut().catch(() => {
              setBusy(false);
            });
          }}
          className="shrink-0 rounded-lg border border-border px-2.75 py-1.5 text-body font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:opacity-40"
        >
          {busy ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </SettingsSection>
  );
}
