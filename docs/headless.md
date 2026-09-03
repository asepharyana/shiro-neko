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
shiro: headless denies write_file, edit_file, multi_edit, apply_patch, bash, web_fetch and mcp tools unless --yolo is passed
[tool] write_file {"path":"test/paginate.test.ts",...}
[denied] write_file (run with --yolo to allow tool use in headless mode)
```

Read-only tools work either way, so `-p` without `--yolo` is a safe way to ask questions
about a codebase from a script. That includes `read_many_files`, `list_dir`, and the git tools,
which is enough to review a diff or explain a module without any write access at all.

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
{"type":"tool-start","id":"c1","name":"grep"}
{"type":"tool-call","id":"c1","name":"grep","input":{"pattern":"tool\\("}}
{"type":"tool-result","id":"c1","name":"grep","output":"src/tools.ts:26: ..."}
{"type":"text","text":"There are 16 built-in tools."}
{"type":"done","inputTokens":4210,"outputTokens":88}
```

Event types: `text`, `reasoning`, `tool-start`, `tool-call`, `tool-output`, `tool-result`,
`tool-error`, `tool-denied`, `compacted`, `notice`, `error`, `done`.

`tool-start` arrives before the arguments have finished streaming, so it carries the name but
no input. Use `tool-call` when you need the arguments.

Errors are flattened to message strings, because `JSON.stringify` turns an `Error` into `{}`
and a JSON stream that reports failures as empty objects is useless for the one case it
matters.

## Exit codes

`0` on success, `1` on a model or stream error. A denied tool is not a failure — the model was
told and can respond to it.

```bash
if shiro -p "does this build?" --yolo; then echo ok; else echo failed; fi
```

That distinction is deliberate and it has a consequence: **a successful run says nothing about
whether the answer was yes.** `0` means the turn completed, not that the build passed. To gate CI
on the content, read the output:

```bash
shiro -p "Does this build? Answer only YES or NO." --json --yolo \
  | jq -r 'select(.type=="text") | .text' | grep -q YES
```

Anything that must fail the build has to be asserted on text or, better, on the exit code of a
real command the agent ran.

## Timeouts

There is no wall-clock limit on a headless run. Three things bound it:

- `maxSteps` per variant — 12 for `quick`, 50 by default, 80 for `deep`.
- The `timeout` the model passes to `bash`, 120 s by default and 600 s at most.
- Whatever your CI runner enforces, which is the only hard stop.

Interactively `ctrl-c` kills one command and keeps the turn. Headless has no terminal for that, so
a signal ends the run. In CI, prefer `--agent quick` and a runner timeout over hoping.

## Sessions

Headless runs save like interactive ones, so `-c` picks up where one left off:

```bash
shiro -p "start the refactor" --yolo
shiro -p "now update the tests" --yolo -c
```

Useful, and worth knowing the shape of: each `-p` run is **one turn**, and `-c` resumes the newest
session for that directory. Two concurrent runs in the same directory therefore fight over the
same session, and the second overwrites the first. Pass `-r <id>` to keep parallel runs separate,
or point them at different `SHIRO_HOME` directories.

Memory also accumulates. An unattended loop calling `remember` writes to the project store like
any other run, so `--no-memory` is worth considering for a job that runs on every push.

## What is withheld

The `ask` tool is not offered at all, rather than being offered and left to hang. The model
is told to decide and state its assumption instead.

Subagent progress events are not emitted; the report still comes back.

There is no terminal, so `ctrl-c` cannot interrupt a single command the way it does
interactively — a signal kills the run. Cap the risk with the `timeout` the model passes to
`bash`, or with `--agent quick` to cap the step count.

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

Two more worth having in a workflow. Trim the tool schema to what the job needs, since a CI run
pays for it on every step:

```yaml
- run: echo '{ "toolSets": [] }' > ~/.shiro-neko/config.json
```

And keep an unattended job from inheriting an installed skill nobody reviewed:

```yaml
- run: shiro -p "..." --agent review --no-skills --no-plugins
```

`--no-skills` matters more in CI than locally: a skill installed from a registry is instructions
in the system prompt, and CI is exactly where nobody is watching what it says. See
[registry](registry.md).

## Cost control

Headless runs are unattended, so a runaway loop costs real money. `--agent quick` caps the
step count at 12, and `{ "toolSets": [] }` trims the schema sent every request. There is no
spend ceiling yet — see [TODO.md](../TODO.md).

What a run actually costs is in the `done` event, so a wrapper can total it:

```bash
shiro -p "..." --json --yolo | jq -r 'select(.type=="done" and .inputTokens) | "\(.inputTokens) in, \(.outputTokens) out"'
```

The token fields are optional: an aborted turn emits `done` with neither, which is why the filter
checks for one rather than assuming it.
