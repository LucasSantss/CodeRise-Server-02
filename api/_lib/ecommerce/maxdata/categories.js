/**
 * ecommerce/maxdata/categories.js
 * Categorias na MaxData = Grupos de produto (GET /product/groups).
 *
 * A MaxData também expõe "subgrupos" (/product/subgroups) e "classes"
 * (/product/classes), mas a Suri só suporta um nível de categoria por
 * produto — mapeamos apenas o grupo (campo `grupoId` do produto), que é a
 * granularidade mais próxima de "categoria" numa vitrine de e-commerce.
 */

import * as client from "./client.js";

// Categoria de fallback para produtos sem grupo. A Suri rejeita produtos
// sem categoryId, então esta categoria é sempre criada/atualizada junto
// com as demais (mesmo padrão usado pela Olist).
export const UNCATEGORIZED_ID = "sem-categoria";
const UNCATEGORIZED_CATEGORY = {
  id: UNCATEGORIZED_ID,
  name: "Sem categoria",
  description: "",
  parentId: null,
  tagType: null,
  handle: UNCATEGORIZED_ID,
};

/**
 * Busca todos os grupos de produto da MaxData (paginado) e normaliza.
 */
export async function fetchCategories(config) {
  const { api_url, emp_id, terminal } = config;
  let all = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const batch = await client.listProductGroups(api_url, emp_id, terminal, { page, limit: 50 });
    const items = Array.isArray(batch) ? batch : (batch.docs || []);
    if (!items.length) { hasMore = false; break; }
    all = all.concat(items.map(normalizeCategory));
    hasMore = items.length >= 50;
    page++;
    if (page > 200) break; // proteção contra loop infinito
  }

  return [...all, UNCATEGORIZED_CATEGORY];
}

/**
 * Normaliza um grupo de produto (dtos.ProductGroupSearch: { id, nome, usaEcommerce })
 * para o formato interno de categoria.
 */
export function normalizeCategory(g) {
  return {
    id: String(g.id),
    name: g.nome || "",
    description: "",
    parentId: null,
    tagType: null,
    handle: null,
  };
}
