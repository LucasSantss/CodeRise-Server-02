import pool from "./db.js";
import { notifyAdminIntegrationError } from "./error-webhook.js";

// ─── Normalizers por plataforma ───────────────────────────────────────────────
function normalizeVtex(payload) {
  const order = payload.order || payload;
  const rawEvent = payload.type || payload.event || order.status || "";
  const statusMap = { "payment-approved":"order.created","order-created":"order.created","OrderCreated":"order.created","invoiced":"order.shipped","shipped":"order.shipped","order-completed":"order.shipped","canceled":"order.cancelled","order-cancelled":"order.cancelled","product-created":"product.sync","product-updated":"product.sync" };
  const eventType = statusMap[rawEvent] || rawEvent;
  if (eventType === "product.sync") { const p = payload.product || payload; return { eventType, product: { id:String(p.Id||p.ProductId||p.id), sku:String(p.RefId||p.sku||"1"), name:p.ProductName||p.name, description:(p.Description||p.description||"").replace(/<[^>]+>/g,""), categoryId:String(p.CategoryId||p.categoryId||""), brand:p.BrandName||p.brand||null, isActive:p.IsActive??p.isActive??true, price:p.Price||p.price||0, promotionalPrice:p.ListPrice||p.promotionalPrice||0, url:p.DetailUrl||p.url||null, images:(p.Images||p.images||[]).map(i=>({url:i.ImageUrl||i.url,description:i.ImageLabel||null})), weightInGrams:p.WeightKg?p.WeightKg*1000:0, dimensions:{heightInCm:p.Height||0,widthInCm:p.Width||0,lengthInCm:p.Length||0} } }; }
  const logInfo = order.shippingData?.logisticsInfo?.[0] || {};
  return { eventType, orderId:String(order.orderId||order.order_id||""), paymentTracking:order.paymentData?.transactions?.[0]?.transactionId||"", logisticStatus:order.status||"shipped", totalAmount:(order.value||0)/100, items:(order.items||[]).map(i=>({productId:String(i.productId||i.id),sku:String(i.id||i.sku),name:i.name,quantity:i.quantity,unitPrice:(i.sellingPrice||i.price||0)/100,discount:(i.manualDiscount||0)/100,sellerId:i.sellerId||"all"})), shipping:{provider:logInfo.deliveryCompany||"Entrega",type:1,price:(order.totals?.find(t=>t.id==="Shipping")?.value||0)/100,estimative:logInfo.shippingEstimateDate||"5 dias úteis"} };
}
function normalizeShopify(payload) {
  const topic = payload.topic||payload.x_shopify_topic||"";
  const statusMap = { "orders/create":"order.created","orders/paid":"order.created","orders/fulfilled":"order.shipped","orders/cancelled":"order.cancelled","products/create":"product.sync","products/update":"product.sync" };
  const eventType = statusMap[topic]||topic;
  if (eventType === "product.sync") { const p=payload,v=p.variants?.[0]||{}; return { eventType, product:{id:String(p.id),sku:String(v.sku||p.id),name:p.title,description:(p.body_html||"").replace(/<[^>]+>/g,""),categoryId:String(p.product_type||""),brand:p.vendor||null,isActive:p.status==="active",price:parseFloat(v.price||0),promotionalPrice:parseFloat(v.compare_at_price||0),url:p.handle?`https://shop.myshopify.com/products/${p.handle}`:null,images:(p.images||[]).map(i=>({url:i.src,description:i.alt||null})),weightInGrams:v.grams||0,dimensions:{heightInCm:0,widthInCm:0,lengthInCm:0}} }; }
  const f=payload.fulfillments?.[0]||{};
  return { eventType, orderId:String(payload.id||payload.order_id||""), paymentTracking:payload.payment_gateway||"", logisticStatus:payload.fulfillment_status||"fulfilled", totalAmount:parseFloat(payload.total_price||0), items:(payload.line_items||[]).map(i=>({productId:String(i.product_id),sku:String(i.sku||i.variant_id),name:i.title,quantity:i.quantity,unitPrice:parseFloat(i.price||0),discount:parseFloat(i.total_discount||0),sellerId:"all"})), shipping:{provider:f.tracking_company||payload.shipping_lines?.[0]?.title||"Entrega",type:1,price:parseFloat(payload.shipping_lines?.[0]?.price||0),estimative:"5 dias úteis"} };
}
function normalizeWoocommerce(payload) {
  const action=payload.action||payload.webhook_event||payload.status||"";
  const statusMap={"woocommerce_new_order":"order.created","woocommerce_order_status_processing":"order.created","woocommerce_order_status_completed":"order.shipped","woocommerce_order_status_shipped":"order.shipped","woocommerce_order_status_cancelled":"order.cancelled","woocommerce_order_status_refunded":"order.cancelled","woocommerce_new_product":"product.sync","woocommerce_update_product":"product.sync","order.created":"order.created","order.updated":"order.shipped","order.deleted":"order.cancelled","product.created":"product.sync","product.updated":"product.sync","processing":"order.created","completed":"order.shipped","cancelled":"order.cancelled","refunded":"order.cancelled"};
  const eventType=statusMap[action]||"order.created";
  if (eventType==="product.sync") { const p=payload; return { eventType, product:{id:String(p.id),sku:String(p.sku||p.id),name:p.name,description:(p.short_description||p.description||"").replace(/<[^>]+>/g,""),categoryId:String(p.categories?.[0]?.id||""),brand:p.brands?.[0]?.name||null,isActive:p.status==="publish",price:parseFloat(p.price||p.regular_price||0),promotionalPrice:parseFloat(p.sale_price||0),url:p.permalink||null,images:(p.images||[]).map(i=>({url:i.src,description:i.alt||null})),weightInGrams:p.weight?parseFloat(p.weight)*1000:0,dimensions:{heightInCm:parseFloat(p.dimensions?.height||0),widthInCm:parseFloat(p.dimensions?.width||0),lengthInCm:parseFloat(p.dimensions?.length||0)}} }; }
  const sh=payload.shipping_lines?.[0]||{};
  return { eventType, orderId:String(payload.id||payload.order_id||""), paymentTracking:payload.transaction_id||payload.payment_method||"", logisticStatus:payload.status||"processing", totalAmount:parseFloat(payload.total||0), items:(payload.line_items||[]).map(i=>({productId:String(i.product_id),sku:String(i.sku||i.product_id),name:i.name,quantity:i.quantity,unitPrice:parseFloat(i.price||0),discount:0,sellerId:"all"})), shipping:{provider:sh.method_title||"Entrega",type:1,price:parseFloat(sh.total||0),estimative:"5 dias úteis"} };
}
function normalizeNuvemshop(payload) {
  const topic=payload.topic||payload.event||"";
  const statusMap={
    "order/created":"order.created","order/paid":"order.created","order/updated":"order.created",
    "order/packed":"order.shipped","order/fulfilled":"order.shipped","order/cancelled":"order.cancelled",
    "order/pending":"order.created","order/voided":"order.cancelled",
    "order/custom_fields_updated":"order.created","order/edited":"order.created",
    "fulfillment/updated":"order.shipped","fulfillment_order/status_updated":"order.shipped",
    "fulfillment_order/tracking_event_created":"order.shipped","fulfillment_order/tracking_event_updated":"order.shipped",
    "fulfillment_order/tracking_event_deleted":"order.shipped",
    "product/created":"product.sync","product/updated":"product.sync","product/deleted":"product.sync",
    "product_variant/custom_fields_updated":"product.sync",
    "category/created":"product.sync","category/updated":"product.sync","category/deleted":"product.sync",
    "orders/created":"order.created","orders/paid":"order.created","orders/fulfilled":"order.shipped","orders/cancelled":"order.cancelled",
    "products/created":"product.sync","products/updated":"product.sync",
  };
  const eventType=statusMap[topic]||topic;
  if (eventType==="product.sync") { const p=payload.product||payload; return { eventType, product: p }; }
  const order=payload.order||payload;
  return { eventType, orderId:String(order.id||order.number||""), paymentTracking:order.payment_details?.method||"", logisticStatus:order.shipping_status||order.status||"shipped", totalAmount:parseFloat(order.total||0), items:(order.products||[]).map(i=>({productId:String(i.product_id||i.id),sku:String(i.sku||i.variant_id),name:i.name,quantity:i.quantity,unitPrice:parseFloat(i.price||0),discount:parseFloat(i.discount||0),sellerId:"all"})), shipping:{provider:order.shipping_pickup_type||"Entrega",type:1,price:parseFloat(order.shipping_cost_owner||0),estimative:"5 dias úteis"} };
}
function normalizeTray(payload) {
  const event=payload.type||payload.trigger||payload.event||"";
  const statusMap={"order_created":"order.created","order_paid":"order.created","order_shipped":"order.shipped","order_delivered":"order.shipped","order_cancelled":"order.cancelled","product_created":"product.sync","product_updated":"product.sync"};
  const eventType=statusMap[event]||event;
  if (eventType==="product.sync") { const p=payload.Product||payload.product||payload; return { eventType, product:{id:String(p.id||p.Id),sku:String(p.reference||p.sku||p.id),name:p.name||p.Name,description:(p.description||p.Description||"").replace(/<[^>]+>/g,""),categoryId:String(p.category_id||p.CategoryId||""),brand:p.brand||p.Brand||null,isActive:p.available==="1"||p.available===true||p.Active===true,price:parseFloat(p.price||p.Price||0),promotionalPrice:parseFloat(p.promotional_price||p.PromotionalPrice||0),url:p.link||p.Url||null,images:(p.images||p.Images||[]).map(i=>({url:i.link||i.Url||i.url,description:i.alt||null})),weightInGrams:parseFloat(p.weight||p.Weight||0)*1000,dimensions:{heightInCm:parseFloat(p.height||p.Height||0),widthInCm:parseFloat(p.width||p.Width||0),lengthInCm:parseFloat(p.length||p.Length||0)}} }; }
  const order=payload.Order||payload.order||payload;
  return { eventType, orderId:String(order.id||order.Id||order.order_id||""), paymentTracking:order.payment?.payment_method||order.PaymentMethod||"", logisticStatus:order.status||order.Status||"shipped", totalAmount:parseFloat(order.total||order.Total||0), items:(order.ProductsSold||order.products||order.items||[]).map(i=>({productId:String(i.Product?.id||i.product_id||i.id),sku:String(i.Product?.reference||i.sku||i.id),name:i.Product?.name||i.name,quantity:parseInt(i.quantity||i.Quantity||1),unitPrice:parseFloat(i.price||i.Price||0),discount:parseFloat(i.discount||i.Discount||0),sellerId:"all"})), shipping:{provider:order.shipping?.carrier||order.Carrier||"Entrega",type:1,price:parseFloat(order.shipping?.cost||order.ShippingCost||0),estimative:"5 dias úteis"} };
}
// A Olist (Vnda) não manda o nome do evento no corpo do webhook — usamos o
// mesmo link para todos os eventos, então o tipo precisa ser inferido pelo
// formato do payload (confirmado com exemplos reais de produção):
//  - pedido:  { order: {...} } — o estágio real está em order.status
//             ("confirmed" etc.) e nos timestamps confirmed_at/shipped_at/
//             canceled_at/paid_at.
//  - estoque: array de itens com { sku, quantity, inventories }.
//  - preço:   array de itens com { sku, price } (sem quantity).
//  - produto: a Olist manda só { id } no webhook — não há como diferenciar
//             "ativado" de "alterado" pelo corpo; ambos caem em "product_changed".
function classifyOlistTopic(payload) {
  if (Array.isArray(payload)) {
    const first = payload[0] || {};
    if ("price" in first && !("quantity" in first)) return "prices_changed";
    if ("quantity" in first || "inventories" in first) return "stocks_changed";
    return "";
  }
  if (payload && typeof payload === "object" && payload.order) {
    const o = payload.order;
    const status = String(o.status || "").toLowerCase();
    if (o.canceled_at || status.includes("cancel")) return "order_canceled";
    if (o.shipped_at || o.tracking_code || status.includes("ship") || status.includes("sent")) return "order_sent";
    if (o.confirmed_at || o.paid_at || status.includes("confirm") || status.includes("paid")) return "order_confirmed";
    return "order_received";
  }
  if (payload && typeof payload === "object" && payload.id !== undefined) return "product_changed";
  return "";
}

