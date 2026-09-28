# Revisão corretiva PagBank — 28/09/2026

**Entrega local para revisão. Sem commit, push, deploy, migration ou acesso a produção.** Trabalho anterior preservado na branch `develop`. O relatório de 24/09 permanece abaixo como histórico; as conclusões PagBank desta revisão substituem as descrições anteriores de chave manual, hash legado e envelopes presumidos.

## A. Estado encontrado ao retomar

Branch develop confirmada antes de editar; relatório anterior, git status e git diff --stat lidos. 23 arquivos rastreados modificados (1313 inserções/509 exclusões), mais os arquivos novos da Fase 1 sem staging. develop `49cdae24e5db7f456b0f0146929addf3ea52c85c`; main `fbbf7032e7ee02d4adf40103c604be942740f2b4`. Ambas as refs continuam iguais. Nenhuma alteração foi descartada; não foram usados reset/checkout.

## B. Incorreto/incompleto

Reconciliação interpretava payments[]/invoices[] sem contrato público comprovado; checkout não paginava e invoices incrementava offset por hipótese. Webhook tinha fallback SHA-256 legado, dependia de chave manual no cofre e misturava configuração de recorrência com autenticação. Teste de conexão consultava CARD e não distinguia homologação. Faltava validar identidade de alguns recursos reconsultados.

## C. Correções

Removidas as duas suposições de envelope. Receiver PagBank exige ECDSA; consulta chave WEBHOOK pública, cache/rotação, Base64 estrito e isolamento por ambiente/credencial. IDs reconsultados são conferidos. Teste devolve capacidades separadas. Public key manual não é aceita em webhookSecret; legado ignorado sem apagar dados. Compartilhado: apenas contrato aditivo de resultado de test e tratamento específico PagBank em GatewaysService. Adapters Mercado Pago, Stripe e Asaas e processador transacional de produção preservados.

## D. Documentação oficial

