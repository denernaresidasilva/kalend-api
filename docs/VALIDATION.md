# Evidências de validação local

## Correção do lockfile após 3a23b04

Validação em 23/09/2026 com Node 22.23.2 e npm 9.2.0 (lockfile v3).
O procedimento com `--legacy-peer-deps` registrado abaixo é histórico e não deve
ser repetido: ele removeu peers necessários do lockfile e quebrou `npm ci` normal.

- `package.json` não declara React, ReactDOM ou scheduler. Também não possui
  `peerDependencies`, `optionalDependencies`, `overrides` ou `workspaces` na raiz.
- A cadeia é `prisma@7.10.0` → `@prisma/studio-core@0.33.0`, que declara peers
  React/ReactDOM `^18.0.0 || ^19.0.0`. Radix/Visx também usam esses peers.
  A resolução seleciona React/ReactDOM 19.3.0; ReactDOM exige scheduler `^0.28.0`.
  São dependências transitivas da ferramenta Studio, não da aplicação NestJS.
- A autenticação adicionou somente `jose@6.2.12`, sem dependências React.
  As versões dos três pacotes Prisma foram fixadas em 7.10.0 naquele commit.
- A reprodução também identificou TypeScript 5.9.3 ausente: peer opcional
  `^5.0.0` de `vite-tsconfig-paths` → `tsconfck@3.1.6`. A resolução normal
  instala essa versão aninhada, mantendo TypeScript 6.0.3 na raiz.
- O lock foi regenerado localmente, em diretório temporário contendo os dois
  manifests, com `npm install --package-lock-only --ignore-scripts --no-audit
  --no-fund` (cache previamente preenchido; execução com `--offline`). Nenhuma
  versão existente mudou e nenhum pacote foi removido. Foram acrescentadas
  as quatro entradas ausentes e recalculadas somente as marcações
  `dev`/`devOptional` das entradas existentes. `package.json` permaneceu intacto.

Resultados: `npm ci` passou tanto no workspace quanto em cópia limpa criada
com `git archive HEAD` e o lock corrigido, sem `node_modules` ou `.env` prévios,
sem `--legacy-peer-deps`, `--force` ou `--ignore-scripts`. A instalação não
alterou o lock. O postinstall existente (`prisma skills sync || exit 0`)
informou ausência de `DATABASE_URL`; esse aviso não impediu a instalação.
O client Prisma foi gerado localmente com URL fictícia, sem conexão ao banco.

`npm run build`: OK. `npm test`: 48 testes passaram (10 arquivos).
`npm run test:e2e`: 51 testes passaram (2 arquivos); exigiu execução fora do
sandbox para a porta HTTP local do Supertest, com persistência mockada.
`npm run lint`: OK. `git diff --check`: OK.
Sem alterações em `.env`, banco, migrations ou código da aplicação; sem commit
ou push. Alterações limitadas a `package-lock.json` e este registro.

## Validação original do commit 3a23b04

Data: 23/09/2026. Branch: develop. Runtime utilizado: Node **22.23.2** disponível no ambiente; o Node padrão era 18.19.0, incompatível com as dependências atuais. Nenhum teste conectou a banco DEV ou produção.

| Verificação                                       | Resultado final                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Prisma client generate                            | OK, 7.10.0                                                           |
| Prisma validate/format                            | OK                                                                   |
| Prisma migrate diff entre schema original e atual | SQL comparado com a migration nova: equivalente; sem conexão a banco |
| npm run build                                     | OK, exit 0                                                           |
| npm test                                          | **48 passaram**, 10 arquivos, exit 0                                 |
| npm run test:e2e                                  | **51 passaram**, 2 arquivos, exit 0                                  |
| npm run lint                                      | OK, exit 0, sem avisos após remover import não usado                 |
| git diff --check                                  | OK, exit 0                                                           |
| git status                                        | develop, alterações locais e arquivos novos; sem commit/push         |

