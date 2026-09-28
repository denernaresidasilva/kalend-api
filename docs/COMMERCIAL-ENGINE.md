# Motor comercial — implementação local em develop

Data: 23/09/2026; revisão e validação final em 24/09/2026. Prisma permanece em 7.10.0. Nenhuma migration foi aplicada e nenhum banco, conta de pagamento ou ambiente de produção foi acessado. Integrações foram exercitadas com HTTP fake; não são integrações homologadas em contas reais.

## Auditoria anterior e decisões

Foram lidos package.json, schema, as quatro migrations anteriores, billing, subscriptions, plans, companies, auth, dashboard, finance, webhooks e a documentação existente. Não há AGENTS.md aplicável encontrado. A árvore estava limpa em develop. main apontava para `fbbf7032e7ee02d4adf40103c604be942740f2b4`; develop para `49cdae24e5db7f456b0f0146929addf3ea52c85c`.

Já existiam Plan/PlanFeature com preço mensal/anual, benefícios, destaque, limites e trial; Company/Membership; assinaturas e pagamentos; autenticação JWT em cookies; SUPER_ADMIN; criptografia AES-256-GCM com AAD; receivers de três gateways; processamento serializável; expiração administrativa. Essas bases foram reutilizadas. Faltavam adapters registrados, Asaas, checkout de outro plano, APIs de regularização e limites executáveis. A consulta pública não distinguia planos privados. O TenantGuard bloqueava a regularização de empresas suspensas. IDs externos eram únicos sem ambiente. A reconciliação só expirava assinaturas, sem consultar provedores.

Não foram criados módulos de comunicação ou Agenda. `ProductAccessGuard` e `EntitlementsService` são mecanismos a aplicar nas futuras operações de produto.

## Arquitetura

`GatewayRegistry` registra quatro adapters próprios. `gateway.types.ts` define capacidades e eventos internos; o transporte compartilhado controla hosts, timeout, redirects e sanitização. Cada adapter conserva caminhos, autenticação, valores monetários e mecanismos de assinatura próprios. `createSubscription`, `getSubscription`, `cancelSubscription` e `getRefund` são capacidades opcionais.

O fluxo é:

1. Sessão + membership + OWNER/ADMIN determinam companyId.
2. Checkout valida DTO por allowlist, carrega Plan ativo/público e preço em centavos.
3. Transação Serializable grava Subscription PENDING e Payment antes da chamada externa. Payment.id é externalReference; planId, companyId, billingInterval, amountCents, currency, gateway, environment e período ficam explícitos. Subscription guarda expectedAmountCents para renovações, sem consultar o preço novo do catálogo retroativamente.
4. Claim condicional READY → CREATING impede duas chamadas externas da mesma compra.
5. O adapter cria checkout/cobrança/mandato e os IDs retornados são armazenados; só confirmação financeira autenticada ativa acesso.
6. Webhook e reconciliação usam o mesmo processador serializável. A transação vincula pagamento/assinatura/empresa e registra o evento processado.

`Payment` foi estendido em vez de criar outro modelo de checkout redundante. MANUAL continua representando histórico e concessões administrativas. A ativação manual existente de empresa foi preservada e não gera receita fictícia.

### Timeouts e idempotência

A chave HTTP de checkout é vinculada ao companyId por SHA-256. O mesmo par retorna o mesmo registro; reutilizá-lo com outro plano, gateway, intervalo, recorrência ou ambiente falha. A chave enviada ao provedor é o UUID interno do Payment. Stripe recebe Idempotency-Key; cancelamento recorrente PagBank recebe x-idempotency-key. Não foi presumida idempotência nativa em endpoints de criação que não a documentam.

Uma resposta externa incerta deixa UNCERTAIN; queda do processo pode deixar CREATING. Nenhum desses estados é repetido cegamente. Reconciliar antes de qualquer intervenção. A trava não tem expiração automática: segurança contra cobrança duplicada prevalece sobre retry automático. Ausência de resultado numa busca não autoriza recriar imediatamente. Recuperação operacional de criação sem ID externo, especialmente Stripe/PagBank e mandato recorrente sem resposta, ainda exige localizar a referência no painel/API do provedor e procedimento DEV; não há endpoint para o frontend inventar IDs/status.

Checkout novo é recusado se já houver compra pendente ou assinatura paga vigente/mandato externo não cancelado. Isso impede duas recorrências simultâneas. Trocas com prorrata não foram implementadas: cancelar a assinatura anterior pelo fluxo existente e regularizar quando aplicável. Trial não cria mandato externo.

## Credenciais e ambientes

`GATEWAY_ENCRYPTION_KEY` continua sendo chave mestra de 32 bytes, em 64 caracteres hexadecimais, fornecida pelo backend. Secrets são write-only, AES-256-GCM, nonce aleatório e AAD `gateway:environment:campo`. Erros não retornam respostas externas, bodies, tokens ou ciphertext. Não há logging de payloads/credenciais nos adapters.

