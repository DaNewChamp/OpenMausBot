CREATE TABLE web_client_auth_exchanges (
  code TEXT PRIMARY KEY NOT NULL,
  account_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX idx_web_client_auth_exchanges_expires ON web_client_auth_exchanges(expires_at);
