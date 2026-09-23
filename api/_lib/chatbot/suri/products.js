/**
 * chatbot/suri/products.js
 * Criação e atualização de produtos na Suri.
 *
 * storeId agora vem resolvido via store mapping (passado pelo caller).
 * Fallback para getFirstStoreId apenas quando não há mapeamento configurado.
 */

import * as client from "./client.js";
import { getFirstStoreId, buildStocks, buildPriceTables } from "./stores.js";

// Resolve price/promotionalPrice pro significado que a Suri usa. Internamente
// "price" é o preço cheio e "promotionalPrice" é o preço com desconto — mas na
// Suri é o oposto: "price" é o "Preço atual" (o que é cobrado) e
// "promotionalPrice" é o "Preço antigo" (riscado). Sem essa inversão, produtos
// em promoção apareciam com o preço cheio como atual.
// Módulo (não só dentro de toSuriFormat) pra reaproveitar em updateProductPricesOnly.
function resolveSuriPrices(regularPrice, promoPrice) {
  const hasDiscount = promoPrice > 0 && promoPrice < regularPrice;
  return hasDiscount
    ? { price: promoPrice, promotionalPrice: regularPrice }
    : { price: regularPrice, promotionalPrice: 0 };
}

function toSuriFormat(product, storeId) {
  // Monta as variações (campo `dimensions` na Suri).
  // Cada variação recebe: sku, preço, estoque, medidas, imagem própria e atributos (Cor, Tamanho, etc.)

  // Helper: retorna um SKU válido.
  // String(null) = "null" e String(undefined) = "undefined" — ambos rejeitados pela Suri.
  // Usa o ID do produto como fallback seguro.
  function buildSku(skuValue, fallbackId) {
    const s = skuValue != null ? String(skuValue).trim() : "";
    return s && s !== "null" && s !== "undefined" ? s : String(fallbackId);
  }

  // Helper: monta o objeto `image` de cada variação (campo `dimensions[].image`).
  // Diferente do array `images` no nível raiz, a Suri espera aqui só { url }.
  function buildImage(variantImageUrl) {
    const url = variantImageUrl || product.images?.[0]?.url || "";
    const validUrl = url && url !== "null" && url !== "undefined" ? url : null;
    return { url: validUrl };
  }

  // Helper: a Suri espera weightInGrams como inteiro — valores com casas
  // decimais (ex: 4030.0000000000005, por imprecisão de ponto flutuante em
  // conversões de unidade) são rejeitados com HTTP 400 ("not a valid integer").
  function roundWeight(value) {
    return Math.round(Number(value) || 0);
  }

  // Helper: descarta atributos sem valor (ex: "Tamanho": null vindo da Olist
  // quando a variante não tem essa dimensão) — a Suri não deve receber uma
  // opção vazia nem no `dimensions` nem no `attributes` da variação/produto.
  function hasValue(value) {
    return value != null && String(value).trim() !== "";
  }

  const basePrices = resolveSuriPrices(product.price, product.promotionalPrice ?? 0);

  // A Suri exige que todas as variações (`dimensions[]`) do mesmo produto
  // compartilhem exatamente o mesmo conjunto de atributos (ex: todas com
  // "Tamanho" e "Cor") — senão rejeita o produto inteiro com
  // "ProductAttributesAndDimensionsMustMatch". Produtos ainda em edição na
  // Olist/e-commerce podem chegar com atributos preenchidos só em parte das
  // variantes (ex: tamanhos configurados um a um); calculamos aqui a união
  // dos nomes de atributo entre todas as variantes pra preencher "-" nas que
  // ainda não têm valor, em vez de travar a sincronização do produto todo.
  const allAttributeNames = Array.from(new Set(
    (product.variants || []).flatMap(v => (v.attributes || []).filter(a => hasValue(a.value)).map(a => String(a.name)))
  ));

  const dimensions = (product.variants && product.variants.length > 0)
    ? product.variants.map(v => {
      const variantPrices = resolveSuriPrices(v.price ?? product.price, v.promotionalPrice ?? product.promotionalPrice ?? 0);
      const validAttributes = (v.attributes || []).filter(a => hasValue(a.value));
      const finalAttributes = [
        ...validAttributes.map(a => ({ name: String(a.name), value: String(a.value) })),
        ...allAttributeNames
          .filter(name => !validAttributes.some(a => String(a.name) === name))
          .map(name => ({ name, value: "-" })),
      ];
      const variantObj = {
        sku: buildSku(v.sku || product.sku, product.id),
        dimensions: Object.fromEntries(
          finalAttributes.map(a => [a.name, a.value])
        ),
        price: variantPrices.price,
        promotionalPrice: variantPrices.promotionalPrice,
        priceTables: buildPriceTables(storeId, variantPrices.price),
        stocks: buildStocks(storeId, v.stock ?? product.stock ?? 0),
        measurements: {
          weightInGrams: roundWeight(v.weightInGrams || product.weightInGrams || 0),
          heightInCm: v.dimensions?.heightInCm || product.dimensions?.heightInCm || 0,
          widthInCm: v.dimensions?.widthInCm || product.dimensions?.widthInCm || 0,
          lengthInCm: v.dimensions?.lengthInCm || product.dimensions?.lengthInCm || 0,
          unitsPerPackage: 1,
        },
        // Atributos da variação (ex: [{ name: "Cor", value: "Azul" }, { name: "Tamanho", value: "M" }])
        attributes: finalAttributes,
        image: buildImage(v.imageUrl),
      };
      return variantObj;
    })
    : [{
      sku: buildSku(product.sku, product.id),
      dimensions: {},
      image: buildImage(null),
      price: basePrices.price,
      promotionalPrice: basePrices.promotionalPrice,
      priceTables: buildPriceTables(storeId, basePrices.price),
      stocks: buildStocks(storeId, product.stock ?? 0),
      measurements: {
        weightInGrams: roundWeight(product.weightInGrams || 0),
        heightInCm: product.dimensions?.heightInCm || 0,
        widthInCm: product.dimensions?.widthInCm || 0,
        lengthInCm: product.dimensions?.lengthInCm || 0,
        unitsPerPackage: 1,
      },
      attributes: [],
    }];

  return {
    id: product.id,
    sku: buildSku(product.sku, product.id),
    categoryId: product.categoryId || null,
    subcategoryId: null,
    // A Suri espera brand como objeto ShopBrand: { name: "..." } ou null
    // quando não houver marca. Nunca enviar como string pura (HTTP 400).
    brand: (product.brand && product.brand !== "null") ? { name: String(product.brand) } : null,
    sellerId: "all",
    sellerName: null,
    isActive: product.isActive,
    isPriceEditable: false,
    itemWithoutLogistic: false,
    isRestrictedSale: false,
    name: product.name,
    description: product.description || "",
    // url nula/vazia é omitida — a Suri rejeita null neste campo (HTTP 400)
    ...(product.url && product.url !== "null" && product.url !== "undefined"
      ? { url: product.url }
      : {}),
    price: basePrices.price,
    promotionalPrice: basePrices.promotionalPrice,
    minPrice: basePrices.price,
    hasShippingRestriction: false,
    // images no nível raiz: usa as imagens do produto ou das variações.
    // Quando não há nenhuma imagem, envia null (formato nativo da Suri, conforme retornado pela API).
    images: (() => {
      // 1) Imagens do produto (nível raiz)
      const productImgs = (product.images || [])
        .filter(i => i && i.url && i.url !== "null" && i.url !== "undefined")
        .map(i => ({ providerId: null, url: i.url, description: i.description || null }));
      if (productImgs.length > 0) return productImgs;

      // 2) Fallback: imagens das variações (deduplica por URL)
      const seen = new Set();
      const variantImgs = [];
      for (const v of (product.variants || [])) {
        const u = v.imageUrl;
        if (u && u !== "null" && u !== "undefined" && !seen.has(u)) {
          seen.add(u);
          variantImgs.push({ providerId: null, url: u, description: null });
        }
      }
      if (variantImgs.length > 0) return variantImgs;

      // 3) Sem imagens: null (igual ao formato que a Suri retorna)
      return null;
    })(),
    attributes: (() => {
      // Agrega atributos das variações no formato que a Suri espera:
      // [{ name: "Cor", options: [{ name: "Azul" }, { name: "Vermelho" }] }]
      // Lê de `dimensions` (já com os placeholders "-" preenchidos acima), não
      // das variantes originais, pra manter as opções aqui coerentes com os
      // valores que cada variação de fato carrega em `dimensions[].dimensions`.
      const attrMap = new Map();
      for (const d of dimensions) {
        for (const a of (d.attributes || [])) {
          if (!attrMap.has(a.name)) attrMap.set(a.name, new Set());
          attrMap.get(a.name).add(a.value);
        }
      }
      return Array.from(attrMap.entries()).map(([name, values]) => ({
        name,
        options: Array.from(values).map(v => ({ name: v })),
      }));
    })(),
    dimensions,
    weightInGrams: roundWeight(product.weightInGrams || 0),
  };
}

