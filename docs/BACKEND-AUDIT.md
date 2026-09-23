# Auditoria Kalend API — 23/09/2026

## Escopo e limites

Auditoria estática do backend, schema, duas migrations existentes, controllers, services e testes. Branch `develop`. Nenhum acesso a DEV/produção, nenhum deploy, nenhum `.env` alterado, nenhuma migration aplicada, nenhum commit/push. Prisma fixado em **7.10.0** (client, adapter e CLI).

O bloqueio administrativo temporário 503 foi **substituído por autenticação real**: JWT curto em cookie HttpOnly, refresh rotativo com hash, sessões revogáveis, bcrypt e autorização global consultada no banco. Agora, sem sessão válida retorna 401; usuário comum retorna 403; Super Admin válido é autorizado. A implantação ainda exige migration, configuração e bootstrap DEV, não executados. Adapters externos de pagamentos continuam pendentes. Desenho, segurança e procedimento do primeiro administrador: [AUTHENTICATION.md](AUTHENTICATION.md).

## Diagnóstico

| Área           | Evidência anterior                                                                    | Correção/estado                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard      | Nenhum módulo/rota de Dashboard; resumos separados de usuários, financeiro e webhooks | `/dashboard/summary`, agregações Prisma em snapshot RepeatableRead                                                                                   |
| Criação manual | Transação criava Company, User, Membership OWNER e Subscription; trial por padrão     | Preservada; reutiliza usuário por e-mail normalizado sem trocar senha/perfil; rejeita proprietário inativo/Super Admin                               |
| Métricas       | Criar empresa não cria Payment; TRIAL não é ACTIVE                                    | Total/trial/active e receita separados; sem pagamentos fictícios                                                                                     |
| Segurança      | `GET /companies/:id` incluía `memberships.user: true`                                 | Select explícito de campos públicos de usuário em ambas as consultas de empresa                                                                      |
| Usuários       | Services carregavam hash mesmo quando não o serializavam                              | `omit: { passwordHash: true }` nas consultas de leitura                                                                                              |
| Webhooks       | Detalhe retornava payload integral e erro sem sanitização                             | Select de metadados; payload, headers e erros internos não são expostos                                                                              |
| Financeiro     | Empresa derivada de subscription, embora Payment tenha companyId próprio              | Usa relação direta Payment.company; agregação no banco; FAILED e CANCELED separados                                                                  |
| Validação      | DTOs inline/`any` não validam em runtime                                              | Validação de campos/tipos, UUIDs, e-mail, timezone, senha/bcrypt, preços, features, gateways e cobranças; campos inesperados rejeitados nas mutações |
| Períodos       | `setMonth` pode pular fevereiro a partir de 31/jan                                    | UTC com ajuste para último dia do mês                                                                                                                |
| Expiração      | Nenhum fluxo de atualização por vencimento                                            | Reconciliação transacional explícita `/billing/reconcile`; agendamento externo ainda pendente                                                        |
| Auth           | Nenhuma autenticação/guard administrativa                                             | JWT/sessão, AdminGuard real e TenantGuard implementados; configuração/aceitação DEV pendentes                                                        |
| Gateways       | Apenas enum e referências textuais sem configuração/providers                         | Modelo criptografado, interface, registro indisponível e endpoints preparados                                                                        |
| Idempotência   | Só WebhookEvent tinha unicidade por gateway/eventId                                   | Índices para pagamentos/assinaturas externos e chave de cobrança; processamento serializável                                                         |
| Testes         | Testes gerados sem providers necessários e e2e dependente de banco real               | Providers corrigidos e Prisma substituído no teste HTTP; testes de regras adicionados                                                                |

### Causa do Dashboard

**Confirmado no backend:** falta de endpoint consolidado; criação padrão é TRIAL/TRIALING; criação manual, inclusive ativação imediata, não é receita confirmada. Os registros devem aparecer no total de empresas, usuários (se proprietário novo), assinaturas e trial ou ativos. Não devem aumentar pagamentos/receita.

