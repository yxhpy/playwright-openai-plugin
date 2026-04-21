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

## Action Pack Workflow

Generate or package animation action sheets into transparent frame PNGs, an atlas, GIF preview, manifest, and zip:

```bash
scripts/poai action-pack create \
  --character "consistent game pet character" \
  --actions idle,walk,run,jump,attack,cast,hurt,victory \
  --output-dir ./outputs/my-action-pack
```

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

## Included Codex Skill

The plugin includes `skills/playwright-openai/SKILL.md`, which teaches Codex how to use the CLI safely.
