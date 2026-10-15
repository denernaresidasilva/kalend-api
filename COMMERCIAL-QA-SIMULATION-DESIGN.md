# Simulação comercial DEV/QA — implementação local

Data: 2026-10-14. Repositório: kalend-api. Branch: develop.

Este documento registra a etapa de implementação local e sua validação. Nessa etapa, não houve commit, push ou deploy, e a migration foi executada exclusivamente em banco PGlite efêmero de teste. A aplicação no kalend_dev remoto e o deploy DEV são uma etapa posterior, sujeita à autorização explícita. Nenhum dado da QA Kalend 4 foi alterado durante a implementação.

## Schema e migration

Enum exato: PaymentGateway. Novo valor: QA_SIMULATION.

Migration: prisma/migrations/20261014120000_commercial_qa_simulation/migration.sql.

```sql
ALTER TYPE "PaymentGateway" ADD VALUE 'QA_SIMULATION';
```

É a única alteração estrutural. Nenhum model, coluna, índice ou trigger foi alterado. Subscription, Payment, WebhookEvent e GatewayConfiguration compartilham PaymentGateway e passam a aceitar o valor pelo enum existente; nenhum registro GatewayConfiguration(QA_SIMULATION) é criado.

QA_SIMULATION é uma origem interna. Não há adapter, credenciais, URL de checkout ou webhook externo. GatewayRegistry, gatewayName(), catálogo de gateways e checkout continuam limitados aos providers reais. POST /billing/checkout rejeita QA_SIMULATION, inclusive em DEV. O processador de webhooks externos e seu reprocessamento também rejeitam essa origem.

## Endpoint e contrato

POST /billing/qa-simulation. Sem UI pública. Usa AdminGuard real, sessão autenticada e validação de Origin existente. O serviço revalida as proteções antes e dentro da transação:

- qaRuntimeEnvironment() deve resultar exatamente em DEV. PROD, STAGING e UNKNOWN bloqueiam mesmo com a flag true. O classificador existente usa identidade configurada da API e do banco; NODE_ENV isolado não concede autorização.
- COMMERCIAL_QA_SIMULATION_ENABLED deve ser exatamente true; ausência bloqueia.
- Usuário autenticado deve ser Super Admin.
- QA_COMMUNICATION_COMPANY_IDS deve conter uma lista válida de UUIDs e incluir companyId. Lista ausente, vazia ou com entrada inválida bloqueia.
- Empresa deve existir, ter isActive=true e status ACTIVE ou TRIAL.

Criação de tentativa:

```json
{
  "companyId": "<UUID da empresa QA autorizada>",
  "action": "PAYMENT_PENDING",
  "planId": "<UUID de plano ativo no catálogo DEV>",
  "billingInterval": "MONTHLY",
  "idempotencyKey": "cenario-qa-001"
}
```

billingInterval aceita MONTHLY ou YEARLY, com preço positivo resolvido exclusivamente do catálogo. Cria uma assinatura própria QA PENDING e um Payment vinculado à mesma empresa/plano, ambos QA_SIMULATION/SANDBOX. A assinatura própria evita transformar uma assinatura real em simulação. A chave de criação é um hash com namespace QA e companyId; repetição retorna os mesmos IDs.

Transição da mesma tentativa:

```json
{
  "companyId": "<UUID da mesma empresa QA>",
  "paymentId": "<paymentId retornado na criação>",
  "action": "PAYMENT_APPROVED"
}
```

Ações: PAYMENT_PENDING, PAYMENT_APPROVED, PAYMENT_FAILED, PAYMENT_OVERDUE, SUBSCRIPTION_GRACE_PERIOD, SUBSCRIPTION_SUSPENDED, SUBSCRIPTION_REACTIVATED e SUBSCRIPTION_CANCELLED.

Resposta: source=QA_SIMULATION, paymentId, subscriptionId, action e duplicate. Repetir PENDING por paymentId é aceito. Outros estados exigem paymentId. Não recebe subscriptionId, valor, gateway, destinatários ou secrets. Campos desconhecidos bloqueiam. IDs de outra empresa, pagamentos reais e vínculos incompatíveis entre Payment/Subscription/Plan bloqueiam.

## CLI operacional DEV

Comando: `npm run billing:qa-simulate -- ...`, após build. Não exige senha, cookie, token ou sessão HTTP. O operador precisa de acesso operacional ao host DEV e à configuração privada existente. Não há token fixo, autenticação HTTP alternativa ou impersonação de Super Admin.

