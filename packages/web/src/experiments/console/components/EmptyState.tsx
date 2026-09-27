import type { ReactElement, ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: ReactNode;
}

/** Minimal empty state — one sentence + optional single button. No illustrations. */
export function EmptyState({ title, hint, action }: EmptyStateProps): ReactElement {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-x-2.25 gap-y-1.75 text-center">
      <p className="text-large text-text-secondary">{title}</p>
      {hint !== undefined ? <p className="text-small text-text-tertiary">{hint}</p> : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
