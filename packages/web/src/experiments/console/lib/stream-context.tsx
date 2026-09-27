import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

/**
 * Context for per-stream data that every entry needs but we don't want to
 * prop-drill through five layers.
 *
 * `runStartedAt` drives relative timestamps like `+04:12`.
 *
 * `assistant` is which provider answers this stream, and it decides the mark on
 * every agent message. Null where the stream has no assistant of its own — a
 * run log, or an avatar rendered outside a stream entirely — and the reader
 * falls back to the configured default.
 */
export interface StreamContextValue {
  runStartedAt: string | null;
  assistant: string | null;
  /**
   * Hand the keyboard back from an ask card to whatever it came from — the
   * chat's message box. Absent where a stream has no composer.
   */
  leaveAsk?: () => void;
}

const context = createContext<StreamContextValue>({ runStartedAt: null, assistant: null });

// Wrap Provider as a function so naming-convention allows PascalCase.
export function StreamContextProvider({
  value,
  children,
}: {
  value: StreamContextValue;
  children: ReactNode;
}): ReactElement {
  return <context.Provider value={value}>{children}</context.Provider>;
}

export function useStreamContext(): StreamContextValue {
  return useContext(context);
}