Fontes/URLs e conflitos registrados em [GATEWAY-PROVIDERS.md](GATEWAY-PROVIDERS.md#pagbank--revisão-corretiva-de-28092026). Reconsultados guia de autenticidade, referência de chave, checkout, invoices, invoice individual, pagamento recorrente, refund, cancelamento, checkout recorrente e elegibilidade. OpenAPI oficial obtido nas páginas `.md`; nenhuma conta/credencial de gateway consultada.

## E. x-payload-signature

Obrigatório, ECDSA SHA-256, assinatura Base64. Sem assinatura ou nenhuma válida: 401. Sem fallback para hash/token antigo. Assinatura válida não dispensa consulta e validação financeira.

## F. RAW BODY

Nest preserva Buffer original com rawBody:true. Controller passa req.rawBody e adapter valida esses bytes antes de JSON.parse; nenhum stringify para reconstruir conteúdo assinado. Testes incluem espaços, nova linha e UTF-8 no HTTP real local.

## G. Chave WEBHOOK

GET HTTPS `/public-keys/webhook`, Bearer principal, host fixo do ambiente. public_key Base64 DER/SPKI deve ser EC; chave CARD/RSA rejeitada. Guia usa query `?type=webhook`, referência OpenAPI usa path: adotado path sem fallback; divergência exige Sandbox. Guia também ressalva URL de produção, ainda não homologada. Não grava chave pública como secret.

## H. Cache e rotação

Memória, TTL 5 min, 32 entradas, hash de ambiente/token/versão da configuração. Requisições simultâneas compartilham consulta. Falha de assinatura tenta atualização com cooldown de 30 s. Falha de obtenção aceita somente cache ainda válido e assinatura criptograficamente válida. Cache expirado não é usado. Não renova par no provedor nem executa PUT. Janela de cooldown pode rejeitar temporariamente assinatura exclusiva da chave nova, até nova entrega/atualização.

## I. Múltiplas assinaturas

Aceita headers repetidos/comma-separated; valores malformados são ignorados individualmente. Verifica todos os valores decodificáveis, aceita se pelo menos um corresponde. Limite defensivo de 16 assinaturas: exceder rejeita a requisição. Valores acima de 16 KiB são ignorados como inválidos. Nenhuma válida: rejeição, sem mutação financeira.

## J. Checkout

Endpoint/Bearer/CHEC e offset/limit confirmados; o exemplo não comprova coleção ou IDs financeiros. Consulta primeira página explícita (limit=100, offset=0) e retorna PAGBANK_CHECKOUT_CONTRACT_UNVERIFIED, inclusive se vier payments[] plausível ou status PAID. **PENDENTE DE HOMOLOGAÇÃO SANDBOX**.

## K. Invoices

Endpoint/Bearer recorrente/SUBS, status opcional, offset=0 e limit=100 confirmados. Resposta pública da listagem é schema vazio/exemplo {}. Não interpreta invoices[], não retorna evento parcial nem altera assinatura. Erro PAGBANK_INVOICES_CONTRACT_UNVERIFIED. Invoice individual INVO tem schema documentado, distinto da listagem. **PENDENTE DE HOMOLOGAÇÃO SANDBOX**.

## L. Paginação

Nenhuma lista financeira é tratada como completa após 100 itens. Sem envelope/continuidade comprovados, ambos os percursos encerram com erro explícito na primeira consulta e nenhum evento. Offset de invoices descrito como página/deslocamento exige esclarecimento; loop antigo removido. GET subscriptions?limit=1&offset=0 é somente prova de acesso no teste, não inventário financeiro.

## M. Reconciliação e idempotência

Consulta direta de charge com ID confiável exige ID retornado igual e reference_id igual ao Payment interno. Processador preserva conferência de amount/currency, tenant/plano/assinatura, unicidade, claims e transação Serializable. Sem referência comprovada não há aprovação. Webhook/reconcile não renovam duas vezes; refunds mantêm identidade estável. Percursos dependentes de envelopes desconhecidos falham integralmente. Lifecycle continua reportando paymentsFailed e fazendo manutenção temporal de expiração independente: erro do provedor não representa ativação nem nova confirmação financeira.

## N. Pendências Sandbox

Envelopes/IDs/continuidade das duas consultas; endpoint da chave e rotação real; entrega ECDSA dos produtos da conta; elegibilidade e token recorrente; referência inicial checkout→assinatura; dois ciclos, cancelamento e refund parcial/total; perda/reentrega de webhook. Recorrência não está homologada. Antes de produção, resolver ressalva oficial da URL de chaves. PF não habilitada para recorrência via API segundo guia atual; confirmar conta elegível.

## O. Testes

Nova suíte pagbank.spec.ts cobre autenticação, ausência/invalidez/múltiplas assinaturas, EC versus RSA, chave inválida, falha de aquisição/refresh, TTL, cooldown/rotação, cache por credencial, fetch concorrente, capacidades, contratos desconhecidos (inclusive 100 registros plausíveis), parâmetros paginados e referência incorreta. Testes existentes ajustados para endpoint WEBHOOK. Suíte transacional parametrizada para PagBank cobre amount/currency/referência, duplicação, refund e competição webhook×reconcile com transações fake serializadas. HTTP verifica Buffer idêntico ao enviado e rejeição após reserialização. Todas as chamadas financeiras usam fakes, chaves ECDSA efêmeras. Concorrência real PostgreSQL não foi validada por esses testes.

## P. npm test

**PASS: 147/147, 15 arquivos.** Antes da geração do Client após npm ci, houve falha de importação esperada por ausência de .prisma/client; após generate a execução completa passou. Um teste antigo que ainda fornecia chave manual foi ajustado ao novo contrato.

## Q. test:e2e

**PASS: 57/57, 3 arquivos.** Primeira execução bloqueada pelo sandbox ao abrir portas locais; reexecução autorizada passou. Sem rede financeira ou banco real.

## R. Demais validações

npm ci --no-audit --no-fund PASS (494 pacotes); Prisma validate PASS; generate PASS 7.10.0; TypeScript PASS; build PASS; lint PASS; git diff --check PASS. Node 22.23.2 do cache local. Prisma validate/generate precisaram de permissão para cache externo do engine, com DATABASE_URL fictícia em 127.0.0.1:1, sem conexão. postinstall opcional skills sync não carregou DATABASE_URL e instalação terminou 0. Avisos preexistentes tsconfck e resolução Vite; aviso de Prisma 8 ignorado. Prisma, @prisma/client e @prisma/adapter-pg mantidos em **7.10.0**; manifest/lock/prisma.config.ts intactos. Varredura heurística de 43 arquivos modificados/novos sem padrões suspeitos de chave privada/token live/URL remota de banco autenticada; não é garantia universal de detecção.

## S. Migration

`prisma/migrations/20260923190000_commercial_engine/migration.sql` já existia ao retomar e foi preservada. **NÃO EXECUTADA**. Nenhuma alteração adicional de schema/migration nesta revisão, nenhum acesso a PostgreSQL DEV ou produção. Backfill/DDL e concorrência precisam de validação futura em PostgreSQL descartável, após revisão do usuário.

## T. git diff --stat

Inclui toda a Fase 1 local rastreada, não somente esta revisão; arquivos novos não entram no stat.

```text
 docs/AUTHENTICATION.md                   |   2 +
 docs/BACKEND-AUDIT.md                    |   2 +
 docs/FRONTEND-API.md                     |   2 +
 docs/VALIDATION.md                       |   2 +
 prisma/schema.prisma                     |  64 ++--
 src/auth/auth.service.ts                 |  16 +-
 src/auth/tenant.guard.ts                 |   6 +
 src/billing/billing.module.ts            |  65 +++-
 src/billing/billing.spec.ts              | 461 ++++++++++++++------------
 src/billing/gateway.provider.ts          |  80 ++---
 src/billing/gateways.service.ts          | 198 +++++++++---
 src/billing/lifecycle.service.spec.ts    |  81 ++++-
 src/billing/lifecycle.service.ts         | 112 +++++--
 src/billing/payments.service.ts          | 348 ++++++++++++++------
 src/billing/webhook-processor.service.ts | 535 ++++++++++++++++++++++---------
 src/companies/companies.service.spec.ts  |  13 +
 src/dashboard/dashboard.service.ts       |  14 +-
 src/finance/finance.service.ts           |  13 +-
 src/plans/plan.validation.ts             |  16 +-
 src/plans/plans.service.ts               |  55 ++--
 test/app.e2e-spec.ts                     |  13 +-
 test/auth.e2e-spec.ts                    |  31 +-
 test/support/auth-database.ts            |   3 +
 23 files changed, 1498 insertions(+), 634 deletions(-)
```

## U. git status

```text
## develop...origin/develop
 M docs/AUTHENTICATION.md
 M docs/BACKEND-AUDIT.md
 M docs/FRONTEND-API.md
 M docs/VALIDATION.md
 M prisma/schema.prisma
 M src/auth/auth.service.ts
 M src/auth/tenant.guard.ts
 M src/billing/billing.module.ts
 M src/billing/billing.spec.ts
 M src/billing/gateway.provider.ts
 M src/billing/gateways.service.ts
 M src/billing/lifecycle.service.spec.ts
 M src/billing/lifecycle.service.ts
 M src/billing/payments.service.ts
 M src/billing/webhook-processor.service.ts
 M src/companies/companies.service.spec.ts
 M src/dashboard/dashboard.service.ts
 M src/finance/finance.service.ts
 M src/plans/plan.validation.ts
 M src/plans/plans.service.ts
 M test/app.e2e-spec.ts
 M test/auth.e2e-spec.ts
 M test/support/auth-database.ts
?? docs/COMMERCIAL-ENGINE.md
?? docs/COMMERCIAL-VALIDATION.md
?? docs/GATEWAY-PROVIDERS.md
?? prisma/migrations/20260923190000_commercial_engine/migration.sql
?? src/billing/adapters/adapters.spec.ts
?? src/billing/adapters/asaas.adapter.ts
?? src/billing/adapters/http.ts
?? src/billing/adapters/mercado-pago.adapter.ts
?? src/billing/adapters/pagbank.adapter.ts
?? src/billing/adapters/pagbank.spec.ts
?? src/billing/adapters/stripe.adapter.ts
?? src/billing/commercial-policy.ts
?? src/billing/commercial.service.spec.ts
?? src/billing/entitlements.service.ts
?? src/billing/gateway.types.ts
?? src/billing/payments.service.spec.ts
?? src/billing/product-access.guard.ts
?? src/billing/regularization.service.ts
?? src/billing/renewals.spec.ts
?? test/webhooks.e2e-spec.ts
```

Nada em staging; refs develop/main inalteradas. Sem commit, push, deploy ou migration.

## V. Riscos antes de PostgreSQL DEV

PagBank permanece parcialmente bloqueado por contrato externo incompleto: a implementação segura não representa integração homologada. Não habilitar recorrência operacional com base em CONNECTED. Validar migration/backfills e corridas reais no DEV após aprovação. Cache/rotação e mecanismo ECDSA devem ser confirmados com a conta Sandbox. Criações UNCERTAIN continuam sem retry cego; resolução pode exigir investigação no provedor. Nenhum item de fases futuras implementado. Trabalho parado para revisão do usuário.

---

# Histórico preservado — relatório de 24/09/2026

# Relatório da Fase 1 — entrega local para revisão

Data: 24/09/2026. Branch `develop`. Trabalho anterior preservado. Nenhum commit, push, deploy, acesso a banco ou cobrança real. Prisma mantido em **7.10.0**.

A implementação local e suas verificações automatizadas estão entregues. **Homologação dos gateways e validação da migration/concorrência em PostgreSQL não foram realizadas.** Há uma lacuna de contrato externo do PagBank descrita em I/S/T; não se deve interpretar os testes com mocks como conclusão dessa homologação.

## A. Estado anterior encontrado

Nest, Prisma, autenticação por sessão/cookies, isolamento por membership, SUPER_ADMIN, catálogo Plan/PlanFeature, empresas, assinaturas, pagamentos e WebhookEvent já existiam. Também existiam AES-256-GCM com chave de ambiente/AAD, receivers de três provedores e manutenção de expiração. Essas estruturas foram reutilizadas. A auditoria incluiu package.json, schema, migrations, módulos solicitados e docs; nenhum AGENTS.md aplicável foi encontrado.

## B. Problemas encontrados

- Registro de gateways sem adapters operacionais; Asaas ausente.
- Checkout preso à assinatura/plano anterior, sem fluxo tenant de seleção após trial.
- Reconciliação sem consulta financeira externa; bloqueio de tenant impedindo recuperação comercial.
- Identificadores externos sem separação por ambiente; catálogo sem indicador público.
- Ausência de claim persistente para operações externas incertas e de mecanismo executável de limites.
- Necessidade de tratamento de renovação, refunds parciais e estados de criação, cancelamento e graça.
- Migration comercial anterior com alteração de preço sem backfill para dados populados: risco preexistente, registrado e não executado.

## C. Arquivos modificados/criados

O inventário exato está em V. Principais grupos:

- `prisma/schema.prisma` e nova migration comercial.
- `src/billing/`: registro/tipos, quatro adapters, transporte HTTP, configuração segura, checkout, processador de eventos, reconciliação, regularização, política comercial e entitlements/guard.
- `src/auth/`: acesso à recuperação de empresa suspensa, preservando autenticação e isolamento.
- `src/plans/`: catálogo público e validação de limites.
- `src/dashboard/` e `src/finance/`: contabilização de refunds parciais.
- Testes unitários de billing/adapters/trial e testes HTTP/autenticação/webhooks.
- Documentação nova e avisos nas páginas históricas para evitar instruções obsoletas sobre adapters inexistentes.

## D. Migration criada

`prisma/migrations/20260923190000_commercial_engine/migration.sql`.

Adiciona ASAAS, estados comerciais, PaymentCreationState, snapshots de assinatura, dados de checkout, recorrência/refund, isPublic/maxMessages e credencial separada de recorrência PagBank. Índices externos incluem ambiente. Backfills preservam intervalo conhecido, refund total histórico e classificam operações legadas como CREATED/UNCERTAIN, sem liberar retry cego. Não inferem plano/preço/ambiente pelo valor.

DDL conferido contra `prisma migrate diff` entre schema original e final. Migrations anteriores intactas. **SQL não aplicado a nenhum banco**; teste em PostgreSQL descartável permanece em T.

## E. Novos endpoints

| Endpoint | Autorização |
| --- | --- |
| GET /billing/regularization | OWNER/ADMIN do tenant |
| POST /billing/checkout | OWNER/ADMIN do tenant |
| POST /billing/subscriptions/:id/cancel | OWNER/ADMIN, assinatura do tenant |
| POST /webhooks/asaas | Token dedicado do provedor |

## F. Endpoints alterados/preservados

| Endpoint | Resultado |
| --- | --- |
| GET/PATCH /payment-gateways/:gateway; GET /payment-gateways | Quatro provedores, capacidades/ambiente, secrets write-only, estado seguro |
| POST /payment-gateways/:gateway/test | Teste externo real pelo adapter, erro sanitizado |
| POST /payments | Contrato administrativo de entrada preservado; usa checkout interno |
| POST /billing/reconcile | Consulta financeira e manutenção comercial |
| POST /webhooks/mercado-pago, /stripe, /pagbank | Validação específica, reconsulta e processamento transacional; HTTP 200 |
| POST /webhooks/:id/reprocess | Reconsulta autenticada de evento falho |
| GET /plans/public | Somente ativos/públicos e campos comerciais selecionados |
| GET /auth/me e seleção de tenant | Membership ativa de empresa suspensa disponível para regularização |

Dados financeiros adicionais são retornados de forma aditiva. Preço/status/companyId não são aceitos no checkout tenant. A rota administrativa continua validando explicitamente a relação empresa/assinatura/plano.

## G. Mercado Pago

Adapter de Checkout Pro/preapproval, consulta de pagamento/assinatura, cancelamento e reconciliação. Referências internas explícitas, verificação de ambiente e assinatura x-signature para os produtos documentados. IPN/produtos com autenticação diferente não recebem fallback inseguro. Criação incerta não é repetida automaticamente.

## H. Stripe

Checkout payment/subscription, metadata/client_reference_id, Idempotency-Key, versão REST fixada, consulta de invoices/Invoice Payments/PaymentIntent, cancelamento imediato/agendado e assinatura raw-body. Eventos de checkout, invoice, assinatura e refund. Invoice é a identidade financeira canônica da recorrência; redirect nunca ativa acesso.

## I. PagBank

Checkout/Order, reference_id, ambientes separados, SHA-256 de notificações Order e ECDSA de recorrência. Recorrência condicionada à habilitação da conta, token próprio e chave pública; cancelamento pela API de assinaturas, faturas/refunds e idempotência de estorno.

**Limitação ainda aberta:** exemplos oficiais de consulta de checkout/listagem de faturas não especificam os envelopes completos. Os caminhos são documentados, mas as estruturas `payments`/`invoices` usadas na reconciliação precisam ser confirmadas com resposta Sandbox/contrato do provedor. Ausência do formato esperado gera erro explícito e nenhuma aprovação. Isso pode impedir reconciliação automática e processamento de eventos recorrentes dependentes dessa consulta; não é uma capacidade homologada. Não habilitar recorrência apenas porque o teste de credencial passou.

## J. Asaas

Cliente por externalReference, cobrança hospedada, recorrência mensal/anual, consulta/cancelamento, endpoints Sandbox/produção e access_token. Token dedicado de webhook, distinto da API key. Eventos financeiros/assinatura normalizados; configuração de webhook preparada como método interno seguro. Não se presume idempotência nativa não documentada; claim e reconciliação protegem criação incerta.

## K. Webhooks

Quatro receivers independentes. Autenticidade antes do processamento, consulta de recurso, ambiente/provider, relações empresa/plano/assinatura, moeda/valor e referências validados. Eventos persistidos, unicidade por provider/ambiente/ID, claim e transação Serializable compartilhada com reconcile. Conflitos no processador têm retry limitado. Estado financeiro não é aceito do navegador. Segredos e payloads sensíveis não são registrados.

## L. Trial e assinaturas

Datas de trial persistidas e não recalculadas após edição do catálogo. Trial Premium seguido de compra Pro ativa Pro. Renovação conserva snapshot comercial e período identificado; falha/atraso não ativa assinatura. Graça configurável, suspensão, reativação por pagamento, cancelamento no gateway e refund parcial/total preservam histórico. Login permanece disponível após expiração.

## M. Regularização

Resposta com motivo/status, trial expirado, assinatura atual, planos públicos, intervalos/preços, gateways e checkout pendente. OWNER/ADMIN autorizado escolhe plano diferente do trial. Exceção de acesso comercial restrita às rotas marcadas BillingRecovery; não libera automaticamente operações do produto.

## N. Limites de plano

EntitlementsService usa assinatura vigente, PlanFeature e limites reais do catálogo; erro PLAN_LIMIT_REACHED estruturado. Contagem de profissionais/clientes por memberships ativas. Guard exportado para operações de produto. Unidades/mensagens ainda não têm módulos de produto: seus futuros serviços devem contar uso e criar recursos na mesma transação Serializable. Agenda não implementada.

## O. Segurança

SUPER_ADMIN/tenant/Origin preservados; allowlists de DTO; companyId derivado de membership no checkout. Cofre existente reutilizado. Credenciais substituídas invalidam teste/habilitação. Ambiente não muda com histórico; mudança e criação de intenção têm verificações dentro de transações Serializable. Configuração modificada durante checkout é rejeitada. Hosts HTTPS fixos, redirects recusados, timeout, valores inteiros, comparação de assinaturas em tempo constante e erros sanitizados.

Varredura heurística dos arquivos modificados/novos: nenhum padrão suspeito de chave privada, token live longo ou URL remota autenticada de banco encontrado. Revisão de código não encontrou logging de secrets. Essa varredura não constitui garantia universal contra todos os formatos possíveis de segredo.

Nenhum `.env`, configuração de deploy/produção, package.json, package-lock.json ou prisma.config.ts alterado. main e develop continuam nos mesmos commits da auditoria; alterações apenas na árvore local.

## P. Testes adicionados/atualizados

Cobertura local para configuração dos quatro gateways/secrets, adapter correto, ambientes, preço do banco/mass assignment, Premium → Pro, assinaturas válidas/inválidas/replay/duplicação, amount/currency/company/environment incorretos, aprovação/falha/atraso/refund, cancelamento/reativação, trial/login/regularização, reconciliação, renovação e limites. Acrescentados ECDSA real com chave efêmera de teste, snapshot de trial e mudança concorrente de configuração. Mocks/fakes em todas as chamadas externas e banco.

## Q. Resultados finais

| Validação | Resultado |
| --- | --- |
| npm ci --no-audit --no-fund | PASS, 494 pacotes; manifest/lock intactos |
| Prisma validate | PASS |
| Prisma Client generate | PASS, 7.10.0 |
| Migration: comparação DDL/schema e revisão dos backfills | PASS estático; não aplicada |
| npx tsc --noEmit | PASS |
| npm run build | PASS |
| npm run lint | PASS |
| npm test | **102/102**, 14 arquivos |
| npm run test:e2e | **56/56**, 3 arquivos |
| git diff --check | PASS |
| Branch/refs/configurações/varredura heurística de secrets | PASS, limites descritos em O |

Node 22.23.2 usado porque o Node 18 padrão não atende as dependências existentes. npm ci apresentou aviso preexistente de tsconfck descontinuado e postinstall opcional `prisma skills sync` sem DATABASE_URL; instalação terminou com exit 0. Não foi fornecida URL real para esse hook. Prisma validate/generate usaram URL fictícia local, sem conexão. A geração precisou de acesso ao cache do engine fora do sandbox; testes HTTP precisaram abrir porta local. Vite avisou sobre plugin de resolução de paths redundante. Nenhum desses avisos resultou em falha final.

## R. Novas variáveis de ambiente

- `BILLING_PUBLIC_API_URL`: base HTTPS pública da API do ambiente.
- `BILLING_RETURN_URL`: URL HTTPS de retorno definida pelo backend.
- `BILLING_GRACE_DAYS`: opcional, inteiro 0..999, ausente = 0.

`GATEWAY_ENCRYPTION_KEY` já existia. Credenciais dos provedores continuam criptografadas no banco, sem novas variáveis com valores reais. Exemplos não contêm secrets reais.

## S. Pendências dependentes de contas/credenciais

- Homologar checkout, assinatura, eventos e consulta nos quatro Sandboxes.
- PagBank: elegibilidade, tokens/chave ECDSA oficiais da conta, envelopes de consulta citados em I e origem/rotação da chave.
- Mercado Pago: entrega assinada do produto Assinaturas e contas de teste correspondentes.
- Stripe: versão/configuração do endpoint de webhook compatível com API fixada.
- Asaas: pagador de teste, autenticação dedicada de webhook e confirmação de estados efetivos de cobrança/recorrência.

Nenhuma dessas pendências foi simulada como sucesso real.

## T. Validações restantes em DEV

Aplicar migrations somente após revisão em PostgreSQL descartável, com dados legados representativos; testar unicidade/Serializable e corrida webhook × reconcile e checkout × troca de configuração. Não há PostgreSQL/psql/docker disponível neste ambiente.

Exercitar dois ciclos de recorrência, reentrega/replay, refund parcial/total/ciclo anterior, cancelamento, trial Premium → Pro e perda de webhook. Validar recuperação após timeout/crash externo: UNCERTAIN/CREATING não têm retry cego nem endpoint para o frontend inventar IDs; alguns casos sem referência externa exigem investigação no provedor. Refunds avulsos antigos não entram em varredura de todo o histórico, dependem de webhook/reprocessamento. Validar HTTPS, cookies, Origin, cron externo de reconcile e limites concorrentes nos futuros serviços de produto.

Fontes e passos por provedor: [GATEWAY-PROVIDERS.md](GATEWAY-PROVIDERS.md). Arquitetura, contratos e Sandbox: [COMMERCIAL-ENGINE.md](COMMERCIAL-ENGINE.md).

## U. git diff --stat

O comando Git abaixo contabiliza arquivos rastreados. Arquivos novos permanecem sem staging e aparecem em V; não estão incluídos no total de `git diff --stat`.

```text
 docs/AUTHENTICATION.md                   |   2 +
 docs/BACKEND-AUDIT.md                    |   2 +
 docs/FRONTEND-API.md                     |   2 +
 docs/VALIDATION.md                       |   2 +
 prisma/schema.prisma                     |  64 ++--
 src/auth/auth.service.ts                 |  16 +-
 src/auth/tenant.guard.ts                 |   6 +
 src/billing/billing.module.ts            |  65 +++-
 src/billing/billing.spec.ts              | 171 +++++-----
 src/billing/gateway.provider.ts          |  80 ++---
 src/billing/gateways.service.ts          | 178 ++++++++--
 src/billing/lifecycle.service.spec.ts    |  81 ++++-
 src/billing/lifecycle.service.ts         | 112 +++++--
 src/billing/payments.service.ts          | 348 ++++++++++++++------
 src/billing/webhook-processor.service.ts | 535 ++++++++++++++++++++++---------
 src/companies/companies.service.spec.ts  |  13 +
 src/dashboard/dashboard.service.ts       |  14 +-
 src/finance/finance.service.ts           |  13 +-
 src/plans/plan.validation.ts             |  16 +-
 src/plans/plans.service.ts               |  55 ++--
 test/app.e2e-spec.ts                     |  13 +-
 test/auth.e2e-spec.ts                    |  31 +-
 test/support/auth-database.ts            |   3 +
 23 files changed, 1313 insertions(+), 509 deletions(-)
```

## V. git status

```text
## develop...origin/develop
 M docs/AUTHENTICATION.md
 M docs/BACKEND-AUDIT.md
 M docs/FRONTEND-API.md
 M docs/VALIDATION.md
 M prisma/schema.prisma
 M src/auth/auth.service.ts
 M src/auth/tenant.guard.ts
 M src/billing/billing.module.ts
 M src/billing/billing.spec.ts
 M src/billing/gateway.provider.ts
 M src/billing/gateways.service.ts
 M src/billing/lifecycle.service.spec.ts
 M src/billing/lifecycle.service.ts
 M src/billing/payments.service.ts
 M src/billing/webhook-processor.service.ts
 M src/companies/companies.service.spec.ts
 M src/dashboard/dashboard.service.ts
 M src/finance/finance.service.ts
 M src/plans/plan.validation.ts
 M src/plans/plans.service.ts
 M test/app.e2e-spec.ts
 M test/auth.e2e-spec.ts
 M test/support/auth-database.ts
?? docs/COMMERCIAL-ENGINE.md
?? docs/COMMERCIAL-VALIDATION.md
?? docs/GATEWAY-PROVIDERS.md
?? prisma/migrations/20260923190000_commercial_engine/migration.sql
?? src/billing/adapters/adapters.spec.ts
?? src/billing/adapters/asaas.adapter.ts
?? src/billing/adapters/http.ts
?? src/billing/adapters/mercado-pago.adapter.ts
?? src/billing/adapters/pagbank.adapter.ts
?? src/billing/adapters/stripe.adapter.ts
?? src/billing/commercial-policy.ts
?? src/billing/commercial.service.spec.ts
?? src/billing/entitlements.service.ts
?? src/billing/gateway.types.ts
?? src/billing/payments.service.spec.ts
?? src/billing/product-access.guard.ts
?? src/billing/regularization.service.ts
?? src/billing/renewals.spec.ts
?? test/webhooks.e2e-spec.ts
```

Sem staging, commit, push ou deploy. Entrega aguardando revisão.
