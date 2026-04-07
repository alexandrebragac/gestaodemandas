/**
 * Serviço de integração com Rappi (API não-oficial / reverse-engineered)
 * Busca supermercados e preços de itens próximos ao endereço do usuário.
 *
 * IMPORTANTE: Esta integração usa endpoints internos da Rappi que podem
 * mudar sem aviso. Se retornar null, o comparador usará apenas dados do iFood.
 */

const axios = require('axios');

const BASE = 'https://services.rappi.com.br';
const BASE_BR = 'https://rappi.com.br';

// Headers que simulam o app web da Rappi
const HEADERS = {
  'accept': 'application/json',
  'accept-language': 'pt-BR,pt;q=0.9',
  'content-type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
  'x-device-id': 'web-rappi-br-001',
};

const TIMEOUT = 12000;

// Token de sessão anônima — a Rappi permite browsing sem login
let sessionToken = null;
let tokenExpira = 0;

/**
 * Obtém token de sessão anônima da Rappi
 */
async function obterToken() {
  if (sessionToken && Date.now() < tokenExpira) return sessionToken;

  try {
    const { data } = await axios.post(
      `${BASE}/api/ms/oauth2/anonymous`,
      { type: 'ms', is_anonymous: true },
      { headers: HEADERS, timeout: TIMEOUT }
    );
    sessionToken = data?.access_token || data?.token;
    tokenExpira = Date.now() + (data?.expires_in || 3600) * 1000;
    return sessionToken;
  } catch (err) {
    console.warn('[Rappi] Erro ao obter token anônimo:', err.message);
    return null;
  }
}

/**
 * Busca supermercados próximos via API da Rappi
 */
async function buscarSupermercados(lat, lon) {
  const token = await obterToken();

  const authHeaders = token
    ? { ...HEADERS, Authorization: `Bearer ${token}` }
    : HEADERS;

  try {
    const { data } = await axios.get(`${BASE}/api/ms/dynamic-home/stores`, {
      params: {
        lat,
        lng: lon,
        limit: 5,
        store_type: 'supermarket',
      },
      headers: authHeaders,
      timeout: TIMEOUT,
    });
    return data?.stores || data?.data?.stores || [];
  } catch (err) {
    // Tenta endpoint alternativo
    try {
      const { data } = await axios.post(
        `${BASE}/api/ms/stores/v2/store-list`,
        { lat, lng: lon, store_type: 3, offset: 0, limit: 5 },
        { headers: authHeaders, timeout: TIMEOUT }
      );
      return data?.stores || [];
    } catch (err2) {
      console.warn('[Rappi] Erro ao buscar supermercados:', err2.message);
      return null;
    }
  }
}

/**
 * Busca um item no catálogo de um supermercado da Rappi
 */
async function buscarItemNoSupermercado(storeId, query) {
  const token = await obterToken();
  const authHeaders = token
    ? { ...HEADERS, Authorization: `Bearer ${token}` }
    : HEADERS;

  try {
    const { data } = await axios.get(`${BASE}/api/ms/catalog-v1/product-search`, {
      params: {
        store_id: storeId,
        query,
        limit: 5,
        offset: 0,
      },
      headers: authHeaders,
      timeout: TIMEOUT,
    });
    return data?.results || data?.products || [];
  } catch (err) {
    try {
      const { data } = await axios.post(
        `${BASE}/api/ms/search/v1`,
        { storeId, searchTerm: query, limit: 5 },
        { headers: authHeaders, timeout: TIMEOUT }
      );
      return data?.results || [];
    } catch {
      return null;
    }
  }
}

/**
 * Normaliza dados de produto da Rappi para formato padrão
 */
function normalizarProduto(produto) {
  return {
    description: produto.name || produto.description || produto.product_name,
    price: produto.price || produto.real_price || produto.unit_price || 0,
    logoUrl: produto.image || produto.image_url || null,
  };
}

/**
 * Busca preços de todos os itens nos supermercados Rappi próximos ao endereço.
 * Retorna objeto com dados por loja, ou null se Rappi não estiver acessível.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {Array<{id: string, nome: string, quantidade: number, unidade: string}>} itens
 * @returns {Promise<object|null>}
 */
async function buscarPrecos(lat, lon, itens) {
  const supermercados = await buscarSupermercados(lat, lon);
  if (!supermercados) return null;
  if (supermercados.length === 0) return {};

  const lojas = {};

  for (const mercado of supermercados.slice(0, 4)) {
    const storeId = mercado.id || mercado.store_id || mercado.storeId;
    const loja = {
      plataforma: 'rappi',
      id: `rappi_${storeId}`,
      nome: mercado.name || mercado.store_name || 'Supermercado',
      logo: mercado.logo || mercado.image || null,
      taxa_entrega: mercado.delivery_fee || mercado.deliveryFee || 0,
      tempo_entrega_min: mercado.delivery_time || mercado.deliveryTime || 45,
      avaliacao: mercado.rating || null,
      itens: {},
    };

    for (const item of itens) {
      const produtos = await buscarItemNoSupermercado(storeId, item.nome);

      if (produtos && produtos.length > 0) {
        const normalizados = produtos.map(normalizarProduto).filter(p => p.price > 0);
        if (normalizados.length === 0) {
          loja.itens[item.id] = { encontrado: false };
          continue;
        }

        const candidatos = normalizados.filter(p =>
          p.description?.toLowerCase().includes(item.nome.toLowerCase()) ||
          item.nome.toLowerCase().includes(p.description?.toLowerCase()?.split(' ')[0])
        );
        const lista = candidatos.length > 0 ? candidatos : normalizados;
        const maisBarato = lista.reduce((min, p) =>
          (p.price < min.price ? p : min), lista[0]);

        loja.itens[item.id] = {
          encontrado: true,
          nome_produto: maisBarato.description,
          preco_unitario: maisBarato.price,
          preco_total: maisBarato.price * item.quantidade,
          quantidade: item.quantidade,
          unidade: item.unidade,
          imagem: maisBarato.logoUrl,
        };
      } else {
        loja.itens[item.id] = { encontrado: false };
      }
    }

    lojas[`rappi_${storeId}`] = loja;
  }

  return lojas;
}

module.exports = { buscarPrecos };
