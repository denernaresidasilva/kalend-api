# Autenticação e autorização Kalend

Implementação local em develop; não implantada. Nenhum usuário foi criado/promovido, nenhuma migration foi aplicada e nenhum banco DEV/produção foi consultado. Não há endpoint de bootstrap nem autenticação por header fixo.

## Arquitetura

- Login e-mail/senha com bcrypt existente. E-mail é normalizado; senha não é normalizada/truncada (limite de 72 bytes). `LoginDto` e `SelectTenantDto` possuem parsers runtime e rejeitam campos extras.
- Access JWT HS256 via **jose 6.2.12**, até 10 minutos, com issuer/audience fixos, `typ=at+jwt`, sub, sid, jti, iat e exp obrigatórios. Algoritmo restrito; não há segredo padrão. JWT não contém autorização/roles para confiar em claims desatualizadas.
- Sessão PostgreSQL por login/dispositivo: 30 dias absolutos, refresh com até 7 dias de inatividade, renovado sem ultrapassar o limite absoluto. GET não estende sessão. O banco é consultado a cada autenticação, permitindo revogação efetiva mesmo antes da expiração do JWT.
- Refresh opaco de 32 bytes aleatórios, enviado somente em cookie; banco guarda SHA-256 e o histórico de uso. Alta entropia permite digest rápido sem bcrypt. Access token não é persistido.
- Rotação transacional: marca refresh como utilizado por update condicional, cria próximo digest e atualiza prazo. Reutilização de qualquer refresh antigo revoga toda a sessão desse dispositivo; a revogação é **commitada antes do 401**. Logout/replay de um dispositivo não revogam automaticamente outros dispositivos.
- `credentialHash` da sessão é um digest do hash bcrypt atual (com separador de domínio), nunca senha ou refresh puro. Uma mudança de senha torna os access/refresh anteriores inválidos, mesmo que a alteração ocorra fora de um futuro endpoint de recuperação. Comparação bcrypt permanece só no login/bootstrap.
- Logout revoga a sessão e remove cookies; logout-all revoga todas as sessões do usuário autenticado. Login bem-sucedido substitui a sessão anterior do navegador quando o refresh anterior está presente.

## Transporte e CSRF

Tokens são entregues **exclusivamente por Set-Cookie**, nunca no JSON, localStorage, sessionStorage ou URL. Cookies `__Host-kalend_access` e `__Host-kalend_refresh`: Secure, HttpOnly, SameSite=Strict, Path=/, sem Domain. Prefixo __Host impede cookies com Domain injetados por outros subdomínios. Só expirações e confirmação de autenticação são retornadas no corpo.

Frontend deve usar `credentials: 'include'`. Frontend DEV e API DEV são HTTPS e pertencem ao mesmo site `kalend.tech`. Para desenvolvimento local do navegador, usar ambiente HTTPS do mesmo site com configuração explícita; não desabilitar Secure/SameSite. Este contrato não aceita Bearer no header Authorization; futuros clientes nativos exigem um contrato próprio, sem expor tokens ao JavaScript web.

Login, refresh, logout e mutações autenticadas exigem Origin exata na allowlist. Ausência ou divergência gera 403; isso também impede login/logout CSRF. Headers Origin não substituem o JWT nem a autorização. CORS usa a mesma allowlist, mas não constitui autenticação. Auth e respostas protegidas usam `Cache-Control: no-store` e `Vary: Cookie`.

## Papel global e tenant

O schema **já tinha `User.isSuperAdmin`**; ele permanece como fonte única explícita de privilégio global. Adicionar outro enum duplicaria o estado. `/auth/me` deriva `systemRole: SUPER_ADMIN | USER` desse campo, sem migrar/promover usuários. MembershipRole (OWNER, ADMIN, RECEPTIONIST, PROFESSIONAL, CLIENT) continua estritamente por empresa.

AdminGuard valida JWT, sessão, usuário ativo, versão da credencial e `isSuperAdmin` atual no banco. Não depende de membership. Aplica-se a Dashboard, companies, plans administrativos, subscriptions, finance, payment-gateways, payments, users, billing e webhooks de consulta/reprocessamento. `/plans/public`, `/`, `/health` e receptores externos de webhook permanecem fora desse guard. Os receptores continuam recusando 503 por adapter pendente, não por ausência de JWT administrativo.

