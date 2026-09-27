# Deploys that announce themselves, hold, and pick up where they left off

**Status:** partly implemented. Drain (refuse new work, wait for old, report
`drain.state` on `/api/health`) shipped first. Park-and-resume (#144) shipped next:
after `DRAIN_GRACE_SECONDS` the deploy parks what is still running and the new server
resumes it — see §7 and `packages/server/src/services/deploy-park.ts`. Holding
messages sent while armed (§6.2), the console banner and `deploy_pending` events are
not built; a message sent while armed is still refused.
**Method:** every claim about current behaviour was read out of the source and
is cited by file and line. Where a comment and the code disagreed, the code won.

---

## 1. The problem
─────────────────────────────────────────────

Shipping a commit recreates the app container, and the container is where the
work lives. Three kinds of work die with it:

```
┌───────────────────────┬──────────────────────────────────────────────┐
│ WHAT                  │ WHY IT DIES                                  │
├───────────────────────┼──────────────────────────────────────────────┤
│ A turn in flight      │ the provider subprocess is in that container │
│ A message queued      │ `messageQueues` is an in-memory Map          │
│   behind a turn       │ (conversation-lock.ts:39)                    │
│ A workflow run        │ executes in-process; the row stays `running` │
└───────────────────────┴──────────────────────────────────────────────┘
```

A chat that is merely *open* already survives: `assistant_session_id` is
persisted per conversation (`packages/core/src/db/sessions.ts:38`), so its next
message resumes the provider session with its context intact. This was not a
prediction — on 2026-09-22 the container was recreated at 16:19:12Z and the
conversation driving the deploy carried straight through it.

`scripts/turn-gap.ts` (shipped 2026-09-22) already refuses to swap while any of
the three exist. That removes the destruction. It does not remove the two costs
that remain:

1. **You cannot use the box while a deploy is pending.** Every message you send
   keeps the box busy, and the wait keeps waiting. The deploy and the operator
   are in a standoff, each politely deferring to the other, and the human always
   loses because they are the one who has to stop.
2. **Nothing announces itself.** No chat is told a deploy is pending. The wait
   observes; it does not negotiate.

## 2. Why it is worth solving
─────────────────────────────────────────────

The turn-gap made deploys *safe*. It did not make them *usable*. On a box with
five concurrent workstreams, "wait for a moment when nobody is doing anything"
can be a long wait, and the operator has to actively stop working to let the
deploy through. That is a tax on the thing the box exists to do.

The evidence is one afternoon: three failed deploys (12:09Z, 13:25Z, 13:39Z),
and a fourth that built successfully and then held for seven minutes, released
only when the operator deliberately went quiet.

## 3. Why now
─────────────────────────────────────────────

The wait is built and proven, which makes this the cheap increment rather than a
rewrite: the quiesce phase already exists and does not change.

The second reason is a defect this design prevents. Workflow run `20fa1e55`
(`archon-ship`) sat `running` for **twelve hours** after the process executing
it was killed by one of the morning's failed deploys. The turn-gap found it —
it was blocking the swap — and it was abandoned by hand. Every interrupted
deploy can mint one of those. A deploy that parks work instead of severing it
does not create them at all.

## 4. Desired outcome
─────────────────────────────────────────────

> You type during a deploy. The composer says *deploying — I'll send this when
> it's back*. Nothing is lost. It answers a few seconds later, in the same chat,
> with its context intact.

Concretely, five phases:

```
1. ARM      the deploy tells the server a swap is coming
2. HOLD     the server stops accepting new turns and says so, on every open chat
3. QUIESCE  turns already in flight finish; scripts/turn-gap.ts already does this
4. SWAP     the container is recreated
5. REPLAY   the new process picks up what was parked and runs it
```

## 5. Invariants
─────────────────────────────────────────────

These are the properties a reviewer should check the implementation against.

1. **No turn is interrupted.** Unchanged from today; phase 3 is the existing
   wait.
2. **A parked message is never lost and never runs twice.** Parking and replay
   are the two halves of one contract.
3. **The drain state cannot outlive its deploy.** A failed, timed-out or
   abandoned deploy must leave the box accepting work. A drain that survives its
   own deploy is worse than no drain: it is an outage with no failing part.
   Therefore arming carries a TTL *and* an explicit disarm, and every exit path
   of `deploy-local.sh` disarms.
4. **Replay happens only for work this server itself parked**, recorded
   unambiguously. See §8 on why that does not violate the ownership rule.
5. **A swap never widens what the box will do.** Draining removes capability
   temporarily; it must not, for example, drop authorization checks on the
   replay path.
6. **The console degrades honestly.** A client that has not been reloaded since
   before this ships must not appear to accept a message that will never run.

## 6. Design
─────────────────────────────────────────────

### 6.1 Arm and disarm

A new endpoint, `POST /api/deploy/arm` / `POST /api/deploy/disarm`, setting a
single in-process flag with an expiry. In-process is correct here: the state
describes *this* process's willingness to start work, and it must die with the
process — persisting it is how invariant 3 gets violated.

`scripts/deploy-local.sh` arms immediately before step 5 (the wait) and disarms
on every exit path, including `die`. The TTL is the backstop for the path no
`trap` can cover — the host losing power mid-deploy.

### 6.2 Hold

`dispatchToOrchestrator` (`packages/server/src/routes/api.ts:2418`) is the single
chokepoint every web message passes through. While armed, it persists the
message as **parked** and returns a status saying so, instead of calling
`lockManager.acquireLock`.

Workflow *starts* are gated the same way. A run started during a drain would be
killed seconds later, which is exactly how `20fa1e55` was born.

### 6.3 Parking, and the schema

`remote_agent_messages` has no status column — `id, conversation_id, role,
content, metadata JSONB, created_at`. Schema evolution here is additive-only
and older binaries may open the same database (`AGENTS.md`, Data and
compatibility).

**Recommendation: a nullable `parked_at TIMESTAMP`**, not a `metadata` key.
Nullable is additive, needs no default, and stays valid for older writers. It is
also indexable, which the replay scan wants. A `metadata` key would avoid the
migration entirely but makes the boot scan a JSONB predicate that has to behave
identically on SQLite and Postgres — a cost paid on every future read to save a
column once.

**Consequence to state plainly:** an older binary opening this database will not
replay parked messages, because it does not know the column exists. They sit
until a current binary runs. That is degradation, not corruption, and it is the
honest price of additive-only.

### 6.4 Announce

The dashboard stream already carries `conversation_lock` events to every open
console (`packages/web/src/experiments/console/lib/sse.ts:55-63`), so the channel
exists. Add `deploy_pending` / `deploy_cleared`, carrying only what the UI needs
to render a state — never a countdown, which would be a promise the deploy
cannot keep.

### 6.5 Replay

On boot, after adapters are initialized, scan for parked messages and dispatch
them in `created_at` order per conversation, clearing `parked_at` as each is
handed to the lock manager.

Ordering rule: **a conversation's parked messages run before anything typed
after the restart.** The user's sequence is the thing being preserved.

Workflows need nothing new. `workflow-resume-service.ts` already scans every 5s
for runs with a resume cursor and continues them, and `run-live-owner.ts` already
models per-run liveness with an explicit `control_handoff`.

## 7. What this does not do
─────────────────────────────────────────────

- **It does not freeze a turn mid-tool-call.** That turn is a provider
  subprocess in the container being replaced; there is no thaw-it-elsewhere. The
  options are finish it (phase 3) or stop it and resume it after the swap. This
  plan chooses **finish within grace, otherwise park and resume**: the deploy waits
  `DRAIN_GRACE_SECONDS` (default 600) for work to finish on its own, then
  `POST /internal/drain/park` interrupts each web chat's turn, saves the messages
  queued behind it, and pauses each top-level workflow run the server executes on a
  `park` wait. The new server gives each parked chat one message telling the agent
  to check what its last step actually finished, replays the queued messages in
  order, exactly once, and resumes the runs through the continuation scanner from
  the node that was in flight. A chat's provider session continues when it has one;
  a chat whose very first turn was parked never saved a session, so the resume
  message quotes the last user message instead. Anything that cannot be parked —
  non-web chats, runs another process owns, runs with a live sub-run — is waited
  for, and named in the deploy log. `DRAIN_PARK=0` keeps the old finish-always
  wait.
- **It does not remove the HTTP gap.** The container still restarts and browsers
  still reconnect for a few seconds. Removing that needs two app instances and
  conversation-sticky routing, which is a separate and much larger piece — and
  worth noting that the in-memory lock (`conversation-lock.ts:38-39`) means two
  instances sharing one conversation would break per-conversation ordering.
- **It does not make deploys faster.**

## 8. The policy question, answered before a reviewer raises it
─────────────────────────────────────────────

`packages/server/src/index.ts:336` is explicit: orphaned-run cleanup is
deliberately **not** run at startup, because doing so killed live runs belonging
to other processes. The rule is that a process must not decide the fate of work
it cannot prove it owns.

Automatic replay is not an exception to that rule, and should not be argued as
one. The distinction is provenance:

- An orphaned `running` row is **ambiguous**. Its owner may be alive elsewhere.
- A parked message is **unambiguous**. This server parked it, during its own
  drain, deliberately, and recorded that it did.

Replaying work you yourself set aside is not guessing about a stranger. The
implementation must keep that true: if the marker ever becomes something another
process could have written, this argument lapses and the design needs revisiting.

As built, the marker is a row in `remote_agent_parked_work`, written only by
`POST /internal/drain/park` (bearer-gated by `ARCHON_DRAIN_TOKEN`) and only for
work this process holds: a web chat in its own lock manager, or a run for which
`isRunOwnedByThisProcess` is true. Replay reads those rows and nothing else.

## 9. Acceptance
─────────────────────────────────────────────

1. A message sent while armed is persisted, not dispatched, and the sender is
   told it is held.
2. After a swap, that message runs, in order, in the same conversation, with the
   provider session resumed.
3. It runs exactly once. Replay is idempotent across a boot that crashes
   mid-replay.
4. A turn in flight when the deploy arms runs to completion.
5. `disarm` restores normal acceptance; so does the TTL expiring; so does the
   process dying.
6. A deploy that times out at phase 3 leaves a box that accepts work, with
   parked messages replayed rather than stranded.
7. No workflow run is started while armed, and no run is left `running` by the
   swap.
8. An un-reloaded console does not silently swallow a message.
9. `bun run validate` passes.

## 10. Work, by package
─────────────────────────────────────────────

```
┌────────────────┬──────────────────────────────────────────┬────────┐
│ PACKAGE        │ WORK                                     │ SIZE   │
├────────────────┼──────────────────────────────────────────┼────────┤
│ core           │ parked_at column + queries; schema on    │ medium │
│                │ both SQLite and Postgres                 │        │
│ server         │ arm/disarm + TTL; gate in                │ large  │
│                │ dispatchToOrchestrator; SSE events;      │        │
│                │ boot replay                              │        │
│ web/console    │ banner; composer holds and reports;      │ medium │
│                │ parked messages render as held           │        │
│ scripts        │ arm before the wait, disarm on every     │ small  │
│                │ exit path including die                  │        │
└────────────────┴──────────────────────────────────────────┴────────┘
```

Suggested order: **scripts and server first, behind the arm flag** — at that
point a deploy already drains correctly even with no UI, because a held message
returns a status the existing client can surface. The console work then improves
a working system rather than being load-bearing for it.

## 11. Open questions for the operator
─────────────────────────────────────────────

1. **How long may a parked message wait before it is stale?** A deploy that
   times out after 30 minutes could replay a message whose moment has passed.
   Replay it anyway, or surface it as held-and-skipped?
   *Answered by #144: always replay. The grace window plus the deploy budget
   bound the age, and the acceptance asks for every parked message to run.*
2. **Should arming block a *new chat*, or only new turns in existing ones?**
   Blocking is simpler; allowing it means a conversation created during a drain
   whose first message is parked.
   *Unchanged: an empty new chat is allowed, one carrying a message is refused.*
3. **Is `parked_at` on messages the right home**, or should parked work be its
   own table? A table costs more now and isolates the concept better if parking
   ever covers more than chat messages.
   *Answered by #144: its own table, `remote_agent_parked_work`. Queued messages
   are not transcript rows, replay needs their staged file paths and sender, and
   parked runs share the same per-drain report.*
