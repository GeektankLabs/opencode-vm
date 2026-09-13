# Releasing opencode-vm

## OpenLive artifact contract

Every release whose script references an OpenLive adapter must publish these assets under the matching `v<OCVM_VERSION>` tag:

- `opencode-vm.sh`
- `opencode-vm-openlive-adapter-<adapter-version>.tar`
- `SHA256SUMS`

The adapter archive is built reproducibly by `scripts/build-openlive-adapter.sh`. Its tag, filename, version, and SHA-256 are pinned in `opencode-vm.sh`; the installed script never executes a floating branch artifact.

## Release sequence

1. Increment the patch component of `OCVM_VERSION` and set `OPENLIVE_ADAPTER_TAG` to the matching `v<OCVM_VERSION>` tag.
2. If adapter runtime behavior changed, increment its version in `adapters/openlive-acp/package.json`, regenerate `package-lock.json`, update `ADAPTER_VERSION` in `src/acp/transport.ts`, and update `OPENLIVE_ADAPTER_VERSION` plus `OPENLIVE_ADAPTER_FILENAME` in `opencode-vm.sh`.
3. Install locked dependencies with `npm ci` in `adapters/openlive-acp/`.
4. Build the archive twice and require byte-for-byte equality:

   ```bash
   scripts/build-openlive-adapter.sh /tmp/openlive-a.tar
   scripts/build-openlive-adapter.sh /tmp/openlive-b.tar
   cmp /tmp/openlive-a.tar /tmp/openlive-b.tar
   shasum -a 256 /tmp/openlive-a.tar
   ```

5. Set `OPENLIVE_ADAPTER_SHA256` to that digest and run all validations listed below.
6. Commit the release candidate and push it to `main` through the normal host/IDE workflow.
7. Wait for `.github/workflows/release.yml` to validate the release, create the missing `v<OCVM_VERSION>` tag at that exact commit, and publish the release assets.
8. Verify that the pinned artifact URL downloads successfully before announcing the release.

Updating `main` remains a host-side maintainer action because session VMs intentionally have no Git origin credentials. Tag and release publication runs in GitHub Actions.

Because a `main` push starts the release workflow, `main` necessarily contains the candidate while validation is still running. Do not run or announce an update during this window. A failed release workflow must be fixed or rerun before the candidate is considered available.

The workflow also accepts a manually pushed `v*` tag as a recovery path. A normal `git push` or IDE “Sync Changes” does not reliably push local tags, so the default process does not create a local tag at all: GitHub creates the tag after every validation passes, then publishes the release. Release jobs are serialized per version, with the running job and latest pending attempt retained. The first successful same-version candidate publishes; later candidates exit without rebuilding only when their script and adapter build inputs match the published release. An incomplete release, inconsistent tag or asset, unversioned release-input change, or GitHub API failure stops the workflow instead of being mistaken for a successful no-op.

## Validation

```bash
cd adapters/openlive-acp
npm run check
npm run build
npm test
npm run test:integration

cd ../..
bash -n opencode-vm.sh tests/openlive_test.sh scripts/build-openlive-adapter.sh
shellcheck --severity=error opencode-vm.sh tests/openlive_test.sh scripts/build-openlive-adapter.sh
bash tests/openlive_test.sh
git diff --check
```

The release workflow also starts the packaged entry point after a production-only dependency install and runs the real OpenCode manager-tool integration with the tool file from the extracted package.

The artifact builder requires GNU tar. GitHub's Ubuntu runner supplies it; on macOS install `gnu-tar`. The builder selects `gtar` automatically when available, or accepts an explicit executable through `GTAR`.