**Não confirmado:** qual endpoint o frontend DEV efetivamente chama, cache/mapeamento do frontend, conteúdo atual de `kalend_dev` e versão publicada. Não foi acessado `kalend-web` nem o banco. Assim, não se afirma uma causa única para o sintoma observado no painel. Verificação de aceitação posterior: autenticar, criar empresa DEV, consultar summary e comparar variações; reutilização de proprietário não aumenta usuários.

### Relações e integridade

Company tem Memberships, Subscriptions e Payments. User pertence a empresas via Membership (unicidade usuário/empresa); isSuperAdmin é global, OWNER é por empresa. Plan tem features e assinaturas. Subscription referencia empresa/plano e possui pagamentos. Payment mantém empresa, assinatura opcional, plano opcional para compatibilidade histórica, gateway, moeda, preço e período congelados por cobrança. Novas cobranças exigem assinatura/empresa/plano compatíveis. WebhookEvent referencia pagamento/empresa quando conhecidos.

Migrations antigas preservadas. A migration comercial anterior removeu `Plan.priceCents` e adicionou `monthlyPriceCents` obrigatório sem backfill: isso é um risco histórico em bancos já populados, não foi repetido nem executado aqui. Relações antigas usam Cascade em exclusões de empresa; não há endpoint de exclusão novo. Não há isolamento por tenant no banco/RLS: endpoints aqui são **somente Super Admin**, não APIs de usuário comum.

## Migration nova

`20260923140000_gateway_architecture`: enums GatewayEnvironment/IntegrationStatus, GatewayConfiguration, campos de Payment (planId, environment, idempotencyKey, currency, periodStart/End), WebhookEvent (companyId, paymentId, environment, attempts), relações e índices únicos. Campos novos históricos são opcionais; não é feito backfill inventado. Antes de aplicar em DEV, revisar duplicatas `(gateway, externalPaymentId)` e `(gateway, externalSubscriptionId)`: índices falham diante de duplicatas, sem apagar dados automaticamente. Fazer validação de aplicação em banco descartável e depois DEV por procedimento autorizado.

## Gateways e secrets

MERCADO_PAGO, STRIPE e PAGBANK, sandbox/produção. MANUAL permanece para histórico/ativação administrativa, não é integração configurável.

Credenciais e segredo de webhook são criptografados com AES-256-GCM, nonce aleatório e AAD vinculada a gateway/ambiente/tipo de segredo. Chave `GATEWAY_ENCRYPTION_KEY` (64 caracteres hexadecimais, 32 bytes) deve ser provisionada pelo gerenciador de secrets do backend; não foi criada nem escrita em `.env`. Sem chave, gravação de credencial falha. API retorna flags, nunca ciphertext, segredo completo ou chave. O campo publicId é exclusivamente identificação pública. Rotação/backup da chave e auditoria de acesso devem ser definidos antes do uso real.

Adapters reais **não implementados**. Registro rejeita chamadas com `GATEWAY_ADAPTER_PENDING`; ativação e teste não simulam sucesso. A interface prevê criar cobrança/assinatura, consultar pagamento, cancelar assinatura e verificar webhook. Capacidades e contratos por gateway precisam ser implementados com documentação/SDK oficial e validados em sandbox. `lastValidatedAt` permanece nulo até conexão real; CONNECTED só pode ser atribuído após um adapter real validar a conexão; com o registro atual vazio, essa etapa é inacessível.

## Webhooks e pagamentos

Receptores públicos preservam raw body. Sem adapter autenticador, retornam 503 (ou 400 para corpo ausente/inválido), sem persistir evento nem ativar empresa. Não há formato de payload externo inventado. Um adapter futuro deverá verificar assinatura/autenticidade, conta e ambiente, e consultar o provedor quando requerido, antes de produzir `VerifiedEvent` interno. Nunca conectar body HTTP diretamente a `processVerified`.

O processador interno persiste somente dados normalizados necessários (ID externo do pagamento, status, valor e moeda). EventId é único por gateway. Faz claim e atualizações de Payment/Subscription/Company/WebhookEvent em transação Serializable, com até três tentativas para conflitos P2034. Falha faz rollback da transação e registra FAILED com código genérico; não armazena exceção bruta. Evento PROCESSED duplicado retorna sem nova ativação. Outro eventId do mesmo pagamento também não renova novamente: somente transição permitida e período fixo da cobrança.

