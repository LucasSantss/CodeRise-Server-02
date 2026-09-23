/**
 * ecommerce/maxdata/products.js
 * Normaliza produtos da API MaxData (MaxApi Manager) para o formato interno
 * do CodeRise.
 *
 * A MaxData é um ERP/PDV, não uma vitrine de e-commerce: não existe conceito
 * de variantes (cor/tamanho) nem de SKU dedicado — cada "produto"
 * (dtos.Product) já é a própria unidade vendável. Por isso o produto
 * normalizado nunca preenche `variants` (a Suri trata `variants: []` como
 * produto de dimensão única — ver toSuriFormat em chatbot/suri/products.js),
 * e o `sku` usado é sempre o próprio `id` do produto na MaxData: é o único
 * identificador garantido, estável e resolvível de volta via
 * GET /product/{id} — necessário pra baixa/devolução de estoque disparada
 * por pedidos da Suri (ver stock.js).
 */

import * as client from "./client.js";

function toImageUrl(imagem) {
  if (!imagem) return null;
  const val = String(imagem).trim();
  // O formato do campo "imagem" (retornado na listagem/detalhe do produto)
  // não é documentado com precisão pela MaxData — assume-se URL quando
  // reconhecível como tal; caso contrário (ex: base64, path relativo) é
  // ignorado, pra não mandar uma URL de imagem inválida pra Suri.
  return /^https?:\/\//i.test(val) ? val : null;
}

/**
 * Normaliza um produto (dtos.Product) da MaxData para o formato interno.
 */
export function normalizeProduct(p) {
  const id = String(p.id);
  const imageUrl = toImageUrl(p.imagem);

  // "peso"/"pesoLiq" não têm a unidade documentada — segue a convenção mais
  // comum em ERPs nacionais (quilogramas) e converte pra gramas (a Suri
  // exige inteiro), como já é feito para a Olist. Ajustar aqui caso a
  // MaxData confirme unidade diferente (ex: já em gramas).
  const weightKg = parseFloat(p.pesoLiq ?? p.peso ?? 0) || 0;

  return {
    id,
    sku: id,
    name: p.descricao || p.descPdv || "",
    // A MaxData não tem um campo de descrição longa/HTML — reaproveita a
    // descrição do produto (não há texto rico disponível nesse ERP).
    description: p.descricao || p.descPdv || "",
    categoryId: p.grupoId != null ? String(p.grupoId) : null,
    brand: p.fabricante || null,
    isActive: p.desativado !== true && p.desativado !== "true",
    price: parseFloat(p.valorVenda || 0),
    promotionalPrice: parseFloat(p.valorPromocao || 0),
    url: null,
    images: imageUrl ? [{ url: imageUrl, description: null }] : [],
    weightInGrams: Math.round(weightKg * 1000),
    dimensions: {
      heightInCm: parseFloat(p.altura || 0),
      widthInCm:  parseFloat(p.largura || 0),
      lengthInCm: parseFloat(p.comprimento || 0),
    },
    stock: parseInt(p.estoque ?? 0, 10) || 0,
    // MaxData não tem variantes — a Suri recebe o produto como dimensão
    // única a partir daqui.
    variants: [],
  };
}

/**
 * Busca um produto completo pelo ID e normaliza.
 */
export async function fetchAndNormalizeProduct(config, productId) {
  const { api_url, emp_id, terminal } = config;
  const p = await client.getProduct(api_url, emp_id, terminal, productId);
  return normalizeProduct(p);
}
