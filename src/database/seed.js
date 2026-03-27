require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const getDb = require('./db');

const db = getDb();

// Garante tabelas existem (roda migrate inline se necessário)
db.pragma('foreign_keys = ON');

const usuarios = [
  { id: uuidv4(), nome: 'Alice Silva', telefone_whatsapp: '+5511999990001' },
  { id: uuidv4(), nome: 'Bruno Costa', telefone_whatsapp: '+5511999990002' },
  { id: uuidv4(), nome: 'Carla Souza', telefone_whatsapp: '+5511999990003' },
];

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO usuarios (id, nome, telefone_whatsapp)
  VALUES (@id, @nome, @telefone_whatsapp)
`);

for (const u of usuarios) {
  insertUser.run(u);
}

console.log('Seed executado com sucesso. Usuários criados:');
usuarios.forEach(u => console.log(`  ${u.nome} — ${u.telefone_whatsapp}`));

db.close();
