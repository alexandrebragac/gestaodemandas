const express = require('express');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');
const whatsappService = require('../services/whatsapp');
const lembreteService = require('../services/lembretes');
const clickupService = require('../services/clickup');

const router = express.Router();

const STATUS = {
  PENDENTE_ACEITE: 'pendente_aceite',
  EM_NEGOCIACAO: 'em_negociacao',
  ACEITA: 'aceita',
  EM_ANDAMENTO: 'em_andamento',
  CONCLUIDA_AGUARDANDO_BAIXA: 'concluida_aguardando_baixa',
  FINALIZADA: 'finalizada',
};

function demandaComUsuarios(demanda) {
  if (!demanda) return null;
  const db = getDb();
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);
  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  return { ...demanda, solicitante, responsavel };
}

// GET /demandas
router.get('/', (req, res) => {
  const db = getDb();
  const { status, solicitante_id, responsavel_id } = req.query;

  let sql = 'SELECT * FROM demandas WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (solicitante_id) { sql += ' AND solicitante_id = ?'; params.push(solicitante_id); }
  if (responsavel_id) { sql += ' AND responsavel_id = ?'; params.push(responsavel_id); }

  sql += ' ORDER BY criado_em DESC';
  const demandas = db.prepare(sql).all(...params);
  res.json(demandas.map(demandaComUsuarios));
});

// GET /demandas/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });
  res.json(demandaComUsuarios(demanda));
});

// POST /demandas
router.post('/', async (req, res) => {
  const { solicitante_id, responsavel_id, descricao, data_entrega, horario_entrega } = req.body;
  if (!solicitante_id || !responsavel_id || !descricao || !data_entrega) {
    return res.status(400).json({ erro: 'solicitante_id, responsavel_id, descricao e data_entrega são obrigatórios' });
  }

  const db = getDb();
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(solicitante_id);
  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(responsavel_id);

  if (!solicitante) return res.status(404).json({ erro: 'Solicitante não encontrado' });
  if (!responsavel) return res.status(404).json({ erro: 'Responsável não encontrado' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO demandas (id, solicitante_id, responsavel_id, descricao, data_entrega, horario_entrega, origem)
    VALUES (?, ?, ?, ?, ?, ?, 'web')
  `).run(id, solicitante_id, responsavel_id, descricao.trim(), data_entrega, horario_entrega || null);

  // Registra mensagem de criação
  const msgId = uuidv4();
  const conteudo = `Nova demanda criada por ${solicitante.nome}:\n\n"${descricao}"\n\nPrazo de entrega: ${data_entrega}`;
  db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?, ?, ?, 'criacao', ?)`)
    .run(msgId, id, solicitante_id, conteudo);

  // Agenda lembretes para responsável
  lembreteService.agendarLembretes(id, data_entrega);

  // Cria tarefa no ClickUp (se configurado)
  let clickup_url = null;
  try {
    clickup_url = await clickupService.criarTarefa({ descricao, data_entrega, horario_entrega, solicitante, responsavel });
    if (clickup_url) {
      db.prepare('UPDATE demandas SET clickup_url = ? WHERE id = ?').run(clickup_url, id);
    }
  } catch (err) {
    console.error('[ClickUp] Erro ao criar tarefa:', err.message);
  }

  // Notifica responsável via WhatsApp
  let whatsappErro = null;
  try {
    await whatsappService.notificarNovaDeamanda(responsavel, solicitante, { id, descricao, data_entrega, horario_entrega: horario_entrega || null, clickup_url });
  } catch (err) {
    whatsappErro = err.message;
    console.error('[WhatsApp] Falha ao notificar nova demanda:', err.message);
  }

  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(id);
  const resposta = demandaComUsuarios(demanda);
  if (whatsappErro) resposta._whatsapp_erro = whatsappErro;
  res.status(201).json(resposta);
});

// PUT /demandas/:id
router.put('/:id', async (req, res) => {
  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });

  const campos = ['descricao', 'data_entrega', 'horario_entrega', 'data_acordada', 'status'];
  const updates = [];
  const values = [];

  for (const campo of campos) {
    if (req.body[campo] !== undefined) {
      updates.push(`${campo} = ?`);
      values.push(req.body[campo]);
    }
  }

  if (updates.length === 0) return res.status(400).json({ erro: 'Nenhum campo para atualizar' });

  updates.push("atualizado_em = datetime('now')");
  values.push(req.params.id);

  db.prepare(`UPDATE demandas SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const atualizada = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  res.json(demandaComUsuarios(atualizada));
});

// POST /demandas/:id/aceitar
router.post('/:id/aceitar', async (req, res) => {
  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });

  const { usuario_id } = req.body;
  if (usuario_id && usuario_id !== demanda.responsavel_id) {
    return res.status(403).json({ erro: 'Apenas o responsável pode aceitar esta demanda' });
  }

  if (![STATUS.PENDENTE_ACEITE, STATUS.EM_NEGOCIACAO].includes(demanda.status)) {
    return res.status(400).json({ erro: `Não é possível aceitar uma demanda com status "${demanda.status}"` });
  }

  const dataAcordada = req.body.data_acordada || demanda.data_entrega;
  db.prepare(`
    UPDATE demandas SET status = 'aceita', data_acordada = ?, atualizado_em = datetime('now') WHERE id = ?
  `).run(dataAcordada, demanda.id);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);

  // Reagenda lembretes com data acordada
  db.prepare('DELETE FROM lembretes WHERE demanda_id = ? AND enviado = 0').run(demanda.id);
  lembreteService.agendarLembretes(demanda.id, dataAcordada);

  await whatsappService.notificarAceite(solicitante, responsavel, { ...demanda, data_acordada: dataAcordada });

  const atualizada = db.prepare('SELECT * FROM demandas WHERE id = ?').get(demanda.id);
  res.json(demandaComUsuarios(atualizada));
});

// POST /demandas/:id/propor-prazo
router.post('/:id/propor-prazo', async (req, res) => {
  const { nova_data, observacao } = req.body;
  if (!nova_data) return res.status(400).json({ erro: 'nova_data é obrigatório' });

  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });

  db.prepare(`UPDATE demandas SET status = 'em_negociacao', data_acordada = ?, atualizado_em = datetime('now') WHERE id = ?`)
    .run(nova_data, demanda.id);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);

  const msgId = uuidv4();
  const conteudo = `${responsavel.nome} propôs novo prazo: ${nova_data}${observacao ? `\nObs: ${observacao}` : ''}`;
  db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?, ?, ?, 'resposta', ?)`)
    .run(msgId, demanda.id, demanda.responsavel_id, conteudo);

  await whatsappService.notificarNovoPrazo(solicitante, responsavel, { ...demanda, nova_data, observacao });

  const atualizada = db.prepare('SELECT * FROM demandas WHERE id = ?').get(demanda.id);
  res.json(demandaComUsuarios(atualizada));
});

