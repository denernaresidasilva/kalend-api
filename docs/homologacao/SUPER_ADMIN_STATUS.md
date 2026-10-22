# Super Admin KALEND — acompanhamento de homologação

Atualizado em 22/10/2026. **SUPER ADMIN BLOQUEADO para homologação definitiva e liberação dos demais painéis.** A release local está preparada e versionada; faltam publicação segura, migration e evidência dos fluxos críticos em DEV real. Não foram iniciados outros painéis.

O [histórico integral de 21/10](SUPER_ADMIN_STATUS_2026-10-21.md) foi preservado. A [matriz de 72 requisitos](SUPER_ADMIN_MATRIZ.md) e o [JSON](SUPER_ADMIN_MATRIZ.json) detalham implementação, testes, evidência, ambiente, resultado, bloqueador e próximo passo para cada grupo.

## Estado confirmado e Git

Há dois repositórios, ambos em develop. HEAD inicial API: b1cc220aafcb1f2fef97c026150795fcd5c88906. HEAD inicial Web: 4d86829b81737189503eb8b1859477e708dcdb12. Os hashes de 211 arquivos API e 203 Web coincidiam com a última auditoria; o trabalho anterior foi preservado, revisado e incorporado aos commits locais autorizados. Os números históricos não foram usados como resultados atuais após os patches.

Commits locais da API: 6475fe8 (evidência financeira, correções anteriores, retries e testes nativos), 34e4261 (dependências), 36a1370 (chargeback concorrente). Web: 525382d (regressões da interface aprovada), 5c7bf8c (patches). O commit documental posterior registra este relatório; consultar git log para seu hash. Nenhum push, merge, deploy ou alteração de main foi executado.

O código candidato e os lockfiles estão identificados por [hashes](evidencias/2026-10-22-super-admin/candidate-source-hashes.json). Logs brutos, perfis, traces, screenshots e clusters temporários ficam locais e ignorados no Git; somente relatórios estruturados revisados e resumos são versionados. Nenhum .env privado foi modificado ou incluído.

## Bloqueadores tratados nesta execução

### SA-06 — P1 local corrigido: conflitos nativos de webhook não eram repetidos

PostgreSQL nativo demonstrou falhas em 4 dos 12 cenários iniciais. PrismaPg expunha o conflito do SELECT FOR UPDATE como P2010, com driverAdapterError.cause.originalCode=40001. O processador repetia apenas P2034/P2002, convertendo um conflito recuperável em WEBHOOK_PROCESSING_FAILED.

A classificação agora reconhece somente SQLSTATE 40001/40P01 em erros Prisma P2010, além dos códigos anteriores. Webhook e simulador preservam o limite de três tentativas da transação completa; erros de permissão, sintaxe, conexão e integridade não são incluídos indevidamente. Dez testes unitários cobrem classificação, rejeição e limite. Não há chamada de provedor dentro da repetição do processador verificado.

### SA-07 — P1 local corrigido: revogação concorrente de ADMIN_GRANT falhava

Duas requisições válidas simultâneas podiam gerar conflito Serializable sem retry no CompaniesService. A revogação agora repete a transação completa até três vezes, revalidando o ator, tenant, direito e estado. O teste nativo exige sucesso das duas solicitações, preservação do ator e perda de acesso quando não resta prova válida; a corrida revogação × pagamento legítimo preserva o direito pago.

Os SA-01/02/03 anteriores (backfill inferindo grant sobre pagamento, exclusão de histórico financeiro e inbox de recuperação) foram preservados, revisados e revalidados. A migration histórica aplicada não foi reescrita: somente a migration nova da release contém a correção anterior. As 18 migrations antigas permanecem iguais ao commit-base.

Uma expectativa nova de teste supunha que reapresentar APPROVED após reembolso integral recuperaria o mesmo pagamento. Isso não é regra válida: a fixture foi corrigida para exigir novo pagamento aprovado. Nenhuma regra comercial foi enfraquecida.

## PostgreSQL nativo e migration

**PostgreSQL 16.15 nativo validado localmente**, mesma versão principal/secundária observada em DEV. Pacotes oficiais Debian foram extraídos em /tmp, sem criar serviço do sistema. O runner npm run test:native cria cluster próprio com initdb, usuário sintético, banco reservado e porta loopback dinâmica. Exige diretório proprietário/marcador e confere SHOW data_directory antes de qualquer limpeza de fixture. Não lê DATABASE_URL nem usa credenciais reais. Encerra somente o cluster que criou e retém os logs/dados temporários.

