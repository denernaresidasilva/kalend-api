# Super Admin KALEND — status de homologação

Atualizado: 2026-10-21T21:50:32.878558+00:00. Ambiente de execução: LOCAL, Node 24.21.0. SSH limitado a metadados em transação READ ONLY no DEV.

## Decisão executiva

**SUPER ADMIN BLOQUEADO para homologação definitiva e liberação dos demais painéis.** As proteções financeiras e administrativas têm evidência local, mas a versão candidata não está publicada em DEV, a migration nova está ausente nesse banco, a concorrência PostgreSQL nativa não está comprovada para esta implementação e os fluxos externos críticos ainda não têm evidência suficiente. Nenhum desses pontos é resolvido por health HTTP 200.

Não foram iniciados os painéis Proprietário, Profissional, Contador ou Cliente. Não houve commit, push, merge, deploy, alteração de main, escrita administrativa em banco real, mensagem/cobrança real ou alteração operacional na VPS nesta auditoria.

## Estado e preservação do trabalho anterior

Há dois repositórios Git irmãos; a pasta comum não é um repositório Git válido. API e Web estão em `develop`, sem checkout de branch durante a tarefa.

- API base: `b1cc220aafcb1f2fef97c026150795fcd5c88906`.
- Web base: `4d86829b81737189503eb8b1859477e708dcdb12`.
- Estado inicial API: 18 arquivos rastreados modificados e 7 não rastreados; Web limpa.
- O trabalho anterior de SubscriptionEntitlement, PaymentEvidence, ADMIN_GRANT, graça, estornos, idempotência e QA foi mantido. Só houve acréscimos/correções pontuais descritos abaixo.
- Manifestos de estado e hashes: [estado inicial](evidencias/2026-10-21-super-admin/estado-inicial.json) e [estado final](evidencias/2026-10-21-super-admin/estado-final.json).

## Evidência histórica e banco já testado

`ENTITLEMENT-GRACE-SECURITY.md` registra 862 unitários e 243 E2E anteriores. O próprio documento identifica PGlite e pool de uma conexão; não representa aprovação nativa multiconexão nem DEV real. O texto não fornece sozinho um manifesto de hashes dos arquivos sujos daquela execução. Por isso foi necessária regressão do candidato atual, sem reutilizar números como aprovação automática.

`docs/PHASE3-COMMUNICATION.md` relata migrations anteriores em PostgreSQL 16.15 descartável, cluster depois removido. A auditoria de 09/10 e os documentos da homologação descrevem PGlite, mocks e limitações de concorrência. Essas provas não foram descartadas ou reescritas; continuam históricas e não certificam a migration de 17/10.

Inventário atual: não há `postgres`, `initdb`, `pg_ctl`, `psql`, Docker ou Podman disponíveis localmente nem diretório de binários PostgreSQL conhecido. Não foi instalado um cluster novo nem reutilizado banco real. Ver [inventário](evidencias/2026-10-21-super-admin/inventario-postgresql.json).

## DEV real: fatos confirmados, sem teste financeiro

Em 21/10/2026 às 21:08:23 UTC, SSH no `srv1119527` confirmou, em `BEGIN READ ONLY`, PostgreSQL **16.15**, banco `kalend_dev`, zero registros da migration `20261017090000_subscription_entitlement_evidence` em `_prisma_migrations` e ausência de `PaymentEvidence`/`SubscriptionEntitlement`.

Os Git HEAD publicados coincidem com os commits-base acima. Isso não prova sozinho que os artefatos remotos equivalem ao candidato local ou que o checkout remoto está limpo. A ausência das tabelas prova que a implementação nova não está homologada no schema DEV observado. Não foram consultados registros das Companies QA nem histórico financeiro. Ver [transcrição estruturada da consulta](evidencias/2026-10-21-super-admin/dev-schema-readonly.json).

A recuperação operacional e a habilitação das units da fase anterior são fatos separados: nenhuma unit foi iniciada/reiniciada nesta auditoria e o teste dinâmico continua pendente de autorização própria.

## Bugs comprovados e corrigidos localmente

### SA-01 — P0: grant inferido sobre período legado já comprovado por pagamento

O backfill de uma Subscription MANUAL criava PAYMENT e também ADMIN_GRANT para o mesmo período. O segundo direito não dependia do pagamento e sobrevivia ao estorno da única prova financeira. A regressão reproduziu dois direitos onde deveria existir apenas o direito pago.

