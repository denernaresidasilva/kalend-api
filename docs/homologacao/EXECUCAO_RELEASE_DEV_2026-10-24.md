# Execução autorizada da release DEV — 24/10/2026

## Resultado efetivo

**BLOQUEADO no primeiro gate, sem push e sem mudanças administrativas remotas.**
A autorização do proprietário foi recebida. O impedimento é capacidade administrativa
GitHub indisponível neste ambiente, não falta de autorização.

## Evidências desta execução

- API develop: `5f582740bf814f083aa97b7a90e29c48d6918c1f`.
  Candidata de aplicação `db182667ca565bdb18370dc1c209d129e6e139a0`;
  commit posterior apenas operacional/documental. Correção de produto anterior
  `ff1865537f8633d661b47f76e9864f3ec4a9cbc6` e implementação financeira
  `6475fe8` preservadas.
- Web develop: `d1b549d4ec4072741f5b84420e279c5c4226413e`.
  Candidata de aplicação `5c7bf8c792050cb9ed9d69a4dd73c2062bc5f326`;
  commit posterior somente workflow. Working tree Web limpa; alterações API
  anteriores preservadas. Manifesto operacional SHA256 conferido.
- GitHub develop API: `b1cc220aafcb1f2fef97c026150795fcd5c88906`.
- GitHub develop Web: `4d86829b81737189503eb8b1859477e708dcdb12`.
- Todos os runs retornados consultados: API 29/29; Web 22/22; nenhum não concluído
  no instante da consulta. IDs de workflow nos runs: API `375472066`, Web `375448719`.
- Arquivos remotos `.github/workflows/deploy-dev.yml` lidos em develop:
  ambos têm gatilho push, SSH e PM2; API também tem `migrate deploy`.
  Isso prova conteúdo perigoso para um push prematuro, não comprova o estado
  enabled/disabled do workflow.
- Conector GitHub oferece consultas de runs/arquivos/branches, mas não operação
  de disable de workflow. GET `/actions/workflows` e `/hooks` foi recusado com
  `INVALID_ARGUMENT`, endpoint não permitido pelo conector. Nenhuma mutação tentada
  por endpoint improvisado. Não há `gh`, arquivo de autenticação gh, credencial
  helper Git ou variável GH_TOKEN/GITHUB_TOKEN configurados no terminal.
  Não foram procurados segredos em backups ou arquivos privados da VPS.
- SSH de leitura confirmou `root` em `srv1119527`; horário remoto observado
  `2026-10-24T09:20:49Z`. Espaço `/root`: 61.625.416 KiB disponíveis, 39% utilizado.
- Web PROD, health API PROD, Web DEV e health API DEV retornaram HTTP 200.
- PM2 PROD: PIDs 1299/1318; frontend PROD npm 1921 e Next 2461.
  PM2 DEV: 2465796/2465893; frontend npm 2465810 e Next 2465827;
  API DEV Node 2465910. PIDs coincidem com os registros anteriores disponíveis.
- Nginx, PostgreSQL 16-main, Redis e Docker ativos; PIDs 1230/1067/788/1140.
  Nenhum start/stop/restart/reload executado. Evolution não foi acionada.
- Consulta `BEGIN READ ONLY` exclusivamente em `kalend_dev`: 7 Subscriptions,
  5 Payments; migration alvo não concluída no ledger; tabelas PaymentEvidence e
  SubscriptionEntitlement ausentes. Consulta administrativa somente leitura;
  nenhuma escrita SQL, migration ou teste financeiro foi executado.
- Identidade Linux migradora e configuração do fence ainda ausentes.
  Isolamento efetivo para a nova release não está comprovado.

## Operações não executadas por dependência do gate inicial

Sem desabilitação comprovada dos gatilhos e inventário de consumidores não foi
feito push, manutenção DEV, parada de workers/apps, provisionamento de contas/roles,
backup atualizado, reclassificação financeira, restore, migration ou deploy.
Nenhuma fixture, pagamento ou mensagem real foi criado. Nenhuma configuração VPS
foi modificada. A ausência de testes de jornada da candidata é explícita.

## Matriz de homologação

As 72 linhas permanecem: 52 APROVADO LOCALMENTE, 12 PARCIAL, 6 BLOQUEADO,
2 NÃO TESTADO. Nenhuma aprovação DEV real concedida à candidata nesta execução.
Os números históricos de testes financeiros não foram reapresentados como novos.
Nenhum P0 novo identificado; os gates operacionais de CI/CD e isolamento continuam
abertos. Não foi recontado o inventário completo de P1 funcionais.

## Desbloqueio necessário para retomar a execução já autorizada

Disponibilizar mecanismo GitHub autenticado capaz de administrar Actions dos dois
repositórios e inventariar webhooks/Apps/CI externo, ou fornecer evidência operacional
atual da suspensão específica dos workflows e controle dos consumidores envolvidos.
Não é necessária nova autorização para o fluxo já concedido. Não enviar tokens na
conversa. Com esse gate comprovado, retomar o procedimento existente no isolamento
DEV; backup/restauração/legado atualizados precedem qualquer DDL e ativação.

As alterações locais que neutralizam os workflows NÃO suspendem seus equivalentes
remotos. Não usar push para testar, não substituir o disable por alteração remota
prematura do próprio YAML e não usar root para contornar o gate GitHub.
