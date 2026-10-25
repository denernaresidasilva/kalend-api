# Landing pública e cadastro Trial

Estado local: 25/10/2026. Esta implementação ainda não foi publicada em DEV.

## Implementado

- `POST /auth/trial-signup`, protegido por `AuthOriginGuard`, cria em uma
  transação Serializable um usuário novo, uma empresa Trial, membership OWNER,
  assinatura Trial sem evidência de pagamento, consentimento versionado e evento
  de boas-vindas na Outbox. O cadastro não cria sessão, cookies ou tokens.
- Plano, elegibilidade e duração são validados no servidor. Qualquer identidade
  existente, ativa ou desativada, mantém o e-mail reservado; o fluxo não associa
  empresas, troca senhas nem reativa contas existentes. P2002 e conflito
  serializável concorrente P2034 retornam rejeição genérica.
- O e-mail é normalizado com trim/lowercase no cadastro e login. Uma migration
  acrescenta índice único PostgreSQL em `lower(btrim(email))`, impedindo
  duplicidade por caixa ou espaços mesmo para outros escritores. A migration
  aborta sem alterar schema se encontrar identidades legadas normalizadas iguais.
- Após cadastro, a página confirma sucesso e encaminha para a rota real de login
  `/`; o usuário informa normalmente seu e-mail e senha. A URL de login enviada
  no evento de boas-vindas é derivada exclusivamente de um Origin HTTPS permitido.
- Rate limits por IP/e-mail, honeypot, validação de senha, aceite obrigatório e
  consentimento promocional independente.
- Evento de boas-vindas solicita somente e-mail. Nenhum segredo é inserido nos
  eventos. WhatsApp depende de autorização/configuração e Push exige subscription
  autorizada do dispositivo; nenhum deles é disparado pelo cadastro público.
- `/lp` apresenta o catálogo elegível real; termos, privacidade e onboarding
  informam claramente as capacidades disponíveis. Módulos operacionais ainda
  indisponíveis não são anunciados como entregues.
- Tracking de marketing é opt-in, sem PII. Conversão ocorre após criação
  confirmada, e conversões são deduplicadas por sessão. DEV não é indexável.

## Validação local

- Validação atual da correção local: API 903 testes unitários e 253 E2E;
  lint, typecheck, build e Prisma validate passaram. Web: 402 testes, lint,
  TypeScript e build passaram.
- Migration `20261025090000_public_trial_signup_consent`: aplicada em PGlite
  isolado; tabela, defaults, FKs, unicidade e índices verificados.
- Web: 402 testes, ESLint, TypeScript e build passaram.
- Playwright local da LP: 3/3 passaram em desktop, tablet e mobile; o teste
  cobre cadastro sem cookies, tela de sucesso, navegação para login e login
  normal. As chamadas de API foram simuladas localmente e não representam
  homologação real.

## Regra de reutilização do e-mail

Consulta somente leitura realizada no banco DEV para o endereço reportado:
existe uma identidade de usuário desativada, sem membership, sem empresa
correspondente e sem assinatura, pagamento ou evidência financeira associada;
as sessões históricas estão todas revogadas. Portanto, isso não é uma exclusão
definitiva de identidade e o cadastro público deve continuar recusando o e-mail.
Nenhum registro DEV foi alterado. Não existe fluxo de recuperação de conta
disponível no produto auditado; a identidade requer recuperação administrativa
autorizada. A exclusão futura de empresa não deve remover uma identidade nem seu
histórico financeiro automaticamente.

## Gate DEV pendente

Leitura remota sanitizada em `srv1119527`: os processos DEV estão online; o
preflight da migration confirmou `kalend_dev`/`kalend_dev_migrator` sem
privilégios de cluster e `prisma migrate status` mostrou as 19 migrations já
publicadas como aplicadas. O catálogo público retornou três planos Trial elegíveis.

**Isolamento do runtime aplicado em DEV:** role `kalend_dev_runtime`, LOGIN sem
senha, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`,
`NOBYPASSRLS`, sem memberships ou ownership. Recebe somente `USAGE` em `public`,
DML em tabelas, `USAGE/SELECT` em sequences e default privileges futuros dos
objetos criados por `kalend_dev_migrator`. Não recebe `CREATE` no banco/schema.
O `.env` privado da API aponta para peer socket como `kalend_dev_runtime`; a role
migradora e a variável de migration permaneceram inalteradas.

Regras específicas de `pg_hba`/`pg_ident` permitem peer apenas do UID
`kalend-api-dev` para `kalend_dev` e rejeitam o runtime por socket em outros
bancos e por TCP. A role herda o bit `CONNECT` de `PUBLIC` no catálogo, mas testes
reais foram negados pelo HBA para `kalend` via socket, `kalend` via TCP e até
`kalend_dev` via TCP. O API DEV foi reiniciado somente pelo nome PM2 autorizado;
HTTP health e catálogo público retornaram 200, com três planos, e a sessão ativa
foi observada como `kalend_dev_runtime` em `kalend_dev`.

Configuração anterior preservada em `/root/kalend-dev-runtime-20261025-WitXCWSf`
(0700 root:root), com rollback `rollback-runtime.sh` validado por `bash -n`.
O backup contém `.env`; não copiar nem exibir seu conteúdo. Backup de dados DEV
restaurável continua em `/root/kalend-dev-lp-20261025-xVFoWvuV` e
`/root/kalend-dev-lp-20261025-fvBmlaR3`.

**Publicação continua bloqueada:** os dois usuários que os workflows verificam,
`kalend-api-dev` e `kalend-dev`, ainda podem executar `clpctlWrapper` por sudo.
O inventário CloudPanel disponível afirma que não se pode remover essa permissão
às cegas porque os consumidores legítimos ainda não foram totalmente mapeados;
uma identidade SSH de deploy separada também não isola código executado pelo
runtime na mesma conta. Não alterei sudoers, SSH ou a conta `clp`; recuperação
administrativa independente ainda não está comprovada. Não houve push, migration
ou deploy. `/lp` segue indisponível em DEV até o pipeline poder executar com
isolamento administrativo efetivo.

Antes de publicar, completar o inventário CloudPanel/SSH e confinar os
executores/runtime DEV sem quebrar os consumidores legítimos, com recuperação
administrativa independente e rollback verificados. Não usar este commit como
autorização para contornar esse gate.

Depois do isolamento: backup atualizado e restore verificado de `kalend_dev`,
push API (a migration é aplicada pelo workflow automático) e, em seguida, Web;
acompanhar Actions e validar cadastro, cookies, tenant, assinatura Trial e
Outbox com fixtures QA/sink autorizado. Não enviar WhatsApp/Push sem dispositivo
ou destinatário QA autorizado; não cobrar, usar SMTP de produção ou alterar PROD.

## Limitações funcionais reconhecidas

O onboarding confirma Trial e conta, mas serviços, horários e agenda pública
continuam indisponíveis neste ambiente. O envio real de e-mail sandbox depende
da allowlist e da configuração de DEV. Termos e política publicados nesta
implementação requerem validação jurídica antes de uso comercial definitivo.
