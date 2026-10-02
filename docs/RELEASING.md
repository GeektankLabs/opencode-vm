# Releasing opencode-vm

## Release artifact contract

Every release whose script references the adapters must publish these assets under the matching `v<OCVM_VERSION>` tag:

- `opencode-vm.sh`
- `opencode-vm-openlive-adapter-<openlive-version>.tar`
- `opencode-vm-mcp-adapter-<mcp-version>.tar`
- `opencode-vm-hub-1.tar`
- `SHA256SUMS`

OpenLive and incoming MCP are independently versioned adapters. They share the script's release tag; the Hub archive contains only the maintained Hub source/UI. `SHA256SUMS` contains one entry for each of the three archives.

The archives are built reproducibly by `scripts/build-openlive-adapter.sh`, `scripts/build-mcp-adapter.sh`, and `scripts/build-agent-hub.sh`. Each tag, filename, version, and SHA-256 is pinned in `opencode-vm.sh`; an installed standalone script never executes a floating branch artifact.

## Release sequence

1. Increment the patch component of `OCVM_VERSION`.
2. Set `OPENLIVE_ADAPTER_TAG`, `MCP_ADAPTER_TAG`, and `HUB_ASSET_TAG` to the matching `v<OCVM_VERSION>` tag.
3. If OpenLive runtime behavior changed, increment `adapters/openlive-acp/package.json`, regenerate its `package-lock.json`, update `ADAPTER_VERSION` in `src/acp/transport.ts`, and update `OPENLIVE_ADAPTER_VERSION` plus `OPENLIVE_ADAPTER_FILENAME` in `opencode-vm.sh`.
4. If MCP adapter behavior changed, increment `adapters/mcp/package.json`, regenerate its `package-lock.json`, update `ADAPTER_VERSION` in `src/types.ts`, and update `MCP_ADAPTER_VERSION` plus `MCP_ADAPTER_FILENAME` in `opencode-vm.sh`.
5. Install locked dependencies with `npm ci --ignore-scripts` in both adapter directories.
6. Build all three archives twice and require byte-for-byte equality:

```bash
scripts/build-openlive-adapter.sh /tmp/openlive-a.tar
scripts/build-openlive-adapter.sh /tmp/openlive-b.tar
scripts/build-mcp-adapter.sh /tmp/mcp-a.tar
scripts/build-mcp-adapter.sh /tmp/mcp-b.tar
scripts/build-agent-hub.sh /tmp/hub-a.tar
scripts/build-agent-hub.sh /tmp/hub-b.tar
cmp /tmp/openlive-a.tar /tmp/openlive-b.tar
cmp /tmp/mcp-a.tar /tmp/mcp-b.tar
cmp /tmp/hub-a.tar /tmp/hub-b.tar
shasum -a 256 /tmp/openlive-a.tar /tmp/mcp-a.tar /tmp/hub-a.tar
```

7. Set `OPENLIVE_ADAPTER_SHA256`, `MCP_ADAPTER_SHA256`, and `HUB_ASSET_SHA256` to those digests and run all validations below.
8. Commit the release candidate locally. Record the exact commit and hand it to the operator; a local commit or successful local checks do not publish a release.
9. The operator pushes that exact candidate commit to `main` through the normal host/IDE workflow. The push and any recovery tag push remain operator actions.
10. Wait for `.github/workflows/release.yml` to validate that commit, create the missing `v<OCVM_VERSION>` tag at that exact commit, and publish all five assets. Apply the release-completion gate below to the same commit.
11. Verify pinned artifact URLs and checksums before announcing the release.

Updating `main` remains a host-side maintainer action because session VMs intentionally have no Git origin credentials. Tag and release publication runs in GitHub Actions.

Because a `main` push starts the release workflow, `main` necessarily contains the candidate while validation is still running. Do not run or announce an update during this window. A failed release workflow is not release availability; diagnose its evidence and follow the repair and re-verification sequence below.

The workflow also accepts a manually pushed `v*` tag as a recovery path. A normal `git push` or IDE "Sync Changes" does not reliably push local tags, so the default process does not create a local tag at all: GitHub creates the tag after every validation passes, then publishes the release. Release jobs are serialized per version, with the running job and latest pending attempt retained. The first successful same-version candidate publishes; later candidates exit without rebuilding only when their script and adapter/Hub build inputs match the published release. An incomplete release, inconsistent tag or asset, unversioned release-input change, or GitHub API failure stops the workflow instead of being mistaken for a successful no-op.

## Release-completion gate and runtime continuity

A candidate is not a completed release until its own pushed commit passes the expected workflow and the corresponding release is verified. Evaluate the exact candidate SHA recorded at local handoff; the branch tip, tag name, push receipt, or a different newer green run is not a substitute.

The gate is **verified green** only when all of the following are evidenced for that candidate:

- The expected release workflow/run has completed successfully, its checked-out/head commit is exactly the candidate SHA, and every required job, validation and publication step has succeeded.
- The `v<OCVM_VERSION>` tag resolves to that same commit.
- The release is published (not draft or prerelease) with all five expected assets from the artifact contract above.
- The published checksum/pin information is consistent with the candidate's validated build inputs. Distinguish checksum metadata or hosted asset digests from a newly downloaded and independently hashed asset; claim the latter only when those bytes were actually read and hashed.

