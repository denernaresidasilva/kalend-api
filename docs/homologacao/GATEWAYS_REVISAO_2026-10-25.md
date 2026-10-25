# Revisão dos gateways — 25/10/2026

## Resultado desta continuação

Foram revisados os quatro adapters efetivamente registrados: Stripe, Mercado Pago, PagBank e Asaas. Os testes locais cobriram contratos de checkout, ambiente, autenticação, assinatura de webhook, reconciliação, cancelamento e refund conforme aplicável. Não houve cobrança, estorno remoto ou alteração da configuração dos gateways.

Uma sessão Super Admin QA foi usada somente para `GET /payment-gateways`; a sessão foi encerrada em seguida. A configuração observada em DEV indicou PagBank SANDBOX conectado, sem recorrência habilitada; Mercado Pago, Stripe e Asaas não configurados. Nenhuma credencial foi retornada nem registrada. Portanto, não havia credenciais sandbox para contratos remotos dos outros três provedores.

## Revisão por provedor

| Gateway | Implementação observada | Segurança/contrato | Estado de teste externo |
|---|---|---|---|
| Stripe | Checkout Sessions em modo `payment`/`subscription`; segredo de API só no backend; header de idempotência; cancelamento imediato ou ao fim do período. | Confere prefixo test/live e `livemode`; assinatura do webhook sobre bytes originais e timestamp; checkout e metadata vinculam payment, company, plan e subscription. Campos usados no formulário: chave secreta; segredo de webhook separado. | Contratos locais aprovados. Sandbox remoto indisponível: sem credenciais configuradas em DEV. |
| Mercado Pago | Checkout Pro Preferences e `/preapproval`; credencial Bearer; URL de notificação e retorno geradas pelo Kalend; cancelamento e confirmação por consulta autenticada ao recurso. | Assinatura HMAC da notificação vincula `data.id`, `x-request-id` e timestamp; reconciliação busca o recurso na API. Idempotência é da aplicação, não declarada como nativa pelo adapter. | Contratos locais aprovados. Sandbox remoto indisponível: sem credenciais configuradas em DEV. O produto atualmente usa Preferences; a documentação oficial mantém essa referência, enquanto Orders é outra rota disponível e exige `X-Idempotency-Key`. A migração de produto não foi feita nesta correção. |
| PagBank | Checkout hospedado `/checkouts`; recorrência em API separada e explicitamente opt-in; URLs de notificação geradas pelo backend. | Token checkout e token de recorrência separados; chave pública webhook obtida pela API; ECDSA do corpo original; env SANDBOX/PRODUCTION aplicado aos hosts; cancelamento de recorrência sem prometer período restante. | Um checkout SANDBOX e idempotência já têm evidência DEV anterior. Não houve submissão de pagamento nem callback legítimo. Recorrência não habilitada nem configurada. |
| Asaas | Customers, Payments e Subscriptions; `access_token`; hosts sandbox/prod distintos; cobrança em checkout hospedado. | Token do webhook separado da API key (`asaas-access-token`); evento não é confiado sem refetch do pagamento. Idempotência é interna ao Kalend; exclusão de assinatura é imediata e remove cobranças pendentes/vencidas segundo o provedor. Configuração automática de webhook não está exposta pelo contrato do adapter, então a capability foi corrigida para `false`; configuração é externa/manual. | Contratos locais aprovados. Sandbox remoto indisponível: sem credenciais configuradas em DEV. |

## Correções locais desta rodada

1. PagBank: mudar o ambiente em modo checkout-only não exige token de recorrência. O formulário oculta o token enquanto recorrência estiver desligada; ao trocar ambiente com recorrência desligada, envia `null` para apagar a credencial cifrada no escopo antigo. Ao habilitar recorrência no ambiente novo, exige token novo, evitando reutilizar ciphertext cifrado com AAD do outro ambiente.
2. Asaas: re-fetch de pagamento agora soma apenas entradas de refund em estado `DONE`, preservando valores parciais. Uma resposta `REFUNDED` com refunds somente pendentes não é tratada como dinheiro devolvido. O fallback de valor integral existe só quando a API omite o array `refunds`. O webhook de Asaas também se inscreve em `PAYMENT_PARTIALLY_REFUNDED` e `PAYMENT_REFUND_IN_PROGRESS`.
3. Asaas: `webhookManagement` agora é falso, pois o método de cadastro não está conectado a rota/contrato acessível do fluxo Super Admin; evita alegar gestão automática que o produto não oferece.

## Validação executada

- API: 90 testes dirigidos de billing/adapters/gateways passaram; lint e build passaram.
- Web: 399 testes passaram com Node 24.21.0; TypeScript, ESLint e build passaram.
- Uma tentativa inicial da suíte Web com Node 18 falhou por `ERR_REQUIRE_ESM` em jsdom; repetida na versão Node 24 do projeto, passou integralmente.
- Nenhum teste pagou, submeteu checkout ou enviou comunicação externa nesta rodada.

## Situação de publicação e limites

