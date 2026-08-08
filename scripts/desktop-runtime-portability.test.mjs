import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPortableMacNodeRuntime,
  isPortableMacLibrary,
  parseOtoolLibraries,
} from './desktop-runtime-portability.mjs';

const officialNode = `/tmp/node:
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3038.1.255)
\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61439.1.1)
\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.101.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
`;

const homebrewNode = `/opt/homebrew/bin/node:
\t@rpath/libnode.127.dylib (compatibility version 0.0.0, current version 0.0.0)
\t/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib (compatibility version 3.0.0, current version 3.0.0)
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3038.1.255)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)
`;

test('otool fixture parser keeps complete dependency paths', () => {
  assert.deepEqual(parseOtoolLibraries(officialNode), [
    '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
    '/System/Library/Frameworks/Security.framework/Versions/A/Security',
    '/usr/lib/libc++.1.dylib',
    '/usr/lib/libSystem.B.dylib',
  ]);
});

test('official Node fixture with only macOS system libraries is portable', () => {
  assert.equal(isPortableMacLibrary('/usr/lib/libSystem.B.dylib'), true);
  assert.equal(isPortableMacLibrary('/System/Library/Frameworks/Security.framework/Security'), true);
  assert.doesNotThrow(() => assertPortableMacNodeRuntime(officialNode));
});

test('Homebrew and rpath dependencies are rejected before packaging', () => {
  assert.equal(isPortableMacLibrary('/opt/homebrew/opt/icu4c/lib/libicuuc.dylib'), false);
  assert.equal(isPortableMacLibrary('@rpath/libnode.127.dylib'), false);
  assert.throws(
    () => assertPortableMacNodeRuntime(homebrewNode),
    error => {
      assert.match(error.message, /Node runtime is not portable/);
      assert.match(error.message, /@rpath\/libnode\.127\.dylib/);
      assert.match(error.message, /\/opt\/homebrew\/opt\/openssl@3/);
      assert.match(error.message, /official Node\.js 22 macOS arm64 binary/);
      return true;
    },
  );
});

test('malformed otool output fails closed', () => {
  assert.throws(
    () => assertPortableMacNodeRuntime('/tmp/node:\n\tnot a dependency line\n'),
    /could not parse otool dependency line/,
  );
});
