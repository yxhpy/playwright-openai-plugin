# CSDN Publish Automation

This repo includes a standalone Playwright script for preparing CSDN Markdown articles from a logged-in browser session:

```bash
node scripts/csdn-publish.mjs --dry-run \
  --title "文章标题" \
  --markdown-file ./article.md \
  --cover ./cover.png \
  --image hero=./hero.png
```

After `npm link` or plugin packaging, the same script is also available as:

```bash
csdn-publish --dry-run --title "文章标题" --markdown-file ./article.md
```

Repo-local npm shortcuts:

```bash
npm run csdn:launch
npm run csdn:inspect
npm run csdn:dry-run -- --title "文章标题" --markdown-file ./article.md
npm run csdn:draft -- --title "文章标题" --markdown-file ./article.md --cover ./cover.png
```

## Browser Setup

Start a managed Chrome profile and log into CSDN once:

```bash
node src/cli.js browser launch --url https://editor.csdn.net/md/
node scripts/csdn-publish.mjs --inspect
```

`--inspect` should report `session_state: "editor_ready"`. If it reports `login_required`, complete login in the visible browser and rerun `--inspect`.

## Modes

- `--dry-run`: default. Validates local Markdown, image placeholders, cover path, and CSDN-specific formatting rules. It does not touch the browser.
- `--inspect`: opens or finds the CSDN editor in the CDP browser and reports detected controls.
- `--draft`: fills the CSDN editor, opens publish settings, uploads cover when provided, and stops before final publish.
- `--publish`: performs the same work as `--draft`, then clicks the final publish button only when `--confirm-publish` exactly matches `--title`.

## Article Format Rules

Use the CSDN title field for the article title. Avoid duplicating the same title as the first `# H1`; pass `--strip-title-heading` if the source file already includes it.

Use fenced code blocks with a language:

````markdown
```bash
npm run check
```
````

Use normal Markdown for public images:

```markdown
![架构图](https://example.com/arch.png)
```

For local images that need CSDN upload, put a placeholder at the exact insertion point:

```markdown
部署结果如下：

{{csdn:image:deploy-result}}
```

Then pass:

```bash
--image deploy-result=./images/deploy-result.png
```

This avoids publishing local filesystem paths that CSDN cannot render.

## Cover

Pass `--cover ./cover.png` with `--draft` or `--publish`. The script opens CSDN publish settings and uploads the cover through the image file input it finds after the publish dialog appears. Because CSDN changes its UI frequently, always review the visible browser before using `--publish`.

## Example

```bash
node scripts/csdn-publish.mjs --dry-run \
  --title "Playwright 自动发布 CSDN 文章实践" \
  --markdown-file ./article.md \
  --cover ./cover.png \
  --image hero=./hero.png \
  --tags Playwright,CSDN,自动化 \
  --category 自动化

node scripts/csdn-publish.mjs --inspect

node scripts/csdn-publish.mjs --draft \
  --title "Playwright 自动发布 CSDN 文章实践" \
  --markdown-file ./article.md \
  --cover ./cover.png \
  --image hero=./hero.png \
  --summary "文章摘要，最多 256 字" \
  --tags Playwright,CSDN,自动化 \
  --category AI编程 \
  --article-type original \
  --visibility public
```

Only run `--publish` after visually confirming the draft in the browser, and include an exact title confirmation:

```bash
node scripts/csdn-publish.mjs --publish \
  --confirm-publish "Playwright 自动发布 CSDN 文章实践" \
  --title "Playwright 自动发布 CSDN 文章实践" \
  --markdown-file ./article.md
```
