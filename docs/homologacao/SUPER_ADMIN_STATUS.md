# Super Admin KALEND — acompanhamento de homologação

Atualizado em 24/10/2026. **SUPER ADMIN BLOQUEADO para homologação definitiva.** API a49f6a5 e Web c4f84d5 publicadas; migration aplicada e verificada. Falta homologação autenticada com identidades QA, não novo deploy.

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


## Revisão administrativa final — sem acesso à VPS

Plano original requereu correções. A revisão restringiu a fase A à nova identidade auditora, preservando usuários/serviços CloudPanel existentes. O inventário completo de dependências do wrapper permanece obrigatório antes da fase B; o arquivo local não permite identificar todos os consumidores reais e nenhuma completude foi presumida. Ver [procedimento final](release-controlada/INTERVENCAO_ADMINISTRATIVA.md) e [inventário](release-controlada/DEPENDENCIAS_CLOUDPANEL.md).

Corrigidos: chave central fora de home gravável; home nova root-owned com shell sem rc de login; fragmento SSH somente do auditor; diretiva inválida PermitUserEnvironment removida de Match e tratada como precondição global; validação de symlinks/ancestrais; caminhos PostgreSQL 16 fixos e ambiente sanitizado; role transacional com guard de banco, NOINHERIT, limite de conexões e row_security=off para falhar em RLS parcial. Instalação por stdin evita tentar ler um staging /root como postgres; pais compartilhados não recebem chmod/chown. Sudoers foi dividido em auditor novo e contas DEV condicionadas. Nenhuma regra global clp/ALL é retirada.

Backup foi revisto para preservar owner/ACL no arquivo original, manifesto do mesmo snapshot, restore completo em cluster privado sem egress, destino novo e NOSUPERUSER, sem --create/--clean. Método validado com dados sintéticos: 29 tabelas iguais, evidências e constraints preservadas; dump recusou RLS impeditiva. Isso NÃO comprova backup real de DEV.

Testes locais desta revisão: 10 Python de comandos forçados; 42 nativos com conexões NOSUPERUSER após ajuste do runner (bootstrap de initdb apenas para provisionamento, NOLOGIN antes dos testes); caso de role novamente validado com rejeição de banco errado; visudo de ambos os fragmentos; sshd -t/-T preservando seis contextos não alvo no modelo local; HBA peer/outro banco/TCP com conexão não alvo e PID preservados; dump/restore sintético; lint/typecheck aprovados. Não se repetiu auditoria funcional completa, build ou suítes Web/API sem necessidade. Todos os resultados são locais e o servidor real precisa dos pré-checks do plano.

Preparação da fase A pronta para revisão/autorização administrativa específica; fase B, backup real, classificação real, publicação e homologação continuam condicionados aos gates. Não houve SSH, alteração remota, migration real, commit, push ou deploy nesta revisão. Código de produto, dependências, main, PROD e outros sistemas preservados. Os 72 estados funcionais não foram promovidos.


## Correção local do pacote auditor — 23/10/2026

Corrigida a chave pública central para root:kalend_dev_audit 0640, grupo exclusivo,
com diretório root:root 0755. Substituída a dependência de getfacl por lstat/listxattr
com recusa de qualquer ACL/capability e de erros de consulta; symlinks e ancestrais
inseguros bloqueiam. Ver procedimento revisado e evidências em
[evidencias/2026-10-23-pacote-auditor/resumo.json](evidencias/2026-10-23-pacote-auditor/resumo.json).
A recuperação administrativa real NÃO foi comprovada. Pré-checks operacionais e
sshd/sudo/HBA efetivos continuam obrigatórios imediatamente antes da instalação.
Contas DEV com caminho CloudPanel e proprietário SQL kalend compartilhado entre
DEV/PROD continuam riscos separados; esta correção não modifica essas identidades.
Nenhum acesso/intervenção VPS, push, deploy ou migration real nesta execução.
Os estados funcionais dos 72 grupos e os bloqueios de homologação permanecem.


## Auditoria financeira real e backup recuperável — 23/10/2026

**Concluídos dois gates antes pendentes:** classificação REAL de kalend_dev e
backup consistente com restauração integral comprovada. Evidências sanitizadas:
[evidencias/2026-10-23-financeiro-real/resumo.json](evidencias/2026-10-23-financeiro-real/resumo.json).

Snapshot 00000004-00004F07-1, coletado em 2026-10-23T20:06:23.334833+00:00: 7 assinaturas e 5 pagamentos.
1 assinatura com direito pago a importar; 6 sem direito comprovado a importar.
1 pagamento elegível; 4 não aprovados sem prova. Zero classificações ambíguas,
zero reviews e guard de backfill não bloquearia. Nenhum grant administrativo
inferido; nenhum estorno/refund/duplicidade sinalizado. Não se concede acesso aos
registros sem prova. A validade da classificação é do snapshot, não permanente.

