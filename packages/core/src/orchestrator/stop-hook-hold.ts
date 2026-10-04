/**
 * Holds the agent's latest text until the turn shows whether a Stop hook sent
 * it back.
 *
 * A Claude Code Stop hook runs after the agent's last text and may return
 * `{"decision":"block"}` to demand a rewrite. The SDK then continues the SAME
 * turn, so the stream reads: text → `hook_response` (Stop) → more agent output
 * → the rewrite. The hook's `outcome` is `success` either way, so that ordering
 * is the only structured signal that the text was rejected; the hook's stdout
 * is user-authored and is deliberately not parsed.
 *
 * Streaming the text before the verdict is what showed the operator every
 * rejected draft followed by its rewrite (#190). Text followed by other work
 * (a tool call) is an interim note and is released as soon as that work
 * starts; only a trailing run of text waits for the turn to decide.
 *
 * A question card the `ask` tool emitted belongs to that trailing run, not
 * before it (#358). Text after the card is still the same reply, so it must
 * not release the card: if the Stop hook then sends the reply back, the
 * rewrite asks again and the reader would see the card twice.
 */
export class StopHookHold {
  private held: string[] = [];
  private stopHookFinished = false;
  private heldToolReply = false;

  /** `fromTool`: the text is a reply a tool emitted, such as an ask card. */
  hold(text: string, fromTool = false): void {
    this.held.push(text);
    if (fromTool) this.heldToolReply = true;
  }

  /**
   * More text arrived and should join the held text instead of releasing it:
   * a tool reply is held and no Stop hook has judged it yet.
   */
  keepsTextTogether(): boolean {
    return this.heldToolReply && !this.stopHookFinished;
  }

  /** A Stop hook finished. It judged the held text only if text is held. */
  stopHookDone(): void {
    if (this.held.length > 0) this.stopHookFinished = true;
  }

  /**
   * The agent produced more output. The held text is either released (it was
   * an interim note) or withheld (a Stop hook ran on it and the turn went on,
   * so the hook sent it back).
   */
  continueTurn(): { text: string[]; sentBack: boolean } {
    const decided = { text: this.held, sentBack: this.stopHookFinished };
    this.reset();
    return decided;
  }

  /**
   * The turn is over — by result, end of stream, error, or abort. Whatever is
   * held is the final reply: a Stop hook that ran on it let it through, since
   * nothing followed. Always released, never dropped.
   */
  endTurn(): string[] {
    const text = this.held;
    this.reset();
    return text;
  }

  private reset(): void {
    this.held = [];
    this.stopHookFinished = false;
    this.heldToolReply = false;
  }
}
