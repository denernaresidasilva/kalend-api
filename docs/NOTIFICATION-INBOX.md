# Central de notificações — Fase 4.3, Bloco 3

Histórico pessoal persistido, separado dos canais de entrega. Contratos: GET /notifications (filter all/unread/read, limit 1–20, cursor opaco); GET /notifications/unread-count; POST /notifications/:id/read; POST /notifications/read-all; GET/PUT /notifications/preferences (inSystemEnabled boolean). Mutações de leitura aceitam apenas corpo {}.

AuthGuard valida cookies/sessão e origem de mutações. User e empresa vêm da sessão. Company requer membership ativo e empresa ativa; nenhum role/companyId/userId enviado pelo navegador autoriza acesso. Globais são próprias; Super Admin não recebe acesso à caixa de terceiros. Consultas/mutações excluem expiradas pelo horário do banco. Respostas de lista/count/read incluem serverNow e companyId do contexto. Ações usam allowlist de rotas de Minha conta, sem destinos externos ou query strings.

Migration: prisma/migrations/20261002120000_notification_inbox/migration.sql. Notification possui createdAt UTC do banco e expiresAt GENERATED ALWAYS AS (createdAt + INTERVAL '168 hours') STORED. Não substituir esta coluna gerada por expiresAt calculado na aplicação. Prisma usa dbgenerated() para representar a geração nativa. ReadAt, FK user/company, idempotência por user/sourceKey, índices e NotificationPreference são persistidos.

NotificationsService.ingest consome a outbox real com progresso separado notificationProcessedAt; até 100 eventos, transação/SKIP LOCKED. Eventos comerciais conservam destinatários OWNER ativos, segurança é pessoal para qualquer usuário ativo. Conteúdo em português não depende de templates/provedores/Push. Não há endpoint público para publicar para user/company arbitrários. Tipos são strings extensíveis; novos eventos necessitam produtor autorizado e política de destinatários.

Worker ingere antes da expansão de entregas; expansão exige notificationProcessedAt para não entregar antes do histórico entre processos concorrentes. Preferência inSystemEnabled=false impede novo histórico, mantém registros até expiração e não altera consentimento independente de Push. Eventos já consumidos não recriam registros após exclusão.

Scheduler existente executa cleanup físico com DELETE de até 1000 expiradas/SKIP LOCKED, antes de reconciliação e ingestão. Não existe limpeza no frontend, GET ou temporizador de navegador. O padrão do projeto é job de uma execução sob timer externo supervisionado. Confirmar COMMUNICATION_SCHEDULER_ENABLED=true e COMMUNICATION_WORKER_ENABLED=true e cadência (um minuto sugerido). Monitorar backlog; lotes maiores exigem invocações sucessivas. Exclusão física periódica; indisponibilidade após expiração é imediata no backend. Nenhum timer DEV/deploy foi executado nesta implementação.

Comandos corrigidos para dist/communication/worker.js e dist/communication/scheduler.js, saída real do build. Payload Push somente adiciona destino fixo /conta/notificacoes; nenhum canal novo, credencial ou provedor foi criado.

Validação local: npm test (483 testes); npm run test:e2e (116); npm run lint; npm run build; git diff --check. Teste reproduzível test/support/validate-notification-inbox.mjs: PostgreSQL 16 isolado em 127.0.0.1:55443, usuário fixture, banco novo kalend_notifications_disposable; recusa reuso e remove somente banco criado. Compilar antes de executar. Não usa DATABASE_URL para escolher alvo. 60 verificações reais de migrations/HTTP/autorização/roles/isolamento/paginação/expiração/scheduler/worker/ingestão concorrente. Push externo real e homologação DEV permanecem pendentes.

Nenhum commit, push, deploy ou migration aplicada a banco existente. A documentação completa e o inventário frontend ficam em kalend-web/docs/phase-4.3.md.
