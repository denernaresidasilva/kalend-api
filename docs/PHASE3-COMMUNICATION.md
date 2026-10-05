# Fase 3 — Gmail OAuth e Web Push GLOBAL

Entrega local sobre `develop`, base `88c979e`. Não há alteração no frontend, credenciais reais, deploy, commit, push, execução de worker/scheduler ou migration em DEV/produção. Todas as migrations foram validadas exclusivamente em PostgreSQL16 descartável e o banco/cluster foram removidos. Testes de aplicação usam credenciais efêmeras e persistência simulada; não representam homologação dos fornecedores.

## Auditoria e decisões

Foram examinados schema/migrations, comunicação, autenticação/sessões/Origin/AdminGuard, usuários/memberships/empresas, billing/gateways, cofre, outbox, worker/scheduler, testes e contratos em `kalend-web/lib/{communication,contracts,api,commercial}.ts`. A arquitetura captura fatos de negócio por triggers PostgreSQL e expande eventos para proprietários ativos. Preserva os 13 IDs técnicos existentes, SMTP/Meta/Evolution e a captura transacional.

`GMAIL` passa a ter adapter real. `PUSH_PENDING` permanece como identificador persistido/público de compatibilidade da Fase 2, com transporte efetivo `WEB_PUSH`. Não é renomeado para evitar quebrar templates/histórico/frontend. O frontend atual ainda mostra “Em breve”; sua atualização é uma etapa posterior, não foi feita aqui.

`GlobalPushSubscription` e `GlobalGmailOAuthState` são exclusivos GLOBAL. Não há companyId nas subscriptions e não se reutilizam credenciais, templates ou destinatários tenant. O provider extensível e plataformas WEB/ANDROID/IOS deixam espaço para tokens nativos cifrados no futuro; somente WEB_PUSH/WEB pode ser registrado/enviado hoje. A abstração `Transport` continua pertencendo ao motor de comunicação; futuros transports nativos deverão implementar seus contratos reais antes de habilitação.

Não foram criadas preferências de canal: os eventos atuais não possuem classificação transacional/segurança/marketing nem política de obrigatoriedade. Um opt-out amplo poderia suprimir segurança e cobrança. Não foram criadas preferências visuais, consentimentos legais, branding tenant ou Service Worker backend.

## Gmail: configuração e fluxo

1. Super Admin configura `PATCH /communication/providers/GMAIL` com `config:{clientId,fromEmail}`, `secrets:{clientSecret}` e ambiente. Secrets são write-only; `refreshToken` e `accessToken` enviados por clientes são rejeitados. Alterar client, secret ou remetente remove autorização anterior e exige reconexão.
2. `POST /communication/gmail/connect`, body `{}`/ausente, cria state e binding de 256 bits, PKCE S256 e validade de 10 minutos. Guarda apenas hashes de state/binding, verifier cifrado, sessão, ator, revisão e callback controlado pelo servidor. Retorna `{authorizationUrl,expiresIn:600}` e cookie `__Host-kalend_gmail_oauth`, HttpOnly/Secure/SameSite=Lax/Path=/, sem Domain. O navegador deve iniciar navegação para a autorização retornada. Uma segunda conexão na mesma sessão de navegador substitui o binding; completar a última.
3. Google usa callback HTTPS exato configurado em `COMMUNICATION_GMAIL_CALLBACK_URL`. Nenhuma URL de retorno é recebida do cliente. GET `/communication/gmail/callback` é uma rota de protocolo sem AdminGuard: exige state, cookie próprio, sessão iniciadora vigente, usuário ativo Super Admin e snapshot da senha ainda válido. Valida novamente a sessão antes de persistir. Consome state atomicamente antes da troca de code; replay/concorrrência/negação/erro não reaproveitam state.
4. Troca code por tokens em POST form-urlencoded para `oauth2.googleapis.com/token`, incluindo client secret, callback e verifier. Requer refresh token e escopo Gmail de envio. Consulta email verificado de Google e exige correspondência com `fromEmail`; não suporta aliases arbitrários nesta fase.
5. Tokens/access expiry/accountEmail ficam no SecretVault AES-256-GCM com AAD `communication:GLOBAL:GMAIL:<environment>:credentials`; verifier tem AAD próprio por hash de state. Nenhum token/client secret/ciphertext é retornado. Callback responde texto fixo sem scripts/recursos/redirects, com no-store, no-referrer e CSP. Nenhum authorization code é logado pelo código.
6. Conexão termina com `enabled:false`. `test`, `send-test` e habilitação continuam explícitos, usando rotas existentes. `send-test` lê email do Super Admin atual; eventos automáticos leem proprietários pelas regras do outbox.

