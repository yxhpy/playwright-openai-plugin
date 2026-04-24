# Image Difficulty Routing

Date: 2026-04-24
Status: completed

## Goal

Update the plugin so image generation no longer treats Pro as the only high-quality path. Route image requests by prompt difficulty and use ChatGPT Thinking for harder image work while avoiding Pro for image generation.

## Evidence

- OpenAI Help Center says ChatGPT image generation is available with Instant and Thinking, but not Pro.
- OpenAI Help Center documents Thinking time controls: Light, Standard, Extended, and Heavy.
- ChatGPT Images 2.0 system card documents a thinking mode for image generation.
- Initial local `poai status --json` and `poai discover --json` found no usable CDP endpoint for the first implementation slice.
- Later live smoke testing found the managed CDP endpoint ready and verified `instant`, `thinking`, and `heavy` image generation end to end. The separate Thinking time selector remains unverified.

## Scope

- Add deterministic image prompt difficulty routing in existing model selection code.
- Preserve existing `submit`, `wait`, `collect`, `revise`, and action-pack workflow shape.
- Update CLI help and plugin skill guidance.
- Do not add unverified browser mutations for the Thinking time picker.

## Verification

- Run `npm run check`.
- Run local read-only `scripts/poai status --json` after code changes.
- Run live image-generation smoke for explicit `instant`, `thinking`, and `heavy` routes when a managed browser session is available.
- Refresh the installed local plugin copy and cache.
