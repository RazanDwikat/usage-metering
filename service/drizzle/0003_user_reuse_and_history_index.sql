
ALTER TABLE users DROP CONSTRAINT users_account_id_external_id_key;
CREATE UNIQUE INDEX users_external_id_active ON users (account_id, external_id) WHERE deleted_at IS NULL;

CREATE INDEX consume_requests_month ON consume_requests (account_id, window_start, created_at DESC, id DESC);
