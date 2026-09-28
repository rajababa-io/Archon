# Discover the gate

Find the project's own checks and declare the command that runs them. You do not run it: the next node runs the command you declare as its own process, with a deadline no agent shell has, and records the result. Running it here wastes the time and proves nothing.

Optional narrowing (may be empty — empty means the full applicable gate):

$INPUTS.scope

The run's trigger message, which may add context:

$ARGUMENTS

## Discover

1. Discover the checks from the repository itself: package scripts, task runners, CI workflow definitions, contributor docs. Never invent a generic command the project does not define; never substitute your own idea of a check for the project's.
2. Honor any documented aggregate gate (a `validate`/`check` script) over reassembling its pieces by hand. Apply a non-empty scope through the gate's own documented narrowing, never an invented command.
3. If dependencies are missing, install them with the project's own package manager in locked mode, in the foreground — a gate that fails on a broken environment is reporting the environment, not the code.

Do not run the gate or any check. Do not move files: untracked files under `.archon/` are run scaffolding, and the gate node moves them aside itself while the gate runs.

## Declare the gate

- `gate` — `run` when you found the gate. `none_defined` only when the repository genuinely defines no checks. `unrunnable` when a gate exists but cannot run here — a missing toolchain, a failed locked install.
- `argv` — for `run`, the command as an argument vector, for example `["bun", "run", "validate"]`. It runs at the checkout root without a shell; when the project's own documented command genuinely needs one, declare `["bash", "-c", "<that command>"]`. Empty for `none_defined` and `unrunnable`.
- `reason` — for `unrunnable`, what stops the gate; otherwise a short note on where the gate is defined.

Do not write `validation.md`; the node after the gate writes it.