Escopos: `https://www.googleapis.com/auth/gmail.send`, `openid`, `email`. Sem leitura de caixas ou senha Google. `openid email` serve para consultar a conta via endpoint userinfo, não para autenticar usuário no Kalend; ID tokens não são aceitos como login. Verificação de conexão confirma token e conta, não garante entregabilidade de Gmail. Somente teste de envio/homologação verificam esse aspecto.

| Método | Endpoint | Resultado |
| --- | --- | --- |
| GET | `/communication/gmail/status` | configured, connected, accountEmail, reconnectRequired |
| POST | `/communication/gmail/connect` | autorização/reconexão, expiresIn e cookie de binding |
| GET | `/communication/gmail/callback` | resposta fixa de sucesso/cancelamento/erro |
| POST | `/communication/gmail/disconnect` | disconnected, remoteRevoked |
| PATCH | `/communication/providers/GMAIL` | configuração pública/revisão, secret write-only |
| POST | `/communication/providers/GMAIL/test` | connected, sendTested:false |
| POST | `/communication/providers/GMAIL/send-test` | accepted:true, delivered:false |

Todos exceto callback exigem AdminGuard. Mutação exige Origin permitida. Connect: 3/admin/10min e 10 GLOBAL/10min; disconnect compartilha o orçamento por admin. Teste/envio compartilham os limites existentes: 5/admin/5min e 20 GLOBAL/5min. Sem retry automático de send-test.

Access token é renovado quando falta ou está próximo da expiração (60s). Refresh omitido na resposta mantém o existente; escopo omitido mantém o anterior. Escopo retornado sem gmail.send causa perda de autorização. Atualização de ciphertext usa comparação com snapshot/revisão; disputa entre workers termina em retry seguro antes de enviar. Refresh não altera a revisão da configuração nem invalida deliveries existentes.

`invalid_grant`, credenciais removidas, HTTP 401/autorização perdida exigem reconexão e desabilitam o provider quando apropriado. Refresh é limitado a uma tentativa por operação. HTTP 429 e razões Gmail 403 `rateLimitExceeded`/`userRateLimitExceeded` usam o backoff existente. Cota diária termina sem loop. Falha de conexão antes de TLS pode ser transitória; timeout após possível envio, resposta ambígua/sem ID e Gmail send 5xx são UNCERTAIN, sem resend automático.

Envio usa MIME gerado pelo MailComposer existente (text/html dos templates com escaping existente) e raw base64url em `POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`. Remetente/destinatário validados e subject sem CR/LF; sem anexos/fetch de arquivos/URLs. O ID Gmail é registrado como aceitação, não prova de entrega.

Disconnect remove tokens/desabilita/invalida revisão localmente **antes** de tentar revoke por form POST. Se `remoteRevoked:false`, a comunicação local já está desconectada; remover o acesso manualmente na conta Google. A aplicação não guarda refresh token para retentar revoke remotamente após remoção local.

## Web Push

`PATCH /communication/providers/PUSH_PENDING` usa `config:{subject:"mailto:<contato>",publicKey:<VAPID público>}`, `secrets:{privateKey:<VAPID privado>}`. A chave privada é write-only e cifrada no cofre com AAD provider/ambiente. Valida curva P-256, comprimentos e correspondência do par. Não gera chave operacional automaticamente. `test` valida configuração/chaves localmente; `send-test` efetua envio aos dispositivos ativos do próprio Super Admin (até 20). Habilitação exige configuração validada; conexão Web Push não é uma sessão remota persistente.

`web-push@3.6.7` gera VAPID e cifra payload RFC 8291/aes128gcm. O backend usa `generateRequestDetails`, não a rede permissiva da biblioteca: HTTPS próprio, DNS público com IP fixado, hostname TLS validado, nenhuma cadeia de redirects/proxy configurável, timeout 15s, resposta máxima 64KiB. Web Push aceita hostname DNS válido de qualquer fornecedor, sem depender de `COMMUNICATION_WEB_PUSH_HOSTS`. IP literal, domínios locais, DNS privado/reservado, credenciais URL, portas alternativas e fragmentos são rejeitados. Caminho e query opacos são preservados, inclusive caminho raiz. DNS público é verificado antes da persistência e novamente em cada envio, com IP fixado no socket. Falha transitória de DNS no cadastro retorna 503 `PUSH_ENDPOINT_DNS_UNAVAILABLE`; destino inseguro retorna 400 `PUSH_ENDPOINT_INVALID`.

