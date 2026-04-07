/**
 * Serviço de integração com iFood (API não-oficial / reverse-engineered)
 * Busca supermercados e preços de itens próximos ao CEP do usuário.
 *
 * IMPORTANTE: Esta integração usa endpoints internos do iFood que podem
 * mudar sem aviso. Se retornar null, o comparador usará apenas dados da Rappi.
 */

const axios = require('axios');

const BASE = 'https://marketplace.ifood.com.br';

// Headers que simulam o app mobile do iFood
const HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'pt-BR,pt;q=0.9',
  'app_version': '10.10.10',
  'platform': 'IOS',
  'device-id': 'e3a8f2b1-4c7d-4e9f-a012-bcde56789012',
  'cache-control': 'no-cache',
  'User-Agent': 'iFood/10.10.10 (iPhone; iOS 16.0; Scale/3.00)',
};

const TIMEOUT = 12000;

/**
 * Converte CEP em coordenadas via API pública (ViaCEP + Nominatim)
 */
async function cepParaCoordenadas(cep) {
  const cepLimpo = cep.replace(/\D/g, '');
  try {
    // Primeiro pega endereço via ViaCEP
    const viaCep = await axios.get(`https://viacep.com.br/ws/${cepLimpo}/json/`, { timeout: 8000 });
    if (viaCep.data?.erro) throw new Error('CEP não encontrado');

    const { logradouro, localidade, uf } = viaCep.data;
    const query = encodeURIComponent(`${logradouro}, ${localidade}, ${uf}, Brazil`);

    // Depois geocodifica via Nominatim (OpenStreetMap)
    const nominatim = await axios.get(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`,
      { timeout: 8000, headers: { 'User-Agent': 'GestaoMercado/1.0' } }
    );
    if (!nominatim.data?.length) throw new Error('Não foi possível geocodificar o endereço');

    return {
      lat: parseFloat(nominatim.data[0].lat),
      lon: parseFloat(nominatim.data[0].lon),
      endereco: `${localidade} - ${uf}`,
    };
  } catch (err) {
    console.warn('[iFood] Erro ao geocodificar CEP:', err.message);
    return null;
  }
}

/**
 * Busca supermercados próximos via API do iFood
 */
async function buscarSupermercados(lat, lon) {
  try {
    const { data } = await axios.get(`${BASE}/v2/merchants`, {
      params: {
        lat,
        long: lon,
        channel: 'IFOOD',
        size: 5,
        category: 'MERCADO',
        sort: 'best_match',
      },
      headers: HEADERS,
      timeout: TIMEOUT,
    });
    return data?.merchants || [];
  } catch (err) {
    console.warn('[iFood] Erro ao buscar supermercados:', err.message);
    return null;
  }
}

/**
 * Busca um item no catálogo de um supermercado específico
 */
async function buscarItemNoSupermercado(merchantId, query) {
  try {
    const { data } = await axios.post(
      `${BASE}/v1/merchant/${merchantId}/catalog/search`,
      { query, size: 5 },
      { headers: { ...HEADERS, 'content-type': 'application/json' }, timeout: TIMEOUT }
    );
    return data?.items || [];
  } catch (err) {
    // Tenta endpoint alternativo
    try {
      const { data } = await axios.get(`${BASE}/v1/merchant/${merchantId}/catalog`, {
        params: { search: query, size: 5 },
        headers: HEADERS,
        timeout: TIMEOUT,
      });
      return data?.items || [];
    } catch {
      return null;
    }
  }
}

/**
 * Busca preços de todos os itens nos supermercados iFood próximos ao endereço.
 * Retorna objeto com dados por loja, ou null se iFood não estiver acessível.
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
    const loja = {
      plataforma: 'ifood',
      id: mercado.id,
      nome: mercado.name || mercado.alias || 'Supermercado',
      logo: mercado.logoUrl || null,
      taxa_entrega: mercado.deliveryFee?.value ?? mercado.deliveryFee ?? 0,
      tempo_entrega_min: mercado.deliveryTime ?? 45,
      avaliacao: mercado.userRating ?? null,
      itens: {},
    };

    for (const item of itens) {
      const produtos = await buscarItemNoSupermercado(mercado.id, item.nome);

      if (produtos && produtos.length > 0) {
        // Pega o mais barato que contenha o nome do item
        const candidatos = produtos.filter(p =>
          p.description?.toLowerCase().includes(item.nome.toLowerCase()) ||
          item.nome.toLowerCase().includes(p.description?.toLowerCase()?.split(' ')[0])
        );
        const lista = candidatos.length > 0 ? candidatos : produtos;
        const maisBarato = lista.reduce((min, p) =>
          (p.price < min.price ? p : min), lista[0]);

        loja.itens[item.id] = {
          encontrado: true,
          nome_produto: maisBarato.description,
          preco_unitario: maisBarato.price,
          preco_total: maisBarato.price * item.quantidade,
          quantidade: item.quantidade,
          unidade: item.unidade,
          imagem: maisBarato.logoUrl || null,
        };
      } else {
        loja.itens[item.id] = { encontrado: false };
      }
    }

    lojas[mercado.id] = loja;
  }

  return lojas;
}

module.exports = { buscarPrecos, cepParaCoordenadas };
