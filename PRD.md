# PRD — todos-api

## Background

The commonest shape of internal product is a collection API: create items,
filter/sort/page over them, mutate state transitions, and validate every
input at the boundary. This product is that shape, complete: an in-memory
TODO collection API whose difficulty is not storage but **semantics** —
stable cursor pagination, deterministic sort orders, and a validation
contract that never leaks a 500.

## Product

`todos-api` is an HTTP service exposing a TODO collection. Single file
(`server.js`), plain `node:http`, no frameworks, no npm dependencies. Starts
with `node server.js`, listens on `PORT` from the environment. State is
in-memory for the process lifetime (no persistence).

## Contract (machine-checked; review walks these line by line)

### Health
- `GET /health` → `200` with JSON body containing `"ok":true`.

### Create
- `POST /todos` with JSON `{"title":"<string>","priority":<int 1..5, optional, default 3>}`
  → `201` with JSON `{"id":<int>,"title":…,"priority":…,"status":"open","createdAt":<RFC3339 UTC>}`.
  - `id`: integer, allocated 1, 2, 3… per process (monotically increasing,
    never reused, even after deletes).
  - `title`: 1..200 characters after trimming; anything else → `400`
    `{"error":…}`. A non-integer or out-of-range `priority` → `400`.
  - Malformed JSON → `400`; the process keeps serving.

### Read (list + query semantics)
- `GET /todos` supports, combined in any order:
  - `status=` `open` | `done` | (absent = all);
  - `sort=` `priority` | `createdAt` (default `createdAt`);
  - `order=` `asc` | `desc` (default `asc`);
  - `limit=` integer 1..100 (default 20);
  - `cursor=` opaque string previously returned as `nextCursor`.
- Response: `200` `{"items":[<todo>…],"nextCursor":"<string>"|null}` —
  `todos` in `items` carry the same shape as `POST /todos` responses.
- **Sort semantics**: primary key is the `sort` field; ties break by `id`
  ascending, always (in both orders). `priority` sorts numerically; `createdAt`
  sorts chronologically with `id` ascending as the tie-break.
- **Pagination semantics**: `cursor` is the last item's `id` from the
  previous page. A page returns the items that come strictly **after** that
  id in the requested ordering — so paging is stable even while new items
  are created between pages, and asking again with the same cursor returns
  the same page. `nextCursor` is the last item's id of this page, or `null`
  when fewer than `limit` items were returned.
- When a `cursor` is supplied, `status`/`sort`/`order` are interpreted by the
  SAME request (the server does not need to remember the previous request).
- Invalid values for any parameter (`status=banana`, `limit=0`, `limit=101`,
  `order=sideways`, `cursor=@@@`) → `400` `{"error":…}` — never a 500, never
  a silently ignored parameter.

### Mutate
- `PATCH /todos/<id>` with `{"status":"done"}` or `{"status":"open"}` →
  `200` with the updated todo. Unknown id → `404` `{"error":…}`. Any other
  `status` value, or other fields in the patch → `400`.
- `DELETE /todos/<id>` → `204` empty body. Unknown id → `404` `{"error":…}`.
- Deleted ids never reappear; id allocation never reuses them.

### Errors
- Any unknown path → `404`. Any unparseable body → `400`. The process must
  survive every bad request and keep serving `/health` immediately after.

## Delivery requirements (part of the contract, not optional)

1. **First issue ships the CI workflow**: `.github/workflows/ci.yml` running
   the test suite (`node --test`) on `pull_request` and `push` to the
   default branch, Node ≥ 22.
2. **First issue ships the container**: `docker-compose.yml` at the repo
   root, service named exactly `worker`, image with Node.js ≥ 22
   preinstalled, publishing the scenario port on `127.0.0.1`.
3. Tests under `test/` (built-in `node:test`) covering the query semantics:
   sorting with ties, cursor stability across intervening creates, and
   validation rejections.

## Non-goals

Authentication, users/ownership, due dates, tags/search, persistence across
restarts, websocket/live updates, bulk endpoints, rate limiting.

## Out of scope for this product

Metrics, admin surface, idempotency keys, conditional requests (ETag).

## Suggested build order (advisory — the slicer decides)

Skeleton (health, validation shell, compose + CI) → create + ids + title
checks → read/filter/sort with tie-breaks → cursor pagination → patch/delete
state transitions (+ adversarial rejections).
