import pool from "./db.js";
import { requireAuth } from "../_auth.js";
import { notifyAdminIntegrationError } from "./error-webhook.js";

const SUPPORTED_PLATFORMS = ["nuvemshop", "olist", "shopify", "woocommerce", "tray", "vtex", "maxdata"];

async function notifySyncFailure(row, platform, message, extra = {}) {
  let userName = row.user_id ? `ID ${row.user_id}` : "desconhecido";
  try {
    const uRow = await pool.query("SELECT name FROM users WHERE id = $1", [row.user_id]);
    if (uRow.rows[0]) userName = uRow.rows[0].name;
  } catch { /* mantém o fallback */ }

  const title = `Sincronização com falhas — ${platform || "integração"}`;
  const detailLines = [
    `Loja Suri: #${extra.resolvedStoreId || "—"}`,
    "",
    `Motivo: ${message}`,
  ];

  if (extra.summary) {
    detailLines.push(
      "",
      `Categorias criadas: ${extra.summary.categories_created}`,
      `Categorias atualizadas: ${extra.summary.categories_updated}`,
      `Produtos criados: ${extra.summary.products_created}`,
      `Produtos atualizados: ${extra.summary.products_updated}`,
      `Erros: ${extra.summary.errors}`,
    );
  }

  const notificationMessage = detailLines.join("\n");

  try {
    if (row.user_id) {
      await pool.query(
        "INSERT INTO notifications (type, title, message, target_role, target_user_id) VALUES ('error', $1, $2, 'user', $3)",
        [title, notificationMessage, row.user_id]
      );
    }

    await notifyAdminIntegrationError(title, `Perfil: ${userName}\n${notificationMessage}`, {
      platform,
      storeId: extra.resolvedStoreId || null,
      userId: row.user_id || null,
      userName,
      summary: extra.summary || null,
      errorMessage: message,
    });
  } catch { /* notificação é best-effort — não pode quebrar a sincronização */ }
}

/**
 * Cada plataforma tem uma assinatura de credenciais diferente.
 * Esta função resolve os adaptadores corretos (listProducts, getVariants,
 * normalizeProduct, fetchCategories) para a plataforma configurada.
 */
