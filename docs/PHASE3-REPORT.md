# Relatório Fase 3 — Super Admin 2.0 + Comunicação Global

Entrega técnica local validada em `develop`, com Prisma CLI, Client e adapter **7.10.0**. A pendência de versão foi resolvida após comprovar pelo Git e pelo log npm que o downgrade era exclusivamente local. Todas as migrations foram aplicadas em PostgreSQL 16 descartável e o banco/cluster foram removidos. Google OAuth e Web Push em navegador permanecem **PENDENTES DE HOMOLOGAÇÃO EXTERNA**, sem bloquear a revisão técnica. Não foi feito commit.

1. **Branch:** `develop`, confirmada antes de qualquer edição e novamente no encerramento.
2. **Commit base:** `88c979e59e021d1fcee3601e9e63e81725ec9e48` — Implementa comunicacao global da Fase 2.
3. **Git status:** havia somente `package.json` e `package-lock.json` modificados no início. Status final local está transcrito abaixo; sem arquivos removidos/staged, commit, push ou merge.
4. **Arquivos modificados:** listagem completa abaixo. O downgrade local do CLI foi corrigido somente para a versão exata 7.10.0; a alteração local de @nestjs/mau foi preservada. Web-push3.6.7 e @types/web-push3.6.4 continuam as adições da Fase3. A reconciliação do lock alterou somente Prisma e sua árvore de dependências; não houve atualização geral.
5. **Arquivos criados:** listagem completa abaixo, incluindo documentação operacional, relatório, models/migration, transports/controllers e testes.
6. **Migration:** `prisma/migrations/20260929220000_global_gmail_web_push/migration.sql`. Aplicada com sucesso sobre as seis migrations anteriores em PostgreSQL16.15 descartável, binário oficial PGDG extraído em /tmp. Confirmados tabelas/enum/colunas/defaults/índices/PK/FK/cascade, preservação de delivery antiga e unique por dispositivo. As seis migrations anteriores são byte a byte iguais ao commit base. Nenhum DEV/produção acessado; banco removido, cluster parado e dados temporários removidos.
7. **Prisma:** novos models GlobalGmailOAuthState e GlobalPushSubscription; enum GlobalPushPlatform WEB/ANDROID/IOS; relação User→subscriptions globais; targetKey na delivery; índice único por outbox/user/channel/targetKey e índices por expiração/usuário/ativo/hash. FK User com cascade somente para dispositivos, preservando histórico independente do outbox. Nome explícito do índice evita truncamento PostgreSQL.
8. **Gmail OAuth implementado:** adapter real Gmail API, sem senha de conta ou senha de aplicativo; configuração administrativa clientId/fromEmail e clientSecret write-only. Estado de conexão consultável sem tokens.
9. **Fluxo OAuth:** connect Super Admin → autorização Google → callback HTTPS servidor → state/binding/PKCE/sessão/Super Admin/snapshot da senha/revisão → consume atômico single-use → form token exchange → email verificado correspondente ao remetente → armazenamento criptografado → conexão ainda desabilitada para envio automático até decisão explícita. State expira em 10min. Callback fixo em texto, no-store/no-referrer/CSP; sem redirect arbitrário ou conteúdo refletido.
10. **Endpoints Gmail:** GET `/communication/gmail/status`; POST `/communication/gmail/connect` (também reconexão); GET `/communication/gmail/callback`; POST `/communication/gmail/disconnect`; PATCH `/communication/providers/GMAIL`; POST `/communication/providers/GMAIL/test` e `/send-test`. Detalhes/contratos em PHASE3-COMMUNICATION.md.
11. **Armazenamento/criptografia:** SecretVault existente AES-256-GCM com AAD GLOBAL/provider/ambiente; access/refresh/account/expiry cifrados juntos. State e cookie binding apenas como hashes; PKCE verifier cifrado por hash de state. Nenhum clientSecret/accessToken/refreshToken/privateKey/ciphertext é retornado em contratos administrativos/públicos. Não há logs de token/code/request body.
12. **Refresh/revogação:** refresh quando falta/expira em ≤60s, uma tentativa por operação. Retém refresh/scope quando Google omite; escopo retornado sem Gmail send termina a autorização. CAS de revisão/ciphertext evita overwrite de reconnect/disconnect e disputa entre workers. invalid_grant/autorização revogada desabilita, apaga tokens e exige reconexão. Disconnect faz remoção local antes de revoke; retorno remoteRevoked=false exige remoção externa pelo operador.
13. **Envio Gmail:** MIME RFC pelo MailComposer já instalado, raw base64url via users/me/messages/send, subject/remetente/destinatário protegidos, templates email existentes text/html escapado. Owner automático e admin de teste obtidos do banco, sem destinatário arbitrário. Cotas 429/403 apropriadas usam backoff; resposta ambígua/timeout pós-envio/5xx de send fica UNCERTAIN e não é reenviada automaticamente.
14. **Arquitetura Push:** canal PUSH e identificador PUSH_PENDING compatíveis; transport efetivo WEB_PUSH independente do domínio do Kalend; mesmo registro Transport/worker/outbox. Future provider extensível no dispositivo, sem seleção arbitrária de Expo/FCM/APNs.
15. **Web Push:** web-push gera criptografia RFC 8291/aes128gcm e VAPID; nossa rede HTTPS aplica allowlist, DNS público fixado, TLS hostname, sem redirects/proxy, timeout/response limit. TTL 300s, urgency normal. Payload `{version:1,title,body}` até 3000 bytes; nunca HTML interpretado/deep links. Aceitação não afirma exibição/read receipt.
16. **VAPID:** valida P-256, public/private comprimentos e correspondência do par. Private key write-only no cofre; public key acessível apenas pelo contrato apropriado. Chaves reais operacionais não foram geradas/configuradas; somente chaves aleatórias efêmeras em testes.
17. **Subscriptions:** armazenamento GLOBAL com usuário autenticado, provider/platform, hash único, endpoint/chaves cifrados, label opcional, active, createdAt/updatedAt/lastSeenAt, expiresAt/revokedAt. Sem UA integral, fingerprint ou IP persistente. Device ownership nunca vem do body.
18. **Múltiplos dispositivos:** até 20 ativos por usuário; duplicate endpoint do mesmo usuário atualiza ID estável. Endpoint pertencente a outro usuário retorna conflito. Uma delivery por dispositivo, sem repetir dispositivo aceito por falha em outro.
19. **Revogação/limpeza:** DELETE de device aplica userId/scope e apaga credenciais; 404/410 revoga condicionalmente ao ciphertext observado. Scheduler separado apaga credenciais e desativa expirações vencidas. Rotação VAPID exige nova subscription frontend. Dispositivo compartilhado necessita unsubscribe/revoke na troca de conta.
20. **Preparação Android:** platform ANDROID e provider/credentialsEncrypted permitem token nativo cifrado futuro; API atual rejeita plataformas/providers nativos. Nenhum token/envio fictício.
21. **Preparação iOS:** mesma preparação para IOS; iOS navegador/PWA será Web Push quando suportado/homologado. APNs/Expo nativo não foi implementado ou configurado.
22. **Preferências:** não implementadas após avaliar ausência de classificação/política dos eventos. Opt-out indiscriminado poderia suprimir segurança/transações. Preferências visuais continuam frontend/local; nenhum branding tenant criado.
23. **Outbox:** único motor existente; expand gera EMAIL/WHATSAPP/PUSH conforme templates/providers habilitados. Fanout Push por dispositivo com idempotência persistente; payload cifrado e purga terminal mantidos. Revalida owner ativo, template/configuração/contato e ownership ativo do dispositivo. Sem rede dentro das transações comerciais/expansão.
24. **Worker:** processo separado, mesmo lote/claim/retry/backoff/5 tentativas/quarentena. Não foi ativado ou executado. HTTP não inicia worker.
25. **Scheduler:** processo separado/fail-closed, mantém reconciliação/temporal e acrescenta limpeza de expirações Push. Não envia mensagens e não foi ativado/executado.
26. **Novos endpoints:** Gmail e subscriptions/public-config acima. Listagens administrativas existentes agora têm limit/offset (até 100, default100) e filtros coerentes, mantendo arrays. Dashboard/empresas/usuários/planos/assinaturas/financeiro/gateways/webhooks/configurações existentes foram auditados. Não criado CRUD sem necessidade. Gateway test e webhook reprocess ganharam quotas administrativas.
27. **Novas env vars:** COMMUNICATION_GMAIL_CALLBACK_URL e COMMUNICATION_WEB_PUSH_HOSTS. Reutiliza SecretVault/GATEWAY_ENCRYPTION_KEY, AUTH_* e flags fail-closed. Nenhum .env real alterado. Google/VAPID secrets configurados posteriormente pelo contrato administrativo seguro.
28. **Segurança/segunda revisão:** repetida após a reconciliação do Prisma, examinando OAuth state/CSRF/expiração/replay/PKCE/cookie/sessão/senha, redirect fixo, tokens e secrets write-only, SecretVault/AAD, logs, VAPID privado, ownership/IDOR/AdminGuard/Origin, quotas, SSRF/DNS/TLS/timeouts, headers/payload, retry limitado/UNCERTAIN, idempotência/outbox/transactions e regressões Fases1/2. Nenhum novo bloqueio encontrado. State single-use e constraints foram também exercitados em PostgreSQL descartável. Correções da primeira revisão permanecem preservadas. Limites operacionais e testes externos seguem documentados; não equivale a pentest.
29. **Documentação oficial:** Google OAuth web server, OpenID/userinfo/PKCE, scopes Gmail, MIME/send API, handle-errors e políticas OAuth; W3C Push API, RFCs 8030/8291/8292 e README dos autores de web-push. Links e decisões em PHASE3-COMMUNICATION.md. Não foram usados blogs para contratos.
30. **Testes novos:** na entrega técnica inicial, 87 unitários (77 em novos arquivos, 8 no engine e 2 em configuração) + 7 e2e = 94. Gmail cobre state inválido/expirado/replay/password/contexto, callback/code exchange/PKCE/armazenamento/secrets/refresh/invalid_grant/revoke/disconnect/envio/headers/sem config/cotas; Push cobre VAPID/ownership/duplicates/devices/revoke/protocolo/crifra real com decriptação do payload/inválida/transiente/retry/outbox/logs/payload/mobile ausente; rede cobre DNS/TLS/redirects/timeout/limites. Parsers de paginação cobertos.
31. **Testes totais:** rodada final após auditoria PagBank: 373/373 unitários PASS em28 arquivos. Com e2e,455 testes PASS. Todos os testes anteriores mantidos; auditoria de checkout26 unitários/3 e2e e revisão40113 unitários/4 e2e. A rodada da entrega técnica inicial foi334+75=409.
32. **E2E:** npm run test:e2e: 82/82 PASS em 5 arquivos, guards reais com JWT/bcrypt/Origin/vault e banco simulado. Sandbox não permite listener temporário Supertest; rerun autorizado fora do sandbox. Não acessa DB real/produção.
33. **Lint:** npm run lint PASS, sem warnings na rodada final.
34. **TypeScript:** npx tsc --noEmit PASS.
35. **Build:** npm run build PASS com Node 22.23.2. Node 18 padrão não foi usado para validar dependências modernas.
36. **Prisma format:** PASS, `npx prisma format` no repositório com CLI7.10.0 instalado pelo lock e Node22.23.2.
37. **Prisma validate:** PASS, `npx prisma validate` no repositório com CLI7.10.0, sem conexão com banco real.
38. **Prisma generate:** PASS, `npx prisma generate` no repositório; Client7.10.0 gerado após instalação limpa. Configuração fictícia local substituiu DATABASE_URL; nenhum banco DEV/produção acessado. Cache do engine exigiu execução autorizada fora do sandbox. CLI/Client/adapter em7.10.0, confirmados por npx prisma -v e npm ls.
39. **git diff --check:** PASS. Revisão final inclui diff tracked, novos fontes/tests/migration/documentação e comparação estrutural do lock com snapshot inicial. Nenhum arquivo de frontend modificado.
40. **Limitações:** homologação externa Google/navegadores pendente; testes de aplicação/e2e usam banco simulado e mocks de contratos. Migration e invariantes SQL básicos agora foram validados em PostgreSQL16 descartável; isso não substitui ensaio integral de concorrência e falhas do worker sob carga. Sem aliases Gmail, native Push, preferências legais, recibos browser, redirect callback frontend ou revoke remoto durável após limpeza local. Envio já iniciado pode terminar durante revogação; não se promete exactly-once externo. Sem bloqueio técnico conhecido nos checks executados.
41. **Passos Google externos:** criar projeto/ativar Gmail API, Web OAuth client, consent/Audience/test users ou Internal, scopes, callback exato HTTPS, políticas/verificação aplicável; guardar credenciais fora do repo/configurar secret write-only; conectar conta remetente; testar expiração/refresh/revoke e envio real. Redigir query/code em proxy/APM. Ver limites de Testing. Nenhuma credencial inventada/configurada.
42. **Passos Web Push externos:** gerar/custodiar VAPID operacional, contato real, configurar allowlist e chaves, HTTPS frontend, implementar SW/permite-pelo-usuário/subscribe/unsubscribe e frontend dos novos contratos. Validar browsers/PWA e rotação. Nenhum SW backend/produção gerado; providers nativos ficam para fase própria.
43. **Homologação real pendente:** Google consent/refresh/revoke/account/scopes e mailbox de teste/quota; Web Push Chrome/Edge/Firefox/Safari/PWA com permissão, exibição, expiração/revoke/multidevice. Instalação limpa com Prisma7.10.0 e migration PostgreSQL16 descartável concluídas. Worker/scheduler somente após autorização operacional futura. Nenhuma alteração em frontend, .env real, VPS/PM2/CloudPanel/DNS/WordPress, DEV ou produção.