/**
 * Sincroniza um produto na Suri.
 *
 * Estratégia: POST primeiro (criar). Se a Suri indicar que o produto
 * já existe (HTTP 409, ou HTTP 400/422 com "already exists" / "duplicate"),
 * faz PUT (atualizar). Isso evita o erro de validação do campo `brand`
 * que ocorria quando se tentava PUT em produtos ainda não criados.
 *
 * @param {string} endpoint
 * @param {string} token
 * @param {object} product  - produto normalizado
 * @param {string|null} resolvedStoreId - ID da loja Suri resolvido via store mapping.
 *   Se null, usa getFirstStoreId como fallback.
 * @param {Map<string,string>|null} categoryIdMap - mapa nuvemshop_id → suri_id para categorias.
 */
export async function syncProduct(endpoint, token, product, resolvedStoreId = null, categoryIdMap = null) {
  const storeId = resolvedStoreId || await getFirstStoreId(endpoint, token);
  if (!storeId) throw new Error("Nenhuma loja encontrada na Suri — configure uma loja antes de sincronizar produtos.");

  // Resolve o categoryId para o ID interno da Suri.
  // Se não houver mapeamento, envia null para evitar rejeição por ID de outra plataforma.
  const resolvedCategoryId = (() => {
    if (!product.categoryId) return null;
    if (categoryIdMap && categoryIdMap.size > 0) {
      const mapped = categoryIdMap.get(String(product.categoryId));
      return mapped || null;
    }
    // Sem mapa disponível: não envia o ID externo pois a Suri vai rejeitar
    return null;
  })();

  const productWithResolvedCategory = { ...product, categoryId: resolvedCategoryId };
  const suriPayload = toSuriFormat(productWithResolvedCategory, storeId);

  try {
    // 1) Verifica se o produto já existe na Suri pelo ID
    let exists = false;
    try {
      exists = await client.productExists(endpoint, token, product.id);
    } catch {
      // Se não conseguir verificar, tenta POST e deixa a Suri decidir
      exists = false;
    }

    if (exists) {
      // Produto já existe → PUT (atualizar)
      await client.updateProduct(endpoint, token, suriPayload);
      return { action: "product_updated", productId: product.id, storeId, sentPayload: suriPayload };
    }

    // Produto não existe → POST (criar)
    try {
      await client.createProduct(endpoint, token, suriPayload);
      return { action: "product_created", productId: product.id, storeId, sentPayload: suriPayload };
    } catch (createErr) {
      const msg = createErr.message || "";
      // Se a Suri retornar que o produto já existe (race condition ou ID duplicado),
      // tenta PUT como fallback
      const alreadyExists =
        msg.includes("HTTP 409") ||
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("já existe");
      if (alreadyExists) {
        await client.updateProduct(endpoint, token, suriPayload);
        return { action: "product_updated", productId: product.id, storeId, sentPayload: suriPayload };
      }
      throw createErr;
    }
  } catch (err) {
    // Anexa o payload enviado ao erro — quem chama (ex: logChatbotProductSync)
    // usa isso pra registrar exatamente o que foi mandado à Suri, mesmo em falha.
    err.suriPayload = suriPayload;
    throw err;
  }
}

export async function deactivateProduct(endpoint, token, productId) {
  try {
    await client.deactivateProduct(endpoint, token, productId);
    return { action: "product_deactivated", productId };
  } catch (err) {
    if (err.message.includes("404")) return { action: "product_not_found_in_suri", productId };
    throw err;
  }
}