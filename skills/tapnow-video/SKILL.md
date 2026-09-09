---
name: tapnow-video
description: Generate TapNow videos with Seedance and MiniMax H3 using tapnow-cli, selecting text, first-frame, start/end, reference or edit modes and directing motion, sound and continuity.
---

# TapNow video generation

Use `tapnow` with the user's authorized account and credits. Discover the workflow schema with `tapnow schema` and command details with `--help`; `--agent` wraps JSON results with version and success status. Authenticate with `auth login` when required.

Translate the brief into observable action over the requested duration. When working with Seedance read [seedance.md](references/seedance.md); for H3 read [h3.md](references/h3.md). Keep user-specified models and intent. The references inform creative direction, while TapNow's live catalog and transforms determine executable capabilities.

Use `models params MODEL --mode MODE` before selecting parameters. Choose explicit mode: text with no media; image with one first frame; start/end with two ordered frames; reference with model-supported media; video_edit only on a model supporting it. H3-Max has fewer modes than H3. Seedance variants also differ in resolution, output length and reference counts.

Use HTTPS `images`, `videos`, `audios` arrays, populated via `assets upload` as needed. Direct references precede references from links, in link order. Optional `videoDurations` in direct-video order enable early offline checks. For models with reference-video duration limits, prepare and execution measure actual media duration in the browser and stop when measurement fails or limits are exceeded. H3 audio references need an accompanying image or video. Audio reference inputs and a generateAudio output switch are different capabilities: set only fields advertised by the selected model.

Frame-derived modes omit aspectRatio. Seedance 2.5 video_edit preserves input duration with duration=-1. `workflow configure FILE NODE --model MODEL --mode MODE --reset-params` previews a switch; set only options from its capability result, then add `--write` or save a new manifest using `--output`. Keep reference order and describe each reference's intended influence in the prompt.

Validate, prepare the transformed request, apply the graph, and obtain the quote using the corresponding `workflow` commands. Resolve deferred upstream media before treating an estimate as complete. Execute with `workflow run FILE --execute --max-cost BUDGET` within the user's authorized budget. Recover uncertain jobs with the job commands and existing state rather than submitting duplicates.

Completion requires server results saved on canvas and inspection of motion, continuity, timing, audio and requested framing. If video playback is unavailable, report that limitation separately from successful generation. Download requested outputs; provide paths, canvas URL and any defects. Use a new workflow/state for revised submitted shots.