`/auth/me` retorna memberships ativas de empresas ativas em ACTIVE/TRIAL, com papel e dados básicos da empresa; nunca tokens, hashes ou identificadores internos de refresh. Empresa selecionada é por sessão, não por User. `POST /auth/tenant` exige membership ativa e empresa elegível. `null` limpa seleção. Super Admin também precisa de membership para usar uma rota de tenant; seu poder global aplica-se às rotas administrativas.

TenantGuard revalida membership/empresa a cada chamada, ignorando companyId em headers. `@TenantRoles(...)` permite autorizar papéis em cada rota futura. Serviços de tenant deverão buscar recursos por **id + companyId do contexto validado**, nunca apenas por id recebido. Exemplo conceitual: `where: { id: resourceId, companyId: req.tenant.companyId }`. Guard de membership sozinho não filtra consultas nem é RLS. As rotas administrativas atuais não são reaproveitadas como rotas de tenant. Entitlement por assinatura segue a reconciliação de billing existente; não foi implementado um painel de empresa.

## Limitação de tentativas e dados sensíveis

AuthRateLimit usa upsert/incremento atômico no PostgreSQL, compartilhado entre instâncias. Login: 30 tentativas/IP/15 minutos e 10 tentativas/e-mail/15 minutos; refresh: 60/IP/minuto. Janelas fixas; contar também identidades inexistentes e logins bem-sucedidos evita revelar existência. Identificadores são HMAC-SHA256 com chave de auth e domínio separado; não há e-mails/IPs puros na tabela. O limite pode bloquear temporariamente uma conta alvo; medidas adicionais de recuperação/abuso pertencem à operação futura. Rate limiting não faz fallback para permitir requisições se o banco falhar.

Sem proxy confiável configurado, Express usa IP da conexão e ignora X-Forwarded-For. Se houver balanceador, configure somente seus IPs/CIDRs, bloqueie acesso direto à API e garanta que ele sobrescreva headers encaminhados. Nunca configurar trust proxy=true nem confiar em qualquer origem de tráfego. Sem essa configuração, clientes podem compartilhar o limite do IP do proxy.

Usuário inexistente e senha errada recebem o mesmo 401 e ambos executam bcrypt.compare; conta inativa também passa por compare. Hash dummy aleatório usa custo 12 como a criação atual. Não é uma alegação de timing matematicamente idêntico (banco e hashes legados podem variar). Nenhum handler registra senha, cookie, JWT ou refresh. Instrumentação/proxy externos devem redigir Cookie/Set-Cookie/Authorization e corpos de login/credenciais; sua configuração não foi acessada aqui.

## Variáveis de ambiente

| Nome                       | Uso e valor exigido                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_JWT_SECRET`          | Chave aleatória dedicada ao ambiente, 32 bytes em 64 caracteres hex. Provisionar diretamente no gerenciador de secrets; sem valor padrão. Não reutilizar chave de gateway. |
| `AUTH_ALLOWED_ORIGINS`     | Lista separada por vírgulas de origins HTTPS exatas, sem barra final/path/wildcard. Para DEV, origin do frontend: `https://dev.kalend.tech`.                               |
| `AUTH_TRUSTED_PROXY_CIDRS` | Opcional, IPs/CIDRs específicos dos proxies confiáveis separados por vírgulas. Vazio = nenhum. Prefixos excessivamente amplos são rejeitados.                              |
| `KALEND_ADMIN_TARGET`      | Somente para CLI de bootstrap: literal `dev`. Não autoriza nenhuma requisição HTTP.                                                                                        |
| `DATABASE_URL`             | Configuração existente do backend apontando exclusivamente para o banco DEV durante bootstrap. O valor não deve aparecer no terminal, documentação ou logs.                |

`GATEWAY_ENCRYPTION_KEY` continua independente e necessária apenas para credenciais de gateways. Nenhum `.env` real foi alterado. Chave de JWT ausente/inválida causa 503 AUTH_NOT_CONFIGURED nas operações que precisam dela; requisição administrativa sem cookie continua 401. Allowlist ausente nega Origin e CORS. Rotação da chave JWT invalida access tokens existentes; refresh pode emitir novos JWTs. Em incidente, revogar também sessões no banco por procedimento administrativo autorizado.