## Auditoria da pendência Prisma e revalidação

- Base versionada: `88c979e59e021d1fcee3601e9e63e81725ec9e48`; `develop` mantida. HEAD package.json e package-lock.json configuram CLI/Client/adapter **7.10.0**. Histórico dos manifests: `88c979e`, `49cdae2`, `3a23b04`, `fbbf703` (somente quatro commits existentes).
- Antes da correção: `package.json:58` tinha `prisma:^6.19.3`; o lock repetia esse range no root e instalava `node_modules/prisma`6.19.3, além dos engines/config6.19.3. Client/adapter permaneceram7.10.0. Manifest e lock concordavam sobre o CLI6, porém CLI e Client estavam desalinhados. npm ls e npx prisma -v confirmaram o estado instalado.
- Origem comprovada: `/home/guest/.npm/_logs/2026-09-30T00_56_39_593Z-debug-0.log` (29/09/2026 às21:56:39 BRT). Linhas21–22 registram `npm audit fix --force`; linhas885/895 registram a substituição de prisma por6.19.3. O snapshot anterior à Fase3 já continha a mudança. Isso comprova comando e janela temporal, sem atribuir autoria humana que o log não identifica. A alteração era não commitada; não faz parte de develop versionada nem das instalações web-push da Fase3. Esse comando não foi repetido.
- Correção autorizada: somente range do CLI voltou a `7.10.0` exato; lock reconciliado sem audit, sem scripts, sem atualização geral. `@nestjs/mau:^0.0.6` e todo o restante da Fase3 foram preservados. Pacotes removidos/substituídos na reconciliação pertencem à árvore do Prisma6; nenhuma dependência direta adicional foi atualizada.
- Instalação limpa: `npm ci --ignore-scripts --no-audit --no-fund`, Node22.23.2, cache temporário. Scripts automáticos foram omitidos para não sincronizar skills nem gerar client implicitamente; `prisma generate` foi executado explicitamente depois. Lock está coerente com manifest e instalação; npm ls retorna CLI7.10.0/Client7.10.0 e adapter7.10.0.
- Migração descartável: pacote oficial `postgresql-16_16.15-1.pgdg12+2_amd64.deb`, SHA256 `12b7e33dc5b0711c02248816c02e7a08f85d1372835409de66adcd9f808864f4`, baixado de apt.postgresql.org e extraído sem instalar serviço. Cluster exclusivo em /tmp, role efêmero `phase3_validation`, trust somente por socket Unix local, listen_addresses vazio, sem senha/role kalend e sem rede TCP. Não houve migrate reset.
- Aplicação em ordem: init_core → commercial_billing → gateway_architecture → auth_sessions → commercial_engine → global_communication → global_gmail_web_push. SQL integral aplicado por pg no banco recém-criado; a Fase3 manteve seu BEGIN/COMMIT. Comparação binária com Git confirmou todas as migrations anteriores intactas.
- Verificações reais: 2 tabelas/25 colunas com defaults/nulabilidade; enum WEB/ANDROID/IOS; 2 PKs+5 índices; FK User ON UPDATE/DELETE CASCADE; remoção do antigo unique de delivery e novo unique targetKey; delivery pré-existente recebe USER; duplicate USER/device e endpointHash retornam23505; usuário inexistente retorna23503; cascade remove subscription; state só é consumido uma vez; triggers anteriores preservados. Banco de teste removido em finally, cluster parado, diretório de dados removido.
- Resultado final: **334/334 unitários +75/75 e2e =409 testes**, sem remoção de testes; lint/TypeScript/build/format/validate/generate/diff-check PASS. PostgreSQL fornece validação adicional de infraestrutura, fora dessa contagem Vitest. Primeira tentativa unitária antecipou geração de client após ci e falhou por ausência do client; repetida após generate com sucesso. E2e/socket/cache exigiram permissões fora do sandbox; nenhum banco real utilizado. Avisos informativos existentes: tsconfck depreciado e resolução nativa de paths no Vite; nenhuma atualização solicitada foi feita por esses avisos.
- Evidências locais: `/tmp/kalend-phase3-before-prisma-fix.diff` (git diff integral anterior), `/tmp/kalend-phase3-package-before-fix.diff` (manifest+lock anteriores), `/tmp/kalend-phase3-migration-results.json` (catálogo e checks), `/tmp/kalend-phase3-migration-validation.mjs` (procedimento), `/tmp/kalend-phase3-revalidation-{unit,e2e,lint,typescript,build}.log`. Arquivos temporários não entram no commit.

