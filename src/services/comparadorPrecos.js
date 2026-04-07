/**
 * Algoritmo de comparação e otimização de compras entre iFood e Rappi.
 *
 * Recebe os preços de todas as lojas das duas plataformas e calcula:
 *  1. Melhor loja única no iFood
 *  2. Melhor loja única na Rappi
 *  3. Melhor combinação mista (item a item, considerando taxas de entrega)
 *  4. Recomendação final com justificativa
 */

const ifoodService = require('./ifood');
const rappiService = require('./rappi');

/**
 * Formata valor em reais
 */
function moeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Calcula o total de uma loja para um conjunto de itens
 */
function calcularTotalLoja(loja, itens) {
  let subtotal = 0;
  let itensEncontrados = 0;
  const detalhes = {};

  for (const item of itens) {
    const resultado = loja.itens[item.id];
    if (resultado?.encontrado) {
      subtotal += resultado.preco_total;
      itensEncontrados++;
      detalhes[item.id] = resultado;
    } else {
      detalhes[item.id] = { encontrado: false };
    }
  }

  return {
    subtotal,
    taxa_entrega: loja.taxa_entrega,
    total: subtotal + loja.taxa_entrega,
    itens_encontrados: itensEncontrados,
    itens_total: itens.length,
    cobertura_pct: itens.length > 0 ? Math.round((itensEncontrados / itens.length) * 100) : 0,
    detalhes,
  };
}

/**
 * Encontra a melhor loja (menor total) de um conjunto de lojas
 * para os itens fornecidos. Só considera lojas com ≥ 70% dos itens.
 */
function melhorLoja(lojas, itens) {
  let melhor = null;

  for (const loja of Object.values(lojas)) {
    const resultado = calcularTotalLoja(loja, itens);

    // Só considera se tiver pelo menos 70% dos itens
    if (resultado.cobertura_pct < 70 && itens.length > 2) continue;

    if (!melhor || resultado.total < melhor.calc.total) {
      melhor = { loja, calc: resultado };
    }
  }

  return melhor;
}

/**
 * Calcula o cenário de compra mista (melhor preço por item independente de loja).
 * Agrupa itens por loja e soma as taxas de entrega das lojas utilizadas.
 */
function calcularCenarioMisto(todasLojas, itens) {
  // Para cada item, encontra o menor preço entre todas as lojas
  const melhorPorItem = {};

  for (const item of itens) {
    let melhorPreco = null;
    let melhorLojaDados = null;

    for (const loja of Object.values(todasLojas)) {
      const dadosItem = loja.itens[item.id];
      if (!dadosItem?.encontrado) continue;

      if (!melhorPreco || dadosItem.preco_total < melhorPreco) {
        melhorPreco = dadosItem.preco_total;
        melhorLojaDados = {
          loja_id: loja.id,
          loja_nome: loja.nome,
          plataforma: loja.plataforma,
          taxa_entrega: loja.taxa_entrega,
          ...dadosItem,
        };
      }
    }

    if (melhorLojaDados) {
      melhorPorItem[item.id] = { item, resultado: melhorLojaDados };
    }
  }

  // Agrupa por loja para calcular as taxas de entrega únicas
  const lojasPedido = {};
  let subtotalItens = 0;
  let itensNaoEncontrados = [];

  for (const item of itens) {
    if (!melhorPorItem[item.id]) {
      itensNaoEncontrados.push(item);
      continue;
    }

    const { resultado } = melhorPorItem[item.id];
    subtotalItens += resultado.preco_total;

    if (!lojasPedido[resultado.loja_id]) {
      lojasPedido[resultado.loja_id] = {
        loja_id: resultado.loja_id,
        loja_nome: resultado.loja_nome,
        plataforma: resultado.plataforma,
        taxa_entrega: resultado.taxa_entrega,
        itens: [],
        subtotal: 0,
      };
    }
    lojasPedido[resultado.loja_id].itens.push({
      item_id: item.id,
      item_nome: item.nome,
      ...resultado,
    });
    lojasPedido[resultado.loja_id].subtotal += resultado.preco_total;
  }

  const totalTaxas = Object.values(lojasPedido).reduce(
    (acc, l) => acc + l.taxa_entrega, 0
  );

  return {
    itens_por_loja: Object.values(lojasPedido),
    melhor_por_item: melhorPorItem,
    subtotal_itens: subtotalItens,
    total_taxas: totalTaxas,
    total: subtotalItens + totalTaxas,
    itens_nao_encontrados: itensNaoEncontrados,
    num_pedidos: Object.keys(lojasPedido).length,
    itens_encontrados: Object.keys(melhorPorItem).length,
    itens_total: itens.length,
    cobertura_pct: itens.length > 0
      ? Math.round((Object.keys(melhorPorItem).length / itens.length) * 100)
      : 0,
  };
}

/**
 * Gera a recomendação final comparando os cenários.
 */
