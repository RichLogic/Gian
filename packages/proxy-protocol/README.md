# Gian Proxy Protocol

The versioned JavaScript/TypeScript contract shared by Gian Host and its Proxy
implementations. Node.js 24 is the supported delivery runtime.

## Public package

Public `RichLogic/Gian` publishes `proxy-protocol-vX.Y.Z` releases containing
`gian-proxy-protocol-X.Y.Z.tgz`, `protocol-package.json` and `SHA256SUMS`.
Consumers use the exact archive URL and lockfile integrity, not a branch,
`latest` URL, private checkout or temporary GitHub CDN URL. The package does
not require npm registry publication or authentication to download.

```ts
import { PROTOCOL_NAME, SUPPORTED_PROTOCOL_VERSIONS } from '@gian/proxy-protocol';
import { manifestSchema } from '@gian/proxy-protocol/schemas';
import { HostProtocolValidator } from '@gian/proxy-protocol/conformance';
import { isRuntimeBootstrapOffer } from '@gian/proxy-protocol/node';
```

The archive contains compiled implementation, declarations and exact runtime
dependency versions. It does not contain an Agent CLI, credentials, a Host,
Proxy executables or an App. The `node` subpath is explicitly Node-only; the
root also exports Node-backed helpers and is not a browser compatibility claim.

Package SemVer is independent of the `gian.proxy` wire versions. A package
upgrade does not grant support for a wire version or optional capability that
the peer did not negotiate.
