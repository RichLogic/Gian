# Official Catalog source

Local documentation mirror for the signed Catalog source managed in
`RichLogic/Gian-Proxy-Catalog`. Catalog metadata Releases remain separate from
the App and executable Proxy assets in `RichLogic/Gian`. This tree describes
the currently visible official Proxies:

| Plugin ID | Product name | Version |
|---|---|---|
| `claude` | Claude Code | 0.2.4 |
| `codex` | Codex | 0.2.16 |
| `kimi` | Kimi Code | 0.2.10 |
| `ai.deepseek.harness` | DeepSeek Harness | 0.1.6 |
| `com.zhipu.zcode` | ZCode | 0.1.1 |

`io.gian.fixture` and `grok` are not official Catalog source entries.
`grok` remains a shipped executor but is hidden from the product surface.

This checked-in source remains **documentation-only** until independently
certified immutable Proxy releases exist. Stable artifact coordinates are added
only from `scripts/prepare-catalog-coordinate.mjs` output bound to those exact
public bytes in `RichLogic/Gian`. The compiler must not invent GitHub URLs,
sentinel hashes, or sizes. See
`docs/operations/proxy-catalog-publication.md`.

## Quality

```bash
pnpm catalog:verify
```

That command compiles with an ephemeral test key only. It never writes or
generates the production private key.

## Compile (does not publish)

```bash
GIAN_CATALOG_SIGNING_KEY_PEM="$(cat /path/to/protected.pem)" \
  node scripts/compile-official-catalog.mjs \
    --sequence 1 \
    --issued-at 2026-09-02T00:00:00.000Z \
    --out /tmp/gian-catalog-bundle
```

Publication to GitHub, Releases, tags, or uploads is **not authorized**
from this worktree.

## External publication blocker

The production Host pins public key
`8721796e6bdf8798804745396bd2181cd999f261d077f09a6fdaa180091344df`
(`keyId` `gian-official-catalog-2026-09`). The matching private key is
stored only as the protected `RichLogic/Gian-Proxy-Catalog` Actions secret
`GIAN_CATALOG_SIGNING_KEY_PEM`. The repository cannot export or print it.
This repository cannot otherwise prove that
the matching private key exists, is protected, and is owned outside the
runtime. Do not generate a production key here. Do not commit a production
key. Treat missing provenance as an external publication blocker.
