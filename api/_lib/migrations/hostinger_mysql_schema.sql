-- ============================================================
-- Schema MySQL (Hostinger) — equivalente ao que GET /setup cria
-- Cole este script na aba "SQL" do phpMyAdmin, com o banco
-- u500692157_Server1 selecionado, e clique em "Executar".
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  plain_password TEXT,
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  active BOOLEAN NOT NULL DEFAULT true,
  token VARCHAR(64) UNIQUE,
  token_expires_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_integrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  ecommerce_platform VARCHAR(50),
  ecommerce_config JSON,
  ecommerce_active BOOLEAN NOT NULL DEFAULT false,
  webhook_token VARCHAR(64) UNIQUE NOT NULL,
  chatbot_platform VARCHAR(50),
  chatbot_config JSON,
  chatbot_active BOOLEAN NOT NULL DEFAULT false,
  chatbot_token VARCHAR(64) UNIQUE,
  suri_endpoint TEXT,
  suri_token TEXT,
  suri_active BOOLEAN NOT NULL DEFAULT false,
  sync_schedule JSON NULL,
  catalog_polling JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  event VARCHAR(100) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  message_template TEXT,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_webhooks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  event_type VARCHAR(100),
  payload JSON,
  status VARCHAR(20) DEFAULT 'received',
  error_message TEXT,
  source VARCHAR(20) DEFAULT 'ecommerce',
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(30) NOT NULL,
  title VARCHAR(100) NOT NULL,
  message TEXT NOT NULL,
  image_url TEXT,
  target_role VARCHAR(20) DEFAULT 'all',
  target_user_id INT,
  scheduled_at TIMESTAMP NULL,
  created_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INT NOT NULL,
  user_id INT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id, user_id),
  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_webhook_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  webhook_url TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT admin_webhook_settings_single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS platform_settings (
  `key` VARCHAR(100) PRIMARY KEY,
  value JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── Índices de performance ──────────────────────────────────
CREATE INDEX idx_users_token ON users(token);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_webhooks_user_id ON user_webhooks(user_id);
CREATE INDEX idx_webhooks_status ON user_webhooks(status);
CREATE INDEX idx_webhooks_received_at ON user_webhooks(received_at DESC);
CREATE INDEX idx_notifications_target_user ON notifications(target_user_id);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX idx_notifications_target_role ON notifications(target_role);

-- ── Seed opcional: admin + usuário teste ────────────────────
-- Os tokens abaixo são só placeholders — são substituídos por um
-- token aleatório de verdade no primeiro login de cada um.
INSERT IGNORE INTO users (name, email, password, role, token) VALUES
  ('Administrador', 'admin@plataforma.com', 'admin123', 'admin', 'seed-admin-token'),
  ('Usuário Teste', 'teste@plataforma.com', 'teste123', 'user', 'seed-user-token');

INSERT IGNORE INTO user_integrations (user_id, webhook_token, chatbot_token)
SELECT id, 'seed-webhook-token', 'seed-chatbot-token' FROM users WHERE email = 'teste@plataforma.com';
