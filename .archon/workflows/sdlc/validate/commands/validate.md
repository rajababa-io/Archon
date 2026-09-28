# Validate

Report the truth about the project's own checks. You fix nothing and judge nothing beyond pass or fail. The gate has already run: an earlier node discovered it, and a script ran it as its own process with a 45-minute deadline and recorded the outcome. Your job is to read that record and classify it.

Optional narrowing (may be empty — empty means the full applicable gate):

$INPUTS.scope

The run's trigger message, which may add context:

$ARGUMENTS

The discovered gate:

$INPUTS.discovery

The gate's record — its argv, exit code, whether it hit the deadline, duration, the last lines of output, and any untracked `.archon/` paths moved aside while it ran:

$INPUTS.gate

The full output is at `$ARTIFACTS_DIR/<log>`, where `<log>` is the record's `log` field.

## Read the record

Read the log to learn which checks ran, which passed, which failed, and which never started. Do not re-run the gate or any long check — it would face exactly the limits the gate node exists to avoid. Short foreground commands are fine when a verdict needs corroborating evidence.

The gate ran against the tracked tree: untracked files under `.archon/` are run scaffolding the gate node moved aside for its duration and restored afterwards. Name them in your report when the record lists any.

## Not your job

Do not modify source files, fix failures, commit, push, or touch pull requests. Do not skip a failing check to make the verdict green. Do not re-run a flaky-looking check more than once without saying so.

## Report

Write `$ARTIFACTS_DIR/validation.md`: the gate's argv, exit code, duration, whether it hit the deadline, any quarantined paths, each check's outcome as the log shows it, any applicable check that never ran, and for failures the decisive output tail — enough for a fixer to act without re-running everything. Concise and factual. No one is watching the run — this file and your declared fields are the only record the checks ever ran.

## Declare the verdict

- `green` — true only when every applicable check ran and passed: the gate exited 0 without hitting its deadline. A later node refuses a green verdict over a gate record that did not pass.
- `red_cause` — why the verdict is not green. When a check that ran failed: `introduced`, the change under validation caused it; `inherited`, the same check was already failing at the base this branch came from; `environment`, the machine caused it, not any code — a database or port a parallel process holds, a missing credential, a network fault. `incomplete` when no check that ran failed but not every applicable check ran — the gate hit its deadline or was killed partway, or it could not run at all. An unfinished gate is no evidence about the change, and delivery stops there until the run is resumed. A check that ran and failed takes its own cause even when others never ran. Always declared: use the empty string `""` only when `green` is true.
- `summary` — a few sentences: what ran, what passed, and for a red verdict the failing checks by name. For `incomplete`, what stopped validation and which checks ran and passed.

Classifying red never makes it green — `green` stays false either way. But `inherited` and `environment` let delivery continue, so neither is the comfortable answer: declaring one commits you to evidence. Name the exact failing check and the concrete reason the change under validation cannot have caused it — the same named check failed on the exact base revision, or a resource another process demonstrably holds. Disjoint changed paths alone do not prove independence; a check can read a path another change moves. `$ARTIFACTS_DIR/implementation.md` may already record the same red; corroborate it against the recorded gate output rather than repeating it. Without that evidence the cause is `introduced`.

Reading the record:

- Exit code 0, not timed out — `green: true`.
- Non-zero exit code — the failing check, named from the log, takes its own cause.
- Timed out, or killed with no exit code, and the log shows no failed check — `incomplete`; the summary says the gate did not finish and which checks completed first.
- Not run because discovery found the gate `unrunnable` — `green: false`, `red_cause: incomplete`, with discovery's reason in `summary`.
- Not run because discovery found `none_defined` — `green: true` with the note "no checks defined by this project".

Before declaring, confirm every outcome you cite appears in the recorded output or in a command you ran in this session, and that `validation.md` reflects exactly what happened.

The optional `comparison` path runs outside this agent: a script records the same project gate on pinned change-alone, incoming-base and composed trees. Only that evidence-backed path can declare `interaction`. It remains red and delivery holds the combination. Ordinary validation must not infer interaction from file overlap, prior green badges, or prose claims.