`GatewayConfiguration` mantém um ambiente por gateway por instalação. Credenciais Sandbox e produção devem ser provisionadas em instalações/bancos separados. Não se permite mudar o ambiente de um gateway com histórico de pagamentos. Trocar ambiente sem histórico exige substituir explicitamente todos os segredos correspondentes. Isso evita perder a capacidade de receber eventos financeiros do ambiente anterior. Índices de pagamentos, assinaturas e eventos incluem o ambiente; registros históricos com ambiente desconhecido não são associados por inferência.

Salvar/substituir secrets invalida conexão e desabilita criação de cobranças. Habilitar exige teste de conexão bem-sucedido na configuração atual. Escritas e testes usam comparação de updatedAt para impedir validação de configuração substituída durante uma requisição. Troca de ambiente verifica histórico em transação Serializable; a criação de intenção lê a versão/ambiente/habilitação da configuração na mesma transação financeira para detectar concorrência. Rotação de credenciais deve manter a mesma conta comercial; mudança de conta exige procedimento de migração de histórico, não troca silenciosa de token.

`enabled=false` bloqueia novos checkouts, mas receivers, consulta, cancelamento e reconciliação continuam funcionando com a credencial armazenada. Desabilitar um meio de venda não deve interromper confirmação/estorno de cobranças anteriores.

## Contratos HTTP

Todas as mutações web autenticadas continuam exigindo Origin autorizada. Nenhuma rota aceita status financeiro do frontend.

| Rota | Autorização | Entrada/comportamento |
| --- | --- | --- |
| GET /plans/public | Pública | Planos ativos e públicos, select explícito de campos comerciais e features habilitadas |
| GET /payment-gateways | SUPER_ADMIN | Quatro configurações, sem secrets |
| GET /payment-gateways/:gateway | SUPER_ADMIN | Mesmo contrato anterior + provider, capabilities, webhookUrl, webhookStatus, recurringConfigured |
| PATCH /payment-gateways/:gateway | SUPER_ADMIN | enabled, environment, publicId, credentials, webhookSecret; PagBank usa recurringCredentials e recurringEnabled; webhookSecret não nulo é recusado |
| POST /payment-gateways/:gateway/test | SUPER_ADMIN | Consulta real via adapter; erro sanitizado e disabled se falhar |
| POST /payments | SUPER_ADMIN | Contrato legado companyId/subscriptionId/planId/gateway/idempotencyKey preservado; vínculo validado |
| GET /billing/regularization | OWNER/ADMIN do tenant | Estado comercial, motivo, trial, plano, planos públicos, gateways habilitados e checkout pendente |
| POST /billing/checkout | OWNER/ADMIN do tenant | planId, billingInterval, gateway, idempotencyKey, recurring opcional, taxId quando Asaas |
| POST /billing/subscriptions/:id/cancel | OWNER/ADMIN do tenant | `{atPeriodEnd:boolean}`; busca por id **e companyId autorizado** |
| POST /billing/reconcile | SUPER_ADMIN | Sem body; consulta gateway e depois aplica expiração/grace |
| POST /webhooks/:id/reprocess | SUPER_ADMIN | Reconsulta recurso externo de evento FAILED |
| POST /webhooks/mercado-pago | Assinatura do provedor | HMAC/consulta autenticada; raw body e query data.id |
| POST /webhooks/stripe | Assinatura do provedor | Stripe-Signature sobre bytes originais |
| POST /webhooks/pagbank | Assinatura do produto | ECDSA SHA-256 obrigatório, RAW BODY e chave WEBHOOK consultada pela API |
| POST /webhooks/asaas | Token dedicado de webhook | asaas-access-token e consulta autenticada da cobrança |

Receivers confirmam HTTP 200. Não exigem cookie/JWT administrativo. Eventos autenticados fora do escopo retornam sem mutação financeira. Erros de autenticidade falham antes do processamento. Ainda não existe fila de ingestão; indisponibilidade do provedor/banco depende de retry do gateway e reconciliação.

Checkout não recebe companyId, amountCents, currency, environment, trialDays ou status. Campos adicionais são recusados. Asaas requer CPF/CNPJ (taxId) como dado do pagador, não como fonte de autorização; esse dado não é armazenado em Payment nem enviado ao log. Nome/e-mail vêm do OWNER ativo no banco. Não se recebe número de cartão/CVV; o pagamento é hospedado pelo provedor.

Exemplo de entrada (identificadores substituídos pelo cliente):

```json
{
  "planId": "UUID_DO_PLANO_PUBLICO",
  "billingInterval": "MONTHLY",
  "gateway": "ASAAS",
  "idempotencyKey": "IDENTIFICADOR_DA_OPERACAO",
  "recurring": false,
  "taxId": "CPF_OU_CNPJ_DO_PAGADOR"
}
```

