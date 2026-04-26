---
name: x-articles-publish
description: Use the Playwright X Articles publisher to validate Markdown, inspect a logged-in X Article composer, fill a visible draft, and stop before publication unless exact-title confirmation is explicitly provided.
---

# X Articles Publish

Use this skill for preparing or publishing X Articles through the logged-in managed browser from this plugin checkout.

## Safety Rules

- Do not click the final X publish button unless the user explicitly asks for real publication.
- Real publication requires both `--publish` and `--confirm-publish "<exact title>"`; do not bypass this confirmation lock.
- Prefer `--draft` for end-to-end verification because it fills the visible composer but stops before final publish.
- Treat X login state, cookies, local storage, and account URLs as sensitive. Do not export or persist them.
- If `--inspect` reports `login_required` or `articles_access_required`, ask the user to complete login/access in the visible browser and rerun inspect.

## Entrypoints

From the repository root:

```bash
node scripts/x-articles-publish.mjs --help
```

From the installed package bin:

```bash
x-articles-publish --help
```

## Browser Setup

Start or inspect the managed browser on the X Article composer:

```bash
node src/cli.js browser launch --url https://x.com/compose/articles
node scripts/x-articles-publish.mjs --inspect --endpoint http://127.0.0.1:9333
node scripts/x-articles-publish.mjs --capabilities --endpoint http://127.0.0.1:9333
```

If the browser is already running and logged into X, inspect first:

```bash
node scripts/x-articles-publish.mjs --inspect
```

Expected ready state:

```json
{
  "page": {
    "session_state": "editor_ready"
  }
}
```

## Capability Probe

Before deciding whether a requested feature can be automated, probe the current X editor:

```bash
node scripts/x-articles-publish.mjs --capabilities \
  --endpoint http://127.0.0.1:9333
```

Use `observed_native` for what X currently exposes and `automated_by_script` for what this plugin actually fills and verifies today.

## Markdown Validation

Run this before browser mutation:

```bash
node scripts/x-articles-publish.mjs --dry-run \
  --title "Article title" \
  --markdown-file ./article.md \
  --strip-title-heading
```

Supported Markdown subset:

- headings and subheadings;
- paragraphs;
- blockquotes and emoji text;
- bold, italic, strikethrough, and inline code through rich-text paste;
- links;
- ordered and unordered lists;
- standalone local Markdown images such as `![alt](./image.png)`;
- native dividers from `---`, `***`, or `___`;
- native code blocks from fenced code;
- native LaTeX blocks from `$$...$$`;
- native X post embeds from `{{x:post:https://x.com/user/status/123}}` when X validates the URL; `x:post` markers for `/i/articles/...` URLs are currently rejected as invalid and remain manual only;
- native GIF inserts from `{{x:gif:celebrate}}`, using the first visible X GIF search result.

Local Markdown image paths are uploaded through X's `媒体` dialog and verified by native media block read-back. Remote Markdown image URLs are blocked; download them locally first. `帖子` embeds are status-URL-only (`.../status/...`) and can fail on non-post/article URLs. Keep native dividers, code, LaTeX, X post embeds, and GIF markers before local images; native blocks after local images are rejected because live preview/order read-back drifted. Cover/header images and videos are still manual-review-only.

## Draft Fill

Fill the visible editor and stop:

```bash
node scripts/x-articles-publish.mjs --draft \
  --endpoint http://127.0.0.1:9333 \
  --title "Article title" \
  --markdown-file ./article.md \
  --strip-title-heading \
  --validate-preview
```

After draft fill, review the browser for title, body opening, headings, blockquotes, lists, links, local image media blocks, native dividers, native code/LaTeX blocks, native X post embeds (status URL only), preview text, and any manually added cover/header/video media.

## Final Publish

Only after visible review:

```bash
node scripts/x-articles-publish.mjs --publish \
  --confirm-publish "Article title" \
  --title "Article title" \
  --markdown-file ./article.md
```

The script refuses to publish if `--confirm-publish` does not exactly match `--title`.

## Read-Back Check

After publication, use the visible result page or `opencli twitter article <url>` to export the live X Article as Markdown and compare it with the source.