O endpoint continua com AdminGuard, sessão autenticada, Origin e Super Admin obrigatório. O CLI usa `QaSimulationService.simulateFromCli()`; os dois caminhos convergem para a mesma aplicação de transições, transação, validação da empresa, idempotência e domínio. A policy de DEV/flag/allowlist foi extraída para `assertCommercialQaScope()`. O caminho HTTP conserva adicionalmente `assertCommercialQa()` com Super Admin obrigatório. Nenhum campo HTTP permite escolher autorização CLI.

O contexto Nest do comando contém apenas PrismaService e QaSimulationService. A policy é verificada antes de criar/conectar Prisma e novamente dentro do serviço e da transação. Não inicializa AppModule, providers financeiros, listener HTTP, worker ou scheduler. PROD, STAGING, UNKNOWN, flag desativada, allowlist inválida/ausente e empresas fora do escopo bloqueiam. Empresa inexistente ou inativa também bloqueia antes de qualquer Payment/Subscription/evento.

Disponibilidade e preflight sem criar pagamento:

```sh
npm run billing:qa-simulate -- --help
npm run billing:qa-simulate -- --company <UUID-QA> --check
```

`--check` exige exclusivamente company, usa transação READ ONLY, verifica empresa ativa e valor QA_SIMULATION no enum do banco e retorna `readOnly=true` e `safeToSimulate=true`. Não publica evento, cria tentativa ou executa worker. Não pode ser combinado com action/payment/plan/key.

Criação explícita de uma tentativa pelo catálogo:

```sh
npm run billing:qa-simulate -- --company <UUID-QA> --action PAYMENT_PENDING --plan <UUID-PLANO> --interval MONTHLY --key <CHAVE-ESTAVEL>
```

Intervalo MONTHLY ou YEARLY. Plano, intervalo e chave estável são obrigatórios na criação. A chave não é gerada automaticamente: repetir os mesmos argumentos reutiliza a tentativa. O comando não aceita valor, gateway, secrets ou identidade de usuário.

Transição ou repetição da tentativa existente:

```sh
npm run billing:qa-simulate -- --company <UUID-QA> --action PAYMENT_APPROVED --payment <UUID-PAYMENT-QA>
```

Todas as oito ações já listadas são aceitas. Ações diferentes de PAYMENT_PENDING exigem payment. PENDING também aceita payment para repetição. Payment não pode ser combinado com plan/interval/key. Argumentos desconhecidos, repetidos ou incompletos bloqueiam; não há ação padrão. O comando encerra com código 1 ao bloquear e não imprime erros brutos de provider, conexão ou valores de argumentos.

Auditoria CLI: source=QA_SIMULATION, execution=CLI, operator e operatorUid obtidos do sistema operacional, sem actorId fictício. Auditoria HTTP mantém actorId autenticado e execution=HTTP. Gateway e environment persistidos continuam QA_SIMULATION/SANDBOX. Nenhuma migration adicional foi necessária.

## Worker QA manual

### Correção de isolamento da ingestão (2026-10-14)

A homologação PENDING revelou que `NotificationsService.ingest()` selecionava todos os fatos com `notificationProcessedAt IS NULL`. Tanto `communication:worker` quanto o scheduler chamam essa função; por isso a notificação interna QA era ingerida automaticamente, embora a expansão/envio comercial já excluíssem o namespace do simulador. A recuperação de deliveries SENDING também não filtrava a origem. A seleção QA por empresa, isoladamente, podia incluir fatos comerciais da mesma empresa.

`communicationEventScope()` centraliza a seleção SQL/Prisma por origem e modo. A identificação durável é a businessKey `QA_SIMULATION:` gravada na mesma transação do Payment/Subscription; também reconhece o evento/namespace `QA_COMMUNICATION_TEST` e metadata explícita `variables.source=QA_SIMULATION`. Não usa nome, slug ou contatos da empresa. Namespaces QA malformados são excluídos do processamento comercial e não têm fallback comercial.

O modo comercial exclui QA antes da ingestão, expansão, claim de PENDING/RETRY e recuperação de SENDING. O modo QA exige policy/allowlist, inclui somente fatos QA autorizados e revalida o escopo no claim. Simulações comerciais só são selecionadas em DEV com a flag explícita. `runQaWorker()` passa `qaMode=true` à mesma ingestão central; o preflight usa a mesma seleção. Fatos comerciais dentro de empresa allowlisted continuam pertencendo ao modo comercial.

A geração temporal comercial exclui Subscription.gateway=QA_SIMULATION. O modo QA não gera transições temporais implícitas: essas entradas permanecem ações explícitas do simulador. Não há engine duplicado, migration, timer QA nem reescrita da evidência PENDING já processada. Os E2E usam PostgreSQL efêmero, mocks de transport/rede e validam evento QA novo intocado pelo normal, processamento QA manual, idempotência, tenant isolation, origem ambígua, retry/backoff, recuperação, flags/PROD e continuidade do fluxo comercial.

