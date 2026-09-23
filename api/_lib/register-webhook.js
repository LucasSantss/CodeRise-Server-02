import pool from "./db.js";
import { requireAuth } from "../_auth.js";

async function registerShopify(config, webhookUrl) {
  const { store_url, api_token, api_version } = config;
  if (!store_url || !api_token) throw new Error("store_url e api_token são obrigatórios");
  const version = api_version || "2024-01";
  const base = `https://${store_url.replace(/^https?:\/\//, "")}/admin/api/${version}`;
  const headers = { "Content-Type":"application/json", "X-Shopify-Access-Token":api_token };
  const topics = ["orders/create","orders/fulfilled","orders/cancelled","products/create","products/update"];
  const results = [];
  for (const topic of topics) {
    const r = await fetch(`${base}/webhooks.json`, { method:"POST", headers, body:JSON.stringify({webhook:{topic,address:webhookUrl,format:"json"}}) });
    const data = await r.json();
    if (!r.ok) { results.push({topic,status:r.status===422&&JSON.stringify(data).includes("already")?"already_exists":"error",detail:data.errors||data}); }
    else { results.push({topic,status:"created",id:data.webhook?.id}); }
  }
  return { success:true, message:`${results.filter(r=>r.status!=="error").length}/${topics.length} webhooks registrados na Shopify`, details:results };
}

async function registerWoocommerce(config, webhookUrl) {
  const { site_url, consumer_key, consumer_secret } = config;
  if (!site_url||!consumer_key||!consumer_secret) throw new Error("site_url, consumer_key e consumer_secret são obrigatórios");
  const base=`${site_url.replace(/\/+$/,"")}/wp-json/wc/v3`;
  const auth=Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");
  const headers={"Content-Type":"application/json","Authorization":`Basic ${auth}`};
  const topics=[{name:"Pedido Criado",topic:"order.created"},{name:"Pedido Atualizado",topic:"order.updated"},{name:"Pedido Deletado",topic:"order.deleted"},{name:"Produto Criado",topic:"product.created"},{name:"Produto Atualizado",topic:"product.updated"}];
  const results=[];
  for (const {name,topic} of topics) { const r=await fetch(`${base}/webhooks`,{method:"POST",headers,body:JSON.stringify({name,status:"active",topic,delivery_url:webhookUrl})}); const data=await r.json(); results.push(r.ok?{topic,status:"created",id:data.id}:{topic,status:"error",detail:data.message||data}); }
  return { success:true, message:`${results.filter(r=>r.status==="created").length}/${topics.length} webhooks registrados no WooCommerce`, details:results };
}

async function registerNuvemshop(config, webhookUrl) {
  const { store_id, access_token } = config;
  if (!store_id||!access_token) throw new Error("store_id e access_token são obrigatórios");
  const base=`https://api.tiendanube.com/v1/${store_id}`;
  const headers={"Content-Type":"application/json","Authentication":`bearer ${access_token}`,"User-Agent":"CodeRise Integration (suporte@coderise.com.br)"};
  const events=[
    "category/created","category/updated","category/deleted",
    "order/created","order/updated","order/paid","order/packed",
    "order/fulfilled","order/cancelled",
    "product/created","product/updated","product/deleted",
  ];
  const results=[];
  for (const event of events) {
    const r=await fetch(`${base}/webhooks`,{method:"POST",headers,body:JSON.stringify({event,url:webhookUrl})});
    const data=await r.json().catch(()=>({}));
    if (!r.ok) {
      // Nuvemshop retorna mensagens em português — checar ambos os idiomas
      const body=JSON.stringify(data).toLowerCase();
      const alreadyExists=r.status===422&&(
        body.includes("already")||body.includes("já existe")||body.includes("ja existe")||
        body.includes("existe um webhook")||body.includes("mesmo endere")||body.includes("duplicate")
      );
      // Evento não suportado: 422 com "is not valid" ou "invalid"
      const unsupported=r.status===422&&(body.includes("is not valid")||body.includes("invalid")||body.includes("não é válido"));
      results.push({event,status:alreadyExists?"already_exists":unsupported?"unsupported":"error",detail:data.description||data,httpStatus:r.status});
    } else {
      results.push({event,status:"created",id:data.id});
    }
  }
  const ok=results.filter(r=>r.status==="created"||r.status==="already_exists").length;
  return { success:true, message:`${ok}/${events.length} webhooks registrados na Nuvemshop`, details:results };
}

