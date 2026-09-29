import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { Plus } from 'lucide-react';
import * as skill from '../../../skills';
import { set } from '../../../store/cache';
import { K } from '../../../store/keys';
import { errorDetail } from '../../../lib/http';
import type { MobileChats } from '../../lib/use-mobile-chats';
import { chatPath } from '../../lib/paths';
import { projectChatRows } from '../../lib/switcher';
import { ChatRow } from '../ChatRow';

/** The project's open chats, the ones that need you first, and New chat. */
export function ChatsTab({
  projectId,
  chats,
}: {
  projectId: string;
  chats: MobileChats;
}): ReactElement {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const rows = useMemo(
    () => projectChatRows(chats.chats ?? [], chats.statuses, chats.statusSets.unread, projectId),
    [chats.chats, chats.statuses, chats.statusSets.unread, projectId]
  );

  // The chat screen finds a chat in the every-project list, so the list is
  // re-read before going there: a chat it does not yet hold reads as missing.
  const newChat = async (): Promise<void> => {
    setCreating(true);
    setFailure(null);
    try {
      const created = await skill.createConversation(projectId);
      set(K.allConversations, await skill.listAllConversations());
      navigate(chatPath(created.conversationId));
    } catch (err) {
      setFailure(errorDetail(err));
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="px-4">
        <button
          type="button"
          onClick={() => void newChat()}
          disabled={creating}
          className="mobile-tap flex w-full items-center justify-center gap-2 rounded-lg border border-border text-body font-medium text-text-primary disabled:opacity-50"
        >
          <Plus aria-hidden className="h-4 w-4" />
          {creating ? 'Starting a chat…' : 'New chat'}
        </button>
        {failure !== null ? (
          <p role="alert" className="pt-1 text-small text-error">
            Couldn&apos;t start a chat: {failure}
          </p>
        ) : null}
      </div>
      {chats.error !== undefined ? (
        <p className="mobile-note text-error">
          Couldn&apos;t load the chats: {chats.error.message}
        </p>
      ) : chats.chats === undefined ? (
        <p className="mobile-note">Loading chats…</p>
      ) : rows.length === 0 ? (
        <p className="mobile-note">No open chats in this project.</p>
      ) : (
        <ul aria-label="Chats in this project">
          {rows.map(({ chat, status, unread }) => (
            <li key={chat.id}>
              <ChatRow chat={chat} status={status} unread={unread} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