O timer comercial permanece inalterado, executando `communication:worker` e ignorando a outbox QA. O CLI não dispara comunicações. Após uma criação explicitamente autorizada, a homologação deve usar:

```sh
npm run communication:worker:qa:check
```

Somente se o preflight indicar SAFE TO RUN = SIM:

```sh
npm run communication:worker:qa
```

Execução one-shot, manual, sem timer QA. Esta etapa de entrega do CLI não executa PAYMENT_PENDING nem qualquer outra transição no DEV remoto e não executa worker QA real.

## Domínio comercial e eventos

BillingDomain contém as transições extraídas de WebhookProcessor e a política temporal extraída de LifecycleService. Webhooks reais continuam validando assinatura e normalizando a entrada antes de chamar o mesmo domínio. O simulador chama esse domínio diretamente, sem contextos, configuração ou adapters financeiros.

PENDING não concede período pago. APPROVED altera o mesmo Payment e usa a ativação paga real, incluindo períodos, regra de concorrência de planos e estado da empresa. Para a origem QA, a ativação preserva todas as outras assinaturas, inclusive trials reais da mesma empresa; o comportamento dos providers reais é preservado. FAILED e OVERDUE aplicam a política real de inadimplência. GRACE fornece um fim de período controlado somente à assinatura QA e usa a mesma política temporal do lifecycle. REACTIVATED exige Payment APPROVED, período pago ainda válido e assinatura PAST_DUE ou SUSPENDED; reutiliza a mesma ativação paga. CANCELLED e SUSPENDED passam pelas transições existentes de assinatura.

Os produtores reais de eventos são os triggers de kalend_global_communication_capture(), instalados pela migration 20260929120000_global_communication. Eles continuam produzindo fatos duráveis na mesma transação. Não foi adicionado um produtor paralelo nem alterado qualquer trigger.

Antes do commit, o serviço prefixa as businessKeys dos fatos capturados do Payment e da Subscription vinculados com QA_SIMULATION:. Nenhum evento de outra assinatura/empresa é reidentificado. Isso diferencia a origem na outbox sem nova coluna e impede corrida com o worker: o registro só fica visível com a identificação QA. A repetição não muda novamente o estado nem captura outro evento.

NotificationsService.ingest(), CommunicationEngine.expand(), templates e o índice único de deliveries são reutilizados. O worker normal exclui os fatos QA tanto da expansão quanto do envio. O processamento em modo QA conserva as proteções de empresa/destinatário existentes; para comunicações comerciais QA, o envio também bloqueia fora de DEV ou sem COMMERCIAL_QA_SIMULATION_ENABLED=true. Nenhum worker CLI ou transport real foi executado nesta implementação.

EntitlementsService consulta o banco; não há cache comercial nesses serviços. Os testes verificam a decisão antes/depois da aprovação e após suspensão usando a mesma instância. RegularizationService continua fornecendo a decisão comercial autoritativa e exclui tentativas QA de pendingCheckout público. Não foi criado cache ou invalidação fictícia.

## Limites sem contornar regras reais

- BILLING_GRACE_DAYS global permanece inalterado. O CLI aceita --grace-days 0..999 somente em PAYMENT_FAILED, PAYMENT_OVERDUE e SUBSCRIPTION_GRACE_PERIOD; a policy é passada ao mesmo BillingDomain, sem alterar process.env. GRACE exige tolerância positiva. OVERDUE com override positivo já pode iniciar grace e emitir seu evento pelo trigger real.
- Uma tentativa aprovada não pode ser rebaixada para PENDING/FAILED/OVERDUE. Use outra chave para um cenário incompatível.
- Cancelamento não é desfeito pelo simulador.
- Cada ação é aplicada uma vez por Payment. Repetição retorna duplicate=true enquanto as proteções continuam satisfeitas.
- Suspensão comercial pode tornar isActive=false sem alterar administrativeStatus=ACTIVE. Nesse caso, o CLI aceita somente preflight, PAYMENT_PENDING de recovery (com --subscription), PAYMENT_APPROVED e SUBSCRIPTION_REACTIVATED. DISABLED e LEGACY_UNKNOWN continuam bloqueados. O worker QA pode comunicar os eventos de recuperação da empresa comercialmente suspensa; allowlists e transportes sandbox permanecem obrigatórios. Aprovação do pagamento de recovery já reativa a mesma assinatura e emite SUBSCRIPTION_REACTIVATED; não executar uma reativação redundante após a aprovação.
- Para ciclos adicionais, use nova tentativa QA. Não há edição arbitrária de datas ou mudança de relógio global.

