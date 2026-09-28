/**
 * The ask block the chat is waiting on, answered from chips above the keyboard.
 *
 * The chips are the ask card's controls in another shape: every step goes
 * through the card's own primitives (`toggleChoice`, `setCustomAnswer`,
 * `composeAnswer`), so an answer sent from a chip is byte-for-byte the message
 * the card would have sent.
 */
import {
  composeAnswer,
  isComplete,
  setCustomAnswer,
  splitReply,
  toggleChoice,
  type Answer,
  type AskQuestion,
  type AskSpec,
} from '../../primitives/ask';
import type { Message } from '../../primitives/message';

/**
 * The ask block in the agent's last word, or null when there is none.
 *
 * The same rule the rail's `awaiting` reads: answering is sending a message, so
 * once your reply is the newest message the question is no longer open. Rows
 * with no text — a turn's tool calls — are not a last word.
 */
export function openAsk(messages: readonly Message[]): AskSpec | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'user') return null;
    if (m.role !== 'assistant' || m.content.trim() === '') continue;
    const asks = splitReply(m.content).flatMap(p => (p.kind === 'ask' ? [p.spec] : []));
    return asks.at(-1) ?? null;
  }
  return null;
}

/** Where a chip answer stands: the question on show and every answer so far. */
export interface ChipState {
  index: number;
  answers: Answer[];
}

export function startChips(spec: AskSpec): ChipState {
  return { index: 0, answers: spec.questions.map(() => null) };
}

/** After a step: show the next question, or send the whole set. */
export type ChipStep = { kind: 'show'; state: ChipState } | { kind: 'send'; text: string };

export function currentQuestion(spec: AskSpec, state: ChipState): AskQuestion | undefined {
  return spec.questions[state.index];
}

const answered = (a: Answer | undefined): boolean => a?.some(v => v.trim() !== '') ?? false;

/**
 * The current question is answered: send once every one is, else show the
 * next unanswered question — after this one first, then any skipped before.
 */
function advance(spec: AskSpec, answers: Answer[], index: number): ChipStep {
  if (isComplete(spec.questions, answers)) {
    return { kind: 'send', text: composeAnswer(spec.questions, answers) };
  }
  const later = answers.findIndex((a, i) => i > index && !answered(a));
  const next = later !== -1 ? later : answers.findIndex(a => !answered(a));
  return { kind: 'show', state: { index: next, answers } };
}

/**
 * One tap on an option. A single-answer question is answered by it; a
 * multi-answer one toggles it and waits for `confirm`.
 */
export function tapChip(spec: AskSpec, state: ChipState, label: string): ChipStep {
  const question = currentQuestion(spec, state);
  const multi = question?.multi === true;
  const answers = [...state.answers];
  answers[state.index] = toggleChoice(state.answers[state.index] ?? null, label, multi);
  if (multi) return { kind: 'show', state: { ...state, answers } };
  return advance(spec, answers, state.index);
}

/** Done choosing on a multi-answer question. Nothing happens with nothing chosen. */
export function confirmChips(spec: AskSpec, state: ChipState): ChipStep {
  if (!answered(state.answers[state.index])) return { kind: 'show', state };
  return advance(spec, state.answers, state.index);
}

/** "Other…" answered in the composer: the text is this question's own answer. */
export function answerOwn(spec: AskSpec, state: ChipState, text: string): ChipStep {
  const question = currentQuestion(spec, state);
  const answers = [...state.answers];
  answers[state.index] = setCustomAnswer(
    state.answers[state.index] ?? null,
    text,
    question?.options ?? [],
    question?.multi === true
  );
  return advance(spec, answers, state.index);
}
