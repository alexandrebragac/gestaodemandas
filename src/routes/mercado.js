/**
 * Rotas REST para o módulo de lista de compras e comparação de preços.
 *
 * Base: /api/mercado
 *
 * Listas:
 *   GET    /listas               — listar todas as listas
 *   POST   /listas               — criar lista
 *   GET    /listas/:id           — detalhar lista com itens
 *   PUT    /listas/:id           — atualizar lista
 *   DELETE /listas/:id           — remover lista
 *
 * Itens:
 *   POST   /listas/:id/itens     — adicionar item à lista
 *   PUT    /itens/:itemId        — editar item
 *   DELETE /itens/:itemId        — remover item
 *
 * Comparação:
 *   POST   /listas/:id/comparar  — disparar comparação de preços
 *   GET    /listas/:id/comparacao — última comparação salva
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');

const { compararPrecos } = require('../services/comparadorPrecos');
const { cepParaCoordenadas } = require('../services/ifood');

// ── Helpers ──────────────────────────────────────────────────────────────────

function db() { return getDb(); }

function listaComItens(id) {
  const lista = db().prepare('SELECT * FROM listas_mercado WHERE id = ?').get(id);
  if (!lista) return null;
  lista.itens = db().prepare(
    'SELECT * FROM itens_lista_mercado WHERE lista_id = ? ORDER BY criado_em ASC'
  ).all(id);
  return lista;
}

// ── Listas ───────────────────────────────────────────────────────────────────

// GET /api/mercado/listas
router.get('/listas', (req, res) => {
  const listas = db().prepare(`
    SELECT l.*,
           COUNT(i.id) as total_itens
    FROM listas_mercado l
    LEFT JOIN itens_lista_mercado i ON i.lista_id = l.id
    GROUP BY l.id
    ORDER BY l.atualizado_em DESC
  `).all();
  res.json(listas);
});

// POST /api/mercado/listas
router.post('/listas', (req, res) => {
  const { nome, descricao } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome da lista é obrigatório' });

  const id = uuidv4();
  db().prepare(
    'INSERT INTO listas_mercado (id, nome, descricao) VALUES (?, ?, ?)'
  ).run(id, nome.trim(), descricao?.trim() || null);

  res.status(201).json(listaComItens(id));
});

// GET /api/mercado/listas/:id
router.get('/listas/:id', (req, res) => {
  const lista = listaComItens(req.params.id);
  if (!lista) return res.status(404).json({ erro: 'Lista não encontrada' });
  res.json(lista);
});

// PUT /api/mercado/listas/:id
router.put('/listas/:id', (req, res) => {
  const { nome, descricao, status } = req.body;
  const lista = db().prepare('SELECT id FROM listas_mercado WHERE id = ?').get(req.params.id);
  if (!lista) return res.status(404).json({ erro: 'Lista não encontrada' });

  const campos = [];
  const vals = [];

  if (nome !== undefined) { campos.push('nome = ?'); vals.push(nome.trim()); }
  if (descricao !== undefined) { campos.push('descricao = ?'); vals.push(descricao?.trim() || null); }
  if (status !== undefined) { campos.push('status = ?'); vals.push(status); }

  if (campos.length === 0) return res.status(400).json({ erro: 'Nenhum campo para atualizar' });

  campos.push('atualizado_em = datetime(\'now\')');
  vals.push(req.params.id);

  db().prepare(`UPDATE listas_mercado SET ${campos.join(', ')} WHERE id = ?`).run(...vals);
  res.json(listaComItens(req.params.id));
});

// DELETE /api/mercado/listas/:id
router.delete('/listas/:id', (req, res) => {
  const r = db().prepare('DELETE FROM listas_mercado WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ erro: 'Lista não encontrada' });
  res.json({ ok: true });
});

// ── Itens ─────────────────────────────────────────────────────────────────────

// POST /api/mercado/listas/:id/itens
router.post('/listas/:id/itens', (req, res) => {
  const lista = db().prepare('SELECT id FROM listas_mercado WHERE id = ?').get(req.params.id);
  if (!lista) return res.status(404).json({ erro: 'Lista não encontrada' });

  const { nome, quantidade = 1, unidade = 'un', observacao } = req.body;
  if (!nome?.trim()) return res.status(400).json({ erro: 'Nome do item é obrigatório' });

  const id = uuidv4();
  db().prepare(
    'INSERT INTO itens_lista_mercado (id, lista_id, nome, quantidade, unidade, observacao) VALUES (?,?,?,?,?,?)'
  ).run(id, req.params.id, nome.trim(), Number(quantidade) || 1, unidade.trim() || 'un', observacao?.trim() || null);

  // Atualiza timestamp da lista
  db().prepare("UPDATE listas_mercado SET atualizado_em = datetime('now') WHERE id = ?").run(req.params.id);

  res.status(201).json(db().prepare('SELECT * FROM itens_lista_mercado WHERE id = ?').get(id));
});

// PUT /api/mercado/itens/:itemId
router.put('/itens/:itemId', (req, res) => {
  const item = db().prepare('SELECT * FROM itens_lista_mercado WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado' });

  const { nome, quantidade, unidade, observacao } = req.body;
  const campos = [];
  const vals = [];

  if (nome !== undefined) { campos.push('nome = ?'); vals.push(nome.trim()); }
  if (quantidade !== undefined) { campos.push('quantidade = ?'); vals.push(Number(quantidade)); }
  if (unidade !== undefined) { campos.push('unidade = ?'); vals.push(unidade.trim()); }
  if (observacao !== undefined) { campos.push('observacao = ?'); vals.push(observacao?.trim() || null); }

  if (campos.length === 0) return res.status(400).json({ erro: 'Nenhum campo para atualizar' });

  vals.push(req.params.itemId);
  db().prepare(`UPDATE itens_lista_mercado SET ${campos.join(', ')} WHERE id = ?`).run(...vals);

  db().prepare("UPDATE listas_mercado SET atualizado_em = datetime('now') WHERE id = ?").run(item.lista_id);

  res.json(db().prepare('SELECT * FROM itens_lista_mercado WHERE id = ?').get(req.params.itemId));
});

// DELETE /api/mercado/itens/:itemId
router.delete('/itens/:itemId', (req, res) => {
  const item = db().prepare('SELECT lista_id FROM itens_lista_mercado WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado' });

  db().prepare('DELETE FROM itens_lista_mercado WHERE id = ?').run(req.params.itemId);
  db().prepare("UPDATE listas_mercado SET atualizado_em = datetime('now') WHERE id = ?").run(item.lista_id);

  res.json({ ok: true });
});

// ── Comparação de Preços ──────────────────────────────────────────────────────

// POST /api/mercado/listas/:id/comparar
router.post('/listas/:id/comparar', async (req, res) => {
  const lista = listaComItens(req.params.id);
  if (!lista) return res.status(404).json({ erro: 'Lista não encontrada' });
  if (!lista.itens?.length) return res.status(400).json({ erro: 'Lista está vazia' });

  const { cep, lat, lon } = req.body;

  // Resolve coordenadas
  let coords = null;

  if (lat && lon) {
    coords = { lat: parseFloat(lat), lon: parseFloat(lon), endereco: 'Coordenadas informadas' };
  } else if (cep) {
    coords = await cepParaCoordenadas(cep);
    if (!coords) {
      return res.status(400).json({ erro: 'CEP inválido ou não encontrado. Informe um CEP válido.' });
    }
  } else {
    return res.status(400).json({ erro: 'Informe o CEP ou as coordenadas (lat/lon) para buscar preços.' });
  }

  try {
    const resultado = await compararPrecos({
      lat: coords.lat,
      lon: coords.lon,
      itens: lista.itens,
    });

    resultado.endereco = coords.endereco;

    // Salva resultado no banco (cache)
    const compId = uuidv4();
    db().prepare(
      'INSERT INTO comparacoes_mercado (id, lista_id, cep, lat, lon, resultado_json) VALUES (?,?,?,?,?,?)'
    ).run(compId, lista.id, cep || null, coords.lat, coords.lon, JSON.stringify(resultado));

    res.json({ id: compId, lista_id: lista.id, ...resultado });
  } catch (err) {
    console.error('[Mercado] Erro na comparação:', err);
    res.status(500).json({ erro: 'Erro ao buscar preços. Tente novamente.' });
  }
});

// GET /api/mercado/listas/:id/comparacao
router.get('/listas/:id/comparacao', (req, res) => {
  const comp = db().prepare(
    'SELECT * FROM comparacoes_mercado WHERE lista_id = ? ORDER BY criado_em DESC LIMIT 1'
  ).get(req.params.id);

  if (!comp) return res.status(404).json({ erro: 'Nenhuma comparação realizada para esta lista' });

  res.json({
    id: comp.id,
    lista_id: comp.lista_id,
    cep: comp.cep,
    criado_em: comp.criado_em,
    ...JSON.parse(comp.resultado_json),
  });
});

module.exports = router;
