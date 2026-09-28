# Adapters e documentação oficial consultada

Consulta em 23/09/2026. As URLs abaixo foram consultadas antes da implementação; quando a página HTML ocultava campos, foi usada sua versão oficial `.md` com OpenAPI. Nenhuma conta de gateway foi acessada. Testes de contrato locais usam respostas fake: validar os payloads efetivos da conta Sandbox é obrigatório antes de habilitar integração no DEV.

## Mercado Pago

Adapter: `src/billing/adapters/mercado-pago.adapter.ts`.

- Autenticação Bearer no host fixo api.mercadopago.com; teste em `/users/me` confirma conta de teste por tags. Sandbox usa vendedor/comprador de teste; não se decide ambiente somente pelo prefixo do token. Checkout retorna sandbox_init_point ou init_point conforme ambiente.
- Checkout Pro cria preferência com external_reference=Payment.id. Preapproval cria recorrência pending com external_reference=Subscription.id, frequência em meses e preço definido no backend. Não coleta cartão no Kalend.
- Consulta `/v1/payments/:id`, busca por external_reference; recorrência consulta preapproval e authorized_payments. Cancelamento usa preapproval status cancelled.
- Webhooks tratados: payment, subscription_preapproval, subscription_authorized_payment. HMAC usa data.id da query, x-request-id e ts, comparado em tempo constante, com tolerância de cinco minutos. O recurso financeiro é reconsultado e live_mode é conferido.
- IPN/legados e produtos sem essa assinatura não são aceitos por este receiver. Não se atribui o mesmo mecanismo automaticamente a Orders, Point, QR ou outras integrações. Validar a entrega autenticada do produto Assinaturas da conta antes de habilitar recorrência.
- Pagamentos normalizados: pending/in_process/authorized, approved, rejected, cancelled, refunded/charged_back. O valor é convertido de unidades decimais para centavos com validação. Reembolso é acumulado por transaction_amount_refunded.
- Não foi presumida chave idempotente em criação de preferência/preapproval. O claim interno e UNCERTAIN impedem repetição automática. Páginas acima do limite de reconciliação retornam pendência explícita, não aprovação incompleta.

Fontes oficiais:

