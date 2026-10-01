import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { defineNativeToolInputSchema, type NativeTool } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import {
  defaultHandoffsDir,
  findSecrets,
  handoffPath,
  renderHandoff,
  type HandoffInput,
  type HandoffLineage,
} from './handoff';

const log = createLogger('orchestrator.handoff');

export interface HandoffContext {
  codebaseId: string;
  /** The chat being handed off — marked done once the successor exists. */
  conversationId: string;
  repo: string;
  branch: string;
  worktree: string;
  /** Where docs live. Defaults to ~/handoffs. */
  handoffsDir?: string;
  /**
   * Opens the successor and seeds it. Returns its platform id.
   *
   * Takes the document path as well as the trigger because the seed row is
   * where lineage lives: the successor has to be able to name what it replaced
   * for `undo_handoff` to have anything to go back to.
   */
  relay: (trigger: string, document: string) => Promise<string>;
  /**
   * Marks the current chat done. Reversible in one click, which is why the
   * handoff can fire without asking.
   */
  markDone: () => Promise<void>;
}

const INPUT_SCHEMA = defineNativeToolInputSchema({
  properties: {
    topic: {
      kind: 'string',
      description:
        'kebab-case slug naming the WORK, not the session — `context-bar`, not `tuesday`. Becomes the filename.',
    },
    tldr: { kind: 'string', description: 'One line: the goal, and where it actually got to.' },
    decisions: {
      kind: 'string',
      description:
        'Decisions that are locked, one per line, each with its reason. The reason is the part that stops a successor relitigating it.',
    },
    failed: {
      kind: 'string',
      description:
        'Approaches tried and abandoned, one per line, each with the evidence that killed it. Leave empty only if genuinely nothing was abandoned — this is the section that stops a successor re-walking dead ends.',
    },
    completed: { kind: 'string', description: 'What actually landed, one per line.' },
    remaining: { kind: 'string', description: 'What is left, one per line. Becomes checkboxes.' },
    issues: { kind: 'string', description: 'Known issues and traps, one per line.' },
    filesModified: { kind: 'string', description: 'Principal files touched, one per line.' },
    evidenceCommand: {
      kind: 'string',
      description:
        'The cheapest command a successor can run to prove this document is not stale — a test run, a build.',
    },
    evidenceExpectation: {
      kind: 'string',
      description: 'What that command should report, in a few words. e.g. "796 passing".',
    },
  },
  required: ['topic', 'tldr', 'evidenceCommand', 'evidenceExpectation'],
});

function lines(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split('\n')
    .map(s => s.replace(/^\s*[-*]\s*/, '').trim())
    .filter(s => s !== '');
}

/**
 * Moves a conversation into a fresh one, carrying a document instead of a
 * context.
 *
 * A tool rather than a script because the half that matters is a judgement:
 * only the session that did the work knows which decisions were locked and
 * which approaches died. The mechanics — the path, the collision guard, the
 * secret scan, opening the successor, archiving this chat — are the same every
 * time, so they live here and cannot be forgotten under pressure.
 *
 * The successor is seeded with a PATH, not the prose. That costs forty tokens
 * instead of several thousand, and it makes the successor read and verify the
 * document rather than skim text it was handed — which is the difference
 * between resuming and guessing.
 *
 * Archiving is a soft delete. That is what makes this safe to do automatically
 * later: nothing is destroyed, and the chat can be brought back.
 */
