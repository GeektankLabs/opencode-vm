Task-ID: task_70e6fe6a-7813-54f2-aa1a-5c068d67ca3b
Title: Release-Gate-Workflow für OpenCode VM manifestieren
Last-updated: 2026-10-02T20:06:06+02:00

## Current W2a result
- Implemented and committed locally on canonical `main`: `722d041` (`docs: define exact-commit release gate`), based on authorized start `cd8c0c13ffc02507950bd95f90b80b941f55eb11`.
- `docs/RELEASING.md` now defines local candidate → operator push → exact-commit CI/release verification → smallest separately authorized local repair → operator push and new exact-commit verification. Red/unverified gates preserve the working runtime; an interruption needs an explicitly authorized, technically necessary in-scope repair and recorded recovery state.
- Root `AGENTS.md` points to the policy. The generic ChatGPT orchestrator discovers the target repository's policy, preserves operator-only publication and exact-commit semantics, and carries the same runtime rule. Companion skill marker: `2026-10-02-r29`.
- No workflow YAML, script, adapter, backend, permission or publishing behavior changed. No remote push/tag/release/deploy, runtime interruption, Board mutation or hosted skill acceptance was performed.

## Local verification
- PASS: `python3 -B tests/chatgpt_skill_test.py` — 25 tests.
- PASS: `python3 -B tests/release_metadata_test.py` — 5 tests.
- PASS: `python3 -B tests/release_state_test.py` — 5 tests.
- PASS: `python3 scripts/build-chatgpt-skill.py --check` — r29 inventory, ZIP and checksum consistent.
- PASS: `git diff --check`.

The concept plan remains unchanged; no substantive product/architecture/security decision was discovered. W2a is locally integrated and ready for W2b after it re-reads the current C/P, canonical target and actual `main` HEAD. Hosted skill behavior and any future release publication remain separate acceptance.
