# WritCraft 0.3.1

WritCraft 0.3.1 is an evaluation-fix batch on top of the 0.3.0 transparent AI
collaboration preview for macOS. It adds no new product capability; it hardens
existing behavior after a five-dimension evaluation of the 0.3.0 candidate.

## What is new

This release contains no new entry point, panel, or AI capability. The changes
in the release commit are:

- **Watcher read authority settled before reads.** `writcraft:project:read` now
  settles watcher read authority before reading, the same posture already used
  by the trash, navigation, and daily-workspace reads. A reader therefore never
  observes a half-committed tree while a mutation is in flight (evaluation
  P2-7).
- **API-key storage threat model documented.** `SECURITY.md` records the
  accepted tradeoff for plaintext `0600` API-key storage and the Keychain
  upgrade path (security P2-1). The accepted threat boundary is unchanged: an
  active same-UID process defeating owner-only private storage remains out of
  scope.
- **0.4 component gate instructions added to the status ledger.** The explicit
  gate-run list for the 0.4 component tests — which are deliberately absent from
  the default `npm test` — plus the CI ordering.

The 0.3.1 version number also carries an accumulated 2026-08-16 fix campaign
that had already landed on `main` across five evaluation dimensions: repo
hygiene; E2E force gates; IPC/chat contracts; capability-store hardening
(ownerId/instanceId/random ids/capacity); network error classification and
bounded retry; native `strcpy` guards; watcher and diagnostics; strict mode;
gate-chain consolidation including `verify:syntax` and the CI workflow;
Renderer helper extraction and `readState` convergence; dialog unification;
global error observation; dead-code removal; and documentation governance.

## Safety and scope

AI output remains preview-only until the author explicitly confirms a Diff.
`edit.md`, source files, and project rules remain read-only within AI generation
and review. This release does not add Autopilot, autonomous book generation,
cloud collaboration, cross-project memory, or an external Research engine, and
it does not change any frozen 0.1.x–0.3.0 contract.

The package is distributed under the WritCraft Proprietary Evaluation License
1.0.

## Install

```bash
npx writ-craft@preview
npx writ-craft@preview --check
```

Requires macOS 12+, Node.js 22.12+, and npm 10 or 11. **npm 12 is outside this
preview contract** because it no longer honors dependency shrinkwraps; use
`@preview` explicitly. `latest` remains `0.1.0` and is not moved by this
release.

## Publication

Published to npm `preview` on **2026-08-16** as `writ-craft@0.3.1`.

- Registry: `preview: 0.3.1`, `latest: 0.1.0`
- Registry `time["0.3.1"]`: `2026-08-16T07:47:18.410Z`
- Shasum: `43ff6081e6c6229818a8219e10bcbaa714cff7e5`
- Integrity: `sha512-q4SwbH+iyByC/3uO8A4NM2u0PkglU6XRPDRzRXkzVYnfbwui0NdW5P2ndLOJMnF9+c4IkfHPQS0k14/9Hfvitw==`
- Tarball: https://registry.npmjs.org/writ-craft/-/writ-craft-0.3.1.tgz
- Packed contents: 185 files, 5,862,961 bytes unpacked
- Release commit: `74bc497` (`release: bump to writ-craft 0.3.1 (evaluation fix batch)`)

This remains a macOS Developer Preview. No signed App/ZIP distribution is
included, and no Apple Developer ID signing or notarization is claimed.

## Notes on this record

The npm publication on 2026-08-16 was not accompanied by a `v0.3.1` git tag or
a release note at the time; the tag was created retrospectively at the release
commit, and this note was written afterwards. Two consequences worth stating
plainly:

- The tag points at `74bc497`, which is the exact tree that was published. This
  note is **not** part of that tree, because published history is never
  rewritten.
- Whether an isolated `verify:npm-preview:installed` run was performed for 0.3.1
  is **not recorded** in this repository. That is a genuine gap, tracked as an
  open item in [`../v0/DEVELOPMENT-STATUS.md`](../v0/DEVELOPMENT-STATUS.md),
  rather than silently assumed green.

The current public version is `0.3.1`. The next target version, 0.4.0
("evidence and delivery closure"), is **not** released; it is under development
and its checkpoints are signed at the code/integration layer only. See
[`ROADMAP.md`](ROADMAP.md) and [`ROADMAP-0.4.0.md`](ROADMAP-0.4.0.md).
