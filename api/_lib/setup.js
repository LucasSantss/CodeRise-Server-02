import pool from "./db.js";
import crypto from "crypto";
import { isAdminSecret } from "../_auth.js";

export async function handleSetup(req, res) {
  if (req.method !== "GET") return res.status(405).end();
  if (!isAdminSecret(req)) return res.status(401).json({ success:false, message:"Não autorizado" });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL, password VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'user', active BOOLEAN NOT NULL DEFAULT true, token VARCHAR(64) UNIQUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_integrations (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, ecommerce_platform VARCHAR(50), ecommerce_config JSON, ecommerce_active BOOLEAN NOT NULL DEFAULT false, webhook_token VARCHAR(64) UNIQUE NOT NULL, chatbot_platform VARCHAR(50), chatbot_config JSON, chatbot_active BOOLEAN NOT NULL DEFAULT false, chatbot_token VARCHAR(64) UNIQUE, suri_endpoint TEXT, suri_token TEXT, suri_active BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP NULL`).catch(()=>{});
    // Índices de performance
    for (const idx of [
      `CREATE INDEX idx_users_token ON users(token)`,
      `CREATE INDEX idx_users_email ON users(email)`,
      `CREATE INDEX idx_webhooks_user_id ON user_webhooks(user_id)`,
      `CREATE INDEX idx_webhooks_status ON user_webhooks(status)`,
      `CREATE INDEX idx_webhooks_received_at ON user_webhooks(received_at DESC)`,
      `CREATE INDEX idx_notifications_target_user ON notifications(target_user_id)`,
      `CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC)`,
      `CREATE INDEX idx_notifications_target_role ON notifications(target_role)`,
    ]) { await pool.query(idx).catch(()=>{}); }
    for (const sql of [
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS chatbot_platform VARCHAR(50)`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS chatbot_config JSON`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS chatbot_active BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS chatbot_token VARCHAR(64) UNIQUE`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS sync_schedule JSON NULL`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS catalog_polling JSON NULL`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS logistics_platform VARCHAR(50)`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS logistics_config JSON`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS logistics_active BOOLEAN NOT NULL DEFAULT false`,
      `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS logistics_token VARCHAR(64) UNIQUE`,
    ]) { await pool.query(sql).catch(()=>{}); }
    const noToken = await pool.query("SELECT user_id FROM user_integrations WHERE chatbot_token IS NULL");
    for (const row of noToken.rows) { await pool.query("UPDATE user_integrations SET chatbot_token=$1 WHERE user_id=$2 AND chatbot_token IS NULL",[crypto.randomBytes(32).toString("hex"),row.user_id]); }
    await pool.query(`CREATE TABLE IF NOT EXISTS sync_rules (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event VARCHAR(100) NOT NULL, active BOOLEAN NOT NULL DEFAULT true, message_template TEXT, delay_minutes INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_webhooks (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, event_type VARCHAR(100), payload JSON, status VARCHAR(20) DEFAULT 'received', error_message TEXT, source VARCHAR(20) DEFAULT 'ecommerce', received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);`);
    await pool.query(`ALTER TABLE user_webhooks ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'ecommerce'`).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (id INT AUTO_INCREMENT PRIMARY KEY, type VARCHAR(30) NOT NULL, title VARCHAR(100) NOT NULL, message TEXT NOT NULL, image_url TEXT, target_role VARCHAR(20) DEFAULT 'all', target_user_id INT, scheduled_at TIMESTAMP NULL, created_by INT, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS notification_reads (notification_id INT NOT NULL, user_id INT NOT NULL, hidden BOOLEAN NOT NULL DEFAULT false, read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (notification_id, user_id), FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_webhook_settings (id SMALLINT PRIMARY KEY DEFAULT 1, webhook_url TEXT, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT admin_webhook_settings_single_row CHECK (id = 1));`);
    const adminToken=crypto.randomBytes(32).toString("hex");
    await pool.query(`INSERT IGNORE INTO users (name,email,password,role,token) VALUES ('Administrador','admin@plataforma.com','admin123','admin',$1)`,[adminToken]);
    const userToken=crypto.randomBytes(32).toString("hex");
    await pool.query(`INSERT IGNORE INTO users (name,email,password,role,token) VALUES ('Usuário Teste','teste@plataforma.com','teste123','user',$1)`,[userToken]);
    const testUser=await pool.query("SELECT id FROM users WHERE email='teste@plataforma.com'");
    if (testUser.rows[0]) { const wt=crypto.randomBytes(32).toString("hex"),ct=crypto.randomBytes(32).toString("hex"); await pool.query(`INSERT IGNORE INTO user_integrations (user_id,webhook_token,chatbot_token) VALUES ($1,$2,$3)`,[testUser.rows[0].id,wt,ct]); }
    const admin=await pool.query("SELECT id,email,token FROM users WHERE email='admin@plataforma.com'");
    const user=await pool.query("SELECT id,email,token FROM users WHERE email='teste@plataforma.com'");
    return res.status(200).json({ success:true, message:"Tabelas criadas/migradas com sucesso!", tables:["users","user_integrations","sync_rules","user_webhooks","notifications","notification_reads","admin_webhook_settings"], seeds:{admin:admin.rows[0],user:user.rows[0]} });
  } catch (err) { return res.status(500).json({success:false,message:err.message}); }
}