function gerarRecomendacao(cenarioIfood, cenarioRappi, cenarioMisto, itens) {
  const cenarios = [];

  if (cenarioIfood) {
    cenarios.push({
      tipo: 'ifood_unica',
      label: `Tudo no iFood (${cenarioIfood.loja.nome})`,
      plataforma: 'ifood',
      total: cenarioIfood.calc.total,
      num_pedidos: 1,
      cobertura_pct: cenarioIfood.calc.cobertura_pct,
    });
  }

  if (cenarioRappi) {
    cenarios.push({
      tipo: 'rappi_unica',
      label: `Tudo na Rappi (${cenarioRappi.loja.nome})`,
      plataforma: 'rappi',
      total: cenarioRappi.calc.total,
      num_pedidos: 1,
      cobertura_pct: cenarioRappi.calc.cobertura_pct,
    });
  }

  if (cenarioMisto && cenarioMisto.num_pedidos > 1) {
    cenarios.push({
      tipo: 'misto',
      label: `Compra dividida (${cenarioMisto.num_pedidos} pedidos)`,
      plataforma: 'misto',
      total: cenarioMisto.total,
      num_pedidos: cenarioMisto.num_pedidos,
      cobertura_pct: cenarioMisto.cobertura_pct,
    });
  }

  if (cenarios.length === 0) {
    return {
      tipo: 'sem_dados',
      mensagem: 'Não foi possível obter preços das plataformas. Tente novamente mais tarde.',
    };
  }

  // Ordena por total (menor primeiro), mas penaliza por cobertura < 100%
  cenarios.sort((a, b) => {
    // Se cobertura muito diferente, prefere o com maior cobertura
    if (Math.abs(a.cobertura_pct - b.cobertura_pct) > 20) {
      return b.cobertura_pct - a.cobertura_pct;
    }
    return a.total - b.total;
  });

  const melhor = cenarios[0];
  const segundo = cenarios[1];

  let mensagem = '';
  let economia = 0;

  if (segundo) {
    economia = segundo.total - melhor.total;
    const economiaStr = moeda(economia);

    if (melhor.tipo === 'misto' && economia < 5) {
      // Economia pequena com múltiplos pedidos — não vale a pena
      const alternativa = cenarios.find(c => c.tipo !== 'misto');
      if (alternativa) {
        return {
          tipo: alternativa.tipo,
          plataforma: alternativa.plataforma,
          mensagem: `Faça tudo em um único pedido. A economia com pedido dividido seria apenas ${economiaStr}, não vale a complexidade de 2 entregas.`,
          economia_vs_pior: moeda(cenarios[cenarios.length - 1].total - alternativa.total),
          cenarios,
        };
      }
    }

    if (melhor.tipo === 'misto') {
      mensagem = `Dividindo a compra você economiza ${economiaStr} vs a segunda melhor opção. Serão ${melhor.num_pedidos} pedidos separados.`;
    } else {
      mensagem = `${melhor.label} é a melhor opção, economizando ${economiaStr} vs ${segundo.label}.`;
    }
  } else {
    mensagem = `${melhor.label} é a única opção disponível.`;
  }

  return {
    tipo: melhor.tipo,
    plataforma: melhor.plataforma,
    mensagem,
    economia_vs_segundo: economia > 0 ? moeda(economia) : null,
    cenarios,
  };
}

/**
 * Ponto de entrada principal: busca preços nas duas plataformas e retorna
 * a análise completa com recomendação.
 */
async function compararPrecos({ lat, lon, itens }) {
  console.log(`[Comparador] Buscando preços para ${itens.length} item(ns) em lat=${lat}, lon=${lon}`);

  // Busca nas duas plataformas em paralelo
  const [lojasIfood, lojasRappi] = await Promise.all([
    ifoodService.buscarPrecos(lat, lon, itens).catch(err => {
      console.warn('[Comparador] iFood falhou:', err.message);
      return null;
    }),
    rappiService.buscarPrecos(lat, lon, itens).catch(err => {
      console.warn('[Comparador] Rappi falhou:', err.message);
      return null;
    }),
  ]);

  const todasLojas = {
    ...(lojasIfood || {}),
    ...(lojasRappi || {}),
  };

  const temDados = Object.keys(todasLojas).length > 0;

  // Cenário 1: Melhor loja única no iFood
  const melhorIfood = lojasIfood && Object.keys(lojasIfood).length > 0
    ? melhorLoja(lojasIfood, itens)
    : null;

  // Cenário 2: Melhor loja única na Rappi
  const melhorRappi = lojasRappi && Object.keys(lojasRappi).length > 0
    ? melhorLoja(lojasRappi, itens)
    : null;

  // Cenário 3: Compra mista (melhor preço por item)
  const cenarioMisto = temDados ? calcularCenarioMisto(todasLojas, itens) : null;

  // Recomendação
  const recomendacao = gerarRecomendacao(melhorIfood, melhorRappi, cenarioMisto, itens);

  return {
    status: temDados ? 'ok' : 'sem_dados',
    plataformas: {
      ifood: lojasIfood !== null ? 'ok' : 'indisponivel',
      rappi: lojasRappi !== null ? 'ok' : 'indisponivel',
    },
    lojas: todasLojas,
    cenarios: {
      melhor_ifood: melhorIfood
        ? { loja: melhorIfood.loja, ...melhorIfood.calc }
        : null,
      melhor_rappi: melhorRappi
        ? { loja: melhorRappi.loja, ...melhorRappi.calc }
        : null,
      misto: cenarioMisto,
    },
    recomendacao,
    gerado_em: new Date().toISOString(),
  };
}

module.exports = { compararPrecos };
