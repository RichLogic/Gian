# Gian Proxies

Official independently released Gian Proxy packages and the signed Proxy Catalog.
Development is integrated in GianDev; this public repository is a reproducible
source export, not a copy of private Git history.

## Contents

- Claude, Codex, Kimi, DSH and ZCode shipping Proxies, each independently versioned.
- Release versions come from each Proxy package on GianDev main. Export does
  not assign a repository-wide version or automatically bump Proxy versions.
- Grok source remains non-shipping. Its presence does not authorize a release.
- DSH Proxy includes its exact Bridge rather than relying on an App-bundled copy.
- Catalog source, Markdown documentation, logos, compiler and signing workflows.
- Exact public `@gian/proxy-protocol` archive dependency from RichLogic/Gian.
- Shared support source and the production Runtime extractor snapshot. No Host,
  Web, Desktop or private protocol checkout is needed to build this product.

## Build and release

Use Node 24.14.0 and the pinned pnpm version. `pnpm install --frozen-lockfile` followed
by `pnpm build` builds the standalone product. No Provider credentials are needed.

`release-selection.json` explicitly selects the Proxies to build, qualify and
publish. Its signed base Catalog is verified against the existing pinned key;
unselected Proxies retain their complete immutable executable and certificate
coordinates. A subset release never rebuilds, retags or republishes an excluded
Proxy. The final Catalog must preserve the plugin set and every excluded stable
tuple exactly. Update the selection in GianDev before exporting source.

1. Dispatch **Qualify Proxy Artifacts** on main. The hosted macOS ARM64 workflow
   verifies source provenance, compiles, exercises Proxy contracts with fake
   Runtimes, verifies exact managed Runtime candidates with the production
   extractor, builds archives once and self-tests their extracted entry points.
2. Create each immutable `proxy-<releaseId>-v<version>` tag at that qualified
   public commit. Dispatch **Publish Certified Proxies** with its run ID. The
   publisher authenticates the run and rehashes the downloaded artifact; it does
   not rebuild. Existing releases must match byte-for-byte or publication fails.
3. Create `catalog-v1.<sequence>.0` at the intended main source commit. Dispatch
   **Publish Signed Catalog** with the qualification run, sequence and explicit
   issue time. It checks published assets, compiles the Catalog and verifies the
   signature with the pinned App public key before publication.

The Catalog-production environment requires the existing
`GIAN_CATALOG_SIGNING_KEY_PEM` Secret. Never regenerate the signing key, put it
in a repository or send it through chat. Proxy build jobs do not receive it.
The first migrated Catalog sequence must exceed the legacy source's sequence 6.
Catalog consumers select `catalog-v1.*`; they must not use the repository's
generic latest release as a Proxy version. Proxy releases use `--latest=false`.

Certificates bind actual bytes and explicitly exclude App/Desktop acceptance,
Host/Web journeys and real Provider turns. Those are separate consumer checks,
not invented successful stages in this product's certificate. ZCode's managed
CLI is built from the full Git commit in its `src/runtime/source.json`, using
the pinned toolchain and frozen dependency lock. Its complete distribution and
source provenance are repacked as a Host-compatible archive. Qualification
checks the extracted entry, Provider resources and app-server catalog boundary;
an upstream protocol mismatch blocks publication even when `--version` works.
Published Runtime archives are copied from qualification, never rebuilt by
the publisher. Updating the source pin requires a new Proxy release.

The 0.4.1 candidate pins CLI 0.16.9 and includes a versioned integration layer
for model metadata and standalone authentication. Proxy requests use complete
model/reasoning selections. The layer's input source hash and resulting source
digests are checked/recorded; upstream changes require renewed review.
This source candidate still requires hosted qualification and real-provider
acceptance before it can be described as a verified usable combination.
Before Catalog publication, capture the newly published release/Manifest and
Runtime coordinate in `catalog/proxy-information/evidence/` and author its
history entry. Historical snapshots must not be filled with invented hashes.

## Updates

Change source in GianDev and export an integrated commit with
`node scripts/export-proxies.mjs --ref main --output <new-empty-directory>`.
The exporter uses the platform Ruby YAML parser to retain locked dependency
versions and writes standard YAML-compatible JSON. Never hand-edit generated
snapshot files in this repository or overwrite an existing immutable release.
Catalog publication that introduces executable changes requires fresh Proxy
qualification. A documentation-only refresh instead uses **Publish Catalog
Documentation** with an already published signed Catalog: verify the pinned
signature, recheck public artifact and certificate digests, recompile, require
every complete stable/executable tuple to remain identical, and sign a higher
sequence. This path cannot add/remove a Proxy or change Runtime, Manifest,
artifact or certificate coordinates. It does not renew or rewrite the old
certificate; the normal Proxy publication freshness checks remain unchanged.

Author tutorials and structured history in `catalog/proxy-information/`. Catalog
publication validates that source and its certified Runtime snapshot, then
projects nine chapters into v1 setup/usage/troubleshooting and history Markdown
into overview in the temporary compilation input. The signed wire schema and
existing immutable Proxy coordinates stay unchanged. A dedicated App history
view is a separate consumer change; basic.md contains review examples, not
installed-state data. Publication runs the focused projection checks in CI.

Old Gian and Gian-Proxy-Catalog releases remain available during migration.
Publishing here does not change any installed App's trusted source or data.