Resultado: **41/41 = 17 cenários nativos + 24 de backfill**. Pools de até seis conexões. PIDs de backend distintos e pg_blocking_pids comprovaram bloqueio real simultâneo em FOR UPDATE; ver [resumo estruturado](evidencias/2026-10-22-super-admin/resumo-execucao.json).

Cenários: webhook duplicado, dois eventos para um pagamento, duas provas do mesmo período, renovação adjacente, sobreposição, reembolsos concorrentes, parcial × aprovação, primeira FAILED/OVERDUE sem graça, grant × estorno, replay depois de refund, revogação duplicada, revogação × aprovação, recuperação com novo pagamento, aprovação × refund e chargeback × refund alternativo. O backfill executa as migrations anteriores, cria legados sintéticos, aplica a nova e prova rollback dos casos ambíguos. Não é teste de carga ou comprovação universal de todas as corridas possíveis. Checkout × troca de configuração e claims de worker mantêm sua evidência lógica/local anterior, sem nova certificação nativa nesta bateria.

Migration 20261017090000_subscription_entitlement_evidence presente e validada em bancos descartáveis. Índices, constraints, funções e guard de ambiguidade exercitados. **Não aplicada em DEV/PROD nesta tarefa.** Em consulta SSH READ ONLY de 22/10, kalend_dev retornou PostgreSQL 16.15, zero migrations concluídas com esse nome e tabelas PaymentEvidence/SubscriptionEntitlement ausentes. Os registros financeiros reais não foram alterados nem usados em testes.

O backfill real ainda exige classificação do legado, volumetria, estimativa de locks e restauração de backup ensaiada. Dados sintéticos pequenos não estimam duração em DEV. Rollback de código não desfaz schema/funções. O [procedimento de release/recuperação](RELEASE_DEV_CONTROLADA.md) descreve os gates obrigatórios.

## Regressão atual

| Verificação | Resultado | Ambiente / limite |
|---|---:|---|
| Unitários API | 878/878 | LOCAL; após correções e patches; zero falhas/pendentes |
| E2E API | 251/251 | LOCAL; HTTP e fixtures/mocks/PGlite conforme suíte |
| PostgreSQL nativo | 41/41 | LOCAL descartável; 17 casos + 24 de backfill |
| Testes Web | 393/393 | LOCAL Node tests |
| Playwright | 114/114 | LOCAL; APIs interceptadas; zero skip/flaky/falha |
| Responsividade | 324/324 | 18 rotas × 9 larguras × 2 temas; zero overflow/exceções JS |
| Build API/Web | PASSOU | Node 24.21.0; Web Next 16.3.8; API ESM |
| Lint API/Web | PASSOU | Sem desativar regras ou testes |
| Typecheck API/Web | PASSOU | Sem erros |
| Prisma validate/generate | PASSOU | Datasource inerte; sem migration real |
| git diff --check | PASSOU | Ambos os repositórios |

Os 42 asserts SQL/HTTP e 10 asserts de recuperação local entre processos, assim como os 13 testes do framework de homologação, permanecem históricos de 21/10 e não são apresentados como reexecutados agora. Não certificam systemd. Relatórios atuais: [evidências](evidencias/2026-10-22-super-admin/README.md).

## Dependências e segurança

Patches mínimos, sem major upgrade: Prisma/client/adapter 7.10.1; Next/eslint-config-next 16.3.8; sharp 0.35.5; source-map-js 1.2.2; Vitest/coverage 4.1.12; Vite 8.3.5. O override restrito external-editor → tmp 0.2.7 corrige a cadeia antiga do CLI Nest; foi verificada criação/leitura/cleanup do arquivo temporário sem abrir editor. Os downloads e instalações foram concluídos em staging local antes da substituição dos node_modules; o runtime anterior foi preservado em /tmp.

npm audit --omit=dev: **zero advisories nas duas aplicações**. Auditoria completa API: zero. Auditoria completa Web: cinco entradas high derivadas de **um advisory braces**, somente na cadeia de tooling ESLint/fast-glob/micromatch. A versão mais recente publicada observada de braces é 3.0.3 e continua afetada; não foi aplicado downgrade incompatível do Next ou override sem patch real. P2 residual neste uso: lint sobre arquivos/padrões confiáveis, sem exposição de glob recebido de usuários em runtime. Reavaliar prioridade se essa condição mudar. Não é correto declarar zero vulnerabilidades na árvore Web completa.

