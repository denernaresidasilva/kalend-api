# Comunicação GLOBAL — decisão de arquitetura (29/09/2026)

Escopo exclusivo Kalend → OWNER ativo da empresa; ADMIN não recebe cobrança automaticamente sem delegação explícita futura. Não há comunicação com clientes da agenda.

A chave existente GATEWAY_ENCRYPTION_KEY será reutilizada com AES-256-GCM e AAD `communication:GLOBAL:provider:environment:credentials`. A separação por domínio impede transplantar ciphertext de gateways. Não será criada outra chave mestra. Rotação exige recriptografia dos dois domínios.

Outbox PostgreSQL e execução por CLI de lote separado do HTTP, invocada por scheduler externo. Sem Redis/BullMQ. A captura transacional no banco registra fatos confirmados; nenhum transporte, renderização ou credencial participa de transações financeiras. Erro de canal nunca desfaz pagamento. Como em toda outbox transacional, falha de persistência no próprio banco impede commit; não se promete atomicidade sem persistência.

Tabelas com prefixo GlobalCommunication e scope GLOBAL, sem configuração por companyId. companyId no evento é referência de negócio/destinatário, nunca proprietário da configuração. Futuro TENANT exige tabelas/repositórios/permissões próprios; somente contratos de transporte podem ser reutilizados.

Eventos e entregas são separados: um fato de negócio pode gerar canais independentes. Chaves únicas no fato e em evento+usuário+canal evitam replay. Worker reivindica entregas por atualização condicional. Envio com resultado incerto não tem retry automático; exactly-once externo não é garantido por SMTP/WhatsApp. Retenção de IDs idempotentes deve sobreviver à remoção de conteúdo.

## Auditoria recuperada e modelo

Estado inicial: develop limpa, commit f7bd6f8. Não foi encontrado AGENTS.md aplicável. Antes de editar foram auditados docs existentes, Prisma, autenticação, memberships, planos, trial, subscriptions, pagamentos, gateways, webhooks e entitlements. Estado recuperado após interrupção: package/lock/schema/AppModule alterados e diretórios novos de comunicação/migration/docs; preservados sem reset/checkout. Não existia tabela equivalente, Redis/BullMQ, transport de email nem configuração de app móvel.

Extensão: GlobalCommunicationProvider; GlobalCommunicationTemplate (configuração de evento/canal e conteúdo num só modelo); GlobalCommunicationMetaTemplate (estado remoto); GlobalCommunicationOutbox (fato durável); GlobalCommunicationDelivery (snapshot, estado, tentativas, referência externa); GlobalCommunicationLog (auditoria mínima). Scope enum contém somente GLOBAL. Não há companyId em configuração/template. Environment usa enum existente SANDBOX/PRODUCTION. Status de credencial reutiliza IntegrationStatus. Dados anteriores não são removidos/alterados pela nova migration.

Outbox tem companyId/userId opcionais de referência, não relação com cascata: exclusão posterior de usuário/empresa não apaga chaves idempotentes. Autorização de envio sempre vem das memberships atuais, não desses IDs isolados. OWNER_WELCOME é por empresa/proprietário; eventos financeiros por empresa; SECURITY_PASSWORD_CHANGED é individual, deduplicado entre memberships e só usa variável nome. ADMIN não tem permissão implícita de receber cobrança. Delegação/opt-in de ADMIN é decisão futura, sem inventar equivalência com OWNER.

## Integração com Fase 1

Captura transacional **somente de fatos mínimos**, por triggers em Payment, Subscription, Membership e User. As alterações ficam visíveis ao worker somente após commit. Não há rede, renderização, secret ou dependência de provider no trigger. Código comercial existente não foi reescrito. Rollback financeiro também desfaz o fato; aprovação confirmada não depende do resultado de uma tentativa de comunicação. Falha de persistência do próprio journal não é falha de canal e não é descartada silenciosamente.

