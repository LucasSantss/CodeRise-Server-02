/**
 * api/_lib/poll-catalog.js
 * Sincronização incremental (polling) de catálogo, usada por plataformas de
 * e-commerce que não têm nenhuma API de webhooks — hoje só a MaxData (ver
 * ecommerce/maxdata/index.js).
 *
 * Estratégia "listagem leve + detalhe sob demanda":
 *   1. Pagina o catálogo inteiro com uma listagem leve (sem `sincronizacao=true`
 *      na MaxData, que traz imagens/lotes/multiloja/embalagens e deixa a
 *      resposta bem maior — não precisamos disso só pra detectar mudança).
 *   2. Calcula um hash curto por produto a partir dos campos que a Suri
 *      realmente precisa saber quando mudam (nome, preço, promoção, estoque,
 *      status, categoria).
 *   3. Compara com o cache de hashes salvo da rodada anterior
 *      (user_integrations.catalog_polling.productHashes) — só os produtos
 *      que mudaram (ou são novos) disparam uma busca de detalhe completo +
 *      push pra Suri. Produtos que sumiram da listagem (ex: usaEcommerce
 *      virou false, ou foram excluídos) são desativados na Suri.
 *
 * O primeiro poll depois de ativado sempre sincroniza tudo (cache vazio =
 * todo produto conta como "mudou"), igual a uma sincronização completa.
 * A partir do segundo poll, só o que de fato mudou é reenviado.
 */
import crypto from "crypto";
import pool from "./db.js";
import { notifyAdminIntegrationError } from "./error-webhook.js";

// Plataformas sem nenhuma API de webhooks — únicas elegíveis pro polling
// incremental. Reaproveitado pelo cron (cron-sync-stores.js) e pelo front-end.
export const NO_WEBHOOK_PLATFORMS = ["maxdata"];

const HASH_LEN = 12; // caracteres hex — suficiente pra detectar mudança, mantém o cache compacto

function lightHash(fields) {
  return crypto.createHash("sha1").update(JSON.stringify(fields)).digest("hex").slice(0, HASH_LEN);
}

async function runConcurrent(items, fn, concurrency = 6) {
  const chunks = [];
  for (let i = 0; i < items.length; i += concurrency) chunks.push(items.slice(i, i + concurrency));
  for (const chunk of chunks) await Promise.all(chunk.map(fn));
}

/**
 * Resolve os adaptadores de listagem leve + detalhe completo pra cada
 * plataforma sem webhook. Hoje só a MaxData — novas plataformas sem
 * webhook entram aqui seguindo o mesmo formato.
 */
async function resolvePollingAdapters(platform, ecommerceConfig) {
  switch (platform) {
    case "maxdata": {
      const client = await import("./ecommerce/maxdata/client.js");
      const { fetchAndNormalizeProduct } = await import("./ecommerce/maxdata/products.js");
      const { api_url, emp_id, terminal, tabela_preco_id } = ecommerceConfig;
      return {
        storeKeyValid: !!api_url && !!emp_id && !!terminal,
        // Listagem leve — sem sincronizacao=true (não traz imagens/lotes/
        // multiloja/embalagens, só os campos abaixo usados no hash).
        listLightProducts: (page) => client.listProducts(api_url, emp_id, terminal, {
          page, limit: 100, ecommerce: true,
          ...(tabela_preco_id ? { tabelaPrecoId: tabela_preco_id } : {}),
        }).then(r => Array.isArray(r) ? r : (r.docs || [])),
        idOf: (p) => String(p.id),
        hashOf: (p) => lightHash({
          n: p.descricao ?? p.descPdv ?? "",
          v: p.valorVenda ?? 0,
          pr: p.valorPromocao ?? 0,
          e: p.estoque ?? 0,
          d: p.desativado ?? false,
          g: p.grupoId ?? null,
        }),
        fetchAndNormalizeProduct: (id) => fetchAndNormalizeProduct({ api_url, emp_id, terminal }, id),
      };
    }
    default:
      return null;
  }
}

async function notifyPollFailure(row, platform, message) {
  let userName = row.user_id ? `ID ${row.user_id}` : "desconhecido";
  try {
    const uRow = await pool.query("SELECT name FROM users WHERE id = $1", [row.user_id]);
    if (uRow.rows[0]) userName = uRow.rows[0].name;
  } catch { /* mantém o fallback */ }
  try {
    if (row.user_id) {
      await pool.query(
        "INSERT INTO notifications (type, title, message, target_role, target_user_id) VALUES ('error', $1, $2, 'user', $3)",
        [`Sincronização incremental com falhas — ${platform}`, message, row.user_id]
      );
    }
    await notifyAdminIntegrationError(`Sincronização incremental com falhas — ${platform}`, `Perfil: ${userName}\n${message}`, {
      platform, userId: row.user_id || null, userName, errorMessage: message,
    });
  } catch { /* notificação é best-effort — não pode quebrar o polling */ }
}

/**
 * Executa uma rodada de polling incremental para uma linha de integração.
 *
 * @param {object} row - linha de user_integrations (precisa de: user_id,
 *   ecommerce_platform, ecommerce_config, chatbot_config, suri_endpoint,
 *   suri_token, catalog_polling)
 * @returns {{ at, success, message, changed, deactivated, errors, productHashes }}
 *   O caller é responsável por persistir productHashes de volta em
 *   catalog_polling (ver runDuePolling em cron-sync-stores.js).
 */
