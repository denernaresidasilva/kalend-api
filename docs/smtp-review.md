# Revisão do módulo SMTP — API e Web

Implementação local em `kalend-api` e `kalend-web`, com Node **24.21.0**. Sem commit, push, deploy, restart PM2, aplicação de migration ao banco ou envio de e-mails reais durante os testes automatizados.

## A. Arquitetura

`CommunicationModule` registra `EmailService`, `SmtpTransport`, `SystemEmailController` e `CompanyEmailController`. A implementação reaproveita PrismaService, SecretVault, AuthRateLimit, AdminGuard, TenantGuard, validadores SMTP e transporte Nodemailer existentes. Não foram adicionadas dependências nem implementações de OAuth, Gmail API ou Microsoft Graph.

O global reutiliza `GlobalCommunicationProvider`, provider `SMTP`, inclusive suas credenciais, ambiente e compatibilidade com o engine/worker de comunicação global existente. Empresas usam uma tabela própria com chave única por empresa. `EmailService.send(context, message)` exige contexto explícito e é exportado pelo módulo para usos futuros.

## B. Arquivos da API

Novos:

- `src/communication/email.ts`: validação, configuração, ciclo de vida, envio contextual e teste real.
- `src/communication/email.controller.ts`: rotas e autorização dos dois contextos; rate limits.
- `src/communication/email.spec.ts`: testes de serviço e HTTP com transporte mockado, incluindo compatibilidade legada.
- `src/communication/smtp-configuration.ts`: normalização, comparação e metadados de teste compartilhados pelos fluxos SMTP.
- `prisma/migrations/20261005120000_tenant_smtp/migration.sql`.
- `docs/smtp-review.md`: este relatório.

Alterados:

- `prisma/schema.prisma`: relacionamento da empresa, novo modelo e metadados do teste global.
- `src/communication/communication.module.ts`: registro e exportação.
- `src/communication/configuration.ts`: SMTP aceita Gmail por senha; seletor opcional de provedor; mudanças de credenciais invalidam os metadados do teste real.
- `src/communication/network.ts`: três hosts padrão incorporados à política SMTP existente.
- `src/communication/configuration.spec.ts` e `src/communication/security.spec.ts`: expectativas SMTP ajustadas e cobertura da regra única e normalização.
- `docs/COMMUNICATION-OPERATIONS.md` e `docs/COMMUNICATION-PROVIDERS.md`: política atual de hosts oficiais/customizados.
- `src/communication/transports.spec.ts`: dois testes adicionais de SSL e timeout no envio efetivo.

## C. Arquivos do Web

Novos:

- `lib/email.ts`: providers centralizados, tipos e chamadas API.
- `components/email-settings.tsx`: autorização antes do loader, carregamento, gerenciamento, formulário, teste e estados.
- `tests/email.test.cjs`: 23 testes incluindo contexto entre abas, compatibilidade legada e execução de payloads contra o validador real da API local.

Alterados:

- `lib/api.ts`: parâmetro opcional de identidade no helper tenantApi existente, sem alterar autenticação geral.
- `.github/workflows/deploy-dev.yml`: comando Webpack validado.
- `app/globals.css`: controles SMTP com tokens do tema atual e layout responsivo.
- `app/painel/layout.tsx`: acesso a Configurações para OWNER/ADMIN, usando o destino de preferências existente.
- `app/super-admin/configuracoes/page.tsx`: E-mail do Sistema dentro de Configurações/Comunicação.
- `components/account-content.tsx`: Comunicação/E-mail da empresa dentro das preferências da conta, somente para OWNER/ADMIN.
- `components/communication-page.tsx`: seção E-mail no painel de comunicação do Super Admin.
- `components/communication-providers.tsx`: SMTP abre o novo gerenciador; o cartão legado de Gmail/OAuth sai da seleção visual.
- `lib/communication.ts`: remoção do bloqueio de Gmail SMTP no contrato legado.
- `tests/communication.test.cjs`: expectativas ajustadas para Gmail SMTP e integração do novo gerenciador.
- `tests/account.test.cjs`, `tests/company-selection.test.cjs`, `tests/design-system.test.cjs`: mocks da nova fronteira de componente; cobertura específica fica em `email.test.cjs`.

## D. Endpoints novos

