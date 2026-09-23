import pool from "./db.js";
import { requireAuth } from "../_auth.js";

export async function handleWebhooks(req, res) {
  try {
    switch (req.method) {
      case "GET": {
        const caller = await requireAuth(req, res); if (!caller) return;
        const { id, event_type, status, limit, since, after_id, source } = req.query;
        const where = [], values = []; let idx = 1;
        if (caller.role !== "admin") { where.push(`uw.user_id = $${idx++}`); values.push(caller.id); }
        else if (req.query.user_id) { where.push(`uw.user_id = $${idx++}`); values.push(req.query.user_id); }
        if (id)         { where.push(`uw.id = $${idx++}`);          values.push(id); }
        if (event_type) { where.push(`uw.event_type = $${idx++}`);  values.push(event_type); }
        if (status)     { where.push(`uw.status = $${idx++}`);      values.push(status); }
        if (source)     { where.push(`uw.source = $${idx++}`);      values.push(source); }
        // Sem "since" explícito, restringe aos últimos 30 dias — a listagem não
        // é mais limitada por quantidade de linhas, e sim por janela de tempo,
        // pra não crescer indefinidamente conforme o volume de eventos aumenta.
        if (since)      { where.push(`uw.received_at > $${idx++}`); values.push(since); }
        else            { where.push(`uw.received_at > NOW() - INTERVAL 30 DAY`); }
        if (after_id)   { where.push(`uw.id > $${idx++}`);          values.push(after_id); }
        const whereStr = where.length ? `WHERE ${where.join(" AND ")}` : "";
        let sql = `SELECT uw.id, uw.user_id, u.name AS user_name, u.email AS user_email, uw.event_type, uw.payload, uw.status, uw.error_message, uw.source, uw.received_at FROM user_webhooks uw JOIN users u ON u.id = uw.user_id ${whereStr} ORDER BY uw.received_at DESC`;
        const queryValues = [...values];
        if (limit) { const p = parseInt(limit, 10); if (!isNaN(p) && p > 0) { sql += ` LIMIT $${idx}`; queryValues.push(p); } }
        const r = await pool.query(sql, queryValues);
        if (id) { if (!r.rows[0]) return res.status(404).json({ success: false, message: "Evento não encontrado" }); return res.status(200).json({ success: true, webhook: r.rows[0] }); }
        return res.status(200).json({ success: true, webhooks: r.rows, total: r.rowCount, server_time: new Date().toISOString() });
      }
      case "PATCH": {
        const caller = await requireAuth(req, res); if (!caller) return;
        const { id } = req.query; if (!id) return res.status(400).json({ success: false, message: "id obrigatório" });
        const { status, error_message } = req.body || {};
        if (!["received","processed","error"].includes(status)) return res.status(400).json({ success: false, message: "status inválido" });
        const ownerFilter = caller.role === "admin" ? "" : ` AND user_id = ${caller.id}`;
        const upd = await pool.query(`UPDATE user_webhooks SET status=$1, error_message=$2 WHERE id=$3${ownerFilter}`, [status, error_message || null, id]);
        if (!upd.rowCount) return res.status(404).json({ success: false, message: "Evento não encontrado" });
        return res.status(200).json({ success: true, message: "Status atualizado", webhook: { id, status, error_message: error_message || null } });
      }
      case "DELETE": {
        const caller = await requireAuth(req, res); if (!caller) return;
        const { id } = req.query;
        if (id) {
          const ownerFilter = caller.role === "admin" ? "" : ` AND user_id = ${caller.id}`;
          const r = await pool.query(`DELETE FROM user_webhooks WHERE id=$1${ownerFilter}`, [id]);
          if (!r.rowCount) return res.status(404).json({ success: false, message: "Evento não encontrado" });
          return res.status(200).json({ success: true, message: "Evento apagado" });
        }
        if (caller.role === "admin" && req.query.user_id) { await pool.query("DELETE FROM user_webhooks WHERE user_id=$1", [req.query.user_id]); }
        else if (caller.role === "admin") { await pool.query("DELETE FROM user_webhooks"); }
        else { await pool.query("DELETE FROM user_webhooks WHERE user_id=$1", [caller.id]); }
        return res.status(200).json({ success: true, message: "Eventos apagados" });
      }
      default: res.setHeader("Allow", ["GET","PATCH","DELETE"]); return res.status(405).end();
    }
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}

export async function handleWebhooksPoll(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", ["GET"]); return res.status(405).end(); }
  const caller = await requireAuth(req, res); if (!caller) return;

  const afterId = req.query.after_id ? parseInt(req.query.after_id, 10) : null;
  const timeout = 20000;

  const buildQuery = () => {
    const where = [], values = []; let idx = 1;
    if (caller.role !== "admin") { where.push(`uw.user_id = $${idx++}`); values.push(caller.id); }
    else if (req.query.user_id) { where.push(`uw.user_id = $${idx++}`); values.push(req.query.user_id); }
    if (req.query.status)     { where.push(`uw.status = $${idx++}`);     values.push(req.query.status); }
    if (req.query.event_type) { where.push(`uw.event_type = $${idx++}`); values.push(req.query.event_type); }
    if (afterId !== null)     { where.push(`uw.id > $${idx++}`);         values.push(afterId); }
    const whereStr = where.length ? `WHERE ${where.join(" AND ")}` : "";
    return { sql: `SELECT uw.id, uw.user_id, u.name AS user_name, u.email AS user_email, uw.event_type, uw.payload, uw.status, uw.error_message, uw.source, uw.received_at FROM user_webhooks uw JOIN users u ON u.id = uw.user_id ${whereStr} ORDER BY uw.received_at DESC LIMIT 100`, values };
  };

  const { sql, values } = buildQuery();
  const immediate = await pool.query(sql, values).catch(() => ({ rows: [] }));
  if (immediate.rows.length > 0) {
    return res.status(200).json({ success: true, webhooks: immediate.rows, has_new: true, server_time: new Date().toISOString() });
  }

  // Polling curto dentro do próprio request, em vez de LISTEN/NOTIFY: conexões
  // via pool (Hyperdrive/Neon pooled) não sustentam sessão dedicada para
  // pg_notify, então reconsultamos a cada ~1.5s até `timeout`. Mesmo contrato
  // externo de sempre (até ~20s de espera, mesmo formato de resposta).
  const started = Date.now();
  const intervalMs = 1500;
  while (Date.now() - started < timeout) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const { sql: s2, values: v2 } = buildQuery();
    const fresh = await pool.query(s2, v2).catch(() => ({ rows: [] }));
    if (fresh.rows.length > 0) {
      return res.status(200).json({ success: true, webhooks: fresh.rows, has_new: true, server_time: new Date().toISOString() });
    }
  }
  return res.status(200).json({ success: true, webhooks: [], has_new: false, server_time: new Date().toISOString() });
}
