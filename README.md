# opencode-leaner

![opencode-leaner](src/assets/opencode-leaner.jpeg)

An [opencode](https://opencode.ai) plugin that reduces the context sent to the model — shorter tool descriptions and lean agent definitions (some of them are more like experiments).

## Features

### Trimmed tool descriptions

Opencode's builtin tool descriptions are verbose. The plugin hooks `tool.definition` and replaces/trim the descriptions of tools with short, minimal versions (see [`src/tools/*.txt`](src/tools/))

The rules applied "the tools should have the essential to execute the tool, other instructions should be pruned from tools".

Examples:

 - "Use `gh` for GitHub tasks, including PRs, issues, checks, and releases; return the PR URL when done." from bash/shell tool - it should not be in the shell/bash tool description, it is too specific and out of the scope of the tool description or usage.

 - "ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required." from write tool - if need this, it should be a agents.md or custom agent prompt instruction.

 - "Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked." from write tool - if need this, it should be a agents.md or custom agent prompt instruction. This sentence overlap if other tools and system prompt too.

Tool parameters, output format, truncation caps, and permission prompts are untouched — only the description text changes.

### Lean agents

The plugin hooks `config` and injects five agent definitions (defined in [`src/agents`](src/agents) as markdown with YAML frontmatter):

| Agent | Description | Tools | Tokens at start [1] | Notes
| --- | --- | --- | --- | --- |
| `bash` | Coding assistant only with bash (similar to the mini-swe-agent)| `bash` | ~1,300  | A experiment to let opencode agent similar to the mini-swe-agent. It only has the bash tool so the agent must read, write, find files and do all other actions from bash. |
| `blank` | Coding assistant without tools and without prompt | none | ~220 | Since this agent does not have any tool, it works more like a chat |
| `minimal` | Coding assistant with minimal prompt but with tools | all core tools | ~7000 | Use if you want all tools like grep, subagents and skills, but dont want a 1k tokens agent prompt |
| `coding` | Coding assistant with a pruned, verbose-minimized prompt | all core tools | ~8100 | It is the Build agent that is built in opencode, but pruned|
| `pi-like` | Coding assistant similar to pi in built tools and prompt | `bash`, `edit`, `glob`, `grep`, `read`, `write`, `skill` | ~5500 | Has a minimal set of tools, no subagents and one line agent prompt |

[1] Tokens at start was calculated in a empty folder, with not project or personal AGENTS.md, and but with various skills (about ~2600 tokens in skill descriptions).
Base Build agent in the same enviroment uses ~10,300 tokens.

If an agent with the same id already exists in your config, the plugin's definition is deep-merged over it (your config wins on conflict).

Set `OPENCODE_LEANER_AGENT_PREFIX` surpass the conflicts name, e.g. `OPENCODE_LEANER_AGENT_PREFIX=lean` inject `lean-bash` instead of `bash`.

## Install

### Npm package

Register the plugin in your opencode config (e.g. `opencode.json`):

```json
{
  "plugin": ["opencode-leaner"]
}
```

### Manual

```sh
git clone <repo-url> opencode-leaner
cd opencode-leaner
bun install
```

Register the plugin in your opencode config (e.g. `opencode.json`), pointing at the plugin entrypoint:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-leaner/index.ts"]
}
```

## Development

```sh
# Run the log proxy regression tests
bun test

# Typecheck
bunx tsc

# Run the log proxy
bun run log-proxy
```

The log proxy tests use a local HTTP server and do not call any model providers. Validate plugin changes by loading the plugin in opencode and inspecting the debug context dump or the proxy log.

### Debug context

With `OPENCODE_LEANER_DEBUG_CONTEXT=1`, the plugin appends the outgoing messages, system prompt, chat params, and headers for every request to a file (default: `/tmp/opencode-context-debug.txt`), so you can inspect offline what was actually sent to the model.

### Log proxy

`scripts/log-proxy.mjs` is a small Bun HTTP proxy for OpenAI-compatible endpoints. It forwards requests to an upstream server and logs the (pretty-printed) request body — and optionally the response — to a file. Useful for measuring context size at the wire level.

### Configuration

All options are environment variables read by the plugin (and the log proxy):

| Variable | Default | Description |
| --- | --- | --- |
| `OPENCODE_LEANER_AGENT_PREFIX` | _(empty)_ | Prefix added to injected agent ids, e.g. `lean-bash` |
| `OPENCODE_LEANER_DEBUG_CONTEXT` | _(off)_ | Set to `1` to dump outgoing context to a file |
| `OPENCODE_LEANER_DEBUG_CONTEXT_PATH` | `/tmp/opencode-context-debug.txt` | Output file for the debug context dump |
| `OPENCODE_LEANER_PROXY_PORT` | `18077` | Port for the log proxy |
| `OPENCODE_LEANER_PROXY_UPSTREAM` | `http://192.168.2.56:8077/v1` | Upstream base URL the proxy forwards to |
| `OPENCODE_LEANER_PROXY_LOG_FILE` | `/tmp/opencode-proxy-requests.txt` | Log file for the proxy |
| `OPENCODE_LEANER_PROXY_LOG_RESPONSE` | _(off)_ | Set to `1` to also log response bodies |

## License

[MIT](LICENSE)