| Método | Endpoint | Contrato |
| --- | --- | --- |
| GET | `/communication/push/public-config` | AuthGuard; available, provider:WEB_PUSH, publicKey ou null, nativeAvailable:false |
| POST | `/communication/push/subscriptions` | AuthGuard+Origin; cria/atualiza a própria subscription |
| GET | `/communication/push/subscriptions` | lista até 100 dispositivos próprios, sem endpoint/chaves/ciphertext |
| DELETE | `/communication/push/subscriptions/:id` | revoga apenas a própria subscription, resposta idempotente |
| GET | `/communication/providers` | AdminGuard; estado e configuração públicos de Push |
| POST | `/communication/providers/PUSH_PENDING/test` | AdminGuard; valida VAPID localmente |
| POST | `/communication/providers/PUSH_PENDING/send-test` | AdminGuard; envia a dispositivos ativos do próprio admin |

Registro aceita `{provider?:"WEB_PUSH",platform?:"WEB",endpoint,keys:{p256dh,auth},expirationTime?:number|null,label?:string}`. Nenhum userId/companyId/scope/token nativo é aceito. Identidade vem da autenticação. Expiration usa timestamp milissegundos conforme PushSubscription. Label opcional limitado a 80 caracteres; sem fingerprint, UA integral ou IP persistido. Até 20 dispositivos ativos por usuário; 20 registros/revogações por usuário/5min.

Endpoint/chaves são cifrados com AAD `communication:GLOBAL:push:<id>`; hash único do endpoint garante deduplicação e proíbe transferência silenciosa entre usuários. Nova chamada para o mesmo endpoint do mesmo usuário atualiza chaves/label/lastSeenAt e mantém ID. Para outro usuário retornar 409. Em dispositivo compartilhado, logout/frontend deve fazer unsubscribe/revogar e o usuário seguinte gerar sua própria subscription. O backend não inventa estado de `Notification.permission`.

Cada evento gera delivery própria por dispositivo e `targetKey`. EMAIL/WHATSAPP antigos recebem targetKey USER; a chave idempotente inclui targetKey. Eventos sem dispositivo têm registro UNSENDABLE. Revogação de membership/usuário/template/config e propriedade do dispositivo são revalidadas antes do envio. Tokens não são copiados para payload do outbox: ele referencia o dispositivo e cifra somente a mensagem. Um dispositivo aceito não é reenviado devido à falha de outro.

Payload é JSON `{version:1,title,body}`, até 3000 bytes UTF-8 antes da cifragem, title até 200 caracteres. Sem URL, HTML interpretado, scripts ou deep links; o frontend deve usar title/body como texto na Notification. TTL 300s, urgency normal. Aceitação pelo serviço Push não prova exibição/leitura; nenhuma falsa delivery browser é criada.

HTTP 404/410 revoga o dispositivo e apaga credentialsEncrypted condicionalmente ao snapshot (protege registro atualizado em paralelo). 429 usa rate-limit/backoff; 5xx é falha transitória explícita, outras permanentes encerram; timeout após potencial envio é UNCERTAIN. Retry máximo 5 do motor existente. Scheduler separado agora revoga subscriptions cuja expiração persistida venceu; não envia Push nem inicia por HTTP. Troca de par VAPID exige resubscription no navegador; devices com chave antiga não recebem usando chave nova.

## Contratos Super Admin

Dashboard/summary, detalhe de empresas/usuários/planos/assinaturas, financeiro, gateways e webhooks já existiam. Não foi criado endpoint de configurações gerais sem caso de uso. Comunicação usa endpoints existentes e extensões descritas acima.

`GET /users`, `/companies`, `/subscriptions`, `/finance`, `/webhooks`, `/communication/outbox`, `/communication/deliveries`, `/communication/failures`, `/communication/logs` mantêm resposta array e agora suportam `limit` (1..100, default 100) e `offset` (0..1000000, default 0). `/users` aceita q por nome/email; `/companies` aceita q por nome/slug e status; subscriptions/finance/webhooks e deliveries/failures aceitam status técnico validado. Demais listagens de comunicação aceitam somente paginação. Não há count gigante aninhado nem alteração para envelope incompatível. Arrays não são inventário completo; usar páginas e summaries existentes. Cota de gateway-test: 5/admin/5min e 20 GLOBAL/5min. Webhook reprocess: 10/admin/5min.