Correção na migration **nova, local, não aplicada em DEV**: não inferir grant quando já existe direito PAYMENT exato para o período atual. Preserva a classificação administrativa histórica sem prova paga e não fabrica pagamentos. O teste estorna a única prova e exige cobertura falsa. Evidência: [reprodução](evidencias/2026-10-21-super-admin/backfill-repro.log), `test/entitlement-backfill.e2e-spec.ts` e regressão direcionada.

### SA-02 — P0: exclusão de empresa podia apagar evidência financeira

O serviço removia webhooks explicitamente e excluía a empresa sujeita às cascatas do schema, sem barreira de histórico financeiro. A correção rejeita exclusão com qualquer Payment, WebhookEvent, SubscriptionEntitlement ou mandato externo, antes da limpeza Evolution e novamente na transação Serializable. Não muda ou cancela pagamentos. A exclusão de cadastros sem esse histórico continua testada.

Evidência: [reprodução com cinco casos](evidencias/2026-10-21-super-admin/company-deletion-repro.log), `src/companies/companies.service.spec.ts` e quatro casos persistidos em `test/entitlement-evidence.e2e-spec.ts`. A repetição da checagem na transação foi testada com mudança entre as leituras; isso não equivale a certificar uma corrida MVCC nativa.

### SA-03 — P1: inbox de recuperação bloqueada e filtro administrativo incompleto

O filtro exigia somente `company.isActive=true`: negava inbox ao OWNER suspenso e não verificava `administrativeStatus` do tenant selecionado. Agora exige usuário, empresa e membership exatos/ativos e autorização administrativa; permite apenas o contexto legítimo de conta/recuperação. Produto continua negado sem entitlement.

Evidência: [três reproduções persistidas](evidencias/2026-10-21-super-admin/notification-scope-repro.log), testes unitários e casos PGlite para SUSPENDED, DISABLED e LEGACY_UNKNOWN. A correção não lista notificações de outro usuário ou tenant.

### SA-04 — P2: fixture SQL/HTTP antiga sem ator da concessão

O script de trial chamava `createManual` sem o ator exigido pela implementação nova. A fixture agora cria explicitamente um Super Admin descartável e passa seu ID; não contorna guards ou reduz asserts. Removida também a legenda fixa enganosa de “14 migrations”; o script percorre as migrations versionadas existentes.

### SA-05 — P2: suíte browser ainda exigia apresentações removidas

A primeira execução completa registrou 84 aprovações e 27 falhas, sem skips. Os testes ainda exigiam o modal inicial do Proprietário, um título antigo de planos e uma apresentação antiga da expiração da sessão. O commit-base `4d86829` demonstra a recuperação compacta aprovada. Foram corrigidas apenas as expectativas de teste, sem alterar componentes de produto: produto continua bloqueado no trial expirado, Escape/falha de rede não liberam acesso, checkout mantém preço/termos/idempotência e apenas confirmação autoritativa libera o shell. A recuperação de conta em outras rotas continua testada com o modal detalhado. Um caso adicional cobre a seleção compacta e a pendência sem concessão de acesso.

## Resultados automatizados e qualidade da evidência

| Verificação | Resultado / limite |
|---|---|
| API, primeira regressão válida do estado inicial | 862/862 unitários; 243/243 E2E |
| API, regressão unitária após correções | 868/868 aprovados; 0 falhas; 0 pendentes |
| API, regressão E2E final | 251/251 aprovados; 0 falhas; 0 pendentes |
| Evidência/backfill/preservação/inbox direcionados | 62/62, PGlite descartável, Prisma real, pool de uma conexão |
| Web, regressão inicial válida | 393/393 Node tests; não confundir com a tentativa restrita que só reportou arquivos |
| API e Web: build/lint/typecheck | PASSOU após restauração das dependências; sem mudança visual de produto |
| Prisma validate/generate | PASSOU localmente com datasource inerte; generate não aplica migration |
| Integração SQL/HTTP | 42 asserções, gateway substituído e PGlite descartável |
| Recuperação local entre processos | 10 asserções, dois processos Node e PGlite em disco; não é teste systemd |
| Framework da homologação | 13/13 testes de gate/cleanup/matriz |
| Responsividade | 324 verificações, 18 rotas × 9 larguras × 2 temas; zero overflow e exceções JS |
| Playwright final | 114/114 aprovados, zero falhas/skips/flaky, desktop/tablet/mobile; APIs simuladas |
| PostgreSQL nativo multiconexão | NÃO TESTADO nesta implementação; infraestrutura local não disponível |
| DEV real autenticado/fornecedores | NÃO TESTADO nesta tarefa; nenhuma operação com efeitos de aplicação |

