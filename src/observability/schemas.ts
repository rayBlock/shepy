import { Type } from "@sinclair/typebox";
import { demandRequestSchema } from "./profile-demand-ingress.js";

export const demandLookupInputSchema = Type.Object(
  {
    schema: Type.Literal("factory.demand.lookup.v1"),
    profileId: Type.String({ minLength: 1 }),
    sourceId: Type.String({ minLength: 1 }),
    idempotencyKey: Type.String({ minLength: 1, maxLength: 192 }),
  },
  { additionalProperties: false },
);
export const demandPublishInputSchema = demandRequestSchema;
export const acceptedSourceKindsSchema = Type.Array(
  Type.Union([Type.Literal("agent"), Type.Literal("profile-demand")]),
  { minItems: 1, uniqueItems: true },
);

export const agentSessionRefSchema = Type.Object(
  {
    agent: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("id"), Type.Literal("path")]),
    source: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const agentListInputSchema = Type.Object(
  {
    all: Type.Optional(Type.Boolean()),
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentGetInputSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    target: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentSelectorSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("terminalId"), value: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("paneId"), value: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("name"), value: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("agentSession"), value: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      agent: Type.String({ minLength: 1 }),
      kind: Type.Literal("runtimeKindPlusCwd"),
      cwd: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const profileEnsureInputSchema = Type.Object(
  {
    displayName: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
    projectRoots: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const profileShowInputSchema = Type.Object(
  { profileId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const profileDiagnoseInputSchema = Type.Object(
  {
    // The CLI's own build stamp, when the caller volunteers it: the daemon
    // compares it against its own and reports daemon_version_skew in the
    // findings. Absent (raw RPC callers) → no skew finding.
    cliBuildStamp: Type.Optional(Type.String({ minLength: 1 })),
    profileId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const profileSubscribeInputSchema = Type.Object(
  {
    agentSelector: agentSelectorSchema,
    herdrSessionName: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const profileUnsubscribeInputSchema = profileSubscribeInputSchema;

export const profilePruneInputSchema = Type.Object(
  {
    ageMs: Type.Integer({ minimum: 0 }),
    profileId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const operationDispatchInputSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    profileId: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const operationGetInputSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
    profileId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const operationWaitInputSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
    profileId: Type.Optional(Type.String({ minLength: 1 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
  },
  { additionalProperties: false },
);

export const agentReadInputSchema = Type.Object(
  {
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    target: Type.String({ minLength: 1 }),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const agentEventsInputSchema = Type.Object(
  {
    afterEventId: Type.Optional(Type.Integer({ minimum: 0 })),
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const piPresenceSessionRefSchema = Type.Object(
  {
    agent: Type.Literal("pi"),
    kind: Type.Literal("path"),
    source: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const agentOrchestratorRegisterInputSchema = Type.Object(
  {
    herdrSocketPath: Type.String({ minLength: 1 }),
    paneId: Type.String({ minLength: 1 }),
    sessionRef: piPresenceSessionRefSchema,
    subscriberId: Type.String({ minLength: 1 }),
    subscriberKind: Type.Literal("pi"),
    workspaceId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const agentOrchestratorSetInputSchema = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);

export const agentOrchestratorGetInputSchema = Type.Object({}, { additionalProperties: false });

export const agentOrchestratorAckInputSchema = Type.Object(
  { eventId: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const profileClaimInputSchema = Type.Object(
  {
    // Proof of possession for a same-lease re-claim: the daemon-minted
    // token the claimant currently holds. Only an exact match against the
    // live owner's token takes the fast path; omitted or stale, the claim
    // waits out the lease. Identity fields are public by design and
    // authenticate nothing.
    currentLeaseToken: Type.Optional(Type.String({ minLength: 1 })),
    acceptedSourceKinds: Type.Optional(acceptedSourceKindsSchema),
    harnessKind: Type.String({ minLength: 1 }),
    harnessSessionRefJson: Type.String({ minLength: 1 }),
    // Host location is optional ALL-OR-NONE: a standalone owner carries none
    // of these; a hosted owner carries all three. Partial tuples are refused
    // by the owner store before any mutation. Never fabricate Herdr fields.
    herdrSessionName: Type.Optional(Type.String({ minLength: 1 })),
    paneId: Type.Optional(Type.String({ minLength: 1 })),
    profileId: Type.String({ minLength: 1 }),
    subscriberId: Type.String({ minLength: 1 }),
    terminalId: Type.Optional(Type.String({ minLength: 1 })),
    workspaceId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const profileReleaseInputSchema = Type.Object(
  {
    leaseToken: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const inboxListInputSchema = Type.Object(
  {
    // Cursor: only rows strictly OLDER than this agent event id (newest-first
    // order unchanged). The read-back paging for a deferred tail.
    before: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    profileId: Type.String({ minLength: 1 }),
    state: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("leased"),
        Type.Literal("delivered"),
        Type.Literal("acked"),
        Type.Literal("dead_letter"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export const inboxLeaseInputSchema = Type.Object(
  {
    leaseToken: Type.String({ minLength: 1 }),
    sourceKinds: Type.Optional(acceptedSourceKindsSchema),
    maxBatch: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    profileId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const inboxDeliveredInputSchema = Type.Object(
  {
    harnessTurnId: Type.Optional(Type.String({ minLength: 1 })),
    ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    leaseToken: Type.String({ minLength: 1 }),
    ownerSessionRefJson: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const inboxAckInputSchema = Type.Object(
  {
    errorCode: Type.Optional(Type.String({ minLength: 1 })),
    ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    leaseToken: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const inboxDeferInputSchema = Type.Object(
  {
    ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    leaseToken: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const inboxGetInputSchema = Type.Object(
  { obligationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const inboxRetryInputSchema = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const inboxRetireInputSchema = Type.Object(
  {
    olderThan: Type.Optional(Type.Integer({ minimum: 0 })),
    profileId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
