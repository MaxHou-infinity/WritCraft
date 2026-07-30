# WritCraft V0 · npm Developer Preview v1

> Status: `writ-craft@0.1.1` was published to the explicit npm `preview` tag on 2026-07-29 from candidate commit `c65981e`; registry shasum `d370c500666e25cfb373852deafa21b232d2bc18` exactly matches the signed candidate. Public-registry install/start/exit cleanup passed 2/2. Git tag `v0.1.1` points to the same candidate and its GitHub Release is a prerelease, not latest. Registry tags are intentionally split: `preview: 0.1.1`, `latest: 0.1.0`.

## Distribution boundary

The first distributable candidate is a macOS-only npm Developer Preview, not the existing ad-hoc App/ZIP. It does not require Apple Developer ID signing or notarization, but it is a technical preview for developers who already have Node.js.

Install and launch:

```bash
npx writ-craft@preview
npx writ-craft@preview --check
```

The package requires macOS 12 or later, Node.js `>=22.12.0`, and npm 10 or 11. The manifest and universal native helpers admit `darwin` on `arm64` and `x64`, and every direct runtime dependency is pinned exactly. On 2026-07-29 the fresh-tarball installed-Renderer matrix passed on official Node 22.22.3/npm 10.9.8 arm64 and Node 24.18.0/npm 11.16.0 x64, 2/2 checks per combination. This evidence closes the pre-publication runtime matrix only; it is not registry publication or post-publication `npx` evidence. `--help`, `--version`, and `--check` must never launch Electron or access the network. A real launch may obtain the checksum-verified Electron runtime from cache or the configured download source if it is not already present. `--profile <absolute-directory>` selects an existing owner-private profile under the current home directory for isolated acceptance or deliberate profile separation.

On 2026-07-30 exact candidate `9a05c44` repeated npm Preview **10/10**, local installed **2/2**, and fresh-tarball installed **2/2** on each of the same official npm 10/arm64 and npm 11/x64 combinations; the production audit reported **0 vulnerabilities**. Its dry-run package is **120 files / 573,745 bytes packed / 2,626,999 bytes unpacked / shasum `4e41acaa8803efdbc093bb4ea72140d1b34fc768`**. This proves only local candidate packaging and runtime preparation. It is not a completed real-author journey, registry publication, GitHub Release, or permission to move any dist-tag.

## Package invariants

- Publish only `bin/`, production `src/main/`, production `src/renderer/`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, the manifest, and the shrinkwrap.
- Publish `npm-shrinkwrap.json` so supported npm 10/11 clients resolve the reviewed dependency graph. npm 12 is outside this preview contract because it no longer honors dependency shrinkwraps; it requires a separately reviewed bundling or installer strategy.
- Never publish tests, fixtures, `.env`, release archives, status documents, project manuscripts, user data, or credentials.
- The CLI accepts no forwarded Chromium switches. Its only path input is `--profile`: the leaf must already exist as a normal directory under the current home directory, belong to the current user, deny group/world access, reject permissive macOS ACLs, and have a canonical, current-user-owned, non-group/world-writable ancestor chain before Main independently revalidates it. A process already running as the same user remains inside the accepted local-account threat boundary.
- The CLI fails closed below macOS 12 and when environment variables can replace the Electron runtime, platform, architecture, version, or checksum authority.
- The package must include executable universal author-copy, project-hash, and Markdown-trash helpers.
- On 2026-07-29 the owner selected `WritCraft Proprietary Evaluation License 1.0`; the manifest uses `SEE LICENSE IN LICENSE`. It grants personal or internal evaluation, including bounded access by an organization's authorized evaluators, and prohibits production use, commercial delivery, hosted service, resale, and external redistribution. `THIRD_PARTY_NOTICES.md` preserves licenses for vendored browser bundles; npm-installed dependencies retain the licenses and notices shipped in their own packages.
- Before publication, a read-only registry query returned `E404` for
  `writ-craft`; that was historical preflight evidence, not a reservation.
  The authenticated owner later published the exact signed candidate. No
  credential or token was recorded.

## Version and rollback

npm versions are immutable. Every candidate must use a new version and publish
with the explicit `preview` dist-tag; the manifest fixes this with
`publishConfig.tag=preview`. The public registry package object requires at
least one `latest` entry, so the first and only version may also be exposed as
`latest` even when publication explicitly used `preview`. This registry alias
does not confer stable status: documentation and acceptance must use
`writ-craft@preview`, and a future stable release requires a new independently
signed version.

The 0.0AF closeout did not unpublish `0.1.0` or publish a placeholder version
to manipulate `latest`. Those destructive substitutes must not be used to hide
the registry-required alias.

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
