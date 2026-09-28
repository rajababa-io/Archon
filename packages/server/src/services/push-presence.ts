/**
 * Which chats are on someone's screen right now, so a push about a chat you
 * are already looking at is not sent.
 *
 * Every open console — desktop or phone — reports the chat it is showing while
 * its page is visible, on a heartbeat, and reports nothing once hidden. A
 * report expires on its own, because a browser that is closed, killed or
 * suspended by the phone's OS never says goodbye. Until it expires, pushes for
 * that chat are held back as if it were still on screen; the window is short
 * so that mistake stays small.
 *
 * In memory on purpose: presence is about this process's clients this minute,
 * and a restart loses nothing a heartbeat does not restore.
 */

/** How long one report counts. The console heartbeats well inside it. */
export const PRESENCE_TTL_MS = 45_000;

export class ChatPresence {
  /** Per client, the chat it is showing and until when that report holds. */
  private readonly clients = new Map<string, { conversationId: string; until: number }>();

  constructor(
    private readonly ttlMs: number = PRESENCE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * One client's report. A client shows at most one chat, so each report
   * replaces its last; `null` means it is showing none (hidden, or on a
   * screen that is not a chat).
   */
  report(clientId: string, conversationId: string | null): void {
    if (conversationId === null) {
      this.clients.delete(clientId);
      return;
    }
    this.clients.set(clientId, { conversationId, until: this.now() + this.ttlMs });
    this.sweep();
  }

  /** Whether any client reported this chat on screen within the window. */
  isVisible(conversationId: string): boolean {
    const now = this.now();
    for (const entry of this.clients.values()) {
      if (entry.conversationId === conversationId && entry.until > now) return true;
    }
    return false;
  }

  /** Drop expired reports, so clients that vanished do not accumulate. */
  private sweep(): void {
    const now = this.now();
    for (const [clientId, entry] of this.clients) {
      if (entry.until <= now) this.clients.delete(clientId);
    }
  }
}
