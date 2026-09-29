import type { ReactElement } from 'react';
import { useConversationCheckout } from '../hooks/useConversationCheckout';
import { formatCost, shortModel, turnFacts } from '../primitives/context-window';
import type { Message } from '../primitives/message';
import type { ConversationCheckout } from '../skills';
import { ContextBar } from './ContextBar';
import { ChatModelPicker } from './ChatModelPicker';

const LOCATION_LABEL = { live: 'live checkout', worktree: 'worktree' } as const;

/**
 * Everything the status line says about the chat beyond what it is doing:
 * how full it is, the model and effort the last turn ran on, which branch and
 * folder the agent is editing, whether uncommitted work not already on the
 * base branch is sitting there, and what the chat has cost.
 *
 * Every segment is a value the server reported, and a missing value hides its
 * segment rather than standing in for it. A Codex turn reports no cost, so no
 * cost shows — `$0.00` would read as free. A turn left on the provider's
 * default effort names none, so none shows. A checkout git could not read has
 * no branch and no dirty marker, because a clean tree is a claim.
 *
 * The marker counts only changes the base branch does not already hold. A
 * shared checkout nearly always carries leftover copies of merged work, and a
 * marker that is always lit is one nobody reads.
 */
export function StatusDetails({
  conversationId,
  messages,
  turnKey,
}: {
  conversationId: string | null;
  messages: readonly Message[];
  /** Changes when a turn starts or ends; re-reads the checkout. */
  turnKey: string;
}): ReactElement {
  const facts = turnFacts(messages);
  const checkout = useConversationCheckout(conversationId, turnKey);
  return (
    <StatusDetailsView
      messages={messages}
      facts={facts}
      checkout={checkout}
      conversationId={conversationId}
    />
  );
}

/** The rendering half, split out so it can be rendered with fixed inputs. */
export function StatusDetailsView({
  messages,
  facts,
  checkout,
  conversationId = null,
}: {
  messages: readonly Message[];
  facts: ReturnType<typeof turnFacts>;
  checkout: ConversationCheckout | undefined;
  /** When set, model and effort render as the chat's picker (#132). */
  conversationId?: string | null;
}): ReactElement {
  const where = checkout === undefined ? null : checkoutLabel(checkout);
  const model = facts?.model ?? null;
  const effort = facts?.effort ?? null;
  const cost = facts?.costUsd ?? null;
  const offBase = checkout === undefined ? null : offBaseMark(checkout);
  return (
    <span className="flex min-w-0 items-center gap-3 text-mini text-text-tertiary">
      <ContextBar messages={messages} />
      {conversationId !== null ? (
        // The same two facts as below, as a control: clicking them changes
        // what this chat's NEXT turn runs on.
        <ChatModelPicker conversationId={conversationId} last={{ model, effort }} />
      ) : (
        <>
          {model === null ? null : (
            <span title={model} className="truncate">
              {shortModel(model)}
            </span>
          )}
          {effort === null ? null : (
            <span title="Reasoning effort the last turn ran with">effort {effort}</span>
          )}
        </>
      )}
      {where === null ? null : (
        <span title={checkout?.path ?? undefined} className="truncate">
          {where}
        </span>
      )}
      {offBase === null ? null : (
        <span title={offBase.title} style={{ color: 'var(--warning-mark)' }}>
          {offBase.label}
        </span>
      )}
      {cost === null ? null : (
        <span title="What this chat has cost so far">{formatCost(cost)}</span>
      )}
    </span>
  );
}

/**
 * `● 3 not on dev` when the checkout holds work no copy of the base branch
 * has; nothing when it holds none, or when that could not be compared.
 */
export function offBaseMark(
  checkout: ConversationCheckout
): { label: string; title: string } | null {
  const count = checkout.offBaseFiles;
  if (count === null || count === 0) return null;
  const base = checkout.baseBranch ?? 'the base branch';
  const files = count === 1 ? '1 changed file' : `${String(count)} changed files`;
  return {
    label: `● ${String(count)} not on ${base}`,
    title: `${files} in the folder the agent edits ${count === 1 ? 'is' : 'are'} not on ${base} — resetting the folder would lose ${count === 1 ? 'it' : 'them'}`,
  };
}

/**
 * `⎇ dev · live checkout`, `⎇ feat/x · worktree`. Either half alone when only
 * one is known; nothing when neither is.
 */
export function checkoutLabel(checkout: ConversationCheckout): string | null {
  const parts = [
    checkout.branch === null ? null : `⎇ ${checkout.branch}`,
    checkout.location === null ? null : LOCATION_LABEL[checkout.location],
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}
