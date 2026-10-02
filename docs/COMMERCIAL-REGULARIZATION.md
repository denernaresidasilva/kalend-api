# GET /billing/regularization — Fase 4.2-BE

## Auditoria e fontes

Controller anterior: CommercialController em src/billing/billing.module.ts; service: RegularizationService. Não havia DTO de entrada nem tipo explícito da resposta, inferida pelo TypeScript. Testes existentes: commercial.service.spec.ts, auth.security.spec.ts e auth.e2e-spec.ts. Agora CommercialStateController atende somente a leitura; as operações continuam no CommercialController.

Subscription pertence a Company por companyId. trialStartedAt/trialEndsAt são persistidos por CompaniesService na criação, acrescentando Plan.trialDays em UTC; editar o catálogo não recalcula trials existentes. Subscription.status/currentPeriodEnd/graceEndsAt e entitledWhere são a autoridade comercial. Payment.status é a fonte financeira; pagamento APPROVED isolado não prova acesso. AuthGuard autentica cookie JWT e sessão persistida; AuthService.membership valida membership ativa e empresa, usando a política de recuperação já existente para empresa suspensa/cancelada. MembershipRole tem OWNER, ADMIN, RECEPTIONIST, PROFESSIONAL, CLIENT; User.isSuperAdmin define o privilégio global, sem role de empresa implícita.

## Resposta aditiva

Exemplo parcial de trial vigente:

```json
{
  "serverNow": "2026-10-01T23:00:00.000Z",
  "companyId": "empresa-selecionada",
  "context": { "systemRole": "USER", "role": "OWNER", "commercialApplicable": true },
  "trial": {
    "active": true,
    "endsAt": "2026-10-04T23:00:00.000Z",
    "expired": false,
    "remainingDays": 3
  },
  "financial": { "requiresAction": false, "status": "TRIALING", "paymentStatus": null }
}
```

Todos os campos legados permanecem: companyId, accessAllowed, status, reason, trialExpired, subscription, plans, gateways, pendingCheckout. OWNER/ADMIN conservam o conteúdo anterior. Outros papéis recebem a mesma estrutura de estado, mas plans/gateways são arrays vazios e pendingCheckout é null; nenhuma permissão de checkout, consulta individual de pagamento ou cancelamento é concedida. A assinatura continua resumida; não há credenciais, dados do pagador ou referências financeiras externas no estado adicional.

## Tempo e trial

serverNow é gerado pelo servidor a cada consulta, em ISO 8601 UTC com Z. O mesmo instante participa de todas as comparações e da consulta de elegibilidade; nunca vem do cliente. Datas persistidas são serializadas em UTC. O timezone cadastrado na empresa não muda a comparação de instantes.

Trial ativo: assinatura efetiva selecionada com status TRIALING e trialEndsAt > serverNow. Trial expirado: trialEndsAt <= serverNow com status TRIALING ou EXPIRED, preservando trialExpired legado. ACTIVE após conversão não é tratado como trial expirado por possuir datas históricas. Mantém-se a seleção anterior: assinatura elegível mais recente, ou, na ausência, última assinatura não PENDING.

remainingDays = ceil((trialEndsAt - serverNow) / 86400000) para trial ativo; nos demais casos, 0. A convenção já existe na detecção de aviso de trial da comunicação; nenhuma alteração foi feita nela. Significado: 3 para (48h,72h], 2 para (24h,48h], 1 para (0h,24h]. Exatamente no término: active=false, expired=true, remainingDays=0. Sem trial: active=false, expired=false, endsAt=null, remainingDays=0. Datas de trial histórico podem permanecer em endsAt, com active=false. Não são dias de calendário; essa experiência dependeria de uma definição adicional de produto e não foi inventada.

## Financeiro e prioridade