As correções foram publicadas em DEV: API `14962deda4375ca2d703b385d279f3475ca14b0e` e Web `8d9d97035705c925f6c175fe551542a845d154d2`. O Actions API run `40181447763` concluiu com sucesso, confirmou `kalend_dev_migrator`/`kalend_dev`, encontrou zero migrations pendentes, compilou e reiniciou apenas `kalend-api-dev`; `/health` respondeu com o banco conectado. O Actions Web run `40181452419` teve uma primeira tentativa sem execução remota (timeout SSH), e a tentativa 2 concluiu com sucesso. Os SHAs no checkout DEV conferem com os commits publicados.

Smoke autenticado em DEV navegou pelas quatro configurações de gateway. As quatro páginas e seus GET de API responderam 200; cada formulário exibiu campos específicos do provedor; no PagBank o campo de recorrência aparece somente quando a opção é habilitada; não houve overflow em 390 e 1440 px. A API gerou as quatro URLs públicas no host `api-dev.kalend.tech`, cada uma no caminho `/webhooks/<gateway>`. Nenhuma configuração foi salva. A API confirmou que somente PagBank está configurado em SANDBOX e recorrência está desligada. Evidência sanitizada: [release smoke](evidencias/2026-10-25-gateways/release-smoke.json).

Isso comprova a publicação e a interface/contrato da configuração, não callbacks ou pagamento externo. Não classificar estes pontos como homologação financeira DEV.

Permanecem bloqueados por dependência externa:

- Configurar credenciais sandbox privadas de Stripe, Mercado Pago e Asaas para contrato remoto.
- Submeter um pagamento de teste PagBank e observar callback autenticado, usando comprador de teste do provedor.
- Habilitar recorrência SANDBOX PagBank com token próprio de recorrência e provar criação/cancelamento sem cobrança live.
- Confirmar entrega real de WhatsApp com destinatário QA autorizado e Push num dispositivo QA com subscription ativa.

## Continuação de homologação — 25/10/2026

Foi retomado o callback PagBank usando a fixture existente e sua proprietária QA
legítima, OWNER_B. A tentativa anterior com OWNER_A recebeu 403; a leitura
administrativa confirmou a associação existente de OWNER_B, cuja seleção de tenant
respondeu 200. PagBank segue habilitado em SANDBOX. A repetição protegida pela API
respondeu `CHECKOUT_ALREADY_PENDING` (HTTP 409), sem criar pagamento adicional.
O endpoint autenticado da proprietária confirmou o payment como `PENDING`,
`creationState=CREATED`, sem `paidAt`; o estado comercial continua CANCELED. O
checkout hospedado abriu em HTTP 200 e apresentou cartão, Pix e boleto. A sessão
foi encerrada (HTTP 204). A URL de teste foi guardada somente em arquivo local
privado, fora do repositório, com modo 0600 sob diretório 0700.

A documentação oficial define `/checkouts` como checkout hospedado e descreve as
notificações de alteração do pagamento. Os cartões fictícios publicados são
explicitamente delimitados a `/orders` e `/orders/pay`; não assumimos que funcionem
neste formulário. O checkout pode ser concluído por um comprador QA com instrumento
de teste oficialmente compatível. Assim, pagamento aprovado, callback legítimo e
recorrência permanecem pendentes; não foram promovidos na matriz. Fontes:
[teste de integração e sandbox PagBank](https://developer.pagbank.com.br/reference/testar-sua-integracao-pagamentos-recorrentes),
[escopo oficial dos cartões de teste](https://developer.pagbank.com.br/docs/cartoes-de-teste),
[fluxo Checkout hospedado](https://developer.pagbank.com.br/docs/checkout),
[endpoint de criação `/checkouts`](https://developer.pagbank.com.br/reference/criar-checkout).

Evidência sanitizada: `evidencias/2026-10-25-gateways/pagbank-callback-resume.json`.

## Documentação oficial consultada

- Stripe: [Checkout Sessions](https://docs.stripe.com/api/checkout/sessions/create), [assinatura de webhooks](https://docs.stripe.com/webhooks/signature), [idempotência](https://docs.stripe.com/api/idempotent_requests), [refunds](https://docs.stripe.com/api/refunds/create), [cancelamento de assinatura](https://docs.stripe.com/api/subscriptions/cancel).
- Mercado Pago: [Preferences API/Checkout Pro](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-preferences/overview), [autenticação](https://www.mercadopago.com.br/developers/pt/reference), [criação de Order e chave de idempotência](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-pro/create-order/post).
- Asaas: [refunds e valores parciais](https://docs.asaas.com/docs/refunds), [eventos de pagamento](https://docs.asaas.com/docs/payment-events), [remoção de assinatura](https://docs.asaas.com/reference/remove-subscription), [webhooks](https://docs.asaas.com/docs/receba-eventos-do-asaas-no-seu-endpoint-de-webhook).
- PagBank: [criar checkout](https://developer.pagbank.com.br/reference/criar-checkout), [webhooks de checkout](https://developer.pagbank.com.br/reference/webhooks-checkout), [autenticidade de notificações](https://developer.pagbank.com.br/reference/validacao-de-autenticidade), [refunds e recorrência](https://developer.pagbank.com.br/docs/pagamentos).
