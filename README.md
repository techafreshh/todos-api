# todos-api

A paginated, sortable, filterable TODO collection API, grown issue-by-issue
by the pi-dark-factory. Single plain-Node process, zero runtime
dependencies, in-memory state.

## What it does

`POST /todos`, `GET /todos` with `status` / `sort` / `order` / `limit` /
`cursor` query semantics (stable cursor pagination with deterministic
tie-breaks), `PATCH /todos/<id>` state transitions, `DELETE /todos/<id>` —
with a validation contract that never leaks a 500.

## Documents

- [`PRD.md`](./PRD.md) — background, the exact query-semantics contract
  (sort ties, cursor stability, validation rejections), non-goals, and the
  delivery requirements (CI workflow + docker-compose `worker` shipped by
  the factory).

## Operating model

Built autonomously: issues come from slicing `PRD.md`; every issue is
implemented, verified black-box (runtime + adversarial holdout scenarios,
including seeded-collection pagination), reviewed, and squash-merged. The
verifier's probe contract lives outside this repo by design.