## Auditoria, finanças e isolamento

Payment, Subscription e WebhookEvent persistem gateway=QA_SIMULATION e environment=SANDBOX. WebhookEvent registra source=QA_SIMULATION, actorId e ação normalizada. Logs registram origem, ator, empresa e IDs; não incluem secrets. description é apenas uma indicação adicional, nunca a identificação exclusiva.

FinanceService e DashboardService excluem QA_SIMULATION das somas de receita, receita mensal e agregações de pagamentos. A listagem financeira administrativa mantém o gateway explícito. O teste com um Payment real aprovado como controle comprova que a receita real continua contabilizada enquanto QA é excluído.

LifecycleService exclui QA tanto da reconciliação por provider quanto da varredura automática de expiração. As transições QA são explícitas e controladas, evitando capturas posteriores sem identificação QA. Não há adapter QA e nenhum registro de configuração financeira é necessário.

Transações Serializable, chave única da tentativa e chave única do journal de ação garantem idempotência. Há retry limitado para P2002/P2034. Os E2E verificam duas requisições concorrentes no banco efêmero; o socket PGlite usa pool de uma conexão, portanto essa prova não substitui um teste de concorrência entre múltiplas conexões PostgreSQL.

## Verificação local

Node usado: 24.21.0, já instalado. O Node padrão 18 não é compatível com o CLI Prisma instalado. Prisma validate/generate receberam URL fictícia local explícita e não conectaram a banco remoto.

Testes usam mocks de sessão com AdminGuard/Origin reais e migrations completas no PGlite efêmero. Incluem bloqueios de ambiente/flag/company/usuário, checkout HTTP, as oito ações, repetição, concorrência, tenant isolation/IDOR, preservação de assinaturas reais e usuários, acesso autoritativo, captura de eventos, notificações/templates/deliveries, reconciliação e exclusão financeira. Métodos dos quatro adapters e fetch foram mockados com falha caso chamados; chamadas externas do simulador: zero. Transports são mocks; envios reais: zero.

Resultados da etapa inicial: npm test — 824 testes aprovados em 50 arquivos; npm run test:e2e — 152 testes aprovados em 9 arquivos; npm run lint — passou sem avisos; npm run build — passou; npx prisma validate — passou; npx prisma generate — passou; git diff --check — passou. Nenhum comando de migration deploy/dev foi executado contra banco remoto. Na etapa de implementação descrita, não houve commit, push, deploy ou alteração de PROD/main.

Validação adicional do CLI: npm test — 848 testes aprovados em 51 arquivos; npm run test:e2e — 157 testes aprovados em 9 arquivos; lint, build, prisma validate e diff check passaram. Os novos testes cobrem as oito ações no parser, bloqueio antes de conectar ao banco, criação PENDING e aprovação do mesmo Payment pelo serviço compartilhado, repetição, auditoria operacional, preflight READ ONLY, empresas inexistentes/inativas e impossibilidade de solicitar autorização CLI pelo HTTP. As quatro famílias de adapters externos continuam mockadas com zero chamadas.

## Recovery e fixture lifecycle

O checkout real e o QA compartilham a seleção em recovery-policy e o mesmo BillingDomain. Recovery exige assinatura PAST_DUE/SUSPENDED, origem/ambiente corretos e ausência de outro entitlement ACTIVE/TRIALING válido. O QA não altera a origem de uma assinatura de provider real.

```sh
npm run billing:qa-simulate -- --company <UUID-QA> --action PAYMENT_PENDING --subscription <UUID-SUB-QA> --key <CHAVE>
npm run billing:qa-simulate -- --company <UUID-QA> --action PAYMENT_OVERDUE --payment <UUID-PAYMENT-QA> --grace-days 1
npm run billing:qa-fixture -- --source-company <UUID-QA-AUTORIZADA> --key <CHAVE>
```

A fixture é DEV-only, exige as flags comerciais e de comunicação QA e uma empresa-fonte na allowlist. Reutiliza seu OWNER ativo, não Super Admin, com email e telefone já autorizados. Cria somente uma Company chamada QA Billing Lifecycle e Membership OWNER: nenhum usuário/senha novo, assinatura, entitlement ou Evolution COMPANY. OWNER_WELCOME é marcado QA na mesma transação. Chave estável evita duplicação; fixture já utilizada por billing não é recriada.

A fixture NÃO adiciona o novo UUID à allowlist. É obrigatória autorização separada para configuração privada DEV antes de simular ou comunicar a nova empresa. Não executar fixture nem transições como parte do deploy.

Ver SUSPENDED-SUBSCRIPTION-RECOVERY.md para backfill administrativo e contratos reais.