- [Criar preferência](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-preferences/create-preference/post)
- [Criar preapproval](https://www.mercadopago.com.br/developers/en/reference/online-payments/subscriptions/create-preapproval/post)
- [Consultar preapproval](https://www.mercadopago.com.br/developers/pt/reference/online-payments/subscriptions/get-preapproval/get)
- [Webhooks, assinatura e tabela de recursos](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/additional-content/your-integrations/notifications/webhooks)

## Stripe

Adapter: `src/billing/adapters/stripe.adapter.ts`.

- API REST com Bearer, formulário URL-encoded, Idempotency-Key e versão fixada `2025-06-30.basil`. A versão do endpoint de webhook precisa ser compatível. Não segue automaticamente alterações da versão padrão da conta.
- Checkout Session payment/subscription com line_items calculados no backend. Metadata inclui Payment, Subscription, Company e Plan; client_reference_id mantém referência interna. Sem cupons/prorrata/taxas adicionais neste contrato: divergência de total requer revisão comercial, não inferência de plano.
- Chaves test/live e livemode são validados. Teste consulta balance. Browser redirect nunca concede acesso.
- Eventos: checkout.session.completed, async_payment_succeeded/failed; invoice.paid/payment_failed/voided/marked_uncollectible; payment_intent.succeeded/payment_failed/canceled; customer.subscription.created/updated/deleted/paused/resumed; charge.refunded.
- Stripe-Signature usa raw body, timestamp e HMAC SHA-256; aceita uma assinatura v1 válida e rejeita timestamps fora de cinco minutos. Recursos são reconsultados na conta autenticada.
- Invoice é identidade financeira de recorrência. Invoice Payments vincula PaymentIntent e valores estornados; o mesmo pagamento não vira uma segunda receita. Consultas de assinatura não concedem entitlement sem pagamento.
- Cancelamento imediato usa DELETE; ao fim do período usa cancel_at_period_end. A consulta de invoices reconcilia entregas perdidas, com limite explícito de paginação.

Fontes oficiais:

- [Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)
- [Listar Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/list)
- [Webhooks](https://docs.stripe.com/webhooks)
- [Tipos de eventos](https://docs.stripe.com/api/events/types)
- [Invoice](https://docs.stripe.com/api/invoices/object)
- [Invoice Payments](https://docs.stripe.com/api/invoice-payment/list)
- [Objeto Invoice Payment](https://docs.stripe.com/api/invoice-payment/object)
- [Consultar PaymentIntent](https://docs.stripe.com/api/payment_intents/retrieve)
- [Atualizar assinatura](https://docs.stripe.com/api/subscriptions/update)
- [Cancelar assinatura](https://docs.stripe.com/api/subscriptions/cancel)
- [Versionamento](https://docs.stripe.com/api/versioning)

## PagBank — revisão corretiva de 28/09/2026

Adapter: `src/billing/adapters/pagbank.adapter.ts`. Nenhuma chamada financeira real foi feita na revisão.

### Autenticidade e chave pública

`x-payload-signature` é obrigatório para todo evento deste receiver. Usa ECDSA/SHA-256 com assinatura Base64 e chave pública X.509/SPKI EC. O Buffer original capturado pelo Nest (`rawBody: true`) é verificado antes do parse no adapter. Reformatar JSON, espaços, quebras de linha ou UTF-8 invalida a assinatura. Não há fallback para `x-authenticity-token`, chave manual ou chave RSA de cartão. Produtos que ainda entreguem somente o mecanismo antigo ficam bloqueados até homologação explícita.

A chave vem de GET `/public-keys/webhook`, Bearer com a credencial principal, host HTTPS fixo por ambiente (`sandbox.api.pagseguro.com` / `api.pagseguro.com`). Esse caminho e o tipo `webhook` estão definidos na referência OpenAPI **Consultar chave pública**. A página **Validação de autenticidade** usa alternativamente `/public-keys?type=webhook` e ressalva confirmação da URL de produção. Não há tentativa automática em caminhos alternativos: **PENDENTE DE HOMOLOGAÇÃO SANDBOX** confirmar o endpoint e, antes de qualquer produção, resolver a ressalva com o PagBank. O exemplo genérico RSA da referência não autoriza usar CARD: o adapter exige EC.

Cache somente em memória, sem persistência no cofre, TTL de 5 minutos, até 32 entradas, escopo por hash de ambiente/token/versão da configuração. Consultas simultâneas da mesma chave compartilham a requisição. Após falha criptográfica, atualiza a chave respeitando intervalo mínimo de 30 segundos entre atualizações. Nova credencial/configuração não reutiliza a entrada anterior. Falha de consulta pode usar somente cache ainda válido, sempre exigindo assinatura correspondente; cache expirado nunca é recuperado por fallback. Não executa PUT para renovar chaves no provedor. A renovação administrativa oficial exige sete dias desde criação; sua entrega efetiva precisa de Sandbox.

Headers repetidos e valores separados por vírgula são normalizados; cada assinatura Base64 válida é verificada independentemente. Basta uma corresponder ao corpo original. Valores malformados não impedem testar os demais; nenhuma válida resulta em 401. Há limite defensivo de 16 assinaturas, com rejeição da requisição acima desse total; valores acima de 16 KiB são ignorados como inválidos. Falha de aquisição de chave confiável resulta em 503 sanitizado.

`webhookSecret` não é mais usado pelo PagBank e novos valores não nulos são recusados. Valor legado eventualmente armazenado permanece intacto, mas é ignorado. A chave pública não é segredo. Tokens principal/recorrente continuam criptografados.

### Teste de conexão

O teste consulta a chave WEBHOOK, nunca CARD. Quando recorrência está configurada, consulta `/subscriptions?limit=1&offset=0` apenas para verificar acesso, sem enumerar assinaturas. Retorna `checks`: `CREDENTIALS_VALID`, `WEBHOOK_KEY_AVAILABLE`, webhook `UNVERIFIED`, recorrência `RECURRING_AVAILABLE` ou `NOT_TESTED`, e `RECONCILIATION_UNVERIFIED`. `CONNECTED`/`connected` mantêm compatibilidade e representam conectividade; não homologação financeira. GET de configuração mantém `REMOTE_KEY_UNVERIFIED`; não persiste comprovação de webhook. Habilitação administrativa não elimina as limitações abaixo.

### Checkout, invoices e paginação

- GET `/checkouts/{checkout_id}`: Bearer principal, `CHEC_...`, `offset` como item inicial, `limit` padrão 10/máximo 100. O exemplo oficial contém metadados do checkout, mas não define pagamentos associados nem seus IDs financeiros. O adapter consulta `limit=100&offset=0` e retorna `PAGBANK_CHECKOUT_CONTRACT_UNVERIFIED` (503), inclusive se receber um plausível `payments[]` ou status PAID. Não deriva referência financeira dessa resposta.
- GET `/subscriptions/{subscription_id}/invoices`: host de assinaturas, Bearer recorrente, `SUBS_...`; status opcionais PAID/UNPAID/WAITING/OVERDUE (ausente: todos), offset padrão 0, limit padrão 100. A descrição chama offset de número/deslocamento de página, mas o schema de resposta tem propriedades vazias e exemplo `{}`. Não comprova `invoices[]`, metadados de continuidade ou passo do offset. O adapter consulta a primeira página explicitamente e retorna `PAGBANK_INVOICES_CONTRACT_UNVERIFIED` (503), sem sequer emitir evento de assinatura.
- Esses dois percursos estão **PENDENTES DE HOMOLOGAÇÃO SANDBOX**. A paginação não é declarada completa após 100 itens: não há processamento de páginas parciais. Não foi implementado loop baseado em envelope inventado. Confirmar envelope, IDs, relacionamento e término/continuidade antes de liberar o percurso.
- GET `/invoices/{invoice_id}` tem schema próprio documentado: `INVO_...`, status, amount.value/currency, subscription.id e occurrence. GET `/charges/{id}` usa `CHAR_...`. As consultas verificam que o ID retornado corresponde ao solicitado. Consulta direta de charge na reconciliação exige também reference_id igual ao Payment interno; o processador valida amount/currency/relações antes da atualização Serializable.

### Demais limitações e proteções

Checkout envia reference_id do Payment e recurrence_plan MONTH/YEAR com crédito, sem retry automático de criação. Criação incerta continua UNCERTAIN/CREATING e não é refeita cegamente. Checkout recorrente exige habilitação, elegibilidade e token de recorrência; a documentação atual exclui PF da integração de recorrência via API. Confirmar elegibilidade específica da conta PJ. Recorrência, entrega de eventos e dois ciclos reais continuam pendentes.

Cancelamento imediato: PUT `/subscriptions/{id}/cancel`, Bearer recorrente e x-idempotency-key estável; cancelamento ao fim do período não é suportado. Consulta de estorno usa REFU → PAYM → INVO, verifica IDs e moeda; SUCCESS tem refundId estável e delta sob idempotência transacional. Não foi adicionada criação de estornos. Refund parcial/total, entrega repetida e associação ao ciclo precisam de Sandbox.

Eventos subscription.* dependentes da listagem de faturas falham integralmente; não alteram Payment/Subscription. Order autenticado é reconsultado, seu ID e charges são validados e as charges são reconsultadas individualmente. Invoice permanece identidade canônica de recorrência, evitando receita duplicada pela charge inicial. Status desconhecido nunca é aprovação. Webhook e reconcile usam o mesmo processador, claims, índices únicos, transação Serializable e retries limitados de conflito de banco; nenhum retry cego de operação financeira externa foi adicionado.

Transporte preservado: allowlist de hosts, TLS, redirects proibidos, timeout de 15 segundos, respostas limitadas e erros sanitizados, sem logs de token, chave ou payload. Os testes usam somente fetch fake e chaves efêmeras; corridas reais de PostgreSQL permanecem pendentes.

### Fontes oficiais reconsultadas

Consultadas em 28/09/2026, incluindo `.md` com OpenAPI quando disponível:

- [Validação de autenticidade](https://developer.pagbank.com.br/reference/validacao-de-autenticidade)
- [Consultar chave pública](https://developer.pagbank.com.br/reference/consultar-chave-publica)
- [Consultar Checkout](https://developer.pagbank.com.br/reference/consultar-checkout)
- [Listar faturas de uma assinatura](https://developer.pagbank.com.br/reference/listar-faturas-de-assinatura)
- [Consultar fatura](https://developer.pagbank.com.br/reference/consultar-fatura)
- [Consultar pagamento recorrente](https://developer.pagbank.com.br/reference/consultar-pagamento-1)
- [Consultar estorno](https://developer.pagbank.com.br/reference/consultar-estorno)
- [Cancelar assinatura](https://developer.pagbank.com.br/reference/cancelar-assinatura)
- [Checkout e Checkout Recorrente](https://developer.pagbank.com.br/docs/checkout)
- [Pagamentos Recorrentes e elegibilidade](https://developer.pagbank.com.br/docs/pagamentos-recorrentes)

## Asaas

Adapter: `src/billing/adapters/asaas.adapter.ts`.

- Sandbox `api-sandbox.asaas.com/v3`; produção `api.asaas.com/v3`. API key no header access_token, User-Agent do backend. Teste consulta finance/balance.
- Cliente localizado por externalReference=Company.id antes de criar; cadastro usa CPF/CNPJ e notificationDisabled=true. Notificações próprias do Kalend não foram implementadas. Cobrança UNDEFINED gera fatura hospedada, com externalReference=Payment.id. Descontos/juros/multa são zerados neste contrato para manter o preço esperado.
- Recorrência MONTHLY/YEARLY cria Subscription com externalReference=Subscription.id. A criação não confirma pagamento. Cobranças geradas são consultadas pela assinatura e vinculadas individualmente. Cancelamento usa DELETE subscriptions/:id; preserva histórico Kalend. Sem cancelamento agendado automático neste adapter.
- Webhook exige asaas-access-token com token dedicado, diferente da API key. Comparação em tempo constante; evento id é persistido para idempotência e a cobrança é reconsultada no host do ambiente. Não se presume HMAC ou timestamp que o produto não documenta.
- PAYMENT_* normaliza estados pendente, recebido/confirmado, atrasado, falha, cancelado e estornado; PAYMENT_CREDIT_CARD_CAPTURE_REFUSED é falha quando a consulta ainda está pendente. SUBSCRIPTION_CREATED/UPDATED/INACTIVATED/DELETED vinculam ou suspendem/cancelam mandato, sem ativação por criação. RECEIVED_IN_CASH não é aprovação automática no Kalend.
- Método interno configureWebhook prepara POST /webhooks com URL controlada, authToken separado e eventos explícitos; não existe ação automática durante teste/conexão. Preparado para futura ação administrativa, sem expor o segredo retornado pelo provedor.
- Não há header de idempotência inventado para cobranças/clientes. Claim local evita execução duplicada e timeout exige reconciliação por externalReference. Duplicatas de clientes já existentes fazem a operação falhar para revisão.

Fontes oficiais:

- [Criar cliente](https://docs.asaas.com/reference/criar-novo-cliente)
- [Listar clientes](https://docs.asaas.com/reference/listar-clientes)
- [Criar cobrança](https://docs.asaas.com/reference/criar-nova-cobranca)
- [Listar cobranças](https://docs.asaas.com/reference/listar-cobrancas)
- [Consultar cobrança](https://docs.asaas.com/reference/recuperar-uma-unica-cobranca)
- [Criar assinatura](https://docs.asaas.com/reference/criar-nova-assinatura)
- [Consultar assinatura](https://docs.asaas.com/reference/recuperar-uma-unica-assinatura)
- [Listar assinaturas](https://docs.asaas.com/reference/listar-assinaturas)
- [Remover assinatura](https://docs.asaas.com/reference/remover-assinatura)
- [Webhooks](https://docs.asaas.com/docs/webhooks-2)
- [Eventos de cobranças](https://docs.asaas.com/docs/webhook-para-cobrancas)
- [Eventos de assinaturas](https://docs.asaas.com/docs/eventos-para-assinaturas)
- [Criar webhook](https://docs.asaas.com/reference/criar-novo-webhook)
- [Saldo](https://docs.asaas.com/reference/recuperar-saldo-da-conta)

## Aceitação em DEV

Para cada gateway: confirmar a conta/ambiente, testar credencial, criar checkout com pagador de teste, validar retorno e webhook com bytes reais, reentregar o mesmo evento, simular atraso/falha/estorno/cancelamento, interromper webhook e reconciliar. Recorrência requer pelo menos dois ciclos distintos e refund de um ciclo anterior. Verificar que alterar preço do catálogo não altera snapshots de compras já iniciadas e que trial Premium seguido de Pro concede apenas Pro.

Validar também disputa real entre webhook e reconcile em PostgreSQL, queda após criação externa, chaves/cookies/Origin em HTTPS DEV, limites sob criação concorrente e migration em banco descartável. Não habilitar produção com base apenas nos testes fake desta entrega.