## Primeiro Super Admin DEV — executar somente posteriormente

Pré-requisitos: revisão e aplicação autorizada das migrations no DEV, Node compatível (validação local com 22.23.2), dependências e cliente Prisma gerado. A aplicação de migrations é etapa separada; **não foi executada neste trabalho**. Obter ambiente do backend pelo mecanismo aprovado e conferir o host PostgreSQL DEV no provedor sem imprimir a URL de conexão. Não usar produção.

1. No checkout develop do backend, em terminal interativo de operador autorizado, disponibilizar a configuração existente do banco **kalend_dev** pelo gerenciador de secrets. Não passar senha por argumentos/env do comando e não habilitar gravação de terminal.
2. Para criar usuário novo:

   ```sh
   KALEND_ADMIN_TARGET=dev npm run admin:create
   ```

3. Para promover explicitamente usuário existente, em vez de criar:

   ```sh
   KALEND_ADMIN_TARGET=dev npm run admin:create -- --promote
   ```

4. O CLI solicita hostname DEV (deve coincidir com a configuração), confirmação literal `CRIAR PRIMEIRO SUPER ADMIN DEV`, e-mail, nome, senha e confirmação de senha. Senha é lida com eco desabilitado. Na criação exige 12 caracteres e até 72 bytes; na promoção exige a **senha atual** e a mesma política. Não redefine senha nem cria membership ao promover.
5. O comando recusa banco com nome diferente de kalend_dev, alvo diferente de dev e entrada não interativa. Serializa o bootstrap com advisory lock transacional e recusa se **qualquer** Super Admin já existir, mesmo inativo. Para promover, exige usuário ativo, verifica bcrypt e revoga sessões anteriores. Para criar, recusa e-mail já existente sem promoção explícita. Erros do driver nunca são impressos.
6. Depois do sucesso e da integração do frontend ao contrato de auth, acessar o frontend DEV, autenticar e conferir `/auth/me` com `systemRole=SUPER_ADMIN`. O CLI não retorna token. Não há endpoint público equivalente e ele não é chamado no startup.

O script não é mecanismo de recuperação nem administração permanente de papéis. Administradores adicionais e recuperação de acesso precisam de fluxo auditado separado. Restrições de host/nome são uma barreira operacional; conferir a conta/projeto DEV no provedor continua obrigatório. **O CLI não foi executado**, apenas sua função de domínio foi testada com cliente fake.

## Pendências de implantação e operação

- Aplicação autorizada da migration, configuração de secrets/origins/proxy, execução manual do bootstrap, integração do frontend e teste de aceitação DEV.
- Testes PostgreSQL de concorrência de refresh/logout e bootstrap. Os testes atuais exercitam bcrypt/JWT reais e persistência substituída; não provam locks/rollback reais.
- Definir retenção/limpeza de AuthRateLimit expirados e sessões encerradas. Manter hashes utilizados até o fim absoluto da sessão para detecção de replay; não apagar só porque o token individual venceu. Nenhuma rotina destrutiva foi executada/adicionada.
- MFA, recuperação/troca de senha por HTTP, verificação de e-mail, gestão de papéis adicionais, inventário de dispositivos e trilha operacional de login não fazem parte desta entrega. O fingerprint já invalida sessão após troca de hash; futuras operações de desativação devem revogar sessões no mesmo fluxo.
- Cookies dependem de HTTPS e comportamento real do navegador; validar CORS/cookies entre hosts DEV após implantação. Refresh deve ser serializado entre abas; rede interrompida após rotação pode exigir novo login (não há janela de tolerância a replay).
- Gateways, validação externa de webhooks, cron billing e validação PostgreSQL da auditoria anterior continuam pendentes e preservados.

Referências usadas no desenho: [jose (assinatura e verificação JWT)](https://github.com/panva/jose), [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [RFC 9700 §4.14 — proteção de refresh](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14). O Kalend aqui não implementa um authorization server OAuth; aproveita o princípio de rotação/detecção de replay em sua sessão própria.
