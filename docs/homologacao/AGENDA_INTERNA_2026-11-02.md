# Continuação operacional — agenda interna

Estado pré-publicação, 02/11/2026. Preservados os commits de núcleo API ca6f0dc e Web c27385b e todos os arquivos locais anteriores. Os arquivos históricos não rastreados e caches Python não fazem parte desta entrega.

## Implementado

Agenda diária `GET /booking/agenda?date=YYYY-MM-DD`, somente itens CONFIRMED da empresa selecionada, com limites de dia calculados no fuso da empresa. OWNER/ADMIN/RECEPTIONIST veem a agenda da empresa; PROFESSIONAL recebe somente seus próprios itens. Inbox profissional também filtra itens de pedidos compartilhados e não retorna contato do cliente. A interface atualiza após aprovação e consulta mudanças a cada 15 segundos; SSE e ativação de identidade do cliente permanecem na próxima fase.

Aceitação revalida horário futuro, profissional/membership ativo e disponibilidade vigente; repete a transação completa em conflitos PostgreSQL recuperáveis. Rejeição libera o intervalo. Corrigidos dois defeitos comprovados no PostgreSQL: campos companyId redundantes nas relações aninhadas Prisma e desserialização de void do advisory lock. Não foram removidas constraints ou relaxados os locks.

Workflows preservam gatilho develop e usuários/diretórios DEV. Atualização do checkout remoto usa merge --ff-only em lugar do reset destrutivo, conforme instrução do proprietário; divergências e alterações conflitantes interrompem o pipeline.

## Validação local

- PostgreSQL 16.15 real em cluster temporário local, criado/encerrado pelo runner existente: 13/13 casos. Todas as migrations aplicadas no banco descartável. Inclui concorrência de requests, idempotência simultânea, aceitar × recusar e duas aprovações concorrentes após expiração, relações compostas entre empresas, setup inicial, deativação, alteração de disponibilidade e agenda após confirmação.
- API: 921 testes unitários, build e lint aprovados antes do ajuste restrito dos links de notificação; revalidação direcionada acompanha o commit.
- Web: build webpack e TypeScript aprovados; suíte anterior 403/403 e novo teste React de agenda/fuso/resposta obsoleta de tenant aprovado. Lint aprovado.

## Publicação e limites

Preflight SSH confirmou srv1119527 / kalend-api-dev e diretório API DEV; runtime efetivo kalend_dev_runtime em kalend_dev; guard da migration confirmou kalend_dev_migrator sem privilégios compartilhados. Web: kalend-dev e diretório dev.kalend.tech/app. Fetch sem divergência; checkouts remotos sem alterações rastreadas. Backup DEV atualizado sob diretório privado da conta API, restaurado em cluster isolado: 30 tabelas públicas, 21 migrations concluídas e 5 PaymentEvidence. Nenhum serviço global, regra administrativa ou PROD foi alterado. Sudo amplo histórico não é gate cumulativo conforme política vigente.

Este registro não declara homologação DEV antes de Actions e jornadas QA concluírem. As fases seguintes continuam pendentes: atualização em tempo real; cadastro/ativação segura e painel cliente; gestão completa de equipe/serviços; recepção/profissional/proprietário completos; contador; PDV/comandas/caixa/comissões; mensagens e follow-up operacional; permissões/paletas e PWA.

## Resultado DEV da fase de agenda

API 9d7cbf4, Actions 41499239046: sucesso. Web 64baa40, Actions 41499638624: sucesso. Dez casos HTTP reais e dois casos Chromium (390 e 1366 px) aprovados, sem APIs interceptadas. Fixtures exclusivamente novas empresas QA; nenhum envio/cobrança externa. Migration com checksum/ledger conferidos, sete tabelas operacionais presentes; PaymentEvidence preservado. A primeira tentativa browser ocorreu durante o build Web e excedeu o timeout na versão antiga; após conclusão do deploy os dois viewports passaram. Capturas privadas em /tmp. [Evidências sanitizadas](evidencias/2026-11-02-agenda/http-dev.json).
