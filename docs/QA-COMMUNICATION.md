# Comunicação QA isolada

Esta trilha é local à aplicação e não habilita agendamento. Não crie o tenant nem execute o comando até company, OWNER e destinatário controlado existirem e as variáveis QA estiverem configuradas somente no backend DEV.

## Barreira de ambiente

O backend só reconhece QA quando `QA_COMMUNICATION_ENABLED=true`, `EVOLUTION_WEBHOOK_BASE_URL` é exatamente a origem DEV ou STAGING esperada e `DATABASE_URL` identifica o banco correspondente (`kalend_dev` ou `kalend_staging`). A API de produção ou qualquer combinação desconhecida rejeita o fluxo, mesmo com a flag QA. O modo não usa `NODE_ENV` nem aceita override de ambiente vindo do cliente.

DEV usa a configuração já existente de `EVOLUTION_WEBHOOK_BASE_URL` e `DATABASE_URL`; não copie URLs com credenciais para logs ou documentação. Staging ainda não pode enviar WhatsApp: `EvolutionService` reconhece DEV e PRODUCTION, sem ambiente STAGING. O canal WhatsApp em staging deve permanecer bloqueado até suporte explícito ser implementado.

## Allowlist de backend

Configure somente no backend DEV ou STAGING. A lista é extensível e os valores nunca devem ser impressos em logs:

- `QA_COMMUNICATION_ENABLED=true`
- `QA_COMMUNICATION_COMPANY_IDS=<UUID QA 1,UUID QA 2>`
- `QA_COMMUNICATION_EMAIL_ALLOWLIST=<e-mail controlado 1,e-mail controlado 2>`
- `QA_COMMUNICATION_PHONE_ALLOWLIST=<telefone controlado 1,telefone controlado 2>`
- `QA_COMMUNICATION_PUSH_SUBSCRIPTION_IDS=<UUID de device QA,...>` (opcional; quando presente, restringe os devices)

O endpoint `POST /communication/qa-test` recebe somente `companyId`, `userId`, canal e UUID de idempotência. A company deve estar na lista do servidor e o usuário precisa ser OWNER ativo dela. E-mail e WhatsApp são comparados com allowlists normalizadas. Push exige uma subscription ativa do usuário e autorização para a mesma company. A identificação não depende do slug.

O corpo de mensagem e template são fixos. Provider deve ser GLOBAL, ativo e compatível. Push ainda exige subscription ativa, não expirada, do user allowlisted e autorização ativa para a mesma company. A configuração de Push/Evolution GLOBAL não é alterada por essa trilha.

## Execução manual

O worker QA reutiliza temporal, ingestão, expansão, resolução de templates, claim, transportes e retry do engine comercial, aplicando filtro SQL por `QA_COMMUNICATION_COMPANY_IDS`. Processa até 5 eventos e até 20 deliveries por execução one-shot. Ingestão e trial-expiring também são limitados às companies QA. Destinatário fora da allowlist vira `UNSENDABLE` e nunca chega ao provider. Push fica limitado a subscriptions autorizadas para o mesmo user/company. Evolution só pode enviar se a conexão global real for a instância DEV esperada; ambiente STAGING não envia WhatsApp até existir suporte explícito.

Antes de processar, use o diagnóstico somente leitura:

```sh
npm run communication:worker:qa:check
```

Depois de revisar o preflight, a execução manual é:

```sh
npm run communication:worker:qa
```

`--qa-only` processa eventos comerciais existentes apenas das companies QA configuradas; não lê nem altera eventos/deliveries de outras companies. Ao contrário do worker normal, não dispara scheduler global nem ingestão global. A chave única da delivery preserva idempotência e o claim atômico impede processamento simultâneo duplicado. O allowlist limita os destinatários, mas não transforma provider real em sandbox. Não instalar timer nem configurar execução recorrente.

## Aprovisionamento pendente

Os IDs de companies e os endereços controlados precisam ser configurados nas variáveis privadas do ambiente. Telefone brasileiro legado (10/11 dígitos com DDD) é normalizado para E.164 sem inventar dígitos; números inválidos são recusados. Para Push, registre browser/device QA e autorize-o para a membership da mesma company. O preflight mostra apenas contatos mascarados, contagens, providers e IDs de correlação.

Nenhuma migration é necessária: evento e template já armazenam nomes técnicos como strings. Nenhum tenant/destinatário foi criado ou contatado pela implementação.
