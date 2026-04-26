# X Articles Publish Automation

This repo includes a standalone Playwright script for preparing X Articles from a logged-in browser session:

```bash
node scripts/x-articles-publish.mjs --dry-run \
  --title "Article title" \
  --markdown-file ./article.md
```

After `npm link` or plugin packaging, the same script is also available as:

```bash
x-articles-publish --dry-run --title "Article title" --markdown-file ./article.md
```

Repo-local npm shortcuts:

```bash
npm run x:launch
npm run x:articles:inspect
npm run x:articles:capabilities
npm run x:articles:dry-run -- --title "Article title" --markdown-file ./article.md
npm run x:articles:draft -- --title "Article title" --markdown-file ./article.md
```

## Browser Setup

Start a managed Chrome profile and log into X once:

```bash
node src/cli.js browser launch --url https://x.com/compose/articles
node scripts/x-articles-publish.mjs --inspect
```

`--inspect` should report `session_state: "editor_ready"`. If it reports `login_required`, complete login in the visible browser and rerun `--inspect`.

X Articles are account-gated. X documents that publishing Articles requires Premium, Premium+, Premium Business, or Premium Organizations access, and the composer is reached from the Articles tab on x.com by clicking Write.

## Modes

- `--dry-run`: default. Validates local Markdown and converts it to X-friendly HTML/text. It does not touch the browser.
- `--inspect`: opens or finds the X Article composer in the CDP browser and reports detected controls.
- `--capabilities`: probes the currently visible X Article editor controls and reports native UI support versus what this script automates today.
- `--draft`: fills the visible X Article title/body editor and stops before final publish.
- `--validate-preview`: after `--draft`, opens X's preview page, verifies visible title/body text, then returns to the editor.
- `--publish`: performs the same work as `--draft`, then clicks the X publish control only when `--confirm-publish` exactly matches `--title`.

## Article Format Rules

Use the X title field for the article title. Avoid duplicating the same title as the first `# H1`; pass `--strip-title-heading` if the source file already includes it.

Supported Markdown subset:

```markdown
## Heading

Paragraph with **bold**, *italic*, ~~strikethrough~~, and [links](https://example.com).

> Blockquote with emoji ✅

- Bullet one
- Bullet two

1. Step one
2. Step two

![Chart](./images/chart.png)

---

```js
console.log("native code block")
```

$$E=mc^2$$

{{x:post:https://x.com/OpenAI/status/2016959338523611621}}

{{x:gif:celebrate}}
```

X documents support for headings, subheadings, bold, italics, strikethrough, indentation, numbered lists, bulleted lists, images, video, GIFs, posts, and links. This script automates the stable text-formatting subset plus standalone local Markdown images and native GIF/post/divider/code/LaTeX inserts. Native post embeds are status-only (`/status/...`) in the current X Articles dialog; `/i/articles/...` links are rejected as invalid post URLs. Remote Markdown image URLs are rejected because X's media dialog uploads local files; download them first or place them manually during review.

Run a live capability probe after login:

```bash
node scripts/x-articles-publish.mjs --capabilities --endpoint http://127.0.0.1:9333
```

The probe separates:

- `observed_native`: controls exposed by the current X editor UI, such as blockquote, link dialog, media file input, GIF, post embed, divider, code, and LaTeX menu items.
- `automated_by_script`: features currently filled and verified by this repo's script.

## Current Capability Matrix

The latest live probe against the logged-in editor at `https://x.com/compose/articles/edit/...` reported:

