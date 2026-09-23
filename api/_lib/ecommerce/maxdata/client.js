/**
 * ecommerce/maxdata/client.js
 * Client HTTP da API MaxData (MaxApi Manager) — ERP/PDV, não uma vitrine de
 * e-commerce tradicional.
 *
 * Autenticação: JWT Bearer obtido via POST /auth com { empId, terminal }
 * (ver dtos.TokenDto). O token expira — este módulo mantém um cache em
 * memória por combinação (api_url + empId + terminal) e reautentica
 * automaticamente quando necessário.
 *
 * Base URL: específica de cada cliente MaxData (o campo "host" do Swagger
 * vem vazio — cada instalação tem seu próprio domínio/porta), configurada
 * pelo usuário como "API URL". basePath documentado: "/v2".
 */

const USER_AGENT = "CodeRise Integration (suporte@coderise.com.br)";
const TOKEN_REFRESH_MARGIN_MS = 60_000; // renova o token 60s antes do vencimento
const DEFAULT_TOKEN_TTL_MS = 20 * 60 * 1000; // usado quando "expiration" não é uma data parseável

// Cache de token em memória — evita autenticar de novo a cada chamada dentro
// da mesma execução do processo.
const _tokenCache = new Map();

function baseUrl(apiUrl) {
  return `${String(apiUrl || "").replace(/\/+$/, "")}/v2`;
}

function cacheKey(apiUrl, empId, terminal) {
  return `${apiUrl}|${empId}|${terminal}`;
}

async function authenticate(apiUrl, empId, terminal) {
  const res = await fetch(`${baseUrl(apiUrl)}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ empId: Number(empId), terminal: String(terminal) }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`MaxData POST /auth → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  if (!data.token) throw new Error("MaxData /auth não retornou token");
  return data; // { token, expiration, empId, terminal }
}

/**
 * Retorna um token JWT válido, autenticando ou reautenticando quando
 * necessário. O formato de "expiration" retornado pela MaxData não é
 * documentado com precisão — se não for uma data parseável, usa um TTL
 * conservador (20min) pra forçar renovação periódica de qualquer forma.
 */
async function getToken(apiUrl, empId, terminal) {
  const key = cacheKey(apiUrl, empId, terminal);
  const cached = _tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return cached.token;

  const auth = await authenticate(apiUrl, empId, terminal);
  const parsedExpiration = auth.expiration ? Date.parse(auth.expiration) : NaN;
  const expiresAt = Number.isFinite(parsedExpiration) ? parsedExpiration : Date.now() + DEFAULT_TOKEN_TTL_MS;
  _tokenCache.set(key, { token: auth.token, expiresAt });
  return auth.token;
}

// Retry com backoff exponencial para falhas transientes (mesmo padrão dos demais adaptadores)
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 600) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      const msg = err.message || "";
      const isClientError = msg.includes("HTTP 4") && !msg.includes("HTTP 429") && !msg.includes("HTTP 408");
      if (isClientError || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 300;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function request(apiUrl, empId, terminal, method, path, { body, query, forceReauth } = {}) {
  const token = forceReauth
    ? await (async () => { _tokenCache.delete(cacheKey(apiUrl, empId, terminal)); return getToken(apiUrl, empId, terminal); })()
    : await getToken(apiUrl, empId, terminal);

  const cleanQuery = query
    ? Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ""))
    : null;
  const qs = cleanQuery && Object.keys(cleanQuery).length > 0 ? new URLSearchParams(cleanQuery).toString() : "";
  const url = `${baseUrl(apiUrl)}${path}${qs ? `?${qs}` : ""}`;

  return withRetry(async () => {
    const res = await fetch(url, {
      method,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": USER_AGENT,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    // O token pode ter expirado entre a checagem do cache e a chamada real —
    // reautentica uma vez e refaz a requisição antes de desistir.
    if (res.status === 401 && !forceReauth) {
      return request(apiUrl, empId, terminal, method, path, { body, query, forceReauth: true });
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`MaxData ${method} ${path} → HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  });
}

// ─── Produtos ─────────────────────────────────────────────────────────────────
export async function listProducts(apiUrl, empId, terminal, params = {}) {
  return request(apiUrl, empId, terminal, "GET", "/product", { query: params });
}

export async function getProduct(apiUrl, empId, terminal, productId) {
  return request(apiUrl, empId, terminal, "GET", `/product/${productId}`);
}

export async function getProductByEan(apiUrl, empId, terminal, ean) {
  return request(apiUrl, empId, terminal, "GET", `/product/ean/${encodeURIComponent(ean)}`);
}

export async function updateProduct(apiUrl, empId, terminal, productId, body) {
  return request(apiUrl, empId, terminal, "PUT", `/product/${productId}`, { body });
}

// ─── Catálogo (grupos, subgrupos, classes) ────────────────────────────────────
export async function listProductGroups(apiUrl, empId, terminal, params = {}) {
  return request(apiUrl, empId, terminal, "GET", "/product/groups", { query: params });
}

export async function listProductSubGroups(apiUrl, empId, terminal, params = {}) {
  return request(apiUrl, empId, terminal, "GET", "/product/subgroups", { query: params });
}

export async function listProductClasses(apiUrl, empId, terminal, params = {}) {
  return request(apiUrl, empId, terminal, "GET", "/product/classes", { query: params });
}

// ─── Tabelas de preço ─────────────────────────────────────────────────────────
export async function listPricingTables(apiUrl, empId, terminal, params = {}) {
  return request(apiUrl, empId, terminal, "GET", "/product/pricingtables", { query: params });
}

export async function getPricingTableItems(apiUrl, empId, terminal, pptid, params = {}) {
  return request(apiUrl, empId, terminal, "GET", `/pricingtables/${pptid}/items`, { query: params });
}

// ─── Conexão ──────────────────────────────────────────────────────────────────
// Autentica e faz uma listagem mínima — valida empId/terminal e a API URL
// numa única chamada (a MaxData não tem um endpoint de "loja"/"conta").
export async function testConnection(apiUrl, empId, terminal) {
  await getToken(apiUrl, empId, terminal);
  return listProducts(apiUrl, empId, terminal, { limit: 1, page: 1 });
}
