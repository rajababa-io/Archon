import { Search, Inbox, PanelLeft, ChevronUp, ChevronDown } from 'lucide-react';
import { useRailPeek } from '../lib/use-rail-peek';
import { RAIL_AUTO_COLLAPSE_PX, useViewportWidth } from '../lib/use-viewport';
import {
  applyManualOrder,
  dropIndexAt,
  mergeManualOrder,
  previewShift,
  reorder,
  rowBoxes,
} from '../lib/chat-order';
import { readProjectOrder, writeProjectOrder } from '../lib/project-order';
import { clampPaneWidth, readPaneWidth, writePaneWidth, type PaneBounds } from '../lib/pane-width';
import { pushOrder, syncPresentation } from '../lib/presentation-sync';

/** Matches `margin-bottom: var(--row-gap)` on .rail-row at comfortable density. */
const PROJECT_ROW_GAP = 2;
import {
  Fragment,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate, useLocation } from 'react-router';
import { Settings, Workflow, type LucideIcon } from 'lucide-react';
import { ProjectRow } from './ProjectRow';
import { ProjectCountHeader, ProjectCountTotals } from './ProjectCountCells';
import { EnvVarsDialog } from './EnvVarsDialog';
// Sign-out lives here because the console is the only UI — there is no other
// surface left to log out from. Renders null when web auth is off (the solo
// default), so the rail is unchanged for a single-operator install.
import { SessionMenu } from '@/components/auth/SessionMenu';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import {
  clampDropToGroup,
  groupByOwner,
  moveOwnerGroup,
  type Project,
} from '../primitives/project';

interface ProjectRailProps {
  /** Shown as a drawer over the page rather than beside it. */
  drawer: boolean;
  onAddProject: () => void;
  /** Opens the command palette — the rail's search row is a shortcut to it. */
  onSearch: () => void;
}

interface ProjectRemovalActions {
  remove: (projectId: string) => Promise<void>;
  invalidateProjects: () => void;
  navigateToOverview: () => void;
}

export async function removeProjectFromRail(
  projectId: string,
  selectedProjectId: string | null,
  actions: ProjectRemovalActions
): Promise<void> {
  await actions.remove(projectId);
  actions.invalidateProjects();
  if (selectedProjectId === projectId) actions.navigateToOverview();
}

/** Extract the project id from /console/p/:id (and /console/p/:id/r/:runId). */
function extractProjectId(pathname: string): string | null {
  const m = /^\/console\/p\/([^/]+)/.exec(pathname);
  return m === null ? null : m[1];
}

const RAIL_COLLAPSED_KEY = 'archon.console.railCollapsed';

/** Bounds for the project rail. The chat rail declares its own; see lib/pane-width. */
const RAIL_WIDTH: PaneBounds = {
  key: 'archon.console.railWidth',
  min: 232,
  max: 440,
  initial: 280,
};

/** A row in the rail's bottom nav menu (Workflows / Settings). */
function RailNavLink({
  to,
  icon: Icon,
  label,
  title,
  activeFor = [to],
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  title?: string;
  /** Path prefixes this item is the current place for; defaults to its own. */
  activeFor?: readonly string[];
}): ReactElement {
  const { pathname } = useLocation();
  const active = activeFor.some(p => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <Link to={to} title={title} aria-current={active ? 'page' : undefined} className="rail-row">
      <span aria-hidden className="rail-ico" style={{ color: 'var(--text-secondary)' }}>
        <Icon />
      </span>
      <span className="rail-hide rail-text">{label}</span>
    </Link>
  );
}

/**
 * Left rail: header, search row, the global scope, then the projects grouped
 * by owner under section labels, and a drag handle on the right edge
 * (232–440px, persisted).
 *
 * Note: ProjectRail mounts outside the inner `<Routes>` (sibling to the
 * <main> that hosts them), so `useParams()` returns `{}` here even on a
 * project URL. We extract the project id from the pathname directly.
 */
