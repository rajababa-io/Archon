/**
 * Pure helpers for the in-chat model picker (#132).
 *
 * Every value the picker offers comes from the server: the models and effort
 * rungs from the provider registry (GET /api/providers), the current choice
 * from the chat itself (GET /api/conversations/:id/model). Nothing here names
 * a model.
 */
import type { ChatModel, ProviderInfo } from '../skills';
import { shortModel } from '../primitives/context-window';
import { curatedOptionsForAgent, type ModelOption } from './model-options';

/** What the last turn ran on, as the status line reports it; nulls when unknown. */
export interface LastTurn {
  model: string | null;
  effort: string | null;
}

function describe(model: string | null, effort: string | null): string {
  const name = model === null ? 'model' : shortModel(model);
  return effort === null ? name : `${name} · effort ${effort}`;
}

/**
 * The words on the picker's button.
 *
 * Normally what the LAST turn ran on — the status line's model and effort,
 * which is what it has always shown, and whose window the context figure
 * beside it belongs to. When the chat has pinned something the next turn will
 * use instead, both are shown with an arrow: the rest of the line still
 * describes the last turn, so hiding either half would make one of them a lie
 * until the next reply lands.
 */
export function pickerLabel(chat: ChatModel | undefined, last: LastTurn): string {
  const pin = chat?.pin ?? null;
  const lastLabel =
    last.model === null
      ? describe(chat?.model ?? null, last.effort)
      : describe(last.model, last.effort);
  if (chat === undefined || pin === null) return lastLabel;
  const next = describe(chat.model, chat.effort);
  if (last.model === null) return next;
  const modelMatches = chat.model === null || sameModel(last.model, chat.model);
  const effortMatches = chat.effort === last.effort;
  return modelMatches && effortMatches ? lastLabel : `${lastLabel} → ${next}`;
}

/**
 * Whether the model that answered is the one that was asked for.
 *
 * Providers report the concrete id (`claude-opus-4-7-20260101`) for a keyword
 * request (`opus`), so equality alone would draw an arrow from a model to
 * itself.
 */
export function sameModel(answered: string, requested: string): boolean {
  const a = answered.toLowerCase();
  const r = requested.toLowerCase();
  return a === r || a.includes(r);
}

/** The models the picker lists for this chat's provider, from the registry. */
export function modelChoices(
  chat: ChatModel | undefined,
  providers: readonly Pick<ProviderInfo, 'id' | 'suggestedModels'>[] | undefined
): ModelOption[] {
  if (chat === undefined) return [];
  return curatedOptionsForAgent(chat.provider, providers);
}

/** The effort rungs this chat's provider accepts, or none when it has no control. */
export function effortChoices(
  chat: ChatModel | undefined,
  providers: readonly Pick<ProviderInfo, 'id' | 'effortLevels'>[] | undefined
): readonly NonNullable<ChatModel['effort']>[] {
  if (chat === undefined) return [];
  return providers?.find(p => p.id === chat.provider)?.effortLevels ?? [];
}
