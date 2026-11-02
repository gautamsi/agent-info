# agent-info

A band above the prompt that shows the work running in this session: one row
per worker (subagents started with the Agent tool, background shells), with
its status, elapsed time, steps and tool calls, its last tool, and an
estimated cost; a progress bar for the session's task list (the Code tab's
plan, or TodoWrite in a terminal); and the session's cost. A sessions pane
lists every Claude Code session on the machine with its cost, by month.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install agent-info --marketplace gautamsi/agent-info
```

Answer `y` to add the marketplace, then pick the user scope (Enter). It is
active at once, and in every session you start after, the desktop app's Code
tab included.

From a shell:

```
claude plugin install agent-info --marketplace gautamsi/agent-info
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `gautamsi/agent-info`, then Add plugin.

Needs Claude Code 2.1.275 or later. The sessions pane also needs `python3` on
the PATH.

## Use

- **One line by default**, pinned above the prompt: a small pixel critter per
  worker (bobbing while it runs, pulsing while it waits, on a faint green tile
  when done, grey on a faint red tile when it failed or was stopped; hover one
  for its task, steps and cost), `done/total`, a segmented progress bar, the
  percent, the session cost and the workers' share of it. On the desktop the
  line is drawn as one picture, so it never wraps or loses a part.
- **▾** expands it (larger critters, plus one row per worker with elapsed time,
  steps, tool calls, current tool and cost); **▴** collapses it to one line.
  **–** folds it into a chip in the prompt's footer line; click the chip to
  open it again. Both choices are remembered across sessions.
- The bar stays up after the work is done, showing the finished batch and what
  it cost, until the next worker starts a new batch. With nothing tracked yet
  it shows the last saved run.
- Every batch is saved when its last worker finishes. `/agent-info history`
  lists the last 15 runs (date, workers, duration, workers' cost, session cost
  at the time).
- `/agent-info` always brings the bar back (from the chip or from off) and
  prints the current status in the chat; asked again while the bar is up, it
  expands it. `/agent-info mini` folds it to the chip, `/agent-info off` hides
  everything. While a question box is open above the prompt the bar steps
  aside and returns when it closes. The bar opens by itself when a worker
  starts, unless you chose the chip; `/agent-info auto off` stops that.

## Sessions pane

`/agent-info sessions`, or **$** on the bar, opens a pane beside the chat with
every Claude Code session saved on this machine:

- **This month** and **All time** at the top: the cost of every saved
  session in the current calendar month, and in all.
- **Running now**: sessions whose transcript changed in the last 3 minutes
  (this one always), with a green dot, their whole cost and this month's part.
- **Month by month**, newest first: each month's total and how many sessions
  ran in it. This month is open; click an older month to list its sessions,
  each with what it cost in that month (and its total when it spans months).
- **Reset total** adds a "Since reset" figure counted from now; **Clear reset**
  removes it. The month and all-time figures never change with it.

How it is counted: `scripts/scan.py` reads each session's transcript under
`~/.claude/projects` (its subagents' files included) and prices every model
reply at the list prices in `PRICES`, as the bar does, in the local month
it was made in. A reply is counted once
even when several files hold it. A fork (or a resumed session) starts with a
copy of its parent's conversation, and the copied lines keep the parent's
session id, so they stay the parent's: **a fork counts only what it spent
after it split**, and the total never counts a reply twice. A copy whose parent
transcript is gone counts for the oldest file that has it.

The first scan reads every transcript once (a few seconds for several GB);
after that only what each file gained is read, from a cache at
`~/.claude/agent-info/scan-cache.json`. While the pane is open it rescans each
minute. It needs `python3` on the PATH (macOS has one in `/usr/bin`).

Limits: the costs are list-price estimates, not your plan's billing; this
session's own row shows the engine's ledger instead. Cloud sessions, and
transcripts Claude Code has already cleaned up (by default after 30 days),
are not on this machine and are not counted.

## What the numbers are

- **Session cost** is the engine's own ledger (what `/cost` totals): the real
  figure. Without one the bar says "session cost not reported".
- **Workers' share** (`workers ≈$0.42 (20%)`): the ledger prices each API
  response at list prices, so the mod prices each worker's own responses the
  same way and divides by the session total. `<1%` means a small share, not
  zero.
- **Worker cost** (`~$0.08`) is an estimate: the token counts each of the
  worker's model requests reported, priced at list prices per million tokens
  (cache writes at 1.25x input, cache reads at the model's cache price). It
  ignores subscription plans, discounts, fast mode and partner pricing, and
  shows `cost ?` for a model it has no price for. Prices are in `PRICES` in
  `hooks/register.tsx`.
- **Progress** for the main thread is the task list's completed steps. A
  worker has no task list the engine can see, so its row shows how far it has
  got (model requests and tool calls) and its last tool, not a percentage.
- Background shells show running / done from the start of the call to their
  completion notice; they cost nothing in tokens.
- Other Claude sessions (side sessions started from this one) run in their
  own processes; the mod cannot see them.
