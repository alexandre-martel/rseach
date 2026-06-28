# Changelog

## 0.1.0 — Initial Release

- Full research pipeline: literature search, analysis, code extraction, experiments, analysis, report
- LLM providers: Ollama (local), Claude, OpenAI
- Literature sources: arXiv, Semantic Scholar, DuckDuckGo web search, custom URL sources
- arXiv category filtering (cs.LG, cs.AI, cs.RO, stat.ML, etc.)
- Iterative experiment loop with LLM-guided hyperparameter exploration
- Reflection step between experiment rounds
- Early stopping after N rounds without improvement
- Checkpoint and resume for experiments
- Markdown and LaTeX report generation
- Telegram bot integration (notifications + remote commands)
- Skills system for persistent LLM instructions (global + workspace)
- Pipeline tree view with real-time progress tracking
- Settings webview with source, category, and skills management