// Resolve o tópico do evento Olist: prioriza o nome vindo da URL cadastrada
// (?event=..., uma por evento — ver registerOlist), recebido aqui como
// queryEvent em vez de misturado no payload — os eventos de estoque/preço
// chegam como ARRAY, e fazer spread num array pra "injetar" um campo o
// transformaria num objeto comum, quebrando a detecção pelo formato.
// Só cai para a inferência pelo formato (classifyOlistTopic) se não vier
// pela URL nem por um campo no corpo.
function resolveOlistTopic(payload, queryEvent) {
  const bodyTopic = (payload && !Array.isArray(payload)) ? (payload.event || payload.topic || payload.type || "") : "";
  const rawTopic = queryEvent || bodyTopic || "";
  const topic = String(rawTopic).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return { rawTopic, topic: topic || classifyOlistTopic(payload) };
}

const OLIST_DISPLAY_LABELS = {
  order_received:    "order-received",
  order_confirmed:   "order-confirmed",
  order_sent:         "order-sent",
  order_canceled:     "order-canceled",
  product_activated: "product-activated",
  product_changed:    "product-changed",
  prices_changed:      "prices-changed",
  stocks_changed:      "stocks-changed",
};

function normalizeOlist(payload, queryEvent) {
  const { rawTopic, topic } = resolveOlistTopic(payload, queryEvent);
  const statusMap = {
    "order_paid":       "order.created",
    "order_created":    "order.created",
    // order-confirmed, order-received e order-sent são apenas registrados
    // (aparecem em Logs) — não disparam nenhuma ação na Suri.
    "order_confirmed":  "order.noop",
    "order_received":   "order.noop",
    "order_shipped":    "order.shipped",
    "order_sent":       "order.noop",
    "order_delivered":  "order.shipped",
    "order_canceled":   "order.cancelled",
    "order_cancelled":  "order.cancelled",
    "order_voided":     "order.cancelled",
    "order_refunded":   "order.cancelled",
    "product_created":  "product.sync",
    "product_updated":  "product.sync",
    "product_activated": "product.sync",
    "product_changed":  "product.sync",
    // Estoque/preço chegam como array de itens (sku/reference), não como
    // objeto de produto — tipo próprio, tratado em processOlistStockOrPriceChanged
    // (busca o produto completo pela referência e reaproveita o sync padrão).
    "prices_changed":   "product.price_changed",
    "stocks_changed":   "product.stock_changed",
    "product_deleted":  "product.deleted",
    "tag_created":      "category.sync",
    "tag_updated":      "category.sync",
    "tag_deleted":      "category.deleted",
  };
  const eventType = statusMap[topic] || topic || rawTopic;
  const displayEventType = OLIST_DISPLAY_LABELS[topic] || rawTopic || eventType;
  if (eventType === "product.sync" || eventType === "product.deleted") {
    const p = payload.product || payload;
    return { eventType, displayEventType, product: p };
  }
  if (eventType === "product.price_changed" || eventType === "product.stock_changed") {
    return { eventType, displayEventType, items: Array.isArray(payload) ? payload : [] };
  }
  const order = payload.order || payload;
  return {
    eventType,
    displayEventType,
    orderId:         String(order.code || order.id || ""),
    paymentTracking: order.payment_method || order.payment_type || "",
    logisticStatus:  order.shipping_status || order.status || "shipped",
    totalAmount:     parseFloat(order.total || 0),
    items: (order.items || order.line_items || []).map(i => ({
      productId: String(i.product_id || i.id || ""),
      sku:       String(i.sku || i.variant_sku || ""),
      name:      i.name || i.product_name || "Produto",
      quantity:  parseInt(i.quantity || 1),
      unitPrice: parseFloat(i.price || i.unit_price || 0),
      discount:  parseFloat(i.discount || 0),
      sellerId:  "all",
    })),
    shipping: {
      provider:   order.shipping_method_name || "Entrega",
      type:       1,
      price:      parseFloat(order.shipping_price || 0),
      estimative: "5 dias úteis",
    },
  };
}
export function normalizePayload(platform, payload, queryEvent) {
  switch (platform) {
    case "vtex":        return normalizeVtex(payload);
    case "shopify":     return normalizeShopify(payload);
    case "woocommerce": return normalizeWoocommerce(payload);
    case "nuvemshop":   return normalizeNuvemshop(payload);
    case "tray":        return normalizeTray(payload);
    case "olist":       return normalizeOlist(payload, queryEvent);
    default: return { eventType:payload.type||payload.event||payload.event_type||"desconhecido", orderId:String(payload.order_id||payload.orderId||payload.id||""), paymentTracking:"", logisticStatus:payload.status||"shipped", totalAmount:parseFloat(payload.total||payload.total_price||0), items:payload.items||payload.line_items||[], shipping:{provider:"Entrega",type:1,price:0,estimative:"5 dias úteis"} };
  }
}

