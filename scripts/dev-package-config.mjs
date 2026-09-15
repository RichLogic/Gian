export function devPackageConfiguration(base, sha, icon, version) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('A precise source SHA is required');
  if (!version) throw new Error('An app version is required');
  return {
    ...base, extends: null,
    appId: 'com.gian.desktop.dev', productName: 'GianDev',
    artifactName: `GianDev-${version}-${sha.slice(0, 12)}-\${arch}.\${ext}`,
    extraMetadata: { gianReleaseChannel: 'dev', gianBuildSha: sha },
    forceCodeSigning: false, publish: null,
    mac: {
      ...base.mac, icon, identity: '-', notarize: false, hardenedRuntime: true,
      entitlements: 'resources/entitlements.dev.plist',
      entitlementsInherit: 'resources/entitlements.dev.plist',
    },
  };
}

export function assertDevSigningEntitlements(entitlements) {
  for (const key of ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation']) {
    if (entitlements?.[key] !== true) throw new Error(`Ad-hoc GianDev is missing entitlement: ${key}`);
  }
}

export function requireDevOAuthClientId(value) {
  const clientId = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(clientId)) {
    throw new Error('GIAN_GITHUB_CLIENT_ID must be configured with a valid OAuth client id before Dev packaging');
  }
  return clientId;
}

export function assertDevOAuthConfiguration(config, expectedClientId) {
  const actual = requireDevOAuthClientId(config?.clientId);
  if (actual !== requireDevOAuthClientId(expectedClientId)) {
    throw new Error('Packaged OAuth client id differs from the Dev build configuration');
  }
}