| Operação | Super Admin | Empresa selecionada |
| --- | --- | --- |
| Consultar | GET `/communication/email` | GET `/company/communication/email` |
| Salvar/atualizar/habilitar/desabilitar | PUT `/communication/email` | PUT `/company/communication/email` |
| Enviar teste | POST `/communication/email/test` | POST `/company/communication/email/test` |
| Remover credenciais/configuração | DELETE `/communication/email` | DELETE `/company/communication/email` |

GET/PUT/DELETE retornam HTTP 200 e o contrato de configuração. POST retorna HTTP 201 com resultado do envio, inclusive `sent: false` para falhas sanitizadas do transporte. Autenticação, autorização, validação, conflito e limite retornam os códigos HTTP correspondentes (401/403/400/409/429). Configuração inexistente no teste retorna 503.

As rotas antigas de comunicação global continuam existentes para compatibilidade. O novo gerenciador SMTP utiliza exclusivamente as novas rotas, com envio real. A verificação legada de conexão SMTP não altera status ou metadados do teste real. O envio de teste SMTP legado registra SUCCESS/ERROR e o mesmo timestamp de tentativa. Ambos os fluxos exigem SUCCESS para habilitar/enviar SMTP.

## E. Contratos request/response

PUT (campos desconhecidos são rejeitados; password é opcional somente quando já existe credencial e a identidade da conta não muda):

```json
{
  "provider": "GOOGLE",
  "email": "empresa@gmail.com",
  "username": "empresa@gmail.com",
  "smtpHost": "smtp.gmail.com",
  "smtpPort": 587,
  "security": "TLS",
  "password": "senha-de-app-informada-apenas-no-envio"
}
```

`provider`: GOOGLE/MICROSOFT/ICLOUD/CUSTOM. `username` é opcional e assume o e-mail. `security`: TLS/SSL. Porta numérica: TLS=587, SSL=465. `enabled` opcional; habilitar exige teste real bem-sucedido da configuração atual. Alterações invalidam o teste e desabilitam envio até novo teste e habilitação.

Resposta GET/PUT/DELETE (exemplo após teste bem-sucedido, antes de habilitar):

```json
{
  "scope": "COMPANY",
  "configured": true,
  "provider": "GOOGLE",
  "email": "empresa@gmail.com",
  "username": "empresa@gmail.com",
  "smtpHost": "smtp.gmail.com",
  "smtpPort": 587,
  "security": "TLS",
  "enabled": false,
  "verified": true,
  "status": "VERIFIED",
  "lastTestAt": "2026-10-05T12:00:00.000Z",
  "lastTestRecipient": "teste@exemplo.com",
  "lastTestStatus": "SUCCESS"
}
```

`status`: NOT_CONFIGURED/UNTESTED/VERIFIED/ERROR. `lastTestStatus`: null/SUCCESS/ERROR. `lastTestAt` e `lastTestRecipient` podem ser null. A API não retorna password, encryptedPassword ou credentialsEncrypted.

POST teste:

```json
{ "recipient": "teste@exemplo.com" }
```

Resposta:

```json
{
  "sent": true,
  "recipient": "teste@exemplo.com",
  "server": "smtp.gmail.com:587",
  "tls": true,
  "code": null,
  "message": "E-mail enviado com sucesso!",
  "configuration": { "...": "contrato completo de configuração acima" }
}
```

Erro SMTP: `sent: false`, `code: AUTH_FAILED` ou `SEND_FAILED_OR_TIMEOUT`, mensagem amigável e configuração com status ERROR, verified=false e enabled=false. Não se retorna a exceção original do provedor.

## F. Prisma/migration

- `Company.emailConfiguration`: relacionamento opcional 1:1.
- `CompanyEmailConfiguration.companyId`: PK UUID e FK para Company com cascade.
- Campos: config JSON, credentialsEncrypted, enabled, status IntegrationStatus, revision, lastVerifiedAt, lastTestRecipient, lastTestStatus, lastError, createdAt, updatedAt.
- GlobalCommunicationProvider ganha lastTestRecipient e lastTestStatus. Para SMTP, lastVerifiedAt é usado exclusivamente como horário da tentativa de envio real; a resposta lastTestAt só o expõe quando lastTestStatus está definido. Uma verificação de conexão não altera esse horário nem determina verified.
- Migration aditiva; sem apagar os dados existentes.
- `prisma validate` passou. SQL conferido com `prisma migrate diff --from-schema <schema HEAD> --to-schema prisma/schema.prisma --script`.
- Prisma Client regenerado localmente; migration **não aplicada ao banco**.

## G. Proteção da senha

