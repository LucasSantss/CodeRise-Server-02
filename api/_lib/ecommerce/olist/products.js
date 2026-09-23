/**
 * ecommerce/olist/products.js
 * Busca o produto completo via API da Olist pelo ID recebido no webhook,
 * e normaliza para o formato interno do CodeRise.
 *
 * FLUXO CORRETO:
 * Webhook traz ID → buscamos o produto completo na API → normalizamos → enviamos à Suri
 */

import * as client from "./client.js";
import { UNCATEGORIZED_ID } from "./categories.js";

// A Olist retorna image_url como URL protocol-relative (ex: "//cdn.vnda.com.br/...");
// sem o "https:" na frente, alguns consumidores da Suri não resolvem a imagem.
// Além disso, a imagem de variante costuma vir com um path de redimensionamento
// (ex: "/x120/") que serve uma versão em baixa resolução — removemos esse
// segmento pra usar a imagem original em tamanho completo.
function toAbsoluteUrl(url) {
  if (!url) return null;
  const fullRes = url.replace(/(cdn\.vnda\.com\.br)\/x\d+\//, "$1/");
  return fullRes.startsWith("//") ? `https:${fullRes}` : fullRes;
}

// A Olist retorna cada item de "variants" embrulhado num objeto cuja única
// chave é o id da variante: { "5117": { id: 5117, sku: "...", quantity: 4, ... } }.
// Sem desembrulhar, v.sku/v.quantity/v.properties etc. ficam todos undefined
// e caem nos fallbacks do produto (mesmo SKU pra todas as variantes, estoque
// sempre 0, sem atributos). Também aceita o formato já plano, caso algum
// endpoint (ex: /products/{id}/variants) retorne direto.
function unwrapVariant(entry) {
  if (!entry || typeof entry !== "object") return entry;
  if ("id" in entry) return entry;
  const values = Object.values(entry);
  return values.length === 1 ? values[0] : entry;
}

// ─── Descrição: padroniza o texto da Olist em HTML pra Suri ──────────────────
// A Olist retorna plain_description como texto plano com headers fixos
// (Descrição/Medidas/Diferenciais de impacto, seguido da versão em inglês
// depois de uma linha "[idioma]" com os mesmos headers traduzidos). A Suri
// aceita HTML no campo description e é assim que a loja exibe corretamente.
const PT_DESC_HEADERS = { title: "Descrição", measures: "Medidas", impact: "Diferenciais de impacto", more: "Saiba mais:" };
const EN_DESC_HEADERS = { title: "Description", measures: "Sizing", impact: "Impact differences", more: "Find out more:" };

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderDescImpactLine(line) {
  const pipeIdx = line.indexOf(" | ");
  if (pipeIdx !== -1) {
    const before = escapeHtml(line.slice(0, pipeIdx));
    const after = escapeHtml(line.slice(pipeIdx + 3));
    return `<li><strong>${before}</strong> | ${after}</li>`;
  }
  // Linhas em caixa alta (certificações, ex: "FEITO NO BRASIL") ficam em negrito;
  // o restante (frases normais) fica sem formatação.
  if (line === line.toUpperCase()) return `<li><strong>${escapeHtml(line)}</strong></li>`;
  return `<li>${escapeHtml(line)}</li>`;
}

function renderDescMeasuresBlock(lines) {
  if (lines.length <= 1) return `<p>${escapeHtml(lines[0] || "")}</p>`;
  const items = lines.map(line => {
    const m = line.match(/^(\S{1,4})\s*([-:])\s*(.*)$/);
    if (m) return `<li><strong>${escapeHtml(m[1])}</strong> ${m[2]} ${escapeHtml(m[3])}</li>`;
    return `<li>${escapeHtml(line)}</li>`;
  });
  return `<ul>\n    ${items.join("\n    ")}\n  </ul>`;
}

function renderDescTitleBlock(lines, compositionLabel) {
  return lines.map(line => {
    if (/^OBS:/i.test(line)) return `<p><em>${escapeHtml(line)}</em></p>`;
    if (line.toLowerCase().startsWith(`${compositionLabel.toLowerCase()}:`)) {
      const rest = line.slice(line.indexOf(":") + 1).trim();
      return `<p><strong>${compositionLabel}:</strong> ${escapeHtml(rest)}</p>`;
    }
    return `<p>${escapeHtml(line)}</p>`;
  }).join("\n  ");
}

function parseDescLanguageBlock(lines, headers) {
  const idx = {};
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === headers.title) idx.title = i;
    else if (t === headers.measures) idx.measures = i;
    else if (t === headers.impact) idx.impact = i;
    else if (t === headers.more) idx.more = i;
  });
  // "Diferenciais de impacto"/"Impact differences" é o único header que
  // aparece em todo produto — tratamos como obrigatório pra reconhecer o
  // texto. "Medidas"/"Sizing" nem sempre existe (acessórios como cintos e
  // colares não têm), e o bloco em inglês às vezes nem repete o header
  // "Description" antes do parágrafo — por isso ambos são opcionais.
  if (idx.impact == null) return null;

  const titleStart     = idx.title != null ? idx.title + 1 : 0;
  const titleEnd       = idx.measures != null ? idx.measures : idx.impact;
  const titleLines     = lines.slice(titleStart, titleEnd).map(l => l.trim()).filter(Boolean);
  const measuresLines  = idx.measures != null ? lines.slice(idx.measures + 1, idx.impact).map(l => l.trim()).filter(Boolean) : null;
  const impactEnd      = idx.more != null ? idx.more : lines.length;
  const impactLines    = lines.slice(idx.impact + 1, impactEnd).map(l => l.trim()).filter(Boolean);
  const urlLine         = idx.more != null ? (lines.slice(idx.more + 1).map(l => l.trim()).find(Boolean) || "") : "";
  const compositionLabel = headers.title === "Descrição" ? "Composição" : "Composition";

  const html = [
    `  <h2>${headers.title}</h2>`,
    `  ${renderDescTitleBlock(titleLines, compositionLabel)}`,
  ];
  if (measuresLines) {
    html.push(`  <h2>${headers.measures}</h2>`, `  ${renderDescMeasuresBlock(measuresLines)}`);
  }
  html.push(
    `  <h2>${headers.impact}</h2>`,
    `  <ul>\n    ${impactLines.map(renderDescImpactLine).join("\n    ")}\n  </ul>`,
  );
  if (urlLine) {
    html.push(`  <p>${headers.more} <a href="${escapeHtml(urlLine)}" target="_blank" rel="noopener">${escapeHtml(urlLine)}</a></p>`);
  }
  return html.join("\n");
}