## Arquivos modificados

- `test/auth.e2e-spec.ts`
- `test/webhooks.e2e-spec.ts`
- `src/billing/adapters/pagbank.spec.ts`

- `src/billing/payments.service.spec.ts`

- `src/billing/payments.service.ts`

- `src/billing/billing.spec.ts`

- `src/billing/adapters/pagbank.adapter.ts`

- `docs/COMMUNICATION-ARCHITECTURE.md`
- `docs/COMMUNICATION-OPERATIONS.md`
- `docs/COMMUNICATION-PROVIDERS.md`
- `docs/COMMUNICATION-SECURITY.md`
- `package-lock.json`
- `package.json`
- `prisma/schema.prisma`
- `src/billing/billing.module.ts`
- `src/communication/communication.module.ts`
- `src/communication/configuration.spec.ts`
- `src/communication/configuration.ts`
- `src/communication/engine.spec.ts`
- `src/communication/engine.ts`
- `src/communication/scheduler.ts`
- `src/communication/security.spec.ts`
- `src/communication/transports.ts`
- `src/companies/companies.controller.ts`
- `src/companies/companies.service.ts`
- `src/finance/finance.controller.ts`
- `src/finance/finance.service.ts`
- `src/subscriptions/subscriptions.controller.ts`
- `src/subscriptions/subscriptions.service.ts`
- `src/users/users.controller.ts`
- `src/users/users.service.ts`
- `src/webhooks/webhooks.controller.ts`
- `src/webhooks/webhooks.service.ts`

