# Gian Remote Changelog

## [1.2.0] - 2026-09-23

- Adds a separate Host registration page at `/enrollment`. Deployment-configured
  GitHub account allowlisting controls enrollment token generation.
- Enrollment tokens are account-bound, single-use and expire after five minutes.
  The command-line administrator path remains available with the same restrictions.
- Browser remote control no longer requires GitHub login. Pairing still needs
  explicit approval on the Host, device-key authentication and end-to-end encryption.
  Browser delegation lasts thirty days and can be revoked; expiry requires pairing again.
- Supports native Gian remote execution with same-account admission, history
  replication, scoped file preview and updated model/configuration controls.

### Upgrade Notes

- Configure `GIAN_REMOTE_GITHUB_CLIENT_ID` and `GIAN_REMOTE_ENROLLMENT_GITHUB_IDS`.
  An empty allowlist denies new Host registrations.
- Existing unbound Host registrations and unused enrollment tokens are not
  implicitly trusted. Compatible Gian clients must complete GitHub authorization
  and register again. Ordinary reconnects after registration do not need a new token.
- The App GitHub credential is not forwarded to a self-hosted Server. Native
  Remote authorization remains separate from the App login.
