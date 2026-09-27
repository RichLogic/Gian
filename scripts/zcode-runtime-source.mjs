import source from '../packages/proxies/zcode-proxy/src/runtime/source.json' with { type: 'json' };

export const zcodeRuntimeSource = Object.freeze(source);

/** The source lock ships with the Proxy; a newer upstream branch/tag is never
 * an implicit upgrade of an already released Proxy. */
export function validateZcodeRuntimeSource(value = source) {
  if (value?.schemaVersion !== 1
    || value.integrationVersion !== 1
    || !/^[a-f0-9]{64}$/.test(value.protocolEntrypointSha256 ?? '')
    || value.repository !== 'https://github.com/zai-org/ZCode.git'
    || !/^[a-f0-9]{40}$/.test(value.commit ?? '')
    || !/^\d+\.\d+\.\d+$/.test(value.cliVersion ?? '')
    || !/^\d+\.\d+\.\d+$/.test(value.nodeVersion ?? '')
    || !/^\d+\.\d+\.\d+$/.test(value.pnpmVersion ?? '')
    || !/^[a-f0-9]{64}$/.test(value.lockfileSha256 ?? '')
    || value.platform !== 'darwin-arm64'
    || value.entryRelativePath !== 'zcode/agent/zcode.cjs') {
    throw new Error('ZCode source lock is invalid.');
  }
  return value;
}

export function assertZcodeSourceBinding(candidate) {
  validateZcodeRuntimeSource();
  if (!candidate || candidate.version !== source.cliVersion
    || candidate.format !== 'tar.gz'
    || candidate.entryRelativePath !== source.entryRelativePath
    || Object.keys(candidate.source ?? {}).length !== Object.keys(source).length
    || Object.entries(source).some(([key, value]) => candidate.source?.[key] !== value)) {
    throw new Error('ZCode Runtime is not bound to this Proxy\'s pinned Git source and layout.');
  }
}
