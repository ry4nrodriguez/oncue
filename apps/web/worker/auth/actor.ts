// A verified caller: an internal user id and its private workspace id, never
// the Clerk subject. Only `register.ts` calls `constructActor`, so an
// unauthenticated code path fails to typecheck rather than merely fail review.

declare const actorBrand: unique symbol;

export type Actor = {
  readonly [actorBrand]: true;
};

type ActorFields = {
  readonly userId: string;
  readonly workspaceId: string;
};

type ConcreteActor = Actor & ActorFields;

export function constructActor(userId: string, workspaceId: string): Actor {
  return { userId, workspaceId } as ConcreteActor;
}

export function actorUserId(actor: Actor): string {
  return (actor as ConcreteActor).userId;
}

export function actorWorkspaceId(actor: Actor): string {
  return (actor as ConcreteActor).workspaceId;
}