async function resolvePlatformAdapters(platform, ecommerceConfig) {
  switch (platform) {
    case "nuvemshop": {
      const client = await import("./ecommerce/nuvemshop/client.js");
      const { normalizeProduct } = await import("./ecommerce/nuvemshop/products.js");
      const { fetchCategories } = await import("./ecommerce/nuvemshop/categories.js");
      const { store_id, access_token } = ecommerceConfig;
      return {
        listProductsFn: (params) => client.listProducts(store_id, access_token, params),
        getVariantsFn: (productId) => client.getProductVariants(store_id, access_token, productId),
        normalizeProduct,
        fetchCategories: () => fetchCategories({ store_id, access_token }),
        storeKeyValid: !!store_id && !!access_token,
      };
    }
    case "olist": {
      const client = await import("./ecommerce/olist/client.js");
      const { normalizeProduct } = await import("./ecommerce/olist/products.js");
      const { fetchCategories } = await import("./ecommerce/olist/categories.js");
      const { store_url, access_token } = ecommerceConfig;
      return {
        listProductsFn: (params) => client.listProducts(store_url, access_token, params),
        // normalizeProduct usa apenas p.variants/p.images (já vêm no GET /products) —
        // buscar /products/{id}/variants por produto aqui seria uma chamada extra
        // descartada, e dobra a carga na API contribuindo para rate limit (HTTP 429).
        getVariantsFn: null,
        normalizeProduct,
        fetchCategories: () => fetchCategories({ store_url, access_token }),
        storeKeyValid: !!store_url && !!access_token,
      };
    }
    case "shopify": {
      const client = await import("./ecommerce/shopify/client.js");
      const { normalizeProduct } = await import("./ecommerce/shopify/products.js");
      const { fetchCategories } = await import("./ecommerce/shopify/categories.js");
      const { store_url, api_token, api_version } = ecommerceConfig;
      return {
        listProductsFn: (params) => client.listProducts(store_url, api_token, params, api_version),
        getVariantsFn: null, // Shopify já retorna variantes dentro do próprio produto
        normalizeProduct: (raw) => normalizeProduct(raw, store_url),
        fetchCategories: () => fetchCategories({ store_url, api_token, api_version }),
        storeKeyValid: !!store_url && !!api_token,
      };
    }
    case "woocommerce": {
      const client = await import("./ecommerce/woocommerce/client.js");
      const { normalizeProduct } = await import("./ecommerce/woocommerce/products.js");
      const { fetchCategories } = await import("./ecommerce/woocommerce/categories.js");
      const { site_url, consumer_key, consumer_secret } = ecommerceConfig;
      return {
        listProductsFn: (params) => client.listProducts(site_url, consumer_key, consumer_secret, params),
        getVariantsFn: async (productId) => {
          // WooCommerce só tem variações para produtos do tipo "variable" — buscamos sob demanda
          try {
            return await client.getProductVariations(site_url, consumer_key, consumer_secret, productId, { per_page: 100 });
          } catch { return []; }
        },
        normalizeProduct: (raw, variants) => normalizeProduct(raw, variants || []),
        fetchCategories: () => fetchCategories({ site_url, consumer_key, consumer_secret }),
        storeKeyValid: !!site_url && !!consumer_key && !!consumer_secret,
      };
    }
    case "tray": {
      const client = await import("./ecommerce/tray/client.js");
      const { normalizeProduct } = await import("./ecommerce/tray/products.js");
      const { fetchCategories } = await import("./ecommerce/tray/categories.js");
      const { api_address, access_token } = ecommerceConfig;
      return {
        listProductsFn: async (params) => {
          const data = await client.listProducts(api_address, access_token, params);
          const items = data.Products || data.products || [];
          return items.map(i => i.Product || i);
        },
        getVariantsFn: (productId) => client.getProductVariants(api_address, access_token, productId).catch(() => []),
        normalizeProduct: (raw, variants) => normalizeProduct({ ...raw, Variants: variants || raw.Variants }),
        fetchCategories: () => fetchCategories({ api_address, access_token }),
        storeKeyValid: !!api_address && !!access_token,
      };
    }
    case "vtex": {
      const client = await import("./ecommerce/vtex/client.js");
      const { normalizeProduct } = await import("./ecommerce/vtex/products.js");
      const { fetchCategories } = await import("./ecommerce/vtex/categories.js");
      const { account_name, app_key, app_token } = ecommerceConfig;
      return {
        // VTEX não tem listagem paginada simples de produtos por padrão REST —
        // usamos a árvore de SKUs como fallback simplificado de IDs.
        listProductsFn: async () => [],
        getVariantsFn: null,
        normalizeProduct,
        fetchCategories: () => fetchCategories({ account_name, app_key, app_token }),
        storeKeyValid: !!account_name && !!app_key && !!app_token,
      };
    }
    case "maxdata": {
      const client = await import("./ecommerce/maxdata/client.js");
      const { normalizeProduct } = await import("./ecommerce/maxdata/products.js");
      const { fetchCategories } = await import("./ecommerce/maxdata/categories.js");
      const { api_url, emp_id, terminal, tabela_preco_id } = ecommerceConfig;
      return {
        // ecommerce=true traz só produtos marcados pro e-commerce;
        // sincronizacao=true traz os dados completos (imagens, lotes, código
        // de barras, estoque multiloja) — ver resumo da API no cadastro da integração.
        listProductsFn: (params) => client.listProducts(api_url, emp_id, terminal, {
          page: params.page,
          limit: params.limit || params.per_page || 50,
          ecommerce: true,
          sincronizacao: true,
          ...(tabela_preco_id ? { tabelaPrecoId: tabela_preco_id } : {}),
        }).then(r => Array.isArray(r) ? r : (r.docs || [])),
        getVariantsFn: null, // MaxData não tem variantes (cor/tamanho)
        normalizeProduct,
        fetchCategories: () => fetchCategories({ api_url, emp_id, terminal }),
        storeKeyValid: !!api_url && !!emp_id && !!terminal,
      };
    }
    default:
      return null;
  }
}

