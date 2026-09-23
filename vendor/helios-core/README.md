# Reviewed helios-core patches

Upstream: helios-core 2.3.0 by Daniel Scalzi, https://github.com/dscalzi/helios-core, LGPL-3.0-only. The upstream license is retained in LICENSE.

The JavaScript files listed in manifest.json are modified copies of the upstream dist files, changed on 2026-09-23 for:

- mandatory download size and digest verification before installation;
- confined paths and refusal of linked destinations;
- signed distribution verification, SHA-256 module hashes and bounded manifest retrieval;
- in-memory download authorization and verified encrypted-cache reuse;
- PKCE in the Microsoft authorization-code exchange.

rolynk-security.js and distribution-signature.js provide the added validation helpers. distribution-trust.json contains only the public verification key.

tools/patch-helios.cjs checks the upstream version and original file digests before applying these sources. Install a clean upstream package before revising a previously installed patch. The application includes these modified sources so the library changes remain inspectable.