SecretVault existente: AES-256-GCM, IV aleatório de 12 bytes e autenticação por AAD. A chave continua sendo `GATEWAY_ENCRYPTION_KEY` (64 caracteres hexadecimais), já usada pelo projeto. Não foi lida, substituída nem criada uma chave neste trabalho.

Global: AAD existente `communication:GLOBAL:SMTP:<environment>:credentials`. Empresa: `communication:COMPANY:<companyId>:SMTP:credentials`. Trocar ciphertext entre empresas ou entre contextos falha na autenticação criptográfica.

Senha somente no input DOM `type=password`, sem estado React, armazenamento persistente, URL, analytics ou logs. O campo é limpo antes de aguardar o salvamento e ao terminar/fechar/trocar provedor. GET nunca preenche a senha. Alteração de host, usuário ou remetente exige senha nova.

## H. SMTP global

Somente AdminGuard/Super Admin gerencia `/communication/email`. Configuração global permanece compatível com mensagens administrativas aos proprietários e assinantes e com o engine global existente. A interface explica esse público. A tela de empresa não monta o loader global.

## I. SMTP da empresa

TenantGuard resolve companyId pela sessão e verifica membership atual. TenantRoles limita a OWNER/ADMIN. Profissional, cliente e recepcionista não gerenciam SMTP. Nenhum companyId ou scope é aceito no body. Cada consulta, salvamento, teste e remoção usa a empresa selecionada e sua própria linha/credencial. A UI é remontada ao mudar usuário/empresa/contexto. Chamadas SMTP da empresa usam tenantApi com companyId e userId capturados do AuthProvider; a trava de contexto existente cobre preflight e requisição, e divergências disparam atualização da sessão antes de bloquear a chamada. Nenhum identificador de contexto é usado para escolher SMTP arbitrariamente no backend.

Caminho atual: painel da empresa → Configurações (`/conta#preferencias`) → Comunicação → E-mail da empresa → Gerenciar. Esse destino reutiliza o painel existente, sem criar um painel de configurações paralelo.

## J. Teste real

O servidor usa SmtpTransport/Nodemailer para conexão, TLS, autenticação e `sendMail`. Assunto: `Teste de e-mail — Kalend`. Corpo simples, com identificação da empresa ou do sistema. O servidor exige aceitação de destinatário pelo SMTP; não promete chegada à caixa de entrada.

DNS com timeout de 3s e uma tentativa; conexão/greeting de 10s; socket de 15s; operação SMTP com prazo total de 20s após resolver DNS. O transporte fecha conexão ao terminar ou expirar. DNS público é resolvido e o IP é fixado na conexão, mantendo validação do certificado pelo hostname, TLS >=1.2, logger/debug desativados e bloqueio de leitura de arquivos/URLs pelo Nodemailer.

O teste não cria contatos/clientes/campanhas, não dispara automações e não armazena o conteúdo da mensagem. Persiste somente resultado, horário e destinatário do último teste. Não há histórico de conteúdo ou logs SMTP brutos.

## K. Isolamento e abuso

`EmailService.send({scope:'SYSTEM'}, message)` usa somente global. `EmailService.send({scope:'COMPANY',companyId}, message)` usa somente essa empresa. Empresa sem configuração falha, sem fallback para SMTP global ou outra empresa.

Rate limit persistente e compartilhado entre réplicas, via AuthRateLimit: 5 testes por usuário/5min, 5 por contexto/5min, 100 por plataforma/5min. O limite por usuário é compartilhado com os testes legados de comunicação. O sexto teste é bloqueado antes do transporte. Um único destinatário é validado; listas de destinatários são rejeitadas. Requisições mutáveis preservam proteção de origem e respostas preservam no-store do AuthGuard existente.

Salvamento em transação Serializable e teste protegido por revision: uma configuração alterada enquanto o teste está em andamento não é marcada como válida pelo resultado antigo.

## L/M. Testes executados e resultados

API: `npm test`: **32 arquivos, 549 testes passaram**. Inclui os testes do módulo (lifecycle global/tenant, autorização HTTP com os guards reais, isolamento, criptografia, senha omitida, providers, TLS/SSL, falhas sanitizadas, revision e limite de abuso). Dois testes adicionais no transporte comprovam SSL no sendMail e fechamento de envio pendurado no prazo total. Autenticação/timeout também são cobertos pelos testes existentes do transporte.