// Lógica de sincronização pura, reaproveitada tanto pelo endpoint manual (handleSyncCatalog)
// quanto pelo endpoint de agendamento (cron-sync-stores.js).
export async function syncCatalogForIntegrationRow(row) {
  const platform = row.ecommerce_platform;
  const ecommerceConfig = row.ecommerce_config || {};
  const chatbotCfg = row.chatbot_config || {};
  const suriEndpoint = chatbotCfg.endpoint || row.suri_endpoint || null;
  const suriToken    = chatbotCfg.token    || row.suri_token    || null;
  let resolvedStoreId = null;
  let allResults = [];

  const emptySummary = {
    categories_created: 0,
    categories_updated: 0,
    products_created: 0,
    products_updated: 0,
    errors: 1,
  };

  try {
    if (!platform || !SUPPORTED_PLATFORMS.includes(platform)) {
      const message = `Sincronização ainda não disponível para ${platform || "(nenhuma plataforma)"}.`;
      await notifySyncFailure(row, platform, message, { resolvedStoreId, summary: emptySummary });
      return { success: false, message, summary: emptySummary, results: [{ type: "error", entity: "sync", message }], resolvedStoreId, platform };
    }
    if (!suriEndpoint || !suriToken) {
      const message = "Chatbot (Suri) não configurado.";
      await notifySyncFailure(row, platform, message, { resolvedStoreId, summary: emptySummary });
      return { success: false, message, summary: emptySummary, results: [{ type: "error", entity: "sync", message }], resolvedStoreId, platform };
    }

    const adapters = await resolvePlatformAdapters(platform, ecommerceConfig);
    if (!adapters) {
      const message = `Sincronização ainda não disponível para ${platform}.`;
      await notifySyncFailure(row, platform, message, { resolvedStoreId, summary: emptySummary });
      return { success: false, message, summary: emptySummary, results: [{ type: "error", entity: "sync", message }], resolvedStoreId, platform };
    }
    if (!adapters.storeKeyValid) {
      const message = "E-commerce não configurado corretamente — credenciais ausentes.";
      await notifySyncFailure(row, platform, message, { resolvedStoreId, summary: emptySummary });
      return { success: false, message, summary: emptySummary, results: [{ type: "error", entity: "sync", message }], resolvedStoreId, platform };
    }
    if (platform === "vtex") {
      const message = "Sincronização em lote da VTEX ainda não disponível — utilize o fluxo de webhooks para sincronização incremental por produto.";
      await notifySyncFailure(row, platform, message, { resolvedStoreId, summary: emptySummary });
      return { success: false, message, summary: emptySummary, results: [{ type: "error", entity: "sync", message }], resolvedStoreId, platform };
    }

    const { syncProduct } = await import("./chatbot/suri/products.js");
    const { syncCategory, listCategories } = await import("./chatbot/suri/categories.js");

    // Resolve store mapping: ecommerce store_id → suri storeId
    try {
      const mappings = ecommerceConfig._store_mappings ? JSON.parse(ecommerceConfig._store_mappings) : [];
      const storeKeyForMapping = ecommerceConfig.store_id || ecommerceConfig.store_url || ecommerceConfig.account_name || "";
      const match = mappings.find(m => String(m.ecommerceStoreId) === String(storeKeyForMapping));
      if (match) resolvedStoreId = String(match.chatbotStoreId);
    } catch { /* sem mapeamento */ }

    allResults = [];
    const categoryIdMap = new Map();

  async function runConcurrent(items, fn, concurrency = 8) {
    const chunks = [];
    for (let i = 0; i < items.length; i += concurrency) chunks.push(items.slice(i, i + concurrency));
    for (const chunk of chunks) await Promise.all(chunk.map(fn));
  }

  // 1. Categorias em paralelo — coleta mapa platform_id → suri_id
  try {
    const cats = await adapters.fetchCategories();
    await runConcurrent(cats, async (cat) => {
      try {
        const r = await syncCategory(suriEndpoint, suriToken, cat, resolvedStoreId);
        const action = r?.action || "category_updated";
        if (r?.suriId) categoryIdMap.set(String(cat.id), String(r.suriId));
        allResults.push({ type: action, entity: "category", id: String(cat.id), name: cat.name, storeId: resolvedStoreId });
      } catch (err) {
        allResults.push({ type: "error", entity: "category", id: String(cat.id), name: cat.name, storeId: resolvedStoreId, message: err.message });
      }
    }, 8);
  } catch (err) {
    allResults.push({ type: "error", entity: "category", message: err.message });
  }

  if (categoryIdMap.size === 0) {
    try {
      const suriCats = await listCategories(suriEndpoint, suriToken);
      for (const c of suriCats) {
        const suriId = String(c.id);
        if (c.externalId) categoryIdMap.set(String(c.externalId), suriId);
        categoryIdMap.set(suriId, suriId);
      }
    } catch { /* ignora */ }
  }

  // 2. Produtos paginados com variantes atualizadas em paralelo por batch
  const allRawProducts = [];
  {
    let page = 1, hasMore = true;
    while (hasMore) {
      let batch;
      try {
        batch = await adapters.listProductsFn({ page, per_page: 50, limit: 50 });
      } catch (err) {
        // Página falhou mesmo após retries (ex: rate limit persistente) — para a
        // paginação aqui, mas preserva os produtos já coletados das páginas anteriores.
        allResults.push({ type: "error", entity: "product", message: `Falha ao buscar página ${page} de produtos: ${err.message}` });
        break;
      }
      if (!Array.isArray(batch) || batch.length === 0) { hasMore = false; break; }

      // DIAGNÓSTICO TEMPORÁRIO: confirma se o endpoint de listagem já retorna
      // images/variants completos (hipótese: pode vir só um resumo, causando
      // produtos sem imagem/variante na Suri). Remover após a investigação.
      if (page === 1) {
        const sample = batch[0] || {};
        console.log(`[sync-catalog][diagnostic] platform=${platform} sample product keys:`, Object.keys(sample));
        console.log(`[sync-catalog][diagnostic] has images=${Array.isArray(sample.images)} count=${sample.images?.length ?? "n/a"}`);
        console.log(`[sync-catalog][diagnostic] has variants=${Array.isArray(sample.variants)} count=${sample.variants?.length ?? "n/a"}`);
        console.log(`[sync-catalog][diagnostic] raw sample:`, JSON.stringify(sample).slice(0, 2000));
      }

      if (adapters.getVariantsFn) {
        // Concorrência limitada: buscar variantes de todo o batch de uma vez
        // (até 50 requisições simultâneas) derruba APIs protegidas por rate limit.
        await runConcurrent(batch, async (p) => {
          try {
            const variants = await adapters.getVariantsFn(p.id || p.Id);
            if (Array.isArray(variants) && variants.length > 0) p._fetchedVariants = variants;
          } catch { /* mantém variants já presentes no produto, se houver */ }
        }, 4);
      }

      for (const raw of batch) allRawProducts.push(raw);
      hasMore = batch.length >= 50;
      page++;
      if (page > 200) break; // proteção contra loop infinito
    }
  }

  // Sincroniza produtos em paralelo (10 por vez)
  await runConcurrent(allRawProducts, async (raw) => {
    try {
      const normalized = adapters.normalizeProduct(raw, raw._fetchedVariants);
      if (normalized.categoryId && !categoryIdMap.has(String(normalized.categoryId))) {
        categoryIdMap.set(String(normalized.categoryId), String(normalized.categoryId));
      }
      const r = await syncProduct(suriEndpoint, suriToken, normalized, resolvedStoreId, categoryIdMap.size > 0 ? categoryIdMap : null);
      const action = r?.action || "product_updated";
      allResults.push({ type: action, entity: "product", id: String(raw.id || raw.Id), name: normalized.name || String(raw.id || raw.Id), storeId: resolvedStoreId });
    } catch (err) {
      const rawName = raw.name ?? raw.Name;
      const nameStr = typeof rawName === 'string' ? rawName : (rawName?.pt || rawName?.es || rawName?.en || Object.values(rawName || {})[0] || String(raw.id || raw.Id));
      allResults.push({ type: "error", entity: "product", id: String(raw.id || raw.Id), name: nameStr, storeId: resolvedStoreId, message: err.message });
    }
  }, 6);

  const summary = {
    categories_created: allResults.filter(r => r.type === "category_created").length,
    categories_updated: allResults.filter(r => r.entity === "category" && r.type !== "error" && r.type !== "category_created").length,
    products_created:   allResults.filter(r => r.type === "product_created").length,
    products_updated:   allResults.filter(r => r.entity === "product" && r.type !== "error" && r.type !== "product_created").length,
    errors:             allResults.filter(r => r.type === "error").length,
  };

  const hasSuccess = (summary.categories_created + summary.categories_updated + summary.products_created + summary.products_updated) > 0;

  // Notifica sobre falhas na sincronização — mesmo padrão usado pra erros de
  // webhook (uma notificação pro usuário dono da integração + uma pro admin).
  // Agrupa tudo numa notificação só por execução, em vez de uma por item, pra
  // não inundar o usuário quando muitos produtos falham na mesma sincronização.
  if (summary.errors > 0) {
    await notifySyncFailure(row, platform, `Sincronização concluída com ${summary.errors} erro(s).`, {
      resolvedStoreId,
      summary,
    });
  }

  return {
    success: hasSuccess,
    message: `Sincronização concluída: ${summary.categories_created + summary.categories_updated} categoria(s), ${summary.products_created + summary.products_updated} produto(s)${summary.errors > 0 ? `, ${summary.errors} erro(s)` : ""}.`,
    summary,
    results: allResults,
    resolvedStoreId,
    platform,
  };
  } catch (err) {
    const message = err?.message || "Erro inesperado ao executar a sincronização.";
    await notifySyncFailure(row, platform, message, { resolvedStoreId, summary: { ...emptySummary, errors: 1 } });
    return {
      success: false,
      message: `Falha na sincronização: ${message}`,
      summary: { ...emptySummary, errors: 1 },
      results: [{ type: "error", entity: "sync", message }],
      resolvedStoreId,
      platform,
    };
  }
}