## Arquivos criados

- `src/billing/adapters/pagbank-checkout.spec.ts`

- `docs/PHASE3-COMMUNICATION.md`
- `docs/PHASE3-REPORT.md`
- `prisma/migrations/20260929220000_global_gmail_web_push/migration.sql`
- `src/common/admin-list.spec.ts`
- `src/common/admin-list.ts`
- `src/communication/gmail.spec.ts`
- `src/communication/gmail.ts`
- `src/communication/google-api.spec.ts`
- `src/communication/google-api.ts`
- `src/communication/phase3.controller.ts`
- `src/communication/push.spec.ts`
- `src/communication/push.ts`
- `src/communication/secure-http.spec.ts`
- `src/communication/secure-http.ts`
- `test/communication-phase3.e2e-spec.ts`

## Git status final local

```text
 M docs/COMMUNICATION-ARCHITECTURE.md
 M docs/COMMUNICATION-OPERATIONS.md
 M docs/COMMUNICATION-PROVIDERS.md
 M docs/COMMUNICATION-SECURITY.md
 M package-lock.json
 M package.json
 M prisma/schema.prisma
 M src/billing/adapters/pagbank.adapter.ts
 M src/billing/adapters/pagbank.spec.ts
 M src/billing/billing.module.ts
 M src/billing/billing.spec.ts
 M src/billing/payments.service.spec.ts
 M src/billing/payments.service.ts
 M src/communication/communication.module.ts
 M src/communication/configuration.spec.ts
 M src/communication/configuration.ts
 M src/communication/engine.spec.ts
 M src/communication/engine.ts
 M src/communication/scheduler.ts
 M src/communication/security.spec.ts
 M src/communication/transports.ts
 M src/companies/companies.controller.ts
 M src/companies/companies.service.ts
 M src/finance/finance.controller.ts
 M src/finance/finance.service.ts
 M src/subscriptions/subscriptions.controller.ts
 M src/subscriptions/subscriptions.service.ts
 M src/users/users.controller.ts
 M src/users/users.service.ts
 M src/webhooks/webhooks.controller.ts
 M src/webhooks/webhooks.service.ts
 M test/auth.e2e-spec.ts
 M test/webhooks.e2e-spec.ts
?? docs/PHASE3-COMMUNICATION.md
?? docs/PHASE3-REPORT.md
?? prisma/migrations/20260929220000_global_gmail_web_push/
?? src/billing/adapters/pagbank-checkout.spec.ts
?? src/common/admin-list.spec.ts
?? src/common/admin-list.ts
?? src/communication/gmail.spec.ts
?? src/communication/gmail.ts
?? src/communication/google-api.spec.ts
?? src/communication/google-api.ts
?? src/communication/phase3.controller.ts
?? src/communication/push.spec.ts
?? src/communication/push.ts
?? src/communication/secure-http.spec.ts
?? src/communication/secure-http.ts
?? test/communication-phase3.e2e-spec.ts
```

