import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import type { Share, ShareAccess } from '../db/shares';
import { normalizeSharePath, targetAddress, type ShareTarget } from '../services/shares';

const log = createLogger('orchestrator.share_page');

export interface ShareToolContext {
  /** What sharing the normalized path shares, or null when nothing is published there. */
  target: (path: string) => Promise<ShareTarget | null>;
  /** Set the path's access, issuing its code the first time. */
  set: (path: string, access: ShareAccess) => Promise<Share>;
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    path: {
      kind: 'string',
      description:
        'The published file or folder, as its private address: a full https URL, "/files/<project>/<topic>/…", or the path after /files/. A web page (.html) is shared together with the folder it sits in, so its pictures and scripts load; any other file is shared alone.',
    },
    access: {
      kind: 'enum',
      values: ['link', 'restricted'],
      description:
        '"link" (default) makes it open for anyone with the address. "restricted" turns the share address off; the same address comes back if it is shared again.',
    },
  },
  required: ['path'],
});

/** Prefix of a successful answer — the description quotes it so the agent can tell success from failure. */
export const SHARED = 'share_page: SHARED';
export const UNSHARED = 'share_page: RESTRICTED';

/**
 * Lets a chat hand a person outside this install a link to something it
 * published (#345), the way a claude.ai artifact is shared.
 *
 * Everything an agent publishes under `/files/` stays behind the deployment's
 * login; a share is the deliberate act of letting one page or file past it.
 * The tool is the only way an agent can do that, so it validates the path
 * itself — the agent's string is never joined onto the root unchecked — and
 * refuses to share anything that is not already published.
 *
 * The address it returns is site-relative because the server cannot know which
 * of its addresses the reader will use; the agent already writes this
 * install's public host for every `/files/` link, and uses the same one here.
 */
export function buildShareTool(ctx: ShareToolContext): NativeTool {
  return {
    name: 'share_page',
    description: `Share a page or file you published under /files/ so anyone with the link can open it without this install's login — like sharing a claude.ai artifact. Use it only when the human asks for something to be shared with someone outside, or agrees to it; it makes the content public to whoever holds the link. On success the answer starts "${SHARED}" and names the address (/share/<code>/); give the reader the full URL on the same public host as your /files/ links. Re-sharing the same path keeps the same address, and updating the files behind it updates what the link shows. Pass access "restricted" to turn a share off ("${UNSHARED}").`,
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      // Absent means link; anything else that is not one of the two values is
      // refused. Reading a typo as either value would guess which way to move a
      // permission, and guessing "link" would publish.
      if (input.access !== undefined && input.access !== 'link' && input.access !== 'restricted') {
        return 'share_page error: `access` must be "link" or "restricted".';
      }
      const access: ShareAccess = input.access === 'restricted' ? 'restricted' : 'link';
      if (typeof input.path !== 'string') return 'share_page error: `path` must be a string.';
      const normalized = normalizeSharePath(input.path);
      if (!normalized.ok) return `share_page error: ${normalized.reason}`;
      try {
        const target = await ctx.target(normalized.path);
        if (target === null && access === 'link') {
          return `share_page error: nothing is published at /files/${normalized.path} — publish it first.`;
        }
        // Turning a share off still works once its files are gone.
        const resolved = target ?? { path: normalized.path, kind: 'file' as const, page: '' };
        const share = await ctx.set(resolved.path, access);
        const address = targetAddress(share.code, resolved);
        log.info({ code: share.code, path: share.path, access }, 'share_page.set');
        return access === 'link'
          ? `${SHARED} — /files/${share.path} is open to anyone with ${address}`
          : `${UNSHARED} — ${address} no longer opens; /files/${share.path} is behind the login only.`;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: e, path: normalized.path }, 'share_page.failed');
        return `share_page error: ${msg}`;
      }
    },
  };
}
