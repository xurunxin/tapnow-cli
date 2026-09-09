# Image direction and evidence

Describe the asset's use, scene, subject, framing, light, and exact visible text. Specify only details that support the user's brief. For an edit, identify the requested change and the features that must remain consistent. Number input images and state their roles. Review results against those roles, then adjust the single most consequential defect.

Example original brief for a product image:

> A wide catalog photograph of the ceramic cup in image 1 on a pale oak shelf. Preserve the cup's shape, glaze and printed lettering. Soft daylight from a nearby window. Leave clear space above the shelf for separately typeset copy. Change the setting only.

Use parameters to control actual model settings; mentioning “4K” in prose does not configure pixel dimensions. Exact dimensions and available quality levels come from `models params` and `workflow prepare`.

Reference reviewed 2026-09-10: [OpenAI's public imagegen skill](https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md), specifically reference roles, edit invariants, exact-text review and controlled iteration. This is an original TapNow adaptation; its execution path and credentials are TapNow's, and no upstream scripts are installed.
