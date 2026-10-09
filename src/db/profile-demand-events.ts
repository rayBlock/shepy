import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DemandRequest } from "@/observability/profile-demand-ingress.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("demand:non-json-value");
  return encoded;
}

export type DemandEvent = {
  id: string;
  profile_id: string;
  source_id: string;
  idempotency_key: string;
  episode_id: string;
  activation_revision: number;
  payload_json: string;
  payload_sha256: string;
  created_at: number;
};
export type DemandLookup =
  | { found: false }
  | {
      found: true;
      demandEventId: string;
      obligationId: string;
      payloadSha256: string;
      state: string;
      withheldReason: string | null;
      createdAt: number;
    };

/** The durable daemon-owned episode/activation and delivery outbox share a SQLite transaction. */
export class DemandEventStore {
  constructor(private readonly sqlite: DatabaseSync) {}

  get(id: string): DemandEvent | undefined {
    return this.sqlite.prepare("select * from profile_demand_events where id = ?").get(id) as
      | DemandEvent
      | undefined;
  }

  lookup(input: { profileId: string; sourceId: string; idempotencyKey: string }): DemandLookup {
    const row = this.sqlite
      .prepare(`select e.id as demand_event_id, o.id as obligation_id, e.payload_sha256,
      o.state, o.last_error_code as withheld_reason, e.created_at from profile_demand_events e
      join delivery_obligations o on o.profile_demand_event_id = e.id and o.profile_id = e.profile_id
      where e.profile_id = ? and e.source_id = ? and e.idempotency_key = ?`)
      .get(input.profileId, input.sourceId, input.idempotencyKey) as
      | {
          demand_event_id: string;
          obligation_id: string;
          payload_sha256: string;
          state: string;
          withheld_reason: string | null;
          created_at: number;
        }
      | undefined;
    return row
      ? {
          found: true,
          demandEventId: row.demand_event_id,
          obligationId: row.obligation_id,
          payloadSha256: row.payload_sha256,
          state: row.state,
          withheldReason: row.withheld_reason,
          createdAt: row.created_at,
        }
      : { found: false };
  }

  hasActiveDemand(profileId: string): boolean {
    return Boolean(
      this.sqlite
        .prepare(`select 1 from delivery_obligations
      where profile_id = ? and kind = 'demand' and state in ('leased', 'delivered') limit 1`)
        .get(profileId),
    );
  }

  withhold(obligationId: string, reasonCode: string | null): void {
    this.sqlite
      .prepare(
        "update delivery_obligations set last_error_code = ? where id = ? and state = 'pending' and profile_demand_event_id is not null",
      )
      .run(reasonCode, obligationId);
  }

  publish(request: DemandRequest, now: number = Date.now()) {
    const payloadJson = canonicalJson(request);
    const payloadSha256 = createHash("sha256").update(payloadJson).digest("hex");
    this.sqlite.exec("begin immediate");
    try {
      const previous = this.lookup({
        profileId: request.profileId,
        sourceId: request.sourceId,
        idempotencyKey: request.idempotencyKey,
      });
      if (previous.found) {
        if (previous.payloadSha256 !== payloadSha256)
          throw new Error("demand:idempotency-conflict");
        this.sqlite.exec("commit");
        return {
          disposition: "existing" as const,
          demandEventId: previous.demandEventId,
          obligationId: previous.obligationId,
          payloadSha256,
        };
      }
      const eventId = randomUUID();
      const obligationId = randomUUID();
      this.sqlite
        .prepare(`insert into profile_demand_events
        (id, profile_id, source_id, idempotency_key, episode_id, activation_revision, payload_json, payload_sha256, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          eventId,
          request.profileId,
          request.sourceId,
          request.idempotencyKey,
          request.episodeId,
          request.activationRevision,
          payloadJson,
          payloadSha256,
          now,
        );
      this.sqlite
        .prepare(`insert into delivery_obligations
        (id, profile_id, profile_demand_event_id, delivery_seq, kind, state, attempt_count, created_at)
        values (?, ?, ?, coalesce((select max(delivery_seq) + 1 from delivery_obligations), 1), 'demand', 'pending', 0, ?)`)
        .run(obligationId, request.profileId, eventId, now);
      this.sqlite.exec("commit");
      return {
        disposition: "created" as const,
        demandEventId: eventId,
        obligationId,
        payloadSha256,
      };
    } catch (error) {
      this.sqlite.exec("rollback");
      throw error;
    }
  }
}
