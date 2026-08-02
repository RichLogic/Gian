# Work items

One Markdown file per work item, named `GIAN-NNN.md` (zero-padded to 3 digits
once we cross 100). Numbering is monotonic — never reuse IDs, never renumber.

## Template

```markdown
---
id: GIAN-NNN
title: <short imperative title>
status: proposed | in-progress | blocked | done | dropped
opened: YYYY-MM-DD
closed: YYYY-MM-DD  # only when status = done|dropped
owner: <name or "—">
---

## Problem
What's broken or missing. One paragraph.

## Acceptance criteria
- Bullet list of concrete, testable conditions.

## Out of scope
- Things this item is **not** doing. Prevents scope creep.

## Plan
Short bullets. Detailed implementation notes can live in PRs / commits.

## Test plan
How we'll know it works. Reference specific test files where possible.

## Links
- ADR: docs/adr/NNNN-...md (if architectural)
- PRD section: docs/PRD-v2.md §...
- Related items: GIAN-XXX
```

When work item lands, update `docs/quality/traceability.md` with the
requirement → code → test mapping.
