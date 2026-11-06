# KALEND 2.0 — progresso

Base confirmada em 06/11/2026: API `21f077e`, Web `193fbb1`, develop igual ao remoto. Arquivos locais anteriores preservados. PROD/main fora do escopo.

| Fase | Módulo | Estado |
|---|---|---|
| 1 | Lista de espera inteligente | HOMOLOGADA EM DEV |
| 2 | Confirmação, comparecimento e sinal | PUBLICADA EM DEV |
| 3 | Assistente IA WhatsApp | DEPENDÊNCIA EXTERNA |
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

### Homologação DEV da lista de espera — 06/11/2026

API `2692ccb`, Web `590fa30` e correção mobile `a388ca3`; pushes normais em develop, Actions `42199676885`, `42199952363` e `42201899638` aprovados. Quatro jornadas reais aprovadas: cadastro mobile sem oferta de horário ocupado; cancelamento liberando oportunidade única em duas buscas concorrentes; link autenticado convertendo para solicitação/aprovação/agenda; painel do cliente e indicadores do proprietário. Formulário também verificado aberto em 390px sem overflow. Screenshots privados: `/tmp/kalend2-waitlist-{form-mobile,public-mobile,client-mobile,owner-desktop}.png`. JSON sanitizado anexado ao diretório de evidências. Houve correções do teste para seleção por atributo e múltiplos registros de QA; o parsing do corpo pela automação de navegador foi substituído por leitura pela API autenticada, preservando submissão e mensagem de sucesso reais na interface. Nenhum envio externo foi alegado (somente Outbox/Push QA).

## Fase 2 — implementação em andamento

Confirmação opt-in por canal, antecedência, prazo e até três lembretes; links de capacidade com token aleatório de 256 bits, hash na tabela de convites, expiração e uso idempotente. O link é removido da barra após leitura e usa referrer no-referrer. Respostas: confirmar, pedir reagendamento ou cancelar. Reagendamento efetivo é feito pelo operador autorizado, valida disponibilidade e sobreposição em transação, preserva preço/duração acordados e invalida links antigos. Agendamento com comanda ativa exige tratamento no PDV.

Comparecimento registra conclusões legítimas do PDV, cancelamentos, confirmações, pedidos e mudanças de horário e revisões justificadas; histórico imutável e sem classificação punitiva. O padrão sem resposta preserva agendamento; regra de cancelar exige DELIVERED/READ e nenhuma comanda ativa, caso contrário encaminha para revisão. Configuração atual é relida na transação da regra. Push usa somente caminhos internos explicitamente permitidos; dispositivos externos não homologados nesta etapa.

Sinal antecipado: **DEPENDÊNCIA EXTERNA**. Regras por serviço/profissional em rascunho, fixo/percentual com cálculo em centavos e saldo previsto. Contrato de provedor separado de billing SaaS; ativação/cobrança indisponível até existir gateway do estabelecimento homologado. Nenhum crédito no PDV, pagamento real ou integração externa é afirmado. Homologação de cobrança, confirmação financeira, aplicação no PDV e reembolso do sinal continuam pendentes.

### Fase 2 — resultado local e escopo de publicação

953 testes unitários API, 40 testes PostgreSQL nativo e 412 Web aprovados; builds e lint aprovados. Migration aditiva `20261106130000_booking_confirmations`: BookingConfirmationSettings, BookingConfirmation, BookingConfirmationInvitation, BookingAttendanceEvent, BookingScheduleChange e BookingDepositPolicy; histórico e mudanças de horário com trigger de imutabilidade, FKs por tenant, unicidade de convite/etapa e política padrão de sinal.

Rotas Web: `/confirmar-agendamento` (capacidade temporária, sem dados pessoais ou pagamento), painéis de confirmação/comparecimento/sinal no proprietário e comparecimento na recepção. API: POST `/public/booking-confirmation/{view,respond}`; GET/POST `/booking/confirmations/settings`, POST `.../run-due`, GET `.../customers/:id/history`, POST `.../requests/:id/{review,reschedule}`; GET/POST `/booking/deposit-policies` somente OWNER/ADMIN. Reagendamento/revisão também permitem recepção, com justificativa. Histórico não é exposto a contador ou profissional indiscriminadamente.

Backup antes da publicação: `booking-release-backup-uOsX2X`, restaurado com 59 tabelas/29 migrations/5 PaymentEvidence. A fase completa ainda não está homologada: confirmação/reagendamento aguardam DEV; cobrança e aplicação/reembolso do sinal no PDV dependem de homologação de gateway do estabelecimento. Contrato e rascunhos não representam integração financeira concluída.