// ─── Helpers Suri ─────────────────────────────────────────────────────────────
export async function suriRequest(endpoint, token, method, path, body) {
  const base = endpoint.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, { method, headers:{"Content-Type":"application/json","Accept":"application/json","Authorization":`Bearer ${token}`}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(`Suri ${method} ${path} → HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function findSuriOrder(endpoint, token, orderId) {
  try { const data = await suriRequest(endpoint, token, "POST", "/api/shop/orders", {ProviderOrderId:String(orderId),Page:1,PerPage:1}); const list=data?.orders||data?.data||data?.items||data||[]; return Array.isArray(list)?(list[0]||null):null; } catch { return null; }
}
function mapLogisticStatus(status) {
  const map={"ready-for-handling":1,"processing":1,"order_paid":1,"handling":2,"preparing":2,"invoiced":3,"shipped":3,"fulfilled":3,"order_shipped":3,"delivered":4,"order_delivered":4,"completed":4,"canceled":5,"cancelled":5,"refunded":5};
  return map[status]??1;
}

// ─── Processadores de evento ──────────────────────────────────────────────────
export async function processOrderCreated(ep, tk, n) {
  // Apenas cria o orçamento no Suri (a partir do webhook nativo da plataforma).
  // A dedução de estoque no e-commerce é responsabilidade exclusiva do webhook
  // OrdersCreated vindo do Suri (processSuriOrderCreatedGeneric/Olist, roteados
  // via "order.created.suri"/"order.created.olist"), disparado quando o
  // orçamento é criado na Suri — não mais quando é pago.
  const existing = await findSuriOrder(ep, tk, n.orderId);
  if (existing) return { action: "already_exists", suriOrderId: existing.id };
  const budget={id:String(n.orderId),logistic:{providerId:"001",name:n.shipping.provider||"Entrega",description:"Padrão",type:n.shipping.type||1,price:n.shipping.price||0,minShippingTimeEstimative:n.shipping.estimative||"3 dias úteis",shippingTimeEstimative:n.shipping.estimative||"5 dias úteis"},items:n.items.map(i=>({fromSellerId:i.sellerId||"all",ProductId:String(i.productId||i.id),Sku:String(i.sku||i.productId),Name:i.name,quantity:i.quantity,unitPrice:i.unitPrice,discountAmount:i.discount||0})),errorMessages:[]};
  const created = await suriRequest(ep,tk,"POST","/api/shop/orders/budget",budget);
  const suriOrderId=created?.id||created?.orderId;
  return { action: "budget_created", suriOrderId };
}
export async function processOrderShipped(ep,tk,n) { const ex=await findSuriOrder(ep,tk,n.orderId); if (!ex) throw new Error(`Pedido ${n.orderId} não encontrado na Suri`); const st=mapLogisticStatus(n.logisticStatus); await suriRequest(ep,tk,"POST","/api/shop/orders/logistic",{id:ex.id||ex.orderId,status:st}); return {action:"logistic_updated",suriOrderId:ex.id,status:st}; }
// Registra o resultado do envio à Suri como uma linha própria em user_webhooks
// (origem "chatbot"), separada da linha de recebimento do webhook do e-commerce
// (origem "ecommerce") — assim dá pra ver, na tela de Logs, se a sincronização
// do lado da Suri realmente aconteceu com sucesso, e não só se o webhook foi recebido.
async function logChatbotProductSync(userId, product, outcome, eventType = "product.sync") {
  if (!userId) return;
  // sentPayload vem em outcome.result (sucesso) ou outcome.sentPayload (erro,
  // anexado ao erro dentro de syncProduct) — nos dois casos, mostra exatamente
  // o corpo que foi enviado à Suri, não só o resultado/erro da chamada.
  const payload = {
    productId: product?.id,
    sku: product?.sku,
    name: product?.name,
    ...(outcome.result || {}),
    sentPayload: outcome.result?.sentPayload || outcome.sentPayload || null,
  };
  try {
    await pool.query(
      "INSERT INTO user_webhooks (user_id, event_type, payload, status, error_message, source) VALUES ($1, $2, $3, $4, $5, 'chatbot')",
      [userId, eventType, JSON.stringify(payload), outcome.status, outcome.errorMessage || null]
    );
  } catch { /* log é best-effort — não pode quebrar a sincronização */ }
}

export async function processProductSync(ep, tk, n, platform, userId, eventType = "product.sync") {
  const { syncProduct } = await import("./chatbot/suri/products.js");
  const { listCategories, syncCategory } = await import("./chatbot/suri/categories.js");
  const rawProduct = n.product || null;
  let product;
  if (platform === "nuvemshop") {
    const { normalizeProduct } = await import("./ecommerce/nuvemshop/products.js");
    product = rawProduct ? normalizeProduct(rawProduct) : null;
  } else if (platform === "olist") {
    const { normalizeProduct } = await import("./ecommerce/olist/products.js");
    product = rawProduct ? normalizeProduct(rawProduct) : null;
  } else {
    // Shopify, WooCommerce, VTEX, Tray: produto já normalizado pelo normalizeXxx() do webhook
    product = rawProduct || null;
  }
  if (!product) throw new Error("Produto não encontrado no payload do webhook");

  // Constrói mapa de IDs: externalId (plataforma) → id interno do Suri
  const categoryIdMap = new Map();
  try {
    const suriCats = await listCategories(ep, tk);
    for (const c of suriCats) {
      const suriId = String(c.id);
      if (c.externalId) categoryIdMap.set(String(c.externalId), suriId);
      categoryIdMap.set(suriId, suriId);
    }
  } catch {}

  // Se o produto tem categoria não mapeada, tenta sincronizá-la on-the-fly
  // usando os dados que já vieram no payload do webhook (sem chamada extra à API)
  if (product.categoryId && !categoryIdMap.has(String(product.categoryId))) {
    const rawCats = rawProduct?.categories || [];
    const rawCat  = rawCats.find(c => String(c.id) === String(product.categoryId));
    if (rawCat) {
      function i18n(f) { return typeof f === "string" ? f : (f?.pt || f?.es || Object.values(f || {})[0] || ""); }
      try {
        const r = await syncCategory(ep, tk, {
          id:          String(rawCat.id),
          name:        i18n(rawCat.name),
          description: i18n(rawCat.description),
          parentId:    rawCat.parent?.id ? String(rawCat.parent.id) : null,
        });
        if (r?.suriId) categoryIdMap.set(String(product.categoryId), String(r.suriId));
      } catch {}
    }
    // Se ainda não mapeado, envia sem categoria em vez de passar ID inválido ao Suri
    if (!categoryIdMap.has(String(product.categoryId))) {
      product = { ...product, categoryId: null };
    }
  }

  try {
    const result = await syncProduct(ep, tk, product, null, categoryIdMap.size > 0 ? categoryIdMap : null);
    await logChatbotProductSync(userId, product, { status: "processed", result }, eventType);
    return result;
  } catch (err) {
    await logChatbotProductSync(userId, product, { status: "error", errorMessage: err.message, sentPayload: err.suriPayload }, eventType);
    throw err;
  }
}

/**
 * Cenário stocks-changed / prices-changed (Olist → Suri).
 * Esses webhooks só trazem { sku, reference, quantity? / price? } por item —
 * não o produto completo. Os endpoints dedicados de preço/estoque da Suri
 * (PUT /products/{id}/prices e /stocks) exigem que o produto já exista lá;
 * como a Olist não tem webhook de criação de produto, um produto novo só
 * chega à Suri por esse caminho, e o PUT parcial nunca manda category/brand/
 * images/etc — isso gerava produtos incompletos e rejeições (ex: "Product
 * must have a category"). Por isso sempre buscamos o produto completo na
 * Olist e reenviamos via processProductSync (POST se não existir, PUT do
 * produto inteiro se já existir), igual ao fluxo de product_changed.
 */
export async function processOlistStockOrPriceChanged(suriEndpoint, suriToken, normalized, userId) {
  const intRow = await pool.query("SELECT ecommerce_config FROM user_integrations WHERE user_id = $1", [userId]);
  const { store_url, access_token } = intRow.rows[0]?.ecommerce_config || {};
  if (!store_url || !access_token) return { action: "skipped", reason: "Credenciais da Olist não configuradas" };

  const { findProductByReference, fetchFullProductRaw } = await import("./ecommerce/olist/products.js");

  const isPriceChange = normalized.eventType === "product.price_changed";
  const logEventType = isPriceChange ? "product.price_updated" : "product.stock_updated";

  // Agrupa por reference (produto pai) pra resolver o produto na Olist uma
  // única vez e reenviar o produto inteiro uma única vez, mesmo que várias
  // variantes (SKUs) tenham mudado.
  const byReference = new Map();
  for (const item of (normalized.items || [])) {
    if (!item.sku || !item.reference) continue;
    if (!byReference.has(item.reference)) byReference.set(item.reference, []);
    byReference.get(item.reference).push(item);
  }
  if (byReference.size === 0) return { action: "skipped", reason: "Payload sem campo 'reference'/'sku' pra localizar o produto na Olist" };

  const results = [];
  for (const [reference, refItems] of byReference) {
    try {
      const found = await findProductByReference(store_url, access_token, reference, refItems[0]?.sku);
      if (!found) { results.push({ reference, status: "not_found_in_olist" }); continue; }

      const full = await fetchFullProductRaw({ store_url, access_token }, found.id);
      // processProductSync já registra o log (sucesso ou erro) via logChatbotProductSync internamente.
      const syncResult = await processProductSync(suriEndpoint, suriToken, { product: full || found }, "olist", userId, logEventType);
      results.push({ reference, status: "synced", ...syncResult });
    } catch (err) {
      results.push({ reference, status: "error", detail: err.message });
    }
  }
  const allFailed = results.length > 0 && results.every(r => r.status !== "synced");
  if (allFailed) throw new Error(`Nenhum produto sincronizado: ${JSON.stringify(results).slice(0, 300)}`);
  return { action: "stock_price_synced", items: results };
}

// ─── Processadores de pedido da Suri (chatbot → E-commerce) ─────────────────

async function fetchSuriOrderItems(suriEndpoint, suriToken, suriOrderId) {
  const base = suriEndpoint.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/shop/orders/${suriOrderId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${suriToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`Suri GET /api/shop/orders/${suriOrderId} → HTTP ${res.status}: ${JSON.stringify(e).slice(0, 300)}`); }
  const body = await res.json();
  return (body?.data || body)?.items || [];
}

// Baixa o estoque no e-commerce a partir dos itens do pedido na Suri.
// Disparada por OrdersCreated OU OrdersPaid, conforme a preferência
// "Retirada de Estoque" configurada em Chatbot (chatbot_config.stockDeductionTrigger) —
// o roteamento em handleWebhook garante que só um dos dois webhooks chega aqui.
export async function processSuriOrderCreatedGeneric(suriEndpoint, suriToken, normalized, userId) {
  const intRow = await pool.query("SELECT ecommerce_platform, ecommerce_config FROM user_integrations WHERE user_id = $1", [userId]);
  const integration = intRow.rows[0];
  if (!integration) return { action: "skipped", reason: "Integração não encontrada" };
  const platform = integration.ecommerce_platform;
  const config = integration.ecommerce_config || {};
  if (platform === "olist") return { action: "skipped", reason: "Olist usa handler dedicado (order.created.olist)" };
  const suriOrderId = normalized.orderId || normalized.suriOrderId;
  if (!suriOrderId) return { action: "skipped", reason: "OrderId não encontrado no payload" };
  const items = await fetchSuriOrderItems(suriEndpoint, suriToken, suriOrderId);
  if (!items.length) return { action: "skipped", reason: "Pedido sem itens", orderId: suriOrderId };

  let result;
  if (platform === "nuvemshop") {
    const { getProductVariants, updateVariantStock } = await import("./ecommerce/nuvemshop/client.js");
    const { store_id, access_token } = config;
    if (!store_id || !access_token) return { action: "skipped", reason: "Credenciais da Nuvemshop não configuradas" };
    const stockResults = [];
    for (const item of items) {
      const productId = String(item.providerId || ""); const sku = String(item.sku || ""); const qty = Math.round(parseFloat(item.quantity || item.paidQuantity || 1));
      if (!productId || !qty) continue;
      try {
        const variants = await getProductVariants(store_id, access_token, productId);
        const variant = Array.isArray(variants) ? variants.find(v => String(v.sku) === sku) || variants[0] : null;
        if (!variant) { stockResults.push({ productId, sku, status: "variant_not_found" }); continue; }
        const currentStock = variant.stock ?? 0; const newStock = Math.max(0, currentStock - qty);
        await updateVariantStock(store_id, access_token, productId, variant.id, newStock);
        stockResults.push({ productId, sku, variantId: variant.id, previousStock: currentStock, newStock, deducted: currentStock - newStock });
      } catch (err) { stockResults.push({ productId, sku, status: "error", error: err.message }); }
    }
    result = { action: "stock_deducted", orderId: suriOrderId, items: stockResults };
  } else if (platform === "woocommerce") {
    const { deductStockForOrderItems } = await import("./ecommerce/woocommerce/stock.js");
    result = { ...(await deductStockForOrderItems(config, items.map(i => ({ sku: String(i.sku || ""), quantity: Math.round(parseFloat(i.quantity || i.paidQuantity || 1)), name: i.name || "" })))), orderId: suriOrderId };
  } else if (platform === "vtex") {
    const { deductStockForOrderItems } = await import("./ecommerce/vtex/stock.js");
    result = { ...(await deductStockForOrderItems(config, items.map(i => ({ sku: String(i.sku || ""), quantity: Math.round(parseFloat(i.quantity || i.paidQuantity || 1)), name: i.name || "" })))), orderId: suriOrderId };
  } else if (platform === "tray") {
    const { deductStockForOrderItems } = await import("./ecommerce/tray/stock.js");
    result = { ...(await deductStockForOrderItems(config, items.map(i => ({ sku: String(i.sku || ""), quantity: Math.round(parseFloat(i.quantity || i.paidQuantity || 1)), name: i.name || "" })))), orderId: suriOrderId };
  } else if (platform === "shopify") {
    const { deductStockForOrderItems } = await import("./ecommerce/shopify/stock.js");
    result = { ...(await deductStockForOrderItems(config, items.map(i => ({ sku: String(i.sku || ""), quantity: Math.round(parseFloat(i.quantity || i.paidQuantity || 1)), name: i.name || "", inventoryItemId: i.inventoryItemId || null })))), orderId: suriOrderId };
  } else {
    return { action: "skipped", reason: `Plataforma "${platform}" não suporta baixa de estoque automática via Suri` };
  }
  return { platform, action: "stock_deducted", ...result };
}
export const processSuriOrderCreated = processSuriOrderCreatedGeneric;
export async function processSuriOrderCancelledGeneric(suriEndpoint, suriToken, normalized, userId) {
  const intRow = await pool.query("SELECT ecommerce_platform, ecommerce_config FROM user_integrations WHERE user_id = $1", [userId]);
  const integration = intRow.rows[0];
  if (!integration) return { action: "skipped", reason: "Integração não encontrada" };
  const platform = integration.ecommerce_platform;
  const config = integration.ecommerce_config || {};
  if (platform === "olist") return { action: "skipped", reason: "Olist usa handler dedicado (order.cancelled.olist)" };
  const suriOrderId = normalized.orderId || normalized.suriOrderId;
  if (!suriOrderId) return { action: "skipped", reason: "OrderId não encontrado no payload" };
  const items = await fetchSuriOrderItems(suriEndpoint, suriToken, suriOrderId);
  if (!items.length) return { action: "skipped", reason: "Pedido sem itens", orderId: suriOrderId };

  const stockResults = [];
  if (platform === "nuvemshop") {
    const { getProductVariants, updateVariantStock } = await import("./ecommerce/nuvemshop/client.js");
    const { store_id, access_token } = config;
    if (!store_id || !access_token) return { action: "skipped", reason: "Credenciais da Nuvemshop não configuradas" };
    for (const item of items) {
      const productId = String(item.providerId || ""); const sku = String(item.sku || ""); const qty = Math.round(parseFloat(item.quantity || item.paidQuantity || 1));
      if (!productId || !qty) continue;
      try {
        const variants = await getProductVariants(store_id, access_token, productId);
        const variant = Array.isArray(variants) ? variants.find(v => String(v.sku) === sku) || variants[0] : null;
        if (!variant) { stockResults.push({ productId, sku, status: "variant_not_found" }); continue; }
        const currentStock = variant.stock ?? 0; const newStock = currentStock + qty;
        await updateVariantStock(store_id, access_token, productId, variant.id, newStock);
        stockResults.push({ productId, sku, variantId: variant.id, previousStock: currentStock, newStock, returned: qty });
      } catch (err) { stockResults.push({ productId, sku, status: "error", error: err.message }); }
    }
  } else if (platform === "woocommerce") {
    const { returnVariantStock } = await import("./ecommerce/woocommerce/stock.js");
    for (const item of items) {
      const sku = String(item.sku || ""); const qty = Math.round(parseFloat(item.quantity || item.paidQuantity || 1));
      if (!sku || !qty) continue;
      try { stockResults.push({ ...(await returnVariantStock(config, sku, qty)), name: item.name || "" }); }
      catch (err) { stockResults.push({ sku, status: "error", error: err.message }); }
    }
  } else if (platform === "vtex") {
    const { returnVariantStock } = await import("./ecommerce/vtex/stock.js");
    for (const item of items) {
      const sku = String(item.sku || ""); const qty = Math.round(parseFloat(item.quantity || item.paidQuantity || 1));
      if (!sku || !qty) continue;
      try { stockResults.push({ ...(await returnVariantStock(config, sku, qty)), name: item.name || "" }); }
      catch (err) { stockResults.push({ sku, status: "error", error: err.message }); }
    }
  } else if (platform === "tray") {
    const { returnVariantStock } = await import("./ecommerce/tray/stock.js");
    for (const item of items) {
      const sku = String(item.sku || ""); const qty = Math.round(parseFloat(item.quantity || item.paidQuantity || 1));
      if (!sku || !qty) continue;
      try { stockResults.push({ ...(await returnVariantStock(config, sku, qty)), name: item.name || "" }); }
      catch (err) { stockResults.push({ sku, status: "error", error: err.message }); }
    }
  } else if (platform === "shopify") {
    for (const item of items) {
      stockResults.push({ sku: item.sku || "", status: "skipped", reason: "Shopify requer inventory_item_id para devolução de estoque" });
    }
  } else {
    return { action: "skipped", reason: `Plataforma "${platform}" sem suporte a devolução de estoque via Suri` };
  }
  return { platform, action: "stock_returned", orderId: suriOrderId, items: stockResults };
}
export const processSuriOrderCancelled = processSuriOrderCancelledGeneric;

export async function processSuriOrderShippedGeneric(suriEndpoint, suriToken, normalized, userId) {
  const intRow = await pool.query("SELECT ecommerce_platform, ecommerce_config FROM user_integrations WHERE user_id = $1", [userId]);
  const integration = intRow.rows[0];
  if (!integration) return { action: "skipped", reason: "Integração não encontrada" };
  const platform = integration.ecommerce_platform;
  const config = integration.ecommerce_config || {};
  const payload = { orderId: normalized.orderId, tracking_number: normalized.tracking_number, tracking_url: normalized.tracking_url, shipping_company: normalized.shipping_company };
  if (!payload.orderId) return { action: "skipped", reason: "orderId não encontrado no payload" };
  let result;
  if (platform === "nuvemshop") {
    const { fulfillOrder } = await import("./ecommerce/nuvemshop/orders.js");
    result = await fulfillOrder(config, payload);
  } else if (platform === "olist") {
    const { fulfillOrder } = await import("./ecommerce/olist/orders.js");
    result = await fulfillOrder(config, payload);
  } else if (platform === "shopify") {
    const { fulfillOrder } = await import("./ecommerce/shopify/orders.js");
    result = await fulfillOrder(config, payload);
  } else if (platform === "woocommerce") {
    const { fulfillOrder } = await import("./ecommerce/woocommerce/orders.js");
    result = await fulfillOrder(config, payload);
  } else if (platform === "vtex") {
    const { fulfillOrder } = await import("./ecommerce/vtex/orders.js");
    result = await fulfillOrder(config, payload);
  } else if (platform === "tray") {
    const { fulfillOrder } = await import("./ecommerce/tray/orders.js");
    result = await fulfillOrder(config, payload);
  } else {
    return { action: "skipped", reason: `Plataforma "${platform}" sem suporte a atualização de envio via Suri` };
  }
  return { platform, ...result };
}


// Mesma ideia de processSuriOrderCreatedGeneric, variante Olist — disparada por
// OrdersCreated ou OrdersPaid conforme a preferência "Retirada de Estoque".
export async function processSuriOrderCreatedOlist(suriEndpoint, suriToken, normalized, userId) {
  const { deductStockForOrderItems } = await import("./ecommerce/olist/stock.js");
  const intRow = await pool.query("SELECT ecommerce_platform, ecommerce_config FROM user_integrations WHERE user_id = $1", [userId]);
  const integration = intRow.rows[0];
  if (!integration || integration.ecommerce_platform !== "olist") return { action: "skipped", reason: "E-commerce não é Olist" };
  const { store_url, access_token } = integration.ecommerce_config || {};
  if (!store_url || !access_token) return { action: "skipped", reason: "Credenciais da Olist não configuradas" };
  const suriOrderId = normalized.orderId || normalized.suriOrderId;
  if (!suriOrderId) return { action: "skipped", reason: "OrderId não encontrado no payload" };
  const base = suriEndpoint.replace(/\/+$/, "");
  const orderRes = await fetch(`${base}/api/shop/orders/${suriOrderId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${suriToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!orderRes.ok) { const errBody = await orderRes.json().catch(() => ({})); throw new Error(`Suri GET /api/shop/orders/${suriOrderId} → HTTP ${orderRes.status}: ${JSON.stringify(errBody).slice(0, 300)}`); }
  const suriOrder = await orderRes.json();
  const items = (suriOrder?.data || suriOrder)?.items || [];
  if (!items.length) return { action: "skipped", reason: "Pedido sem itens", orderId: suriOrderId };
  const result = await deductStockForOrderItems(
    { store_url, access_token },
    items.map(i => ({ sku: String(i.sku || ""), quantity: Math.round(parseFloat(i.quantity || i.paidQuantity || 1)), name: i.name || "" }))
  );
  return { action: "stock_deducted", orderId: suriOrderId, ...result };
}
export async function processSuriOrderCancelledOlist(suriEndpoint, suriToken, normalized, userId) {
  const { getVariantBySku, updateVariantStock } = await import("./ecommerce/olist/client.js");
  const intRow = await pool.query("SELECT ecommerce_platform, ecommerce_config FROM user_integrations WHERE user_id = $1", [userId]);
  const integration = intRow.rows[0];
  if (!integration || integration.ecommerce_platform !== "olist") return { action: "skipped", reason: "E-commerce não é Olist" };
  const { store_url, access_token } = integration.ecommerce_config || {};
  if (!store_url || !access_token) return { action: "skipped", reason: "Credenciais da Olist não configuradas" };
  const suriOrderId = normalized.orderId || normalized.suriOrderId;
  if (!suriOrderId) return { action: "skipped", reason: "OrderId não encontrado no payload" };
  const base = suriEndpoint.replace(/\/+$/, "");
  const orderRes = await fetch(`${base}/api/shop/orders/${suriOrderId}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${suriToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!orderRes.ok) { const errBody = await orderRes.json().catch(() => ({})); throw new Error(`Suri GET /api/shop/orders/${suriOrderId} → HTTP ${orderRes.status}: ${JSON.stringify(errBody).slice(0, 300)}`); }
  const suriOrder = await orderRes.json();
  const items = (suriOrder?.data || suriOrder)?.items || [];
  if (!items.length) return { action: "skipped", reason: "Pedido sem itens", orderId: suriOrderId };
  const stockResults = [];
  for (const item of items) {
    const sku = String(item.sku || "");
    const qty = Math.round(parseFloat(item.quantity || item.paidQuantity || 1));
    if (!sku) continue;
    try {
      const variant      = await getVariantBySku(store_url, access_token, sku);
      const currentStock = parseInt(variant.quantity ?? variant.stock ?? 0);
      const newStock     = currentStock + qty;
      await updateVariantStock(store_url, access_token, sku, newStock);
      stockResults.push({ sku, previousStock: currentStock, newStock, returned: qty });
    } catch (err) { stockResults.push({ sku, status: "error", error: err.message }); }
  }
  return { action: "stock_returned", orderId: suriOrderId, items: stockResults };
}

// ─── Handler principal do webhook ────────────────────────────────────────────
export async function handleWebhook(req, res) {
  if (req.method === "GET") return res.status(200).json({ success: true, message: "Webhook endpoint ativo" });
  if (req.method !== "POST") { res.setHeader("Allow",["GET","POST"]); return res.status(405).end(); }
  const { token } = req.query;
  if (!token) return res.status(400).json({ success: false, message: "token obrigatório" });
  let integration;
  try {
    let r = await pool.query("SELECT user_id, suri_active, suri_endpoint, suri_token, ecommerce_platform, chatbot_platform, chatbot_config, chatbot_active, chatbot_token, webhook_token FROM user_integrations WHERE webhook_token = $1", [token]);
    if (!r.rows[0]) r = await pool.query("SELECT user_id, suri_active, suri_endpoint, suri_token, ecommerce_platform, chatbot_platform, chatbot_config, chatbot_active, chatbot_token, webhook_token FROM user_integrations WHERE chatbot_token = $1", [token]);
    if (!r.rows[0]) return res.status(404).json({ success: false, message: "Token inválido" });
    integration = r.rows[0];
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
  const _ccfg = integration.chatbot_config || {};
  // chatbot_config.endpoint/token é a credencial atual; suri_endpoint/token é legado
  const suri_endpoint = _ccfg.endpoint || integration.suri_endpoint || null;
  const suri_token    = _ccfg.token    || integration.suri_token    || null;
  // chatbot_active é o campo atual; suri_active é legado
  const suri_active   = !!(integration.chatbot_active ?? integration.suri_active ?? (suri_endpoint && suri_token));
  const { user_id, ecommerce_platform, chatbot_platform } = integration;
  const isViaWebhookToken = integration.webhook_token === token;
  const activePlatform = isViaWebhookToken ? (ecommerce_platform || "ecommerce") : (chatbot_platform || "chatbot");
  const PLATFORM_LABELS = { shopify:"Shopify", woocommerce:"WooCommerce", nuvemshop:"Nuvemshop", vtex:"VTEX", tray:"Tray", suri:"Suri", evolution_api:"Evolution API", kommo:"Kommo", chatbot:"Chatbot", ecommerce:"E-commerce" };
  const platformLabel = PLATFORM_LABELS[activePlatform] || activePlatform;
  let userName = `ID ${user_id}`;
  try { const uRow = await pool.query("SELECT name FROM users WHERE id = $1", [user_id]); if (uRow.rows[0]) userName = uRow.rows[0].name; } catch {}

  let rawPayload = req.body || {};

  // Olist: um link por evento (uma URL com ?event=... cadastrada para cada
  // evento no painel admin — ver registerOlist) é a fonte da verdade pro tipo.
  // Guardamos à parte em vez de misturar no payload: os eventos de estoque/
  // preço chegam como ARRAY, e um spread pra "injetar" um campo o
  // transformaria num objeto comum, quebrando a detecção pelo formato.
  const olistQueryEvent = ecommerce_platform === "olist" ? String(req.query.event || req.query.topic || "") : "";

  // Olist: o webhook de produto manda só { id } — busca o produto completo
  // (com variantes) antes de normalizar, senão o sync envia um produto vazio.
  if (ecommerce_platform === "olist") {
    const { topic: _olistTopic } = resolveOlistTopic(rawPayload, olistQueryEvent);
    if ((_olistTopic === "product_activated" || _olistTopic === "product_changed") && rawPayload.id && !rawPayload.name) {
      try {
        const intRow = await pool.query("SELECT ecommerce_config FROM user_integrations WHERE user_id = $1", [user_id]);
        const { store_url, access_token } = intRow.rows[0]?.ecommerce_config || {};
        if (store_url && access_token) {
          const { fetchFullProductRaw } = await import("./ecommerce/olist/products.js");
          const full = await fetchFullProductRaw({ store_url, access_token }, rawPayload.id);
          if (full) rawPayload = { ...rawPayload, ...full };
        }
      } catch {}
    }
  }

  // Nuvemshop: busca dados completos + variantes atualizadas
  if (ecommerce_platform === "nuvemshop" && rawPayload.id && rawPayload.event) {
    try {
      const intRow = await pool.query("SELECT ecommerce_config FROM user_integrations WHERE user_id = $1", [user_id]);
      const cfg = intRow.rows[0]?.ecommerce_config || {};
      const { store_id, access_token } = cfg;
      if (store_id && access_token) {
        const headers = { "Content-Type":"application/json", "Authentication":`bearer ${access_token}`, "User-Agent":"CodeRise Integration (suporte@coderise.com.br)" };
        const base = `https://api.tiendanube.com/v1/${store_id}`;
        const ev = rawPayload.event || "";
        let fetchUrl = null;
        if (ev.startsWith("product")) fetchUrl = `${base}/products/${rawPayload.id}`;
        else if (ev.startsWith("order")) fetchUrl = `${base}/orders/${rawPayload.id}`;
        else if (ev.startsWith("category")) fetchUrl = `${base}/categories/${rawPayload.id}`;
        if (fetchUrl) {
          const r = await fetch(fetchUrl, { headers });
          if (r.ok) {
            const fullData = await r.json();
            if (ev.startsWith("product")) {
              let variants = fullData.variants || [];
              try { const vr = await fetch(`${base}/products/${rawPayload.id}/variants`, { headers }); if (vr.ok) { const vd = await vr.json(); if (Array.isArray(vd) && vd.length > 0) variants = vd; } } catch {}
              rawPayload = { ...rawPayload, product: { ...fullData, variants } };
            } else if (ev.startsWith("order")) {
              rawPayload = { ...rawPayload, order: fullData };
            } else {
              rawPayload = { ...rawPayload, ...fullData };
            }
          }
        }
      }
    } catch {}
  }

  let normalized;
  if (!isViaWebhookToken && rawPayload.HookEvent) {
    const suriEventMap = { "OrdersPaid":"order.paid", "OrdersCreated":"order.created", "OrdersCancelled":"order.cancelled", "OrdersCanceled":"order.cancelled", "OrdersShipped":"order.shipped" };
    const displayEventType = suriEventMap[rawPayload.HookEvent] || rawPayload.HookEvent;
    const _isOlist = ecommerce_platform === "olist";
    // Configurável em Chatbot > Retirada de Estoque ("created" ou "paid") —
    // decide qual dos dois webhooks da Suri deduz estoque; o outro vira noop
    // pra nunca deduzir duas vezes pro mesmo pedido. Default "created" mantém
    // o comportamento anterior pra quem ainda não escolheu uma opção.
    const stockDeductionTrigger = _ccfg.stockDeductionTrigger === "paid" ? "paid" : "created";
    const deductOnCreated = stockDeductionTrigger === "created";
    const routeEventType = displayEventType === "order.cancelled"
      ? (_isOlist ? "order.cancelled.olist" : "order.cancelled.suri")
      : displayEventType === "order.created"
      ? (deductOnCreated ? (_isOlist ? "order.created.olist" : "order.created.suri") : "order.noop")
      : displayEventType === "order.paid"
      ? (!deductOnCreated ? (_isOlist ? "order.created.olist" : "order.created.suri") : "order.noop")
      : displayEventType === "order.shipped"
      ? "order.shipped.suri"
      : displayEventType;
    normalized = { eventType: routeEventType, displayEventType, orderId: String(rawPayload.OrderId || rawPayload.Id || ""), suriOrderId: String(rawPayload.Id || "") };
  } else {
    try { normalized = normalizePayload(ecommerce_platform, rawPayload, olistQueryEvent); }
    catch { normalized = { eventType: rawPayload.type||rawPayload.event||"desconhecido", orderId:"", items:[], shipping:{provider:"Entrega",type:1,price:0,estimative:"5 dias úteis"} }; }
  }

  const eventType = normalized.eventType;
  // Prefer the original event name sent by the platform (rawPayload.event/topic/type)
  // so the UI 'Tipo' column shows the exact webhook name configured on the store.
  // Fall back to the normalized displayEventType or the internal eventType.
  const logEventType = (rawPayload && (rawPayload.event || rawPayload.topic || rawPayload.type)) || normalized.displayEventType || eventType;
  let webhookId;
  try {
    const webhookSource = isViaWebhookToken ? "ecommerce" : "chatbot";
    const ins = await pool.query("INSERT INTO user_webhooks (user_id, event_type, payload, status, source) VALUES ($1, $2, $3, 'received', $4)", [user_id, logEventType, JSON.stringify(rawPayload), webhookSource]);
    webhookId = ins.insertId;
    await pool.query(`DELETE FROM user_webhooks WHERE user_id=$1 AND received_at < NOW() - INTERVAL 60 DAY`,[user_id]).catch(()=>{});
  } catch (err) { return res.status(500).json({ success: false, message: "Erro ao salvar: " + err.message }); }

  if (!suri_active || !suri_endpoint || !suri_token) return res.status(200).json({ success:true, message:"Evento registrado. Suri não configurada ou inativa.", event_type:eventType, platform:ecommerce_platform, webhook_id:webhookId });

  try {
    let result;
    switch (eventType) {
      case "order.created":        result = await processOrderCreated(suri_endpoint, suri_token, normalized);  break;
      case "order.shipped":        result = await processOrderShipped(suri_endpoint, suri_token, normalized);  break;
      // Cancelamento vindo do e-commerce não propaga pra Suri — só a Suri
      // (order.cancelled.suri/order.cancelled.olist) é fonte da verdade pra
      // cancelar pedido; senão um cancelamento parcial/local no e-commerce
      // cancelaria o pedido inteiro na Suri sem ela ter decidido isso.
      case "order.cancelled":      { await pool.query("UPDATE user_webhooks SET status='processed', error_message=$1 WHERE id=$2", [`Ignorado: ${logEventType} (cancelamento só é aplicado quando vem da Suri)`, webhookId]); return res.status(200).json({ success:true, message:"Evento registrado sem ação.", event_type:logEventType, webhook_id:webhookId }); }
      case "product.sync":         result = await processProductSync(suri_endpoint, suri_token, normalized, ecommerce_platform, user_id); break;
      case "order.noop":           { await pool.query("UPDATE user_webhooks SET status='processed', error_message=$1 WHERE id=$2", [`Ignorado: ${logEventType} (sem ação configurada)`, webhookId]); return res.status(200).json({ success:true, message:"Evento registrado sem ação.", event_type:logEventType, webhook_id:webhookId }); }
      case "order.paid":           result = await processSuriOrderCreatedGeneric(suri_endpoint, suri_token, normalized, user_id); break;
      case "order.created.suri":   result = await processSuriOrderCreatedGeneric(suri_endpoint, suri_token, normalized, user_id); break;
      case "order.shipped.suri":   result = await processSuriOrderShippedGeneric(suri_endpoint, suri_token, normalized, user_id); break;
      case "order.cancelled.suri": result = await processSuriOrderCancelledGeneric(suri_endpoint, suri_token, normalized, user_id); break;
      case "order.created.olist":        result = await processSuriOrderCreatedOlist(suri_endpoint, suri_token, normalized, user_id); break;
      case "order.cancelled.olist":      result = await processSuriOrderCancelledOlist(suri_endpoint, suri_token, normalized, user_id); break;
      case "product.price_changed":
      case "product.stock_changed":      result = await processOlistStockOrPriceChanged(suri_endpoint, suri_token, normalized, user_id); break;
      default:
        await pool.query("UPDATE user_webhooks SET status='processed', error_message=$1 WHERE id=$2", [`Evento '${eventType}' sem mapeamento`, webhookId]);
        return res.status(200).json({ success:true, message:"Evento registrado sem processamento", event_type:eventType, webhook_id:webhookId });
    }
    const resultInfo = result ? JSON.stringify(result).slice(0, 400) : null;
    await pool.query("UPDATE user_webhooks SET status='processed', error_message=$1 WHERE id=$2", [resultInfo, webhookId]);
    return res.status(200).json({ success:true, message:"Evento processado com sucesso", event_type:eventType, platform:ecommerce_platform, webhook_id:webhookId, suri_result:result });
  } catch (err) {
    await pool.query("UPDATE user_webhooks SET status='error', error_message=$1 WHERE id=$2", [err.message, webhookId]);
    try {
      const errorTime = new Date().toLocaleString("pt-BR", { timeZone:"America/Sao_Paulo", day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit", second:"2-digit" });
      await pool.query("INSERT INTO notifications (type, title, message, target_role, target_user_id) VALUES ('error', $1, $2, 'user', $3)", [`Erro na integração ${platformLabel}`, `Evento "${eventType || "desconhecido"}" falhou em ${errorTime}.\n\nDetalhe: ${err.message}`, user_id]);
      await notifyAdminIntegrationError(`Erro de integração — ${platformLabel}`, `Perfil: ${userName}\nPlataforma: ${platformLabel}\nEvento: ${eventType || "desconhecido"}\nHorário: ${errorTime}\n\nDetalhe: ${err.message}`);
    } catch {}
    return res.status(200).json({ success:false, message:"Evento registrado mas falhou ao processar na Suri", event_type:eventType, platform:ecommerce_platform, webhook_id:webhookId, error:err.message });
  }
}