export function buildHandoffTool(ctx: HandoffContext): NativeTool {
  return {
    name: 'handoff',
    description:
      'Write a handoff document for this chat and continue the work in a fresh one. Use when the context is getting full, when the user asks to hand off or wrap up, or before starting something unrelated. Marks this chat done (reversible) and opens a successor seeded with the document.',
    inputSchema: INPUT_SCHEMA,
    handler: async (input): Promise<string> => {
      const i: Record<string, unknown> = input;
      const topic = typeof i.topic === 'string' ? i.topic.trim() : '';
      if (topic === '') return 'handoff needs a topic slug naming the work.';

      const dir = ctx.handoffsDir ?? defaultHandoffsDir();
      mkdirSync(dir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const path = handoffPath(dir, date, topic, p => existsSync(p));

      const doc: HandoffInput = {
        topic,
        repo: ctx.repo,
        branch: ctx.branch,
        worktree: ctx.worktree,
        tldr: typeof i.tldr === 'string' ? i.tldr : '',
        decisions: lines(i.decisions),
        failed: lines(i.failed),
        completed: lines(i.completed),
        remaining: lines(i.remaining),
        issues: lines(i.issues),
        filesModified: lines(i.filesModified),
        evidenceCommand: typeof i.evidenceCommand === 'string' ? i.evidenceCommand : '',
        evidenceExpectation: typeof i.evidenceExpectation === 'string' ? i.evidenceExpectation : '',
        path,
        generated: date,
      };

      const rendered = renderHandoff(doc);

      // Refuse rather than redact. A document quietly altered after the fact is
      // one nobody can trust, and the fix — name the secret instead of quoting
      // it — belongs in the composition, not here.
      const leaks = findSecrets(rendered);
      if (leaks.length > 0) {
        return `Refused: line ${String(leaks[0]?.line)} looks like it carries a secret. Reference it by NAME and call handoff again.`;
      }

      writeFileSync(path, rendered, 'utf-8');

      try {
        const successor = await ctx.relay(
          `Continue: ${path}\n\nThis is a handoff relay. Follow the CONTINUE FROM HERE block at the top of that document.\n\nThis chat replaced an earlier one, which is now marked done. If that was wrong, say "undo the handoff" — the old chat is reopened and this one is marked done in its place, with its work intact.`,
          path
        );
        log.info({ path, successor, from: ctx.conversationId }, 'handoff.relayed');
      } catch (error) {
        // The document is already on disk and is the whole value; a failed
        // relay must not take it down with it. Say so and leave this chat open.
        log.warn({ err: error as Error, path }, 'handoff.relay_failed');
        return `Document written to ${path}, but opening the successor failed — this chat is still open. Start a new one and send: Continue: ${path}`;
      }

      try {
        await ctx.markDone();
      } catch (error) {
        log.warn({ err: error as Error }, 'handoff.mark_done_failed');
        return `Handed off to a new chat (document: ${path}). This chat could not be marked done — mark it done by hand.`;
      }

      return `Handed off. Document: ${path}. Continue in the new chat; this one is marked done and is listed under the Done filter.`;
    },
  };
}

export interface UndoHandoffContext {
  /** Where this chat came from, or null when it was not opened by a handoff. */
  lineage: () => Promise<HandoffLineage | null>;
  /** Reopens the predecessor, clearing the completion the handoff set. */
  reopen: (conversationId: string) => Promise<void>;
  /** Marks THIS chat done, putting it where the predecessor was. */
  markSelfDone: () => Promise<void>;
}

/**
 * Reverses a handoff: the previous chat is reopened and this one takes its
 * place as the finished half.
 *
 * This is what pays for handing off without asking. The locked decision was an
 * undo INSTEAD of a confirm dialog — a confirm taxes every handoff to catch the
 * rare bad one, while an undo costs nothing until it is needed. An automatic
 * handoff that cannot be reversed is an unconfirmed action with no way back,
 * which is the one shape the decision ruled out.
 *
 * It never expires. The case the whole feature serves is the unattended one:
 * the chat fills at 3am and hands itself off to an empty room, and an undo on a
 * timer has expired by the time anybody reads it.
 *
 * Nothing is destroyed. Done is a reversible flag in both directions, so the
 * successor keeps whatever it did overnight and can be reopened the same way
 * the predecessor just was.
 */
export function buildUndoHandoffTool(ctx: UndoHandoffContext): NativeTool {
  return {
    name: 'undo_handoff',
    description:
      'Reverse the handoff that opened this chat: reopen the chat it replaced and mark this one done. Use when the user says the handoff was wrong or asks to undo it, or to go back to the previous chat. Only works in a chat a handoff created. Nothing is destroyed — this chat keeps its work and is listed under the Done filter.',
    inputSchema: defineNativeToolInputSchema({ properties: {}, required: [] }),
    handler: async (): Promise<string> => {
      const lineage = await ctx.lineage();
      if (lineage === null) {
        return 'This chat was not opened by a handoff, so there is no earlier chat to go back to.';
      }

      // The predecessor is reopened FIRST and this chat marked done only once
      // that succeeded. The other order can leave the user with both chats out
      // of the open list — one finished by the handoff and one by the undo
      // meant to reverse it.
      await ctx.reopen(lineage.from);

      try {
        await ctx.markSelfDone();
      } catch (error) {
        log.warn({ err: error as Error, from: lineage.from }, 'handoff.undo_mark_self_done_failed');
        return `The previous chat is open again, but this one could not be marked done — mark it done by hand so the work is not split across two chats. Document: ${lineage.document}`;
      }

      log.info({ from: lineage.from }, 'handoff.undone');
      return `Undone. The previous chat is open again and this one is marked done in its place; its work is intact and is listed under the Done filter. The handoff document is still at ${lineage.document}.`;
    },
  };
}
