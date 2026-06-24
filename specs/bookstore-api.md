# Bookstore API — Build Spec

A self-contained build task for exercising the **code-chain** pipeline
(PLAN → PLAN REVIEW → CODE → CODE REVIEW). Hand this whole file to the coordinator
and let the four loops design, build, and review it.

## Goal

Build a small **Bookstore REST API** in **Python** using **FastAPI**, with an
**in-memory** data store (no external database) and a **pytest** test suite. It must
run with `uvicorn` and pass `pytest`.

## Tech constraints

- Language: Python 3.11+
- Framework: FastAPI, served by uvicorn
- Storage: in-memory (module-level dict/list, repository abstraction is fine)
- Validation: Pydantic models
- Tests: pytest using FastAPI's `TestClient`
- A `requirements.txt` listing fastapi, uvicorn, pydantic, pytest, httpx
- All money values in integer **cents** (no floats for currency)

## Entities

### Author
- `id` (int, server-assigned)
- `name` (str, required, non-empty)

### Book
- `id` (int, server-assigned)
- `title` (str, required, non-empty)
- `author_id` (int, must reference an existing Author)
- `price_cents` (int, > 0)
- `stock` (int, >= 0)
- `isbn` (str, required, unique across all books)

### Customer
- `id` (int, server-assigned)
- `name` (str, required, non-empty)
- `email` (str, required, unique, basic email shape)

### Order
- `id` (int, server-assigned)
- `customer_id` (int, must reference an existing Customer)
- `items`: list of `{ book_id, quantity }`, at least one item, quantity >= 1
- `status`: one of `pending`, `paid`, `cancelled` (starts `pending`)
- `total_cents` (int, server-computed; never trust client total)
- `created_at` (ISO timestamp)

## Endpoints

Authors
- `POST /authors` — create
- `GET /authors` — list
- `GET /authors/{id}` — fetch (404 if missing)

Books
- `POST /books` — create
- `GET /books` — list, optional `?author_id=` filter
- `GET /books/{id}` — fetch (404 if missing)
- `PATCH /books/{id}` — update price/stock/title

Customers
- `POST /customers` — create
- `GET /customers/{id}` — fetch (404 if missing)

Orders
- `POST /orders` — place an order (see business rules)
- `GET /orders/{id}` — fetch (404 if missing)
- `POST /orders/{id}/pay` — mark paid (see business rules)
- `POST /orders/{id}/cancel` — cancel (see business rules)

## Business rules (these are the interesting part — every one needs a test)

1. **Author must exist** to create a Book → else `400`.
2. **ISBN is unique** — creating a Book with a duplicate ISBN → `409`.
3. **Order references must exist** — unknown `customer_id` or any unknown
   `book_id` → `400`.
4. **Stock check at order time** — if any item's `quantity` exceeds that book's
   `stock`, reject the whole order → `409`, and **no** stock is decremented.
5. **Placing an order decrements stock** atomically for every item, only when the
   whole order is valid.
6. **Server computes `total_cents`** = sum(book.price_cents × quantity). A client
   supplied total must be ignored.
7. **Pay** only works on a `pending` order → sets `paid`. Paying a non-pending
   order → `409`.
8. **Cancel** only works on a `pending` order → sets `cancelled` **and restores
   the stock** that was reserved. Cancelling a non-pending order → `409`.
9. **Deleting/304 not required** — keep scope to the endpoints above.
10. All validation failures return a JSON body with an `error` or `detail` message.

## Definition of done

- `pip install -r requirements.txt` then `pytest` passes.
- `uvicorn main:app` starts cleanly.
- Every business rule above is covered by at least one passing test, including the
  negative cases (duplicate ISBN, insufficient stock leaves stock untouched,
  cancel restores stock, pay/cancel on wrong status).