// POST /demandas/:id/concluir
router.post('/:id/concluir', async (req, res) => {
  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });

  const { usuario_id } = req.body;
  if (usuario_id && usuario_id !== demanda.responsavel_id) {
    return res.status(403).json({ erro: 'Apenas o responsável pode concluir esta demanda' });
  }

  if (![STATUS.ACEITA, STATUS.EM_ANDAMENTO].includes(demanda.status)) {
    return res.status(400).json({ erro: `Não é possível concluir uma demanda com status "${demanda.status}"` });
  }

  db.prepare(`UPDATE demandas SET status = 'concluida_aguardando_baixa', atualizado_em = datetime('now') WHERE id = ?`)
    .run(demanda.id);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);

  const msgId = uuidv4();
  db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?, ?, ?, 'conclusao', ?)`)
    .run(uuidv4(), demanda.id, demanda.responsavel_id, `Demanda concluída por ${responsavel.nome}. Aguardando baixa do solicitante.`);

  await whatsappService.notificarConclusao(solicitante, responsavel, demanda);

  // Remove lembretes pendentes do responsável e agenda lembretes para solicitante
  db.prepare('DELETE FROM lembretes WHERE demanda_id = ? AND enviado = 0').run(demanda.id);
  lembreteService.agendarLembretesAguardandoBaixa(demanda.id);

  const atualizada = db.prepare('SELECT * FROM demandas WHERE id = ?').get(demanda.id);
  res.json(demandaComUsuarios(atualizada));
});

// POST /demandas/:id/baixa
router.post('/:id/baixa', async (req, res) => {
  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });

  const { usuario_id } = req.body;
  if (usuario_id && usuario_id !== demanda.solicitante_id) {
    return res.status(403).json({ erro: 'Apenas o solicitante pode dar baixa nesta demanda' });
  }

  if (demanda.status !== STATUS.CONCLUIDA_AGUARDANDO_BAIXA) {
    return res.status(400).json({ erro: `Não é possível dar baixa em uma demanda com status "${demanda.status}"` });
  }

  db.prepare(`UPDATE demandas SET status = 'finalizada', atualizado_em = datetime('now') WHERE id = ?`)
    .run(demanda.id);

  db.prepare('DELETE FROM lembretes WHERE demanda_id = ? AND enviado = 0').run(demanda.id);

  const responsavel = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.responsavel_id);
  const solicitante = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(demanda.solicitante_id);

  db.prepare(`INSERT INTO mensagens (id, demanda_id, remetente_id, tipo, conteudo) VALUES (?, ?, ?, 'baixa', ?)`)
    .run(uuidv4(), demanda.id, demanda.solicitante_id, `Baixa confirmada por ${solicitante.nome}. Demanda finalizada.`);

  await whatsappService.notificarBaixa(responsavel, solicitante, demanda);

  const atualizada = db.prepare('SELECT * FROM demandas WHERE id = ?').get(demanda.id);
  res.json(demandaComUsuarios(atualizada));
});

// DELETE /demandas/:id  (apenas o solicitante pode excluir)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });

  const usuario_id = req.query.usuario_id;
  if (usuario_id && usuario_id !== demanda.solicitante_id) {
    return res.status(403).json({ erro: 'Apenas o solicitante pode excluir esta demanda' });
  }

  if (demanda.status === STATUS.FINALIZADA) {
    return res.status(400).json({ erro: 'Demandas finalizadas não podem ser excluídas.' });
  }

  const excluir = db.transaction(() => {
    db.prepare('DELETE FROM lembretes WHERE demanda_id = ?').run(demanda.id);
    db.prepare('DELETE FROM mensagens WHERE demanda_id = ?').run(demanda.id);
    db.prepare('DELETE FROM demandas WHERE id = ?').run(demanda.id);
  });

  excluir();
  res.status(204).end();
});

// GET /demandas/:id/mensagens
router.get('/:id/mensagens', (req, res) => {
  const db = getDb();
  const demanda = db.prepare('SELECT * FROM demandas WHERE id = ?').get(req.params.id);
  if (!demanda) return res.status(404).json({ erro: 'Demanda não encontrada' });

  const mensagens = db.prepare(`
    SELECT m.*, u.nome as remetente_nome, u.telefone_whatsapp as remetente_telefone
    FROM mensagens m
    JOIN usuarios u ON u.id = m.remetente_id
    WHERE m.demanda_id = ?
    ORDER BY m.enviado_em ASC
  `).all(req.params.id);

  res.json(mensagens);
});

module.exports = router;
