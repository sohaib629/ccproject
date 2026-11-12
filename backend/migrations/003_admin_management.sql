-- =============================================================================
-- 003: administration of products and user accounts
--
-- * users.token_version: part of every login token. Resetting a password (or
--   deactivating the account) bumps it, so every token issued before is
--   rejected at once, even though JWTs are otherwise valid until they expire.
-- * admin_audit: who changed which product or account, when, and what changed.
--   Append-only, like stock_movements. Passwords are never recorded.
-- =============================================================================

ALTER TABLE users
    ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0 CHECK (token_version >= 0);

CREATE TABLE admin_audit (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity      TEXT        NOT NULL CHECK (entity IN ('product', 'user')),
    entity_id   INTEGER     NOT NULL,
    action      TEXT        NOT NULL CHECK (action IN (
                    'created', 'updated', 'deactivated', 'reactivated', 'password_reset')),
    changes     JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"priceCents": {"from": 100, "to": 90}}
    user_id     INTEGER     NOT NULL REFERENCES users (id),  -- the admin who made the change
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX admin_audit_entity_idx ON admin_audit (entity, entity_id, created_at DESC);

CREATE FUNCTION forbid_audit_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER admin_audit_append_only
    BEFORE UPDATE OR DELETE ON admin_audit
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_changes();
