---
name: tapnow-workflow
description: Manage personal or team TapNow canvas projects, linked generation nodes, budgets, and resumable jobs with tapnow-cli. Use for TapNow project automation and recovery.
---

# TapNow workflows

Use the installed `tapnow` executable. If unavailable, install the user's checked-out tapnow-cli with `npm ci` and `npm link`; the private GitHub repository requires their GitHub access. Discover commands with `tapnow --help` and machine-readable workflow JSON Schema with `tapnow schema`. Success JSON is the command's result by default; add `--agent` for a versioned `{ok,data}` envelope. Errors are structured JSON on stderr with nonzero exit status. Progress events go to stderr.

Use `auth status`, `orgs`, and `projects list` to identify the intended organization and canvas. Reuse the user's authorized account. `auth login` opens the independent browser profile for interactive login; automation that needs login should report this action to the user. Tokens belong outside manifests and skill files.

When continuing an existing project, reusing library assets or roles, organizing groups/layout, reviewing comments, or starting team collaboration, read [project-management.md](references/project-management.md). It defines the intake, change-plan and handoff workflow. Use `credits balance` and `credits quotas` to distinguish spendable Tapies from separate usage grants.

Represent each requirement as a workflow JSON file and a separate state file. `workflow init` provides a starting graph. `models list` identifies exact model IDs; `models params MODEL --mode MODE` describes defaults, input ranges and valid parameters. For image or video creative work, consult the installed `tapnow-image` or `tapnow-video` skill when available; each is independently usable.

`workflow configure FILE NODE --set key=value` previews a validated edit. Use `--model MODEL --reset-params --mode MODE` when switching families; review retained references and links. Add `--write` to persist or `--output NEW_FILE` for a separate manifest. A submitted workflow/state is immutable: changed requirements need a new workflow/state and an intentional project choice.

Before submission, `workflow validate`, `workflow prepare`, and `workflow estimate` must succeed for the ready nodes. Prepare returns the actual transformed request without submitting it. Pending upstream outputs are reported as deferred; their full validation and quote happen after those outputs exist. `workflow apply` synchronizes nodes and links; this does not generate media.

Submit using `workflow run FILE --execute --max-cost BUDGET` within the user's authorized spend. The budget covers cumulative quotes, including already submitted jobs. Report uncertain or failed submission state and use `jobs status`, `jobs recover`, or ownership-verified `jobs attach` as appropriate; resuming the same state prevents repeat submission of completed jobs. Never erase state to retry an uncertain charge.

Completion means task status is completed, output URLs exist, and the canvas saved them. Download requested deliverables with `assets download URL FILE` and inspect them using the agent's available image/video tools. Report canvas URL, selected outputs, quoted cost, and any acceptance work still outstanding.
