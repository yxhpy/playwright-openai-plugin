---
name: playwright-openai
description: Operate the repo-local `poai` CLI for a Playwright-controlled, already logged-in OpenAI/ChatGPT browser session. Use when the user asks Codex to inspect ChatGPT browser state, submit/wait/collect chat or image jobs, revise image jobs, diagnose image generation status, or manage local `poai` job metadata.
---

# Playwright OpenAI

Use this skill for the repo-local browser-backed OpenAI CLI in `/Users/yxhpy/Desktop/project/playwright-openai`.

## Safety Rules

- Treat browser login state as sensitive user state.
- Do not print, export, persist, or commit raw cookies, local storage, auth headers, or full ChatGPT conversation URLs.
- Prefer `poai discover` or `poai image inspect` before mutating browser state.
- For long-running image/chat work, keep submit, wait, collect, and revise as separate recoverable steps.
- Do not resubmit a job just because `wait` timed out. Inspect or retry wait first.
- Do not use destructive browser actions to undo/delete prior ChatGPT turns unless a future explicit workflow is designed.
- For action packs, do not persist prompt text, character descriptions, source URLs, cookies, local storage, or full conversation URLs in manifests or logs.
- Treat action-pack QA failures as blockers in normal operation. Regenerate or reprocess failed actions unless the user explicitly asks to keep a suspect package with `--qa warn`.

## Entrypoints

From the repository root:

```bash
node src/cli.js --help
```

From the plugin wrapper:

```bash
plugins/playwright-openai/scripts/poai --help
```

Both call the same repo-local CLI.

## Common Workflows

Check browser/session readiness:

```bash
plugins/playwright-openai/scripts/poai status --json
plugins/playwright-openai/scripts/poai discover --json
```

Start/stop the managed browser:

```bash
plugins/playwright-openai/scripts/poai browser launch --text
plugins/playwright-openai/scripts/poai browser stop --text
```

Run a recoverable image generation:

```bash
plugins/playwright-openai/scripts/poai image submit --prompt "<prompt>" --model auto --json
plugins/playwright-openai/scripts/poai image wait --job-id <job-id> --json
plugins/playwright-openai/scripts/poai image collect --job-id <job-id> --json
```

Use one reference image:

```bash
plugins/playwright-openai/scripts/poai image submit --prompt "<prompt>" --file /path/to/reference.png --model auto --json
```

Diagnose what to do next:

```bash
plugins/playwright-openai/scripts/poai image inspect --job-id <job-id> --json
```

Continue the same open image conversation:

```bash
plugins/playwright-openai/scripts/poai image revise --job-id <job-id> --prompt "<new prompt>" --json
```

Create an action pack from live generation:

```bash
plugins/playwright-openai/scripts/poai action-pack create --character "<character description>" --actions idle,walk,run,jump,attack,cast,hurt,victory --model thinking --json
```

For game-ready continuous-frame sprites, prefer this operating model:

- Ask for pixel-grid-aware sprite sheets with fixed cells, fixed character identity, continuous frame progression, and a removable high-contrast background.
- Do not trust raw cell crops. The action-pack processor recovers foreground pose components across the whole sheet before splitting, so small spillovers like feet, hats, and effects are preserved.
- Background cleanup happens per recovered frame, then frames are normalized to a shared bottom-center anchor to reduce sideways drift and vertical bobbing.
- Inspect `package/contact_sheet.png` and the GIF preview before importing into a game.
- If the raw order is visually wrong, use `--frame-order` to keep and reorder frames without regenerating:

```bash
plugins/playwright-openai/scripts/poai action-pack create --from-dir /path/to/raw-sheets --actions attack --grid 2x5 --frames-per-action 10 --frame-order F01,F03,F02,F04,F05,F07,F09 --frame-size 256x256 --output-dir /path/to/output --json
```

Create an action pack and selectively retry QA-failed generated actions:

```bash
plugins/playwright-openai/scripts/poai action-pack create --character "<character description>" --actions idle,walk,run,jump,attack,cast,hurt,victory --model thinking --regen-failed --regen-attempts 1 --json
```

Package existing action sheets without browser mutation:

```bash
plugins/playwright-openai/scripts/poai action-pack create --from-dir /path/to/raw-sheets --actions idle,walk --output-dir /path/to/output --json
```

Expected action-pack outputs:

- `package/<action>/<action>_01.png` frame folders.
- `package/action_pack_atlas.png`.
- `package/contact_sheet.png`.
- `package/action_pack_animation.gif`.
- `package/qa_report.json`.
- `package/manifest.json`.
- `action_pack.zip`.

Quality gate behavior:

- Default `--qa strict` checks blank frames, subject bounds, center drift, scale drift, edge opacity, transparent margins, and crop safety.
- If `qa_status` is `fail`, do not import the pack as production-ready.
- Use `--regen-failed` only for browser-backed generation when the user accepts extra generation time/quota; it retries failed actions only.
- Use `--qa warn` only to retain failed outputs for manual inspection or repair.

## Model Guidance

- Image `--model auto` routes by prompt difficulty. Simple prompts use Instant; complex prompts with reference images, dense text, layout, product, character consistency, sprite/action, or multi-panel requirements select Thinking before opening Images.
- Use `--model thinking`, `--model extended`, or `--model heavy` when generation quality or reference-image reasoning matters and the user accepts slower generation.
- Do not use Pro as the normal image path: ChatGPT Pro does not currently expose image generation. If a user asks for Pro-quality image work, use Thinking/Heavy unless a future verified UI flow supports something else.
- `--model light`, `--model low`, `--model medium`, `--model high`, and `--model xhigh` are accepted as image difficulty intent and currently map to Thinking selection. The plugin does not yet change the separate ChatGPT Web thinking-time toggle because that selector has not been verified live.
- `--model standard` and `--model advanced` target Images surface mode controls for new image submissions only.

## Expected Local State

- Managed browser profile: `~/.playwright-openai/chrome-profile`
- Managed endpoint default: `http://127.0.0.1:9333`
- Job metadata: `~/.playwright-openai/jobs`
- Image outputs: `~/.playwright-openai/outputs/images/<job-id>/`

These locations are outside the plugin and must not be copied into plugin files.