Backup: /root/kalend-dev-finance-20261023-ze8nv5eg/kalend_dev.dump (321916 bytes), privado 0600 sob 0700.
SHA256: c6be1c513457995495a236ef54230e0163e33d2faacaef4df71c295505da6c09.
Manifesto, classificador e dump usaram o MESMO snapshot REPEATABLE READ READ ONLY.
SQL source: proprietário existente kalend, NOSUPERUSER via peer, -d kalend_dev
explícito. Não se criaram roles nem se alteraram permissões. Essa identidade tem
capacidade ampla e não passa a ser credencial isolada de CI/deploy.

Restore local de dados reais, fora do Git e dentro de sandbox sem rede/sem paths
HOME/projeto/SSH/sockets reais: PostgreSQL 16.15, NOSUPERUSER, 27 tabelas com todas
as contagens/fingerprints iguais, 53 constraints, 84 índices, funções e ledger
iguais; 24 FKs sem órfãos. Sem sequences. Owner/ACL preservados no dump original,
owner mapeado apenas no teste isolado; cluster local encerrado. A primeira tentativa
falhou antes de restore por mount /bin ausente; nova tentativa local corrigida
aprovou, com logs privados preservados.

18 migrations aplicadas coincidem com hashes locais; migration financeira pendente,
PaymentEvidence/SubscriptionEntitlement ausentes. **Nenhuma migration foi aplicada**
no DEV ou na cópia nesta tarefa. Modelos/classificador/migration foram confrontados;
o ensaio de DDL/locks da cópia e a autorização operacional continuam pendentes.
A migration não está liberada para execução automática pelo pipeline atual.

A autorização desta tarefa permitiu APENAS arquivos novos no diretório privado
remoto de backup/evidências. Nenhum dado comercial foi alterado; nenhuma configuração,
conta, role, serviço, timer ou outro sistema foi modificado. Não houve push/deploy.
Não se repetiram suites funcionais financeiras já aprovadas. Os bloqueios de acesso
CI/release, migration autorizada e jornadas reais da candidata permanecem.


## Ensaio final sobre cópia real — 23/10/2026

**Migration tecnicamente APTA para release DEV controlada; publicação operacional
continua BLOQUEADA.** Ver [plano final](RELEASE_PAYMENTEVIDENCE_CONTROLADA.md) e
[evidências](evidencias/2026-10-23-migration-real-copy/resumo.json).

Prisma aplicou a migration em clone fiel do snapshot privado, NOSUPERUSER, sem rede
externa/apps/workers. Ledger passou de 18 para 19, checksum correto; segunda execução
sem alterações. Schema: 27 -> 29 tabelas, 53 -> 69 constraints, 84 -> 92 índices,
zero inválidos. Dados das 26 tabelas antigas de aplicação e 18 entradas originais
do ledger preservados por fingerprints. Backfill: 1 PaymentEvidence APPLIED,
1 entitlement PAYMENT, 6 assinaturas sem direito pago, 0 ADMIN_GRANT inventado.

Wall local Prisma ~0,65s, SQL separado ~31ms; não é estimativa de duração DEV.
Locks existentes ShareRowExclusive bloquearam DML enquanto leitura simples passou.
Timeouts 55P03/57014 e cancelamento pré-COMMIT reverteram dados/DDL/funções; retries
após rollback comprovado passaram. Caso Prisma real deixou ledger falhado e P3009;
resolve --rolled-back só foi usado NO SANDBOX após comprovar rollback. Janela DEV
controlada é necessária, sem API antiga processando pagamentos após schema novo.

**SA-08 P1 corrigido localmente:** cadastro inicial concorrente de webhook podia
lançar P2002 antes do retry transacional. Registro agora usa retry limitado existente,
sem repetir chamadas de provedor. Commit ff1865537f8633d661b47f76e9864f3ec4a9cbc6.
Três regressões novas; 881/881 unitários API e 251/251 E2E atuais; build/lint/typecheck
e Prisma validate aprovados. 11 grupos dirigidos com serviços candidatos no schema
migrado passaram (GRACE, estornos/refunds, grant/revogação, recuperação, cancelamento,
tenant e concorrência). Sem bootstrap da aplicação, HTTP real ou provedor externo.
Resultados Web/Playwright seguem históricos; não houve mudança Web.

Falhas de harness/fixtures e primeira execução unitária com URL inerte incompatível
foram registradas; corrigiu-se o ambiente/fixture, não o guard ou regra comercial.
Migration SQL/modelo não foram alterados para obter aprovação. Sem conexão remota,
migration real, push, deploy, alteração PROD ou outros sistemas nesta tarefa.

Restam isolamento CloudPanel/runtime e SQL proprietário DEV/PROD, pipeline automático
inseguro, recuperação/janela/autorização e revalidação do snapshot antes do DDL real.
Não instalar auditor como etapa artificial para repetir evidências já obtidas.


