# Bookstore API — Build Spec (MEDIUM · tier 2 of 3)

Graduated tier 2/3. Builds on the SMALL money core and adds the **interacting**
high-risk surfaces: coupon stacking with a tie-break, time-based reservation expiry,
and the full order state machine. This is where business rules collide on purpose —
the case that most stresses correct step-sizing and the spec-conformance review.
Target build time ~20 minutes. Hand this whole file to the coordinator.

## Goal
A **Bookstore REST API** in **Python** with **FastAPI**, an **in-memory** store, and a
thorough **pytest** suite. Must run under `uvicorn main:app` and pass `pytest`.

## Tech constraints
- Python 3.11+, FastAPI, Pydantic. `requirements.txt`: fastapi, uvicorn, pydantic, pytest, httpx.
- Storage: in-memory behind a repository layer (swappable).
- **All money is integer cents.** Never use floats. Rounding is **round half up** to the
  nearest cent, in **one** shared helper.
- **Deterministic time**: read "now" through one injectable clock function so tests can
  freeze/advance time (needed for reservation expiry). Do not call `datetime.now()` directly throughout.

## Entities
### Book
- `id`, `title` (required, non-empty), `price_cents` (int, > 0), `stock` (int, >= 0 — physically on hand)

### Customer
- `id`, `name` (required), `email` (required, **unique**, basic email shape)
- `tier`: `standard` | `silver` | `gold` (default `standard`), `loyalty_points` (int, >= 0, starts 0)

### Coupon
- `code` (str, primary key, **unique, case-insensitive**)
- `kind`: `percent` or `fixed`
- `value`: for `percent` an int 1–100; for `fixed` an int cents > 0
- `min_subtotal_cents` (int, >= 0), `max_uses` (int, >= 1), `uses` (int, server-managed, starts 0)
- `expires_at` (ISO timestamp; invalid once now > expires_at)
- `stackable` (bool) — see discount rules

### Reservation (internal, created when an order is placed)
- Holds `quantity` of a `book_id` for an order, with an `expires_at`.

### Order
- `id`, `customer_id` (must exist)
- `items`: list of `{ book_id, quantity }`, >= 1 item, each quantity >= 1, no duplicate `book_id`
- `coupon_code` (optional)
- `status`: `pending -> paid -> fulfilled`, plus `cancelled` and `expired` (terminal). Starts `pending`.
- Money breakdown (all cents): `subtotal_cents`, `discount_cents`, `tax_cents`, `shipping_cents`, `total_cents`
- `idempotency_key` (optional), `created_at`

## Pricing pipeline (compute in this exact order; every step needs tests)
1. **subtotal** = Σ (book.price_cents × quantity), current price.
2. **membership discount** applied to subtotal: standard 0%, silver 5%, gold 10%.
3. **coupon discount** (if a coupon is supplied and valid): `percent` takes that percent of the
   *post-membership* amount; `fixed` subtracts that many cents (never below 0).
   - Stacking: membership and a coupon combine **only if** the coupon is `stackable`. A
     non-stackable coupon means membership is **not** applied — instead apply whichever single
     discount (membership-only vs coupon-only) yields the **larger** total discount.
4. `discount_cents` = subtotal − (amount after the chosen discount path).
5. **tax** = 8% of the post-discount amount (round half up).
6. **shipping**: flat 500 cents, **free** when post-discount amount >= 5000 cents.
7. **total_cents** = post-discount + tax + shipping. Must equal the sum of the breakdown fields.

## Stock & reservation rules
8. Placing an order validates references and checks stock. If any item's quantity exceeds the
   book's **available** stock, reject the whole order -> `409`, decrement nothing.
9. **Available stock** = `book.stock` − (sum of quantities held by *active, non-expired*
   reservations for that book). Expired reservations do not count.
10. A successful order creates reservations and **does not** change `book.stock` yet; it reduces
    availability. Reservations expire after **15 minutes**.
11. **Expiry sweep**: any request that touches an order (`GET`, pay, cancel) first expires
    reservations whose `expires_at` < now. When a `pending` order's reservations expire, the order
    becomes `expired` (terminal) and its held availability is released.

## Order lifecycle rules
12. **Pay** (`POST /orders/{id}/pay`) only `pending` -> `paid`: decrement `book.stock`, consume
    reservations. Paying anything not `pending` (incl. `expired`) -> `409`.
13. On payment, award **loyalty points** = floor(total_cents / 100), and increment the coupon's
    `uses` if one was applied.
14. **Fulfill** (`POST /orders/{id}/fulfill`) only `paid` -> `fulfilled`.
15. **Cancel** (`POST /orders/{id}/cancel`): allowed from `pending` (release reservations) or
    `paid` (restock the decremented quantities, revoke awarded loyalty points and the coupon use).
    Cancelling `fulfilled`, `cancelled`, or `expired` -> `409`.
16. **Idempotent order creation**: same `idempotency_key` + same customer returns the **same**
    order (same id, no new reservations). Same key + *different* payload -> `409`.

## Coupon rules
17. Coupon lookup is case-insensitive. Unknown code -> `400`.
18. A coupon is invalid (-> `400`) if expired, if `uses >= max_uses`, or if subtotal < `min_subtotal_cents`.
19. A coupon's `uses` increments only on **successful payment**, never at placement; cancel of a
    paid order decrements it back.

## Endpoints
Books: `POST /books`, `GET /books` (sorted by id), `GET /books/{id}`
Customers: `POST /customers`, `GET /customers/{id}`
Coupons: `POST /coupons`, `GET /coupons/{code}`
Orders: `POST /orders`, `GET /orders/{id}`, `POST /orders/{id}/pay`, `POST /orders/{id}/fulfill`, `POST /orders/{id}/cancel`

## Cross-cutting
- Validation failures return JSON with an `error`/`detail` message and the documented status
  (`400` bad reference/validation, `404` missing GET resource, `409` conflict/state/stock/idempotency).
- `404` only for GET of a missing resource by id; bad references in a create body are `400`.

## Definition of done
- `pip install -r requirements.txt` then `pytest` passes; `uvicorn main:app` starts.
- Every numbered rule (1–19) covered by at least one passing test, including negatives:
  non-stackable coupon picks the larger discount; membership/tax rounding and the free-shipping
  threshold boundary; reservation expiry flips a pending order to `expired` and frees availability;
  pay decrements real stock and awards points; cancel of a paid order restocks, revokes points, and
  decrements coupon uses; idempotency replay vs conflicting payload.