## Operação externa posterior

Novas env vars somente documentadas (sem .env real):

| Variável | Necessidade |
| --- | --- |
| COMMUNICATION_GMAIL_CALLBACK_URL | HTTPS absoluto com path exato `/communication/gmail/callback`, sem query/hash/credenciais; cadastrado idêntico no Google |
| COMMUNICATION_WEB_PUSH_HOSTS | Legada; não utilizada na validação Web Push |

Reutiliza GATEWAY_ENCRYPTION_KEY, AUTH_* e DATABASE_URL. ClientId/clientSecret e VAPID ficam na configuração administrativa; não há nova env de token. Flags COMMUNICATION_WORKER_ENABLED/COMMUNICATION_SCHEDULER_ENABLED continuam exigindo literal true, nenhuma foi ativada. HTTP não inicia processos de lote.

Google: criar projeto/ativar Gmail API; cadastrar cliente OAuth tipo Web application e redirect autorizado exato; configurar Branding/Audience/Data Access com scopes acima, usuários de teste ou app Internal apropriado; validar domínio/URLs de política exigidas e processo de verificação de scopes sensíveis aplicável; criar credenciais fora do repositório; configurar callback via ambiente e clientId/clientSecret via interface administrativa segura; autorizar conta cujo email corresponda ao remetente. Conferir limites/restrições de Testing e expiração de refresh tokens antes de uso operacional. Homologar OAuth, reconnect, revoke e envio real. Reverse proxy/APM deve omitir/redigir query inteira do callback, authorization code e tokens de request logs; aplicação não controla os logs externos. Não colocar recursos de analytics no callback.

Web Push: gerar um par VAPID em ambiente operacional autorizado (não executado nesta entrega), manter backup protegido e contato mailto real; cadastrar chaves no provider; definir allowlist exata baseada nos browsers homologados; configurar HTTPS frontend; frontend implementará Service Worker, permissão mediante ação do usuário, subscribe com publicKey, chamadas autenticadas de registro e unsubscribe/logout. Homologar Chrome/Edge/Firefox e Safari/iOS PWA conforme suporte efetivo. Não afirmar funcionamento em Android/iOS nativo: definir fornecedor/projeto/aplicativo/credenciais em fase própria. Segregar chaves e subscriptions GLOBAL de qualquer comunicação tenant futura.

## Fontes oficiais consultadas em 29/09/2026

