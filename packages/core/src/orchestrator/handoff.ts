/**
 * Writing a chat's handoff: the document, its path, and the check that stops a
 * secret leaving with it.
 *
 * Pure on purpose, and separate from the tool that calls it. What is worth
 * testing here has nothing to do with conversations or the filesystem — it is
 * that the document is COMPLETE, that a second handoff on the same day does
 * not overwrite the first, and that a token in the prose stops the write.
 *
 * The agent supplies the prose, because only the session that lived the work
 * knows which decisions were locked and which approaches were abandoned. This
 * file supplies the shape, so a section can never be dropped for being empty —
 * a missing "What We Tried That Failed" reads as "nobody asked", and the next
 * session re-walks dead ends this one already ruled out.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** What the agent must say. Empty strings are allowed; missing sections are not. */
export interface HandoffInput {
  /** kebab-case, names the work rather than the session. */
  topic: string;
  repo: string;
  branch: string;
  worktree: string;
  /** One line: the goal and where it got to. */
  tldr: string;
  decisions: readonly string[];
  failed: readonly string[];
  completed: readonly string[];
  remaining: readonly string[];
  issues: readonly string[];
  filesModified: readonly string[];
  /** The command a successor can run to prove this doc is not stale. */
  evidenceCommand: string;
  /** Its expected result, in a few words. */
  evidenceExpectation: string;
  /** Where this doc will live, so it can reference itself. */
  path: string;
  /** Predecessor in the same stream, when there is one. */
  chain?: { n: number; previous: string };
  generated: string;
}

/**
 * Render the document.
 *
 * `Status:` is line 1 and is load-bearing: a later session flips it to `done`,
 * and that flip is the only thing stopping a future session re-running
 * finished work. It is first so a resuming session can read one line and stop.
 */
export function renderHandoff(input: HandoffInput): string {
  const chain =
    input.chain === undefined
      ? ''
      : `Chain: #${String(input.chain.n)} — previous: ${input.chain.previous}\n`;

  return `Status: active | Branch: ${input.branch} | Generated: ${input.generated}
${chain}
# CONTINUE FROM HERE

You are a fresh Archon chat. This document is the whole handoff — you should
not need the conversation it came from.

1. **Freshness check first.** If Status above is \`done\` or \`stale\`, STOP and
   say so rather than redoing the work. Confirm the branch still reads
   \`${input.branch}\`; if it does not, stop and report — you are on a wrong
   baseline.
2. Read this entire document top-down.
3. **Evidence check.** Before trusting anything load-bearing here, prove the
   cheapest claim yourself: \`${input.evidenceCommand}\` should report
   ${input.evidenceExpectation}. If it does not, reconcile BEFORE doing any
   work — this doc may be stale even with a fresh date.
4. Summarize in three bullets what you are about to do.
5. Wait for a "go" before touching files.
6. **When the Remaining Tasks are done, edit line 1 of this file** and set
   Status to \`done\` (or \`stale\` if it was superseded). That flip is what
   stops a future session re-running finished work.

---

# Handoff: ${input.repo} — ${input.topic}

Generated: ${input.generated}
Branch: ${input.branch}
Worktree: ${input.worktree}
Document: ${input.path}

## TLDR

${input.tldr.trim() === '' ? 'None.' : input.tldr.trim()}

## Locked Decisions

${bullets(input.decisions)}

## What We Tried That Failed

${bullets(input.failed)}

## Work Completed

${bullets(input.completed)}

## Remaining Tasks

${checkboxes(input.remaining)}

## Known Issues

${bullets(input.issues)}

## Files Modified

${bullets(input.filesModified)}
`;
}

function bullets(items: readonly string[]): string {
  const kept = items.map(s => s.trim()).filter(s => s !== '');
  if (kept.length === 0) return 'None.';
  return kept.map(s => `- ${s}`).join('\n');
}

function checkboxes(items: readonly string[]): string {
  const kept = items.map(s => s.trim()).filter(s => s !== '');
  if (kept.length === 0) return 'None.';
  return kept.map(s => `- [ ] ${s}`).join('\n');
}

/**
 * Where handoff documents are written when the tool is given no directory —
 * and so the only place the server will read one back from (#351). One owner,
 * because a reader that guessed its own copy of this path would refuse every
 * document the writer moved.
 */
export function defaultHandoffsDir(): string {
  return join(homedir(), 'handoffs');
}

/**
 * Where today's handoff goes, given what is already there.
 *
 * Appends `-2`, `-3`, … rather than overwriting. Two handoffs on one day for
 * one topic is a normal morning; silently replacing the earlier one loses the
 * half of the story that explains the second.
 */
export function handoffPath(
  dir: string,
  date: string,
  slug: string,
  exists: (path: string) => boolean
): string {
  const base = `${dir}/${date}_${slug}`;
  if (!exists(`${base}.md`)) return `${base}.md`;
  let n = 2;
  while (exists(`${base}-${String(n)}.md`)) n += 1;
  return `${base}-${String(n)}.md`;
}

/**
 * Token-shaped strings that must never reach a plaintext file.
 *
 * A backstop, not the mechanism: the rule is that secrets are referenced by
 * NAME when the document is composed. This catches the composition that
 * forgot, and it REFUSES the write rather than redacting — a doc silently
 * altered after the fact is a doc nobody can trust, and the fix (say
 * `GH_TOKEN` instead of its value) belongs upstream of here.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /xox[bpars]-[A-Za-z0-9-]{10,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
];

/** The lines that look like they carry a secret. Empty means clean. */
export function findSecrets(document: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  document.split('\n').forEach((text, i) => {
    if (SECRET_PATTERNS.some(p => p.test(text))) found.push({ line: i + 1, text });
  });
  return found;
}

/**
 * Where a relayed chat came from, carried on the message that seeded it.
 *
 * A conversation-level fact kept on a message because there is nowhere else to
 * put it: `remote_agent_conversations` has no parent column, and the successor
 * has to be able to name its predecessor to undo the handoff. The seed row's
 * metadata is already a JSON column, so this needs no schema change and no
 * second writer to keep in agreement.
 */
export interface HandoffLineage {
  /** DB id — not the platform id — of the chat this one replaced. */
  from: string;
  /** The document the handoff wrote, so the undo can name it. */
  document: string;
}

/** The metadata key the seed row carries. One name, read and written here. */
const LINEAGE_KEY = 'handoff';

/** The metadata a relay attaches to the message it seeds a successor with. */
export function lineageMetadata(lineage: HandoffLineage): Record<string, unknown> {
  return { [LINEAGE_KEY]: lineage };
}

/**
 * The lineage on a stored message, or null when there is none to read.
 *
 * Total rather than throwing, and deliberately strict about both fields. The
 * caller's next move is to finish one chat and reopen another, so a partial
 * or malformed record must read as "no lineage" — acting on half of one would
 * close a chat with nothing reopened in its place.
 */
export function readLineage(metadata: string): HandoffLineage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw: unknown = (parsed as Record<string, unknown>)[LINEAGE_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const { from, document } = raw as Record<string, unknown>;
  if (typeof from !== 'string' || from === '') return null;
  if (typeof document !== 'string' || document === '') return null;
  return { from, document };
}
