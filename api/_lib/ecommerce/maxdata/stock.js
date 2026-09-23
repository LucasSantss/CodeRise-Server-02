/**
 * ecommerce/maxdata/stock.js
 * Baixa/devolução de estoque na MaxData a partir de pedidos da Suri.
 *
 * A MaxData não tem endpoint dedicado de "ajuste de estoque" — o único jeito
 * documentado de alterar o estoque é PUT /product/{id} com o corpo completo
 * do produto (dtos.ProductBody), que inclui o campo `estoque`. Por isso
 * sempre buscamos o produto atual primeiro (pra não sobrescrever os demais
 * campos com valores vazios/zerados) e reenviamos com o novo estoque
 * calculado — mesma estratégia de "ler estoque atual → calcular valor
 * absoluto → gravar" usada para a Olist.
 *
 * O `sku` usado aqui é sempre o próprio ID do produto na MaxData
 * (ver comentário em products.js), então a resolução do produto é direta
 * via GET /product/{id} — sem precisar de busca por SKU/EAN.
 */

import * as client from "./client.js";

/**
 * Monta o corpo (dtos.ProductBody) a partir do produto completo (dtos.Product)
 * retornado pela API, preservando os demais campos e sobrescrevendo apenas
 * `estoque`. Envia só os campos que de fato existem no schema de ProductBody.
 */
function buildUpdateBody(p, newStock) {
  return {
    CSOSN: p.CSOSN,
    aplicacao: p.aplicacao,
    balanca: p.balanca,
    baseCalc: p.baseCalc,
    cestId: p.cestId,
    classeId: p.classeId,
    codCST2: p.codCST2,
    codCst1: p.codCst1,
    codigoOriginal: p.codigoOriginal,
    desativado: p.desativado,
    descPdv: p.descPdv,
    descontoMaximo: p.descontoMaximo,
    descontoMaximoAtacado: p.descontoMaximoAtacado,
    descricao: p.descricao,
    estoque: newStock,
    fabricanteId: p.fabricanteId,
    fornecedorId: p.fornecedorId,
    fracionado: p.fracionado,
    geraArquivoBalanca: p.geraArquivoBalanca,
    grupoId: p.grupoId,
    localizador: p.localizador,
    multiplo: p.multiplo,
    multiploUn: p.multiploUn,
    naoContEstoque: p.naoContaEstoque,
    ncmId: p.ncmId,
    prateleira: p.prateleira,
    promocaoDia: p.promocaoDia,
    qtdAtacado: p.qtdAtacado,
    qtdComEntrada: p.qtdComEntrada,
    reclassificacao: p.reclassificacao,
    subGrupoId: p.subGrupoId,
    tipo: p.tipo,
    tipoReclassificacao: p.tipoReclassificacao,
    tipoSped: p.tipoSped,
    unComercialId: p.unComercialId,
    unId: p.unId,
    unTributariaId: p.unTributariaId,
    usaEcommerce: p.usaEcommerce,
    valorCusto: p.valorCusto,
    valorVenda: p.valorVenda,
  };
}

async function applyStockDelta(apiUrl, empId, terminal, productId, delta) {
  const current = await client.getProduct(apiUrl, empId, terminal, productId).catch(() => null);
  if (!current || current.id == null) {
    return { success: false, sku: String(productId), reason: `Produto ${productId} não encontrado na MaxData` };
  }
  const currentStock = parseInt(current.estoque ?? 0, 10) || 0;
  const newStock = Math.max(0, currentStock + delta);
  const body = buildUpdateBody(current, newStock);
  await client.updateProduct(apiUrl, empId, terminal, productId, body);
  return { success: true, sku: String(productId), previousStock: currentStock, newStock };
}

/**
 * Subtrai `qty` do estoque do produto identificado por `sku` (= id do
 * produto na MaxData). Nunca deixa o estoque ficar negativo.
 */
export async function deductVariantStock(config, sku, qty) {
  const { api_url, emp_id, terminal } = config;
  const quantity = parseInt(qty, 10) || 1;
  const result = await applyStockDelta(api_url, emp_id, terminal, sku, -quantity);
  return result.success ? { ...result, soldQuantity: quantity } : result;
}

/**
 * Devolve `qty` ao estoque do produto (pedido cancelado na Suri).
 */
export async function returnVariantStock(config, sku, qty) {
  const { api_url, emp_id, terminal } = config;
  const quantity = parseInt(qty, 10) || 1;
  const result = await applyStockDelta(api_url, emp_id, terminal, sku, quantity);
  return result.success ? { ...result, returned: quantity } : result;
}

/**
 * Processa a baixa de estoque para todos os itens de um pedido.
 *
 * @param {object} config  - { api_url, emp_id, terminal }
 * @param {Array}  items   - [{ sku, quantity, name? }, ...]
 */
export async function deductStockForOrderItems(config, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { processed: 0, results: [] };
  }

  const results = [];

  for (const item of items) {
    const sku = String(item.sku || item.Sku || "");
    const qty = parseInt(item.quantity || item.paidQuantity || 1, 10);

    if (!sku) {
      results.push({ success: false, sku: "(vazio)", reason: "SKU não informado no item" });
      continue;
    }

    try {
      const result = await deductVariantStock(config, sku, qty);
      results.push({ ...result, itemName: item.name || item.Name || "" });
    } catch (err) {
      results.push({
        success:  false,
        sku,
        itemName: item.name || item.Name || "",
        reason:   err.message,
      });
    }
  }

  return {
    processed: results.length,
    succeeded: results.filter(r => r.success).length,
    failed:    results.filter(r => !r.success).length,
    results,
  };
}