Contratos, exemplos seguros, fontes e procedimentos externos: [PHASE3-COMMUNICATION.md](PHASE3-COMMUNICATION.md).


## HOMOLOGAÇÃO PAGBANK SANDBOX

### Evidência real e limite do diagnóstico

O operador confirmou checkout Sandbox criado, Pix de R$1,99 para Kalend MONTHLY aprovado no PagBank, retorno para login e assinatura PENDING. A evidência posterior do Portal do Desenvolvedor substitui o diagnóstico inicial: **PagBank tentou entregar o webhook e Kalend DEV respondeu HTTP401** em 29/09/2026, às22:32 e22:33, para `https://api-dev.kalend.tech/webhooks/pagbank`. A URL foi efetivamente cadastrada; não há evidência de ausência de notificação. Os contadores internos zero são compatíveis com rejeição anterior à persistência.

DEV confirmado pelo operador: branch develop, commit/build `88c979e`, BILLING_PUBLIC_API_URL=`https://api-dev.kalend.tech`, BILLING_RETURN_URL=`https://dev.kalend.tech`. Esta auditoria consultou somente Git/arquivos locais e documentação pública; não acessou DEV/produção, banco real, credenciais, portal autenticado ou logs remotos, nem reenviou webhook ou realizou pagamento.

