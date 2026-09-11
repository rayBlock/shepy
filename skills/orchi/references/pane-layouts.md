# Pane layouts for Orchi

Read `herdr pane layout --pane "$HERDR_PANE_ID"` and the installed command help
before arranging panes. Pane IDs and rectangles come from Herdr, never guesses.
`--current` refers to the caller; the UI-focused pane may belong to the user.

## Choose a useful shape

- **One worker:** lead | worker on a wide rectangle; stack on a narrow one.
- **Two workers:** a large lead pane beside a column containing the two workers.
- **Three workers:** a 2×2 grid (lead + three workers).
- **More:** only when there are genuinely independent tasks and enough space.
  Ask before opening another tab/workspace or rearranging someone else's panes.

Use roughly 70–90 columns and 18–24 rows per coding pane as a comfort target,
not a hard terminal requirement. Inspect the actual sub-rectangle available to
Orchi, not the full screen's width. If it cannot fit the grid, use fewer panes,
reuse idle workers, or ask about a dedicated tab. Do not keep splitting a tiny
pane until every worker has an unreadable strip.

## Two workers, large lead pane

Starting from an authorized lead pane:

```text
┌──────────────────┬─────────────────┐
│                  │ worker A        │
│ lead             ├─────────────────┤
│                  │ worker B        │
└──────────────────┴─────────────────┘
```

1. Split the lead rectangle right, preserving focus. Capture the returned right
   pane ID.
2. Split **that right pane** down, not the lead again. Capture the new bottom
   pane ID.
3. Start one agent in each new available shell pane; keep the lead intact.

Commands (variables must contain discovered IDs):

```bash
herdr pane split --pane "$LEAD" --direction right --ratio 0.5 --cwd "$PWD" --no-focus
# RIGHT = result.pane.pane_id from the preceding response
herdr pane split --pane "$RIGHT" --direction down --ratio 0.5 --cwd "$PWD" --no-focus
# BOTTOM_RIGHT = result.pane.pane_id from that response
herdr pane layout --pane "$LEAD"
```

Inspect the result before any resize: ratio orientation/constraints are defined
by the installed Herdr version. Do not assume a numeric ratio means a particular
number of columns without checking the returned layout.

## Three workers, balanced 2×2 grid

```text
┌──────────────────┬─────────────────┐
│ lead             │ worker A        │
├──────────────────┼─────────────────┤
│ worker B         │ worker C        │
└──────────────────┴─────────────────┘
```

Split the lead right; split each resulting column down. The existing lead stays
in its pane. All three other panes must be newly created or already authorized
for this task. An idle *unrelated* pane is not free real estate.

```bash
herdr pane split --pane "$LEAD" --direction right --ratio 0.5 --cwd "$PWD" --no-focus
# Capture RIGHT.
herdr pane split --pane "$LEAD" --direction down --ratio 0.5 --cwd "$PWD" --no-focus
# Capture BOTTOM_LEFT.
herdr pane split --pane "$RIGHT" --direction down --ratio 0.5 --cwd "$PWD" --no-focus
# Capture BOTTOM_RIGHT.
herdr pane layout --pane "$LEAD"
```

Only create this layout when you need those workers. Empty preallocated panes
are not an orchestration strategy.

## Existing layouts

- Prefer reusing your idle worker before adding another pane.
- `herdr pane resize --pane <id> --direction <direction> --amount <value>` adjusts
  a split; inspect `--help` and the result rather than assuming amount units.
- `herdr pane swap --source-pane <id> --target-pane <id>` swaps positions of
  authorized panes; it does not create fresh agent context.
- `herdr pane move ... --target-pane <id> --split right|down --no-focus` can
  restructure owned panes. Moving workspaces changes the pane's address: read
  the returned ID, update subscriptions and handoff, and retire the old address.
- Re-resolve agent identity before prompting or closing. A pane can contain a
  different session than it did earlier.

Do not issue any rearrangement command just to demonstrate the skill. Layout
changes belong to an actual user-authorized orchestration task.
