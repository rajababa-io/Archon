import { useRef, useState } from 'react';
import * as skill from '../skills';
import type { ChatModel, SetChatModelBody } from '../skills';
import { set, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { errorDetail } from '../lib/http';
import { effortChoices, modelChoices } from '../lib/chat-model';
import type { ModelOption } from '../lib/model-options';

export interface ChatModelPin {
  /** The chat's provider and what its next turn runs on; undefined until read. */
  chat: ChatModel | undefined;
  models: ModelOption[];
  efforts: readonly NonNullable<ChatModel['effort']>[];
  pinnedModel: string | null;
  pinnedEffort: SetChatModelBody['effort'];
  providerName: string | undefined;
  saving: boolean;
  /** The server's refusal of the last save, shown as it said it. */
  error: string | null;
  clearError: () => void;
  /** Pin a model and effort on this chat, from its next turn; null follows the default. */
  save: (body: Omit<SetChatModelBody, 'provider'>) => Promise<boolean>;
}

/**
 * One chat's model pin (#132): what the provider registry offers for it, what
 * is pinned, and the save — the state behind both the desktop context bar's
 * picker and the mobile model sheet.
 */
export function useChatModelPin(conversationId: string): ChatModelPin {
  const { data: chat } = useEntity(K.chatModel(conversationId), () =>
    skill.getChatModel(conversationId)
  );
  const { data: providers } = useEntity(K.providers, skill.listProviders);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  const save = async (body: Omit<SetChatModelBody, 'provider'>): Promise<boolean> => {
    if (chat === undefined || inFlight.current) return false;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const next: ChatModel = await skill.setChatModel(conversationId, {
        provider: chat.provider,
        ...body,
      });
      set(K.chatModel(conversationId), next);
      return true;
    } catch (e: unknown) {
      setError(errorDetail(e));
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const pin = chat?.pin ?? null;
  return {
    chat,
    models: modelChoices(chat, providers),
    efforts: effortChoices(chat, providers),
    pinnedModel: pin?.model ?? null,
    pinnedEffort: pin?.effort ?? null,
    providerName: providers?.find(p => p.id === chat?.provider)?.displayName,
    saving,
    error,
    clearError: (): void => {
      setError(null);
    },
    save,
  };
}
