/** A local packaging exception is restricted to the ad-hoc GianDev identity.
 * The formal Gian App and every non-Dev electron-builder invocation remain
 * subject to the hosted-only package policy. */
function assertLocalDevPackageContext(context) {
  const config = context?.packager?.config;
  const mac = context?.packager?.platformSpecificBuildOptions;
  if (context?.electronPlatformName !== 'darwin'
    || config?.appId !== 'com.gian.desktop.dev'
    || config?.productName !== 'GianDev'
    || config?.extraMetadata?.gianReleaseChannel !== 'dev'
    || mac?.identity !== '-'
    || mac?.notarize !== false
    || config?.publish !== null) {
    throw new Error('Local App packaging is limited to the ad-hoc, unpublished GianDev configuration.');
  }
}

module.exports = { assertLocalDevPackageContext };