- [Google OAuth web server/offline, refresh/revoke](https://developers.google.com/identity/protocols/oauth2/web-server).
- [Google OpenID Connect, userinfo e suporte PKCE S256](https://developers.google.com/identity/openid-connect/openid-connect).
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).
- [Gmail envio MIME](https://developers.google.com/workspace/gmail/api/guides/sending), [users.messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).
- [Gmail erros/cotas](https://developers.google.com/workspace/gmail/api/guides/handle-errors).
- [Google política OAuth](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).
- [W3C Push API](https://www.w3.org/TR/push-api/).
- [RFC 8030 HTTP Push](https://www.rfc-editor.org/info/rfc8030/), [RFC 8291 criptografia](https://www.rfc-editor.org/info/rfc8291/), [RFC 8292 VAPID](https://datatracker.ietf.org/doc/html/rfc8292).
- [Biblioteca web-push: documentação mantida pelos autores](https://github.com/web-push-libs/web-push).

Limitações: fornecedores/rede/navegadores não foram usados com credenciais reais; testes HTTP usam persistência simulada e não representam ensaio integral de concorrência do worker. A migration nova foi aplicada com todas as anteriores em PostgreSQL16.15 descartável: tabelas/enums/índices/constraints e invariantes básicas exercitadas, migrations anteriores idênticas ao commit base. Banco de teste removido e cluster parado/dados removidos. Homologação externa Google/navegador permanece pendente, sem bloqueio técnico nos checks executados. Não existem preferências globais classificadas, envio nativo, recibo de exibição Push, callback redirect ao frontend, aliases Gmail, rotação automática VAPID ou revogação remota com retry durável. Envio já iniciado pode terminar durante uma revogação concorrente; não se promete exactly-once externo. SMTP/Meta/Evolution e histórico mantêm suas limitações documentadas da Fase 2.

## Tooling e validação técnica concluída

Prisma CLI, @prisma/client e @prisma/adapter-pg ficam na versão exata **7.10.0**, conforme commit base. O downgrade local do CLI foi provocado por npm audit fix --force anterior à Fase3, comprovado por log e Git; foi corrigido sem descartar outras mudanças locais. Não repetir audit fix --force. Instalação limpa pelo lock com Node22.23.2 e geração explícita do client concluídas.

Passaram npm test (334), npm run test:e2e (75), npm run lint, npx tsc --noEmit, npm run build, npx prisma format/validate/generate e git diff --check. A validação SQL aplicou as sete migrations em ordem, sem DEV/produção, reset ou alteração do role kalend; confirmou delivery antiga USER, unique por dispositivo/endpoint, FK/cascade, state single-use, enum e índices. Detalhes e evidências no [relatório atualizado](PHASE3-REPORT.md).

Google Cloud Console/credenciais/consentimento e Web Push em navegador/PWA real permanecem **PENDENTES DE HOMOLOGAÇÃO EXTERNA**. Esses testes operacionais não foram simulados como concluídos. O código permanece local em develop, sem commit/push/deploy e sem ativação de worker/scheduler.

## HOMOLOGAÇÃO PAGBANK SANDBOX

### Evidência real e limite do diagnóstico

O operador confirmou checkout Sandbox criado, Pix de R$1,99 para Kalend MONTHLY aprovado no PagBank, retorno para login e assinatura PENDING. A evidência posterior do Portal do Desenvolvedor substitui o diagnóstico inicial: **PagBank tentou entregar o webhook e Kalend DEV respondeu HTTP401** em 29/09/2026, às22:32 e22:33, para `https://api-dev.kalend.tech/webhooks/pagbank`. A URL foi efetivamente cadastrada; não há evidência de ausência de notificação. Os contadores internos zero são compatíveis com rejeição anterior à persistência.

DEV confirmado pelo operador: branch develop, commit/build `88c979e`, BILLING_PUBLIC_API_URL=`https://api-dev.kalend.tech`, BILLING_RETURN_URL=`https://dev.kalend.tech`. Esta auditoria consultou somente Git/arquivos locais e documentação pública; não acessou DEV/produção, banco real, credenciais, portal autenticado ou logs remotos, nem reenviou webhook ou realizou pagamento.

**O ponto exato do 401 real ainda não está comprovado.** O verificador do commit implantado e o local anterior a esta revisão eram idênticos. Foi reproduzida e corrigida uma incompatibilidade concreta: assinatura Base64 sem padding, criptograficamente válida, era rejeitada pelo parser de88c979e. Isso explica um caminho possível de401, mas não comprova que o header real veio nesse formato. Falta somente evidência redigida do erro HTTP (`message`/`code`), presença de x-payload-signature e comprimento/padding de cada assinatura. Não compartilhar valores dos headers, corpo financeiro, tokens, cookies, JWT, senha ou DATABASE_URL. Também é relevante saber se o portal informa apenas o header legado x-authenticity-token, que permanece rejeitado pelo contrato ECDSA.

### Payload anterior e atual

Anterior, confirmado no código local e no commit base (expressões do servidor; não captura do teste real):

```text
redirect_url = returnUrl(BILLING_RETURN_URL)
return_url = returnUrl(BILLING_RETURN_URL)
notification_urls = [callback(BILLING_PUBLIC_API_URL, /webhooks/pagbank)]
payment_notification_urls = [callback(BILLING_PUBLIC_API_URL, /webhooks/pagbank)]
```

Atual, exemplo validado por teste do JSON serializado com base API DEV e rota frontend futura configuradas pelo servidor:

```json
{
  "reference_id": "<Payment.id interno>",
  "notification_urls": ["https://api-dev.kalend.tech/webhooks/pagbank"],
  "payment_notification_urls": ["https://api-dev.kalend.tech/webhooks/pagbank"],
  "redirect_url": "https://dev.kalend.tech/pagamento/retorno?paymentId=<Payment.id interno>",
  "return_url": "https://dev.kalend.tech/pagamento/retorno?paymentId=<Payment.id interno>"
}
```

A correção local acrescenta correlação paymentId no retorno, lê/constrói cada URL uma vez e valida os limites oficiais (100 caracteres por notificação; 255 para retorno/redirecionamento). Os dois campos de notificação já existentes foram preservados. HTTPS obrigatório, sem userinfo/fragmento; URL de notificação é construída de BILLING_PUBLIC_API_URL com path fixo, sem hardcode DEV. Para base `https://api-dev.kalend.tech`, produz exatamente `https://api-dev.kalend.tech/webhooks/pagbank`; produção usa sua configuração própria. Entradas arbitrárias de URLs/status no body de POST /billing/checkout são rejeitadas antes da criação.

notification_urls recebe mudanças de ciclo do checkout (como expiração); não confirma pagamento. payment_notification_urls solicita notificações do pagamento associado (como PAID). redirect_url conduz o comprador após finalização; return_url serve para o retorno à loja. Notificações de pagamento documentadas podem conter ORDE_ com charges CHAR_. O adapter valida ECDSA e reconsulta orders/charges em hosts oficiais fixos; não usa status manipulável do navegador/payload sem autenticação para conceder acesso.

### Retorno para login e contrato frontend

O build88c979e usa diretamente BILLING_RETURN_URL para ambos os retornos. O valor real confirmado aponta à raiz `https://dev.kalend.tech`, onde o frontend renderiza login: isso explica o destino observado. O frontend não possui a página `/pagamento/retorno`; o path `/super-admin/empresas/[id]` também não existe. Nenhum frontend ou configuração DEV foi alterado. Acrescentar paymentId não cria essa página: sua implementação e a configuração explícita de BILLING_RETURN_URL para a rota futura continuam necessárias.

Contrato proposto para implementação frontend posterior: página `/pagamento/retorno`, fora de layouts que obriguem acesso ao produto pago, usando o destino HTTPS explícito em BILLING_RETURN_URL. O backend acrescenta paymentId (somente identificador de correlação, não token/prova). Frontend deve obter sessão e empresa selecionada com autenticação existente; se a sessão acabou, pedir login e preservar somente o ID válido, sem aceitar redirect arbitrário.

Nova consulta **GET `/billing/payments/:id`**, UUID, TenantGuard, papéis OWNER/ADMIN, BillingRecovery e no-store. Empresa vem da sessão; busca por id+companyId. Outra empresa/ID inexistente retorna404; sem sessão401; sem empresa/papel permitido403. Retorna seleção explícita de id/status/creationState/amountCents/currency/gateway/billingInterval/paidAt/refundedAt/refundedAmountCents/createdAt/updatedAt e subscription:{id,status,planId,currentPeriodStart,currentPeriodEnd}. Não retorna credenciais, gateway config, contato, IDs externos ou checkoutUrl. Consulta somente banco interno; não chama provedor nem altera estado.

UX: PENDING → “Estamos confirmando seu pagamento”; APPROVED com assinatura ACTIVE e período vigente → confirmação; FAILED/OVERDUE/CANCELED/REFUNDED → estado financeiro correspondente; APPROVED sem assinatura válida não garante acesso. Consultar também GET `/billing/regularization` para accessAllowed efetivo (pode haver trial/outra assinatura). Sem ID nos checkouts antigos, usar regularization.pendingCheckout; não selecionar cobrança de outra empresa nem inventar associação. Uma atualização limitada da tela lê estado interno, não substitui webhook por polling do PagBank. Nunca usar status/paid/success/amount/empresa da query para aprovar.

### Transições, segurança e idempotência

Checkout cria intenção Payment PENDING/CREATED e Subscription PENDING; retorno não muda essas entidades. Webhook: rawBody original + x-payload-signature ECDSA/SHA-256 + chave WEBHOOK da API/cache/rotation → reconsulta oficial do ORDE_/CHAR_ → valida ambiente/referência externa/empresa/plano/valor/moeda → transação Serializable. Payment passa APPROVED (externalPaymentId/paidAt); assinatura não cancelada com período persistido vigente passa ACTIVE; Company passa ACTIVE/isActive=true quando não existe assinatura mais nova conflitante. Período expirado/cancelamento continuam protegidos pelas regras existentes.

WebhookEvent tem deduplicação por gateway/ambiente/eventId e claim transacional. Payment APPROVED/REFUNDED não é reaprovado por evento diferente. Não cria segunda assinatura nem recalcula/estende período. Triggers globais anteriores só capturam mudança efetiva e usam businessKey único; não há comunicação duplicada por replay financeiro. Nenhuma chamada externa dentro da transação financeira. Assinatura inválida não persiste evento nem altera pagamento; pagamento desconhecido/referência errada falha sem ativar outra empresa. Receiver/processador/ECDSA/cache/rotation/idempotência/migrations/Gmail/Push foram preservados; a normalização de padding e os diagnósticos de rejeição estão descritos abaixo.

### Reconciliação e detalhe da empresa

GET `/checkouts/{checkout_id}` oficial permite consulta paginada, limit até100 e offset por item. A evidência pública consultada ainda não define suficientemente o envelope/relacionamento de todos os pagamentos para liberar reconciliação. O adapter permanece fail-closed com PAGBANK_CHECKOUT_CONTRACT_UNVERIFIED; invoices recorrentes também continuam bloqueadas por contrato não comprovado. Consulta de charge já conhecida verifica ID/reference_id e processa com as mesmas validações, mas não representa homologação nem substitui webhook neste teste. Faltam amostra oficial/documentação do envelope, associação CHEC_→ORDE_/CHAR_, paginação completa, vínculo interno, ensaio de duplicidade e Sandbox real. Nenhuma capability foi promovida a homologada.

Já existe **GET `/companies/:id`**, UUID e AdminGuard. Retorna empresa/status/slug/timezone/isActive/datas, memberships com usuários via safeUserSelect (sem passwordHash), subscriptions com plano/features e payments/datas/estado comercial. Responsável é membership OWNER; plano/assinatura e histórico já estão disponíveis. Não inclui configuração/secrets de gateways ou comunicação. Nenhum endpoint duplicado foi criado. O 404 em `/super-admin/empresas/{id}` é rota frontend ausente, não ausência desse contrato backend. História desse detalhe já era sem paginação; uma futura tela deve evitar inventar que é uma listagem paginada.

### Validação local e novo teste real necessário

Auditoria inicial de checkout:26 novos testes unitários +3 e2e. Revisão do401:mais13 unitários +4 e2e. Total atual: **373 unitários +82 e2e =455 aprovados**. Cobertura adicional: JSON do checkout em SANDBOX/PRODUCTION e recorrente, campos independentes, base/URL/HTTPS/limites, injeção de URLs/status, retorno sem aprovação, GET próprio/IDOR/papéis/empresa suspensa, pipeline ECDSA→order/charge→processador sem mock de processVerified, aprovação/ativação/duplicado/tamper/assinatura inválida/pagamento desconhecido/referência errada. PostgreSQL concorrente não é emulado por esses fakes; a validação descartável anterior de migrations continua registrada. Lint, TypeScript, build, Prisma -v/format/validate/generate e diff-check PASS, Node22.23.2; Prisma/Client/adapter **7.10.0**.

Arquivos desta auditoria: src/billing/adapters/pagbank.adapter.ts; novo src/billing/adapters/pagbank-checkout.spec.ts; src/billing/payments.service.ts; src/billing/payments.service.spec.ts; src/billing/billing.module.ts; src/billing/billing.spec.ts; test/auth.e2e-spec.ts; src/billing/adapters/pagbank.spec.ts; test/webhooks.e2e-spec.ts; docs/PHASE3-REPORT.md; docs/PHASE3-COMMUNICATION.md. Todo o trabalho anterior está preservado; comparação de hashes confirmou comunicação inteira, manifests/lock, schema e migrations intactos.

O pagamento anterior pode ser homologado com o botão “Reenviar notificação”, após diagnóstico e implantação DEV autorizados separadamente. Não é necessário criar outra cobrança. Confirmar HTTP2xx somente após assinatura válida, Payment APPROVED/Subscription ACTIVE/Company ACTIVE, acesso e comunicação únicos; repetição não pode estender período nem duplicar efeitos. A preparação para novo checkout/retorno é distinta da recuperação desse pagamento antigo. **Webhook/financeiro continuam NÃO HOMOLOGADOS. Nenhum pagamento, reenvio ou deploy foi realizado.**

### Auditoria específica do HTTP401 — comparação com88c979e

- `POST /webhooks/pagbank` não tem JWT/TenantGuard/AdminGuard. O AdminGuard protege somente as operações administrativas correspondentes, incluindo reprocessamento. Não existe APP_GUARD, useGlobalGuards ou middleware global de autenticação. AuthModule global fornece dependências, não guard global. CORS do navegador não autentica requisições servidor→servidor.
- `NestFactory.create(..., {rawBody:true})` e RawBodyRequest preservam bytes originais; o processor verifica rawBody antes de persistir WebhookEvent. Ausência/excesso de body pelo fluxo HTTP produz400; chamada direta do adapter sem Buffer produz401 WEBHOOK_INVALID_BODY.
- Na rota HTTP, o adapter produz401 WEBHOOK_INVALID_SIGNATURE para header ausente/vazio, excesso de16 assinaturas, encoding rejeitado ou nenhuma assinatura que valide o rawBody após consulta/refresh da chave. O código implantado não distingue esses motivos na resposta. Eventos rejeitados não são persistidos, explicando a possibilidade de contadores zero.
- A chave é obtida de `/public-keys/webhook`, em `sandbox.api.pagseguro.com` ou `api.pagseguro.com`, conforme ambiente persistido do gateway. Token Bearer autentica chamadas de saída à API; não é exigido no webhook recebido nem entra no cálculo ECDSA. Hosts HTTPS fixos, redirects bloqueados, timeout15s e limite1MiB permanecem. Credenciais vêm do SecretVault, não do payload/cliente.
- public_key Base64 é decodificada como DER/SPKI, formato X.509 equivalente ao PEM BEGIN PUBLIC KEY do exemplo oficial. Exige chave EC. Chave CARD/RSA não é intercambiável; configuração/chave indisponível resulta503, não sucesso artificial nem401 criptográfico. Teste de conectividade prova consulta válida, não correspondência com uma assinatura específica.
- Verificação permanece ECDSA + SHA-256, sobre bytes originais, assinatura DER e algoritmo Node crypto.verify. Não reserializa JSON. Múltiplas assinaturas são aceitas somente se pelo menos uma for válida. Não usa IP, JWT, status do body ou x-authenticity-token legado como substitutos.
- Cache5min, até32 contextos separados por ambiente/credencial/revisão; consulta concorrente coalescida. Divergência pede refresh, limitado a30s; falha de refresh só pode usar chave ainda válida no cache e continua exigindo assinatura correta. Expiração/erro de consulta não libera evento. Não foi alterado esse mecanismo; logs/chave/header reais seriam necessários para atribuir incidente a rotação.

**Correção local comprovada:** parser antigo exigia padding canônico. O teste gera assinatura real, remove apenas `=`, prova que os bytes e a verificação ECDSA são idênticos e que a regex antiga rejeita. Parser novo normaliza apenas padding omitido em assinatura Base64 padrão, mantendo alfabeto/limites/bits residuais estritos e ECDSA obrigatório. Public key mantém o parser anterior. Não aceita Base64URL, lixo, espaços internos ou padding malformado.

Diagnósticos novos, sem material sensível, mantêm HTTP401 e message WEBHOOK_INVALID_SIGNATURE: SIGNATURE_MISSING, SIGNATURE_LIMIT, SIGNATURE_ENCODING_INVALID e SIGNATURE_MISMATCH. Logger emite somente evento fixo PAGBANK_WEBHOOK_REJECTED, ambiente e motivo; nunca corpo, assinatura, token, chave ou referência financeira. Isso permite identificar uma futura rejeição sem registrar secrets.

Regressões:13 unitários cobrindo padding omitido, payload adulterado, múltiplas assinaturas,8 encodings inválidos, motivos/logs seguros, equivalência PEM/SPKI e isolamento Sandbox/produção/Bearer de saída. Mais4 e2e HTTP reais com rawBody UTF-8, ausência de JWT/Origin/Bearer de entrada, sucesso criptográfico e401 missing/encoding/mismatch sem processamento. Casos financeiros/idempotência já existentes continuam passando. Não houve alteração das migrations, Prisma ou código Gmail/Push.

Fontes oficiais consultadas:
- [Validação de autenticidade](https://developer.pagbank.com.br/reference/validacao-de-autenticidade): ECDSA/SHA-256, raw body, x-payload-signature, múltiplas assinaturas e exemplo Node com Buffer.from(..., base64). [Consultar chave pública](https://developer.pagbank.com.br/reference/consultar-chave-publica): type webhook/card e rota /public-keys/{type}. Reconsultadas em29/09/2026; nenhum blog usado como contrato.
- [Criar Checkout](https://developer.pagbank.com.br/reference/criar-checkout), [Objeto Checkout](https://developer.pagbank.com.br/reference/objeto-checkout): campos separados, redirect/return e limites.
- [Webhooks Checkout](https://developer.pagbank.com.br/reference/webhooks-checkout): ciclo/financeiro e payload ORDE_/charges; a introdução genérica menciona notification_urls, mas o contrato de criação define payment_notification_urls separadamente.
- [Consultar Checkout](https://developer.pagbank.com.br/reference/consultar-checkout): consulta/paginação, sem pressupor envelope financeiro não comprovado.

