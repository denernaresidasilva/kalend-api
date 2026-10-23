# Ensaio PaymentEvidence sobre cópia real — 23/10/2026

Backup original DEV hash c6be1c513457995495a236ef54230e0163e33d2faacaef4df71c295505da6c09.
Nenhum dado real, dump, resultado de consulta com IDs, segredo ou log bruto neste Git.
Scripts criam cluster NOVO local, sem rede, root/home/SSH/sockets reais não montados,
SQL NOSUPERUSER; provisionamento bootstrap encerrado com NOLOGIN antes dos testes.
Source snapshot restaurado e fingerprints conferidos. Nenhuma conexão remota nesta tarefa.

Prisma migrate deploy aplicou a migration REAL e registrou uma entrada concluída
com checksum correto. Segunda execução sem mudanças. 27 -> 29 tabelas, 53 -> 69
constraints, 84 -> 92 índices; zero inválidos. As 26 tabelas antigas de aplicação
não mudaram; ledger preservou 18 entradas e acrescentou uma. Backfill: 1 evidência
APPLIED, 1 direito PAYMENT, 0 ADMIN_GRANT, 6 assinaturas sem direito pago a importar.
Trial legítimo não é confundido com acesso pago. Nenhum direito fabricado.

Conexões distintas comprovaram waits. Lock timeout 200ms (55P03), statement timeout
200ms (57014) e cancelamento antes de commit reverteram dados, tabelas, tipos, triggers
novos e função substituída. Novas tentativas após rollback passaram. DDL bruto não
é idempotente: repetição rejeitada sem duplicar direitos. Prisma ledger é o guard.
Caso Prisma REAL de timeout: CLI mostrou transação abortada, servidor confirmou
lock timeout, ledger falhado bloqueou retry com P3009. Somente após comprovar rollback
completo executou-se resolve --rolled-back NO SANDBOX; nova aplicação passou.
Não executar resolve cegamente em DEV. Incerteza após perda de conexão deve ser
resolvida por schema/dados/ledger/checksum, sem assumir rollback ou sucesso.

Medições detalhadas no resumo: wall Prisma inclui engine/ledger, SQL separado.
Lock precommit instrumentado com pg_sleep para observação; não é duração natural.
ShareRowExclusive nos objetos existentes bloqueia DML; leituras simples continuaram.
Nenhuma estimativa precisa de DEV é derivada deste hardware/snapshot pequeno.

11 grupos de probe dos serviços candidatos com Prisma real no schema migrado:
backfill e acesso; primeira FAILED/OVERDUE sem GRACE; duplicidade/concorrência;
escopo tenant; refund parcial/integral, suspensão, novo pagamento/reativação;
chargeback; grant explícito e revogação concorrente; GRACE legítimo/bloqueio;
cancelamento; locks multiconexão. Fixtures novas em clone separado, sem workers,
Nest bootstrap ou provedores; não é homologação HTTP/navegador/sandbox em DEV real.

P1 SA-08: concorrência de WebhookEvent.upsert vazio podia gerar P2002 antes do retry.
Corrigido somente o registro com retry limitado já existente. 3 regressões novas;
antes 2 falharam/1 passou, depois passaram; helper + regressões: 13/13.
Regressão geral justificada por essa mudança: 881/881 API, 251/251 E2E; build/lint/
typecheck e Prisma validate aprovados. Web/Playwright não repetidos: sem mudança Web.
A primeira invocação unitária impunha URL inerte incompatível com guard Evolution;
retirada a variável global de testes, sem alterar guard, sem ler .env privado.
Fixtures de ensaio também foram corrigidas ao contrato/enum reais, sem enfraquecer
regras. Falhas e dados brutos ficaram somente em diretórios privados; clusters parados.

Artefato migration tecnicamente apto; publicação continua BLOQUEADA por isolamento
operacional não comprovado, pipeline automático inseguro e autorização/janela ainda
pendentes. Migration, schema e regras financeiras não foram alterados para passar.
