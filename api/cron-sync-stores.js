/**
 * api/cron-sync-stores.js — dispara a sincronização automática de catálogo
 * para usuários com agendamento ativo (até 2 horários livres/dia, configurados
 * em "Lojas" > "Sincronização de Catálogo" > "Sincronização Automática").
 *
 * Chamado periodicamente (a cada ~10-15min) por um agendador externo
 * (cron-job.org), protegido por CRON_SECRET. Também roda no navegador
 * (enquanto o dashboard estiver aberto) — os dois escrevem no mesmo
 * sync_schedule.lastRun, então não duplicam a sincronização no mesmo dia/horário.
 */
import pool from "./_lib/db.js";
import { setCors } from "./_cors.js";
import { syncCatalogForIntegrationRow } from "./_lib/sync-catalog.js";
import { pollCatalogForIntegrationRow, NO_WEBHOOK_PLATFORMS } from "./_lib/poll-catalog.js";

const TOLERANCE_MINUTES = 7;
const TIME_BUDGET_MS = 45000;

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = req.headers.authorization || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const headerSecret = req.headers["x-cron-secret"] || "";
  const querySecret = req.query?.secret || "";
  return bearer === secret || headerSecret === secret || querySecret === secret;
}

function nowInTimezone(timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type)?.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${get("hour")}:${get("minute")}` };
}

function minutesSinceMidnight(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Lógica de disparo em si, extraída do handler HTTP para poder ser reaproveitada
 * pelo Cron Trigger nativo da Cloudflare (cron-worker/index.js), que roda em
 * `scheduled()` em vez de responder a uma requisição HTTP.
 */
export async function runDueCatalogSyncs() {
  const startedAt = Date.now();
  const rows = await pool.query(
    "SELECT id, user_id, ecommerce_platform, ecommerce_config, chatbot_config, suri_endpoint, suri_token, sync_schedule FROM user_integrations WHERE sync_schedule->>'$.enabled' = 'true'"
  ).then(r => r.rows).catch(() => []);

  const triggered = [];
  let skippedBudget = 0;

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { skippedBudget++; continue; }

    const schedule = row.sync_schedule || {};
    const timezone = schedule.timezone || "America/Sao_Paulo";
    const times = Array.isArray(schedule.times) ? schedule.times : [];
    if (times.length === 0) continue;

    const { date: today, hhmm: currentTime } = nowInTimezone(timezone);
    const currentMinutes = minutesSinceMidnight(currentTime);
    const lastRun = schedule.lastRun && schedule.lastRun.date === today ? schedule.lastRun : { date: today, times: [] };

    const dueSlot = times.find((slot) => !lastRun.times.includes(slot) && Math.abs(minutesSinceMidnight(slot) - currentMinutes) <= TOLERANCE_MINUTES);
    if (!dueSlot) continue;

    let result;
    try {
      result = await syncCatalogForIntegrationRow(row);
    } catch (err) {
      result = { success: false, message: err.message };
    }

    // Recarrega o schedule mais recente antes de gravar, pra não pisar em uma
    // execução concorrente do timer do navegador que tenha rodado nesse meio tempo.
    const freshRow = await pool.query("SELECT sync_schedule FROM user_integrations WHERE id = $1", [row.id]).then(r => r.rows[0]).catch(() => null);
    const freshSchedule = freshRow?.sync_schedule || schedule;
    const freshLastRun = freshSchedule.lastRun && freshSchedule.lastRun.date === today ? freshSchedule.lastRun : { date: today, times: [] };
    if (freshLastRun.times.includes(dueSlot)) continue; // já rodou (ex: pelo navegador) enquanto sincronizávamos

    const updatedLastRun = { date: today, times: [...freshLastRun.times, dueSlot] };
    const historyEntry = { at: new Date().toISOString(), slot: dueSlot, success: !!result.success, message: result.message || null, summary: result.summary || null };
    const history = [historyEntry, ...(Array.isArray(freshSchedule.history) ? freshSchedule.history : [])].slice(0, 15);
    await pool.query(
      "UPDATE user_integrations SET sync_schedule = JSON_MERGE_PATCH(sync_schedule, $1), updated_at = NOW() WHERE id = $2",
      [JSON.stringify({ lastRun: updatedLastRun, lastResult: historyEntry, history }), row.id]
    ).catch(() => {});

    triggered.push({ user_id: row.user_id, slot: dueSlot, success: !!result.success, message: result.message || null });
  }

  return {
    success: true,
    checked: rows.length,
    triggered,
    skippedBudget,
    elapsedMs: Date.now() - startedAt,
  };
}

const DEFAULT_POLLING_INTERVAL_MINUTES = 10;

/**
 * Sincronização incremental (polling) — para plataformas sem webhooks
 * (NO_WEBHOOK_PLATFORMS, ver poll-catalog.js), roda a cada tick deste cron
 * checando se já passou o intervalo configurado (catalog_polling.intervalMinutes,
 * padrão 10min) desde a última execução de cada integração.
 *
 * Reaproveita o mesmo agendador externo do runDueCatalogSyncs — no Hostinger
 * (server.js) o processo persistente já chama isso a cada 5min via
 * setInterval; no Vercel, depende do mesmo cron externo (cron-job.org) que
 * bate em /cron-sync-stores.
 */
export async function runDuePolling() {
  const startedAt = Date.now();
  const placeholders = NO_WEBHOOK_PLATFORMS.map((_, i) => `$${i + 1}`).join(",");
  const rows = await pool.query(
    `SELECT id, user_id, ecommerce_platform, ecommerce_config, chatbot_config, suri_endpoint, suri_token, catalog_polling
     FROM user_integrations
     WHERE catalog_polling->>'$.enabled' = 'true' AND ecommerce_platform IN (${placeholders})`,
    NO_WEBHOOK_PLATFORMS
  ).then(r => r.rows).catch(() => []);

  const triggered = [];
  let skippedBudget = 0;

  for (const row of rows) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { skippedBudget++; continue; }

    const cp = row.catalog_polling || {};
    const intervalMs = (cp.intervalMinutes || DEFAULT_POLLING_INTERVAL_MINUTES) * 60 * 1000;
    const lastRunAt = cp.lastRunAt ? Date.parse(cp.lastRunAt) : 0;
    if (Number.isFinite(lastRunAt) && Date.now() - lastRunAt < intervalMs) continue; // ainda não venceu o intervalo

    let result;
    try {
      result = await pollCatalogForIntegrationRow(row);
    } catch (err) {
      result = { at: new Date().toISOString(), success: false, message: err.message, productHashes: cp.productHashes || {} };
    }

    // productHashes precisa ser substituído por inteiro (não mesclado) — já
    // recalculamos o mapa completo e correto a cada rodada (pollCatalogForIntegrationRow
    // varre o catálogo inteiro); um JSON_MERGE_PATCH comum nunca removeria as
    // entradas de produtos que já não existem mais, e cada rodada seguinte
    // ia detectar (e tentar desativar) o mesmo produto removido de novo, pra
    // sempre. JSON_SET força a troca completa só desse campo; os demais
    // (enabled/intervalMinutes, setados pelo usuário) seguem preservados
    // pelo JSON_MERGE_PATCH.
    const { productHashes, ...lastResult } = result;
    await pool.query(
      `UPDATE user_integrations
       SET catalog_polling = JSON_SET(
             JSON_MERGE_PATCH(COALESCE(catalog_polling, '{}'), $1),
             '$.productHashes', CAST($2 AS JSON)
           ),
           updated_at = NOW()
       WHERE id = $3`,
      [JSON.stringify({ lastRunAt: result.at, lastResult }), JSON.stringify(productHashes || {}), row.id]
    ).catch(() => {});

    triggered.push({ user_id: row.user_id, success: result.success, message: result.message });
  }

  return {
    success: true,
    checked: rows.length,
    triggered,
    skippedBudget,
    elapsedMs: Date.now() - startedAt,
  };
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", ["GET", "POST"]); return res.status(405).end(); }
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: "Não autorizado." });

  const [syncResult, pollResult] = await Promise.all([
    runDueCatalogSyncs(),
    runDuePolling(),
  ]);
  return res.status(200).json({ ...syncResult, polling: pollResult });
}
