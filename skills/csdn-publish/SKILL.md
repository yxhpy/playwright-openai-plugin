---
name: csdn-publish
description: Use the repo-local Playwright CSDN publisher to inspect a logged-in CSDN editor session, validate article Markdown, upload local body images, set a cover, fill publish settings, and stop at draft unless explicitly asked to publish.
---

# CSDN Publish

Use this skill for publishing or preparing CSDN Markdown articles through the logged-in managed browser from `/Users/yxhpy/Desktop/project/playwright-openai`.

## Safety Rules

- Do not click the final CSDN publish button unless the user explicitly asks for real publication.
- Real publication requires both `--publish` and `--confirm-publish "<exact title>"`; do not bypass this confirmation lock.
- Prefer `--inspect` before mutating the editor when debugging selectors or login state.
- Prefer `--draft` for end-to-end verification because it fills the editor and publish settings but stops before final publish.
- Treat browser login state as sensitive user state. Do not print, export, persist, or commit cookies, local storage, auth headers, or full editor session material.
- Use local image placeholders for body images instead of leaving filesystem paths in Markdown.

## Entrypoints

From the repository root:

```bash
node scripts/csdn-publish.mjs --help
```

From the plugin wrapper:

```bash
plugins/playwright-openai/scripts/csdn-publish --help
```

From an installed plugin checkout:

```bash
scripts/csdn-publish.mjs --help
```

## Browser Setup

Start or reuse the managed browser on the CSDN editor:

```bash
node src/cli.js browser launch --url https://editor.csdn.net/md/
node scripts/csdn-publish.mjs --inspect --endpoint http://127.0.0.1:9333
```

`--inspect` should report `session_state: "editor_ready"`. If it reports `login_required`, complete login in the visible browser and run inspect again.

## Article Format Rules

- Use the CSDN title field for the title. If the Markdown starts with the same `# H1`, pass `--strip-title-heading`.
- Use fenced code blocks with a language, for example ` ```bash `.
- Use normal Markdown URLs for public images.
- For local body images, place `{{csdn:image:key}}` at the intended insertion point and pass `--image key=/absolute/or/relative/path.png`.

Example body image:

```markdown
部署结果如下：

{{csdn:image:deploy-result}}
```

## Common Workflows

Validate inputs without touching the browser:

```bash
plugins/playwright-openai/scripts/csdn-publish --dry-run \
  --title "文章标题" \
  --markdown-file ./article.md \
  --cover ./cover.png \
  --image hero=./hero.png
```

Fill the editor and publish settings, then stop before final publish:

```bash
plugins/playwright-openai/scripts/csdn-publish --draft \
  --endpoint http://127.0.0.1:9333 \
  --title "文章标题" \
  --markdown-file ./article.md \
  --strip-title-heading \
  --cover ./cover.png \
  --image hero=./hero.png \
  --summary "文章摘要，最多 256 字" \
  --tags Playwright,CSDN,自动化 \
  --category AI编程 \
  --article-type original \
  --visibility public
```

Only use `--publish --confirm-publish "<exact title>"` after a visible-browser review confirms title, body formatting, uploaded body images, cover, summary, tags, category, article type, and visibility are correct.
