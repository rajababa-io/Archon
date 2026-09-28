import type { ReactElement } from 'react';
import { Share, SquarePlus } from 'lucide-react';

/**
 * How to put Archon on an iPhone's Home Screen. iOS delivers web push only to
 * an app opened from the Home Screen (iOS 16.4 and later), and Safari in a tab
 * has no way to ask — so this, not a Turn on button, is what an iPhone in a
 * tab is shown.
 */
export function InstallCoachMark(): ReactElement {
  return (
    <div
      role="note"
      aria-label="Add to Home Screen"
      className="mx-4 flex flex-col gap-2 rounded-lg border border-border bg-surface-inset p-3 text-small text-text-secondary"
    >
      <p className="font-medium text-text-primary">Add Archon to your Home Screen first</p>
      <p>An iPhone shows notifications only from apps on its Home Screen.</p>
      <ol className="flex flex-col gap-1.5">
        <li className="flex items-center gap-2">
          <span>1. Tap</span>
          <Share aria-label="Share" className="h-4 w-4 text-accent-bright" />
          <span>in Safari&apos;s toolbar.</span>
        </li>
        <li className="flex items-center gap-2">
          <span>2. Choose</span>
          <SquarePlus aria-hidden className="h-4 w-4 text-text-primary" />
          <span className="text-text-primary">Add to Home Screen</span>
        </li>
        <li>3. Open Archon from the new icon and come back here.</li>
      </ol>
    </div>
  );
}