Transporte SMTP foi mockado nos testes; nenhuma mensagem real foi enviada. A camada HTTP usa Nest/Supertest e mocks de persistência/identidade, sem banco externo. Os testes HTTP precisaram de execução fora do sandbox para abrir porta local.

Web: `npm test`: **13 arquivos passaram**. `node tests/email.test.cjs`: **23 testes SMTP passaram**. Abrir Gerenciar, quatro providers, formulário, instrução/link Gmail, senha vazia/limpa, salvar/atualizar/remover/desativar, sucesso/erro/loading, autorização por contexto e payloads contra `emailInput` real da API.

`npm run lint`: passou nos dois projetos. Verificação cruzada confirmou nomes de campos, tipos, rotas, métodos, bodies e respostas consumidas pelo Web. Não há URL Web apontando para uma rota SMTP inexistente.

## N/O. Builds

API: `npm run build` passou (Nest/TypeScript).

Web: `npm run build` com Turbopack foi tentado e falhou por `Operation not permitted` ao abrir porta interna durante processamento de CSS, inclusive na tentativa escalada. `npm run build -- --webpack` passou: compilação, TypeScript, geração das 26 páginas e coleta dos traces. O workflow Web foi ajustado somente para executar npm run build -- --webpack, comando compatível com o script next build existente. Dependências não foram alteradas. A falha padrão do Turbopack permanece como limitação deste ambiente; não se declara esse comando aprovado.

## P/Q. Diff e status

`git diff --check` passou nos dois projetos. Ambos começaram sem alterações. Os arquivos listados em B/C e as correções descritas abaixo permanecem locais, modificados (`M`) ou novos (`??`), sem staging, commit ou push. Não houve alterações de lockfile ou package.json.

## R. Decisões e pontos para revisão

1. Revisar/aplicar a migration somente na etapa posterior autorizada. Não houve alteração do banco nesta entrega.
2. Os hosts Google/Microsoft/iCloud são permitidos por padrão. Hosts personalizados/alterações manuais usam a política existente `COMMUNICATION_SMTP_HOSTS`; cadastrar explicitamente o hostname desejado no ambiente da API antes de usá-lo. Não foram modificados arquivos de ambiente.
3. Nenhuma conexão sem TLS é aceita; portas permitidas: 587/TLS e 465/SSL. Esse limite segue a política já existente no backend.
4. Contas Microsoft/Gmail/iCloud precisam aceitar autenticação SMTP com senha/senha de app; o módulo não cria OAuth para provedores que a exijam por política da conta.
5. SMTP global legado e demais integrações já existentes não foram removidos. Os dois fluxos SMTP exigem teste real antes de habilitar ou enviar; uma configuração previamente habilitada apenas por verify é apresentada como UNTESTED/desabilitada e bloqueada no serviço de envio até passar pelo teste real.
6. Não foi feito teste manual com conta SMTP real nem validação de chegada à caixa de entrada: não há credenciais fornecidas e os testes automatizados são mockados conforme solicitado.
7. A chave de criptografia e as políticas de origem/autenticação existentes precisam estar configuradas no ambiente de execução.

Referência técnica consultada: [Nodemailer SMTP](https://nodemailer.com/smtp), para STARTTLS, SSL, autenticação e opções de timeout.

## Correções da revisão final

- Web: tenantApi reutilizado para SMTP de empresa, com verificação opcional da identidade capturada. Não foram alterados cookies, guards de autenticação, login/logout ou regras gerais de sessão. Testes cobrem A/B, duas abas, trava durante requisição, logout/login e contexto inválido.
- API: normalização SMTP compartilhada preserva fromName, replyTo e emailProvider; normaliza host/e-mail, porta numérica/string e secure boolean/string antes da comparação. A seleção de provider, isoladamente, é um rótulo e não invalida a conexão. Alterações reais do transporte/remetente/senha invalidam o teste e desabilitam envio.
- Estados: configuração salva sem teste = PENDING_VALIDATION (UNTESTED no gerenciador); envio real aceito = CONNECTED/SUCCESS; falha do envio real = FAILED/ERROR. Enabled é separado: exige SUCCESS. SMTP legado previamente habilitado somente por verify não é considerado ativo até envio real bem-sucedido. Nenhum enum ou migration foi alterado.
- Documentação operacional dos hosts SMTP corrigida. A integração Gmail API já existente continua separada do gerenciador SMTP.
- A migration 20261005120000_tenant_smtp e o schema permanecem exatamente como estavam antes desta correção; não há migration adicional nem aplicação ao DEV.
