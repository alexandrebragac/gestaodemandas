require('dotenv').config();
const getDb = require('./db');

const db = getDb();

db.transaction(() => {
  db.prepare('DELETE FROM lembretes').run();
  db.prepare('DELETE FROM mensagens').run();
  db.prepare('DELETE FROM demandas').run();
  db.prepare('DELETE FROM usuarios').run();
})();

console.log('✅ Base de dados limpa com sucesso!');
db.close();
