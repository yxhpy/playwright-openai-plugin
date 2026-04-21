---
name: playwright-openai
description: Operate the installable `poai` CLI for a Playwright-controlled, already logged-in OpenAI/ChatGPT browser session. Use when the user asks Codex to inspect ChatGPT browser state, submit/wait/collect chat or image jobs, revise image jobs, diagnose image generation status, or manage local `poai` job metadata.
---

# Playwright OpenAI

Use this skill for the `playwright-openai-plugin` Codex plugin and its local `poai` CLI.

## Safety Rules

- Treat browser login state as sensitive user state.
- Do not print, export, persist, or commit raw cookies, local storage, auth headers, or full ChatGPT conversation URLs.
- Prefer `poai discover` or `poai image inspect` before mutating browser state.
- For long-running image/chat work, keep submit, wait, collect, inspect, and revise as separate recoverable steps.
- Do not resubmit a job just because `wait` timed out. Inspect or retry wait first.
- Do not use destructive browser actions to undo/delete prior ChatGPT turns unless a future explicit workflow is designed.
- For action packs, do not persist prompt text, character descriptions, source URLs, cookies, local storage, or full conversation URLs in manifests or logs.

## Entrypoints

From the plugin repository root:

```bash
scripts/poai --help
```

The wrapper calls:

```bash
node src/cli.js "$@"
```

## Common Workflows

Check browser/session readiness:

```bash
scripts/poai status --json
scripts/poai discover --json
```

Start/stop the managed browser:

```bash
scripts/poai browser launch --text
scripts/poai browser stop --text
```

Run a recoverable image generation:

```bash
scripts/poai image submit --prompt "<prompt>" --model auto --json
scripts/poai image wait --job-id <job-id> --json
scripts/poai image collect --job-id <job-id> --json
```

Use one reference image:

```bash
scripts/poai image submit --prompt "<prompt>" --file /path/to/reference.png --model auto --json
```

Diagnose next action:

```bash
scripts/poai image inspect --job-id <job-id> --json
```

Continue the same open image conversation:

```bash
scripts/poai image revise --job-id <job-id> --prompt "<new prompt>" --json
```

Create an action pack from live generation:

```bash
scripts/poai action-pack create --character "<character description>" --actions idle,walk,run,jump,attack,cast,hurt,victory --model thinking --json
```

Package existing action sheets without browser mutation:

```bash
scripts/poai action-pack create --from-dir /path/to/raw-sheets --actions idle,walk --output-dir /path/to/output --json
```

Expected action-pack outputs:

- `package/<action>/<action>_01.png` frame folders.
- `package/action_pack_atlas.png`.
- `package/action_pack_animation.gif`.
- `package/manifest.json`.
- `action_pack.zip`.

## Model Guidance

- Image `--model auto` intentionally avoids Pro by selecting the top ChatGPT `Instant` model before opening Images.
- Use `--model thinking` when generation quality or reference-image reasoning matters and the user accepts slower generation.
- Use `--model pro` only when the user explicitly asks for Pro.
- `--model standard` and `--model advanced` target Images surface mode controls for new image submissions only.

## Expected Local State

- Managed browser profile: `~/.playwright-openai/chrome-profile`
- Managed endpoint default: `http://127.0.0.1:9333`
- Job metadata: `~/.playwright-openai/jobs`
- Image outputs: `~/.playwright-openai/outputs/images/<job-id>/`

These locations are outside the plugin repository and must not be copied into plugin files.
