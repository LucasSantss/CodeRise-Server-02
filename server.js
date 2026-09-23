/**
 * Entry point para hospedagem Node.js da Hostinger (hPanel/Passenger).
 *
 * Diferente do Vercel/Cloudflare (funções por request), aqui é um processo
 * Node.js único e persistente — por isso usamos Express de verdade, servindo
 * tanto a API quanto o front-end estático a partir do mesmo processo/domínio.
 *
 * Os handlers de api/** foram escritos no formato Node clássico (req, res) —
 * exatamente o que o Express já entrega nativamente (req/res do Express são
 * o http.IncomingMessage/ServerResponse do próprio Node, só que com métodos
 * de conveniência a mais). Por isso eles são reaproveitados aqui sem
 * nenhuma alteração, ao contrário do que seria necessário num runtime
 * serverless/edge.
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleAuth } from "./api/_lib/auth.js";
import { handleChatbot } from "./api/_lib/chatbot.js";
import { handleWebhooks, handleWebhooksPoll } from "./api/_lib/webhooks.js";
import { handleWebhook } from "./api/_lib/webhook-receiver.js";
import { handleRegisterWebhook, handleRegisterChatbotWebhook } from "./api/_lib/register-webhook.js";
import { handleSyncCatalog } from "./api/_lib/sync-catalog.js";
import { handlePlatformSettings } from "./api/_lib/platform-settings.js";
import { handleErrorWebhookSettings } from "./api/_lib/error-webhook.js";
import { handleSetup } from "./api/_lib/setup.js";
import { handleTestSuri } from "./api/_lib/test-suri.js";
import handleTestEcommerce from "./api/_lib/test-ecommerce.js";
import { handleLogistics } from "./api/_lib/logistics.js";
import { handleLogisticsQuote } from "./api/_lib/logistics-quote.js";
import handleTestLogistics from "./api/_lib/test-logistics.js";

// Mesmos 4 + cron-sync-stores que hoje são arquivos de topo em api/ — ver
// tabela de "fontes da verdade" no plano de migração (users/integrations/
// notifications/sync-rules têm duplicatas órfãs em api/_lib/, não usadas aqui).
import handleUsers from "./api/users.js";
import handleIntegrations from "./api/integrations.js";
import handleNotifications from "./api/notifications.js";
import handleSyncRules from "./api/sync-rules.js";
import handleCronSyncStores, { runDueCatalogSyncs, runDuePolling } from "./api/cron-sync-stores.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));

// ─── Rotas da API — mesma tabela do vercel.json / api/index.js ─────────────
app.all("/auth", handleAuth);
app.all("/chatbot", handleChatbot);
app.all("/webhooks/poll", handleWebhooksPoll);
app.all("/webhooks", handleWebhooks);
app.all("/webhook", handleWebhook);
app.all("/register-webhook", handleRegisterWebhook);
app.all("/register-chatbot-webhook", handleRegisterChatbotWebhook);
app.all("/sync-catalog", handleSyncCatalog);
app.all("/platform-settings", handlePlatformSettings);
app.all("/error-webhook-settings", handleErrorWebhookSettings);
app.all("/setup", handleSetup);
app.all("/test-suri", handleTestSuri);
app.all("/test-ecommerce", handleTestEcommerce);
app.all("/logistics", handleLogistics);
app.all("/logistics-quote", handleLogisticsQuote);
app.all("/test-logistics", handleTestLogistics);
app.all("/users*", handleUsers);
app.all("/integrations*", handleIntegrations);
app.all("/notifications*", handleNotifications);
app.all("/sync-rules*", handleSyncRules);
app.all("/cron-sync-stores", handleCronSyncStores);

// ─── Front-end (build do Vite) + fallback de SPA ────────────────────────────
// index.html referencia os nomes de arquivo com hash do build atual (ex:
// index-CPSjfnoX.js) — se ficar em cache, o navegador de uma aba já aberta
// (ou revisitada sem hard-refresh) continua tentando buscar o JS/CSS do
// build anterior, que já não existe mais em dist/assets após um novo
// `npm run build`. Sem uma rota estática correspondente, o fallback de SPA
// logo abaixo devolve o próprio index.html (text/html) no lugar — o
// navegador recusa executar isso como módulo JS e a página fica em branco,
// sem erro óbvio no Network (a requisição do .js "funciona", só que devolve
// HTML). Por isso index.html nunca pode ficar em cache; já os arquivos
// dentro de /assets/ têm hash no nome — o conteúdo de um nome já publicado
// nunca muda, então podem (e devem) ficar em cache pelo tempo máximo.
const distDir = path.join(__dirname, "dist");
app.use(express.static(distDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
    else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  },
}));
app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(distDir, "index.html"));
});

// ─── Sincronização automática de catálogo ──────────────────────────────────
// O processo do Node no hPanel roda o tempo todo (diferente do modelo
// serverless do Vercel/Cloudflare), então a sincronização agendada roda
// direto no próprio processo, sem depender de um cron externo. Reaproveita
// exatamente a mesma lógica que o endpoint HTTP /cron-sync-stores usa.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  runDueCatalogSyncs().catch((err) => console.error("[cron interno] erro:", err.message));
  // Polling incremental (plataformas sem webhook, ex: MaxData) — mesmo tick,
  // cada integração só roda de fato quando bate o intervalo configurado nela
  // (catalog_polling.intervalMinutes, ver poll-catalog.js/runDuePolling).
  runDuePolling().catch((err) => console.error("[cron interno][polling] erro:", err.message));
}, SYNC_INTERVAL_MS);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`[app] rodando na porta ${port}`));
