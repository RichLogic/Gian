import { useCallback, useEffect, useRef, useState } from 'react';
import { loadWorkingTrees, type WorkingTree } from '../api.js';

export interface WorkingTreeReloadOptions {
  /** Bypass the Host's short-lived discovery cache. */
  force?: boolean;
}

/**
 * Own the global working-tree list and serialize every refresh source through
 * one latest-request-wins boundary. A slow older request can never overwrite a
 * newer menu/reconnect refresh, and failures retain the last known-good list.
 */
export function useWorkingTrees(): {
  workingTrees: WorkingTree[];
  reloadWorkingTrees: (options?: WorkingTreeReloadOptions) => void;
} {
  const [workingTrees, setWorkingTrees] = useState<WorkingTree[]>([]);
  const latestRequestRef = useRef(0);

  const reloadWorkingTrees = useCallback((options: WorkingTreeReloadOptions = {}) => {
    const request = ++latestRequestRef.current;
    void loadWorkingTrees({ refresh: options.force === true })
      .then(next => {
        if (request === latestRequestRef.current) setWorkingTrees(next);
      })
      // No state write on failure: retain the last known-good listing.
      .catch(() => undefined);
  }, []);

  useEffect(() => () => {
    // Prevent an in-flight request from writing after unmount.
    latestRequestRef.current += 1;
  }, []);

  return { workingTrees, reloadWorkingTrees };
}
