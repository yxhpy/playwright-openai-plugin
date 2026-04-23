# Playwright OpenAI Plugin

Installable Codex plugin plus local `poai` CLI for operating an already logged-in ChatGPT/OpenAI browser session through Playwright.

This repository is designed to be cloned directly into a Codex plugin directory.

## Install

```bash
git clone <repo-url> ~/.codex/plugins/playwright-openai-plugin
cd ~/.codex/plugins/playwright-openai-plugin
npm install
```

Or install from an existing local checkout:

```bash
./scripts/install-local.sh
```

## Verify

```bash
scripts/poai --help
npm run check
```

## Browser Setup

Start a managed Chrome profile with CDP enabled:

```bash
scripts/poai browser launch --text
scripts/poai discover --json
```

Log in to ChatGPT in the launched browser if discovery reports a login-required state.

## Common Commands

```bash
scripts/poai status --json
scripts/poai discover --json

scripts/poai image submit --prompt "A clean icon of a green square" --model auto --json
scripts/poai image wait --job-id <job-id> --json
scripts/poai image collect --job-id <job-id> --json

scripts/poai image inspect --job-id <job-id> --json
scripts/poai image revise --job-id <job-id> --prompt "Make it simpler" --json
```

## GPT Image Prompt Router Skill

The plugin also includes `skills/gpt-image-prompt-router/SKILL.md`, a Codex skill for routing image ideas to prompt patterns from the bundled `awesome-gpt-image-2` catalogue snapshot.

```bash
python3 skills/gpt-image-prompt-router/scripts/prompt_router.py route "电商主图 直播间 科技产品" --language zh --limit 5
python3 skills/gpt-image-prompt-router/scripts/prompt_router.py show 13460 --language zh
```

The catalogue is adapted from [YouMind-OpenLab/awesome-gpt-image-2](https://github.com/YouMind-OpenLab/awesome-gpt-image-2) under CC BY 4.0, with source details in `skills/gpt-image-prompt-router/references/SOURCE.md`.

## Action Pack Workflow

Generate or package animation action sheets into transparent frame PNGs, an atlas, GIF preview, QA report, manifest, and zip:

```bash
scripts/poai action-pack create \
  --character "consistent game pet character" \
  --actions idle,walk,run,jump,attack,cast,hurt,victory \
  --output-dir ./outputs/my-action-pack
```

Strict QA runs by default and writes `package/qa_report.json`. If QA finds severe structural issues, the command returns `completed=false` and recommends regeneration or reprocessing. Use `--qa warn` only when you want to keep a suspect package for inspection.

For browser-backed generation, add `--regen-failed --regen-attempts 1` to retry only actions that fail strict QA. This is intentionally opt-in because it consumes generation quota.

Package existing sheets without touching the browser:

```bash
scripts/poai action-pack create \
  --from-dir ./outputs/raw-sheets \
  --actions idle,walk \
  --output-dir ./outputs/action-pack-smoke
```

## Safety

- This plugin does not include browser cookies, local storage, auth headers, job metadata, or generated outputs.
- Managed browser profile and local jobs live outside this repo under `~/.playwright-openai/`.
- ChatGPT conversation URLs are redacted in command output.
- Image jobs are designed as submit/wait/collect/revise workflows to avoid duplicate submissions.
- Action-pack manifests avoid prompt text, character descriptions, source URLs, and browser session material.
- Action-pack QA reports store structural frame metrics only.
- Selective regeneration retries only QA-failed generated actions and is bounded by `--regen-attempts`.

## Included Codex Skill

The plugin includes:

- `skills/playwright-openai/SKILL.md`, which teaches Codex how to use the CLI safely.
- `skills/gpt-image-prompt-router/SKILL.md`, which helps Codex find and adapt GPT Image 2 prompt examples before generation.
