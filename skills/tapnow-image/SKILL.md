---
name: tapnow-image
description: Generate and edit images through TapNow using tapnow-cli, especially GPT Image families, with explicit reference roles, model-specific dimensions, and visual acceptance.
---

# TapNow image generation

Use TapNow and the user's TapNow credits for this skill. `tapnow --help` discovers commands, `tapnow schema` exposes workflow fields, and `tapnow --agent ...` returns a versioned JSON envelope. If authentication is missing, direct the user to `tapnow auth login`.

Clarify the requested deliverable through the available brief: intended placement, exact visible text, composition, and required invariants. For reference inputs, inspect the images and assign each a role (edit target, identity, style, or composition). Read [image-direction.md](references/image-direction.md) when shaping prompts or assessing edits.

Resolve the exact model with `models list --type image` and inspect `models params MODEL --mode text_to_image` or `image_to_image`. TapNow model names and capabilities are platform-specific; the upstream OpenAI API's argument names are not interchangeable with this CLI's parameters.

For GPT Image, query the selected model's quality enum. GPT Image 1 and GPT Image 2/2.5 differ in dimensions and maximum reference count. GPT Image 2/2.5 accept explicit imageSize/aspectRatio combinations, paired auto values, or paired custom pixel dimensions; custom dimensions omit explicit size/ratio settings. Validation rejects values the webpage would silently round or discard. Set `quality`, `imageSize`, and `aspectRatio` through `workflow configure`; use `--reset-params` for family switches. Review the resolved parameters before saving.

Create a workflow with an image node, its prompt, and HTTPS `images` inputs or incoming image links. `assets upload FILE` returns an input URL. Direct images precede linked images; link order determines the remaining reference order. Set `mode` explicitly when reference intent matters.

Run `workflow validate FILE`, `workflow prepare FILE`, then `workflow apply FILE` and `workflow estimate FILE`. A prepare request is diagnostic only. Execute with `workflow run FILE --execute --max-cost BUDGET` within existing authorization. Resume the same state after interruption; uncertain submissions require job recovery rather than a new generation.

Inspect selected results for composition, subject consistency, legible text and requested changes. Refine the observed defect with one controlled change, retain the best prior result, and create a new workflow/state for a new submitted version. Deliver the saved asset path, canvas URL and any unresolved visual defect. A completed server job alone is not visual acceptance.
