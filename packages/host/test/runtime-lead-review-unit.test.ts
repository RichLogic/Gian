import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyRuntimeVersion } from '../src/runtime/classify-version.js';
import { isAuthorizedConfigHome } from '../src/runtime/config-home.js';
import { isGenericRuntimeProtocol } from '../src/runtime/launch-mode.js';
import { isPublicHttpsSetupUrl } from '../src/runtime/setup-url.js';

test('launch mode selects generic only from trusted v4/bootstrap facts', () => {
  assert.equal(isGenericRuntimeProtocol({ schemaVersion: 4 }), true);
  assert.equal(isGenericRuntimeProtocol({ runtimeBootstrap: true, schemaVersion: 3 }), true);
  assert.equal(isGenericRuntimeProtocol({ schemaVersion: 3 }), false);
  assert.equal(isGenericRuntimeProtocol({ schemaVersion: 2 }), false);
  assert.equal(isGenericRuntimeProtocol(undefined), false);
});

test('version policy pins exact SemVer facts', () => {
  assert.equal(classifyRuntimeVersion('1.2.3+build.1', ['1.2.3+build.1']), 'verified');
  assert.equal(classifyRuntimeVersion('1.2.3', ['1.2.3+build.1']), 'unverified');
  assert.equal(classifyRuntimeVersion('0.9.0', ['1.0.0-rc.1', '1.0.0']), 'incompatible');
});

test('configHome allows user temp dot-dirs and rejects system roots', () => {
  const home = '/var/folders/xx/test-home';
  const selected = `${home}/.local/bin/kimi`;
  assert.equal(isAuthorizedConfigHome(`${home}/.kimi-code`, selected, home), true);
  assert.equal(isAuthorizedConfigHome(`${home}/Documents`, selected, home), false);
  assert.equal(isAuthorizedConfigHome('/etc', selected, home), false);
  assert.equal(isAuthorizedConfigHome('/usr/bin', '/usr/bin/tool', home), false);
  assert.equal(isAuthorizedConfigHome('/etc', '/etc/tool', home), false);
  assert.equal(isAuthorizedConfigHome('/var/log', selected, home), false);
  assert.equal(isAuthorizedConfigHome('/', selected, home), false);
});

test('setup URL table accepts public hostnames and rejects reserved literals', () => {
  const accepted = [
    'https://example.com/setup',
    'https://code.kimi.com/kimi-code/install.sh',
    'https://claude.ai/install.sh',
  ];
  const rejected = [
    'https://localhost/install',
    'https://127.0.0.1/install',
    'https://[0:0:0:0:0:0:0:1]/install',
    'https://[fd12:3456:789a::1]/install',
    'https://[fe80::abcd]/install',
    'https://[::ffff:192.168.0.1]/install',
    'https://[2001:db8::1]/install',
    'https://[2001:2::1]/install',
    'https://100.64.1.2/install',
    'https://198.51.100.1/install',
    'https://203.0.113.1/install',
    'https://example.com:8443/install',
    'https://user@example.com/install',
    'https://[fec0::1]/install',
    'https://[2002:c0a8:1::1]/install',
    'https://[2001:0:4136:e378:8000:63bf:3ffd:fdd2]/install',
    'https://[64:ff9b::192.0.2.1]/install',
    'https://[64:ff9b:1::1]/install',
    'https://[100::1]/install',
    'https://[2001:10::1]/install',
    'https://[2001:20::1]/install',
  ];
  for (const url of accepted) assert.equal(isPublicHttpsSetupUrl(url), true, url);
  for (const url of rejected) assert.equal(isPublicHttpsSetupUrl(url), false, url);
});

test('configHome rejects global temp trees and HOME itself', () => {
  const home = '/Users/tester';
  const selected = `${home}/.local/bin/tool`;
  assert.equal(isAuthorizedConfigHome('/tmp/.tool', selected, home), false);
  assert.equal(isAuthorizedConfigHome('/var/folders/xx/tmp/.tool', selected, home), false);
  assert.equal(isAuthorizedConfigHome('/private/tmp/.tool', selected, home), false);
  assert.equal(isAuthorizedConfigHome('/private/var/folders/xx/tmp/.tool', selected, home), false);
  assert.equal(isAuthorizedConfigHome(home, selected, home), false);
  assert.equal(isAuthorizedConfigHome('/private', selected, home), false);
  assert.equal(isAuthorizedConfigHome(`${home}/Documents`, selected, home), false);
  assert.equal(isAuthorizedConfigHome(`${home}/.tool`, selected, home), true);
});