function buildDescriptionHtml(rawText) {
  if (!rawText) return "";
  const lines = String(rawText).replace(/\r\n/g, "\n").split("\n");
  const langIdx = lines.findIndex(l => l.trim() === "[idioma]");
  const ptLines = langIdx === -1 ? lines : lines.slice(0, langIdx);
  const enLines = langIdx === -1 ? [] : lines.slice(langIdx + 1);

  const ptBody = parseDescLanguageBlock(ptLines, PT_DESC_HEADERS);
  // Texto não bate com o template esperado — não tenta adivinhar a
  // estrutura, só envolve o texto puro em parágrafos.
  if (!ptBody) {
    const paragraphs = lines.map(l => l.trim()).filter(Boolean).map(l => `<p>${escapeHtml(l)}</p>`).join("\n");
    return `<div class="descricao-produto">\n${paragraphs}\n</div>`;
  }

  const enBody = parseDescLanguageBlock(enLines, EN_DESC_HEADERS);
  const parts = [`<div class="descricao-produto">\n${ptBody}\n</div>`];
  if (enBody) parts.push(`<div class="product-description" lang="en">\n${enBody}\n</div>`);
  return parts.join("\n\n");
}

/**
 * Busca o produto completo na API da Olist com variantes sempre atualizadas
 * (formato bruto da Olist, não normalizado).
 *
 * GET /products/{id} devolve as variantes num sub-objeto que às vezes fica
 * defasado (preço/estoque zerados) em relação ao estado real — observado em
 * produtos recém-criados/em edição, onde o webhook de estoque ou preço chega
 * antes do detalhe do produto refletir o valor atual. GET /products/{id}/variants
 * é a fonte correta pra isso, então sempre sobrescrevemos p.variants com o
 * retorno desse endpoint quando disponível.
 */
