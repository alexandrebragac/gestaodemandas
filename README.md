# Gestão de Demandas via WhatsApp

Sistema de gestão de tarefas onde toda a comunicação acontece via WhatsApp (Twilio).

## Stack

- **Backend:** Node.js + Express
- **Banco de dados:** SQLite (via `better-sqlite3`)
- **WhatsApp:** Twilio WhatsApp API (Sandbox para testes)
- **Lembretes:** `node-cron`
- **Frontend:** HTML/CSS/JS vanilla

## Instalação

```bash
npm install
cp .env.example .env
# Preencha as variáveis no .env
npm start
```

Acesse o dashboard em `http://localhost:3000`

## Variáveis de Ambiente

```env
DATABASE_URL=./data/demandas.db
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
PORT=3000
NODE_ENV=development
```

> **Sem Twilio configurado:** o sistema funciona normalmente, e as mensagens são apenas logadas no console (modo simulado).

## Endpoints da API

### Usuários
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/usuarios` | Listar usuários |
| GET | `/api/usuarios/:id` | Buscar usuário |
| POST | `/api/usuarios` | Criar usuário |
| PUT | `/api/usuarios/:id` | Atualizar usuário |
| DELETE | `/api/usuarios/:id` | Remover usuário |

### Demandas
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/demandas` | Listar demandas (filtros: `?status=`, `?responsavel_id=`) |
| GET | `/api/demandas/:id` | Buscar demanda |
| POST | `/api/demandas` | Criar demanda (envia WhatsApp ao responsável) |
| PUT | `/api/demandas/:id` | Atualizar campos |
| POST | `/api/demandas/:id/aceitar` | Aceitar demanda |
| POST | `/api/demandas/:id/propor-prazo` | Propor novo prazo |
| POST | `/api/demandas/:id/concluir` | Marcar como concluída |
| POST | `/api/demandas/:id/baixa` | Dar baixa (finalizar) |
| GET | `/api/demandas/:id/mensagens` | Histórico de mensagens |

### Webhook
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/webhook/whatsapp` | Recebe mensagens do Twilio |

## Comandos WhatsApp

| Mensagem | Ação |
|----------|------|
| `aceito` / `ok` | Aceita demanda pendente |
| `novo prazo: DD/MM/AAAA` | Propõe novo prazo |
| `concluído` / `feito` | Marca como concluída |
| `baixa` / `confirmo` | Dá baixa na demanda |
| `status` | Lista demandas ativas |
| `ajuda` | Mostra comandos disponíveis |

## Fluxo de Status

```
pendente_aceite → em_negociacao → aceita → em_andamento → concluida_aguardando_baixa → finalizada
```

## Lembretes Automáticos

**Para o responsável** (antes da conclusão):
- 3 dias antes do vencimento
- 1 dia antes do vencimento
- No dia do vencimento
- Diariamente após vencimento (até 30 dias)

**Para o solicitante** (após conclusão):
- Imediatamente ao ser marcada como concluída
- A cada 2 dias (até dar baixa)

## Configurar Webhook Twilio

1. No console Twilio, vá em **Messaging → Sandbox Settings**
2. Configure o webhook "When a message comes in" para:
   `https://SEU-DOMINIO/webhook/whatsapp`
3. Para testar localmente, use [ngrok](https://ngrok.com/):
   ```bash
   ngrok http 3000
   ```

## Seed (dados de exemplo)

```bash
npm run seed
```
