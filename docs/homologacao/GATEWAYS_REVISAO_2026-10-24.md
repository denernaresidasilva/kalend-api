# Gateways — revisão inicial oficial, 24/10/2026

Etapa iniciada após a homologação autenticada. Não se modificaram credenciais/configurações de gateways existentes. Só PagBank dispõe de configuração SANDBOX no DEV verificado; nenhum pagamento real foi executado. Esta revisão não encerra a homologação dos quatro provedores.

| Provedor | Adapter existente | Configuração necessária ao fluxo utilizado | Evidência atual / pendência |
|---|---|---|---|
| PagBank | Checkout hospedado `/checkouts`; recorrência separada | Token checkout; token recorrente apenas para produto recorrente; URLs Kalend geradas pelo backend; chave de webhook consultada remotamente | Checkout sandbox real e idempotência passaram; callback de pagamento/recorrência pendentes |
| Mercado Pago | Checkout Pro Preferences | Access token e segredo webhook; URLs Kalend geradas; validação de assinatura e confirmação do recurso | Inspeção local e documentação; sem credencial sandbox configurada nesta rodada |
| Stripe | Checkout Sessions | Chave secreta de API e segredo do endpoint webhook; URLs Kalend geradas | Inspeção local e documentação; sem credencial sandbox configurada nesta rodada |
| Asaas | Customers/Payments | API key e token webhook dedicado; cadastro fiscal do pagador quando exigido pela API | Inspeção local e documentação; sem credencial sandbox configurada nesta rodada |

Fontes oficiais consultadas:

- [PagBank: criar checkout](https://developer.pagbank.com.br/reference/criar-checkout): endpoint sandbox e URLs de notificação de checkout/pagamento distintas.
- [Stripe: Checkout Session](https://docs.stripe.com/api/checkout/sessions/create): endpoint e parâmetros do checkout hospedado.
- [Stripe: assinatura webhook](https://docs.stripe.com/webhooks/signature): assinatura deve ser verificada sobre corpo original com segredo do endpoint.
- [Mercado Pago: webhooks Checkout Pro](https://www.mercadopago.com.br/developers/en/docs/checkout-pro-preferences/additional-content/notifications/webhooks): validar os dados de assinatura do webhook, não aceitar evento apenas pelo payload.
- [Asaas: receber eventos](https://docs.asaas.com/docs/receba-eventos-do-asaas-no-seu-endpoint-de-webhook) e [FAQ](https://docs.asaas.com/docs/faq-de-webhooks): header `asaas-access-token`, token dedicado diferente da API key e persistência/idempotência antes da confirmação.

## Achado de formulário a tratar na próxima alteração de produto

P2: `components/gateway-form.tsx` mostra “Identificação pública” genérica nos quatro provedores. Nenhum dos quatro adapters atuais consome `publicId`; o fluxo é checkout hospedado. Remover esse campo da edição específica sem apagar silenciosamente metadados antigos, e usar rótulos de credencial por provedor. As URLs já são calculadas pelo Kalend; segredos continuam write-only. Não marcar recorrência como comprovada apenas porque o teste de conectividade passou.

Ajustar os formulários com regressões de preservação de segredo, troca de ambiente e payload mínimo antes da próxima republicação. Isso não depende de fornecer segredos na conversa. Para integração real dos outros três provedores, disponibilizar credenciais exclusivamente sandbox pelo mecanismo privado já existente; até lá prosseguir com verificações locais isoladas.

Inspeção adicional: página do checkout hospedado abriu HTTP 200 em `pagamento.sandbox.pagbank.com.br` e apresentou cartão/Pix/boleto. A seleção automatizada de cartão não completou no timeout; nenhum formulário de pagamento foi submetido e nenhum callback foi alegado. É uma limitação do ensaio browser neste checkout, não um defeito financeiro comprovado do Kalend.
