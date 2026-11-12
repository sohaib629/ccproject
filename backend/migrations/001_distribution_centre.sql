-- =============================================================================
-- 001: the distribution centre (warehouse) as a third location
--
-- Before: two stores, and a "restock" made units appear at a store from nowhere.
-- After:  every new unit enters at the distribution centre (a supplier delivery),
--         stores are replenished from it through the existing transfer workflow,
--         and customers buy only at stores. So each unit can be traced:
--             supplier -> distribution centre -> store -> sale
--
-- The rules are enforced HERE, in the database, as well as in the API: even a
-- buggy API (or someone with SQL access) cannot record a sale at the warehouse.
--
-- Runs inside one transaction (see src/migrate.js). Existing data is kept.
-- =============================================================================

-- 1. Location kind -------------------------------------------------------------
ALTER TABLE stores
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'store'
        CONSTRAINT stores_kind_check CHECK (kind IN ('store', 'warehouse'));

COMMENT ON COLUMN stores.kind IS
    'store: sells to customers; warehouse: receives supplier deliveries and supplies the stores';

INSERT INTO stores (code, name, address, kind) VALUES
    ('WH', 'StockSync Distribution Centre', '80 Carlingview Dr, Etobicoke, ON', 'warehouse');

-- 2. Warehouse accounts (same demo password as the seed accounts) ----------------
INSERT INTO users (email, full_name, password_hash, role, store_id)
SELECT v.email, v.full_name, u.password_hash, v.role, (SELECT id FROM stores WHERE code = 'WH')
FROM (VALUES
        ('manager.wh@stocksync.dev', 'Wren Warehouse', 'manager'),
        ('staff.wh@stocksync.dev',   'Wes Warehouse',  'staff')
     ) AS v(email, full_name, role)
CROSS JOIN (SELECT password_hash FROM users WHERE email = 'admin@stocksync.dev') u;

-- 3. Opening stock at the distribution centre for the existing 12 products -----
INSERT INTO stock (store_id, product_id, quantity)
SELECT (SELECT id FROM stores WHERE code = 'WH'), p.id, v.qty
FROM (VALUES
    ('LAP-MBA13-M4', 40), ('LAP-XPS14-U7', 25), ('LAP-TP-X1C13', 20),
    ('PHN-IP17-256', 60), ('PHN-PIX10-128', 35), ('PHN-GS25-256', 40),
    ('CON-PS5-SLIM', 30), ('CON-NSW2', 45), ('CON-XSX-1TB', 18),
    ('TAB-IPAD-A16', 50), ('AUD-APP2-USB-C', 120), ('AUD-SONY-XM6', 30)
) AS v(sku, qty)
JOIN products p ON p.sku = v.sku;

-- Every unit needs its audit row, so "stock = sum of its history" stays true.
INSERT INTO stock_movements (store_id, product_id, user_id, movement_type, quantity_change, quantity_after, reason)
SELECT s.store_id, s.product_id,
       (SELECT id FROM users WHERE email = 'admin@stocksync.dev'),
       'initial', s.quantity, s.quantity, 'Opening balance: distribution centre (migration 001)'
FROM stock s
WHERE s.store_id = (SELECT id FROM stores WHERE code = 'WH') AND s.quantity > 0;

-- 4. Location rules, enforced by the database ------------------------------------
--   sale    only at a store              (customers do not shop at the warehouse)
--   restock only at the distribution centre (supplier deliveries arrive there)
-- Adjustments (counts, damage) and transfers are allowed at every location.
CREATE FUNCTION enforce_location_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    loc_kind TEXT;
BEGIN
    IF NEW.movement_type IN ('sale', 'restock') THEN
        SELECT kind INTO loc_kind FROM stores WHERE id = NEW.store_id;
        IF NEW.movement_type = 'sale' AND loc_kind <> 'store' THEN
            RAISE EXCEPTION 'sales can only be recorded at a store (location % is a %)', NEW.store_id, loc_kind
                USING ERRCODE = 'check_violation', CONSTRAINT = 'movements_sale_at_store';
        END IF;
        IF NEW.movement_type = 'restock' AND loc_kind <> 'warehouse' THEN
            RAISE EXCEPTION 'supplier deliveries can only be received at the distribution centre (location % is a %)', NEW.store_id, loc_kind
                USING ERRCODE = 'check_violation', CONSTRAINT = 'movements_restock_at_warehouse';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER stock_movements_location_rules
    BEFORE INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION enforce_location_rules();