APPROVED é o nome existente equivalente a PAID. Aprovação de PENDING ativa assinatura não cancelada/expirada se avança o período; falha apenas registra FAILED e não concede acesso. REFUNDED após APPROVED revoga o período atual correspondente, sem suspender empresa com outra assinatura elegível. CANCELED é cancelamento de pagamento, não cancelamento automático de assinatura. Eventos tardios após estado terminal não concedem acesso; reconciliação por provedor para casos especiais ainda precisa ser definida/testada. Renovação é uma nova cobrança com nova chave e novo período. Após timeout, reutilizar a mesma chave; não gerar outra cobrança por impulso.

`/billing/reconcile` expira assinaturas ACTIVE/TRIALING cujo período venceu e suspende empresa sem outra assinatura vigente. Sem cron conectado, datas vencidas podem continuar com status antigo até executar reconciliação; Dashboard relata os estados persistidos e não altera dados numa leitura. Cancelamento externo de assinatura e eventos de assinatura específicos permanecem pendentes de adapter e regra comercial.

Reprocessamento só aceita FAILED com pagamento conhecido e consulta novamente o gateway; não confia no payload armazenado como autoridade. Eventos desconhecidos permanecem FAILED, sem inventar associação pelo valor. Operação externa não pode participar da transação PostgreSQL: a chave idempotente deve ser suportada pelo adapter e reconciliação deve tratar falha após cobrança externa antes de salvar a referência.

## Pendências críticas antes de implantação

1. Provisionar auth, aplicar migration autorizadamente, criar o primeiro Super Admin via CLI e testar fluxo DEV; autenticação/guards e testes locais já implementados.
2. Aplicar/validar migration em PostgreSQL descartável e DEV; testar concorrência real, rollback e índices (mocks não provam isolamento do banco).
3. Prover chave de criptografia e credenciais sandbox pelo backend.
4. Adapters oficiais, assinatura de webhooks, conta/ambiente, reconciliação de timeout, testes de contrato/sandbox; ativação segura e validação externa do teste de conexão (a persistência de status já está preparada).
5. Cron para expiração e fila/retry operacional para eventos; definir cancelamento externo, chargeback e política de eventos fora de ordem.
6. Paginação consistente das listagens antigas (atualmente sem limite, exceto webhooks), observabilidade sem payloads/secrets, rate limits e trilha de auditoria administrativa.
7. Verificar frontend DEV e dados DEV para concluir o diagnóstico do sintoma publicado, sem mascarar com números locais.

Contrato para o frontend: `FRONTEND-API.md`. Evidências de verificação: `VALIDATION.md`.

Ambiente é congelado em Payment/WebhookEvent e comparado antes de processar/reprocessar. Registros históricos com ambiente nulo não são ativados por eventos novos. Unicidade por gateway/ID externo é deliberadamente mais restritiva: a mesma referência em sandbox e produção exige reconciliação, nunca associação silenciosa.

## Fundação de autenticação adicionada

Migration adicional `20260923160000_auth_sessions`: AuthSession (user, tenant opcional, prazos, revogação, fingerprint de credencial), AuthRefreshToken (somente digest, expiração e uso), AuthRateLimit (contador compartilhado com identificadores HMAC). User.isSuperAdmin já representava o privilégio global e foi preservado sem promover ninguém. Migration de gateways e todos os módulos anteriores permanecem.

Endpoints `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/logout-all`, `/auth/me` e seleção/contexto `/auth/tenant`. DTOs com parsers runtime rejeitam mass assignment. Tokens só em cookies Secure/HttpOnly/__Host, sem JSON; validação de Origin nas mutações. Login inválido tem erro genérico e bcrypt dummy para identidade inexistente. Hash de senha é lido somente internamente na autenticação e convertido em identidade explícita sem credenciais. Sessões antigas ficam inválidas após mudança da senha e status/privilégio do usuário é reconsultado.

Reutilização de refresh revoga a família e commita antes de responder 401. Membership/empresa/papel são revalidados pelo TenantGuard, sem inferir tenant pelo frontend. Consultas futuras deverão obrigatoriamente filtrar recursos por empresa validada. Recebedores de webhook não usam AdminGuard; consultas e reprocessamento usam.
