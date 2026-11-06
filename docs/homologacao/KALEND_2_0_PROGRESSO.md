# KALEND 2.0 — progresso

Base confirmada em 06/11/2026: API `21f077e`, Web `193fbb1`, develop igual ao remoto. Arquivos locais anteriores preservados. PROD/main fora do escopo.

| Fase | Módulo | Estado |
|---|---|---|
| 1 | Lista de espera inteligente | IMPLEMENTADA LOCALMENTE |
| 2 | Confirmação, comparecimento e sinal | NÃO INICIADA |
| 3 | Assistente IA WhatsApp | NÃO INICIADA |
| 4 | Pacotes e assinaturas de clientes | NÃO INICIADA |
| 5 | Cartão-presente | NÃO INICIADA |
| 6 | Estoque | NÃO INICIADA |
| 7 | Inteligência do negócio | NÃO INICIADA |
| 8 | Atribuição de campanhas | NÃO INICIADA |
| 9 | Múltiplas unidades | NÃO INICIADA |
| 10 | Widget de agendamento | NÃO INICIADA |
| 11 | Anamnese e documentos | NÃO INICIADA |
| 12 | Avaliações | NÃO INICIADA |
| 13 | Recursos compartilhados | NÃO INICIADA |
| 14 | Evolução PWA | NÃO INICIADA |
| 15 | Monetização por plano | NÃO INICIADA |
| 16 | Experiência visual | NÃO INICIADA |
| 17 | Testes integrados | EM DESENVOLVIMENTO |
| 18 | Git e publicação | EM DESENVOLVIMENTO |
| 19 | Organização da execução | EM DESENVOLVIMENTO |
| 20 | Relatórios | EM DESENVOLVIMENTO |

Os módulos operacionais anteriores permanecem concluídos; os estados acima referem-se somente às expansões 2.0. Compilação não equivale a homologação. Integrações externas sem credenciais/evidências serão registradas como DEPENDÊNCIA EXTERNA.

## Fase 1

Em implementação: cadastro público e autenticado, preferências de serviço/profissional/datas/horários, prioridade FIFO, oportunidades temporárias sem reserva exclusiva, conversão via agenda existente, consentimento revalidado, indicadores e cancelamento. Templates desativados por padrão. Envio externo não homologado.

### Implementação local da fase 1

- Models: WaitlistSettings, WaitlistEntry e WaitlistOpportunity; migration aditiva `20261106120000_intelligent_waitlist`, FKs compostas de tenant, unicidade de oferta ativa por entrada, limites de prazo e status.
- Endpoints públicos: POST `/public/booking/:slug/waitlist`, GET `.../mine`, POST `.../:id/cancel`; autenticação exigida para consulta/cancelamento e conversão. Contatos de cliente ativado não podem ser usados por terceiros.
- Endpoints do estabelecimento: GET `/booking/waitlist`, GET/POST `.../settings`, POST `.../match`. OWNER/ADMIN configuram; recepção consulta; profissional/contador sem acesso à lista de clientes. POST `/booking/requests/:id/cancel` exige operador autorizado e cancelamento prévio de comanda existente.
- Conversão: `/public/booking/:slug/requests` recebe `waitlistOpportunityId`; valida cliente, serviço, profissional, data, expiração e disponibilidade na transação existente. Confirmação registra conversão e pode encerrar a espera compatível.
- Outbox: evento OP_WAITLIST_AVAILABLE, textos por canal desativados inicialmente, link com ID não secreto e autenticação do destinatário; validado novamente antes de envio. Scheduler/worker existentes buscam oportunidades; execução manual disponível ao proprietário. Sem reserva exclusiva ou promessa de entrega. Cadastro não ativado é mantido, com orientação para ativação/consentimento.
- Prioridade FIFO entre entradas compatíveis; busca limitada às próximas 14 datas, até 100 entradas por empresa e 200 consultas de agenda/500 candidatos por lote, no máximo 50 empresas. Os limites de lote não representam homologação de escala; otimização/paginação por cursor permanece necessária para grandes volumes.
- Testes: regressão API (945 aprovações antes dos dois novos casos finais), 33 casos PostgreSQL nativo, 411 Web, builds e lint. Resultado final e DEV serão anexados após publicação, incluindo screenshots.
- Recuperação: backup DEV `booking-release-backup-Vil0DM` restaurado em cluster privado (56 tabelas, 28 migrations, 5 PaymentEvidence); alvo da migration confirmado como kalend_dev/kalend_dev_migrator. Nenhuma mudança em PROD/main ou controles administrativos.
