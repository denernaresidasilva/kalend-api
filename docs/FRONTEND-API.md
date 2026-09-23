# Contrato Kalend Super Admin

## Disponibilidade e convenções

Base DEV: `https://api-dev.kalend.tech`. Alterações locais **não publicadas**. O bloqueio administrativo 503 foi removido e substituído por sessão/JWT e autorização: sem autenticação válida → 401; sem privilégio global → 403. Configuração/migration/bootstrap ainda precisam ocorrer no DEV. Gateways sem adapter continuam retornando 503. Não preencher cards com valores fictícios.

JSON; IDs UUID; datas ISO 8601 UTC; valores monetários inteiros em centavos de BRL. Campos opcionais omitidos não alteram o valor, exceto quando indicado. JSON com campos desconhecidos é rejeitado nas novas mutações e em criação/edição de planos e empresa. GET/PATCH bem-sucedidos usam 200; POST usa 201 salvo auth, que explicita 200/204 abaixo. Erros Nest: `{ "statusCode": number, "message": string | string[], "error"?: string }`. 400 validação; 401 sessão inválida/ausente; 403 permissão/Origin; 404 inexistente; 409 conflito/processamento; 429 limite de tentativas; 503 adapter/configuração indisponível. Não mostrar detalhes técnicos de erro ao usuário.

## Autenticação do frontend

Pré-requisitos de implantação e primeiro administrador: [AUTHENTICATION.md](AUTHENTICATION.md). O frontend **não armazena nem lê tokens**. Ambos ficam em cookies `__Host-kalend_access` e `__Host-kalend_refresh`, definidos pelo backend: Secure, HttpOnly, SameSite=Strict, Path=/, sem Domain. Usar HTTPS e `credentials: 'include'` em todas as chamadas autenticadas. Não usar localStorage/sessionStorage, query string ou header secreto. O contrato web atual não usa Bearer/Authorization.

CORS e proteção de CSRF exigem a origin do frontend em `AUTH_ALLOWED_ORIGINS`. O navegador envia Origin automaticamente; não tentar definir esse header pelo JavaScript. Todas as mutações autenticadas e login/refresh/logout recusam Origin ausente ou não autorizada. Frontend/API DEV pertencem ao mesmo site HTTPS; localhost HTTP diretamente contra API DEV não é configuração suportada por esses cookies.

| Método/rota             | Entrada JSON                                   | Sucesso                                                                                              |
| ----------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| POST `/auth/login`      | `{email:string,password:string}`               | 200 AuthConfirmation + Set-Cookie                                                                    |
| POST `/auth/refresh`    | `{}` ou sem body; refresh recebido pelo cookie | 200 AuthConfirmation + cookies novos                                                                 |
| POST `/auth/logout`     | `{}` ou sem body                               | 204, revoga dispositivo e limpa cookies                                                              |
| POST `/auth/logout-all` | `{}` ou sem body, sessão válida                | 204, revoga todas as sessões do usuário e limpa cookies                                              |
| GET `/auth/me`          | nenhum                                         | 200 AuthMe                                                                                           |
| POST `/auth/tenant`     | `{companyId:string}` ou `{companyId:null}`     | 200 AuthMe; valida membership, seleciona/limpa tenant                                                |
| GET `/auth/tenant`      | nenhum                                         | 200 `{companyId:string,membershipId:string,role:MembershipRole}`; exige seleção e membership válidas |

```ts
type AuthConfirmation = {
  authenticated: true;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};
type MembershipRole =
  'OWNER' | 'ADMIN' | 'RECEPTIONIST' | 'PROFESSIONAL' | 'CLIENT';
type AuthMe = {
  user: { id: string; name: string; email: string; isSuperAdmin: boolean };
  systemRole: 'SUPER_ADMIN' | 'USER';
  memberships: Array<{
    id: string;
    role: MembershipRole;
    company: {
      id: string;
      name: string;
      slug: string;
      status: 'TRIAL' | 'ACTIVE';
      isActive: true;
    };
  }>;
  selectedCompanyId: string | null;
  session: { expiresAt: string; refreshExpiresAt: string };
};
```

E-mail normalizado; senha validada como string não vazia de até 72 bytes, sem trim. Campos extras (isSuperAdmin, role, userId, refreshToken etc.) são rejeitados. Login errado/inexistente/inativo retorna o mesmo 401: `E-mail ou senha inválidos.`. Não indicar existência da conta pelo frontend. Respostas não contêm passwordHash, credentialHash, hash de refresh, access/refresh em JSON ou credenciais de gateway.

Fluxo:

1. Submeter dados do formulário em `POST /auth/login`. Exemplo de transporte, sem credencial fixa:

   ```ts
   const response = await fetch(`${apiBase}/auth/login`, {
     method: 'POST',
     credentials: 'include',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ email, password }),
   });
   ```

