# Security hardening rollout

This branch changes the launcher/authentication contract and requires a coordinated deployment. It is not a standalone release.

## Changes

- Verify every downloaded archive before use; reject corrupted files even when the size matches.
- Require an Ed25519-signed distribution containing SHA-256 artifact digests. Restrict artifact hosts, paths and linked directories.
- Keep download authorization in memory; remove plaintext mod caches after sealing and clean only owned regular files.
- Require OS-backed secret storage, redact nested credentials, bind Microsoft OAuth to state and PKCE, revoke Rolynk sessions on logout.
- Verify checkout ownership and server-side fulfillment before presenting payment success.
- Restrict navigation, IPC senders and popup permissions; escape account/server values and sanitize overlay HTML.
- Update dependencies and apply reviewed Helios patches deterministically during npm install.

## Manifest publication

The public verification key is in vendor/helios-core/distribution-trust.json. The corresponding private key must remain outside Git and outside the web root. The operator must securely back it up before releasing a client pinned to this key.

1. Generate the unsigned candidate with tools/gen-distro.js. It writes distribution.unsigned.json.
2. On the trusted publishing machine, run:

       node tools/sign-distribution.cjs distribution.unsigned.json /path/to/web-root /secure/private.pem distribution.signed.json SEQUENCE

3. Inspect the candidate, verify all artifacts are available, then atomically publish it as distribution.json.
4. Increase SEQUENCE for each publication. Signatures expire after 30 days; renew before expiry even when the pack is unchanged.
5. Publish the signed manifest before distributing this launcher. Existing clients ignore the extra metadata; this client refuses an unsigned or expired manifest.

Do not change helios-core without reviewing and regenerating vendor/helios-core/manifest.json. The postinstall script rejects unexpected upstream source files.

## Validation

Run npm ci, npm run test:security and npm audit. The security workflow tests Windows and Linux; the release workflow also runs the tests and audit before packaging.

For a real Electron startup test, run Electron with tools/smoke-startup.cjs and an optional signed manifest path. It uses a temporary profile, hidden window and no player accounts.

## Remaining release requirements

The renderer still uses nodeIntegration and @electron/remote. CSP, output sanitization and navigation restrictions reduce exposure but do not replace an isolated renderer and a narrow preload API. That migration remains open.

Authenticode/notarization credentials and updater publisher verification still need to be configured and validated by the release operator. This branch does not contain a signing certificate.

Validate Microsoft login, Discord linking, launch, game exit and checkout with dedicated test accounts on the coordinated backend before release. Backend sources, financial migration inventories and private audit notes are deliberately kept out of this public repository.
