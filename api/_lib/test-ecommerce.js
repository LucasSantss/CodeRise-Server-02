/**
 * api/_lib/test-ecommerce.js
 * Testa a conexão com a plataforma de e-commerce configurada pelo usuário.
 */
import pool       from "./db.js";
import { setCors }     from "../_cors.js";
import { requireAuth } from "../_auth.js";
import { notifyAdminIntegrationError } from "./error-webhook.js";

const PLATFORM_LABELS = {
  shopify: "Shopify", woocommerce: "WooCommerce", nuvemshop: "Nuvemshop",
  vtex: "VTEX", tray: "Tray", olist: "Olist Ecommerce", maxdata: "MaxData", custom: "Custom",
};

async function testNuvemshop({ store_id, access_token }) {
  if (!store_id || !access_token)
    throw new Error("store_id e access_token são obrigatórios.");
  const res = await fetch(`https://api.tiendanube.com/v1/${store_id}/store`, {
    headers: { "Authentication": `bearer ${access_token}`, "User-Agent": "CodeRise Integration (suporte@coderise.com.br)", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error(`Token inválido ou sem permissão (HTTP ${res.status}). Verifique o Access Token.`);
  if (res.status === 404) throw new Error(`Loja não encontrada (HTTP 404). Verifique o Store ID "${store_id}".`);
  if (!res.ok) throw new Error(`Nuvemshop retornou HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const storeName = body.name?.pt || body.name?.es || Object.values(body.name || {})[0] || body.business_name || "—";
  return { store: storeName, plan: body.plan_name || null, country: body.country || null };
}

async function testShopify({ store_url, api_token, api_version }) {
  if (!store_url || !api_token) throw new Error("store_url e api_token são obrigatórios.");
  const version = api_version || "2024-01";
  const host = store_url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const res = await fetch(`https://${host}/admin/api/${version}/shop.json`, {
    headers: { "X-Shopify-Access-Token": api_token, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error(`Token inválido ou sem permissão (HTTP ${res.status}).`);
  if (res.status === 404) throw new Error(`Loja não encontrada. Verifique a URL "${store_url}".`);
  if (!res.ok) throw new Error(`Shopify retornou HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const shop = body.shop || {};
  return { store: shop.name || "—", plan: shop.plan_name || null, country: shop.country_name || null };
}

async function testWoocommerce({ site_url, consumer_key, consumer_secret }) {
  if (!site_url || !consumer_key || !consumer_secret) throw new Error("site_url, consumer_key e consumer_secret são obrigatórios.");
  const base = site_url.replace(/\/+$/, "");
  const auth = Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");
  const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
    headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error(`Credenciais inválidas (HTTP ${res.status}). Verifique Consumer Key e Secret.`);
  if (res.status === 404) throw new Error(`URL não encontrada (HTTP 404). Verifique se o WooCommerce está instalado em "${site_url}".`);
  if (!res.ok) throw new Error(`WooCommerce retornou HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const env = body.environment || {};
  return { store: env.site_url || site_url, plan: `WC ${env.version || ""}`.trim(), country: null };
}

async function testVtex({ account_name, app_key, app_token }) {
  if (!account_name || !app_key || !app_token) throw new Error("account_name, app_key e app_token são obrigatórios.");
  const res = await fetch(`https://${account_name}.vtexcommercestable.com.br/api/catalog_system/pub/category/tree/1`, {
    headers: { "X-VTEX-API-AppKey": app_key, "X-VTEX-API-AppToken": app_token, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error(`Credenciais inválidas (HTTP ${res.status}). Verifique App Key e App Token.`);
  if (res.status === 404) throw new Error(`Conta não encontrada. Verifique o Account Name "${account_name}".`);
  if (!res.ok) throw new Error(`VTEX retornou HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { store: account_name, plan: "VTEX", country: null };
}

async function testTray({ api_address, access_token }) {
  if (!api_address || !access_token) throw new Error("api_address e access_token são obrigatórios.");
  const base = api_address.replace(/\/+$/, "");
  const res = await fetch(`${base}/store`, {
    headers: { "Authorization": `Bearer ${access_token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error(`Token inválido ou sem permissão (HTTP ${res.status}).`);
  if (!res.ok) throw new Error(`Tray retornou HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const store = body.Store || body.store || {};
  return { store: store.name || api_address, plan: null, country: null };
}

async function testOlist({ store_url, access_token }) {
  if (!store_url || !access_token) throw new Error("store_url e access_token são obrigatórios.");
  const base = store_url.replace(/\/+$/, "");
  const res = await fetch(`https://api.vnda.com.br/api/v2/products`, {
    headers: { "Authorization": `Bearer ${access_token}`, "X-Shop-Host": `${base}`, "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error(`Token inválido ou sem permissão (HTTP ${res.status}). Verifique o Token de Acesso da Olist.`);
  if (res.status === 404) throw new Error(`URL não encontrada (HTTP 404). Verifique a URL da loja "${store_url}".`);
  if (!res.ok) throw new Error(`Olist retornou HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return { store: store_url, plan: "Olist Ecommerce", country: "BR" };
}

async function testMaxdata({ api_url, emp_id, terminal }) {
  if (!api_url || !emp_id || !terminal) throw new Error("api_url, emp_id e terminal são obrigatórios.");
  const { testConnection } = await import("./ecommerce/maxdata/client.js");
  try {
    await testConnection(api_url, emp_id, terminal);
  } catch (err) {
    const msg = err.message || "";
    if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) throw new Error(`Credenciais inválidas (HTTP ${msg.match(/HTTP (\d+)/)?.[1] || "401"}). Verifique o ID da Empresa e o Terminal.`);
    if (msg.includes("HTTP 404")) throw new Error(`URL não encontrada (HTTP 404). Verifique a "API URL" configurada: "${api_url}".`);
    throw new Error(`MaxData: ${msg}`);
  }
  return { store: `Empresa #${emp_id}`, plan: "MaxData", country: "BR" };
}

export default async function handler(req, res) {
  if (setCors(req, res)) return;
  if (req.method !== "POST") { res.setHeader("Allow", ["POST"]); return res.status(405).end(); }

  const caller = await requireAuth(req, res);
  if (!caller) return;

  const { platform, config } = req.body || {};
  if (!platform || !config)
    return res.status(400).json({ success: false, message: "platform e config são obrigatórios." });

  const platformLabel = PLATFORM_LABELS[platform] || platform;

  const notifyAdminError = async (errorMsg) => {
    try {
      const errorTime = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const uRow = await pool.query("SELECT name FROM users WHERE id = $1", [caller.id]);
      const userName = uRow.rows[0]?.name || `ID ${caller.id}`;
      await notifyAdminIntegrationError(
        `Falha no teste de conexão — ${platformLabel}`,
        `Perfil: ${userName}\nPlataforma: ${platformLabel} (E-commerce)\nHorário: ${errorTime}\n\nDetalhe: ${errorMsg}`,
      );
    } catch { /* silencioso */ }
  };

  try {
    let result;
    switch (platform) {
      case "nuvemshop":   result = await testNuvemshop(config);   break;
      case "shopify":     result = await testShopify(config);     break;
      case "woocommerce": result = await testWoocommerce(config); break;
      case "vtex":        result = await testVtex(config);        break;
      case "tray":        result = await testTray(config);        break;
      case "olist":       result = await testOlist(config);       break;
      case "maxdata":     result = await testMaxdata(config);      break;
      default:
        return res.status(400).json({ success: false, message: `Teste automático não disponível para "${platform}".` });
    }
    // Constrói lista de lojas usando a chave de identificação configurada
    const storeKey = config.store_id || config.store_url || config.site_url || config.account_name || config.api_address || config.shop_host || config.api_url || '';
    const stores = result.store && storeKey ? [{ id: storeKey, name: result.store }] : [];
    return res.status(200).json({
      success: true,
      message: `Conexão com ${platformLabel} realizada com sucesso!${result.store ? ` Loja: ${result.store}.` : ""}`,
      store: result.store || null, plan: result.plan || null, country: result.country || null,
      stores,
    });
  } catch (err) {
    const msg = err.name === "TimeoutError" ? `Timeout: "${platformLabel}" não respondeu em 10 segundos.` : err.message;
    await notifyAdminError(msg);
    return res.status(200).json({ success: false, message: msg });
  }
}
