import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { canonicalJson, type DemandEventStore } from "@/db/profile-demand-events.js";
import type { ProfileOwnerStore } from "@/db/profile-owners.js";
import type { DemandEligibilityProvider } from "./demand-eligibility.js";
import {
  type DemandRequest,
  demandRequestSchema,
  validateDemandRequest,
} from "./profile-demand-ingress.js";

/** Publication never dispatches or claims a profile. Eligibility is rechecked before every lease. */
export class ProfileDemandService {
  constructor(
    readonly events: DemandEventStore,
    readonly owners: ProfileOwnerStore,
    readonly eligibility: DemandEligibilityProvider,
    private readonly options: { allowlistPath?: string; now?: () => number } = {},
  ) {}

  publishDemand(value: unknown) {
    const request = validateDemandRequest(value, {
      ...(this.options.allowlistPath ? { allowlistPath: this.options.allowlistPath } : {}),
      ...(this.options.now ? { now: this.options.now() } : {}),
    });
    const owner = this.owners.get(request.profileId);
    const evaluation = this.eligibility.evaluate({ request, owner, phase: "publish" });
    // A valid off-duty declaration retains the immutable demand, but does not wake.
    const waiting = [
      "demand:duty-off-duty",
      "demand:duty-waiting",
      "demand:duty-deferred",
    ].includes(evaluation.reasonCode);
    if (!evaluation.eligible && !waiting) throw new Error(evaluation.reasonCode);
    const result = this.events.publish(request, this.options.now?.() ?? Date.now());
    if (waiting) this.events.withhold(result.obligationId, evaluation.reasonCode);
    else if (!owner) this.events.withhold(result.obligationId, "demand:owner-unclaimed");
    else if (!owner.acceptedSourceKinds.includes("profile-demand"))
      this.events.withhold(result.obligationId, "demand:owner-capability-unknown");
    return result;
  }

  lookupDemand(input: { profileId: string; sourceId: string; idempotencyKey: string }) {
    return this.events.lookup(input);
  }

  evaluateLease(input: { demandEventId: string; obligationId: string; profileId: string }) {
    const event = this.events.get(input.demandEventId);
    if (!event || event.profile_id !== input.profileId) {
      this.events.withhold(input.obligationId, "demand:event-missing");
      return { eligible: false, reasonCode: "demand:event-missing" };
    }
    let request: DemandRequest;
    try {
      request = validateDemandRequest(JSON.parse(event.payload_json), {
        ...(this.options.allowlistPath ? { allowlistPath: this.options.allowlistPath } : {}),
        ...(this.options.now ? { now: this.options.now() } : {}),
      });
    } catch {
      this.events.withhold(input.obligationId, "demand:invalid-event");
      return { eligible: false, reasonCode: "demand:invalid-event" };
    }
    if (
      createHash("sha256").update(canonicalJson(request)).digest("hex") !== event.payload_sha256 ||
      request.episodeId !== event.episode_id ||
      request.activationRevision !== event.activation_revision ||
      request.idempotencyKey !== event.idempotency_key
    ) {
      this.events.withhold(input.obligationId, "demand:episode-mismatch");
      return { eligible: false, reasonCode: "demand:episode-mismatch" };
    }
    const evaluation = this.eligibility.evaluate({
      request,
      owner: this.owners.get(input.profileId),
      phase: "lease",
    });
    this.events.withhold(input.obligationId, evaluation.eligible ? null : evaluation.reasonCode);
    return evaluation;
  }

  snapshot(id: string): DemandRequest | null {
    const event = this.events.get(id);
    if (!event) return null;
    try {
      const snapshot: unknown = JSON.parse(event.payload_json);
      if (!Value.Check(demandRequestSchema, snapshot)) return null;
      if (
        createHash("sha256").update(canonicalJson(snapshot)).digest("hex") !== event.payload_sha256
      )
        return null;
      return snapshot;
    } catch {
      return null;
    }
  }
}
