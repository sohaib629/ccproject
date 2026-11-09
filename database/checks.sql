-- =============================================================================
-- StockSync integrity checks. Every query should return ZERO rows.
-- Run:  docker compose exec -T db psql -U stocksync -d stocksync < database/checks.sql
-- =============================================================================

\echo '1) Stock rows whose quantity does not match the audit history (expect 0 rows)'
SELECT s.store_id, s.product_id, s.quantity,
       coalesce(sum(m.quantity_change), 0) AS audited_quantity
FROM stock s
LEFT JOIN stock_movements m
       ON m.store_id = s.store_id AND m.product_id = s.product_id
GROUP BY s.store_id, s.product_id, s.quantity
HAVING s.quantity <> coalesce(sum(m.quantity_change), 0);

\echo '2) Negative stock (expect 0 rows; the CHECK constraint makes this impossible)'
SELECT * FROM stock WHERE quantity < 0;

\echo '3) Received transfers without exactly one transfer_in movement (expect 0 rows)'
SELECT t.id, count(m.id) AS transfer_in_rows
FROM transfers t
LEFT JOIN stock_movements m
       ON m.transfer_id = t.id AND m.movement_type = 'transfer_in'
WHERE t.status = 'received'
GROUP BY t.id
HAVING count(m.id) <> 1;
