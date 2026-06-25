# Bookstore API — Build Spec (complex)

A deliberately involved build task for exercising the **code-chain** pipeline (PLAN → PLAN REVIEW → CODE → CODE REVIEW). The rules interact on purpose: pricing depends on membership, discounts, and coupons; stock is reserved with expiry; orders move through a state machine; and several operations must be idempotent. Hand this whole file to the coordinator and let the four loops design, build, and review it. The goal is to stress correct step-sizing and catch dropped business rules.

## Goal

Build a **Bookstore REST API** in **Python** with **FastAPI**, an **in-memory** data store (no external DB), and a thorough **pytest** suite. It must run under `uvicorn` and pass `pytest`.

## Tech constraints

- Python 3.11+, FastAPI served by uvicorn, Pydantic for validation.
- Storage: in-memory behind a repository layer (module-level state is fine, but keep it swappable). No external database, no network calls.
- Tests: pytest with FastAPI `TestClient`. Aim for one test per business rule, including the negative/edge cases.
- `requirements.txt` with: fastapi, uvicorn, pydantic, pytest, httpx.
- **All money is integer cents.** Never use floats for currency. Rounding, when needed, is **round half up** to the nearest cent, computed in a single helper.
- Deterministic time: read "now" through one injectable clock function so tests can freeze/advance time (needed for reservation expiry). Do not call `datetime.now()` directly throughout the code.

## Entities

### Author
- `id` (int, server-assigned), `name` (str, required, non-empty).

### Category
- `id`, `name` (str, required, unique, case-insensitive).

### Book
- `id`, `title` (required, non-empty)
- `author_id` (must reference an existing Author)
- `category_ids` (list[int], each must reference an existing Category; may be empty)
- `price_cents` (int, > 0)
- `stock` (int, >= 0) — physically on hand
- `isbn` (str, required, **unique**, must be a valid ISBN-13 by checksum)
- `version` (int, server-managed, starts at 1; bumped on every mutation — used for optimistic concurrency)

### Customer
- `id`, `name` (required), `email` (required, **unique**, basic email shape)
- `tier`: one of `standard`, `silver`, `gold` (default `standard`)
- `loyalty_points` (int, >= 0, starts 0)

### Coupon
- `code` (str, primary key, unique, case-insensitive)
- `kind`: `percent` or `fixed`
- `value`: for `percent` an int 1–100; for `fixed` an int cents > 0
- `min_subtotal_cents` (int, >= 0) — minimum order subtotal to be eligible
- `max_uses` (int, >= 1) and `uses` (int, server-managed, starts 0)
- `expires_at` (ISO timestamp; coupon invalid once now > expires_at)
- `stackable` (bool) — see discount rules

### Reservation (internal, created when an order is placed)
- Holds `quantity` of a `book_id` for an order, with an `expires_at`.

### Order
- `id`, `customer_id` (must exist)
- `items`: list of `{ book_id, quantity }`, ≥ 1 item, each quantity ≥ 1, no duplicate `book_id` in one order
- `coupon_code` (optional)
- `status`: state machine `pending → paid → fulfilled`, plus `cancelled` and `expired` (terminal). Starts `pending`.
- Server-computed money breakdown (all cents): `subtotal_cents`, `discount_cents`, `tax_cents`, `shipping_cents`, `total_cents`.
- `idempotency_key` (optional, see rules), `created_at`, `version`.

## Pricing pipeline (compute in this exact order; every step needs tests)

For each order, given valid items:

1. **subtotal** = Σ (book.price_cents × quantity), using each book's *current* price.
2. **membership discount** applied to subtotal: standard 0%, silver 5%, gold 10%.
3. **coupon discount** (if a coupon is supplied and valid): `percent` takes that percent of the *post-membership* amount; `fixed` subtracts that many cents (never below 0).
   - Stacking: membership discount and a coupon may combine **only if** the coupon is `stackable`. A non-stackable coupon means membership discount is **not** applied — instead apply whichever single discount (membership-only vs coupon-only) yields the **larger** total discount for the customer.