2. Após 200, descartar senha da memória do formulário e carregar `/auth/me`. Abrir Super Admin somente se systemRole=SUPER_ADMIN; esse controle visual não substitui AdminGuard.
3. Ao abrir/recarregar app, consultar `/auth/me`. Se 401, fazer **um** refresh e repetir me uma vez; caso refresh falhe com 401, voltar ao login. Não tentar refresh recursivamente a partir de erro no próprio login/refresh/logout.
4. Access dura até 10 minutos. Serializar refresh entre requisições e abas: refresh é de uso único; duas renovações simultâneas podem revogar a sessão por replay. Coordenar chamadas e avisar outras abas. Se a resposta da rotação se perder, pode ser necessário login novo; não repetir indefinidamente um refresh antigo.
5. Em 403, mostrar ausência de permissão/empresa/Origin e não renovar o token tentando contornar autorização. Em 429, aguardar; limites fixos: login 30/IP e 10/e-mail a cada 15 minutos, refresh 60/IP/minuto. Em 503, mostrar configuração/integração indisponível.
6. Logout chama endpoint, depois remove perfil e caches locais. O servidor revoga a sessão no banco. Logout-all é opção distinta e requer access válido. Se access expirou mas há refresh válido, logout normal funciona sem renovação.
7. Para painel de empresa, oferecer memberships retornadas, sem assumir uma só. Selecionar via POST /auth/tenant; trocar tenant invalida caches de empresa e deve sincronizar abas, pois a seleção pertence à sessão do navegador. companyId em header não seleciona nem autoriza empresa. Após desativação de membership/empresa, TenantGuard recusa acesso. Super Admin sem membership mantém poder global, mas não ganha tenant automaticamente.

Refresh vence após até 7 dias sem renovação e nunca passa dos 30 dias absolutos da sessão. Logout, replay e mudança de senha invalidam sessões conforme documentação. Perfil/privilégio é reconsultado no banco: remoção de Super Admin resulta em 403 mesmo com JWT ainda não expirado; usuário inativo/sessão revogada resulta em 401.

As rotas `/dashboard`, `/companies`, `/plans` administrativos, `/subscriptions`, `/finance`, `/payment-gateways`, `/payments`, `/users`, `/billing` e consultas/reprocessamento de `/webhooks` exigem Super Admin. `/plans/public` continua público. Receptores externos `/webhooks/mercado-pago`, `/webhooks/stripe`, `/webhooks/pagbank` não usam login e continuam dependentes de adapter oficial; o frontend não deve chamá-los para simular confirmação de pagamento.

## Dashboard

`GET /dashboard/summary` — sem query/body. Resposta tipada:

```ts
type Summary = {
  generatedAt: string;
  period: { from: string; to: string; timezone: 'UTC' };
  companies: {
    total: number;
    active: number;
    trial: number;
    suspended: number;
    canceled: number;
    inactive: number;
    new: number;
  };
  users: { total: number };
  subscriptions: {
    total: number;
    active: number;
    trialing: number;
    pastDue: number;
    canceled: number;
    expired: number;
  };
  payments: {
    total: number;
    approved: number;
    pending: number;
    failed: number;
    canceled: number;
    refunded: number;
    revenueCents: number;
    monthlyRevenueCents: number;
  };
  recentEvents: WebhookMetadata[]; // últimos 10
};
type WebhookMetadata = {
  environment: 'SANDBOX' | 'PRODUCTION' | null;
  id: string;
  gateway: 'MANUAL' | 'MERCADO_PAGO' | 'STRIPE' | 'PAGBANK';
  externalEventId: string;
  eventType: string | null;
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'IGNORED';
  receivedAt: string;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
  companyId: string | null;
  paymentId: string | null;
  attempts: number;
};
```

`companies.new` usa criação no mês UTC corrente, até generatedAt. Demais contagens são históricas por estado persistido. `inactive` usa isActive=false e pode sobrepor suspended/canceled; não somar esses campos. `total` é independente de pagamentos. Assinaturas contam registros, não empresas distintas. Usuários contam User, não Membership. `revenueCents` soma apenas APPROVED; estornados saem dessa soma. Receita mensal usa paidAt no mês UTC (não createdAt). Não chamar receita de MRR nem projeção. Datas expiradas exigem rotina de reconciliação antes de mudança do status persistido.

Após criar empresa, invalidar/refazer summary e listagens pertinentes. Trial deve aumentar total/trial/trialing, não active/revenue. Ativação manual aumenta active, sem inventar pagamento. Proprietário reutilizado não aumenta users.total.

## Empresa manual

`POST /companies/manual`

