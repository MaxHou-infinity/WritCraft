# WritCraft V0 · npm Developer Preview v1

> Status: the 0.0AD proprietary-evaluation candidate was signed locally on 2026-07-29 after implementation, full regression, real-Electron, installed-tarball verification, three independent reviews with P0/P1/P2=0, and documentation/Git/Nowledge closeout. Candidate commit `3390a86`; tarball shasum `a9cb1c4c02639dda213fec3922a204337a8291f9`. Public registry publication and the external acceptance gates below remain open.

## Distribution boundary

The first distributable candidate is a macOS-only npm Developer Preview, not the existing ad-hoc App/ZIP. It does not require Apple Developer ID signing or notarization, but it is a technical preview for developers who already have Node.js.

Install and launch:

```bash
npx writ-craft@preview
npx writ-craft@preview --check
```

The package requires macOS 12 or later, Node.js `>=22.12.0`, and npm 10 or 11. The manifest and universal native helpers admit `darwin` on `arm64` and `x64`, and every direct runtime dependency is pinned exactly. On 2026-07-29 the fresh-tarball installed-Renderer matrix passed on official Node 22.22.3/npm 10.9.8 arm64 and Node 24.18.0/npm 11.16.0 x64, 2/2 checks per combination. This evidence closes the pre-publication runtime matrix only; it is not registry publication or post-publication `npx` evidence. `--help`, `--version`, and `--check` must never launch Electron or access the network. A real launch may obtain the checksum-verified Electron runtime from cache or the configured download source if it is not already present. `--profile <absolute-directory>` selects an existing owner-private profile under the current home directory for isolated acceptance or deliberate profile separation.

## Package invariants

- Publish only `bin/`, production `src/main/`, production `src/renderer/`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, the manifest, and the shrinkwrap.
- Publish `npm-shrinkwrap.json` so supported npm 10/11 clients resolve the reviewed dependency graph. npm 12 is outside this preview contract because it no longer honors dependency shrinkwraps; it requires a separately reviewed bundling or installer strategy.
- Never publish tests, fixtures, `.env`, release archives, status documents, project manuscripts, user data, or credentials.
- The CLI accepts no forwarded Chromium switches. Its only path input is `--profile`: the leaf must already exist as a normal directory under the current home directory, belong to the current user, deny group/world access, reject permissive macOS ACLs, and have a canonical, current-user-owned, non-group/world-writable ancestor chain before Main independently revalidates it. A process already running as the same user remains inside the accepted local-account threat boundary.
- The CLI fails closed below macOS 12 and when environment variables can replace the Electron runtime, platform, architecture, version, or checksum authority.
- The package must include executable universal author-copy, project-hash, and Markdown-trash helpers.
- On 2026-07-29 the owner selected `WritCraft Proprietary Evaluation License 1.0`; the manifest uses `SEE LICENSE IN LICENSE`. It grants personal or internal evaluation, including bounded access by an organization's authorized evaluators, and prohibits production use, commercial delivery, hosted service, resale, and external redistribution. `THIRD_PARTY_NOTICES.md` preserves licenses for vendored browser bundles; npm-installed dependencies retain the licenses and notices shipped in their own packages.
- A read-only registry query on 2026-07-29 returned `E404` for `writ-craft`, so no public package was visible at that moment. This is not a reservation and may race with another publisher. `npm whoami` succeeded as `houxyue`; no credential or token is recorded. Publishing remains an external write and requires explicit authorization bound to the final candidate.

## Version and rollback

npm versions are immutable. Every candidate must use a new version and publish
only to the `preview` dist-tag; the manifest fixes this with
`publishConfig.tag=preview`. Never overwrite a version or publish this V0 to
`latest`.

To roll back, move `preview` to the last independently signed version with
`npm dist-tag add writ-craft@<known-good-version> preview`, verify
`npx writ-craft@preview --check`, and deprecate the bad version with a bounded
reason. Do not use unpublish as the normal rollback mechanism.

## Sign-off

Before a preview tag is published:

1. run `npm test`, Electron-enabled `npm run verify`, forced real-Electron E2E, persistent Main/IPC, and `npm run verify:npm-preview`;
2. run `npm audit --omit=dev` against the candidate dependency graph and require zero known production vulnerabilities; repeat this audit for every candidate and immediately before publication;
3. run `npm run verify:npm-preview:installed` against the generated tarball, proving the public CLI receives Main's exact IPC after `did-finish-load`, uses only the isolated profile, forwards termination, and leaves no child process; this proves page load, not every workspace/bootstrap behavior;
4. complete the fresh-tarball install, `--check`, Main-observed page-load IPC, signal/exit, and cleanup matrix on npm 10/arm64 and npm 11/x64; an unavailable or failing combination blocks public preview publication;
5. complete an independent code/package review with P0/P1 closed;
6. confirm the owner-selected WritCraft license, reserve the package name, authenticate the intended npm account, and publish only an explicit preview tag;
7. after publication, repeat installation and startup through `npx writ-craft@preview` in a clean directory.

This route does not waive real-author acceptance, image review, privacy, or source-integrity gates.