// Catálogos grandes podem levar minutos pra sincronizar — tempo maior do que
// o proxy da Hostinger deixa uma requisição em aberto (ao contrário da Vercel,
// que tinha maxDuration configurável). Por isso o POST só DISPARA a
// sincronização em segundo plano (o processo do Node aqui é persistente) e
// devolve na hora; o front-end consulta o progresso via GET no mesmo endpoint.
// Estado em memória por usuário — funciona porque é um processo único e
// persistente (não seria seguro em ambiente serverless/múltiplas instâncias).
const syncJobs = new Map();

export async function handleSyncCatalog(req, res) {
  if (req.method === "GET") {
    const caller = await requireAuth(req, res);
    if (!caller) return;
    const job = syncJobs.get(caller.id);
    if (!job) return res.status(200).json({ status: "idle" });
    if (job.status === "running") return res.status(200).json({ status: "running" });
    return res.status(200).json({ status: "done", ...job.result });
  }

  if (req.method !== "POST") { res.setHeader("Allow", ["GET", "POST"]); return res.status(405).end(); }
  const caller = await requireAuth(req, res);
  if (!caller) return;

  const existing = syncJobs.get(caller.id);
  if (existing?.status === "running") return res.status(200).json({ status: "running" });

  const row = await pool.query(
    "SELECT ecommerce_platform, ecommerce_config, chatbot_config, suri_endpoint, suri_token FROM user_integrations WHERE user_id = $1",
    [caller.id]
  ).then(r => r.rows[0]).catch(() => null);

  if (!row) return res.status(404).json({ success: false, message: "Integração não encontrada." });

  row.user_id = caller.id;
  syncJobs.set(caller.id, { status: "running", result: null });
  syncCatalogForIntegrationRow(row)
    .then((result) => syncJobs.set(caller.id, { status: "done", result }))
    .catch((err) => syncJobs.set(caller.id, { status: "done", result: { success: false, message: err.message } }));

  return res.status(200).json({ status: "started" });
}