```ts
type ManualCompanyInput = {
  companyName: string;
  slug: string;
  timezone?: string; // padrão America/Sao_Paulo
  ownerName: string;
  ownerEmail: string;
  ownerPhone?: string;
  ownerPassword: string; // mínimo 8 caracteres, máximo 72 bytes bcrypt
  planId: string;
  billingInterval?: 'MONTHLY' | 'YEARLY'; // MONTHLY
  startWithTrial?: boolean; // true
};
```

E-mail normalizado; usuário existente ativo e não Super Admin é reutilizado sem modificar nome, senha ou telefone. Senha ainda é obrigatória no contrato, embora ignorada para usuário existente. Trial exige plano com trial habilitado e dias positivos. YEARLY exige preço anual. Slug normalizado e único.

Resposta 201:

```ts
type ManualCompanyResult = {
  company: {
    id: string;
    name: string;
    slug: string;
    status: 'TRIAL' | 'ACTIVE';
    timezone: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  };
  owner: { id: string; name: string; email: string; phone: string | null };
  membership: { id: string; role: 'OWNER' };
  subscription: {
    id: string;
    status: 'TRIALING' | 'ACTIVE';
    billingInterval: 'MONTHLY' | 'YEARLY';
    trialStartedAt: string | null;
    trialEndsAt: string | null;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    gateway: 'MANUAL';
    plan: { id: string; name: string; code: string };
  };
};
```

`GET /companies`: mantém lista com id/name/slug/status/createdAt/updatedAt, owner `{id,name,email}|null`, usersCount e subscription `{id,status,trialEndsAt,currentPeriodStart,currentPeriodEnd,plan:{id,name,code}}|null`.

`GET /companies/:id`: Company com memberships (user apenas id/name/email/phone/isActive/isSuperAdmin/createdAt/updatedAt) e subscriptions com plan/features/payments. Não há passwordHash. Não usar este detalhe para calcular Dashboard.

## Configurações > Pagamentos

Gateway de URL é enum **maiúsculo**: `MERCADO_PAGO`, `STRIPE`, `PAGBANK`.

| Método/rota                            | Body         | Resposta                                             |
| -------------------------------------- | ------------ | ---------------------------------------------------- |
| GET `/payment-gateways`                | nenhum       | GatewayConfigurationView[] (três gateways)           |
| GET `/payment-gateways/:gateway`       | nenhum       | GatewayConfigurationView                             |
| PATCH `/payment-gateways/:gateway`     | GatewayPatch | GatewayConfigurationView                             |
| POST `/payment-gateways/:gateway/test` | nenhum       | 503 GATEWAY_ADAPTER_PENDING enquanto adapter ausente |

```ts
type GatewayConfigurationView = {
  gateway: 'MERCADO_PAGO' | 'STRIPE' | 'PAGBANK';
  enabled: boolean;
  environment: 'SANDBOX' | 'PRODUCTION';
  publicId: string | null;
  configured: boolean;
  webhookConfigured: boolean;
  status: 'NOT_CONFIGURED' | 'PENDING_VALIDATION' | 'CONNECTED' | 'FAILED';
  lastValidatedAt: string | null;
  adapterAvailable: boolean; // false na implementação atual
  webhookPath: string;
};
type GatewayPatch = {
  enabled?: boolean; // true retorna 503 até existir adapter validado
  environment?: 'SANDBOX' | 'PRODUCTION';
  publicId?: string | null; // SOMENTE identificação pública
  credentials?: string | null; // segredo write-only, null remove
  webhookSecret?: string | null; // segredo write-only, null remove
};
```

O formato final de credentials por gateway ainda depende do adapter oficial; atualmente é string opaca cifrada, até 16384 caracteres. Na troca de ambiente, enviar ambos credentials e webhookSecret explicitamente (novos valores ou null). Configuração é por gateway, um ambiente por vez; não misturar referências de testes com ambiente de produção. Todas as edições desabilitam a integração e invalidam a validação anterior. Não há conexão externa real no botão de teste atual. Não habilitar o botão “Ativar” se adapterAvailable=false.

O backend nunca retorna credentials/webhookSecret nem o ciphertext. Exibir configured/webhookConfigured como “configurado”. Não preencher campo de senha com máscara recebida, não persistir segredo no localStorage/logs, não embutir chaves no bundle. Se houver formulário administrativo futuro para inserir credenciais, o valor é somente de escrita, enviado por HTTPS ao backend e descartado da memória da tela após envio; a alternativa preferida é provisionar pelo gerenciador de secrets. A chave de criptografia jamais passa pelo frontend.

## Financeiro e cobranças

`POST /payments`:

```ts
type ChargeRequest = {
  companyId: string;
  subscriptionId: string;
  planId: string;
  gateway: 'MERCADO_PAGO' | 'STRIPE' | 'PAGBANK';
  idempotencyKey: string; // 1..128 caracteres; manter para retry da mesma operação
};
```