export async function fetchFullProductRaw(config, productId) {
  const { store_url, access_token } = config;

  const [p, variantsFromApi] = await Promise.all([
    client.getProduct(store_url, access_token, productId),
    client.getProductVariants(store_url, access_token, productId).catch(() => null),
  ]);

  if (Array.isArray(variantsFromApi) && variantsFromApi.length > 0) {
    p.variants = variantsFromApi;
  }

  return p;
}

/**
 * Busca o produto completo na API da Olist e normaliza.
 * Garante dados sempre atualizados, independente do que veio no webhook.
 */
export async function fetchAndNormalizeProduct(config, productId) {
  const p = await fetchFullProductRaw(config, productId);
  return normalizeProduct(p);
}

/**
 * Normaliza um produto da API da Olist para o formato interno do CodeRise.
 *
 * Estrutura típica da Olist:
 *   p.id, p.name, p.description, p.reference (sku do produto pai),
 *   p.available, p.price, p.promotional_price,
 *   p.category_tags (array de { name, tag_type, title }),
 *   p.images (array de { url }),
 *   p.variants (array de variantes)
 *
 * Variante:
 *   v.sku, v.price, v.sale_price, v.quantity/v.stock (estoque),
 *   v.weight, v.height, v.width, v.length, v.image_url,
 *   v.properties (objeto { property1: { name, value }, property2: {...}, ... } — não é array)
 */
export function normalizeProduct(p) {
  const productImages = p.images || [];

  // GET /products (listagem, usada na sincronização em lote) não retorna o
  // array "images" — só um "image_url" único no nível do produto. GET
  // /products/{id} (detalhe, usado no fluxo de webhook) retorna o array
  // completo. Usamos p.image_url como fallback para não perder a imagem
  // quando o produto vem da listagem.
  const fallbackImageUrl = toAbsoluteUrl(p.image_url);

  const variants = (p.variants || []).map(unwrapVariant).map(v => {
    const rawSku = v.sku != null ? String(v.sku).trim() : "";
    const safeSku = rawSku && rawSku !== "null" && rawSku !== "undefined"
      ? rawSku
      : String(p.id);

    // Imagem da variante: usa v.image_url quando presente; senão procura em
    // p.images a imagem cujo variant_ids referencia o id desta variante.
    const linkedImage = productImages.find(img => (img.variant_ids || []).some(id => String(id) === String(v.id)));

    return {
      sku: safeSku,
      price: parseFloat(v.price || p.price || 0),
      promotionalPrice: parseFloat(v.sale_price || v.promotional_price || p.promotional_price || 0),
      // A Suri exige weightInGrams como inteiro. A Olist retorna "weight" em
      // quilos (ex: 0.5, 0.2) — convertemos pra gramas e arredondamos, senão
      // a Suri rejeita o produto inteiro com HTTP 400 (Input string '0.2' is
      // not a valid integer).
      weightInGrams: Math.round(v.weight_g != null ? parseFloat(v.weight_g) : parseFloat(v.weight || 0) * 1000),
      dimensions: {
        heightInCm: parseFloat(v.height || v.height_cm || 0),
        widthInCm:  parseFloat(v.width  || v.width_cm  || 0),
        lengthInCm: parseFloat(v.length || v.length_cm || 0),
      },
      // A Olist retorna "properties" como objeto ({ property1: {...}, property2: {...} }),
      // não array — Object.values normaliza ambos os formatos com segurança.
      stock: parseInt(v.quantity ?? v.stock ?? 0),
      attributes: Object.values(v.properties || {}).map(prop => ({
        name:  String(prop.name  || ""),
        value: String(prop.value || ""),
      })),
      imageUrl: toAbsoluteUrl(v.image_url || linkedImage?.url) || fallbackImageUrl,
    };
  });

  const firstVariant = variants[0] || {};

  // Categoria: pega a primeira tag do tipo "categoria". Tags de outros tipos
  // (estampa, coleção, etc.) nunca são sincronizadas como categoria na Suri,
  // então usá-las aqui causaria "Category with id X not found".
  // Sem tag de categoria (ex: Gift Cards) → usa a categoria "Sem categoria".
  const productTags = p.category_tags || p.tags || [];
  const categoryTag = productTags.find(t => String(t.tag_type || "").toLowerCase() === "categoria");
  const categoryId = categoryTag ? String(categoryTag.name || "") : UNCATEGORIZED_ID;

  return {
    id: String(p.id),
    sku: firstVariant.sku || p.reference || String(p.id),
    name: p.name || "",
    description: buildDescriptionHtml(p.plain_description || p.description || ""),
    categoryId,
    brand: p.brand || null,
    // "available" é o nome do campo na API REST (GET /products/{id}, usada na
    // sincronização completa); o payload de webhook (product-changed) traz o
    // mesmo dado como "active" — sem checar os dois, o atalho do webhook
    // (normalizeWebhookProduct, que processa o payload direto sem refetch)
    // sempre lia undefined e marcava o produto como inativo por engano.
    isActive: p.available === true || p.available === "true" || p.active === true || p.active === "true",
    price: firstVariant.price || parseFloat(p.price || 0),
    promotionalPrice: firstVariant.promotionalPrice || parseFloat(p.promotional_price || 0),
    url: p.url || null,
    images: productImages.length > 0
      ? productImages.map(i => ({
          url:         toAbsoluteUrl(i.url || i.src) || "",
          description: i.alt  || null,
        }))
      : (fallbackImageUrl ? [{ url: fallbackImageUrl, description: null }] : []),
    weightInGrams: firstVariant.weightInGrams || 0,
    dimensions:    firstVariant.dimensions   || { heightInCm: 0, widthInCm: 0, lengthInCm: 0 },
    stock:         firstVariant.stock        || 0,
    variants,
  };
}