As tentativas iniciais restritas ficam registradas: sockets/subprocessos foram bloqueados pelo sandbox e uma DATABASE_URL inerte interferiu nos testes de classificação de ambiente. A reexecução usa `DOTENV_CONFIG_PATH=/dev/null`, sem `.env` privado, e apenas conexões de fixtures. Falhas de infraestrutura não foram tratadas como bugs de produto ou escondidas removendo asserts.

Os downloads de patches npm excederam os limites. As tentativas foram encerradas exclusivamente nos processos instaladores locais da auditoria; manifests/locks inicialmente limpos foram restaurados byte a byte. O client Prisma completo original foi recuperado e regenerado. Builds e regressões foram repetidos após essa recuperação; as falhas intermediárias de instalação/client ficam preservadas como tentativas, sem serem promovidas a aprovação ou confundidas com defeitos do produto.

A execução browser inicial (84/111) e a intermediária (51/57, ainda com duas expectativas antigas) permanecem preservadas. A execução completa final usa os testes corrigidos e aprovou 114/114 sem skips ou retries. Não houve redução de regras de negócio: foram acrescentadas verificações de shell bloqueado, seleção compacta, pendência e liberação só após confirmação do estado autoritativo.

As suítes chamadas E2E da API incluem HTTP com persistência substituída e HTTP/Prisma/PGlite. As do navegador usam APIs interceptadas em `api.kalend.invalid`. Nenhuma dessas camadas comprova entrega de fornecedor ou integração integral da release em DEV. Logs e JSON ficam em [evidências](evidencias/2026-10-21-super-admin/).

## Cobertura por requisitos declarados

Fórmula: requisitos com status **APROVADO LOCALMENTE / total dos grupos de requisitos declarados do módulo**. PARCIAL, BLOQUEADO e NÃO TESTADO não entram no numerador. Isto não é cobertura de linhas/branches, nem percentual de homologação real. Os 72 grupos e suas camadas/evidências estão integralmente na [matriz](SUPER_ADMIN_MATRIZ.md) e no [JSON](SUPER_ADMIN_MATRIZ.json).

| Módulo | Aprovados / requisitos | Cobertura local |
|---|---:|---:|
| Autenticação | 5/9 | 55.6% |
| Permissões | 5/6 | 83.3% |
| Empresas e usuários | 6/8 | 75.0% |
| Planos e trial | 4/5 | 80.0% |
| Assinaturas | 5/6 | 83.3% |
| PaymentEvidence | 6/9 | 66.7% |
| Checkout e webhooks | 5/6 | 83.3% |
| Financeiro | 2/3 | 66.7% |
| Comunicação | 6/9 | 66.7% |
| Interface | 5/7 | 71.4% |
| Infra e segurança | 2/4 | 50.0% |

## Estado funcional por módulo

- **Autenticação/permissões:** login, cookies HttpOnly/Secure/Strict, JWT curto, refresh rotativo, revogação e guards têm testes locais. Não há recuperação/troca de senha por HTTP nem MFA. Fingerprint que invalida senha antiga não implementa esses fluxos. Minha Conta informa a indisponibilidade; não foi reintroduzida interface removida.
- **Empresas/usuários:** criação manual, vínculos múltiplos, edição/desativação e isolamento local implementados. Cadastro comercial público e roteamento efetivo por subdomínio não foram certificados. Não foi encontrada trilha administrativa abrangente para todas as edições; grants têm ator próprio.
- **Planos/trial/assinaturas:** validações, trial autoritativo e prazos UTC estão cobertos localmente. Limites futuros exigem integração nos serviços de produto; não se afirma que painéis inexistentes respeitam limites. Operação completa de grant/revogação ainda não tem UI dedicada.
- **Financeiro/PaymentEvidence:** primeira cobrança não aprovada não concede GRACE; ADMIN_GRANT não cria receita; provas alternativas não somam intervalos; estornos/chargeback invalidam sua prova e preservam outra válida. Revisão de duplicidade é persistida, mas falta workflow visual completo. Listas administrativas têm backend paginado, porém frontend consulta recorte de até 100 e filtra localmente: não homologar busca/histórico integral além desse recorte.
- **Checkout/webhooks:** adapters, verificação, idempotência, payload malformado, ordem de eventos e UNCERTAIN são testados com fornecedores simulados. Não houve cobrança sandbox real ou confirmação externa nesta tarefa.
- **Comunicação:** os 13 eventos técnicos constam de contratos/triggers/templates. As camadas geração → persistência → expansão → claim → aceite → entrega são distintas. SMTP/Evolution/Push simulados não são entrega. Meta implementa receipts correlacionados; isso não prova recebimento real de uma execução atual.
- **Frontend:** páginas existentes e decisões visuais preservadas; contratos/estados têm testes locais. Perfil somente leitura, configurações e recursos indisponíveis continuam explicitamente parciais. Chromium com emulação de viewport não certifica Safari/iOS, hardware ou acessibilidade completa.

