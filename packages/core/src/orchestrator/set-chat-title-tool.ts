import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator.set_chat_title');

/** The `title` column's width; the PATCH route caps to the same. */
const MAX_TITLE_LENGTH = 255;

export interface SetChatTitleContext {
  /** The conversation being renamed. Never another one. */
  conversationId: string;
  /** Write the title and pin it. */
  write: (title: string) => Promise<void>;
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    title: {
      kind: 'string',
      description:
        "The chat's new title. Lead with the issue numbers the chat works on, then a short name — e.g. `#96 Ask card: attach a file`.",
    },
  },
  required: ['title'],
});

/**
 * Lets a chat name itself (#393).
 *
 * The operator's rule is that a chat's title leads with the issue numbers it
 * works on. Before this tool a chat could file the issue but not act on the
 * rule: the only writers of the title were automatic titling and a person's
 * rename, so a chat that did everything else right still finished under its
 * auto-title and handed the rename to the human.
 *
 * The title is pinned, the same as a person's rename, because automatic
 * titling re-titles any unpinned chat and would undo it.
 */
export function buildSetChatTitleTool(ctx: SetChatTitleContext): NativeTool {
  return {
    name: 'set_chat_title',
    description:
      "Rename this chat and lock the name so automatic titling cannot replace it. Use it the moment the chat's work has an issue: the title leads with the issue numbers, then a short name (`#96 Ask card: attach a file`; 2–3 issues list every number; 4 or more give the first number plus the count, `#99 +3 Console polish`). Renames only this chat.",
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      if (title.length === 0) {
        return 'set_chat_title error: title is empty — nothing was written.';
      }
      const written = title.slice(0, MAX_TITLE_LENGTH);
      try {
        await ctx.write(written);
        log.info({ conversationId: ctx.conversationId }, 'set_chat_title.written');
        return `set_chat_title: this chat is now titled "${written}", locked against automatic titling.`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: e, conversationId: ctx.conversationId }, 'set_chat_title.failed');
        return `set_chat_title error: ${msg}`;
      }
    },
  };
}
