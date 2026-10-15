# Skills

Skills are `SKILL.md` capability bundles: instructions the agent loads into its
system prompt for a session. Think of them as reusable expertise, not scripts.

## Format

A skill is a directory containing `SKILL.md` with YAML frontmatter:

```
my-skill/
  SKILL.md          (required)
  references/       (optional)
  scripts/          (optional)
```

```markdown
---
name: my-skill
description: One line shown in skill/list.
---

# My Skill

Instructions the model follows when this skill is active.
```

The body after the frontmatter is the instruction payload.

## Where skills load from

| Directory | Source tag |
|---|---|
| `./skills/` (project root) | `project` |
| `~/.config/prricode/skills/` | `imported` |

Project skills win ties. Loading happens at session start; active skills are
rendered into the system prompt (`render_skills_prompt`).

## CLI

```bash
prricode skills list                       # show discovered skills
prricode skills import /path/to/my-skill   # copy into ~/.config/prricode/skills
prricode skills import /path/to/my-skill --dry-run
prricode skills activate my-skill          # session-scoped; see server
```

`import` accepts either a `SKILL.md` directory (prricode and Claude layouts —
they are the same shape) or a single markdown file (Codex-style), which is
wrapped into a skill directory automatically. Refuses to overwrite an existing
skill unless the destination is removed first.

## Protocol

- `skill/list` — every discovered skill: name, source, description, location.
- `skill/import` — `{source, dryRun, force}`; returns `imported`, `name`, `dest`.
- `skill/setActivation` — `{activation, scope, selector}`; persisted per session.

## Skill scripts (runtime contract)

A skill may ship executable helpers under `scripts/`. The runtime contract,
with this invocation contract:

```
<interpreter> <skill-dir>/scripts/<helper> <args...>
```

- The interpreter comes from the script's **shebang**
  (`#!/usr/bin/env python3` → `env python3`; `#!/bin/bash` → bash; no shebang →
  the file must be executable and is run directly).
- Scripts execute through **`prricode-sandbox`** with no network and a 120s
  timeout; the caller's workspace root is where data files resolve.
- Loaded skills expose `scripts` and `script_command()`; the bundled
  `wordcount` skill (`skills/wordcount/`) is the worked example and is
  executed end-to-end in its tests.

## Authoring tips

- One skill, one job. Name it after the job.
- Front-load constraints ("never do X") — models follow early rules better.
- Reference concrete commands and paths from the target project.
- Keep under ~150 lines; the prompt budget is shared with the conversation.
