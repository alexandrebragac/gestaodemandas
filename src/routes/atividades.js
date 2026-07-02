/**
 * Rotas do módulo de Atividades (rotina diária):
 *   Atividades (template)   — cadastro/gestão feito por quem pode_criar_atividades ou admin
 *   Ocorrências (execução)  — instância diária que o responsável executa
 *   Aprovações              — validação de conclusão / atraso / replanejamento
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const getDb = require('../database/db');
const { authMiddleware } = require('./auth');
const { processarAtividadesDoDia } = require('../services/atividadesScheduler');

const router = express.Router();
router.use(authMiddleware);

// ── Upload de evidências (foto) ─────────────────────────────────────────────
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads', 'atividades');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname || '.jpg')}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

router.post('/upload', upload.single('foto'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Arquivo de imagem inválido ou ausente' });
  res.json({ url: `/uploads/atividades/${req.file.filename}` });
});

// ── Middleware: exige permissão de gestão (admin ou pode_criar_atividades) ──
function carregarUsuarioAtual(req, res, next) {
  const db = getDb();
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.auth.id);
  if (!u) return res.status(401).json({ erro: 'Usuário não encontrado' });
  req.usuarioAtual = u;
  next();
}

function gestorOnly(req, res, next) {
  carregarUsuarioAtual(req, res, () => {
    if (req.usuarioAtual.perfil !== 'admin' && !req.usuarioAtual.pode_criar_atividades) {
      return res.status(403).json({ erro: 'Acesso restrito a gestores' });
    }
    next();
  });
}

const hojeISO = () => new Date().toISOString().slice(0, 10);

function serializeAtividade(db, atividade) {
  return {
    ...atividade,
    recorrencia_dias_semana: atividade.recorrencia_dias_semana ? JSON.parse(atividade.recorrencia_dias_semana) : null,
    checklist: db.prepare('SELECT * FROM atividade_checklist_itens WHERE atividade_id = ? ORDER BY ordem').all(atividade.id),
    campos: db.prepare('SELECT * FROM atividade_campos WHERE atividade_id = ? ORDER BY ordem')
      .all(atividade.id)
      .map(c => ({ ...c, opcoes: c.opcoes ? JSON.parse(c.opcoes) : null })),
  };
}

function serializeOcorrencia(db, oc) {
  const atividade = db.prepare('SELECT * FROM atividades WHERE id = ?').get(oc.atividade_id);
  const checklistItens = db.prepare('SELECT * FROM atividade_checklist_itens WHERE atividade_id = ? ORDER BY ordem').all(oc.atividade_id);
  const checklistExec = db.prepare('SELECT * FROM ocorrencia_checklist_itens WHERE ocorrencia_id = ?').all(oc.id);
  const campos = db.prepare('SELECT * FROM atividade_campos WHERE atividade_id = ? ORDER BY ordem').all(oc.atividade_id);
  const camposExec = db.prepare('SELECT * FROM ocorrencia_campo_valores WHERE ocorrencia_id = ?').all(oc.id);
  const responsavel = db.prepare('SELECT id, nome FROM usuarios WHERE id = ?').get(oc.responsavel_id);
  const validador = oc.validada_por ? db.prepare('SELECT id, nome FROM usuarios WHERE id = ?').get(oc.validada_por) : null;

  return {
    ...oc,
    atividade: atividade ? { ...atividade, opcoes: undefined } : null,
    responsavel,
    validador,
    checklist: checklistItens.map(item => ({
      ...item,
      execucao: checklistExec.find(e => e.item_id === item.id) || { concluido: 0, evidencia_url: null, comentario: null },
    })),
    campos: campos.map(c => ({
      ...c,
      opcoes: c.opcoes ? JSON.parse(c.opcoes) : null,
      valor: camposExec.find(v => v.campo_id === c.id) || { valor: null, evidencia_url: null },
    })),
  };
}

// ══════════════════════════════ ATIVIDADES (templates) ══════════════════════

// GET /api/atividades — lista atividades cadastradas (gestor vê as próprias; admin vê todas)
router.get('/', gestorOnly, (req, res) => {
  const db = getDb();
  const linhas = req.usuarioAtual.perfil === 'admin'
    ? db.prepare('SELECT * FROM atividades WHERE ativo = 1 ORDER BY criado_em DESC').all()
    : db.prepare('SELECT * FROM atividades WHERE ativo = 1 AND criado_por = ? ORDER BY criado_em DESC').all(req.usuarioAtual.id);

  const responsaveis = Object.fromEntries(db.prepare('SELECT id, nome FROM usuarios').all().map(u => [u.id, u.nome]));
  res.json(linhas.map(a => ({ ...serializeAtividade(db, a), responsavel_nome: responsaveis[a.responsavel_id] })));
});

// GET /api/atividades/:id
router.get('/:id', gestorOnly, (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT * FROM atividades WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
  res.json(serializeAtividade(db, a));
});

// POST /api/atividades — cria atividade + checklist + campos
router.post('/', gestorOnly, (req, res) => {
  const {
    titulo, descricao, area, tipo, formato, prioridade, responsavel_id,
    recorrencia_tipo, recorrencia_dias_semana, recorrencia_dia_mes,
    data_inicio, data_fim, horario_limite,
    exige_aprovacao, exige_foto, permite_replanejamento,
    checklist, campos,
  } = req.body;

  if (!titulo || !tipo || !responsavel_id || !data_inicio) {
    return res.status(400).json({ erro: 'titulo, tipo, responsavel_id e data_inicio são obrigatórios' });
  }
  if (!['pontual', 'recorrente'].includes(tipo)) return res.status(400).json({ erro: 'tipo inválido' });

  const recorrenciaFinal = tipo === 'pontual' ? 'unica' : (recorrencia_tipo || 'diaria');
  if (recorrenciaFinal === 'semanal' && !(recorrencia_dias_semana || []).length) {
    return res.status(400).json({ erro: 'recorrencia_dias_semana é obrigatório para recorrência semanal' });
  }
  if (recorrenciaFinal === 'mensal' && !recorrencia_dia_mes) {
    return res.status(400).json({ erro: 'recorrencia_dia_mes é obrigatório para recorrência mensal' });
  }
  if (data_fim && data_fim < data_inicio) {
    return res.status(400).json({ erro: 'data_fim não pode ser anterior a data_inicio' });
  }

  const db = getDb();
  const responsavel = db.prepare('SELECT id FROM usuarios WHERE id = ?').get(responsavel_id);
  if (!responsavel) return res.status(400).json({ erro: 'responsavel_id inválido' });

  const id = uuidv4();
  const formatoFinal = (checklist || []).length ? 'checklist' : (formato || 'simples');

  const criar = db.transaction(() => {
    db.prepare(`
      INSERT INTO atividades (
        id, titulo, descricao, area, tipo, formato, prioridade, criado_por, responsavel_id,
        recorrencia_tipo, recorrencia_dias_semana, recorrencia_dia_mes,
        data_inicio, data_fim, horario_limite, exige_aprovacao, exige_foto, permite_replanejamento
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, titulo.trim(), descricao || null, area || 'operacoes', tipo, formatoFinal, prioridade || 'media',
      req.usuarioAtual.id, responsavel_id,
      recorrenciaFinal, recorrencia_tipo === 'semanal' ? JSON.stringify(recorrencia_dias_semana) : null,
      recorrenciaFinal === 'mensal' ? recorrencia_dia_mes : null,
      data_inicio, data_fim || null, horario_limite || null,
      exige_aprovacao === false ? 0 : 1, exige_foto ? 1 : 0, permite_replanejamento === false ? 0 : 1
    );

    (checklist || []).forEach((item, i) => {
      if (!item.descricao) return;
      db.prepare('INSERT INTO atividade_checklist_itens (id, atividade_id, descricao, ordem, foto_obrigatoria) VALUES (?,?,?,?,?)')
        .run(uuidv4(), id, item.descricao.trim(), i, item.foto_obrigatoria ? 1 : 0);
    });

    (campos || []).forEach((campo, i) => {
      if (!campo.rotulo || !campo.tipo) return;
      db.prepare('INSERT INTO atividade_campos (id, atividade_id, rotulo, tipo, obrigatorio, exige_foto, opcoes, ordem) VALUES (?,?,?,?,?,?,?,?)')
        .run(uuidv4(), id, campo.rotulo.trim(), campo.tipo, campo.obrigatorio ? 1 : 0, campo.exige_foto ? 1 : 0,
          campo.opcoes ? JSON.stringify(campo.opcoes) : null, i);
    });
  });
  criar();

  // Gera já a ocorrência de hoje, se a atividade for válida para hoje (sem esperar o cron da meia-noite)
  processarAtividadesDoDia(hojeISO());

  const atividade = db.prepare('SELECT * FROM atividades WHERE id = ?').get(id);
  res.status(201).json(serializeAtividade(db, atividade));
});

// PUT /api/atividades/:id — edita atividade (apenas criador ou admin)
router.put('/:id', gestorOnly, (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT * FROM atividades WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
  if (req.usuarioAtual.perfil !== 'admin' && a.criado_por !== req.usuarioAtual.id) {
    return res.status(403).json({ erro: 'Apenas o criador ou um admin pode editar esta atividade' });
  }

  const campos = ['titulo', 'descricao', 'area', 'prioridade', 'horario_limite', 'data_fim', 'exige_aprovacao', 'exige_foto', 'permite_replanejamento', 'ativo'];
  const valores = campos.map(c => {
    if (req.body[c] === undefined) return a[c];
    if (['exige_aprovacao', 'exige_foto', 'permite_replanejamento', 'ativo'].includes(c)) return req.body[c] ? 1 : 0;
    return req.body[c];
  });
  db.prepare(`UPDATE atividades SET ${campos.map(c => `${c}=?`).join(', ')}, atualizado_em = datetime('now') WHERE id = ?`)
    .run(...valores, req.params.id);

  res.json(serializeAtividade(db, db.prepare('SELECT * FROM atividades WHERE id = ?').get(req.params.id)));
});

// DELETE /api/atividades/:id — desativa (soft delete)
router.delete('/:id', gestorOnly, (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT * FROM atividades WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
  if (req.usuarioAtual.perfil !== 'admin' && a.criado_por !== req.usuarioAtual.id) {
    return res.status(403).json({ erro: 'Apenas o criador ou um admin pode excluir esta atividade' });
  }
  db.prepare("UPDATE atividades SET ativo = 0, atualizado_em = datetime('now') WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

// ══════════════════════════════ EXECUÇÃO (ocorrências) ═══════════════════════

// GET /api/atividades/minhas/hoje — ocorrências ativas do usuário logado
router.get('/minhas/hoje', (req, res) => {
  const db = getDb();
  const linhas = db.prepare(`
    SELECT * FROM atividade_ocorrencias
    WHERE responsavel_id = ? AND status IN ('pendente','em_andamento','atrasada','aguardando_validacao')
    ORDER BY CASE status WHEN 'atrasada' THEN 0 ELSE 1 END, data_referencia ASC
  `).all(req.auth.id);
  res.json(linhas.map(oc => serializeOcorrencia(db, oc)));
});

// GET /api/atividades/minhas/pontuacao — % de cumprimento do usuário logado
router.get('/minhas/pontuacao', (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'concluida' THEN 1 ELSE 0 END) AS concluidas,
      SUM(CASE WHEN status = 'atrasada' THEN 1 ELSE 0 END) AS atrasadas,
      SUM(CASE WHEN status = 'recusada' THEN 1 ELSE 0 END) AS recusadas
    FROM atividade_ocorrencias
    WHERE responsavel_id = ? AND status IN ('concluida','atrasada','recusada')
  `).get(req.auth.id);
  const total = stats.total || 0;
  const pontuacao = total > 0 ? Math.round((stats.concluidas / total) * 100) : null;
  res.json({ ...stats, pontuacao });
});

// GET /api/atividades/ocorrencias/:id
router.get('/ocorrencias/:id', (req, res) => {
  const db = getDb();
  const oc = db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(req.params.id);
  if (!oc) return res.status(404).json({ erro: 'Ocorrência não encontrada' });
  if (oc.responsavel_id !== req.auth.id && req.auth.perfil !== 'admin') {
    const atividade = db.prepare('SELECT criado_por FROM atividades WHERE id = ?').get(oc.atividade_id);
    if (atividade?.criado_por !== req.auth.id) return res.status(403).json({ erro: 'Sem acesso a esta ocorrência' });
  }
  res.json(serializeOcorrencia(db, oc));
});

function carregarOcorrenciaDoUsuario(req, res, next) {
  const db = getDb();
  const oc = db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(req.params.id);
  if (!oc) return res.status(404).json({ erro: 'Ocorrência não encontrada' });
  if (oc.responsavel_id !== req.auth.id) return res.status(403).json({ erro: 'Esta ocorrência não é sua' });
  if (!['pendente', 'em_andamento', 'atrasada'].includes(oc.status)) {
    return res.status(409).json({ erro: 'Esta ocorrência não está mais disponível para edição' });
  }
  req.ocorrencia = oc;
  next();
}

// POST /api/atividades/ocorrencias/:id/iniciar
router.post('/ocorrencias/:id/iniciar', carregarOcorrenciaDoUsuario, (req, res) => {
  const db = getDb();
  if (req.ocorrencia.status === 'pendente') {
    db.prepare("UPDATE atividade_ocorrencias SET status = 'em_andamento', iniciada_em = datetime('now'), atualizado_em = datetime('now') WHERE id = ?")
      .run(req.ocorrencia.id);
  }
  res.json(serializeOcorrencia(db, db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(req.ocorrencia.id)));
});

// PUT /api/atividades/ocorrencias/:id/checklist/:itemId — marca/desmarca 1 passo
router.put('/ocorrencias/:id/checklist/:itemId', carregarOcorrenciaDoUsuario, (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM atividade_checklist_itens WHERE id = ? AND atividade_id = ?')
    .get(req.params.itemId, req.ocorrencia.atividade_id);
  if (!item) return res.status(404).json({ erro: 'Item de checklist não encontrado' });

  const { concluido, evidencia_url, comentario } = req.body;
  if (concluido && item.foto_obrigatoria && !evidencia_url) {
    return res.status(400).json({ erro: 'Este passo exige uma foto' });
  }

  const existente = db.prepare('SELECT id FROM ocorrencia_checklist_itens WHERE ocorrencia_id = ? AND item_id = ?')
    .get(req.ocorrencia.id, item.id);
  if (existente) {
    db.prepare(`
      UPDATE ocorrencia_checklist_itens
      SET concluido = ?, concluido_em = ?, evidencia_url = ?, comentario = ?
      WHERE id = ?
    `).run(concluido ? 1 : 0, concluido ? new Date().toISOString() : null, evidencia_url || null, comentario || null, existente.id);
  } else {
    db.prepare(`
      INSERT INTO ocorrencia_checklist_itens (id, ocorrencia_id, item_id, concluido, concluido_em, evidencia_url, comentario)
      VALUES (?,?,?,?,?,?,?)
    `).run(uuidv4(), req.ocorrencia.id, item.id, concluido ? 1 : 0, concluido ? new Date().toISOString() : null, evidencia_url || null, comentario || null);
  }
  if (req.ocorrencia.status === 'pendente') {
    db.prepare("UPDATE atividade_ocorrencias SET status = 'em_andamento', iniciada_em = datetime('now'), atualizado_em = datetime('now') WHERE id = ?")
      .run(req.ocorrencia.id);
  }
  res.json(serializeOcorrencia(db, db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(req.ocorrencia.id)));
});

// PUT /api/atividades/ocorrencias/:id/campos/:campoId — preenche 1 campo customizado
router.put('/ocorrencias/:id/campos/:campoId', carregarOcorrenciaDoUsuario, (req, res) => {
  const db = getDb();
  const campo = db.prepare('SELECT * FROM atividade_campos WHERE id = ? AND atividade_id = ?')
    .get(req.params.campoId, req.ocorrencia.atividade_id);
  if (!campo) return res.status(404).json({ erro: 'Campo não encontrado' });

  const { valor, evidencia_url } = req.body;
  if (campo.exige_foto && !evidencia_url) return res.status(400).json({ erro: 'Este campo exige uma foto' });

  const existente = db.prepare('SELECT id FROM ocorrencia_campo_valores WHERE ocorrencia_id = ? AND campo_id = ?')
    .get(req.ocorrencia.id, campo.id);
  if (existente) {
    db.prepare('UPDATE ocorrencia_campo_valores SET valor = ?, evidencia_url = ? WHERE id = ?')
      .run(valor ?? null, evidencia_url || null, existente.id);
  } else {
    db.prepare('INSERT INTO ocorrencia_campo_valores (id, ocorrencia_id, campo_id, valor, evidencia_url) VALUES (?,?,?,?,?)')
      .run(uuidv4(), req.ocorrencia.id, campo.id, valor ?? null, evidencia_url || null);
  }
  res.json(serializeOcorrencia(db, db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(req.ocorrencia.id)));
});

// POST /api/atividades/ocorrencias/:id/submeter — conclui a execução
router.post('/ocorrencias/:id/submeter', carregarOcorrenciaDoUsuario, (req, res) => {
  const db = getDb();
  const oc = req.ocorrencia;
  const atividade = db.prepare('SELECT * FROM atividades WHERE id = ?').get(oc.atividade_id);
  const { comentario_execucao, evidencia_url, justificativa_atraso } = req.body;

  if (oc.status === 'atrasada' && !(justificativa_atraso || '').trim()) {
    return res.status(400).json({ erro: 'Justificativa é obrigatória para concluir uma atividade atrasada' });
  }
  if (atividade.exige_foto && atividade.formato === 'simples' && !evidencia_url) {
    return res.status(400).json({ erro: 'Esta atividade exige uma foto como evidência' });
  }

  if (atividade.formato === 'checklist') {
    const itens = db.prepare('SELECT * FROM atividade_checklist_itens WHERE atividade_id = ?').all(atividade.id);
    const execs = db.prepare('SELECT * FROM ocorrencia_checklist_itens WHERE ocorrencia_id = ?').all(oc.id);
    const pendente = itens.find(item => {
      const e = execs.find(x => x.item_id === item.id);
      return !e || !e.concluido;
    });
    if (pendente) return res.status(400).json({ erro: `Existem passos do checklist ainda não concluídos ("${pendente.descricao}")` });
  }

  const camposObrigatorios = db.prepare('SELECT * FROM atividade_campos WHERE atividade_id = ? AND obrigatorio = 1').all(atividade.id);
  const valores = db.prepare('SELECT * FROM ocorrencia_campo_valores WHERE ocorrencia_id = ?').all(oc.id);
  const campoFaltando = camposObrigatorios.find(c => {
    const v = valores.find(x => x.campo_id === c.id);
    return !v || (v.valor === null && !v.evidencia_url);
  });
  if (campoFaltando) return res.status(400).json({ erro: `O campo obrigatório "${campoFaltando.rotulo}" não foi preenchido` });

  const novoStatus = atividade.exige_aprovacao ? 'aguardando_validacao' : 'concluida';
  db.prepare(`
    UPDATE atividade_ocorrencias
    SET status = ?, submetida_em = datetime('now'),
        concluida_em = CASE WHEN ? = 'concluida' THEN datetime('now') ELSE concluida_em END,
        comentario_execucao = ?, evidencia_url = COALESCE(?, evidencia_url), justificativa_atraso = COALESCE(?, justificativa_atraso),
        atualizado_em = datetime('now')
    WHERE id = ?
  `).run(novoStatus, novoStatus, comentario_execucao || null, evidencia_url || null, justificativa_atraso || null, oc.id);

  res.json(serializeOcorrencia(db, db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(oc.id)));
});

// POST /api/atividades/ocorrencias/:id/replanejar — usuário solicita novo prazo
router.post('/ocorrencias/:id/replanejar', carregarOcorrenciaDoUsuario, (req, res) => {
  const db = getDb();
  const oc = req.ocorrencia;
  const atividade = db.prepare('SELECT * FROM atividades WHERE id = ?').get(oc.atividade_id);
  if (!atividade.permite_replanejamento) return res.status(403).json({ erro: 'Esta atividade não permite replanejamento' });

  const { nova_data, novo_horario, motivo } = req.body;
  if (!nova_data || !(motivo || '').trim()) return res.status(400).json({ erro: 'nova_data e motivo são obrigatórios' });
  if (nova_data < hojeISO()) return res.status(400).json({ erro: 'A nova data não pode estar no passado' });

  const pendenteExistente = db.prepare("SELECT id FROM ocorrencia_replanejamentos WHERE ocorrencia_id = ? AND status = 'pendente'").get(oc.id);
  if (pendenteExistente) return res.status(409).json({ erro: 'Já existe um pedido de replanejamento pendente para esta atividade' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO ocorrencia_replanejamentos (id, ocorrencia_id, solicitante_id, nova_data, novo_horario, motivo)
    VALUES (?,?,?,?,?,?)
  `).run(id, oc.id, req.auth.id, nova_data, novo_horario || null, motivo.trim());

  res.status(201).json(db.prepare('SELECT * FROM ocorrencia_replanejamentos WHERE id = ?').get(id));
});

// ══════════════════════════════ APROVAÇÕES (gestor) ══════════════════════════

// GET /api/atividades/aprovacoes/pendentes
router.get('/aprovacoes/pendentes', gestorOnly, (req, res) => {
  const db = getDb();
  const filtroAtividade = req.usuarioAtual.perfil === 'admin'
    ? ''
    : 'AND a.criado_por = ?';
  const params = req.usuarioAtual.perfil === 'admin' ? [] : [req.usuarioAtual.id];

  const conclusoes = db.prepare(`
    SELECT o.* FROM atividade_ocorrencias o
    JOIN atividades a ON a.id = o.atividade_id
    WHERE o.status = 'aguardando_validacao' ${filtroAtividade}
    ORDER BY o.submetida_em ASC
  `).all(...params);

  const replanejamentos = db.prepare(`
    SELECT r.* FROM ocorrencia_replanejamentos r
    JOIN atividade_ocorrencias o ON o.id = r.ocorrencia_id
    JOIN atividades a ON a.id = o.atividade_id
    WHERE r.status = 'pendente' ${filtroAtividade}
    ORDER BY r.criado_em ASC
  `).all(...params);

  res.json({
    conclusoes: conclusoes.map(oc => serializeOcorrencia(db, oc)),
    replanejamentos: replanejamentos.map(r => ({
      ...r,
      ocorrencia: serializeOcorrencia(db, db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(r.ocorrencia_id)),
    })),
  });
});

function carregarOcorrenciaParaAprovacao(req, res, next) {
  const db = getDb();
  const oc = db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(req.params.id);
  if (!oc) return res.status(404).json({ erro: 'Ocorrência não encontrada' });
  const atividade = db.prepare('SELECT * FROM atividades WHERE id = ?').get(oc.atividade_id);
  if (req.usuarioAtual.perfil !== 'admin' && atividade.criado_por !== req.usuarioAtual.id) {
    return res.status(403).json({ erro: 'Apenas o criador da atividade ou um admin pode validar' });
  }
  if (oc.status !== 'aguardando_validacao') return res.status(409).json({ erro: 'Esta ocorrência não está aguardando validação' });
  req.ocorrencia = oc;
  next();
}

// POST /api/atividades/ocorrencias/:id/validar — { aprovar: bool, motivo_recusa }
router.post('/ocorrencias/:id/validar', gestorOnly, carregarOcorrenciaParaAprovacao, (req, res) => {
  const db = getDb();
  const { aprovar, motivo_recusa } = req.body;

  if (aprovar) {
    db.prepare(`
      UPDATE atividade_ocorrencias
      SET status = 'concluida', concluida_em = datetime('now'), validada_por = ?, validada_em = datetime('now'), atualizado_em = datetime('now')
      WHERE id = ?
    `).run(req.usuarioAtual.id, req.ocorrencia.id);
  } else {
    if (!(motivo_recusa || '').trim()) return res.status(400).json({ erro: 'motivo_recusa é obrigatório ao recusar' });
    db.prepare(`
      UPDATE atividade_ocorrencias
      SET status = 'em_andamento', validada_por = ?, validada_em = datetime('now'), motivo_recusa = ?, atualizado_em = datetime('now')
      WHERE id = ?
    `).run(req.usuarioAtual.id, motivo_recusa.trim(), req.ocorrencia.id);
  }

  res.json(serializeOcorrencia(db, db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(req.ocorrencia.id)));
});

// POST /api/atividades/replanejamentos/:id/decidir — { aprovar: bool, motivo_recusa }
router.post('/replanejamentos/:id/decidir', gestorOnly, (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM ocorrencia_replanejamentos WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ erro: 'Pedido de replanejamento não encontrado' });
  if (r.status !== 'pendente') return res.status(409).json({ erro: 'Este pedido já foi decidido' });

  const oc = db.prepare('SELECT * FROM atividade_ocorrencias WHERE id = ?').get(r.ocorrencia_id);
  const atividade = db.prepare('SELECT * FROM atividades WHERE id = ?').get(oc.atividade_id);
  if (req.usuarioAtual.perfil !== 'admin' && atividade.criado_por !== req.usuarioAtual.id) {
    return res.status(403).json({ erro: 'Apenas o criador da atividade ou um admin pode decidir' });
  }

  const { aprovar, motivo_recusa } = req.body;
  const decidir = db.transaction(() => {
    if (aprovar) {
      db.prepare(`
        UPDATE ocorrencia_replanejamentos SET status = 'aprovada', aprovador_id = ?, decidido_em = datetime('now') WHERE id = ?
      `).run(req.usuarioAtual.id, r.id);
      db.prepare(`
        UPDATE atividade_ocorrencias
        SET status = 'em_andamento', nova_data_prevista = ?, novo_horario_previsto = ?, atualizado_em = datetime('now')
        WHERE id = ?
      `).run(r.nova_data, r.novo_horario, oc.id);
    } else {
      if (!(motivo_recusa || '').trim()) throw Object.assign(new Error('motivo_recusa é obrigatório ao recusar'), { status: 400 });
      db.prepare(`
        UPDATE ocorrencia_replanejamentos SET status = 'recusada', aprovador_id = ?, decidido_em = datetime('now'), motivo_recusa = ? WHERE id = ?
      `).run(req.usuarioAtual.id, motivo_recusa.trim(), r.id);
    }
  });

  try {
    decidir();
  } catch (err) {
    return res.status(err.status || 500).json({ erro: err.message });
  }
  res.json(db.prepare('SELECT * FROM ocorrencia_replanejamentos WHERE id = ?').get(r.id));
});

module.exports = router;
