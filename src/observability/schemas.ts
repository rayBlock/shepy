import { Type } from "@sinclair/typebox";

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
    harnessKind: Type.String({ minLength: 1 }),
    harnessSessionRefJson: Type.String({ minLength: 1 }),
    herdrSessionName: Type.String({ minLength: 1 }),
    paneId: Type.String({ minLength: 1 }),
    profileId: Type.String({ minLength: 1 }),
    subscriberId: Type.String({ minLength: 1 }),
    terminalId: Type.String({ minLength: 1 }),
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

export const inboxRetryInputSchema = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