export function ProjectRail({ drawer, onAddProject, onSearch }: ProjectRailProps): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const scope = extractProjectId(location.pathname) ?? 'all';
  const [envProject, setEnvProject] = useState<Project | null>(null);
  /* The filter box became the Search row. `query` stays as the empty
     default so the list logic below is untouched and can be wired to the
     palette's own filter later without another rewrite. */
  const query = '';
  const [width, setWidth] = useState<number>(() => readPaneWidth(RAIL_WIDTH));

  /**
   * Collapsed to the icon column, and whether a peek is currently open.
   *
   * `showWide` is the one thing the inline width style keys off: while
   * collapsed-and-not-peeking the CSS owns the width (`--rail-collapsed-w`), and
   * an inline width would fight it. While peeking, the inline width is what
   * the panel animates TO.
   */
  /** Bumped on commit so the manual order is re-read from localStorage. */
  const [orderTick, setOrderTick] = useState(0);

  const [chosenCollapsed, setChosenCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });

  /**
   * Narrow windows collapse the rail without forgetting what you chose.
   *
   * Two 268px rails and a transcript do not fit below ~1100px. Overwriting the
   * stored preference would mean a window you narrowed once left the rail
   * collapsed forever; keeping the two separate means widening the window
   * gives you back exactly what you had.
   *
   * A drawer is exempt: it covers the page instead of sharing its width.
   */
  const viewportWidth = useViewportWidth();
  const tooNarrow = !drawer && viewportWidth < RAIL_AUTO_COLLAPSE_PX;
  const collapsed = chosenCollapsed || tooNarrow;
  const peeking = useRailPeek(collapsed, width);
  const showWide = !collapsed || peeking;

  const toggleCollapsed = useCallback((): void => {
    setChosenCollapsed(v => {
      const next = !v;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* private mode — the rail still collapses, it just does not persist */
      }
      return next;
    });
  }, []);

  // ⌘. / Ctrl+. anywhere. Not routed through the keymap because it must work
  // while focus is in the composer, where single-letter shortcuts are off.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [toggleCollapsed]);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const { data: projects, error } = useEntity<Project[]>(K.projects, () => skill.listProjects());

  const allSelected = scope === 'all';
  const allProjectIds = useMemo(() => (projects ?? []).map(p => p.id), [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = projects ?? [];
    if (q.length === 0) return list;
    return list.filter(p => `${p.name} ${p.path}`.toLowerCase().includes(q));
  }, [projects, query]);

  /**
   * One flat list, not owner groups.
   *
   * The owner still identifies the project — it is in the row's tooltip and in
   * the name when it differs from the display name — but it no longer dictates
   * position. Grouping and a hand-chosen order are mutually exclusive, and the
   * order you choose is the more useful of the two.
   */
  /**
   * Reconcile with the server once, when the project list is first known.
   *
   * Not on every render and not per row: this is a migration and a pull, and
   * doing it per row would issue one request per project per navigation.
   */
  const syncedRef = useRef(false);
  useEffect(() => {
    const ids = (projects ?? []).map(p => p.id);
    if (syncedRef.current || ids.length === 0) return;
    syncedRef.current = true;
    void syncPresentation(ids).then(() => {
      setOrderTick(t => t + 1);
    });
  }, [projects]);

  /**
   * Grouped by owner, and `flat` is the REGROUPED order.
   *
   * The drag primitives index into the list as rendered, so the two must not
   * disagree. Grouping does not sort: each owner's section appears where its
   * first project already sat, so a rail dragged into shape stays in shape.
   */
  const groups = useMemo(
    () => groupByOwner(applyManualOrder(filtered, readProjectOrder())),
    [filtered, orderTick]
  );
  const flat = useMemo(() => groups.flatMap(g => g.items), [groups]);

  /* ── drag to arrange ────────────────────────────────────────────────────
     The same primitives the chat rail uses: geometry measured ONCE at drag
     start, a transform-only preview so the measurement stays true for the
     whole gesture, and an index-based commit so what lands matches what the
     preview showed. */
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const boxesRef = useRef<ReturnType<typeof rowBoxes>>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollAtStart = useRef(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState(-1);
  const dragFrom = dragId === null ? -1 : flat.findIndex(p => p.id === dragId);

  const beginDrag = (id: string, index: number): void => {
    const rects = flat
      .map(p => rowRefs.current.get(p.id)?.getBoundingClientRect())
      .filter((r): r is DOMRect => r !== undefined);
    boxesRef.current = rowBoxes(rects, PROJECT_ROW_GAP);
    scrollAtStart.current = scrollerRef.current?.scrollTop ?? 0;
    setDragId(id);
    setDropIndex(index);
  };
  const endDrag = (): void => {
    setDragId(null);
    setDropIndex(-1);
  };
  const commitDrag = (): void => {
    // A drag may only land inside its own owner group — see clampDropToGroup.
    const clamped = dragId === null ? dropIndex : clampDropToGroup(groups, dragId, dropIndex);
    const target = flat[clamped];
    if (dragId !== null && target !== undefined && target.id !== dragId) {
      // `flat` is the SEARCH-filtered list, so it is not the whole order.
      // Folding it in leaves every project the query hid where it was, instead
      // of writing an order made only of the rows that happened to match.
      const next = mergeManualOrder(readProjectOrder(), reorder(flat, dragId, target.id));
      writeProjectOrder(next);
      pushOrder(next);
      // localStorage is invisible to useMemo; this is what makes it recompute.
      setOrderTick(t => t + 1);
    }
    endDrag();
  };

  /**
   * Send a whole account's section past the one above or below it.
   *
   * Written the same way a drag is — fold the displayed order back into the
   * stored one, push it, then tell the memo that localStorage moved — because
   * it IS the same write. A section is just a block of rows, so the arrangement
   * it produces has to be indistinguishable from having dragged each of them.
   */
  const moveGroup = (owner: string, direction: -1 | 1): void => {
    const moved = moveOwnerGroup(groups, owner, direction);
    if (moved === null) return;
    const next = mergeManualOrder(readProjectOrder(), moved);
    writeProjectOrder(next);
    pushOrder(next);
    setOrderTick(t => t + 1);
  };

  // Pointer-driven resize; width clamps to the rail's bounds and persists on
  // release. Pointer capture keeps the drag alive outside the handle.
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    let latest = startW;
    setResizing(true);
    const move = (ev: PointerEvent): void => {
      latest = clampPaneWidth(startW + (ev.clientX - startX), RAIL_WIDTH);
      setWidth(latest);
    };
    const up = (): void => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      writePaneWidth(RAIL_WIDTH, latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  return (
    <>
      {/* A collapsed rail is absolutely positioned over a spacer of its own
          width. That is what lets a peek widen it without pushing the content
          beside it — the page does not reflow, the panel slides over it. */}
      {collapsed ? <div className="rail-spacer" /> : null}
      <nav
        aria-label="Projects"
        style={{ width: showWide ? width : undefined, flexBasis: showWide ? width : undefined }}
        className={`rail-panel relative flex h-full shrink-0 flex-col border-r border-border bg-surface-inset${
          collapsed && !peeking ? ' is-collapsed' : ''
        }${peeking ? ' is-peeking' : ''}`}
      >
        {/* Header: brand + label + count + filter */}
        <div className="px-2.5 pb-1.5 pt-2.5">
          {/* The head is a ROW, on the same icon column as everything below it.
            Collapsed, the toggle is the only thing left and it has not moved —
            which is what makes the panel read as sliding rather than jumping.
            A div, not a button: the toggle owns the icon and the wordmark, the
            assistant's mark is its own control at the trailing edge, and one
            button inside another is invalid markup that leaves the inner one
            unreachable by keyboard. */}
          <div className="rail-row">
            <button
              type="button"
              onClick={toggleCollapsed}
              title={`${collapsed ? 'Expand' : 'Collapse'}  ⌘.`}
              aria-label={collapsed ? 'Expand the rail' : 'Collapse the rail'}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span aria-hidden className="rail-ico" style={{ color: 'var(--text-secondary)' }}>
                <PanelLeft />
              </span>
              {/* leading pinned to the row's 17px content box. .rail-row has a
                  fixed height so hovering cannot make the rail jump, and the
                  wordmark's default 1.5 line-height overflowed it by 4px. */}
              <span className="rail-hide brand-text text-large font-medium leading-[17px] tracking-tight">
                Archon
              </span>
            </button>
          </div>
          {/* A ROW, not a text field. The box was permanent chrome for something
            done occasionally, and the palette already jumps to a project by
            name — across every project, not just the visible list. */}
          <button type="button" onClick={onSearch} title="Search  ⌘K" className="rail-row">
            <span aria-hidden className="rail-ico" style={{ color: 'var(--text-tertiary)' }}>
              <Search />
            </span>
            <span className="rail-hide rail-text">Search</span>
            <span
              className="rail-hide shrink-0 rounded border px-[5px] py-px text-mini text-text-tertiary"
              style={{ borderColor: 'var(--border-bright)' }}
            >
              ⌘K
            </span>
          </button>
        </div>

        {/* ALL scope */}
        <div className="px-2.5">
          <button
            type="button"
            onClick={() => {
              navigate('/console');
            }}
            title="All projects"
            aria-label="All projects"
            aria-pressed={allSelected}
            className="rail-row"
          >
            <span aria-hidden className="rail-ico">
              <Inbox />
            </span>
            <span className="rail-hide rail-text">All projects</span>
            <ProjectCountTotals projectIds={allProjectIds} />
            <span className="rail-hide rail-actions" />
          </button>
        </div>

        {/* Grouped project list */}
        <div
          ref={scrollerRef}
          className="rail-scroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-1.75 pt-1"
          onDragOver={e => {
            if (dragId === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            // The boxes were measured at drag start; if the list scrolled since,
            // the pointer has to be read in that same coordinate space.
            const scrolledBy = (scrollerRef.current?.scrollTop ?? 0) - scrollAtStart.current;
            setDropIndex(dropIndexAt(boxesRef.current, e.clientY, scrolledBy));
          }}
          onDrop={e => {
            if (dragId === null) return;
            e.preventDefault();
            commitDrag();
          }}
        >
          {error !== undefined ? (
            <span
              title={error.message}
              className="mx-2 rounded border border-error/40 bg-error/10 px-2 py-1 text-mini text-error"
            >
              {error.message}
            </span>
          ) : null}
          {/* Column headers. Same geometry as a row's cells, so the glyphs sit
            exactly above the numbers they name. Rendered once, above a FLAT
            list: owner group headers and a hand-sorted order cannot both be
            true, and the order you choose is the more useful of the two. */}
          {flat.length > 0 ? (
            <>
              <div className="rail-sep" />
              {/* Always rendered, never `rail-hide`. Collapsed it is an empty
                row of its own height — reserving the space costs 18px of blank
                and buys a peek in which nothing below it moves. Only its CELLS
                hide, which is the prototype's own reading. */}
              <div className="rail-row is-header">
                <span className="rail-ico" />
                <span className="rail-text" />
                <ProjectCountHeader />
                <span className="rail-actions" />
              </div>
            </>
          ) : null}
          {groups.map((group, gi) => (
            <Fragment key={group.owner}>
              {/* Collapsed, the label is invisible but keeps its height — the
                  same reasoning as the header row above. Removed from layout,
                  every icon below it would slide up under the pointer, by an
                  amount that changes with the font size. */}
              <div className="rail-hide rail-owner">
                <span className="rail-owner-name">{group.owner}</span>
                {/* Two buttons rather than a drag, because a section is not a
                    row: dragging one means carrying every project in it past
                    every project in another, and the preview for that is a
                    different gesture wearing the row drag's clothes. Up and
                    down is the whole vocabulary an account order needs.
                    Revealed on hover, like the row grips. */}
                <span className="rail-owner-move">
                  <button
                    type="button"
                    aria-label={`Move ${group.owner} up`}
                    title="Move this account up"
                    disabled={gi === 0}
                    onClick={() => {
                      moveGroup(group.owner, -1);
                    }}
                  >
                    <ChevronUp />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${group.owner} down`}
                    title="Move this account down"
                    disabled={gi === groups.length - 1}
                    onClick={() => {
                      moveGroup(group.owner, 1);
                    }}
                  >
                    <ChevronDown />
                  </button>
                </span>
              </div>
              {group.items.map((p, i) => {
                const index = group.start + i;
                return (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    dragging={dragId === p.id}
                    shift={
                      dragId === null
                        ? 0
                        : previewShift(boxesRef.current, dragFrom, dropIndex, index)
                    }
                    registerRow={el => {
                      if (el === null) rowRefs.current.delete(p.id);
                      else rowRefs.current.set(p.id, el);
                    }}
                    onDragBegin={() => {
                      beginDrag(p.id, index);
                    }}
                    onDragEnd={endDrag}
                    selected={scope === p.id}
                    onClick={() => {
                      navigate(`/console/p/${p.id}`);
                    }}
                    onRemove={() =>
                      removeProjectFromRail(p.id, scope, {
                        remove: skill.removeProject,
                        invalidateProjects: () => {
                          invalidate(K.projects);
                        },
                        navigateToOverview: () => {
                          navigate('/console');
                        },
                      })
                    }
                    onEditEnv={() => {
                      setEnvProject(p);
                    }}
                  />
                );
              })}
            </Fragment>
          ))}
          {flat.length === 0 && error === undefined ? (
            <div className="px-3 py-3.75 text-center text-body text-text-tertiary">
              No projects match “{query}”.
            </div>
          ) : null}
        </div>

        {/* Add project */}
        {/* Same section padding and gutter as a row, less the 1px border, so the
            "+" sits on the icon column and stays centred when collapsed. */}
        <div className="border-t border-border px-2.5 py-2.5">
          <button
            type="button"
            onClick={onAddProject}
            title="Add project"
            aria-label="Add project"
            className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface py-1.5 pl-[16px] pr-[6px] text-left text-body font-medium text-text-secondary transition-colors hover:border-accent-bright/50 hover:bg-surface-hover hover:text-text-primary"
          >
            <span
              aria-hidden="true"
              className="rail-ico text-large leading-none text-accent-bright"
            >
              +
            </span>
            <span className="rail-hide truncate">Add project</span>
          </button>
        </div>

        {/* Nav menu — under Add project, separated from it by the border-t divider. */}
        <div className="flex flex-col gap-0.5 border-t border-border px-2.5 py-1.25">
          <RailNavLink
            to="/console/workflows"
            icon={Workflow}
            label="Workflows"
            title="Every workflow — open one in the builder"
            activeFor={['/console/workflows', '/console/builder']}
          />
          <RailNavLink
            to="/console/settings"
            icon={Settings}
            label="Settings"
            title="Settings ( , )"
          />
        </div>

        <SessionMenu />

        {/* Resize handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize"
          onPointerDown={startResize}
          className="rail-resize group absolute -right-1 top-0 z-10 flex h-full w-[9px] cursor-col-resize items-center justify-center"
        >
          <span
            aria-hidden
            className={`w-[2px] rounded-sm transition-all ${
              resizing
                ? 'h-full bg-accent-bright'
                : 'h-9 bg-transparent group-hover:h-14 group-hover:bg-accent-bright/60'
            }`}
          />
        </div>

        <EnvVarsDialog
          projectId={envProject?.id ?? ''}
          projectName={envProject?.name ?? ''}
          open={envProject !== null}
          onClose={() => {
            setEnvProject(null);
          }}
        />
      </nav>
    </>
  );
}
