# Contributing to Gian

## Development workflow

1. Discuss requirements and acceptance criteria, then prepare the technical plan.
2. The Owner chooses optional independent plan review and whether the current
   Agent or another Agent implements. Prior choices need not be asked again.
3. Develop in the conversation's worktree. Reuse it across Issues and after
   merges; organize commits by task. Target the selected `release/X.Y.Z` line
   and inspect local edits and target advancement before synchronization.
   Additional checkouts need selected independent work;
   concurrent implementers must not write to the same checkout.
4. Maintain necessary tests with code. Prefer existing coverage and the lowest
   useful layer; document genuine gaps instead of creating ceremonial tests.
   Inspect source/diffs, but do not automatically run tests, typechecks, builds,
   verification dependency installs or previews.
5. Offer optional independent code review (read-only by default), then follow
   the Owner's choice: direct untested integration, focused unit regression,
   requirement-specific functional verification, or preview and a decision.
6. Integrate selected task changes into the version's `release/X.Y.Z` branch,
   not `main`. Local integration needs neither a PR nor remote CI success.
   Pushing, publishing and deployment still require their own authorization.

## Version branches and CI

- `main` is the GianDev released baseline, not the rolling development or
  acceptance branch. Start a new `release/X.Y.Z` from an explicitly selected
  baseline (normally released `main`); reuse the existing branch for that version.
  Do not reset existing branches or bulk-import unrelated main changes into an
  in-progress acceptance version. Migrating an existing candidate uses its exact
  selected revision, not whatever happens to be main's latest tip.
- Develop, integrate fixes, build test packages and accept the version on its
  release line, for example `release/0.6.2`. Task branches/worktrees remain useful
  for isolation; their integration target is that version branch.
- Only pushes to `release/X.Y.Z` automatically run development CI (three numeric
  components, no `v` prefix). Main, task branches and PRs do not trigger it.
  Successful release-branch CI triggers a GianDev test package from the same SHA;
  package creation is not permission to merge into main or publish a release.
- Manual development checks also select a version branch. Default-branch cron
  triggers are removed, including nightly E2E; isolated E2E remains manually
  selectable. Remote CI execution never authorizes local testing.
- Only the Owner's explicit **GianDev release** instruction ("GianDev 发布")
  authorizes merging the selected `release/X.Y.Z` into `main`. Completing a fix,
  passing CI, finishing acceptance or requesting a test package does not.
  Inspect main advancement before this merge; if the delivered content changes,
  reassess affected evidence instead of calling the old candidate accepted.
- A GianDev release does not authorize public `Gian/main` synchronization,
  formal App publication, Proxy/Catalog publication or deployment. Those retain
  their separate authorization and certification requirements.

See [ADR-0088](docs/adr/0088-version-branch-development-and-ci.md) and
[App Delivery](docs/operations/app-delivery.md) for delivery and rollout details.

## Verification and acceptance

Before executing, state exact scope, environment and approximate budget. Prefer
CI or a dedicated test machine. Local common runners require
`GIAN_ALLOW_LOCAL_VERIFICATION=1` and serialize worktrees. Do not set it without
consent or persist it; raw commands must not bypass scope/resource restrictions.
Desktop/E2E and real Provider/quota runs need their separate selected scope.
Reviews and delegated implementation inherit these limits.

GianDev acceptance validates a fixed revision's changed functionality and
directly affected regressions. Check requirements against actual code/tests for
missing coverage, stale tests, unregistered files or weakened assertions.
Resolve or explicitly accept gaps; a merge is not acceptance. Reuse applicable
evidence instead of rerunning it. The Owner judges experience when needed.

Global core smoke on the final release artifact and production-specific checks
complement functional evidence. Follow the current release workflow; do not
silently bypass existing gates while release channels are being reorganized.

## Delivery record

Keep a short change/review/test-maintenance/execution/gap summary in the commit
or task delivery. Executed checks include revision, result and evidence link;
unexecuted checks are NOT_RUN. Preserve the actual test files and machine
catalog/selection configuration. Requirements and acceptance criteria belong
to the task; current implementation and automated assertions belong to code.

Do not maintain a second diary in `.ai/` or update the archived traceability
matrix. Read technical docs only when relevant. Important architecture decisions
remain versioned; changelogs describe versions being packaged or released.

## Tools and commits

Use the Node and pnpm versions pinned by package.json; install/build only as
needed for the selected work. When a build is selected, dependency declarations
must be built before consumers. See package scripts for actual commands.
Use conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`) and a
body explaining meaningful changes and verification. Preserve unrelated edits.
