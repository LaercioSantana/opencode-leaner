
## Project
`opencode-leaner` (package `opencode-leaner`) is an opencode plugin that help you reduce the context size, making it lean and more efficient.

## Stack
- TypeScript, run with Bun

## Conventions
- Each tool mirrors its opencode builtin: same params, output format, truncation caps, permission prompts (`ctx.ask`).
- Descriptions in `<tool>.txt` stay minimal; implementation defines behavior.

## Verify
- Typecheck: `bunx tsc`
- Log proxy tests: `bun test` (local HTTP fixtures; no model provider required).
- Validate plugin changes by loading the plugin in opencode and opencode debug.