Instalação: `npm ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps`. O lockfile já apresentava incompatibilidade de peer dependency de vite-tsconfig-paths/tsconfck com TypeScript 6; `npm ci` sem legacy-peer-deps falhou pedindo typescript@5.9.3. Nenhuma atualização de dependências foi feita para contornar isso. Prisma continua fixado em `7.10.0`. Na etapa de autenticação foi adicionado somente `jose@6.2.12`; nenhuma versão de dependência existente foi atualizada. npm recalculou metadados do lockfile e removeu entradas peer não usadas de React/react-dom/scheduler ao instalar com legacy-peer-deps. Scripts de instalação foram desativados; cliente Prisma foi gerado explicitamente.

Download das dependências/engine e abertura de porta local dos testes HTTP exigiram execução fora do sandbox. A primeira execução e2e falhou na abertura do servidor local pelo supertest; fora do sandbox passou. Prisma foi substituído por provider mockado nos testes HTTP; nenhum dado real foi lido. Há aviso informativo do Vite sobre suporte nativo a tsconfig paths, sem falha.

## Cobertura relevante

- Company, OWNER e Subscription criados na transação; trial e ativação imediata.
- Reutilização de usuário sem alteração de senha; runtime inválido rejeitado.
- Select de memberships.user exclui passwordHash; retorno manual não inclui hash.
- Dashboard agrega grupos reais fornecidos pelo Prisma, sem inferir receita de criação manual.
- Cobrança usa preço do Plan, rejeita amountCents enviado, valida empresa/assinatura/plano.
- Chave idempotente de outra empresa rejeitada.
- Aprovação ativa empresa/assinatura; recusa não ativa; evento duplicado e outro eventId para mesmo pagamento não renovam novamente.
- Divergência de preço, empresa ou ambiente falha sem ativação; erro armazenado genérico.
- Ausência de adapter rejeita webhook antes de escrever eventos.
- Criptografia autenticada vinculada ao gateway/ambiente; flags de configuração sem credenciais tanto em service quanto em HTTP.
- Teste de conexão indisponível nunca retorna sucesso fictício.
- Fim de mês/ano bissexto; expiração preserva empresa com outra assinatura vigente.
- Rotas administrativas agora usam JWT/sessão e privilégio global (401/403); três receptores de webhook permanecem fora do JWT administrativo e rejeitam payload não autenticado pelo gateway.

**Limites:** testes de regras usam mocks; e2e cobre HTTP/Nest com banco mockado. Não é prova de transação/concorrência PostgreSQL, migração aplicada, conexão a gateways ou uso do painel DEV. Não houve teste sandbox de provedor, cobrança real, assinatura externa, cancelamento externo ou deploy. O registro de adapters permanece vazio. Políticas de webhooks fora de ordem e reconciliação de timeout exigem validação antes de conectar adapters reais.

## Autenticação — evidências adicionais

- Bcrypt real e assinatura/verificação jose real, com chave efêmera de teste; banco substituído por fixture em memória. Não é integração com PostgreSQL.
- Login correto, senha incorreta, identidade inexistente e usuário inativo; mensagens inválidas equivalentes.
- Cookies Secure/HttpOnly/SameSite/sem Domain e nenhum token/hash no JSON; refresh persistido somente como digest.
- JWT expirado, sem expiração, algoritmo diferente, assinatura forjada, audience incorreta e duração excedida rejeitados; sem chave não há fallback.
- /auth/me com privilégio global independente de membership; representação de duas empresas/papéis.
- Todos os grupos administrativos testados sem sessão (401) e com usuário comum (403), mais acesso permitido ao Super Admin; mutações administrativas também testadas sem sessão.
- Refresh rotativo, replay, expiração individual/absoluta, logout, logout-all e isolamento de dispositivos.
- Mudança de senha invalida sessões; desativação e retirada de privilégio passam a negar requisições seguintes.
- JWT válido referenciando sessão de outro usuário rejeitado.
- Mass assignment, Origin inválida/ausente e tentativa cross-tenant rejeitados; TenantRoles exige papel permitido, além da membership.
- Limitador com incremento compartilhado, chaves HMAC e HTTP 429; branch de disputa de refresh preserva revogação. Isso valida o código, não concorrência real de PostgreSQL.
- Função de bootstrap testada com cliente fake: criação global, recusa de segundo administrador, ausência de promoção implícita, promoção explícita e revogação de sessões. **CLI interativo não executado.**
- Migration `20260923160000_auth_sessions` gerada e comparada ao diff de schemas sem banco. Migration de gateways e suítes anteriores preservadas.
- Documentação do frontend e procedimento DEV atualizados. Nenhum .env real foi alterado.