### Homologação da parte operacional da fase 2 — 06/11/2026

API `c6121fa`, Web `8418aec`; pushes develop/Actions `42203115311` e `42203311730` aprovados. Quatro jornadas reais DEV aprovadas: confirmação pelo link no celular (token removido da URL e referrer protegido), reagendamento transacional/idempotente invalidando o link anterior, cancelamento protegido pela comanda e histórico, rascunho de sinal que rejeita ativação e não credita pagamento. Screenshots `/tmp/kalend2-confirmation-{mobile,owner-desktop}.png`. Contrato de leitura de token exclusivamente na fixture QA foi corrigido no ensaio; tokens/credenciais não estão nas evidências. Confirmações/reagendamento estão **HOMOLOGADOS EM DEV**; cobrança de sinal continua **DEPENDÊNCIA EXTERNA**. A fase 2 completa não está declarada concluída.

## Fase 3 — contrato local de IA

Implementado localmente: settings isolados por empresa, módulo `ai_assistant` exigido no plano vigente, nome/tom/boas-vindas/informações/horário/limites/retenção; interface de provedor e implementação que recusa operação sem provedor configurado. Nenhuma chave foi criada e não há adaptador remoto habilitado.

Ferramentas autorizadas usam BookingsService e permissões existentes: catálogo público, disponibilidade, informações cadastradas, preparo de link/rascunho para solicitação, consulta de pedidos próprios somente com contexto CLIENT autenticado, encaminhamento para contato humano. Ferramentas não executam SQL recebido, pagamentos, descontos ou confirmação de agenda. A classificação do provedor só seleciona ferramentas; preços/horários são retornados pelo backend. Link de rascunho é revalidado na agenda pública e não reserva horário.

Contrato local de classificação com reserva prévia de franquia/custo, teto por chamada, prazo de 12s, limites diários e por plano, chave idempotente e retenção conservadora da reserva em falha incerta. Não armazena a mensagem original. Provedores de teste existem somente nos testes; produção permanece UNCONFIGURED. Métricas de conversas/atribuição são `null` (não disponíveis), verificações locais têm identificação TOOL_PROBE e custos ausentes não são exibidos como zero.

Models: AiAssistantSettings/AiToolAudit; migration `20261106140000_ai_assistant_contract`. API OWNER/ADMIN: GET/POST `/assistant/settings`, GET `/assistant/dashboard`, POST `/assistant/tools` com limitação de taxa. Nenhum endpoint HTTP expõe execução do provedor. Web: `/conta/configuracoes/inteligencia-artificial`; nova página `/conta/configuracoes/agenda` reutiliza componentes já implementados. Super Admin continua decidindo os direitos pelo PlanFeature existente; preços e planos comerciais não são alterados automaticamente.

**DEPENDÊNCIA EXTERNA / trabalho ainda pendente na fase 3:** adaptador remoto de IA, credenciais e homologação; ingestão de mensagens WhatsApp no assistente, consentimento/opt-out por conversa, entrega de respostas e transferência humana operacional, histórico autorizado/limpeza e atribuição de solicitações/agendamentos. O webhook Evolution atual conserva sua validação por instância e ainda não encaminha mensagens ao assistente. Referência oficial do evento [MESSAGES_UPSERT](https://github.com/evolution-foundation/evolution-docs/blob/main/docs/02-Configuration/Webhooks.md). Contrato e configuração não são atendimento por IA concluído.

Testes locais: 956 unitários API, 43 PostgreSQL nativo (incluindo ferramentas reais, isolamento, direitos de plano, prompt malicioso, quotas e idempotência), 412 Web, build/lint aprovados. DEV do contrato aguarda publicação; não existe homologação remota de IA.

### Publicação do contrato de IA — 06/11/2026

API `7355cf2`, Web `3598ed4`; Actions `42205265176` e `42205668550` aprovados. API DEV validou módulo do plano, ferramentas reais, rejeição de ativação sem provedor, rejeição de SQL/pedidos privados sem autenticação própria e isolamento dos indicadores. Interface móvel identificou overflow nas opções de configuração: correção em homologação, sem declarar o ensaio visual aprovado ainda. Plano exclusivo de QA foi criado sem alterar os planos comerciais, somente na assinatura MANUAL/SANDBOX/TRIALING da empresa `qa-booking-*`, e restaurado em seguida. IA remota e canal WhatsApp continuam pendentes; não há conversas ou custos externos homologados.