Queued/running, failed, cancelled, missing, inaccessible, incomplete, contradictory or wrong-commit evidence leaves the gate **red or unverified**. Missing evidence is not a pass. Report the candidate SHA, the specific observed run/commit/status and which required release evidence is absent or mismatched. A local test pass, a green run for another commit, or a matching version string alone does not open the gate.

When a failed or incomplete gate needs a repair, identify the failed job/step and supporting log or artifact evidence, then propose the smallest local repair. Make changes or commits only within the already authorized task scope; do not rewrite workflow permissions or release architecture as an improvised fix. A repair that changes the candidate creates a new expected commit: hand off its exact SHA for a new operator push, then verify a new successful run and release evidence against that SHA. The earlier green result does not validate the repaired commit. Pushes, tag writes, release publication/uploads and deployment remain operator-only; do not configure or forward credentials to make them agent actions.

While the expected gate is red or unverified, preserve the working runtime and its recovery state. Do not recommend routine pruning, stopping, fresh starts, restart, reconnect/reattach, recreation, installation/update, or Ctrl+C followed by attach as release troubleshooting. Continue diagnosis and in-scope local repair without interrupting a working runtime when possible. An interruption is an exception only when an explicitly authorized in-scope repair demonstrably requires that specific interruption; state the evidence, why it is technically necessary, and the retained recovery state before acting.

Verified green permits a separate authorized maintenance or acceptance decision; it does not automatically trigger prune/restart, task completion, deployment, announcement or cleanup. Report local candidate/checks, operator push (observed or reported), exact-commit CI/release evidence and any external acceptance as separate facts.

## Validation

```bash
cd adapters/openlive-acp
npm run check
npm run build
npm test
npm run test:integration

cd ../mcp
npm run check
npm run build
npm test
npm run test:integration

cd ../..
actionlint .github/workflows/release.yml
python3 tests/release_metadata_test.py
python3 tests/release_state_test.py
bash -n opencode-vm.sh tests/hub_release_test.sh tests/mcp_adapter_test.sh tests/openlive_test.sh scripts/build-agent-hub.sh scripts/build-mcp-adapter.sh scripts/build-openlive-adapter.sh
shellcheck --severity=error opencode-vm.sh tests/hub_release_test.sh tests/mcp_adapter_test.sh tests/openlive_test.sh scripts/build-agent-hub.sh scripts/build-mcp-adapter.sh scripts/build-openlive-adapter.sh
bash tests/hub_release_test.sh
bash tests/mcp_adapter_test.sh
bash tests/mcp_lock_test.sh
bash tests/openlive_test.sh
git diff --check
```

The release workflow additionally performs these checks:

- A native macOS `/bin/bash` job checks short lock cleanup (including Bash 3.2 EXIT-trap behavior); publication depends on that job. Linux runs the same lock regression.
- It compares two builds of each archive for reproducibility and compares each digest to the script pin.
- It installs production-only dependencies from each extracted package with lifecycle scripts disabled.
- It starts the packaged OpenLive entry point far enough to verify its required runtime descriptor and runs the real OpenCode manager-tool integration from the package.
- It starts the packaged MCP entry point far enough to verify its required runtime descriptor; the source-package validation separately runs the disposable real-OpenCode integration suite.
- It rejects an existing same-version release unless its tag, script, both adapter assets, and checksum file are complete and consistent.

Both artifact builders require GNU tar. GitHub's Ubuntu runner supplies it; on macOS install `gnu-tar`. The builders select `gtar` automatically when available, or accept an explicit executable through `GTAR`. Install `actionlint` separately (`brew install actionlint` on macOS) for the workflow syntax check.

## External acceptance

For additive task writes, `OCVM_TASKBOARD_BIN=/path/to/pinned-v0.6.0/taskboard npm run test:taskboard` in `adapters/mcp` runs a disposable real-backend MCP smoke (no model turns). It checks single/bundled bindings, replay/conflicts/no partial mutation, available revision readback, description-only notes, limits and a lost response after real PUT commit without retry, then a separate Board move/status readback. `OCVM_MCP_TEST_ADAPTER=/path/to/extracted-package/dist/main.js` also tests the production-only installed release package. `OCVM_MCP_TEST_OPENCODE=/path/to/opencode` selects the local binary; `OCVM_MCP_LIVE_RUNTIME=/path/to/runtime.json` optionally performs **discovery only** on an existing connector. All smoke mutations and services use a temporary project/DB/credential and are cleaned up. It does not prove Hosted ChatGPT loaded the skill or suppresses approval UI.

Packaging and automated integration are not substitutes for platform acceptance. Before describing the incoming MCP feature as externally accepted, complete the real macOS/Lima, Secure MCP Tunnel, ChatGPT text, and ChatGPT desktop Voice checks in [`MCP-TUNNEL.md`](MCP-TUNNEL.md). Those checks remain required until recorded against the target host and OpenAI workspace.
