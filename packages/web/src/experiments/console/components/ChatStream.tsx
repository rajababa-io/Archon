import { Fragment, type ReactElement } from 'react';
import { ChatGroup } from './ChatGroup';
import { ConsoleWorkflowResultCard } from './ConsoleWorkflowResultCard';
import { groupMessages } from '../primitives/message-groups';
import { isSystemCategory, type Message } from '../primitives/message';

interface ChatStreamProps {
  messages: Message[];
  /** Send an answer to an ask block. Omitted where the stream is read-only. */
  onAnswer?: (text: string, files?: File[]) => void;
}

/**
 * Message-only stream for the chat view. A pure chat has no RunEvent[] to merge
 * (unlike RunStream); consecutive messages from one sender render as a group.
 *
 * Tool calls and framework chatter never render here. They belong to the turn,
 * not to the conversation, so ChatStatusStrip lists them under its own
 * disclosure instead — one place that answers "what is it doing", rather than a
 * switch that turns the whole transcript into a log. The full per-tool cards,
 * inputs and outputs included, remain on the run detail page.
 *
 * Wrap in <StreamContextProvider> upstream (ChatPage) so StreamCard timestamps
 * resolve — pass runStartedAt: null for wall-clock display.
 */
export function ChatStream({ messages, onAnswer }: ChatStreamProps): ReactElement {
  // `workflow_result` messages are normally swept up by `isSystemCategory` (the
  // `workflow_` prefix), but they carry the run summary + a completion card — let
  // them through explicitly. Other `workflow_*` narration stays suppressed.
  const visible = messages.filter(
    m =>
      m.category === 'workflow_result' ||
      (!isSystemCategory(m.category) && (m.content.trim().length > 0 || m.thinking !== null))
  );

  // Grouped AFTER filtering: hidden chatter between two agent messages must not
  // break them into separate groups, since it never appears on screen.
  return (
    <div className="flex flex-col gap-[var(--group-gap)]">
      {groupMessages(visible).map(group => {
        const first = group.messages[0];
        return (
          <Fragment key={group.key}>
            {first?.category === 'workflow_result' && first.workflowResult !== null ? (
              <ConsoleWorkflowResultCard
                runId={first.workflowResult.runId}
                workflowName={first.workflowResult.workflowName}
                summary={first.content}
              />
            ) : (
              <ChatGroup group={group} onAnswer={onAnswer} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
