/**
 * ecommerce/maxdata/index.js
 * A MaxData (MaxApi Manager) não expõe nenhuma API de webhooks — é um
 * ERP/PDV consultado sob demanda, não uma plataforma de e-commerce que
 * notifica eventos. Por isso:
 *
 *  - normalizeWebhook existe só por paridade de interface com as demais
 *    integrações; na prática nunca deve ser chamado, já que a MaxData nunca
 *    envia requisições pro nosso endpoint de webhook.
 *  - registerWebhooks retorna uma mensagem explicando que produtos e
 *    categorias precisam ser mantidos atualizados via sincronização de
 *    catálogo (manual ou agendada, em Lojas → Sincronização de Catálogo).
 */

export function normalizeWebhook(payload) {
  const p = payload?.product || payload || {};
  return { eventType: "product.sync", productId: String(p.id || ""), needsApiFetch: true };
}

export async function registerWebhooks(_config, _webhookUrl) {
  return {
    success: true,
    manual: true,
    message: "A MaxData não possui API de webhooks. Use a sincronização de catálogo (manual ou agendada, em Lojas → Sincronização de Catálogo) para manter produtos e categorias atualizados na Suri.",
    events: [],
  };
}
