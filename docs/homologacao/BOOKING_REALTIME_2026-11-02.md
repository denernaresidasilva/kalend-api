# Solicitações em tempo real — 02/11/2026

Implementação SSE por `GET /booking/events`, com autenticação por cookies existentes. Cada alteração de pedido publica `pg_notify` dentro da transação; PostgreSQL só entrega o evento após o commit. Listener dedicado usa a conexão runtime, reconecta após falha e pede ressincronização. Não há dados de cliente, preços ou IDs de pedidos nos eventos do navegador, apenas sinal de atualização.

Empresa, usuário, membership, papel e entitlement são revalidados antes de cada evento/heartbeat. Contexto diferente, revogação ou expiração encerram o stream. Limite de três streams por sessão e duração máxima de 90 segundos; o navegador revalida a sessão antes de reconectar. Profissionais só recebem refresh por pedidos que contenham seu perfil. Polling anterior permanece como recuperação de disponibilidade. Desconexão remove listeners/contadores.

Validação: 6 testes unitários de stream/autorização/cleanup, 14 casos PostgreSQL nativos incluindo NOTIFY real pós-commit, teste React de conexão com cookies e troca de tenant, 405 testes Web; build/lint/tipos aprovados. A homologação SSE em DEV é registrada após a publicação; estes testes locais não a substituem.

Ajustes mobile derivados da captura real: checkbox de dias com dimensões próprias, títulos/data empilhados em telas estreitas, botões com tamanho de toque e rótulos em português. Setup inicial só aparece antes de haver serviços; CRUD completo continua em fase posterior.

DEV aprovado: API c97595c, Actions 41500520503; Web bfb1fca, Actions 41500699812, ambos com sucesso. Quatro casos reais Chromium: três streams autenticados (proprietário/profissional/empresa B), pedido visível sem recarregar em 184 ms, ausência na empresa B e agenda atualizada por aprovação. [Evidência sanitizada](evidencias/2026-11-02-agenda/realtime-dev.json).
