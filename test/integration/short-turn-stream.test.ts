import { expect, test } from "vitest";
import { shortTurnFixture, until } from "./short-turn-fixture.js";

test("F1 rejects stale pane subscriptions, refreshes before retry, and discovers later panes", async () => {
  const f = await shortTurnFixture();
  try {
    const extra = (pane_id: string) => ({
      ...f.worker,
      pane_id,
      terminal_id: pane_id,
      name: "extra",
    });
    f.workers.set("wT:stale", extra("wT:stale"));
    await f.refresh();
    f.workers.delete("wT:stale"); // Closed while the daemon was down.
    await f.start();
    const rejected = f.subscribeLog.findIndex((s) => !s.accepted);
    // A snapshot-first watcher can avoid the initial rejection altogether.
    if (rejected >= 0) {
      const failure = f.subscribeLog[rejected];
      const recovery = f.subscribeLog[rejected + 1];
      expect(recovery?.panes).toEqual([f.worker.pane_id]);
      expect(recovery?.snapshots).toBeGreaterThan(failure?.snapshots ?? 0);
    }
    await f.turn(1);
    await until(() => f.outcomes().length === 1);

    // The same refusal can happen between an online snapshot and subscribe.
    f.workers.set("wT:closing", extra("wT:closing"));
    f.closeOnSubscribe = "wT:closing";
    f.emit({ type: "pane.created", pane_id: "wT:closing" });
    await until(() => f.subscribeLog.some((s) => !s.accepted && s.panes.includes("wT:closing")));
    await until(() => !f.db.agents.list({}).some((a) => a.paneId === "wT:closing"));
    f.workers.set("wT:later", extra("wT:later"));
    f.emit({ type: "pane.created", pane_id: "wT:later" });
    await until(() => f.subscribed("wT:later"));
    const refusals = f.subscribeLog.filter((s) => !s.accepted);
    expect(refusals.filter((s) => s.panes.includes("wT:stale")).length).toBeLessThanOrEqual(1);
    expect(refusals.filter((s) => s.panes.includes("wT:closing"))).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("F2 and F3 deliver done-only turns once and suppress the same final replayed as working then done", async () => {
  const f = await shortTurnFixture();
  try {
    await f.refresh();
    f.holdSubscriptions = true;
    await f.manager.start();
    await until(() => f.heldSubscriptions.length === 1);
    await f.final(1); // Working happened before this subscription could see it.
    f.afterAck = () => {
      f.afterAck = undefined;
      f.status("done");
    };
    f.releaseSubscriptions();
    await until(() => f.outcomes().length === 1);
    expect(f.outcomes()[0]?.payload).toMatchObject({ from: "done", to: "done" });

    await f.final(2);
    await f.refresh(); // Snapshot catches the turn before its queued wire pair.
    f.status("working");
    f.status("done");
    await until(() =>
      f
        .events()
        .some(
          (e) =>
            e.type === "agent.status.changed" && (e.payload as { to: string }).to === "working",
        ),
    );
    await until(() => f.db.agents.list({})[0]?.agentStatus === "done");
    await f.turn(3); // Passing control: a genuinely different final still delivers.
    await until(() =>
      f.outcomes().some((e) => e.compactHistory?.lastAssistantMessage?.text === "answer 3"),
    );
    await f.manager.stop();
    expect(f.outcomes().map((e) => e.compactHistory?.lastAssistantMessage?.text)).toEqual([
      "answer 1",
      "answer 2",
      "answer 3",
    ]);
  } finally {
    await f.close();
  }
});

test("F4 a covered pane with no status events gets only one refresh-cycle grace", async () => {
  const f = await shortTurnFixture();
  try {
    await f.start();
    await f.final(1);
    await f.rescan();
    expect(f.outcomes()).toHaveLength(0); // Give an already-connected stream one cycle.
    await f.rescan();
    expect(f.outcomes().map((e) => e.compactHistory?.lastAssistantMessage?.text)).toEqual([
      "answer 1",
    ]);
    await f.rescan();
    expect(f.outcomes()).toHaveLength(1); // The repaired cursor does not repeat it.
  } finally {
    await f.close();
  }
});

test("a complete short turn inside a topology refresh retains its working event and one outcome", async () => {
  const f = await shortTurnFixture();
  try {
    await f.start();
    await f.turn(1); // Passing control, outside any refresh window.
    await until(() => f.outcomes().length === 1);
    f.holdSnapshots = true;
    f.shells.add("wT:new-shell");
    f.emit({ type: "pane.created", pane_id: "wT:new-shell" });
    await until(() => f.heldSnapshots.length > 0);
    await f.turn(2);
    f.releaseSnapshots();
    await until(() => f.outcomes().length === 2);
    await f.manager.stop();
    expect(
      f
        .events()
        .filter(
          (e) =>
            e.type === "agent.status.changed" && (e.payload as { to: string }).to === "working",
        ),
    ).toHaveLength(2);
    expect(f.outcomes().map((e) => e.compactHistory?.lastAssistantMessage?.text)).toEqual([
      "answer 1",
      "answer 2",
    ]);
  } finally {
    await f.close();
  }
});