| Evento | Origem / chave de negócio |
| --- | --- |
| OWNER_WELCOME | INSERT Membership OWNER ativo; empresa+usuário |
| TRIAL_STARTED | INSERT Subscription TRIALING; subscription id |
| TRIAL_EXPIRING | Scheduler: TRIALING com deadline nos próximos 3 dias; subscription+trialEndsAt, insert idempotente limitado |
| TRIAL_EXPIRED | TRIALING→EXPIRED com trialEndsAt vencido; subscription id; não dispara na conversão antecipada |
| PAYMENT_PENDING | Payment PENDING somente após creationState CREATED; payment id+evento |
| PAYMENT_APPROVED / FAILED / OVERDUE | Transição financeira persistida; payment id+evento |
| SUBSCRIPTION_GRACE_PERIOD | Transição PAST_DUE com graceEndsAt futuro; subscription+evento+transação |
| SUBSCRIPTION_SUSPENDED / CANCELLED | Transição correspondente; subscription+evento+transação |
| SUBSCRIPTION_REACTIVATED | ACTIVE vindo de PAST_DUE/SUSPENDED; subscription+evento+transação |
| SECURITY_PASSWORD_CHANGED | Hash alterado em User; user+transação, sem copiar hash; destinatário precisa OWNER ativo |

Reentrega do webhook financeiro não gera nova transição elegível; pagamento tem chave única evento/payment. Duas assinaturas reativadas em ciclos diferentes podem gerar fatos diferentes: txid_current distingue transições efetivas, não duplicata do mesmo status. UUIDs SQL usam gen_random_uuid(), disponível no PostgreSQL compatível do projeto; confirmar versão na aplicação futura. Não são criados fatos por mero mandato ACTIVE nem pagamento fictício de empresa manual.

Lacunas comprovadas: Payment não possui dueAt contratual para inventar atraso local; OVERDUE depende de provider. ADMIN sem OWNER não recebe esta política inicial. Usuário CLIENT não recebe SECURITY_PASSWORD_CHANGED por este motor global. Não há endpoint de troca de senha novo, mas a captura detecta atualizações reais do hash. Expiração/graça/suspensão dependem de rodar o scheduler financeiro existente, agora invocável pelo runner separado.

## Conteúdo e entrega

EMAIL tem subject/text; HTML é derivado de texto escapado. Evolution tem text próprio. Meta usa id/nome/idioma remoto e parâmetros posicionais mapeados a nomes permitidos. PUSH tem title/text como contrato indisponível. Não existe HTML livre, URL/deep link arbitrária, acesso a objeto interno ou expressão executável.

Variáveis: nome/empresa nos eventos comerciais; trial acrescenta plano/dias_trial/vencimento; pagamentos acrescentam valor. Segurança usa somente nome. Não há link/suporte porque URLs oficiais de comunicação não foram definidas; não inventar endereço. Template com variável não disponível é rejeitado. Valores não são avaliados recursivamente. Saída renderizada limitada a 16.000 caracteres e headers sem CR/LF.

Cada evento/canal tem habilitação independente; sem configuração habilitada não há envio. Políticas/templates são lidos na expansão; snapshots congelam revisão de configuração/template/destinatário para retry. Worker revalida OWNER ativo, contato atual e revisões; mudança invalida snapshot e produz SKIPPED. Falha num telefone não impede email. Um fato expandido sem canal ativo não será reenviado retroativamente ao ligar um canal.

Fluxo: fato commitado → expansão com row lock SKIP LOCKED → entrega PENDING única → claim SENDING fora de qualquer transação financeira → provider → ACCEPTED ou erro classificado → logs. Meta pode avançar para DELIVERED/READ por recibo autenticado. SMTP/Evolution não presumem entrega. Falha ambígua fica UNCERTAIN e não tem retry. Política/execução: [COMMUNICATION-OPERATIONS.md](COMMUNICATION-OPERATIONS.md). Fontes: [COMMUNICATION-PROVIDERS.md](COMMUNICATION-PROVIDERS.md). Ameaças: [COMMUNICATION-SECURITY.md](COMMUNICATION-SECURITY.md).

## Fase 3

GMAIL e PUSH_PENDING passam a adapters reais Gmail API e WEB_PUSH. Delivery ganha targetKey (USER para dados existentes; ID do dispositivo para Push), com idempotência por evento/usuário/canal/dispositivo. A fila e as garantias de quarantine/retry continuam únicas. Consulte [contratos Fase 3](PHASE3-COMMUNICATION.md).