financial.status é o status persistido da assinatura efetiva (PENDING, SUSPENDED, TRIALING, ACTIVE, PAST_DUE, CANCELED, EXPIRED), ou null sem assinatura. Não se cria enum financeiro novo. financial.paymentStatus é o último Payment.status da mesma assinatura e empresa, ou null: PENDING, APPROVED, FAILED, OVERDUE, REFUNDED, CANCELED. Ele permite distinguir falha/atraso sem expor detalhes financeiros e sem transformar status de pagamento em autorização.

requiresAction é a expressão já implícita em reason=PAYMENT_REQUIRED: nenhuma assinatura elegível e nenhum trial expirado. Portanto falta de assinatura requer regularização; trial expirado segue o fluxo de planos. Uma falha de cobrança com assinatura ainda elegível não torna a ação obrigatória. ACTIVE com currentPeriodEnd futuro, TRIALING com trialEndsAt futuro e PAST_DUE com graceEndsAt futuro continuam elegíveis. Na fronteira exata da carência não há elegibilidade. BILLING_GRACE_DAYS ausente significa zero; o contrato lê o prazo persistido e não o estende nem recalcula. Não espera a reconciliação persistir SUSPENDED para informar ação obrigatória após a carência.

Frontend: primeiro verificar context.commercialApplicable. Se aplicável, prioridade: financial.requiresAction → regularização; trial.expired → planos; trial.active e remainingDays entre 1 e 3 → aviso; demais casos → fluxo normal sujeito às autorizações existentes. O backend não redireciona. status de pagamento é informativo e não deve sobrepor requiresAction.

## Sessão, papéis e empresas

A leitura atende os cinco papéis reais através de membership ativa, usando exclusivamente AuthSession.selectedCompanyId. Não escolhe a primeira empresa, mesmo quando há apenas uma. Query/body/headers com companyId ou serverNow não são usados. Mudança de selectedCompanyId pela rota autenticada existente muda o estado consultado. Todas as consultas de assinaturas e pagamentos são filtradas pela empresa selecionada; o pagamento de status também é filtrado por subscriptionId.

Sem sessão: 401. Empresa selecionada sem membership autorizada/ativa: 403. Sem empresa selecionada (incluindo usuário sem nenhuma empresa): resposta 200 com companyId=null, context.commercialApplicable=false, role=null, status=NOT_APPLICABLE, reason=null, accessAllowed=false, subscription=null, trial sem atividade/expiração e financial.requiresAction=false/status=null/paymentStatus=null. Planos/gateways vazios e checkout null. Não é concessão de acesso ao produto; o frontend deve resolver o contexto de empresa.

Super Admin sempre recebe esse estado não aplicável com systemRole=SUPER_ADMIN, mesmo com empresa selecionada. Não consulta trial de empresa nem ganha membership implicitamente. Operações comerciais e demais guards permanecem com as permissões anteriores.

## Escopo e validação

Sem alteração de schema/migration, checkout, gateways, PagBank, comunicação, Push, PWA ou frontend. Testes unitários cobrem 3/2/1 dias, frações e fronteiras de milissegundo, expiração, ausência de trial, carência e estados de pagamento. A suíte HTTP existente cobre autenticação, contexto vazio, cinco papéis, empresa única, seleção A/B, isolamento, membership revogada e Super Admin, com bcrypt/JWT reais e persistência simulada; não é homologação em banco ou gateways reais.

Resultados locais: npm test — 30 arquivos/462 testes aprovados; npm run test:e2e — 6 arquivos/116 testes aprovados; npm run lint e npm run build aprovados; prisma validate e prisma generate aprovados. Usado Node 24.14.0 temporário em /tmp porque Node 18.19.0 instalado não suporta as dependências atuais. E2E executado com permissão para portas locais. DATABASE_URL local foi fornecida somente para carregar a configuração de validate/generate, sem conexão ou migration. git diff --check sem erros. Nenhum commit/push/deploy.

Tipos adicionados em src/billing/regularization.types.ts para trial, financial e context; a resposta completa mantém inferência TypeScript, incluindo os campos legados.
