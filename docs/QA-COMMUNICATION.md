# Comunicação QA isolada

Esta trilha é local à aplicação e não habilita agendamento. Não crie o tenant nem execute o comando até company, OWNER e destinatário controlado existirem e as variáveis QA estiverem configuradas somente no backend DEV.

## Barreira de ambiente

O backend só reconhece QA quando `QA_COMMUNICATION_ENABLED=true`, `EVOLUTION_WEBHOOK_BASE_URL` é exatamente a origem DEV ou STAGING esperada e `DATABASE_URL` identifica o banco correspondente (`kalend_dev` ou `kalend_staging`). A API de produção ou qualquer combinação desconhecida rejeita o fluxo, mesmo com a flag QA. O modo não usa `NODE_ENV` nem aceita override de ambiente vindo do cliente.

DEV usa a configuração já existente de `EVOLUTION_WEBHOOK_BASE_URL` e `DATABASE_URL`; não copie URLs com credenciais para logs ou documentação. Staging ainda não pode enviar WhatsApp: `EvolutionService` reconhece DEV e PRODUCTION, sem ambiente STAGING. O canal WhatsApp em staging deve permanecer bloqueado até suporte explícito ser implementado.

## Allowlist de backend

Configure apenas no ambiente DEV:

- `QA_COMMUNICATION_ENABLED=true`
- `QA_COMMUNICATION_COMPANY_ID=<UUID da company QA>`
- `QA_COMMUNICATION_USER_ID=<UUID do OWNER QA>`
- `QA_COMMUNICATION_ALLOWED_WHATSAPP=<número E.164 controlado, opcional>`
- `QA_COMMUNICATION_ALLOWED_EMAIL=<e-mail controlado, opcional>`
- `QA_COMMUNICATION_ALLOWED_PUSH_SUBSCRIPTION_ID=<UUID do device QA, opcional>`

O endpoint `POST /communication/qa-test` recebe somente `companyId`, `userId`, canal e UUID de idempotência. O destinatário é resolvido do perfil OWNER ou da subscription allowlisted. Requer sessão autenticada de Super Admin, company ativa com slug `qa-communication-dev`, membership OWNER ativo e correspondência entre company/user e as variáveis do servidor. Não passe contato no request.

O corpo de mensagem e template são fixos. Provider deve ser GLOBAL, ativo e compatível. Push ainda exige subscription ativa, não expirada, do user allowlisted e autorização ativa para a mesma company. A configuração de Push/Evolution GLOBAL não é alterada por essa trilha.

## Execução manual

Depois de aprovisionar os dados QA e revisar as allowlists, um Super Admin cria uma intenção única. A resposta contém apenas o ID da Outbox, evento, canal, provider e destino mascarado. O envio exige revisão explícita dos dados, pois o comando acessa o provider real configurado no ambiente:

```sh
npm run communication:worker:qa
```

`--qa-only` consome no máximo uma delivery elegível; nunca expande Outbox comercial nem chama schedulers ou ingestão de notificações. A mesma chave de idempotência reutiliza a Outbox/delivery. Isso limita o escopo da aplicação, mas não transforma o provider em sandbox. Não instalar timer ou configurar execução recorrente nesta etapa.

## Aprovisionamento pendente

Não há tenant QA, OWNER ou contatos definidos neste repositório. Para preparar um envio real, o responsável precisa fornecer um nome de OWNER, um e-mail de QA e, para WhatsApp, um número controlado. Para Push, é necessário registrar um browser/device QA e obter seu ID de subscription. Senhas devem ser criadas por fluxo seguro de convite/definição, nunca incluídas em issue, log ou documentação. O backend então deve receber os IDs dos registros QA e contatos correspondentes nas variáveis privadas do ambiente DEV.

Nenhuma migration é necessária: evento e template já armazenam nomes técnicos como strings. Nenhum tenant/destinatário foi criado ou contatado pela implementação.
