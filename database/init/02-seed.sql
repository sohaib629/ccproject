-- =============================================================================
-- StockSync seed data (synthetic, for development and demos)
--
-- Demo login for every account below:  StockSync!2026
-- (bcrypt hash, cost 12). Change or remove these accounts for any real use.
-- =============================================================================

BEGIN;

-- Stores ----------------------------------------------------------------------
INSERT INTO stores (code, name, address) VALUES
    ('DT', 'StockSync Downtown',   '220 Yonge St, Toronto, ON'),
    ('NY', 'StockSync North York', '5 Park Home Ave, North York, ON');

-- Users -----------------------------------------------------------------------
INSERT INTO users (email, full_name, password_hash, role, store_id) VALUES
    ('admin@stocksync.dev',      'Avery Admin',      '$2b$12$3B7PSfJdZl5hcx96HDGBtOK0iiQ5bF5TJuRHH/WcEEQO3Dn1KFpmi', 'admin',   NULL),
    ('manager.dt@stocksync.dev', 'Morgan Downtown',  '$2b$12$3B7PSfJdZl5hcx96HDGBtOK0iiQ5bF5TJuRHH/WcEEQO3Dn1KFpmi', 'manager', (SELECT id FROM stores WHERE code = 'DT')),
    ('staff.dt@stocksync.dev',   'Sam Downtown',     '$2b$12$3B7PSfJdZl5hcx96HDGBtOK0iiQ5bF5TJuRHH/WcEEQO3Dn1KFpmi', 'staff',   (SELECT id FROM stores WHERE code = 'DT')),
    ('manager.ny@stocksync.dev', 'Nadia NorthYork',  '$2b$12$3B7PSfJdZl5hcx96HDGBtOK0iiQ5bF5TJuRHH/WcEEQO3Dn1KFpmi', 'manager', (SELECT id FROM stores WHERE code = 'NY')),
    ('staff.ny@stocksync.dev',   'Noah NorthYork',   '$2b$12$3B7PSfJdZl5hcx96HDGBtOK0iiQ5bF5TJuRHH/WcEEQO3Dn1KFpmi', 'staff',   (SELECT id FROM stores WHERE code = 'NY'));

-- Products (prices in cents) --------------------------------------------------
INSERT INTO products (sku, name, category, price_cents, reorder_threshold) VALUES
    ('LAP-MBA13-M4',    'MacBook Air 13" M4 16GB/512GB',    'Laptops',      164900, 3),
    ('LAP-XPS14-U7',    'Dell XPS 14 Core Ultra 7',         'Laptops',      219900, 2),
    ('LAP-TP-X1C13',    'Lenovo ThinkPad X1 Carbon Gen 13', 'Laptops',      249900, 2),
    ('PHN-IP17-256',    'iPhone 17 256GB',                  'Phones',       129900, 4),
    ('PHN-PIX10-128',   'Google Pixel 10 128GB',            'Phones',       109900, 3),
    ('PHN-GS25-256',    'Samsung Galaxy S25 256GB',         'Phones',       119900, 3),
    ('CON-PS5-SLIM',    'PlayStation 5 Slim',               'Consoles',      64999, 2),
    ('CON-NSW2',        'Nintendo Switch 2',                'Consoles',      62999, 3),
    ('CON-XSX-1TB',     'Xbox Series X 1TB',                'Consoles',      74999, 2),
    ('TAB-IPAD-A16',    'iPad 11" A16 128GB',               'Tablets',       49900, 3),
    ('AUD-APP2-USB-C',  'AirPods Pro 2 (USB-C)',            'Audio',         32900, 5),
    ('AUD-SONY-XM6',    'Sony WH-1000XM6 Headphones',       'Audio',         54999, 2);

-- Opening stock ---------------------------------------------------------------
-- Day 2 demo case: MacBook Air at Downtown starts at exactly 5 units.
-- A few rows are deliberately at/below their reorder threshold so the
-- low-stock view has something to show.
INSERT INTO stock (store_id, product_id, quantity)
SELECT st.id, p.id, v.qty
FROM (VALUES
    ('DT', 'LAP-MBA13-M4',   5), ('NY', 'LAP-MBA13-M4',   8),
    ('DT', 'LAP-XPS14-U7',   4), ('NY', 'LAP-XPS14-U7',   1),
    ('DT', 'LAP-TP-X1C13',   3), ('NY', 'LAP-TP-X1C13',   2),
    ('DT', 'PHN-IP17-256',  12), ('NY', 'PHN-IP17-256',   9),
    ('DT', 'PHN-PIX10-128',  6), ('NY', 'PHN-PIX10-128',  2),
    ('DT', 'PHN-GS25-256',   7), ('NY', 'PHN-GS25-256',   5),
    ('DT', 'CON-PS5-SLIM',   1), ('NY', 'CON-PS5-SLIM',   6),
    ('DT', 'CON-NSW2',       9), ('NY', 'CON-NSW2',       4),
    ('DT', 'CON-XSX-1TB',    3), ('NY', 'CON-XSX-1TB',    0),
    ('DT', 'TAB-IPAD-A16',  10), ('NY', 'TAB-IPAD-A16',   7),
    ('DT', 'AUD-APP2-USB-C',20), ('NY', 'AUD-APP2-USB-C', 15),
    ('DT', 'AUD-SONY-XM6',   5), ('NY', 'AUD-SONY-XM6',   2)
) AS v(store_code, sku, qty)
JOIN stores   st ON st.code = v.store_code
JOIN products p  ON p.sku  = v.sku;

-- Opening balances in the audit log, so that from the very first moment
--   stock.quantity = SUM(stock_movements.quantity_change)
-- (rows with 0 units need no movement: a 0 change is not allowed).
INSERT INTO stock_movements (store_id, product_id, user_id, movement_type, quantity_change, quantity_after, reason)
SELECT s.store_id, s.product_id,
       (SELECT id FROM users WHERE email = 'admin@stocksync.dev'),
       'initial', s.quantity, s.quantity, 'Opening balance (seed data)'
FROM stock s
WHERE s.quantity > 0;

COMMIT;
