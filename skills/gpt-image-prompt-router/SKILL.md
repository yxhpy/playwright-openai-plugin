---
name: gpt-image-prompt-router
description: Route image-generation requests to relevant GPT Image 2 prompt patterns, examples, and categories from the bundled YouMind OpenLab awesome-gpt-image-2 catalogue. Use when Codex needs to draft, improve, localize, classify, or choose prompts for GPT Image 2 or ChatGPT image generation, especially for avatars, social posts, infographics, YouTube thumbnails, comics/storyboards, product marketing, e-commerce main images, typography-heavy images, style matching, or when a user asks for prompt-library lookup or semantic prompt search.
---

# GPT Image Prompt Router

Use this skill to turn a user image idea into a strong prompt by routing through the bundled GPT Image 2 prompt catalogue before writing from scratch.

## Quick Start

Search first, then adapt:

```bash
python3 skills/gpt-image-prompt-router/scripts/prompt_router.py route "电商主图 直播间 科技产品" --language zh --limit 5
python3 skills/gpt-image-prompt-router/scripts/prompt_router.py search "youtube thumbnail shocked face tech news" --limit 5
python3 skills/gpt-image-prompt-router/scripts/prompt_router.py show 13460 --language zh
python3 skills/gpt-image-prompt-router/scripts/prompt_router.py categories --language zh
```

The script reads `references/prompt_catalog.json`, so do not load the full catalogue into context unless a specific match must be inspected.

## Workflow

1. Classify the user's goal: use case, subject, style, language, aspect ratio, text requirements, and whether a reference image or product identity must stay consistent.
2. Run `route` or `search` with the user's own words. Use `--language zh` for Chinese output, `--language en` for English output, or `auto` when unsure.
3. Inspect the top 3-5 results. If the match is close, run `show <id>` for the best candidate.
4. Adapt the matched prompt structure to the user's actual target. Keep useful layout, callout, typography, consistency, camera, and style constraints; remove irrelevant product/person/IP names.
5. Preserve dynamic placeholders such as `{argument name="..." default="..."}` until the user has supplied values. Fill them only when values are known.
6. When reusing substantial source text or a full prompt pattern, include attribution to YouMind OpenLab / awesome-gpt-image-2 under CC BY 4.0 in notes, docs, or deliverables.

## Prompt Adaptation Rules

- Prefer structured prompts when the output needs layout precision, text rendering, UI, posters, infographics, product diagrams, or multi-panel storyboards.
- For typography-heavy images, explicitly state exact visible text, language, placement, hierarchy, font mood, and spelling constraints.
- For product or e-commerce images, specify product geometry, material, lighting, hero angle, label placement, background, commercial usage, and negative clutter constraints.
- For character or series consistency, state stable identity anchors: silhouette, palette, outfit, proportions, facial features, pose range, and style lock.
- For thumbnails and social posts, specify focal subject, readable title text, contrast, emotion, crop safety, and platform aspect ratio.
- For game assets or sprites, include transparent background, orthographic or consistent camera, frame grid, action list, margins, and no drop shadow unless needed.
- Do not claim the bundled catalogue covers all 1123 upstream gallery prompts. The bundled offline index is parsed from the current GitHub README snapshot and contains its listed prompt entries plus category directory.

## Using With `poai`

If the user wants actual generation through this plugin, first create the final prompt with this skill, then use the `playwright-openai` skill workflow:

```bash
scripts/poai image submit --prompt "<final prompt>" --model auto --json
scripts/poai image wait --job-id <job-id> --json
scripts/poai image collect --job-id <job-id> --json
```

Keep browser safety rules from `playwright-openai`: do not store cookies, local storage, auth headers, full conversation URLs, generated source URLs, or prompt text in plugin manifests or job metadata.

## Resources

- `scripts/prompt_router.py`: dependency-free local search, category listing, routing, and full-prompt lookup.
- `references/prompt_catalog.json`: compact English and Simplified Chinese catalogue snapshot.
- `references/SOURCE.md`: source repository, commit, license, and attribution details.
