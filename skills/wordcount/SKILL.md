---
name: wordcount
description: Count words, lines, and characters in files.
---

# Wordcount

Use the bundled helper to count text in workspace files:

    python3 <skill-dir>/scripts/wordcount.py <file> [--lines] [--chars]

The helper prints a one-line summary. Prefer it over ad-hoc shell pipelines
when the user asks for simple text statistics.
