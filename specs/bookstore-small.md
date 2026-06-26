# Bookstore API — Build Spec (SMALL · tier 1 of 3)

Graduated tier 1/3. The **smallest** spec that still exercises the high-risk
**money core** — a round-half-up membership discount and tax (the exact surface
where a cheap coder floored instead of rounding) — plus **idempotency**. These are
the rules v17's spec-conformance review and risk-routing are meant to guard.
Target build time ~10 minutes. Hand this whole file to the coordinator.

## Goal
A **Bookstore REST API** in **Python** with **FastAPI**, an **in-memory** store, and
a **pytest** suite. Must run under `uvicorn main:app` and pass `pytest`.

## Tech constraints
- Python 3.11+, FastAPI, Pydantic. `requirements.txt`: fastapi, uvicorn, pydantic, pytest, httpx.
- Storage: in-memory behind a repository layer (module-level state is fine, keep it swappable).
- **All money is integer cents.** Never use floats for currency. Rounding, when needed,
  is **round half up** to the nearest cent, computed in **one** shared helper.

## Entities
### Book
- `id` (int, server-assigned), `title` (required, non-empty)
- `price_cents` (int, > 0), `stock` (int, >= 0)

### Customer
- `id`, `name` (required), `email` (required, **unique**, basic email shape)
- `tier`: one of `standard`, `silver`, `gold` (default `standard`)
- `loyalty_points` (int, >= 0, starts 0)

### Order
- `id`, `customer_id` (must exist)
- `items`: list of `{ book_id, quantity }`, >= 1 item, each quantity >= 1, no duplicate `book_id`
- `status`: `pending -> paid` (starts `pending`)
- Server-computed money breakdown (all cents): `subtotal_cents`, `discount_cents`, `tax_cents`, `shipping_cents`, `total_cents`
- `idempotency_key` (optional), `created_at`

## Pricing pipeline (compute in this exact order; every step needs tests)
1. **subtotal** = Σ (book.price_cents × quantity), using each book's current price.
2. **membership discount** applied to subtotal: standard 0%, silver 5%, gold 10%.
3. `discount_cents` = the membership discount; **post-discount** = subtotal − discount.
4. **tax** = 8% of the post-discount amount (round half up).
5. **shipping**: flat 500 cents, **free** when post-discount amount >= 5000 cents.
6. **total_cents** = post-discount + tax + shipping. Must equal the sum of the reported
   breakdown fields. A client-supplied total/breakdown is ignored.

## Stock & lifecycle rules
7. Placing an order validates references (customer, every book) and checks stock. If any
   item's quantity exceeds the book's `stock`, reject the whole order -> `409`, decrement nothing.
8. **Pay** (`POST /orders/{id}/pay`) only from `pending` -> `paid`: this is when `book.stock`
   is decremented. Paying anything not `pending` -> `409`.
9. On payment, award **loyalty points** = floor(total_cents / 100) to the customer.
10. **Idempotent order creation**: if `POST /orders` includes an `idempotency_key`, a repeat
    with the same key and same customer returns the **same** order (same id). Same key with a
    *different* payload -> `409`.

## Endpoints
Books: `POST /books`, `GET /books` (sorted by id), `GET /books/{id}`
Customers: `POST /customers`, `GET /customers/{id}`
Orders: `POST /orders`, `GET /orders/{id}`, `POST /orders/{id}/pay`

## Cross-cutting
- Validation failures return JSON with an `error`/`detail` message and the documented status
  (`400` bad reference/validation, `404` missing resource on GET, `409` conflict/state/stock/idempotency).
- `404` only for GET of a missing resource by id; bad references in a create body are `400`.

## Definition of done
- `pip install -r requirements.txt` then `pytest` passes; `uvicorn main:app` starts.
- Every numbered rule (1–10) is covered by at least one passing test, including negatives:
  membership-discount rounding, tax rounding, the free-shipping threshold boundary,
  insufficient-stock `409`, pay-non-pending `409`, idempotency replay vs conflicting payload.
