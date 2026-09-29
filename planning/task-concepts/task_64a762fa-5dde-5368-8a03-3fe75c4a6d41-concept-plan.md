Task-ID: task_64a762fa-5dde-5368-8a03-3fe75c4a6d41
Title: Project config CLI and safe disk sizing
Status: active
Last-concept-update: 2026-09-29T13:26:25+02:00

## Problem and outcome

Sizing is split across direct RAM/CPU commands and has no per-project disk setting. Provide a single `opencode-vm config` entry point, with guided interactive completion and deterministic non-interactive subcommands, while preserving existing RAM/CPU commands.

## Requirements and acceptance

- `config show`, `config ram|cpu|disk <integer|default>`; bare `config` offers a menu; bare `config disk` prompts for a value only on a terminal. Show configured/default/current/pending disk state.
- Store `VM_DISK_GIB` beside RAM/CPU in project-state `vm.env`. Fresh clones use `--disk`; stopped kept instances grow on resume via `limactl edit --disk`, then ordinary `limactl start`. Running instances remain running and report pending changes.
- Before every explicit numeric disk change with a kept instance, read its Lima disk size. Unknown size fails closed. Smaller request fails without writing config or invoking edit. Equal request is harmless. Default clears the override but never shrinks existing instances; future clones inherit base disk size.
- RAM/CPU retain their existing bounds, downward resizing and legacy entry points. No mutation of global Lima defaults.

## Design and decisions

The shared sizing helpers in `opencode-vm.sh` load/save the same host-side file and handle clone/resume. Disk default is read from `oc-base` when available; an unset override never invokes a disk edit on an existing instance. Disk readings use Lima's byte-valued `Disk` list field and round upward for conservative shrink protection. A missing/unreadable existing disk (or failed Lima listing) blocks numeric writes; stopped-instance disk edits are skipped with a warning rather than guessing. A numeric disk target below the actual base disk is also rejected: a future clone cannot shrink the base image. CLI prompts follow the existing numbered-menu/read pattern and require an interactive stdin.

Alternative rejected: editing `$LIMA_HOME/_config/default.yaml` or replacing a kept instance to change disk size; both affect other projects or discard existing data. Alternative rejected: editing a running VM implicitly; the configured change is pending until a later stop/resume.

## Interfaces and failure boundaries

`config` dispatches to the existing resource command for RAM/CPU; `ram`, `cpu`, `cpus` remain aliases. Numeric disk setting preflights a tracked, existing Lima instance before saving. The stopped resume helper combines RAM/CPU edits with an increase-only disk edit; a failed resize reports the failure and continues the existing resume behavior. Fresh clones pass the disk override directly to Lima. Read-only `show` labels unavailable disk measurements rather than inferring they are equal.

## Implementation and acceptance plan

1. Extend sizing persistence, display, clone, stopped/resumed and running notices.
2. Add interactive/non-interactive `config` dispatch, keep aliases, update help/README and release tags/version.
3. Add mocked Lima tests for project isolation, menus/direct commands, clone, stopped grow, running pending, shrink prechecks, default and legacy RAM/CPU behavior. Run shellcheck, syntax, relevant tests, release metadata tests and `git diff --check`.

## Open points

Real macOS Lima/guest Cloud-Init grow acceptance requires a host VM; mocked unit coverage verifies command sequence and no-shrink guarantees.