Resposta de checkout inclui id, companyId, subscriptionId, planId, amountCents, currency, billingInterval, gateway, environment, status, externalReference, externalPaymentId, externalCheckoutId, checkoutUrl, recurring, creationState e período. Redirect não ativa assinatura. Recarregar regularization após retorno do provedor.

`GET /billing/regularization` inclui accessAllowed, status, reason, trialExpired, subscription resumida, plans, gateways disponíveis e pendingCheckout. O status derivado TRIAL_EXPIRED é apresentado mesmo antes da manutenção persistir EXPIRED. Não há preço/plano hardcoded na landing page.

## Trial, inadimplência e cancelamento

O mecanismo anterior de trial grava trialStartedAt e trialEndsAt na criação da empresa. Alterar Plan.trialDays não atualiza registros existentes. No fim do trial, a rotina marca EXPIRED e suspende a empresa sem outra assinatura elegível. A autenticação continua validando User e sessão, sem exigir assinatura.

`/auth/me` e a seleção do tenant permitem membership ativa em empresas comercialmente SUSPENDED/CANCELED. A exceção `BillingRecovery` aplica-se apenas às rotas comerciais. TenantGuard normal continua negando empresa suspensa. ProductAccessGuard consulta datas/entitlements atuais para proteger futuras operações, mesmo antes do cron atualizar status. Não aplicá-lo em auth, perfil, suporte, catálogo ou regularização.

Após trial Premium, checkout Pro cria uma nova assinatura PENDING vinculada ao Pro. A aprovação ativa esse registro e encerra trials anteriores. Nenhum plano é descoberto pelo valor nem herdado do trial.

Inadimplência usa ACTIVE → PAST_DUE (graceEndsAt, se configurado) → SUSPENDED. `BILLING_GRACE_DAYS` é configurável; ausente equivale a nenhuma concessão de graça. O prazo é gravado uma vez, sem estender por eventos repetidos. APPROVED de cobrança válida pode reativar EXPIRED/PAST_DUE/SUSPENDED, mas nunca reverte CANCELED. Falha/atraso nunca concede acesso.

Cancelar com atPeriodEnd=true é suportado externamente pelo Stripe. Outros adapters recusam essa capacidade explicitamente. Cancelamento imediato chama o gateway e depois persiste estado local. cancellationRequestedAt registra tentativa; falha externa não é mascarada como cancelamento confirmado. Repetir após falha consulta/aciona operação idempotente de cancelamento conforme provedor. Cancelamento local sem mandato também preserva histórico. Nenhum registro financeiro é apagado.

Refund total revoga somente o período corrente que aquele pagamento financiou; não revoga outra assinatura válida. Refund parcial mantém entitlement e acumula refundedAmountCents; dashboard/financeiro subtraem esse valor. Para PagBank recorrente, refundId estabiliza idempotência de estornos incrementais. Evento atrasado de aprovação não desfaz refund. Eventos de mandato ACTIVE apenas vinculam o mandato, sem conceder acesso pago.

## Webhooks, renovação e reconciliação

O processador valida gateway, ambiente, referência, relação assinatura/empresa/plano, valor inteiro e moeda antes de alteração financeira. Renovações usam expectedAmountCents/currency da assinatura; datas/ciclo vêm do recurso autenticado, nunca do frontend. Faturas adicionais têm Payment próprio e identificador externo único. O primeiro pagamento vincula a intenção original.

Unicidade `(gateway, environment, externalEventId)`, claim condicional e transação Serializable evitam duplicação. Conflitos de serialização/unicidade no processador têm até três tentativas. Outras operações Serializable podem devolver conflito para retry da mesma operação pelo cliente; não afirmamos que mocks demonstram locks PostgreSQL.

`/billing/reconcile` processa até 100 pagamentos por chamada, ordenados pela última atualização, registra checked/failed e só então executa manutenção de datas. Pagamentos pendentes/falhos/atrasados e recorrentes elegíveis são consultados. Resposta mantém expired/reconciledAt e adiciona paymentsChecked/paymentsFailed/batchLimit. Agendar externamente em DEV após revisão; nenhum cron/deploy foi criado.

Limitações de recuperação e paginação são explícitas por adapter; nunca converter consulta incompleta em aprovação. Refunds avulsos antigos continuam dependendo de webhook/reprocessamento: a varredura não reconsulta todo o histórico de pagamentos aprovados não recorrentes.

## Limites de planos

Plan existente já continha maxProfessionals/maxClients/maxUnits. Foram acrescentados maxMessages e isPublic. Benefícios continuam em PlanFeature; não há duplicação com outro catálogo.