async function registerVtex(config, webhookUrl) {
  const { account_name, app_key, app_token } = config;
  if (!account_name||!app_key||!app_token) throw new Error("account_name, app_key e app_token são obrigatórios");
  const base=`https://${account_name}.vtexcommercestable.com.br/api`;
  const headers={"Content-Type":"application/json","X-VTEX-API-AppKey":app_key,"X-VTEX-API-AppToken":app_token};
  const r=await fetch(`${base}/orders/hook/config`,{method:"POST",headers,body:JSON.stringify({filter:{type:"FromWorkflow",status:["payment-approved","invoiced","canceled"]},hook:{headers:{"x-coderise-token":"webhook"},url:webhookUrl}})});
  const data=await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`VTEX Hook API → HTTP ${r.status}: ${JSON.stringify(data)}`);
  return { success:true, message:"Hook de pedidos configurado na VTEX com sucesso", details:data };
}

async function registerTray(config, webhookUrl) {
  const { api_address, access_token } = config;
  if (!api_address||!access_token) throw new Error("api_address e access_token são obrigatórios");
  const base=api_address.replace(/\/+$/,"");
  const headers={"Content-Type":"application/json","Authorization":`Bearer ${access_token}`};
  const triggers=["order_created","order_paid","order_shipped","order_cancelled","product_created","product_updated"];
  const results=[];
  for (const trigger of triggers) { const r=await fetch(`${base}/web_hooks`,{method:"POST",headers,body:JSON.stringify({web_hook:{url:webhookUrl,trigger,active:"true"}})}); const data=await r.json().catch(()=>({})); results.push(r.ok?{trigger,status:"created",id:data.web_hook?.id}:{trigger,status:"error",detail:data.message||data}); }
  return { success:true, message:`${results.filter(r=>r.status==="created").length}/${triggers.length} webhooks registrados na Tray`, details:results };
}

async function registerOlist(config, webhookUrl) {
  const { store_url, access_token } = config;
  if (!store_url || !access_token)
    throw new Error("store_url e access_token são obrigatórios");

  // A Olist (Vnda) não tem API pública de registro de webhooks e não envia o nome
  // do evento no corpo da requisição — cada evento é cadastrado como uma URL
  // separada no painel admin. Geramos uma URL por evento (com ?event=...) para
  // que o backend saiba identificar o tipo com precisão ao receber o payload
  // (essencial para product-activated x product-changed, que chegam com o
  // mesmo corpo — apenas { id } — e não dá pra diferenciar de outra forma).
  const events = [
    "order-received", "order-confirmed", "order-sent", "order-canceled",
    "product-activated", "product-changed", "prices-changed", "stocks-changed",
  ];

  return {
    success: true,
    manual:  true,
    message: `A Olist não possui API pública de registro de webhooks. Configure manualmente no painel admin (Configurações → Integrações → API → Webhooks), colando a URL correspondente para cada evento abaixo.`,
    details: events.map(event => ({ event, status: "manual", url: `${webhookUrl}&event=${event}` })),
  };
}

async function registerMaxdata(config, webhookUrl) {
  const { api_url, emp_id, terminal } = config;
  if (!api_url || !emp_id || !terminal)
    throw new Error("api_url, emp_id e terminal são obrigatórios");

  // A MaxData não tem nenhuma API (nem painel) de webhooks — delega a
  // mensagem explicativa pro módulo da integração.
  const { registerWebhooks } = await import("./ecommerce/maxdata/index.js");
  return registerWebhooks(config, webhookUrl);
}

async function listNuvemshopWebhooks(config) {
  const { store_id, access_token } = config;
  if (!store_id||!access_token) throw new Error("store_id e access_token são obrigatórios");
  const base=`https://api.tiendanube.com/v1/${store_id}`;
  const headers={"Authentication":`bearer ${access_token}`,"User-Agent":"CodeRise Integration (suporte@coderise.com.br)"};
  const r=await fetch(`${base}/webhooks`,{headers});
  const data=await r.json().catch(()=>[]);
  if (!r.ok) throw new Error(`Nuvemshop GET /webhooks → HTTP ${r.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data)?data:[];
}

async function registerSuriChatbot(config, chatbotWebhookUrl, chatbotToken) {
  const { endpoint, token } = config;
  if (!endpoint || !token) throw new Error("endpoint e token da Suri são obrigatórios");
  const topics = (() => {
    try {
      const t = config.suri_topics ? JSON.parse(config.suri_topics) : null;
      if (Array.isArray(t) && t.length > 0) return t;
    } catch { /* usa default */ }
    return ["OrdersCreated","OrdersPaid","OrdersCanceled","OrderLogisticUpdate"];
  })();
  const r = await fetch(`${endpoint.replace(/\/+$/,"")}/webhook/subscribe`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${token}`},
    body:JSON.stringify({url:chatbotWebhookUrl,token:chatbotToken,topics}),
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`Suri POST /webhook/subscribe → HTTP ${r.status}: ${JSON.stringify(data)}`);
  return {
    success:true,
    message:`Webhook registrado na Suri para ${topics.length} tópico(s)`,
    details:topics.map(topic=>({topic,status:"created"})),
  };
}

