# Remote Protocol package

## [1.2.0]

- Adds verified GitHub account admission schemas and account-bound Host enrollment.
  Enrollment tokens expire after five minutes and may only be consumed once.
- Adds local-Session/remote-execution commands, durable execution history,
  takeover, catalog/configuration contracts, scoped file previews and read-only Git.
- Publishes the reusable encrypted controller client and transport helpers.
- Native execution requires the negotiated `wire.execution_v1` capability and
  same-account authentication. Deploy compatible Server, Web and Gian clients;
  legacy unbound Host credentials do not bypass the new account gate.

## [1.1.0]

- Adds the read-only `proxy.logo` command method: closed params (`proxy` name + `light`/`dark` variant) and result (`media_type`, `data_base64` ≤ 128 KiB raw, `sha256`) schemas so Remote clients can render Proxy branding logos without Host HTTP access.
- Adds the `RESOURCE_NOT_FOUND` error code. Hosts predating the method reject it as `INVALID_FRAME`, so mixed-version peers keep working.
- Backward compatible with 1.0.0 peers: no existing schema, method or capability shape changed.

## [1.0.0]

- Initial standalone `@gian/remote-protocol` package distributed through public Gian GitHub Releases.
- Includes compiled JavaScript and TypeScript declarations for Remote authentication, relay, business messages, cryptography and hello negotiation.
- Pins the runtime dependencies used to qualify the package; consumers can install its release archive without accessing GianDev or copying protocol source.
- Package versioning is independent of Gian Desktop, Gian Remote and wire-protocol revisions.
