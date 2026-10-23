# Release DEV candidata — procedimento pendente, não executado

Data: 22/10/2026. Repositórios API e Web em develop. Nenhum push foi feito.

## Gate operacional

O acesso SSH observado é root (UID 0). Os workflows usam secrets DEV_SSH_USER/KEY, cujo valor/escopo não foi verificado; nomes de secrets não demonstram isolamento. O workflow API aplica `prisma migrate deploy` antes do build e não exige testes, backup ou aprovação de ambiente. Ambos fazem reset remoto e compilam dentro do diretório em uso. Não há deploy atômico ou recuperação automática comprovada. Push para develop está bloqueado nesta entrega.

Privilégio mínimo: credenciais SSH separadas para kalend-api-dev e kalend-dev; sem sudo amplo, acesso aos diretórios DEV e PM2_HOME próprios; banco/role restrito a kalend_dev, sem privilégios em kalend. Chave CI deve ter comando restrito ou wrapper root-owned que valide serviço/branch/paths e não permita shell arbitrário. Segredos não entram no Git. Alterar acessos/units é intervenção remota separada, não autorizada implicitamente por este documento.

## Sequência exata de preparação

1. Aprovar o par de commits candidatos e seus hashes de árvore; revisar o diff, inclusive os trabalhos financeiros anteriores. Conferir se o remoto tem mudanças posteriores antes de preparar qualquer push (fetch somente leitura remota e sem reset local).
2. Auditar permissões efetivas das duas credenciais CI e do usuário/role PostgreSQL. Comprovar ausência de sudo amplo e acesso a PROD. Sem essa evidência, solicitar intervenção específica ou provisionamento de acesso restrito.
3. Criar um job de validação separado de deploy, com lock/concurrency que não cancele uma migration em execução, actions fixadas por SHA revisado e environment protegido DEV. Não acionar o workflow atual como ensaio. Publicar uma branch sem gatilho de deploy apenas após auditar todos os gatilhos remotos e obter os pré-requisitos; esta tarefa não realizou push.
4. Somente mediante acesso restrito/autorização: inventariar schema e classificar o legado em transação READ ONLY. Reproduzir os casos ambíguos em cópia protegida, sem exportar dados reais para diretório público. A migration deve abortar com ENTITLEMENT_BACKFILL_REQUIRES_REVIEW se houver lacunas; não inventar grants/pagamentos para contornar o guard.
5. Preparar backup consistente somente de kalend_dev, local protegido, hash, tamanho, timestamp e confirmação de restauração em banco isolado. Definir retenção sem apagar backups existentes. Nenhum backup foi criado nesta auditoria.
6. Ensaiar migration em cópia isolada com volumetria equivalente; medir duração e locks. A migration contém DDL/índices, leitura de históricos e alteração de funções/triggers em transação. Os testes pequenos não estimam locks em dados reais. Definir limites de espera/execução na conexão migradora e plano de abortar, sem editar migration já aplicada nem fazer reset.
7. Preparar artefatos de release fora do diretório ativo, Node 24.21.0, dependências de lockfile, Prisma generate e build. Verificar o artefato ESM dist/main.js e comando direto Node; não usar nest start. Não imprimir .env nem copiar secrets para units.
8. Revisar compatibilidade durante a troca: funções SQL novas são usadas por comunicação e o novo código exige as tabelas. Programar uma janela DEV controlada e coordenar somente processos/workers DEV autorizados; não modificar timers ou parar nada nesta fase. Aprovar expressamente eventual indisponibilidade DEV.
9. Aplicar a migration somente após backup/ensaio/aprovação. Ativar os artefatos e reiniciar somente kalend-api-dev e kalend-web-dev no usuário correto, quando autorizado. Validar dumps/startup para não reintroduzir Nest CLI ou Mailpit; não executar pm2 save indiscriminado. Não tocar PROD nem outros serviços.
10. Executar a homologação QA abaixo, registrar commit, IDs de fixture/provedor redigidos, timestamps e resultados. Encerrar a janela apenas com estabilidade e nenhuma regressão nos serviços preservados.

## Homologação após publicação

- Contas QA explícitas Super Admin, OWNER, PROFESSIONAL e CLIENT, tenants A/B descartáveis e isolados. Não reutilizar Companies QA KALEND 4 / QA Billing Lifecycle para reset ou mutações históricas.
- Browser real → API → PostgreSQL: login/refresh/logout/revogação/desativação, CORS/Origin/cookies, negação 401/403, IDOR, seleção cruzada, mutação de valores/assinatura, bloqueio administrativo.
- Contratação sandbox correlacionada: trial/expiração, checkout, pending/approved/failed/overdue, primeira cobrança sem GRACE, renovação com graça legítima, suspensão, recuperação, cancelamento, estorno parcial/integral e callbacks duplicados/fora de ordem. Conferir Payment, Subscription, Entitlement, acesso, receita, auditoria e UI. Não usar cobrança real.
- Comunicação: validar geração → outbox → delivery → worker → aceite → entrega por canal. Destinatários QA allowlisted, sink de e-mail autorizado, instância WhatsApp QA e aparelho controlado. Mailpit desligado não autoriza fallback SMTP real.
- Push BUG-01: perfil afetado autorizado, permissão, origem, SW ativo/controlador, dispositivo, tenant e subscription do próprio usuário; evidência de não reaparecer convite com granted e de recebimento. Não apagar subscriptions de terceiros. Testes sintéticos já passaram e não encerram o incidente real.
- Todos os P0/P1 devem estar encerrados na release; não liberar novos painéis apenas por HTTP 200. Startup dinâmico systemd exige tarefa/autorização própria, sem reboot global.

## Recuperação

Antes da troca: cancelar publicação sem afetar os processos atuais. Se a migration abortar, confirmar rollback transacional e estado de _prisma_migrations antes de nova tentativa; não executar resolve/reset cegamente. Se houve commit da migration, rollback de código não a desfaz e as funções comerciais mudaram. Preferir correção forward validada. Restauração de snapshot requer janela DEV, avaliação de escritas posteriores e autorização específica; não executar SQL destrutivo improvisado. Manter artefatos, dumps seguros e backup protegido. Nenhum rollback de produção faz parte deste plano.


## Evidência operacional adicional de 22/10

SSH dos usuários DEV existe, porém eles herdam sudo via wrapper CloudPanel sem allowlist DEV. A intervenção necessária deixou de ser apenas hipotética: os arquivos e comandos estão em [release-controlada/INTERVENCAO_ADMINISTRATIVA.md](release-controlada/INTERVENCAO_ADMINISTRATIVA.md). Nada foi aplicado. Há uma proposta SELECT-only validada nativamente para classificar o legado sem usar root como atalho. A publicação continua condicionada aos 14 gates; backup/restore real e classificação não foram executados.


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
