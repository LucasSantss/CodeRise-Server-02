/**
 * ecommerce/maxdata/orders.js
 * Operações de pedidos na MaxData — FLUXO REVERSO (Suri → MaxData).
 *
 * A MaxData (ERP/PDV) não expõe nenhum endpoint público de atualização de
 * status/envio ou cancelamento de pedido vindo de um canal de venda externo
 * (a documentação só cobre pedidos internos do próprio PDV/comandas/OS).
 * Por isso este módulo existe apenas por paridade de arquivos com as demais
 * integrações — a baixa/devolução de estoque (a única ação de fato suportada
 * pra pedidos da Suri) fica em stock.js, reaproveitado diretamente por
 * webhook-receiver.js.
 */

export async function fulfillOrder() {
  return {
    action: "not_supported",
    reason: "A MaxData não possui endpoint de atualização de envio de pedido via API pública.",
  };
}

export async function cancelOrder() {
  return {
    action: "not_supported",
    reason: "A MaxData não possui endpoint de cancelamento de pedido via API pública.",
  };
}