Nenhum amount/price/status é aceito. Backend valida assinatura da empresa/plano e lê preço do Plan conforme billingInterval. Assinaturas canceladas/expiradas e planos inativos são rejeitados. Sem adapter retorna 503 sem criar cobrança. A interface preparada retorna Payment após a criação externa; não há checkoutUrl implementada. Não liberar checkout no frontend ainda.

```ts
type Payment = {
  environment: 'SANDBOX' | 'PRODUCTION' | null;
  id: string;
  companyId: string;
  subscriptionId: string | null;
  planId: string | null;
  amountCents: number;
  currency: string;
  status: 'PENDING' | 'APPROVED' | 'FAILED' | 'REFUNDED' | 'CANCELED';
  gateway: 'MANUAL' | 'MERCADO_PAGO' | 'STRIPE' | 'PAGBANK';
  idempotencyKey: string | null;
  externalPaymentId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  description: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

`GET /finance/summary`: `{ revenueCents, monthlyRevenueCents, paymentsCount, approvedCount, pendingCount, failedCount, canceledCount, refundedCount }` (todos number). **Alteração:** failedCount não inclui mais cancelados. Receita mensal usa paidAt UTC.

`GET /finance`: array `{id,status,amountCents,gateway,externalPaymentId,paidAt,createdAt,updatedAt,company:{id,name,slug},plan:{id,name,code}|null,subscription:{id,status}|null}`. Empresa vem diretamente de Payment mesmo sem assinatura. Lista existente ainda sem paginação.

## Assinaturas

`GET /subscriptions`: array com id, status, **trialStartsAt** (nome legado), trialEndsAt, currentPeriodStart, currentPeriodEnd, canceledAt, createdAt, updatedAt; company `{id,name,slug,status}`; plan `{id,name,code,monthlyPriceCents,yearlyPriceCents}`; lastPayment `{id,status,amountCents,createdAt}|null`.

`GET /subscriptions/:id`: registro completo de Subscription (usa **trialStartedAt**), company, plan com features, payments. Status: TRIALING, ACTIVE, PAST_DUE, CANCELED, EXPIRED. Não inferir pagamento a partir de ACTIVE: ativação manual pode não ter pagamento.

`POST /billing/reconcile`: sem body; `{ expired:number, reconciledAt:string }`. Manutenção administrativa, não chamada automática ao carregar Dashboard. Expira períodos vencidos e suspende empresa sem outra assinatura válida. Cron e cancelamento externo de assinaturas ainda pendentes; não criar botões que prometam operações ausentes.

## Webhooks

`GET /webhooks`: últimos 100 por receivedAt desc; `Array<WebhookMetadata & {errorMessage:'PROCESSING_FAILED'|null}>`.

`GET /webhooks/:id`: mesmo objeto; 404 se não existir. Não retorna payload bruto, assinatura, headers, secret ou erro original.

`GET /webhooks/summary`: `{ total, received, processing, processed, failed, ignored }` (number).

`POST /webhooks/:id/reprocess`: sem body. Apenas FAILED com pagamento conhecido; retorna 409 quando inelegível, 503 enquanto adapter ausente. Quando integrado, consulta provedor e processa transacionalmente, retornando WebhookMetadata; duplicidade pode retornar `{id,status?,duplicate:true}`. Desabilitar ação enquanto adapterAvailable=false. Não permitir editar payload/eventId pelo painel.

Receptores destinados aos gateways (não chamados pelo frontend):

- POST `/webhooks/mercado-pago`
- POST `/webhooks/stripe`
- POST `/webhooks/pagbank`

Contrato externo **pendente dos adapters oficiais**. Atualmente rejeitam com 503, sem processar payload. Não enviar payload de demonstração esperando ativação. O status de pagamento confirmado no banco é **APPROVED**, não PAID.

## Planos e usuários existentes

`GET /plans/public` segue público; apenas planos ativos/features habilitadas. Outras rotas de plans/users exigem sessão válida e Super Admin global. `POST /plans` e `PATCH /plans/:id` validam campos em runtime; não aceitam preços negativos/fracionários, trialDays fora de 1..365, features duplicadas, tipos errados ou propriedades inesperadas. Contrato mantém name/code/description/monthlyPriceCents/yearlyPriceCents/trialEnabled/trialDays/badge/isFeatured/displayOrder/maxProfessionals/maxClients/maxUnits/isActive/features[{code,name,enabled?}]. name/code/monthlyPriceCents são obrigatórios no create. `PATCH /plans/:id/deactivate` mantém histórico.

`GET /users`, `/users/:id`, `/users/summary` preservam contratos públicos de campos, sem hash. Summary owners/professionals/clients conta memberships ativas, e não usuários distintos (um proprietário em duas empresas conta duas memberships).
