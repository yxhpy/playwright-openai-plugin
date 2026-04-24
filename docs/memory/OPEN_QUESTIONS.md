# Open Questions

## 2026-04-24 - ChatGPT Thinking Time Selector Automation

Status: open
Source: Image difficulty routing update.
Evidence: Later live smoke testing confirmed the managed CDP endpoint was usable and image generation worked through `instant`, `thinking`, and `heavy`. The separate ChatGPT Web Thinking time selector itself still has not been verified as a stable automatable control.

Question: What stable selectors and labels should `poai` use to set ChatGPT Web Thinking time values Light, Standard, Extended, and Heavy?

Current decision: Image `--model auto` routes difficult prompts to Thinking, and explicit `light`, `extended`, `heavy`, `low`, `medium`, `high`, and `xhigh` express requested thinking effort in metadata. The CLI does not yet mutate the separate Thinking time toggle until that selector is verified live.
