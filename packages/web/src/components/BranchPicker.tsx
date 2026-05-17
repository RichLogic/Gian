import { useEffect, useMemo, useRef, useState } from 'react';
import type { LocalBranch, RemoteBranch } from '../api.js';

/**
 * Branch picker — popover-style combobox modeled after VS Code's QuickPick
 * and GitHub Desktop's branch chooser. A trigger button shows the current
 * selection; clicking opens a popover with a search input and two grouped
 * sections (Local / Remote). Each row carries the branch name plus a small
 * kind/role tag.
 *
 * The native <datalist> we used previously gives bad UX: no grouping, no
 * default-branch badge, no filtering metadata. Worth the extra plumbing.
 *
 * Filtering: case-insensitive substring match against the full branch name
 * (so typing `feat` matches both `feature/x` and `origin/feature/x`). We
 * stop short of fuzzy matching — branches are short identifiers, substring
 * is the IDE default.
 */
export interface BranchPickerProps {
  branches: LocalBranch[];
  remoteBranches: RemoteBranch[];
  value: string;
  defaultBranch: string | null;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Used for keyboard / accessibility — labels the trigger. */
  ariaLabel?: string;
}

export function BranchPicker({
  branches,
  remoteBranches,
  value,
  defaultBranch,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside-click + Esc. Mirrors the kebab popover pattern used
  // elsewhere in the app for consistency with the dock/kebab menus.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); e.stopPropagation(); }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus the search input as soon as the popover opens; reset query when
  // closed so re-opening starts fresh.
  useEffect(() => {
    if (open) {
      searchRef.current?.focus();
    } else {
      setQuery('');
    }
  }, [open]);

  const localFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const localNames = new Set(branches.map(b => b.name));
    return branches
      // A branch can only be checked out in one worktree at a time; we hide
      // already-occupied ones so the user doesn't pick something git will
      // immediately refuse.
      .filter(b => !b.worktreePath)
      .filter(b => !q || b.name.toLowerCase().includes(q))
      // Default branch floats to the top; otherwise alphabetical.
      .sort((a, b) => {
        if (a.name === defaultBranch) return -1;
        if (b.name === defaultBranch) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(b => ({
        value: b.name,
        isDefault: b.name === defaultBranch,
      }));
  }, [branches, query, defaultBranch]);

  const remoteFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const localNames = new Set(branches.map(b => b.name));
    // Remote-only refs (no local tracking branch yet) are the ones a user
    // can't pick from the Local section. If a remote has a local tracker we
    // hide it here to avoid two entries for the same logical branch.
    return remoteBranches
      .filter(rb => !localNames.has(rb.branch))
      .filter(rb => !q || rb.fullName.toLowerCase().includes(q))
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map(rb => ({ value: rb.fullName }));
  }, [remoteBranches, branches, query]);

  const totalMatches = localFiltered.length + remoteFiltered.length;

  function pick(next: string) {
    onChange(next);
    setOpen(false);
  }

  const display = value || placeholder || 'Pick a base branch…';

  return (
    <div className="branch-picker" ref={anchorRef}>
      <button
        type="button"
        className="branch-picker-trigger"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        aria-label={ariaLabel ?? 'Pick base branch'}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={`branch-picker-value${value ? '' : ' placeholder'}`}>{display}</span>
        <span className="branch-picker-chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="branch-picker-pop" role="listbox">
          <input
            ref={searchRef}
            className="branch-picker-search"
            placeholder="Search local + remote branches…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            spellCheck={false}
          />
          <div className="branch-picker-body">
            {localFiltered.length > 0 && (
              <>
                <div className="branch-picker-sec">Local</div>
                {localFiltered.map(b => (
                  <button
                    key={b.value}
                    type="button"
                    role="option"
                    aria-selected={value === b.value}
                    className={`branch-picker-row${value === b.value ? ' active' : ''}`}
                    onClick={() => pick(b.value)}
                  >
                    <span className="branch-picker-name">{b.value}</span>
                    {b.isDefault && <span className="branch-picker-tag">default</span>}
                  </button>
                ))}
              </>
            )}
            {remoteFiltered.length > 0 && (
              <>
                <div className="branch-picker-sec">Remote</div>
                {remoteFiltered.map(b => (
                  <button
                    key={b.value}
                    type="button"
                    role="option"
                    aria-selected={value === b.value}
                    className={`branch-picker-row${value === b.value ? ' active' : ''}`}
                    onClick={() => pick(b.value)}
                  >
                    <span className="branch-picker-name">{b.value}</span>
                    <span className="branch-picker-tag remote">remote</span>
                  </button>
                ))}
              </>
            )}
            {totalMatches === 0 && (
              <div className="branch-picker-empty">
                {query.trim() ? 'No branches match' : 'No branches'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
