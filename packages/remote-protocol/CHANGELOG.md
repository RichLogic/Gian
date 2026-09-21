# Remote Protocol package

## [1.1.0]

- Adds the read-only `proxy.logo` command method: closed params (`proxy` name + `light`/`dark` variant) and result (`media_type`, `data_base64` ≤ 128 KiB raw, `sha256`) schemas so Remote clients can render Proxy branding logos without Host HTTP access.
- Adds the `RESOURCE_NOT_FOUND` error code. Hosts predating the method reject it as `INVALID_FRAME`, so mixed-version peers keep working.
- Backward compatible with 1.0.0 peers: no existing schema, method or capability shape changed.

## [1.0.0]

- Initial standalone `@gian/remote-protocol` package distributed through public Gian GitHub Releases.
- Includes compiled JavaScript and TypeScript declarations for Remote authentication, relay, business messages, cryptography and hello negotiation.
- Pins the runtime dependencies used to qualify the package; consumers can install its release archive without accessing GianDev or copying protocol source.
- Package versioning is independent of Gian Desktop, Gian Remote and wire-protocol revisions.
