import { Hono } from 'hono';
import { RemoteProtocolError, REMOTE_METHOD_PARAMS, parseClosed } from '@gian/remote-protocol';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { registerWorkingTreeRoutes } from '../web/routes/working-trees.js';

/** Reuse Gian's read implementations without exposing a generic HTTP proxy.
 * The only URL fragments here come from a closed operation table and the
 * already-authorized execution Session. No caller method or URL is accepted. */
export class RemoteReadOnlyGit {
  private readonly reads = new Hono();
  constructor(private readonly db: Db, broadcaster: WsBroadcaster) {
    registerWorkingTreeRoutes(this.reads, db, broadcaster);
  }

  async read(value: unknown): Promise<{ result_json: string }> {
    const input = parseClosed(REMOTE_METHOD_PARAMS['git.read'], value);
    const session = this.db.prepare('SELECT workspace_id, worktree_path FROM sessions WHERE id = ?')
      .get(input.session_id) as { workspace_id: string | null; worktree_path: string | null } | undefined;
    if (!session?.workspace_id) throw new RemoteProtocolError('RESOURCE_NOT_FOUND', 'execution repository unavailable');
    const treeId = session.worktree_path ? 'wt:' + input.session_id : 'ws:' + session.workspace_id;
    const operations = { changed: 'changed', diff: 'diff', branches: 'branches', commits: 'commits', history: 'history',
      history_commit: 'history/' + input.sha, history_diff: 'history/' + input.sha + '/diff',
      history_reachability: 'history/' + input.sha + '/reachability' };
    if (input.operation.startsWith('history_') && !input.sha) throw new RemoteProtocolError('INVALID_FRAME', 'commit required');
    const url = new URL('http://gian-internal/api/working_trees/' + encodeURIComponent(treeId) + '/' + operations[input.operation]);
    const params = { path: input.reference, scope: input.scope, sha: input.sha, base: input.base,
      turn: input.turn, root: input.root, cursor: input.cursor, q: input.query, ref: input.ref,
      author: input.author, limit: input.limit, session: input.session_id };
    for (const [key, item] of Object.entries(params)) if (item !== undefined) url.searchParams.set(key, String(item));
    const response = await this.reads.fetch(new Request(url));
    if (!response.ok) throw new RemoteProtocolError('RESOURCE_NOT_FOUND', 'remote Git read failed');
    const result_json = JSON.stringify(await response.json());
    if (Buffer.byteLength(result_json) > 160 * 1024) throw new RemoteProtocolError('FRAME_TOO_LARGE', 'Git result exceeds remote read budget');
    return { result_json };
  }
}