4. `discount_cents` = subtotal − (amount after the chosen discount path).
5. **tax** = 8% of the post-discount amount (round half up).
6. **shipping**: flat 500 cents, **free** when post-discount amount ≥ 5000 cents.
7. **total_cents** = post-discount + tax + shipping. Must equal the sum of the reported breakdown fields. A client-supplied total/breakdown is ignored.

## Stock & reservation rules

8. Placing an order validates references (customer, every book, every category on a book at creation) and checks stock. If any item's quantity exceeds the book's **available** stock, reject the whole order → `409`, decrement nothing.
9. **Available stock** = `book.stock` − (sum of quantities held by *active, non-expired* reservations for that book). Expired reservations do not count.
10. A successful order creates reservations and **does not** change `book.stock` yet; it reduces availability. Reservations expire after **15 minutes**.
11. **Expiry sweep**: any request that touches an order (`GET`, pay, cancel) must first expire reservations whose `expires_at` < now. When an order's reservations expire while still `pending`, the order becomes `expired` (terminal) and its held availability is released.

## Order lifecycle rules

12. **Pay** (`POST /orders/{id}/pay`) only from `pending` → `paid`: this is the moment `book.stock` is actually decremented and the reservations are consumed. Paying anything not `pending` → `409`. Paying an `expired` order → `409`.
13. On payment, award **loyalty points** = floor(total_cents / 100) to the customer, and increment the coupon's `uses` if one was applied.
14. **Fulfill** (`POST /orders/{id}/fulfill`) only from `paid` → `fulfilled`.
15. **Cancel** (`POST /orders/{id}/cancel`): allowed from `pending` (release reservations) or `paid` (restock the decremented quantities and revoke the awarded loyalty points and the coupon use). Cancelling `fulfilled`, `cancelled`, or `expired` → `409`.
16. **Idempotent order creation**: if `POST /orders` includes an `idempotency_key`, a repeat with the same key and the same customer returns the **same** order (same id, no new reservations). Same key with a *different* payload → `409`.

## Coupon rules

17. Coupon lookup is case-insensitive. Unknown code → `400`.
18. A coupon is invalid (→ `400`) if expired, if `uses >= max_uses`, or if the order subtotal < `min_subtotal_cents`.
19. A coupon's `uses` only increments on **successful payment**, never at order placement; cancel of a paid order decrements it back.

## Concurrency rule

20. **Optimistic concurrency** on `PATCH /books/{id}`: the request must send the `version` it expects; if it doesn't match the current version → `409` and no change. On success bump `version`.

## Endpoints

Authors: `POST /authors`, `GET /authors`, `GET /authors/{id}`
Categories: `POST /categories`, `GET /categories`
Books: `POST /books`, `GET /books` (filters: `?author_id=`, `?category_id=`, `?q=` title substring; pagination `?limit=&offset=`, default limit 20, max 100; results sorted by id), `GET /books/{id}`, `PATCH /books/{id}` (price/stock/title + required `version`)
Customers: `POST /customers`, `GET /customers/{id}`
Coupons: `POST /coupons`, `GET /coupons/{code}`
Orders: `POST /orders`, `GET /orders/{id}`, `POST /orders/{id}/pay`, `POST /orders/{id}/fulfill`, `POST /orders/{id}/cancel`

## Cross-cutting

- All validation failures return JSON with an `error` or `detail` message and the documented status code (`400` bad reference/validation, `404` missing resource on GET, `409` conflict/state/stock/version/idempotency).
- Pagination responses include `total`, `limit`, `offset`, and `items`.
- 404 only for GET of a missing resource by id; bad references in a create body are `400`.

## Definition of done

- `pip install -r requirements.txt` then `pytest` passes; `uvicorn main:app` starts.
- Every numbered business rule (1–20) is covered by at least one passing test, including negatives: non-stackable coupon picks the larger discount; reservation expiry flips a pending order to `expired` and frees availability; pay decrements real stock and awards points; cancel of a paid order restocks, revokes points, and decrements coupon uses; optimistic-concurrency version mismatch on PATCH; ISBN-13 checksum rejection; idempotency-key replay vs conflicting payload; tax/shipping rounding and the free-shipping threshold boundary.