## Eventos comerciais e comunicação crítica

Inventariados: OWNER_WELCOME, TRIAL_STARTED, TRIAL_EXPIRING, TRIAL_EXPIRED, PAYMENT_PENDING, PAYMENT_APPROVED, PAYMENT_FAILED, PAYMENT_OVERDUE, SUBSCRIPTION_GRACE_PERIOD, SUBSCRIPTION_SUSPENDED, SUBSCRIPTION_REACTIVATED, SUBSCRIPTION_CANCELLED e SECURITY_PASSWORD_CHANGED.

Captura SQL e regras locais de seleção/idempotência foram revisadas/testadas. Nenhum evento foi disparado manualmente em DEV/PROD. A existência de SECURITY_PASSWORD_CHANGED não comprova uma tela ou endpoint de troca de senha.

Em DEV, o e-mail usa sink loopback e allowlist, sem fallback SMTP live; Mailpit permaneceu desligado por restrição da recuperação anterior. Homologação de e-mail depende de autorização para prover o sink. WhatsApp exige instância/destinatário QA isolados; Push exige dispositivo/perfil e prova de recebimento. `ACCEPTED` nunca é promovido para entrega real neste relatório.

O incidente histórico BUG-01 do popup Push permanece OPEN no artefato anterior. Código/testes sintéticos podem passar e ainda assim não encerrar o incidente do perfil DEV afetado. Não foi marcada uma vulnerabilidade nova só por esse sintoma e a severidade histórica não foi silenciosamente reduzida.

## Vulnerabilidades de dependências

Os relatórios npm iniciais identificaram Web: 3 pacotes high (Next, sharp, source-map-js); API: 4 entradas high na cadeia Prisma/config/deepmerge-ts/mysql2. Contagem de entradas não é contagem de vulnerabilidades exploráveis na aplicação. MySQL não é o banco de runtime deste produto; deve-se distinguir tooling, caminhos alcançáveis e distribuição de produção.

