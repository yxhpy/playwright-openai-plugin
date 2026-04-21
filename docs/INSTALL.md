# Install

## Clone Into Codex Plugins

```bash
git clone <repo-url> ~/.codex/plugins/playwright-openai-plugin
cd ~/.codex/plugins/playwright-openai-plugin
npm install
scripts/poai --help
```

## Local Symlink Install

From this repository:

```bash
scripts/install-local.sh
```

This creates:

```text
~/.codex/plugins/playwright-openai-plugin -> <this repo>
```

## Runtime Login

The plugin does not ship a login. It expects a managed browser profile that the operator logs into:

```bash
scripts/poai browser launch --text
scripts/poai discover --json
```

If discovery reports login required, complete login in the opened browser and rerun discovery.
