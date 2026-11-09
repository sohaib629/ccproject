-- =============================================================================
-- StockSync schema (PostgreSQL 18)
--
-- Runs once, automatically, the first time the postgres container starts with
-- an EMPTY data directory (files in /docker-entrypoint-initdb.d run in name
-- order). To re-run it locally: docker compose down -v && docker compose up -d
--
-- Design rules enforced by the database itself (not only by the API):
--   * stock can never go negative ............ CHECK (quantity >= 0)
--   * one stock row per (store, product) ..... PRIMARY KEY (store_id, product_id)
--   * transfers only between different stores  CHECK (from_store_id <> to_store_id)
--   * every quantity change is explained ..... stock_movements (append-only audit)
-- Because these rules live in PostgreSQL, they hold no matter which API replica
-- handles a request.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- stores: the two physical locations
-- -----------------------------------------------------------------------------
CREATE TABLE stores (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        TEXT        NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,16}$'),
    name        TEXT        NOT NULL,
    address     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- users: Administrator, Manager, Staff
--   admin            -> not tied to a store (store_id NULL)
--   manager / staff  -> must belong to exactly one store
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         TEXT        NOT NULL,
    full_name     TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,                      -- bcrypt, never plaintext
    role          TEXT        NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
    store_id      INTEGER     REFERENCES stores (id),
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_store_matches_role CHECK (
        (role = 'admin' AND store_id IS NULL) OR
        (role IN ('manager', 'staff') AND store_id IS NOT NULL)
    )
);
-- Case-insensitive unique email: "Alice@x.com" and "alice@x.com" are the same user.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- -----------------------------------------------------------------------------
-- products: the catalogue (shared by both stores)
--   Money is stored as integer cents to avoid floating-point rounding errors.
-- -----------------------------------------------------------------------------
CREATE TABLE products (
    id                INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku               TEXT        NOT NULL UNIQUE CHECK (sku ~ '^[A-Z0-9-]{3,32}$'),
    name              TEXT        NOT NULL,
    category          TEXT        NOT NULL,
    price_cents       INTEGER     NOT NULL CHECK (price_cents >= 0),
    reorder_threshold INTEGER     NOT NULL DEFAULT 0 CHECK (reorder_threshold >= 0),
    is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category);

-- -----------------------------------------------------------------------------
-- stock: current quantity of each product at each store
--   The CHECK constraint is the last line of defence against overselling:
--   even a buggy query cannot commit a negative quantity.
-- -----------------------------------------------------------------------------
CREATE TABLE stock (
    store_id    INTEGER     NOT NULL REFERENCES stores (id),
    product_id  INTEGER     NOT NULL REFERENCES products (id),
    quantity    INTEGER     NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (store_id, product_id)
);
CREATE INDEX stock_product_idx ON stock (product_id);

-- -----------------------------------------------------------------------------
-- transfers: moving units between stores
--
--   requested --(manager dispatches)--> in_transit --(destination receives)--> received
--       |                                    |
--       +---------(cancel)--------> cancelled <----(cancel: units returned)----+
--
--   * Dispatch removes units from the source store.
--   * Receive adds units to the destination store, exactly once.
--   * Cancelling an in-transit transfer returns the units to the source store
--     (a compensating, audited stock movement), so no units are ever lost.
-- -----------------------------------------------------------------------------
CREATE TABLE transfers (
    id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id     INTEGER     NOT NULL REFERENCES products (id),
    from_store_id  INTEGER     NOT NULL REFERENCES stores (id),
    to_store_id    INTEGER     NOT NULL REFERENCES stores (id),
    quantity       INTEGER     NOT NULL CHECK (quantity > 0),
    status         TEXT        NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'in_transit', 'received', 'cancelled')),
    note           TEXT,
    requested_by   INTEGER     NOT NULL REFERENCES users (id),
    dispatched_by  INTEGER     REFERENCES users (id),
    received_by    INTEGER     REFERENCES users (id),
    cancelled_by   INTEGER     REFERENCES users (id),
    requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at  TIMESTAMPTZ,
    received_at    TIMESTAMPTZ,
    cancelled_at   TIMESTAMPTZ,
    CONSTRAINT transfers_different_stores CHECK (from_store_id <> to_store_id),
    -- Each state must carry the evidence of how it was reached.
    CONSTRAINT transfers_in_transit_has_dispatch CHECK (
        status NOT IN ('in_transit', 'received') OR
        (dispatched_by IS NOT NULL AND dispatched_at IS NOT NULL)
    ),
    CONSTRAINT transfers_received_has_receipt CHECK (
        status <> 'received' OR (received_by IS NOT NULL AND received_at IS NOT NULL)
    ),
    CONSTRAINT transfers_cancelled_has_cancel CHECK (
        status <> 'cancelled' OR (cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL)
    )
);
CREATE INDEX transfers_status_idx     ON transfers (status);
CREATE INDEX transfers_from_store_idx ON transfers (from_store_id, status);
CREATE INDEX transfers_to_store_idx   ON transfers (to_store_id, status);

