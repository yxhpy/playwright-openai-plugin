# Xiaohongshu Publish Automation

This repo includes a standalone Playwright script for preparing Xiaohongshu notes from a logged-in Creator browser session:

```bash
node scripts/xhs-publish.mjs --dry-run \
  --title "笔记标题" \
  --markdown-file ./note.md \
  --image ./cover-or-first-image.png
```

After `npm link` or plugin packaging, the same script is also available as:

```bash
xhs-publish --dry-run --title "笔记标题" --markdown-file ./note.md --image ./image.png
```

Repo-local npm shortcuts:

```bash
npm run xhs:launch
npm run xhs:inspect
npm run xhs:dry-run -- --title "笔记标题" --markdown-file ./note.md --image ./image.png
npm run xhs:draft -- --title "笔记标题" --markdown-file ./note.md --image ./image.png
```

Inspect the current support matrix:

```bash
node scripts/xhs-publish.mjs --capabilities
```

## Browser Setup

Start a managed Chrome profile and log into Xiaohongshu Creator once:

```bash
node src/cli.js browser launch --url "https://creator.xiaohongshu.com/publish/publish?source=official"
node scripts/xhs-publish.mjs --inspect
```

`--inspect` should report `session_state: "editor_ready"`. If it reports `login_required`, complete login in the visible browser and rerun `--inspect`.

## Modes

- `--dry-run`: default. Validates local Markdown and media paths. It does not touch the browser.
- `--inspect`: opens or finds the Xiaohongshu Creator publish page in the CDP browser and reports detected controls.
- `--draft`: uploads media, fills the visible title/body editor, and stops before final publish.
- `--publish`: performs the same work as `--draft`, then clicks the publish control only when `--confirm-publish` exactly matches `--title`.

## Note Format Rules

Use the Xiaohongshu title field for the note title. Avoid duplicating the same title as the first `# H1`; pass `--strip-title-heading` if the source file already includes it.

Supported Markdown subset is converted to plain note text:

```markdown
## 小节

正文 **重点** 和 [链接](https://example.com)。

- 要点一
- 要点二

#话题 #标签
```

Pass display-order local media with repeated `--image` flags:

```bash
node scripts/xhs-publish.mjs --draft \
  --endpoint http://127.0.0.1:9333 \
  --title "Playwright 控制小红书发布实践" \
  --markdown-file ./note.md \
  --strip-title-heading \
  --image ./cover.png \
  --image ./step-1.png
```

Markdown image syntax is intentionally not mapped into the editor. Keep captions in text and pass media files through `--image`.

Append topics explicitly when you want deterministic tag text:

```bash
node scripts/xhs-publish.mjs --draft \
  --title "笔记标题" \
  --markdown-file ./note.md \
  --image ./cover.png \
  --topic AI工具 \
  --topic 自动化
```

The web editor may normalize a typed hashtag into the closest platform topic. The script verifies the main body text and treats topic conversion as a platform behavior to review visually.

## Supported Settings

The observed Xiaohongshu Creator image-text editor currently exposes these automatable settings:

```bash
node scripts/xhs-publish.mjs --draft \
  --endpoint http://127.0.0.1:9333 \
  --title "笔记标题" \
  --markdown-file ./note.md \
  --image ./cover.png \
  --original true \
  --content-type ai \
  --visibility public \
  --allow-duet true \
  --allow-copy true \
  --schedule-at "2026-04-27 10:30"
```

Supported values:

- `--content-type fiction|ai|marketing|source`
- `--visibility public|private|mutual|include|exclude`
- `--original true|false`
- `--allow-duet true|false`
- `--allow-copy true|false`
- `--schedule-at "YYYY-MM-DD HH:mm"` enables `定时发布` and fills the observed schedule time input. The final click still requires the normal `--publish --confirm-publish "<exact title>"` gate.
- `--save-draft` clicks `暂存离开` after filling the draft. Use it only when you want to leave the editor after saving.
- `--location <query>` uses the location picker and chooses the first matching visible result. This is best-effort because location results depend on account/browser geolocation and platform ranking.

Observed but intentionally still manual:

- `图片编辑` / `封面建议`: visual crop/template work should remain manual.
- `标记地点或标记朋友`: per-image hotspot placement is visual.
- `选择群聊`, `关联直播预告`, `添加路线`: account/state-dependent surfaces.
- `智能标题`: suggestions are non-deterministic; the script keeps caller-provided `--title`.

## Safety Gate

Normal automation should stop at `--draft`. Only run `--publish` after visually confirming the uploaded media, title, body, and tags in the browser:

```bash
node scripts/xhs-publish.mjs --publish \
  --confirm-publish "Playwright 控制小红书发布实践" \
  --title "Playwright 控制小红书发布实践" \
  --markdown-file ./note.md \
  --image ./cover.png
```

## Implementation Boundary

This script uses the Xiaohongshu Creator web editor through Playwright/CDP. It does not use private APIs and does not export cookies, local storage, auth headers, or account data.
