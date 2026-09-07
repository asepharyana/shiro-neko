---
name: api-design
description: Design or revise an HTTP or library API. Use when adding an endpoint, shaping request/response bodies, naming resources, or reviewing an API for consistency.
---

# API design

An API is a contract. Every choice is a promise you cannot take back without a major version.

## Resource before action

Name things, not verbs. `POST /users` to create, not `POST /createUser`. The URL is the
noun; the method is the verb. When you reach for a verb in the path, that is a sign the
resource is missing — `POST /users/:id/deactivations` reads better than `/deactivateUser`
when the operation has state of its own.

## Shape the body for the reader

- Field names are `snake_case` or `camelCase`, picked once for the whole API. A body that
  mixes both is a body nobody documented.
- Return the object, not a wrapper, unless the wrapper carries something: `{ "user": {...} }`
  only when there is also pagination, a cursor, or an error envelope.
- Errors have a stable shape: a machine-readable `code`, a human `message`, and the field
  that failed. A client should never have to parse the message.

## Status codes mean something

- `201` for a created resource, with the resource in the body.
- `204` for success with nothing to return.
- `400` for a body that failed validation, `401` unauthenticated, `403` authenticated but
  not allowed, `404` not found or not allowed to know, `409` a conflict with current state,
  `422` well-formed but semantically wrong.
- Never `200` with an error in the body. A client checking only the status will treat it as
  success.

## Idempotency and safety

GET, PUT, DELETE must be safe to retry: same request, same state. POST is not. If a client can
double-submit, provide an idempotency key or a natural unique constraint, and say which.

## Version when you must, not before

Add fields freely; removing or renaming is a break. If you are not yet committed, say so with
a `beta` or `v0` marker rather than locking a shape you have not used. Document the contract
you guarantee, not the implementation that happens to produce it.