**Evidência real mais recente:** após deploy do commit e6df279 foi realizado NOVO Checkout Sandbox PIX de R$ 1,99, aprovado pelo PagBank. Duas chamadas chegaram ao Kalend DEV e ambas foram rejeitadas com `environment: SANDBOX`, `reason: SIGNATURE_MISSING`. O motivo observado é ausência/não detecção de assinatura utilizável; padding Base64 foi uma fragilidade corrigida, não a causa comprovada dessas chamadas. O log anterior não distingue header ausente de presente vazio/com espaços/vírgulas.

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

**Conclusão desta auditoria:** regressão de encoding corrigida e testes locais aprovados. Falta evidência que associe esse caso ao401 real, ou identifique outra causa entre os caminhos documentados. Não afirmar que implantar a correção resolverá esse pagamento sem tal evidência. Depois de confirmar o motivo, implantação DEV e reenvio da notificação existente podem homologar o fluxo sem nova cobrança; continuam ações não executadas e dependentes de autorização operacional.

NÃO PRONTO PARA DEPLOY DEV E REENVIO DO WEBHOOK


## Auditoria SIGNATURE_MISSING — 30/09/2026

Sem commit, push ou deploy; produção não alterada. Branch develop, base e6df279.

Caminho exato: HTTP/Node IncomingMessage → Express Request → WebhookReceiverController.pagbank em src/billing/billing.module.ts → WebhookProcessor.receive('PAGBANK', req.rawBody, req.headers) → GatewaysService.context(gateway, false) → GatewayRegistry.get(gateway) → PagBankAdapter.verifyWebhook(raw, headers, context, query). O objeto headers não é copiado nem filtrado. O adapter busca headers['x-payload-signature']; Node normaliza nomes em headers para lowercase, preservando grafia e ocorrências em rawHeaders. String, string[] e listas separadas por vírgula são aceitas; trim/filter eliminam valores vazios. Mixed case real sobre HTTP está coberto por E2E. rawHeaders serve exclusivamente para diagnóstico, nunca como fallback de autenticação.

