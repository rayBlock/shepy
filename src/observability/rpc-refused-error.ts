/**
 * The base class of every refusal the RPC layer is allowed to publish as a
 * stable machine-readable `code` on the error envelope. Subclasses declare
 * the refusal taxonomy callers branch on (e.g. InboxRefusedError's
 * `not_owner` / `owner_lapsed`, which gates the hook's lapsed-owner
 * recovery). The daemon serialises `code` only for `instanceof` this class,
 * so a dispatch failure that merely carries a Node-shaped system code
 * (EACCES, ENOENT) can never masquerade as a Shepy refusal on the wire.
 */
export class RpcRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RpcRefusedError";
    this.code = code;
  }
}
