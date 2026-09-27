import { useState, type ReactElement } from 'react';
import { disableNotify, enableNotify, notifyState, type NotifyState } from '../lib/notify';
import { SettingsSection } from './SettingsSection';
import { Switch } from './SettingsFormPrimitives';

const NOTE: Readonly<Record<NotifyState, string | null>> = {
  unsupported: 'This browser cannot show notifications here.',
  blocked: 'This browser has blocked notifications for this site. Allow them in its site settings.',
  off: null,
  on: null,
};

/**
 * The opt-in for chat notifications. The browser's permission prompt appears
 * only when the switch is turned on — a click, never a page load.
 */
export function NotificationsPanel(): ReactElement {
  const [state, setState] = useState<NotifyState>(notifyState);
  const [asking, setAsking] = useState(false);

  const onChange = (on: boolean): void => {
    if (!on) {
      disableNotify();
      setState(notifyState());
      return;
    }
    setAsking(true);
    void enableNotify()
      .then(setState)
      .finally(() => {
        setAsking(false);
      });
  };

  const note = NOTE[state];
  return (
    <SettingsSection title="Notifications" scope="this browser">
      <div className="flex items-start gap-[13.5px] py-[5px]">
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-text-primary">
            Tell me when a chat finishes or asks
          </div>
          <div className="mt-[3px] text-body leading-relaxed text-text-tertiary">
            Only while this tab is hidden, only for the project&rsquo;s chat page you left open, and
            only the chat&rsquo;s name — never what it said. Click one to open that chat.
          </div>
          {note !== null ? <div className="mt-[6px] text-small text-warning">{note}</div> : null}
        </div>
        <div className="shrink-0 pt-[2px]">
          <Switch
            label="Chat notifications"
            checked={state === 'on'}
            disabled={asking || state === 'unsupported' || state === 'blocked'}
            onChange={onChange}
          />
        </div>
      </div>
    </SettingsSection>
  );
}
