/**
 * Answering an ask block. What an ask block IS — its types and the parser —
 * lives in `@archon/awaiting`, shared with the server.
 *
 * Answering is just sending a message. The chat is a conversation, so a click
 * composes the same text a person would have typed and sends it; the agent
 * needs no new channel and no new state. That is also why a whole set of
 * questions is answered in one submission: the answers do not exist anywhere
 * until they are sent, so paging back and changing one costs nothing.
 */
import type { AskOption, AskQuestion } from '@archon/awaiting';

/**
 * What one question has been answered with: the chosen option labels, or a
 * single free-text answer. An array even for a single-answer question so the
 * two kinds share one shape.
 */
export type Answer = string[] | null;

/**
 * Compose the message an answered set sends back.
 *
 * Written as the person would have typed it, because that is exactly what it
 * is — the agent reads a normal chat message and needs no parser. Numbered to
 * match the order asked, so a set answered out of order still reads in order.
 */
export function composeAnswer(questions: AskQuestion[], answers: Answer[]): string {
  return questions
    .map((q, i) => {
      const chosen = answers[i] ?? [];
      // Several choices are written one per line rather than joined with commas,
      // so an option whose own text contains a comma stays unambiguous.
      const body = chosen.length === 0 ? '(skipped)' : chosen.map(c => c.trim()).join('\n   ');
      return `${String(i + 1)}. ${q.title}\n   ${body}`;
    })
    .join('\n');
}

/** The message a card sends: the composed text, and the files that ride it. */
export interface AnswerSubmission {
  text: string;
  /**
   * Absent rather than empty when nothing is attached, so an unattached answer
   * is byte-for-byte the send an answer without the attach affordance would
   * have made.
   */
  files?: File[];
}

/**
 * The whole payload of one submission.
 *
 * Attachments belong to the ANSWER, never to the ask block — nothing here is
 * readable from the fence, and the question spec is unchanged by the fact that
 * a reply carried a screenshot. They ride the single message the card composes
 * for the whole set, which is why they are held once per card rather than once
 * per question.
 */
export function composeSubmission(
  questions: AskQuestion[],
  answers: Answer[],
  files: File[]
): AnswerSubmission {
  const text = composeAnswer(questions, answers);
  return files.length > 0 ? { text, files: [...files] } : { text };
}

/** Whether every question has an answer — what gates submission. */
export function isComplete(questions: AskQuestion[], answers: Answer[]): boolean {
  return questions.every((_, i) => {
    const a = answers[i];
    return a?.some(v => v.trim().length > 0) ?? false;
  });
}

/**
 * Toggle or replace a choice.
 *
 * A single-answer question replaces what was there; a multi-answer question
 * adds the choice, or removes it if it was already chosen — so the same click
 * that selects is the one that deselects, and there is no separate way to undo.
 */
export function toggleChoice(current: Answer, value: string, multi: boolean): string[] {
  if (!multi) return [value];
  const chosen = current ?? [];
  return chosen.includes(value) ? chosen.filter(v => v !== value) : [...chosen, value];
}

/**
 * Set the free-text answer, replacing any previous one.
 *
 * Deliberately not {@link toggleChoice}: editing free text is a correction, not
 * an additional choice. Toggling would have left the old text alongside the new
 * on a multi-answer question — and since the card shows the first non-option
 * value, it would still have displayed the old one while submitting both.
 *
 * On a single-answer question the custom text is the whole answer. On a
 * multi-answer one it sits alongside the chosen options, which keep their
 * order.
 */
export function setCustomAnswer(
  current: Answer,
  value: string,
  options: AskOption[],
  multi: boolean
): string[] {
  if (!multi) return [value];
  const kept = (current ?? []).filter(v => options.some(o => o.label === v));
  return value.length > 0 ? [...kept, value] : kept;
}