## Preparação operacional executável — 23/10/2026

Comparadas A/B: escolhida A delimitada, seguida de publicação supervisionada sem
SSH de CI. B não elimina o risco do runtime sob usuários com sudo CloudPanel ou
da credencial SQL legada. [Procedimento único](operacao-dev/PROCEDIMENTO_UNICO.md)
e [evidências](evidencias/2026-10-23-operacao-dev/resumo.json).

Novo controle necessário: API DEV ainda usa role kalend compartilhada; trocar env
não revoga a credencial antiga. Proposta testada combina deny sudo específico,
roles DEV/peer, rejeição HBA e fence TCP5432 por UID/sub-UID, preservando PROD.
Sub-UIDs DEV existem; não podem ser ignorados. nft instalado e UFW ativo; ordem e
preservação da tabela dedicada são gates reais antes de liberar execução.

Workflows dos dois repositórios convertidos SOMENTE LOCALMENTE em verificadores
manuais sem SSH/secrets/deploy/migration. Remotos permanecem nos commits antigos;
Settings/Actions e consumidores externos devem ser pausados por administrador.
Main sem workflows e fora do escopo; não depender do despacho manual fora da default
branch. Identidade CI não recebe acesso VPS nesta opção. Build/hooks como conta
sem role SQL; Prisma como migrador não root/NOSUPERUSER; promoção e PM2 nos UIDs DEV.

18 grupos unitários e 16 verificações nativas de rede/SQL passaram; sem repetir a
bateria financeira. Gates false/unknown bloqueiam; falhas de acesso, migration,
inicialização/health e promoção não restauram DB ou iniciam API antiga automaticamente.
Nenhuma configuração/conta/role/timer/serviço remoto foi alterado, sem push/deploy.
O pacote permite revisão de uma intervenção delimitada; isolamento operacional
AINDA NÃO APROVADO enquanto não instalado/verificado e inventários aceitos.


## Execução autorizada — gate inicial em 24/10/2026

Autorização recebida; execução interrompida no gate de controle remoto do GitHub.
Sem capacidade disponível para desabilitar workflows nem inventariar webhooks/Apps,
não houve push, alteração administrativa VPS, manutenção, migration ou deploy.
Leituras confirmaram os quatro HTTP 200 e, em kalend_dev, 7 assinaturas/5 pagamentos,
migration e tabelas financeiras novas ainda ausentes. Contagem não substitui
reclassificação. Os 72 requisitos conservam 52 locais, 12 parciais, 6 bloqueados e
2 não testados; nenhuma aprovação funcional DEV foi acrescentada.
Evidências, limites do conector e retomada: [execução 24/10](EXECUCAO_RELEASE_DEV_2026-10-24.md).


## Fluxo Actions existente — execução de 24/10/2026

Workflows remotos comparados aos últimos deploys bem-sucedidos: iguais, nenhum run
pendente. Nenhum workflow alterado/desativado nesta execução. Bloqueio confirmado:
API .env aponta a kalend_dev mas usa role kalend também proprietária de PROD;
Prisma lê DATABASE_URL sem guard independente no job. Contas DEV continuam com
sudo clpctlWrapper e clp com ALL; identidade SSH CI permanece mascarada nos logs.
Não houve push/deploy/migration. Backup DEV atualizado em snapshot READ ONLY,
classificador reexecutado (7 assinaturas/5 pagamentos; 1 direito legítimo, 6 sem
direito importável, nenhum grant inferido/ambiguidade). Restore nativo isolado
aprovado: 27 tabelas por contagem/fingerprint, 53 constraints, 84 índices, 24 FKs,
zero órfãos. Esses resultados não homologam a candidata ainda não publicada.
Evidências: [execução Actions existente](EXECUCAO_ACTIONS_EXISTENTE_2026-10-24.json).
Os 72 requisitos mantêm os estados; HTTP 200 e backup não promovem testes funcionais.


## Homologação real pós-publicação — 24/10/2026

12 testes públicos + 15 de proteção anônima passaram em Chromium desktop/tablet/mobile.
Nenhuma credencial QA encontrada nos locais verificados; inventário READ ONLY encontrou
zero usuários QA/Super Admin QA/Owner QA. Não usar conta administrativa real. Preparador
local de novas identidades passou em três testes e salvou arquivo privado 0700/0600;
nenhum registro provisionado. SMTP está em PRODUCTION, portanto não houve teste de envio.
PagBank SANDBOX configurado não significa checkout exercitado. Nenhuma cobrança/mensagem.
KA-043 aprovado em DEV real; jornadas de login/tenant/financeiro/comunicação seguem
bloqueadas. Gateways serão revisados somente após homologação crítica. Evidência: evidencias/2026-10-24-homologacao-real/resumo.json.
