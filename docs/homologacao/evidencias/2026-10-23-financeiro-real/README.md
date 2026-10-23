# Auditoria financeira real e backup DEV — 23/10/2026

Fonte REAL: srv1119527, kalend_dev. Nenhuma migration aplicada.
Classificação e fingerprints de todas as tabelas capturados em REPEATABLE READ
READ ONLY; pg_dump -Fc utilizou o MESMO snapshot exportado, mantido aberto até
finalizar o dump. Source original conserva schema, dados, owners/ACL e funções.
Session encerrou com ROLLBACK. Não houve escrita SQL de aplicação.

A autorização atual permite backup e leituras, mas proíbe criar roles/configurações.
Foi usada a identidade SQL EXISTENTE kalend, não superuser, via peer e destino
explícito kalend_dev, sem alteração de privilégios. Ela é proprietária também de
PROD: esse caminho de acesso não foi promovido a identidade isolada de CI/deploy.
As únicas escritas remotas foram arquivos novos no diretório administrativo único
0700; dump e demais arquivos 0600. Não há dados reais neste diretório Git.

7 assinaturas: 1 IMPORT_PAID_RIGHTS; 6 NO_PROVEN_RIGHT_IMPORTED. 5 pagamentos:
1 IMPORT_PAYMENT_EVIDENCE; 4 NOT_APPROVED_NO_PROOF. Zero casos ambíguos, reviews,
refunds ou duplicidades sinalizadas pelo classificador; guard de migration falso.
Isso não aprova acesso pago para os seis registros sem direito, nem homologa
pagamentos/checkout de ponta a ponta. Predição: 1 entitlement pago, 1 evidência,
0 grants administrativos. Números valem para o snapshot identificado no resumo.

Backup privado transferido por SSH para diretório local 0700 fora do repositório;
hashes conferidos. Restaurado por NOSUPERUSER em cluster PostgreSQL 16.15 local
novo, sandbox bwrap sem rede, sem HOME/projeto/chaves/sockets reais e sem apps.
27 tabelas conferidas por contagem e fingerprint de todas as linhas; 53 constraints,
84 índices, funções e ledger idênticos; 24 FKs avaliadas, zero órfãos. Nenhuma
sequence existe no schema fonte. Owner mapeado kalend -> kalend_restore_owner,
ACL original preservada no dump; tabelas fonte sem grants adicionais. Postmaster
local encerrado. A primeira tentativa falhou antes de restore por /bin ausente;
foi corrigido apenas o mount local e usado outro diretório, sem apagar a falha.

18 migrations DEV têm checksums iguais ao repositório; PaymentEvidence e
SubscriptionEntitlement ainda ausentes. Não houve ensaio/aplicação da migration
nesta execução. Restore não é prova de performance/locks da futura migration.

Nenhum serviço/conta/configuração/role remoto foi alterado. Não houve cobrança,
mensagem, worker, seed, reset, push ou deploy. O bloqueio de classificação e
recuperabilidade do backup foi removido para ESTE snapshot. Isolamento operacional,
autorização de schema e homologação da release ainda pendentes.
