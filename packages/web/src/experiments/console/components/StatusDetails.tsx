import type { ReactElement } from 'react';
import { useConversationCheckout } from '../hooks/useConversationCheckout';
import { formatCost, shortModel, turnFacts } from '../primitives/context-window';
import type { Message } from '../primitives/message';
import type { ConversationCheckout } from '../skills';
import { ContextBar } from './ContextBar';

const LOCATION_LABEL = { live: 'live checkout', worktree: 'worktree' } as const;

/**
 * Everything the status line says about the chat beyond what it is doing:
 * how full it is, the model and effort the last turn ran on, which branch and
 * folder the agent is editing, whether uncommitted work is sitting there, and
 * what the chat has cost.
 *
 * Every segment is a value the server reported, and a missing value hides its
 * segment rather than standing in for it. A Codex turn reports no cost, so no
 * cost shows — `$0.00` would read as free. A turn left on the provider's
 * default effort names none, so none shows. A checkout git could not read has
 * no branch and no dirty marker, because a clean tree is a claim.
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
  return <StatusDetailsView messages={messages} facts={facts} checkout={checkout} />;
}

/** The rendering half, split out so it can be rendered with fixed inputs. */
export function StatusDetailsView({
  messages,
  facts,
  checkout,
}: {
  messages: readonly Message[];
  facts: ReturnType<typeof turnFacts>;
  checkout: ConversationCheckout | undefined;
}): ReactElement {
  const where = checkout === undefined ? null : checkoutLabel(checkout);
  const model = facts?.model ?? null;
  const effort = facts?.effort ?? null;
  const cost = facts?.costUsd ?? null;
  return (
    <span className="flex min-w-0 items-center gap-3 text-mini text-text-tertiary">
      <ContextBar messages={messages} />
      {model === null ? null : (
        <span title={model} className="truncate">
          {shortModel(model)}
        </span>
      )}
      {effort === null ? null : (
        <span title="Reasoning effort the last turn ran with">effort {effort}</span>
      )}
      {where === null ? null : (
        <span title={checkout?.path ?? undefined} className="truncate">
          {where}
        </span>
      )}
      {checkout?.dirty === true ? (
        <span
          title="The folder the agent edits has uncommitted changes"
          style={{ color: 'var(--warning-mark)' }}
        >
          ● uncommitted
        </span>
      ) : null}
      {cost === null ? null : (
        <span title="What this chat has cost so far">{formatCost(cost)}</span>
      )}
    </span>
  );
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