EntitlementsService consulta assinatura vigente no banco e usa PlanFeature.enabled. assertMembershipLimit conta memberships ativas de PROFESSIONAL/CLIENT. assertLimit aceita contagem interna do serviço, não DTO HTTP. Para prevenir corrida, a contagem, assert e criação do recurso devem estar **na mesma transação Serializable**. Unidade/mensagem ainda não têm modelos de produto; seus serviços futuros deverão fornecer contagens reais da mesma transação. Não existe endpoint para o cliente fornecer uso.

Erro HTTP 403 estruturado:

```json
{"code":"PLAN_LIMIT_REACHED","feature":"professionals","current":5,"limit":5,"upgradeRequired":true}
```

Limite null significa ilimitado; zero bloqueia criação. Recursos ausentes/desabilitados retornam PLAN_FEATURE_UNAVAILABLE; assinatura sem entitlement retorna SUBSCRIPTION_REQUIRED.

## Variáveis e Sandbox

| Variável | Situação/uso |
| --- | --- |
| GATEWAY_ENCRYPTION_KEY | Existente; segredo do backend, nunca preencher exemplo real |
| DATABASE_URL | Existente; não utilizada para validações de banco nesta tarefa |
| AUTH_* | Existentes; contratos/cookies preservados |
| BILLING_PUBLIC_API_URL | Nova; base HTTPS pública da API do ambiente, sem credenciais |
| BILLING_RETURN_URL | Nova; URL HTTPS de retorno da interface, definida pelo servidor |
| BILLING_GRACE_DAYS | Nova opcional; inteiro 0..999, ausente = 0 |

Credenciais dos provedores não ganharam variáveis paralelas: continuam no cofre de GatewayConfiguration. PagBank recurringCredentials também é criptografada; webhookSecret não é aceito para novas configurações PagBank; valores legados são ignorados. A chave pública WEBHOOK é consultada na API e mantida apenas em cache temporário de memória. Nunca usar chave RSA de criptografia de cartões como chave de notificações.

Após revisão, preparar instalação DEV com migrations, URLs HTTPS e chave mestra pelo gerenciador de secrets. Salvar SANDBOX via SUPER_ADMIN, salvar segredo de webhook específico, testar conexão e habilitar numa segunda ação. No painel do provedor configurar receiver, ambiente e eventos descritos em [GATEWAY-PROVIDERS.md](GATEWAY-PROVIDERS.md). Asaas tem método interno configureWebhook preparado; não é disparado pelo teste de conexão nem exposto como mutação pública.

Executar checkout com conta/pagador de teste; entregar webhook, repetir evento, interromper entrega e reconciliar; validar recorrência, cancelamento e refund. Nenhuma credencial ou conta real foi utilizada nesta entrega.

## Migration e segurança operacional

`20260923190000_commercial_engine` é aditiva em campos/enums e substitui índices de referências para incluir ambiente. Migrations anteriores foram preservadas. Há backfill do intervalo de pagamentos a partir de sua assinatura e classificação conservadora do estado de criação legado. Não se atribui ambiente/preço retroativo por inferência.

A migration comercial histórica remove priceCents e adiciona monthlyPriceCents obrigatório sem backfill; esse risco preexistente em banco populado deve ser revisado separadamente. Não houve tentativa de “corrigir” executando DDL em ambiente remoto.

A rede dos adapters só aceita hosts oficiais constantes, HTTPS sem userinfo/portas, sem redirects; IDs têm charset restrito. Links fornecidos pelo gateway nunca são usados como URL de consulta autenticada. checkoutUrl tem allowlist de domínios. Timeout é 15s e respostas têm limite de tamanho após leitura. Instrumentação/proxy externos devem redigir cookies e corpos de configuração; esses sistemas não foram alterados.

## Testes e limites da validação

Ver [COMMERCIAL-VALIDATION.md](COMMERCIAL-VALIDATION.md) para resultados finais. Testes unitários usam fakes de Prisma/HTTP e testes HTTP usam Nest/Supertest com banco fake. Eles exercitam regras, assinatura e contratos locais, mas não provam a resposta efetiva de uma conta de gateway, homologação, aplicação das migrations nem concorrência em PostgreSQL. Não existe PostgreSQL/psql/docker disponível neste ambiente de execução.

### Revisão PagBank de 28/09/2026

Checkout e listagem de faturas não têm envelope financeiro público comprovado. Esses percursos de reconciliação falham explicitamente sem emitir eventos; assinatura ACTIVE não concede acesso. Teste de credenciais retorna checks separados e não representa homologação. Endpoint de chave diverge entre guia e referência: adotado `/public-keys/webhook` da referência, sem fallback. Detalhes, cache/rotação e pendências em [GATEWAY-PROVIDERS.md](GATEWAY-PROVIDERS.md#pagbank--revisão-corretiva-de-28092026). **PENDENTE DE HOMOLOGAÇÃO SANDBOX**.
