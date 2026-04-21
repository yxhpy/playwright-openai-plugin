# Playwright OpenAI Project Guide

## Project Identity

This repository is for building a CLI that controls an already logged-in OpenAI web browser session through Playwright.

User-provided product fact:

- The target is a browser-backed CLI for OpenAI web surfaces.
- The browser is expected to already be logged in.
- The CLI should eventually expose all practical OpenAI web functions that can be driven from the web UI.

## Current Phase

The repository is in implementation bootstrap phase. The initial `status`, `browser launch`/`stop`, `discover`, and chat commands exist.

Do not add new action commands, browser mutations, or workflow persistence until an iteration plan explicitly allows it.

## Hard Rules

- Treat browser login state as sensitive user state.
- Do not export, print, commit, or persist raw cookies, session tokens, local storage, or authentication headers.
- Prefer attaching to an existing browser session over asking the user to log in again.
- Verify the live OpenAI web UI before assuming selectors, routes, labels, or DOM structure.
- Build workflows as resumable operations: submit, wait, collect, recover, and inspect should be separable.
- Record uncertainty in `docs/memory/OPEN_QUESTIONS.md` instead of guessing.
- Keep each implementation iteration small enough to verify against the real browser.
- Preserve user changes in this repository. Never revert unrelated files.

## Required Workflow For Future Coding Sessions

1. Read `docs/project/PRODUCT_SPEC.md`, `docs/architecture/ARCHITECTURE.md`, and `docs/conventions/ITERATION_CONTRACT.md`.
2. Check `docs/memory/PROJECT_MEMORY.md`, `docs/memory/OPEN_QUESTIONS.md`, and `docs/memory/RISK_REGISTER.md`.
3. Create a task folder from `tasks/_template` before code changes.
4. Reconfirm the current browser/session state before editing browser automation.
5. Add or update decision records for stack, protocol, storage, and security choices.
6. Verify with the real browser or a recorded fixture, and write the evidence into the task execution log.

## Stack Status

Known:

- Browser automation technology: Playwright.
- Product form: CLI.
- Target service: OpenAI web UI in an already logged-in browser.
- Implementation language: Node.js ESM JavaScript.
- Package manager: npm.
- Initial browser attach strategy: CDP endpoint probing plus Playwright `connectOverCDP`.
- Managed browser default profile: `~/.playwright-openai/chrome-profile`.
- First safe discovery command: `poai discover`.
- First action commands: `poai chat send`, `poai chat submit`, `poai chat wait`, `poai chat collect`.
- First file-enabled action: `poai chat submit --prompt <text> --file <path>` for one local readable regular file.
- Chat job management commands: `poai chat jobs list`, `poai chat jobs cleanup`.

Unknown:

- Command taxonomy.
- Output format contract.
- Persistence format beyond non-secret chat job JSON metadata.
- Full safe login verification strategy after manual login.
