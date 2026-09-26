# Releasing opencode-vm

## Release artifact contract

Every release whose script references the adapters must publish these assets under the matching `v<OCVM_VERSION>` tag:

- `opencode-vm.sh`
- `opencode-vm-openlive-adapter-<openlive-version>.tar`
- `opencode-vm-mcp-adapter-<mcp-version>.tar`
- `SHA256SUMS`

OpenLive and incoming MCP are independently versioned adapters. They share the script's release tag and release page, but an adapter version changes only when that adapter changes. `SHA256SUMS` contains one entry for each adapter archive.

The archives are built reproducibly by `scripts/build-openlive-adapter.sh` and `scripts/build-mcp-adapter.sh`. Each tag, filename, version, and SHA-256 is pinned in `opencode-vm.sh`; an installed standalone script never executes a floating branch artifact.

## Release sequence

1. Increment the patch component of `OCVM_VERSION`.
2. Set both `OPENLIVE_ADAPTER_TAG` and `MCP_ADAPTER_TAG` to the matching `v<OCVM_VERSION>` tag.
3. If OpenLive runtime behavior changed, increment `adapters/openlive-acp/package.json`, regenerate its `package-lock.json`, update `ADAPTER_VERSION` in `src/acp/transport.ts`, and update `OPENLIVE_ADAPTER_VERSION` plus `OPENLIVE_ADAPTER_FILENAME` in `opencode-vm.sh`.
4. If MCP adapter behavior changed, increment `adapters/mcp/package.json`, regenerate its `package-lock.json`, update `ADAPTER_VERSION` in `src/types.ts`, and update `MCP_ADAPTER_VERSION` plus `MCP_ADAPTER_FILENAME` in `opencode-vm.sh`.
5. Install locked dependencies with `npm ci --ignore-scripts` in both adapter directories.
6. Build both archives twice and require byte-for-byte equality:

```bash
scripts/build-openlive-adapter.sh /tmp/openlive-a.tar
scripts/build-openlive-adapter.sh /tmp/openlive-b.tar
scripts/build-mcp-adapter.sh /tmp/mcp-a.tar
scripts/build-mcp-adapter.sh /tmp/mcp-b.tar
cmp /tmp/openlive-a.tar /tmp/openlive-b.tar
cmp /tmp/mcp-a.tar /tmp/mcp-b.tar
shasum -a 256 /tmp/openlive-a.tar /tmp/mcp-a.tar
```

7. Set `OPENLIVE_ADAPTER_SHA256` and `MCP_ADAPTER_SHA256` to those digests and run all validations below.
8. Commit the release candidate and push it to `main` through the normal host/IDE workflow.
9. Wait for `.github/workflows/release.yml` to validate the release, create the missing `v<OCVM_VERSION>` tag at that exact commit, and publish all four assets.
10. Verify both pinned artifact URLs and checksums before announcing the release.

Updating `main` remains a host-side maintainer action because session VMs intentionally have no Git origin credentials. Tag and release publication runs in GitHub Actions.

Because a `main` push starts the release workflow, `main` necessarily contains the candidate while validation is still running. Do not run or announce an update during this window. A failed release workflow must be fixed or rerun before the candidate is considered available.

The workflow also accepts a manually pushed `v*` tag as a recovery path. A normal `git push` or IDE "Sync Changes" does not reliably push local tags, so the default process does not create a local tag at all: GitHub creates the tag after every validation passes, then publishes the release. Release jobs are serialized per version, with the running job and latest pending attempt retained. The first successful same-version candidate publishes; later candidates exit without rebuilding only when their script and both adapter build inputs match the published release. An incomplete release, inconsistent tag or asset, unversioned release-input change, or GitHub API failure stops the workflow instead of being mistaken for a successful no-op.

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
bash -n opencode-vm.sh tests/mcp_adapter_test.sh tests/openlive_test.sh scripts/build-mcp-adapter.sh scripts/build-openlive-adapter.sh
shellcheck --severity=error opencode-vm.sh tests/mcp_adapter_test.sh tests/openlive_test.sh scripts/build-mcp-adapter.sh scripts/build-openlive-adapter.sh
bash tests/mcp_adapter_test.sh
bash tests/openlive_test.sh
git diff --check
```

The release workflow additionally performs these checks:

- It compares two builds of each archive for reproducibility and compares each digest to the script pin.
- It installs production-only dependencies from each extracted package with lifecycle scripts disabled.
- It starts the packaged OpenLive entry point far enough to verify its required runtime descriptor and runs the real OpenCode manager-tool integration from the package.
- It starts the packaged MCP entry point far enough to verify its required runtime descriptor; the source-package validation separately runs the disposable real-OpenCode integration suite.
- It rejects an existing same-version release unless its tag, script, both adapter assets, and checksum file are complete and consistent.

Both artifact builders require GNU tar. GitHub's Ubuntu runner supplies it; on macOS install `gnu-tar`. The builders select `gtar` automatically when available, or accept an explicit executable through `GTAR`. Install `actionlint` separately (`brew install actionlint` on macOS) for the workflow syntax check.

## External acceptance

Packaging and automated integration are not substitutes for platform acceptance. Before describing the incoming MCP feature as externally accepted, complete the real macOS/Lima, Secure MCP Tunnel, ChatGPT text, and ChatGPT desktop Voice checks in [`MCP-TUNNEL.md`](MCP-TUNNEL.md). Those checks remain required until recorded against the target host and OpenAI workspace.
