import type { Context, Hono } from 'hono';
import {
  SearchContractError,
  SEARCH_ROUTES,
  parseContextQuery,
  parseFindQuery,
  parseGlobalSearchQuery,
  searchFailureStatus,
  type QueryInput,
} from '@gian/shared';
import type { Db } from '../../storage/db.js';
import { SEARCH_SCAN_BUDGET } from '../../search/store.js';
import { findInSession, readContext, searchGlobal, searchStatus } from '../../search/query.js';

/**
 * Search reads. Host does not execute settings or commands.
 * Auth stays on the app middleware; these routes do not bypass it.
 */
export function registerSearchRoutes(app: Hono, db: Db, scanBudget = SEARCH_SCAN_BUDGET): void {
  app.get(SEARCH_ROUTES.search, c => {
    try {
      return c.json(searchGlobal(db, parseGlobalSearchQuery(readQuery(c)), scanBudget));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get(SEARCH_ROUTES.status, c => {
    try {
      return c.json(searchStatus(db));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get(SEARCH_ROUTES.find, c => {
    try {
      return c.json(findInSession(db, parseFindQuery(c.req.param('id'), readQuery(c)), scanBudget));
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get(SEARCH_ROUTES.context, c => {
    try {
      return c.json(readContext(db, parseContextQuery(c.req.param('id'), readQuery(c))));
    } catch (error) {
      return fail(c, error);
    }
  });
}

function readQuery(c: Context): QueryInput {
  return {
    q: c.req.query('q'),
    types: c.req.query('types'),
    workspace_id: c.req.query('workspace_id'),
    include_archived: c.req.query('include_archived'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    turn_id: c.req.query('turn_id'),
    turn: c.req.query('turn'),
    before: c.req.query('before'),
    after: c.req.query('after'),
    document_id: c.req.query('document_id'),
    message_id: c.req.query('message_id'),
    text_revision: c.req.query('text_revision'),
  };
}

function fail(c: Context, error: unknown): Response {
  if (error instanceof SearchContractError) {
    return c.json(
      { error: error.code, message: error.message },
      searchFailureStatus(error.code),
    );
  }
  throw error;
}
