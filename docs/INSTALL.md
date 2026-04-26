# Install

## Clone Into Codex Plugins

```bash
git clone <repo-url> ~/.codex/plugins/playwright-openai-plugin
cd ~/.codex/plugins/playwright-openai-plugin
npm install
scripts/poai --help
scripts/csdn-publish.mjs --help
scripts/x-articles-publish.mjs --help
scripts/xhs-publish.mjs --help
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

## CSDN Runtime Login

The CSDN publisher also uses the managed browser profile. Launch the CSDN editor and log in once:

```bash
npm run csdn:launch
npm run csdn:inspect -- --endpoint http://127.0.0.1:9333
```

Use `--dry-run` for local validation and `--draft` for browser fill. Real publication requires `--publish --confirm-publish "<exact title>"`.

## X Articles And Xiaohongshu Runtime Login

These publishers also use the managed browser profile. Launch the target editor and log in once:

```bash
npm run x:launch
npm run x:articles:inspect -- --endpoint http://127.0.0.1:9333

npm run xhs:launch
npm run xhs:inspect -- --endpoint http://127.0.0.1:9333
```

Use `--dry-run` for local validation and `--draft` for browser fill. Real publication requires `--publish --confirm-publish "<exact title>"`.
