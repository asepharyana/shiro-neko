# Headless mode

`-p` runs one prompt without the TUI. For scripts, CI, and piping.

```bash
shiro -p "list every route and its handler"
git diff | shiro -p "review this diff" --yolo
shiro -p "fix the failing test" --yolo --agent deep
```

The prompt comes from the argument, or from stdin when the argument is omitted.

## Tool use needs `--yolo`

There is no terminal to approve on, so every gated tool is denied unless `--yolo` is passed:

```
$ shiro -p "add a test for paginate()"
shiro: headless denies write_file, edit_file, bash and mcp tools unless --yolo is passed
[tool] write_file {"path":"test/paginate.test.ts",...}
[denied] write_file (run with --yolo to allow tool use in headless mode)
```

Read-only tools work either way, so `-p` without `--yolo` is a safe way to ask questions
about a codebase from a script.

**`--yolo` does not disable plugin guards.** `rm -rf` is still refused.

## Output

### Text mode (default)

Assistant text to stdout, everything else to stderr. Pipe-friendly:

```bash
shiro -p "one-line summary of src/session.ts" > summary.txt
```

```
$ shiro -p "what does prune.ts do?" 2>/dev/null
src/prune.ts repairs provider-item dependencies after pruneMessages strips reasoning items.
```

### JSON mode

`--json` emits one event per line:

```bash
$ shiro -p "count the tools" --json
{"type":"tool-call","id":"c1","name":"grep","input":{"pattern":"tool\\("}}
{"type":"tool-result","id":"c1","name":"grep","output":"src/tools.ts:26: ..."}
{"type":"text","text":"There are 6 built-in file and shell tools."}
{"type":"done","inputTokens":4210,"outputTokens":88}
```

Event types: `text`, `reasoning`, `tool-call`, `tool-output`, `tool-result`, `tool-error`,
`tool-denied`, `compacted`, `notice`, `error`, `done`.

Errors are flattened to message strings, because `JSON.stringify` turns an `Error` into `{}`
and a JSON stream that reports failures as empty objects is useless for the one case it
matters.

## Exit codes

`0` on success, `1` on a model or stream error. A denied tool is not a failure — the model was
told and can respond to it.

```bash
if shiro -p "does this build?" --yolo; then echo ok; else echo failed; fi
```

## Sessions

Headless runs save like interactive ones, so `-c` picks up where one left off:

```bash
shiro -p "start the refactor" --yolo
shiro -p "now update the tests" --yolo -c
```

## What is withheld

The `ask` tool is not offered at all, rather than being offered and left to hang. The model
is told to decide and state its assumption instead.

Subagent progress events are not emitted; the report still comes back.

## CI recipes

Review a pull request diff:

```yaml
- run: |
    git diff origin/main...HEAD > /tmp/diff
    shiro -p "Review this diff. Report defects with file and line. Say so if it is clean." \
      --agent review < /tmp/diff
```

`--agent review` is read-only, so no `--yolo` is needed and nothing can be modified.

Fail the build on a specific finding:

```yaml
- run: |
    shiro -p "Does any handler skip input validation? Answer only YES or NO." --json \
      | jq -r 'select(.type=="text") | .text' | grep -qv YES
```

Generate a changelog entry:

```yaml
- run: |
    git log --oneline "$(git describe --tags --abbrev=0)"..HEAD \
      | shiro -p "Write a changelog entry from these commits. Group by user-facing change." \
      >> CHANGELOG.md
```

Pass the key as a secret:

```yaml
env:
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Cost control

Headless runs are unattended, so a runaway loop costs real money. `--agent quick` caps the
step count at 12. There is no spend ceiling yet — see [ROADMAP.md](../ROADMAP.md).