export async function pollCatalogForIntegrationRow(row) {
  const platform = row.ecommerce_platform;
  const ecommerceConfig = row.ecommerce_config || {};
  const chatbotCfg = row.chatbot_config || {};
  const suriEndpoint = chatbotCfg.endpoint || row.suri_endpoint || null;
  const suriToken    = chatbotCfg.token    || row.suri_token    || null;
  const prevHashes = row.catalog_polling?.productHashes || {};

  const fail = async (message, notify = true) => {
    if (notify) await notifyPollFailure(row, platform, message);
    return { at: new Date().toISOString(), success: false, message, changed: 0, deactivated: 0, errors: 1, productHashes: prevHashes };
  };

  if (!platform || !NO_WEBHOOK_PLATFORMS.includes(platform)) {
    return fail(`Polling incremental não disponível para "${platform || "(nenhuma plataforma)"}".`, false);
  }
  if (!suriEndpoint || !suriToken) {
    return fail("Chatbot (Suri) não configurado.");
  }

  const adapters = await resolvePollingAdapters(platform, ecommerceConfig);
  if (!adapters || !adapters.storeKeyValid) {
    return fail("E-commerce não configurado corretamente — credenciais ausentes.");
  }

  try {
    const { syncProduct, deactivateProduct } = await import("./chatbot/suri/products.js");
    const { listCategories } = await import("./chatbot/suri/categories.js");

    let resolvedStoreId = null;
    try {
      const mappings = ecommerceConfig._store_mappings ? JSON.parse(ecommerceConfig._store_mappings) : [];
      const storeKeyForMapping = ecommerceConfig.store_id || ecommerceConfig.api_url || "";
      const match = mappings.find(m => String(m.ecommerceStoreId) === String(storeKeyForMapping));
      if (match) resolvedStoreId = String(match.chatbotStoreId);
    } catch { /* sem mapeamento */ }

    // 1. Varre a listagem leve inteira, calculando hash por produto
    const seenIds = new Set();
    const newHashes = {};
    const changedIds = [];
    let page = 1, hasMore = true;
    while (hasMore) {
      let batch;
      try {
        batch = await adapters.listLightProducts(page);
      } catch (err) {
        throw new Error(`Falha ao buscar página ${page} da listagem leve: ${err.message}`);
      }
      if (!Array.isArray(batch) || batch.length === 0) { hasMore = false; break; }

      for (const p of batch) {
        const id = adapters.idOf(p);
        const hash = adapters.hashOf(p);
        seenIds.add(id);
        newHashes[id] = hash;
        if (prevHashes[id] !== hash) changedIds.push(id);
      }

      hasMore = batch.length >= 100;
      page++;
      if (page > 500) break; // proteção contra loop infinito
    }

    // 2. IDs que existiam no cache anterior e não apareceram mais → desativa na Suri
    const removedIds = Object.keys(prevHashes).filter(id => !seenIds.has(id));

    if (changedIds.length === 0 && removedIds.length === 0) {
      return { at: new Date().toISOString(), success: true, message: "Nenhuma mudança detectada.", changed: 0, deactivated: 0, errors: 0, productHashes: newHashes };
    }

    // 3. Categorias — reaproveita o mapa da Suri (externalId → id interno);
    // sem mapa disponível, syncProduct manda categoryId null em vez do ID
    // externo (evitando rejeição por categoria de outra plataforma).
    const categoryIdMap = new Map();
    try {
      const suriCats = await listCategories(suriEndpoint, suriToken);
      for (const c of suriCats) {
        const suriId = String(c.id);
        if (c.externalId) categoryIdMap.set(String(c.externalId), suriId);
        categoryIdMap.set(suriId, suriId);
      }
    } catch { /* segue sem mapa */ }

    let errors = 0;
    const errorDetails = [];

    // 4. Produtos novos/alterados: busca detalhe completo + push pra Suri
    await runConcurrent(changedIds, async (id) => {
      try {
        const product = await adapters.fetchAndNormalizeProduct(id);
        await syncProduct(suriEndpoint, suriToken, product, resolvedStoreId, categoryIdMap.size > 0 ? categoryIdMap : null);
      } catch (err) {
        errors++;
        errorDetails.push({ id, message: err.message });
      }
    }, 6);

    // 5. Produtos que sumiram da listagem: desativa na Suri (404 lá é ok — ignorado por deactivateProduct)
    await runConcurrent(removedIds, async (id) => {
      try {
        await deactivateProduct(suriEndpoint, suriToken, id);
      } catch (err) {
        errors++;
        errorDetails.push({ id, message: err.message });
      }
    }, 6);

    const success = errors === 0;
    const message = `${changedIds.length} produto(s) atualizado(s), ${removedIds.length} desativado(s)${errors > 0 ? `, ${errors} erro(s)` : ""}.`;

    if (errors > 0) {
      await notifyPollFailure(row, platform, `${message}\nDetalhes: ${JSON.stringify(errorDetails).slice(0, 500)}`);
    }

    return { at: new Date().toISOString(), success, message, changed: changedIds.length, deactivated: removedIds.length, errors, productHashes: newHashes };
  } catch (err) {
    return fail(`Falha no polling: ${err?.message || "erro inesperado"}`);
  }
}
