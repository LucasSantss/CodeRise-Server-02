import pool, { checkDb } from "./_lib/db.js";
import { setCors } from "./_cors.js";
import { requireAuth } from "./_auth.js";
import crypto from "crypto";

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  try { await checkDb(); } catch (dbErr) { return res.status(500).json({ success: false, message: dbErr.message }); }
  try {
    switch (req.method) {
      case "GET": {
        const caller = await requireAuth(req, res); if (!caller) return;
        if (caller.role === "admin") {
          const { user_id } = req.query;
          if (user_id) { const r = await pool.query("SELECT ui.*, u.name AS user_name, u.email AS user_email FROM user_integrations ui JOIN users u ON u.id = ui.user_id WHERE ui.user_id = $1", [user_id]); if (!r.rows[0]) return res.status(404).json({ success: false, message: "Integração não encontrada" }); return res.status(200).json({ success: true, integration: r.rows[0] }); }
          const r = await pool.query("SELECT ui.*, u.name AS user_name, u.email AS user_email FROM user_integrations ui JOIN users u ON u.id = ui.user_id ORDER BY ui.created_at DESC");
          return res.status(200).json({ success: true, integrations: r.rows, total: r.rowCount });
        }
        let r = await pool.query("SELECT * FROM user_integrations WHERE user_id = $1", [caller.id]);
        if (!r.rows[0]) {
          const wt = crypto.randomBytes(32).toString("hex"), ct = crypto.randomBytes(32).toString("hex");
          await pool.query("INSERT INTO user_integrations (user_id, webhook_token, chatbot_token) VALUES ($1, $2, $3)", [caller.id, wt, ct]);
          r = await pool.query("SELECT * FROM user_integrations WHERE user_id = $1", [caller.id]);
        } else if (!r.rows[0].chatbot_token) {
          const ct = crypto.randomBytes(32).toString("hex");
          await pool.query("UPDATE user_integrations SET chatbot_token = $1 WHERE user_id = $2 AND chatbot_token IS NULL", [ct, caller.id]);
          r = await pool.query("SELECT * FROM user_integrations WHERE user_id = $1", [caller.id]);
        }
        return res.status(200).json({ success: true, integration: r.rows[0] });
      }
      case "PUT": {
        const caller = await requireAuth(req, res); if (!caller) return;
        const targetId = (caller.role === "admin" && req.query.user_id) ? req.query.user_id : caller.id;
        const { suri_endpoint, suri_token, ecommerce_platform, ecommerce_config, sync_schedule, catalog_polling } = req.body || {};
        await pool.query("INSERT IGNORE INTO user_integrations (user_id, webhook_token) VALUES ($1, $2)", [targetId, crypto.randomBytes(32).toString("hex")]);
        const fields = [], values = []; let idx = 1;
        if (suri_endpoint      !== undefined) { fields.push(`suri_endpoint = $${idx++}`);      values.push(suri_endpoint); }
        if (suri_token         !== undefined) { fields.push(`suri_token = $${idx++}`);         values.push(suri_token); }
        if (ecommerce_platform !== undefined) { fields.push(`ecommerce_platform = $${idx++}`); values.push(ecommerce_platform); }
        if (ecommerce_config   !== undefined) { fields.push(`ecommerce_config = $${idx++}`);   values.push(JSON.stringify(ecommerce_config)); }
        if (sync_schedule      !== undefined) {
          const times = Array.isArray(sync_schedule.times) ? sync_schedule.times.filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 2) : [];
          fields.push(`sync_schedule = JSON_MERGE_PATCH(COALESCE(sync_schedule, '{}'), $${idx++})`);
          values.push(JSON.stringify({ enabled: !!sync_schedule.enabled && times.length > 0, times, timezone: sync_schedule.timezone || "America/Sao_Paulo" }));
        }
        if (catalog_polling    !== undefined) {
          // Só os campos configuráveis pelo usuário (enabled/intervalMinutes)
          // entram no patch — lastRunAt/lastResult/productHashes são geridos
          // pelo próprio polling (poll-catalog.js) e nunca tocados aqui.
          const ALLOWED_INTERVALS = [10, 15, 30, 60];
          const intervalMinutes = ALLOWED_INTERVALS.includes(Number(catalog_polling.intervalMinutes))
            ? Number(catalog_polling.intervalMinutes)
            : 10;
          fields.push(`catalog_polling = JSON_MERGE_PATCH(COALESCE(catalog_polling, '{}'), $${idx++})`);
          values.push(JSON.stringify({ enabled: !!catalog_polling.enabled, intervalMinutes }));
        }
        if (!fields.length) return res.status(400).json({ success: false, message: "Nenhum campo informado" });
        fields.push("updated_at = NOW()"); values.push(targetId);
        await pool.query(`UPDATE user_integrations SET ${fields.join(", ")} WHERE user_id = $${idx}`, values);
        const r = await pool.query("SELECT * FROM user_integrations WHERE user_id = $1", [targetId]);
        return res.status(200).json({ success: true, message: "Integração salva", integration: r.rows[0] });
      }
      case "PATCH": {
        const caller = await requireAuth(req, res); if (!caller) return;
        const targetId = (caller.role === "admin" && req.query.user_id) ? req.query.user_id : caller.id;
        const { suri_active, ecommerce_active } = req.body || {};
        const fields = [], values = []; let idx = 1;
        if (suri_active      !== undefined) { fields.push(`suri_active = $${idx++}`);      values.push(suri_active); }
        if (ecommerce_active !== undefined) { fields.push(`ecommerce_active = $${idx++}`); values.push(ecommerce_active); }
        if (!fields.length) return res.status(400).json({ success: false, message: "Informe suri_active e/ou ecommerce_active" });
        fields.push("updated_at = NOW()"); values.push(targetId);
        const upd = await pool.query(`UPDATE user_integrations SET ${fields.join(", ")} WHERE user_id = $${idx}`, values);
        if (!upd.rowCount) return res.status(404).json({ success: false, message: "Integração não encontrada" });
        const r = await pool.query("SELECT id, user_id, suri_active, ecommerce_active, updated_at FROM user_integrations WHERE user_id = $1", [targetId]);
        return res.status(200).json({ success: true, message: "Status atualizado", integration: r.rows[0] });
      }
      case "DELETE": {
        const caller = await requireAuth(req, res); if (!caller) return;
        const targetId = (caller.role === "admin" && req.query.user_id) ? req.query.user_id : caller.id;
        await pool.query("UPDATE user_integrations SET suri_endpoint=NULL, suri_token=NULL, suri_active=false, ecommerce_platform=NULL, ecommerce_config=NULL, ecommerce_active=false, updated_at=NOW() WHERE user_id=$1", [targetId]);
        return res.status(200).json({ success: true, message: "Integração limpa" });
      }
      default: res.setHeader("Allow", ["GET","PUT","PATCH","DELETE"]); return res.status(405).end();
    }
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}