-- -----------------------------------------------------------------------------
-- stock_movements: append-only audit history
--   Every change to stock.quantity writes exactly one row here, in the SAME
--   transaction. Invariant (checked by tests):
--       stock.quantity = SUM(stock_movements.quantity_change) per (store, product)
-- -----------------------------------------------------------------------------
CREATE TABLE stock_movements (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id         INTEGER     NOT NULL REFERENCES stores (id),
    product_id       INTEGER     NOT NULL REFERENCES products (id),
    user_id          INTEGER     NOT NULL REFERENCES users (id),
    movement_type    TEXT        NOT NULL CHECK (movement_type IN (
                         'initial',          -- opening balance when the system was seeded
                         'sale',             -- negative
                         'restock',          -- positive
                         'adjustment',       -- +/- with a mandatory reason (count correction, damage, theft)
                         'transfer_out',     -- negative, at the source store on dispatch
                         'transfer_in',      -- positive, at the destination store on receive
                         'transfer_return'   -- positive, at the source store when an in-transit transfer is cancelled
                     )),
    quantity_change  INTEGER     NOT NULL CHECK (quantity_change <> 0),
    quantity_after   INTEGER     NOT NULL CHECK (quantity_after >= 0),
    transfer_id      INTEGER     REFERENCES transfers (id),
    reason           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Sign rules: the type determines the direction of the change.
    CONSTRAINT movements_sign_matches_type CHECK (
        (movement_type IN ('sale', 'transfer_out') AND quantity_change < 0) OR
        (movement_type IN ('initial', 'restock', 'transfer_in', 'transfer_return') AND quantity_change > 0) OR
        (movement_type = 'adjustment')
    ),
    CONSTRAINT movements_transfer_link CHECK (
        (movement_type LIKE 'transfer_%') = (transfer_id IS NOT NULL)
    ),
    CONSTRAINT movements_adjustment_reason CHECK (
        movement_type <> 'adjustment' OR length(trim(coalesce(reason, ''))) > 0
    )
);
CREATE INDEX movements_store_product_time_idx ON stock_movements (store_id, product_id, created_at DESC);
CREATE INDEX movements_time_idx               ON stock_movements (created_at DESC);
CREATE INDEX movements_user_idx               ON stock_movements (user_id);

-- The audit log is append-only: history can be added to, never rewritten.
CREATE FUNCTION forbid_movement_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'stock_movements is append-only (% not allowed)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER stock_movements_append_only
    BEFORE UPDATE OR DELETE ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION forbid_movement_changes();

-- -----------------------------------------------------------------------------
-- low_stock: products at or below their reorder threshold, per store
-- -----------------------------------------------------------------------------
CREATE VIEW low_stock AS
SELECT s.store_id,
       st.code  AS store_code,
       st.name  AS store_name,
       p.id     AS product_id,
       p.sku,
       p.name   AS product_name,
       p.category,
       s.quantity,
       p.reorder_threshold,
       p.reorder_threshold - s.quantity AS shortfall
FROM stock s
JOIN products p ON p.id = s.product_id
JOIN stores  st ON st.id = s.store_id
WHERE p.is_active
  AND s.quantity <= p.reorder_threshold;

COMMIT;
