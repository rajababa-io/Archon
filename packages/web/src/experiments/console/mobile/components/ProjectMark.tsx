import type { ReactElement } from 'react';
import { Glyph } from '../../lib/glyph';
import { useProjectIdentity } from '../../lib/project-identity';

/**
 * A project's icon on a tile of its own colour — the phone's form of the
 * desktop rail's mark, read from the same identity store, so the two can never
 * show a project differently (#305). Colour, icon and name are how you know
 * where you are; this is the first two.
 */
export function ProjectMark({
  projectId,
  size = 32,
}: {
  projectId: string;
  /** Tile edge in px; the glyph is sized to it. */
  size?: number;
}): ReactElement {
  const { identity, color } = useProjectIdentity(projectId);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[9px]"
      style={{
        width: size,
        height: size,
        background: `color-mix(in oklch, ${color}, transparent 84%)`,
      }}
    >
      <Glyph seed={projectId} glyph={identity.glyph} color={color} size={Math.round(size * 0.6)} />
    </span>
  );
}
