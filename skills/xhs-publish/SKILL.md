---
name: xhs-publish
description: Use the Playwright Xiaohongshu publisher to validate note Markdown/media, inspect a logged-in Creator publish page, fill a visible draft, and stop before publication unless exact-title confirmation is explicitly provided.
---

# Xiaohongshu Publish

Use this skill for preparing or publishing Xiaohongshu notes through the logged-in managed browser from this plugin checkout.

## Safety Rules

- Do not click the final Xiaohongshu publish button unless the user explicitly asks for real publication.
- Real publication requires both `--publish` and `--confirm-publish "<exact title>"`; do not bypass this confirmation lock.
- Prefer `--draft` for end-to-end verification because it uploads media and fills the visible editor but stops before final publish.
- Treat Xiaohongshu login state, cookies, local storage, and account URLs as sensitive. Do not export or persist them.
- If `--inspect` reports `login_required`, ask the user to complete login in the visible browser and rerun inspect.

## Entrypoints

From the repository root:

```bash
node scripts/xhs-publish.mjs --help
```

From the installed package bin:

```bash
xhs-publish --help
```

## Browser Setup

Start or inspect the managed browser on the Xiaohongshu Creator publish page:

```bash
node src/cli.js browser launch --url "https://creator.xiaohongshu.com/publish/publish?source=official"
node scripts/xhs-publish.mjs --inspect --endpoint http://127.0.0.1:9333
```

Expected ready state:

```json
{
  "page": {
    "session_state": "editor_ready"
  }
}
```

## Local Format Validation

Run this before browser mutation:

```bash
node scripts/xhs-publish.mjs --dry-run \
  --title "笔记标题" \
  --markdown-file ./note.md \
  --image ./cover.png \
  --strip-title-heading
```

Inspect the support matrix when deciding whether a setting can be automated:

```bash
node scripts/xhs-publish.mjs --capabilities
```

Supported Markdown subset is converted to plain Xiaohongshu note text: headings, paragraphs, bold, italic, strikethrough, inline code, links, ordered lists, unordered lists, fenced text, and hashtag text.

Markdown image syntax is not mapped into the editor. Pass media in display order with repeated `--image` flags.

## Draft Fill

Upload media, fill the visible editor, and stop:

```bash
node scripts/xhs-publish.mjs --draft \
  --endpoint http://127.0.0.1:9333 \
  --title "笔记标题" \
  --markdown-file ./note.md \
  --strip-title-heading \
  --image ./cover.png \
  --image ./detail.png
```

Supported draft settings:

```bash
node scripts/xhs-publish.mjs --draft \
  --endpoint http://127.0.0.1:9333 \
  --title "笔记标题" \
  --markdown-file ./note.md \
  --image ./cover.png \
  --topic AI工具 \
  --topic 自动化 \
  --original true \
  --content-type ai \
  --visibility public \
  --allow-duet true \
  --allow-copy true \
  --schedule-at "2026-04-27 10:30"
```

Supported setting values:

- `--content-type fiction|ai|marketing|source`
- `--visibility public|private|mutual|include|exclude`
- `--original true|false`
- `--allow-duet true|false`
- `--allow-copy true|false`
- `--schedule-at "YYYY-MM-DD HH:mm"` enables `定时发布` and fills the observed schedule time input. The final publish click still needs exact-title confirmation.
- `--save-draft` clicks `暂存离开` after filling the draft and should be used only when leaving the editor is intended.
- `--location <query>` best-effort selects the first matching location result.

Keep these manual unless the user explicitly asks for more live research: cover editing/cropping, per-image markers, group chat, live preview, travel route, and smart title suggestions.

After draft fill, review the browser for uploaded media, title, body opening, hashtag text, and final layout.

## Final Publish

Only after visible review:

```bash
node scripts/xhs-publish.mjs --publish \
  --confirm-publish "笔记标题" \
  --title "笔记标题" \
  --markdown-file ./note.md \
  --image ./cover.png
```

The script refuses to publish if `--confirm-publish` does not exactly match `--title`.
