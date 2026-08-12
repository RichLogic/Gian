const SYSTEM_LIBRARY_PREFIXES = ['/System/Library/', '/usr/lib/'];

export function parseOtoolLibraries(output) {
  const lines = String(output).split(/\r?\n/);
  const header = lines.shift()?.trim() ?? '';
  if (!header.endsWith(':')) {
    throw new Error('otool output is missing the inspected binary header.');
  }

  const libraries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(.+?)\s+\(compatibility version [^)]+\)$/);
    if (!match) throw new Error(`could not parse otool dependency line: ${line.trim()}`);
    libraries.push(match[1]);
  }
  if (libraries.length === 0) {
    throw new Error('otool did not report any Node runtime dependencies.');
  }
  return libraries;
}

export function isPortableMacLibrary(path) {
  return SYSTEM_LIBRARY_PREFIXES.some(prefix => path.startsWith(prefix));
}

export function assertPortableMacNodeRuntime(otoolOutput) {
  const libraries = parseOtoolLibraries(otoolOutput);
  const external = libraries.filter(path => !isPortableMacLibrary(path));
  if (external.length > 0) {
    throw new Error([
      'Node runtime is not portable: it depends on non-system macOS libraries.',
      ...external.map(path => `- ${path}`),
      'Use the official Node.js 24 macOS arm64 binary before packaging Gian.',
    ].join('\n'));
  }
  return libraries;
}
