// One-off helper: seed a local-only GitHub credential for the GianDev
// (unpackaged) desktop variant so the onboarding gate can pass without a
// configured OAuth client ID. The token is a dummy — Gian only uses it as a
// local identity gate; proxy artifacts are downloaded over plain HTTPS.
// Revert: delete ~/Library/Application Support/GianDev/github-auth.json
const { app, safeStorage } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const userData = join(homedir(), 'Library', 'Application Support', 'GianDev');
// Must match packages/desktop/src/main.ts so safeStorage derives the same
// Keychain key ("GianDev Safe Storage") as the real dev app.
app.setName('GianDev');
app.setPath('userData', userData);

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('safeStorage encryption unavailable');
    app.exit(1);
    return;
  }
  const credential = {
    version: 1,
    encryptedToken: safeStorage.encryptString('gian-dev-local-only-token').toString('base64'),
    user: {
      id: 29032192,
      login: 'RichLogic',
      name: null,
      avatarUrl: 'https://avatars.githubusercontent.com/u/29032192?v=4',
      profileUrl: 'https://github.com/RichLogic',
    },
    savedAt: new Date().toISOString(),
  };
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, 'github-auth.json'), `${JSON.stringify(credential)}\n`, { mode: 0o600 });
  console.log('seeded', join(userData, 'github-auth.json'));
  app.exit(0);
});
