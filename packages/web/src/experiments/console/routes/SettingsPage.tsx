import { type ReactElement } from 'react';
import { ModelTiersPanel } from '../components/ModelTiersPanel';
import { AliasesPanel } from '../components/AliasesPanel';
import { AgentsPanel } from '../components/AgentsPanel';
import { AssistantConfigPanel } from '../components/AssistantConfigPanel';
import { ChatsPanel } from '../components/ChatsPanel';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { SystemPanel } from '../components/SystemPanel';
import { AppearancePanel } from '../components/AppearancePanel';
import { GithubIdentityPanel } from '../components/GithubIdentityPanel';
import { AccountPanel } from '../components/AccountPanel';

/**
 * Global (installation-wide) console "AI Settings" — sectioned: Model Tiers (the
 * config tiers editor, ungated) → Agents (per-agent credential cards: keys +
 * subscription login, #1956) → Defaults (default assistant + per-provider
 * model) → Chats (handoff thresholds) → Notifications (this browser) → System → GitHub. Mounted at `/console/settings`; the config write
 * paths (PATCH /api/config/* → ~/.archon/config.yaml) are install-wide.
 */
export function SettingsPage(): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="px-7.75 pt-[13.5px]">
        <h1 className="text-display font-semibold text-text-primary">Settings</h1>
      </header>
      <div className="flex-1 overflow-y-auto px-7.75 pb-8.75 pt-3">
        <div className="mx-auto flex max-w-[680px] flex-col gap-x-3.75 gap-y-3">
          <ModelTiersPanel />
          <AliasesPanel />
          <AgentsPanel />
          <AssistantConfigPanel />
          <ChatsPanel />
          <NotificationsPanel />
          <AppearancePanel />
          <SystemPanel />
          <GithubIdentityPanel />
          <AccountPanel />
        </div>
      </div>
    </div>
  );
}