NestFactory.create usa rawBody:true; receive exige Buffer de até 262144 bytes antes do adapter. Body parsers preservam rawBody para os tipos suportados; perda/alteração de bytes explicaria erro de corpo/mismatch, não assinatura ausente. Não há middleware/interceptor/global guard manipulando headers. Guards de outras rotas não protegem esse POST. trust proxy altera confiança em informações de encaminhamento, não remove assinatura. allowedHeaders do CORS controla navegador/preflight, não remove headers de POST servidor→servidor. Não há configuração de proxy externo neste repositório que permita provar sua preservação; rawHeaders observa o que chegou ao Node, não o que saiu do PagBank.

Fontes oficiais reconsultadas em 30/09/2026:
- [Objeto Checkout](https://developer.pagbank.com.br/reference/objeto-checkout): notification_urls é status do checkout; payment_notification_urls é status do pagamento associado. Ambos apontam atualmente para /webhooks/pagbank; dois recebimentos não provam dois tipos diferentes nem excluem retry.
- [Webhooks Checkout](https://developer.pagbank.com.br/reference/webhooks-checkout): exemplos de ciclo CHEC_ e pagamento PIX ORDE_/charges; seção de autenticidade aponta para o guia anterior.
- [Guia anterior](https://developer.pagbank.com.br/reference/confirmar-autenticidade-da-notificacao): x-authenticity-token e SHA-256 de token + hífen + payload.
- [Guia novo](https://developer.pagbank.com.br/reference/validacao-de-autenticidade): x-payload-signature Base64, ECDSA/SHA-256 sobre bytes originais, múltiplas assinaturas; menciona transição de modelo e ressalva sobre publicação como padrão geral/URL de produção. Usa exemplo Sandbox /public-keys?type=webhook.
- [Consultar chave pública](https://developer.pagbank.com.br/reference/consultar-chave-publica): /public-keys/{type}, webhook para x-payload-signature, compatível com a rota atual /public-keys/webhook. Divergência de exemplos documentada, sem alteração especulativa. SIGNATURE_MISSING ocorre antes da consulta de chave.
- [Checkout](https://developer.pagbank.com.br/docs/checkout): testes Sandbox e homologação. Não foi localizada garantia explícita de que os dois callbacks utilizam o novo modelo nem diferença de assinatura específica Sandbox/produção.

Hipótese mais provável: callback entregue pelo PagBank sob contrato anterior/diferente, possivelmente apenas x-authenticity-token. Isso é inferência da divergência documental, não observação dos headers reais. A/B/F permanecem não comprovados; C não foi encontrado; D interno não encontrado, externo não descartado; E confirmado quanto a evento/formato, não quanto a mecanismo de assinatura. Não foi introduzida aceitação de x-authenticity-token, ausência de assinatura ou autenticação por IP.

Diagnóstico novo: somente no catch de SIGNATURE_MISSING, com ambiente obtido da configuração real, evento fixo, método/path fixos da rota, nomes de headers normalizados/originais, presença de x-product-origin, presença/contagens/comprimentos de assinaturas normalizadas e brutas. Nenhum valor de header, body, query, URL recebida, token ou chave é logado. Content-type e user-agent foram omitidos deliberadamente: cliente pode colocar segredo em qualquer valor. Nomes Authorization/Cookie podem aparecer nas listas autorizadas, seus valores nunca. HTTP401 é relançado antes de persistência/processamento financeiro; ECDSA/cache/idempotência permanecem intactos.

Leitura do próximo diagnóstico: assinatura ausente em ambas as listas aponta para ausência antes do Node (PagBank ou proxy); presente somente em rawHeaders aponta para alteração após parser Node; presente com zero valores normalizados aponta para vazio/com espaços/vírgulas. Nome x-authenticity-token confirma presença do header legado, sem validar sua autenticidade. As listas podem revelar outro nome; nenhum nome alternativo é aceito automaticamente. Comparar ausência antes do Node exige evidência de nomes no ponto de origem/proxy sem capturar valores/corpo.

Testes: 3 novos unitários do diagnóstico; novo caso financeiro sem assinatura exercita processador real e impede upsert/atualização/aprovação; novo E2E com duas chamadas PAID não autenticadas, headers sensíveis, assinatura vazia e query, assegura 401, ausência de processamento/rede e logs sem valores/payload; E2E existente agora usa X-Payload-Signature para provar lowercase. Regressões existentes exercitam assinatura válida/inválida, raw UTF-8 e aprovação duplicada idempotente.

Validação local final: Node 22.23.2 já instalado, 29 arquivos/377 unitários passando, 5 arquivos/83 E2E passando, lint e TypeScript sem erros, build Nest passando, git diff --check sem erros. Node 18.19.0 padrão falhou ao iniciar Vitest/build por incompatibilidade de tooling; E2E no sandbox falhou por bloqueio de sockets locais e passou fora dele com autorização. Sem alterações Prisma; validate/generate não aplicáveis. Nenhum commit/push/deploy realizado.