/**
 * Normaliza o payload bruto do webhook de produto da Olist.
 * A Olist envia apenas o ID no webhook; sempre sinaliza needsApiFetch:true.
 */
export function normalizeWebhookProduct(payload) {
  const p = payload.product || payload;
  if (p.variants && p.name) return { fromWebhook: true, product: normalizeProduct(p) };
  return { fromWebhook: false, productId: String(p.id || payload.id || "") };
}

/**
 * Localiza o produto na Olist pela referência (reference — SKU do produto
 * pai) e/ou pelo SKU da variante. Os webhooks de estoque/preço
 * (stocks-changed/prices-changed) só trazem { sku, reference } por item, não
 * o ID do produto — precisamos desse lookup pra chegar no produto completo
 * antes de sincronizar. Só inclui na query os parâmetros que de fato vieram
 * preenchidos, pra não mandar filtros como "sku=undefined" pra API.
 *
 * Confirma reference/sku do resultado antes de retornar: se o filtro da API
 * não for suportado e a Olist ignorar o parâmetro, listProducts devolveria
 * a primeira página do catálogo inteiro — sem essa checagem, arriscaríamos
 * sincronizar o produto errado na Suri.
 */
export async function findProductByReference(storeUrl, accessToken, reference, sku) {
  if (!reference && !sku) return null;

  // Estratégia primária: GET /variants/{sku} — busca direta e exata pela
  // variante (mesmo endpoint usado por stock.js/orders.js), muito mais
  // confiável do que filtrar /products, já que a Olist nem sempre respeita
  // os parâmetros de filtro (reference/sku) nesse endpoint — quando ignora,
  // devolve a primeira página do catálogo inteiro e o produto certo nunca
  // bate no .find() abaixo, gerando falso "not_found_in_olist".
  if (sku) {
    try {
      const variant = await client.getVariantBySku(storeUrl, accessToken, sku);
      const productId = variant?.product_id ?? variant?.product?.id ?? variant?.productId ?? null;
      if (productId) return { id: String(productId), reference: variant?.product?.reference ?? reference ?? null, sku: variant?.sku ?? sku };
    } catch {}
  }

  // Fallback: filtro em /products por reference/sku.
  const params = { per_page: 5 };
  if (reference) params.reference = reference;
  if (sku) params.sku = sku;
  const batch = await client.listProducts(storeUrl, accessToken, params).catch(() => null);
  const list = Array.isArray(batch) ? batch : [];
  return list.find(p =>
    (reference && String(p.reference || "") === String(reference)) ||
    (sku && String(p.sku || "") === String(sku))
  ) || null;
}