Fontes: [Next](https://github.com/advisories/GHSA-4jqv-mc3x-m676), [source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Os JSON npm registram o conjunto completo, antes/depois. Zero advisories não equivale a prova de ausência de vulnerabilidades.

## Estado dos módulos e critérios restantes

- PaymentEvidence/SubscriptionEntitlement: aprovados localmente no escopo dos testes; provas alternativas não multiplicam tempo, estorno/chargeback retiram só a prova afetada, grant legítimo permanece independente, revogação remove acesso sem apagar histórico. Falta schema/release em DEV.
- Pagamentos/checkout/webhooks: contratos, idempotência, ordem e falhas têm regressão local; sandbox real/callback do provedor continuam bloqueados.
- GRACE/suspensão/reativação/cancelamento: aprovados localmente. Primeira cobrança nunca aprovada não recebe graça. Direitos válidos e bloqueio administrativo são preservados conforme política; falta ciclo QA da release em DEV.
- Autenticação/multi-tenant: guard, papel global, membership ativo, IDOR, tokens expirados/revogados/desativação e mutações financeiras protegidas têm regressão local. Falta evidência autenticada com tenants A/B na release publicada.
- Comunicação: geração/persistência/expansão/retry/isolamento têm evidência local; não houve envio real. Aceite não comprova entrega. Sink de e-mail, aparelho WhatsApp QA e perfil/dispositivo Push precisam homologação autorizada.
- Push BUG-01: continua aberto. As regressões de permissão passaram; o perfil afetado, sua subscription/SW/origem e prova de recebimento não foram disponibilizados para reprodução. Nenhuma subscription foi apagada.
- Interface: padrão visual preservado, testes atualizados à recuperação compacta já aprovada. Nenhuma tela de produto foi reconstruída. Integração real da release com API/schema continua pendente.
- P2/P3 anteriores: recuperação/troca de senha HTTP e MFA ausentes; trilha administrativa geral incompleta; UI de grant/revisão financeira parcial; histórico além de 100 registros sem navegação integral; Safari/iOS/acessibilidade completa não certificados; teste dinâmico systemd pendente. Nenhum desses pontos foi promovido silenciosamente a aprovado.

## Matriz e cobertura

72 grupos: **52 APROVADO LOCALMENTE, 12 PARCIAL, 2 NÃO TESTADO, 6 BLOQUEADO**. Nenhum aprovado em DEV real para esta release. Cobertura calculada por grupos aprovados/identificados de cada módulo, disponível ao fim da matriz; não mede linhas de código ou percentual de homologação real. Concorrência nativa deixou de ser bloqueador local. Dependências passaram de bloqueado para parcial pelo alerta de tooling sem patch publicado.

## Publicação e preservação

Acesso SSH efetivamente observado: root, UID 0. Não foi comprovado acesso DEV tecnicamente restrito. Os workflows de push para develop fazem deploy e a API aplica migrate deploy antes do build; não têm gates de backup/testes/restauração demonstrados. Por isso **nenhum push/deploy foi executado**, embora commits locais tenham sido autorizados. O impedimento vem das regras de acesso/deploy da tarefa, não de falta de autorização para correções locais.

DEV frontend/API e PROD frontend/API retornaram HTTP 200 na leitura remota. PIDs/horários de início observados coincidem com o estado anterior: PM2 PROD 1299/1318, frontend PROD 2461, DEV frontend 2465827 e API 2465910; PostgreSQL 1067, Redis 788 e Nginx 1230 preservados. Nenhum serviço remoto foi iniciado/parado/reiniciado/reconfigurado. Não houve escrita administrativa nos bancos, cobrança, mensagem real, execução manual de workers, alteração de timers, .env, PM2, Nginx, systemd, Redis, Docker ou Evolution. Outros sistemas foram preservados pela ausência de intervenção remota.

## P0/P1 e próxima decisão

**P0 aberto comprovado na release local: nenhum identificado nas verificações realizadas.** Isso não certifica a versão ainda publicada em DEV. SA-01/02 e SA-06/07 só serão correções publicadas após release segura.

**P1 restantes:** release e migration ausentes em DEV; isolamento autenticado A/B real (KA-015); migration/backfill real (KA-043); sandbox financeiro/callback (KA-049); Push do perfil afetado (KA-059); entrega crítica/recibos (KA-060/061); integração navegador/API/schema da release em DEV (KA-067). O gate operacional de acesso restrito, backup e recuperação impede a publicação autônoma.

Próxima ação: executar o [plano de release controlada](RELEASE_DEV_CONTROLADA.md) com acesso DEV tecnicamente restrito, ou autorização específica para intervenção delimitada via root, após revisão do legado, backup e ensaio de recuperação. Depois homologar QA sandbox/tenants/comunicação e encerrar os P1 com evidência da mesma release. Teste dinâmico de startup permanece uma tarefa própria. **Não liberar os demais painéis antes desses gates.**


## Execução seguinte — preparação controlada e auditoria efetiva do deploy (22/10/2026)

A release anterior foi conferida: API fc1e6da e Web 5c7bf8c, develop, árvores limpas no início. Fetch somente leitura confirmou origin/develop em b1cc220 e 4d86829, sem commits remotos divergentes (0 recebidos; 4/2 locais à frente antes desta preparação). Todos os hashes do candidato testado coincidem. Não foram recriados commits, reexecutadas baterias integrais sem motivo ou alterados código de produto, dependências e migration nesta execução.

**Novo gate P1-OPS-01 comprovado:** existe SSH nos dois usuários DEV, mas /etc/sudoers.d/cloudpanel concede clpctlWrapper a ALL; o wrapper encaminha comandos a clp, e clp possui sudo ALL NOPASSWD. Os paths comuns negam acesso direto aos checkouts PROD e configurações críticas, mas essa regra administrativa impede comprovar o isolamento. Nenhum clpctl, sudo de escrita ou exploração foi executado. O usuário exato dos secrets CI não pôde ser confirmado: logs mascarados não contêm id/UID explícito. Não foi assumido que CI usa root nem que usa a identidade DEV correta.

Os últimos runs GitHub de push foram confirmados em modo somente leitura: API 38812563493 e Web 38646549731, ambos success nos commits remotos antigos. O workflow é in-place, usa npm ci, permite cancelamento de execução e não tem backup/restore/gates de testes; a API migra antes do build. Um erro posterior à migration pode deixar schema novo com código antigo. PM2_HOME e UID não são validados pelo script; API e Web possuem grupos de concorrência independentes, sem promoção de um par de commits. Nenhuma recuperação automática foi encontrada nesses scripts. Foi identificado o postinstall conhecido prisma skills sync; não foi executado como ensaio de pipeline.

**Preparação entregue:** [intervenção administrativa](release-controlada/INTERVENCAO_ADMINISTRATIVA.md), sudoers específico DEV, comandos SSH forçados root-owned, chaves públicas com restrict/command, role SQL dedicada SELECT-only, fragmento HBA limitado à nova role, consulta única de classificação do backfill e workflow manual de preflight proposto fora de .github/workflows. O gate proposto só permite inspeção; ativação/deploy segue deliberadamente indisponível até aprovar acesso, legado e backup. Nenhum desses arquivos foi instalado na VPS.

O classificador SELECT-only foi confrontado com os 24 casos de backfill em PostgreSQL 16.15 nativo, em transação READ ONLY, inclusive rollback de ambiguidade e contagem dos direitos inferidos. A role proposta foi testada no cluster efêmero: SELECT permitido nas tabelas necessárias, INSERT/UPDATE/DELETE/CREATE/SET ROLE e leitura de User negados por ACL mesmo após desativar o default read_only. Oito testes Python verificaram negação de comandos/identidades e de arquivos inseguros, conexão/SQL fixos e descarte do ambiente privado herdado. Visudo da proposta, lint e typecheck passaram. Os resultados integrais anteriores continuam aplicáveis ao código de produto; os testes específicos novos estão em [resumo](evidencias/2026-10-22-release-controlada/resumo-execucao.json).

**Legado DEV real NÃO classificado nesta execução. Backup DEV NÃO criado/verificado. Recuperação de backup real NÃO ensaiada.** A regra atual exige acesso tecnicamente restrito para a consulta; não foi contornada usando root/credenciais de aplicação com escrita e BEGIN READ ONLY. O resultado anterior sobre tabelas ausentes permanece evidência histórica, não uma consulta repetida nesta execução. O plano de backup/restore considera schema, owners/ACL, artefatos, dados posteriores e funções comerciais; comandos foram preparados, sem execução remota.

As leituras de processos e HTTP confirmaram os quatro endpoints 200 e os PIDs/horários de início anteriores preservados. Não houve mutação remota, mensagem/cobrança, worker manual, alteração de SSH/sudoers/systemd, backup, migration, push ou deploy. Login/tenants/ciclo financeiro/comunicação não foram apresentados como homologação da candidata ausente em DEV. BUG-01 continua aberto e foi solicitado o identificador QA/perfil afetado, sem pedir credenciais.

**Decisão permanece SUPER ADMIN BLOQUEADO.** Próxima autorização necessária: intervenção administrativa estritamente delimitada nos arquivos preparados para retirar o caminho CloudPanel apenas das identidades DEV e prover o comando fixo de auditoria. Depois classificar o legado, criar/restaurar backup protegido e revisar a ativação antes de qualquer publicação. Essa necessidade vem das Fases 3–5 da tarefa atual. Os demais painéis não foram iniciados.
