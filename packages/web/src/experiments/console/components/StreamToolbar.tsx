import type { ReactElement, ReactNode } from 'react';

export type DetailView = 'log' | 'graph' | 'artifacts';

export interface NodeFilterOption {
  id: string;
  name: string;
}

interface StreamToolbarProps {
  view: DetailView;
  onChangeView: (next: DetailView) => void;
  showToolCalls: boolean;
  onToggleToolCalls: (next: boolean) => void;
  showSystem: boolean;
  onToggleSystem: (next: boolean) => void;
  /**
   * Hide everything that is not an error.
   *
   * Not a third independent checkbox in practice: when a long run has gone
   * wrong, the question is "what broke", and answering it by unticking two
   * boxes leaves prose and artifacts still in the way.
   */
  errorsOnly: boolean;
  onToggleErrorsOnly: (next: boolean) => void;
  toolCallCount: number;
  messageCount: number;
  artifactCount: number | null;
  /** Distinct nodes in the run; empty hides the node filter. */
  nodeOptions: NodeFilterOption[];
  /** `'all'` or a nodeId. */
  selectedNodeId: string;
  onSelectNode: (next: string) => void;
}

// Compact native select styled with brand tokens — mirrors AssistantConfigPanel's
// SelectShell/SELECT_CLASS, tuned for the toolbar row height.
const SELECT_CLASS =
  'max-w-[180px] cursor-pointer appearance-none truncate rounded-[7px] border border-border bg-surface-elevated py-[3px] pl-2.5 pr-5.5 text-small font-medium text-text-primary transition-all focus:border-accent-bright/50 focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--accent),transparent_92%)]';

function SelectShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="relative inline-flex items-center">
      {children}
      <span
        aria-hidden
        className="pointer-events-none absolute right-[9px] flex text-text-tertiary"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </span>
  );
}

interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function Checkbox({ label, checked, onChange }: CheckboxProps): ReactElement {
  return (
    <label className="flex cursor-pointer select-none items-center gap-1.5 text-text-secondary hover:text-text-primary">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => {
          onChange(e.target.checked);
        }}
        className="h-3.5 w-3.5 cursor-pointer accent-[color:var(--accent-bright)]"
      />
      <span>{label}</span>
    </label>
  );
}

interface TabProps {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number | null;
}

function Tab({ label, active, onClick, count }: TabProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`relative px-3 py-1.5 text-small font-medium transition-colors ${
        active ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {label}
      {typeof count === 'number' ? (
        <span className="ml-1.5 tabular-nums text-text-tertiary">{count.toString()}</span>
      ) : null}
      {active ? (
        <span
          aria-hidden
          className="brand-bar pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full"
        />
      ) : null}
    </button>
  );
}

export function StreamToolbar({
  view,
  onChangeView,
  showToolCalls,
  onToggleToolCalls,
  showSystem,
  errorsOnly,
  onToggleErrorsOnly,
  onToggleSystem,
  toolCallCount,
  messageCount,
  artifactCount,
  nodeOptions,
  selectedNodeId,
  onSelectNode,
}: StreamToolbarProps): ReactElement {
  const isLog = view === 'log';
  return (
    <div className="flex items-center gap-2.25 border-b border-border/60 bg-surface py-1.25 text-small">
      <div className="flex items-center gap-1">
        <Tab
          label="Log"
          active={isLog}
          onClick={() => {
            onChangeView('log');
          }}
        />
        <Tab
          label="Graph"
          active={view === 'graph'}
          onClick={() => {
            onChangeView('graph');
          }}
        />
        <Tab
          label="Artifacts"
          count={artifactCount}
          active={view === 'artifacts'}
          onClick={() => {
            onChangeView('artifacts');
          }}
        />
      </div>

      {isLog ? (
        <span className="ml-3 text-body text-text-tertiary">
          {messageCount.toString()} messages · {toolCallCount.toString()} tool calls
        </span>
      ) : null}

      {isLog ? (
        <div className="ml-auto flex items-center gap-[13.5px] text-body">
          {nodeOptions.length > 0 ? (
            <label className="flex items-center gap-1.5 text-text-secondary">
              <span className="text-text-tertiary">Node</span>
              <SelectShell>
                <select
                  value={selectedNodeId}
                  onChange={e => {
                    onSelectNode(e.target.value);
                  }}
                  className={SELECT_CLASS}
                  aria-label="Filter stream by node"
                >
                  <option value="all">All nodes</option>
                  {nodeOptions.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </SelectShell>
            </label>
          ) : null}
          <Checkbox label="Tool calls" checked={showToolCalls} onChange={onToggleToolCalls} />
          <Checkbox label="System" checked={showSystem} onChange={onToggleSystem} />
          <Checkbox label="Errors only" checked={errorsOnly} onChange={onToggleErrorsOnly} />
        </div>
      ) : null}
    </div>
  );
}