export async function handleRegisterChatbotWebhook(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow",["POST"]); return res.status(405).end(); }
  const caller = await requireAuth(req, res); if (!caller) return;
  try {
    const r = await pool.query("SELECT chatbot_config, chatbot_token FROM user_integrations WHERE user_id = $1",[caller.id]);
    if (!r.rows[0]) return res.status(404).json({success:false,message:"Integração não encontrada. Salve as configurações primeiro."});
    const { chatbot_config, chatbot_token } = r.rows[0];
    if (!chatbot_config?.endpoint) return res.status(400).json({success:false,message:"Configure o endpoint da Suri antes de registrar o webhook."});
    if (!chatbot_token) return res.status(400).json({success:false,message:"Token do chatbot não gerado. Acesse a configuração do chatbot."});
    const host=req.headers.host||req.headers["x-forwarded-host"]||"";
    const protocol=req.headers["x-forwarded-proto"]||"https";
    const chatbotWebhookUrl=`${protocol}://${host}/webhook?token=${chatbot_token}`;
    const result = await registerSuriChatbot(chatbot_config,chatbotWebhookUrl,chatbot_token);
    return res.status(200).json({success:true,...result,webhook_url:chatbotWebhookUrl});
  } catch (err) { return res.status(500).json({success:false,message:err.message}); }
}

export async function handleRegisterWebhook(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.setHeader("Allow",["GET","POST"]); return res.status(405).end(); }
  const caller = await requireAuth(req, res); if (!caller) return;
  try {
    const r = await pool.query("SELECT * FROM user_integrations WHERE user_id = $1", [caller.id]);
    if (!r.rows[0]) return res.status(404).json({ success:false, message:"Integração não encontrada. Salve as configurações primeiro." });
    const { ecommerce_platform, ecommerce_config, webhook_token } = r.rows[0];
    if (!ecommerce_platform) return res.status(400).json({ success:false, message:"Nenhuma plataforma de e-commerce configurada" });
    if (!ecommerce_config)   return res.status(400).json({ success:false, message:"Configure e salve as credenciais da plataforma primeiro" });
    const host=req.headers.host||req.headers["x-forwarded-host"]||"";
    const protocol=req.headers["x-forwarded-proto"]||"https";
    const webhookUrl=`${protocol}://${host}/webhook?token=${webhook_token}`;

    // GET: lista webhooks registrados na plataforma (check)
    if (req.method === "GET") {
      if (ecommerce_platform !== "nuvemshop") {
        return res.status(400).json({ success:false, message:`Verificação de webhooks disponível apenas para Nuvemshop (plataforma atual: ${ecommerce_platform})` });
      }
      const expectedEvents = [
        "category/created","category/updated","category/deleted",
        "order/created","order/updated","order/paid","order/packed",
        "order/fulfilled","order/cancelled",
        "product/created","product/updated","product/deleted",
      ];
      const existing = await listNuvemshopWebhooks(ecommerce_config);
      const details = expectedEvents.map(event => {
        const found = existing.find(w => w.event === event);
        if (!found) return { event, status:"missing" };
        const urlMatch = found.url === webhookUrl;
        return { event, status: urlMatch ? "registered" : "wrong_url", id:found.id, url:found.url };
      });
      const extra = existing.filter(w => !expectedEvents.includes(w.event));
      const ok = details.filter(d => d.status==="registered").length;
      return res.status(200).json({
        success:true,
        message:`${ok}/${expectedEvents.length} eventos verificados`,
        details,
        extra: extra.map(w => ({ event:w.event, status:"extra", id:w.id, url:w.url })),
        webhook_url:webhookUrl,
        mode:"check",
      });
    }

    // POST: registra webhooks
    let result;
    switch (ecommerce_platform) {
      case "shopify":     result = await registerShopify(ecommerce_config, webhookUrl);     break;
      case "woocommerce": result = await registerWoocommerce(ecommerce_config, webhookUrl); break;
      case "nuvemshop":   result = await registerNuvemshop(ecommerce_config, webhookUrl);   break;
      case "vtex":        result = await registerVtex(ecommerce_config, webhookUrl);        break;
      case "tray":        result = await registerTray(ecommerce_config, webhookUrl);        break;
      case "olist":        result = await registerOlist(ecommerce_config, webhookUrl);        break;
      case "maxdata":      result = await registerMaxdata(ecommerce_config, webhookUrl);     break;
      default: return res.status(400).json({ success:false, message:`Registro automático não disponível para '${ecommerce_platform}'. URL: ${webhookUrl}` });
    }
    return res.status(200).json({ success:true, ...result, webhook_url:webhookUrl });
  } catch (err) { return res.status(500).json({ success:false, message:err.message }); }
}
