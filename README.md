# ResearchLoop

Autonomous AI-powered research loop for VS Code. ResearchLoop automates the full ML research cycle: literature review, code extraction, experiment design, hyperparameter tuning, and report generation.

## Features

- **Literature Search** — Searches arXiv, Semantic Scholar, and DuckDuckGo for relevant papers. Supports custom sources (any website via domain-scoped search).
- **Paper Analysis** — LLM-powered analysis of papers for relevance, methods, and key findings.
- **Code Extraction** — Extracts reusable code snippets from discovered papers and repositories.
- **Experiment Engine** — Iterative experiment loop with automatic hyperparameter exploration, reflection between rounds, and early stopping.
- **Checkpoint & Resume** — Pause and continue experiments across sessions without losing progress.
- **Results Analysis** — Automated statistical analysis of experiment results.
- **Report Generation** — Produces Markdown or LaTeX reports summarizing the full research cycle.
- **Telegram Notifications** — Get notified on pipeline events and control your pipeline remotely via bot commands (`/status`, `/pause`, `/continue`, `/restart`, `/new`).
- **Skills System** — Persistent user instructions injected into LLM prompts (global or per-workspace).

## Supported LLM Providers

| Provider | Model (default) | Notes |
|----------|----------------|-------|
| **Ollama** | llama3.1 | Free, local, no API key needed |
| **Claude** | claude-sonnet-4 | Requires Anthropic API key |
| **OpenAI** | o3-mini | Requires OpenAI API key |

## Quick Start

1. Install the extension
2. Open the **ResearchLoop** panel in the Activity Bar
3. Click **+** to create a new research session
4. Enter your research question and target metrics
5. Click **Run** — the pipeline handles the rest

## Configuration

Open **ResearchLoop: Settings** from the command palette to configure:

- LLM provider and API keys
- Literature sources (built-in + custom URLs)
- arXiv categories filter
- Experiment limits (max experiments, early stopping threshold)
- Telegram bot notifications
- Skills (persistent instructions for the LLM)

## Telegram Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram and copy the bot token
2. Open a chat with your bot and send `/start` to initialize the channel
3. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in your browser
4. Copy the `chat.id` value from the JSON response
5. In VS Code settings, set:
   - `researchloop.notifications.telegram.enabled`: `true`
   - `researchloop.notifications.telegram.botToken`: your bot token
   - `researchloop.notifications.telegram.chatId`: the chat ID from step 4
6. Reload VS Code — you should receive a "ResearchLoop connected" message

**Commands**: `/status` `/pause` `/resume` `/stop` `/continue` `/continue N` `/restart` `/new`

> If you open multiple VS Code workspaces with Telegram enabled, messages are prefixed with `[workspace-name]` so you know which instance is talking. Each instance processes commands independently.

## Requirements

- VS Code 1.85+
- **For local LLM**: [Ollama](https://ollama.ai) running on localhost
- **For experiments**: Python 3.8+ with scikit-learn (installed automatically if missing)

## License

[MIT](LICENSE)