| Feature | X editor exposes it | Script automates it |
| --- | --- | --- |
| Title field | yes | yes |
| Body editor | yes | yes |
| Publish button | yes | guarded by exact-title confirmation |
| Preview link | yes | yes with `--validate-preview` |
| Focus mode | yes | no |
| Bold | yes | yes |
| Italic | yes | yes |
| Strikethrough | yes | yes |
| Heading/subheading style | yes | yes for Markdown headings |
| Blockquote | yes | yes for Markdown `>` quotes |
| Unordered list | yes | yes |
| Ordered list | yes | yes |
| Link dialog | yes, fields: `source`, `text` | yes through rich-text paste |
| Emoji | yes | yes through Unicode rich-text paste |
| Local Markdown images | yes, via media dialog | yes for standalone `![alt](./image.png)` jpg/png/webp/gif files |
| Remote Markdown images | n/a | no; rejected before browser mutation |
| Media upload | yes, accepts `image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime` | yes for local image files; video remains manual-review-only |
| GIF insert | yes | yes for `{{x:gif:query}}` markers |
| X post embed | yes, menu item `帖子` | yes for `{{x:post:https://x.com/user/status/123}}` markers when X validates the URL; `/i/articles/...` is rejected as invalid |
| X post embed from `/i/articles/...` URLs | rejected by current post dialog | no |
| Divider | yes, menu item `分割线` | yes for Markdown thematic breaks (`---`) |
| Code block | yes, menu item `代码` | yes for fenced code blocks |
| LaTeX | yes | yes for `$$...$$` blocks |
| Cover/header image | no separate control observed | not yet |
| Indentation | documented by X | not yet; nested list paste collapses to depth 0 |

Treat any feature marked "not yet" as manual-review-only until a dedicated smoke test proves insertion and read-back.

Use local Markdown image paths on their own line for Article body images:

```markdown
![Chart](./images/chart.png)
```

The script resolves local image paths relative to the Markdown file, uploads them through X's `媒体` dialog, and verifies that the Article body gains a native media section. Remote image URLs such as `![Chart](https://example.com/chart.png)` are rejected; download them locally first. GIFs can either be uploaded as local image files or inserted through X's GIF search dialog. Keep native dividers, code, LaTeX, X post embeds, and GIF markers before local images; a live smoke test showed native blocks after local images can drift in X's preview/order. Video and any cover/header image requirement are still manual-review-only until a dedicated read-back smoke test proves a stable automation path.

Native block extensions:

- Use `---`, `***`, or `___` on its own line for an X divider.
- Use fenced code blocks such as <code>```js</code> for X's native code insert dialog.
- Use `$$E=mc^2$$` or a multiline `$$ ... $$` block for X's native LaTeX insert dialog.
- Use `{{x:post:https://x.com/user/status/123}}` for X's native post insert dialog. The URL must resolve in X's dialog; invalid, private, deleted, or unavailable posts fail before publication. `{{x:post:https://x.com/i/articles/...}}` is currently rejected as "invalid post URL".
- Use `{{x:gif:celebrate}}` for X's GIF search dialog. The script inserts the first visible result for the query and verifies a native media block appears in the Article body.

## Safety Gate

Normal automation should stop at `--draft`:

```bash
node scripts/x-articles-publish.mjs --draft \
  --endpoint http://127.0.0.1:9333 \
  --title "Playwright 控制 X Articles 发布实践" \
  --markdown-file ./article.md \
  --strip-title-heading \
  --validate-preview
```

Only run `--publish` after visually confirming the title, body formatting, links, lists, preview output, and any manually uploaded media in the browser:

```bash
node scripts/x-articles-publish.mjs --publish \
  --confirm-publish "Playwright 控制 X Articles 发布实践" \
  --title "Playwright 控制 X Articles 发布实践" \
  --markdown-file ./article.md
```

## Implementation Boundary

The public X API is not used for Articles publishing here. The stable public API surface is suitable for ordinary posts, while Articles publishing is a web-editor flow. This script therefore follows the same safety model as the CSDN publisher in this repo: local validation first, visible browser draft second, exact-title confirmation before real publication.

OpenCLI currently has `twitter article` for reading/exporting an X Article and `twitter post` for ordinary posts/threads, but no Article publish command. Use this Playwright script for X Article drafting, and use `opencli twitter article <url>` later as an optional read-back check after publication.
