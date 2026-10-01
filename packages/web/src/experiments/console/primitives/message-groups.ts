/**
 * Consecutive messages from one sender, under one label and one timestamp.
 *
 * The agent emits a separate message for each thing it says between tool
 * calls, so a single turn arrives as four or five rows that share a second.
 * Rendered individually they repeat the label, the timestamp and the frame
 * four times for four sentences, which is most of what made the transcript
 * feel bulky.
 *
 * A group is consecutive messages from one sender THAT SHARE A DISPLAYED
 * TIMESTAMP. The header states a time, so it should be true of everything
 * under it — grouping messages whose clocks differ would put four sentences
 * spanning a minute under a single misleading second.
 *
 * That is deliberately not an elapsed-time threshold. There is no interval to
 * choose and no behaviour that changes as a gap grows: two messages either
 * show the same clock or they do not. Seconds, because that is what the
 * transcript renders; comparing the formatted string instead would make
 * grouping depend on the 12/24-hour preference, which is a display choice and
 * must not reshape the conversation.
 */
import { splitReply } from '@archon/awaiting';
import type { Message, MessageRole } from './message';

export interface MessageGroup {
  /** The first message's id — stable across refetches, unlike an index. */
  key: string;
  role: MessageRole;
  /** When the group STARTED. The later messages' own times are not shown. */
  timestamp: string;
  messages: Message[];
}

/**
 * A message that renders as its own card rather than as prose, and so cannot
 * share a header with the messages around it.
 */
function standsAlone(message: Message): boolean {
  return message.category === 'workflow_result';
}

/**
 * The instant a header would show, to the second.
 *
 * Falls back to the raw string when the timestamp will not parse, so an
 * unexpected format groups by exact equality rather than collapsing every
 * unparseable message into one group.
 */
function displayedSecond(timestamp: string): string {
  const t = Date.parse(timestamp);
  return Number.isNaN(t) ? timestamp : String(Math.floor(t / 1000));
}

/** An agent message carrying an ask block, well-formed or not. */
function asks(message: Message): boolean {
  return (
    message.role === 'assistant' && splitReply(message.content).some(p => p.kind !== 'markdown')
  );
}

/**
 * The agent's messages with every question moved to the end of its reply (#336).
 *
 * The `ask` tool's card is persisted as its own row the moment the tool is
 * called, and the agent cannot write its picture first: text before a tool call
 * folds away as a progress note, images and all. So in arrival order the
 * question always sat ABOVE the final text and the picture that explains it.
 * A question is what the reply ends on, so it renders last.
 *
 * A reply here is a run of consecutive agent messages; anything else — you, the
 * system, a workflow card — ends it, so a question never moves past one.
 */
function askLast(messages: readonly Message[]): Message[] {
  const ordered: Message[] = [];
  let held: Message[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && !standsAlone(message)) {
      if (asks(message)) held.push(message);
      else ordered.push(message);
      continue;
    }
    ordered.push(...held, message);
    held = [];
  }
  ordered.push(...held);
  return ordered;
}

export function groupMessages(messages: readonly Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const message of askLast(messages)) {
    const last = groups[groups.length - 1];
    const previous = last?.messages[last.messages.length - 1];
    const joinable =
      last?.role === message.role &&
      // A question moved to the end of its reply belongs under that reply's
      // header even though its own clock is earlier.
      (displayedSecond(last.timestamp) === displayedSecond(message.timestamp) || asks(message)) &&
      !standsAlone(message) &&
      // A card ends a group as surely as it cannot start one, so the next
      // prose message opens a fresh header rather than continuing the card's.
      previous !== undefined &&
      !standsAlone(previous);
    if (joinable) {
      last.messages.push(message);
      continue;
    }
    groups.push({
      key: message.id,
      role: message.role,
      timestamp: message.timestamp,
      messages: [message],
    });
  }
  return groups;
}

/**
 * Ids of the messages in an agent group that are progress notes rather than
 * the reply.
 *
 * The agent writes a line before its tool calls ("issue filed, now updating
 * the rule") and then its answer after them. Both are rows in one group, and
 * each opens with its own headline, so rendered at full size one reply reads
 * as two (#125). Every text piece but the last is therefore a note; the last
 * is the answer.
 *
 * A piece carrying an ask block is never a note, and never the answer either:
 * folding it would hide a question waiting for an answer, and since questions
 * render last (see {@link askLast}) counting one as the answer would fold the
 * real answer above it. Empty rows (tool calls only) render nothing either way
 * and do not count as the last piece.
 */
export function progressNoteIds(group: MessageGroup): Set<string> {
  const notes = new Set<string>();
  if (group.role !== 'assistant') return notes;
  const texts = group.messages.filter(m => m.content.trim().length > 0 && !asks(m));
  for (const m of texts.slice(0, -1)) notes.add(m.id);
  return notes;
}