Pré-requisitos restantes: aplicar migrations por procedimento autorizado, provisionar chave/origins/proxy, executar bootstrap manualmente, validar HTTPS/cookies no navegador DEV e concorrência em PostgreSQL. MFA, recuperação de senha HTTP e rotina de retenção não foram implementados. Não houve teste de integração externa de gateways nem deploy.

## Arquivos alterados/criados

- `docs/AUTHENTICATION.md`
- `docs/BACKEND-AUDIT.md`
- `docs/FRONTEND-API.md`
- `docs/VALIDATION.md`
- `package-lock.json`
- `package.json`
- `prisma/migrations/20260923140000_gateway_architecture/migration.sql`
- `prisma/migrations/20260923160000_auth_sessions/migration.sql`
- `prisma/schema.prisma`
- `scripts/admin-create.mjs`
- `src/app.controller.spec.ts`
- `src/app.controller.ts`
- `src/app.module.ts`
- `src/auth/admin-bootstrap.spec.ts`
- `src/auth/admin-bootstrap.ts`
- `src/auth/auth-rate-limit.service.ts`
- `src/auth/auth.config.ts`
- `src/auth/auth.controller.ts`
- `src/auth/auth.dto.ts`
- `src/auth/auth.guard.ts`
- `src/auth/auth.http.ts`
- `src/auth/auth.module.ts`
- `src/auth/auth.security.spec.ts`
- `src/auth/auth.service.ts`
- `src/auth/auth.tokens.spec.ts`
- `src/auth/auth.tokens.ts`
- `src/auth/auth.types.ts`
- `src/auth/tenant.guard.ts`
- `src/billing/billing.module.ts`
- `src/billing/billing.spec.ts`
- `src/billing/gateway.provider.ts`
- `src/billing/gateways.service.ts`
- `src/billing/lifecycle.service.spec.ts`
- `src/billing/lifecycle.service.ts`
- `src/billing/payments.service.ts`
- `src/billing/secret-vault.ts`
- `src/billing/webhook-processor.service.ts`
- `src/common/admin.guard.ts`
- `src/common/period.ts`
- `src/common/validation.ts`
- `src/companies/companies.controller.ts`
- `src/companies/companies.service.spec.ts`
- `src/companies/companies.service.ts`
- `src/dashboard/dashboard.module.ts`
- `src/dashboard/dashboard.service.spec.ts`
- `src/dashboard/dashboard.service.ts`
- `src/finance/finance.controller.ts`
- `src/finance/finance.service.ts`
- `src/main.ts`
- `src/plans/plan.validation.ts`
- `src/plans/plans.controller.spec.ts`
- `src/plans/plans.controller.ts`
- `src/plans/plans.service.spec.ts`
- `src/plans/plans.service.ts`
- `src/subscriptions/subscriptions.controller.ts`
- `src/subscriptions/subscriptions.service.ts`
- `src/users/users.controller.ts`
- `src/users/users.service.ts`
- `src/webhooks/webhooks.controller.ts`
- `src/webhooks/webhooks.service.ts`
- `test/app.e2e-spec.ts`
- `test/auth.e2e-spec.ts`
- `test/support/auth-database.ts`