Fontes publicadas consultadas: [Next cache poisoning](https://github.com/advisories/GHSA-4jqv-mc3x-m676), [source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), [sharp/librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w). Ver JSON npm e registro de conclusão dos patches antes de afirmar remediação. Nenhum `npm audit fix --force` foi usado e nenhum pacote foi instalado na VPS.

**Remediação NÃO aplicada:** downloads ficaram incompletos; runtime e manifests originais foram restaurados e revalidados. A proposta exata está em [security-patches-proposed.txt](evidencias/2026-10-21-super-admin/security-patches-proposed.txt): Next/eslint-config-next 16.3.8, sharp 0.35.5, source-map-js 1.2.2 e família Prisma 7.10.1 alinhada. Exige instalação íntegra, geração local do client e nova regressão antes de adoção. Não presumir correção só por trocar números no manifest. Ver [restauração](evidencias/2026-10-21-super-admin/dependency-restoration.json).

## Arquivos alterados nesta auditoria

Na API:

- `prisma/migrations/20261017090000_subscription_entitlement_evidence/migration.sql` (migration nova; as 18 migrations históricas rastreadas continuam byte a byte iguais ao HEAD).
- `src/companies/companies.service.ts` e `src/companies/companies.service.spec.ts`.
- `src/notifications/notifications.service.ts` e `src/notifications/notifications.spec.ts`.
- `test/entitlement-backfill.e2e-spec.ts` e `test/entitlement-evidence.e2e-spec.ts`.
- `scripts/validate-trial-access.mjs`.
- Este diretório `docs/homologacao/`: status, matrizes, manifestos e evidências.

Na Web, somente testes: `homologacao/specs/core.local.spec.ts` e `homologacao/specs/checkout.local.spec.ts`. Nenhum componente visual foi reintroduzido. Manifests e locks finais não têm alteração desta auditoria. Build/client gerados são artefatos locais ignorados pelo Git. A pasta comum `docs/homologacao` é um atalho para o conteúdo canônico versionável em `kalend-api/docs/homologacao`.

## Bloqueadores restantes e critérios objetivos

1. **P1 — candidato não homologado em DEV:** revisar e publicar somente mediante nova autorização; aplicar a migration também exige autorização própria. Exigir hashes da release, revisão de dados legados, backup verificado e rollback antes de qualquer ação. Correções locais SA-01/02/03 não são correções já publicadas.
2. **P1 — concorrência PostgreSQL nativa não comprovada:** em PostgreSQL 16 efêmero isolado, usar duas ou mais conexões/transactions independentes para aprovação duplicada, dois pagamentos do mesmo intervalo, sobreposição, aprovação×estorno, grant×revogação, checkout×troca de configuração e claims de worker. Demonstrar retries/rollback/uniqueness sem acesso adicional ou dupla cobrança. PGlite pool=1 não encerra esse requisito.
3. **P1 — cadeia externa financeira e de comunicação:** checkout/webhook sandbox correlacionado, primeira cobrança sem acesso, renovação, falha/overdue/grace, suspensão, recuperação, estorno parcial/integral, reentrega e callbacks fora de ordem na mesma release. Comunicação deve separar evento armazenado, delivery, aceite e recebimento por canal. Nenhuma operação remota autorizada para produzir essas provas nesta tarefa.
4. **P1 — BUG-01 histórico/Push e entrega crítica:** reproduzir no perfil autorizado e registrar versão, estado de permissão/SW/subscription/device; fechar somente com evidência revisada. Não reutilizar login de usuários reais para ensaios destrutivos.
5. **Segurança de dependências:** concluir/revisar a remediação local e o audit pós-correção, seguido de regressão. Não liberar uma combinação parcialmente instalada ou um patch não validado.

Não foram abertas autorizações implícitas para migration, deploy, Mailpit, jobs, mensagens, cobrança ou systemd. Bloqueios externos não impediram as demais análises/correções locais.

## Plano de homologação final em DEV

1. Revisar o diff local e os artefatos desta auditoria; resolver requisitos funcionais parciais com decisão explícita. Congelar release candidata com hashes, sem aprovar só o commit-base.
2. Disponibilizar PostgreSQL efêmero nativo e encerrar os cenários concorrentes acima. Não conectar testes a `kalend` ou `kalend_dev`.
3. Autorizar separadamente leitura de classificação de backfill em dados DEV, backup, migration e publicação. A migration deve abortar se o legado exigir revisão; nunca contornar o guard nem fabricar evidência.
4. Usar contas QA Super Admin/OWNER/PROFESSIONAL/CLIENT e tenants A/B isolados; provar 401/403, IDOR, sessão revogada, usuário desativado, bloqueio administrativo e regularização sem privilégio indevido.
5. Autorizar operações sandbox e destinatários controlados para o ciclo comercial completo; registrar IDs redigidos, antes/depois e prova de fornecedor/recebimento. Preservar Companies QA existentes e seus históricos, sem fixtures destrutivas.
6. Validar interface nos dois temas, viewports e fluxos principais com frontend/API/schema candidatos, sem interceptação de API real. Encerrar BUG-01 com o perfil correto.
7. Fazer teste dinâmico PM2/systemd somente em tarefa própria autorizada. Aprovar o Super Admin apenas com zero P0/P1 abertos e evidência suficiente em DEV real.

## Preservação e próximos trabalhos

Produção, outros sistemas, Git remoto, dados privados e bancos reais foram preservados. Os acessos remotos desta auditoria foram consulta read-only de schema/versão/HEAD e verificação final de HTTP/PIDs. Às 21:38:59 UTC, os quatro endpoints DEV/PROD retornaram 200 e os PIDs de frontend/API/PM2/PostgreSQL/Redis/Evolution inspecionados mantinham seus horários de início anteriores. Não houve alteração de `.env`, Nginx, PM2, systemd, PostgreSQL, Redis, Docker ou Evolution.

**Decisão sobre novos painéis: BLOQUEAR a liberação solicitada até encerrar os gates P0/P1 e a homologação real acima.** Não é necessário reconstruir o que já está implementado e testado. A próxima execução deve partir deste documento, dos resultados atuais e da matriz, sem tratar relatórios históricos como testes da nova release.
