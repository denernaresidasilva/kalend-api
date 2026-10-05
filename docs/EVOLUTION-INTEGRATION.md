# Evolution — correções de ambiente, QR e preflight

Atualização local de 05/10/2026. **Uma empresa = uma instância por ambiente. O Super Admin possui uma conexão GLOBAL independente por ambiente.** Nenhuma chave real foi impressa, nenhum banco real foi consultado ou alterado, nenhuma migration foi aplicada e nenhuma instalação Evolution foi modificada. VPS e aparelhos reais: **NÃO VALIDADO**.

## 1. Ambiente e webhook obrigatório

O projeto não possui um APP_ENV confiável. NODE_ENV=production também é usado nos builds/deploys DEV e não determina o ambiente Evolution.

A fonte explícita é EVOLUTION_WEBHOOK_BASE_URL, obrigatória e sem fallback:

| Ambiente | Origin obrigatório |
|---|---|
| DEV | https://api-dev.kalend.tech |
| Produção | https://api.kalend.tech |

Aceita somente esses origins HTTPS, com raiz e sem credenciais/query/fragmento. Ausência retorna 503 com código sanitizado EVOLUTION_WEBHOOK_BASE_URL_REQUIRED, antes de qualquer chamada Evolution. URL inválida retorna EVOLUTION_WEBHOOK_BASE_URL_INVALID. Não existe fallback silencioso para produção.

BILLING_PUBLIC_API_URL, quando presente, deve ter o mesmo origin. DATABASE_URL, quando presente, deve ser PostgreSQL e coerente: DEV exige banco kalend_dev; produção recusa kalend_dev. Divergência retorna EVOLUTION_ENVIRONMENT_MISMATCH. Essa defesa é aplicada à integração, sem alterar configuração de billing, autenticação ou PrismaService. A configuração/URL real da VPS não foi lida ou confirmada.

Os callbacks continuam separados:
- COMPANY: /webhooks/communication/evolution/:connectionId;
- GLOBAL: /webhooks/communication/evolution/global/:connectionId.

Além de token, instanceName e contexto, o receiver exige environment persistido igual ao ambiente verificado da API e nome coerente com esse namespace. Eventos de vínculo antigo não atribuído ou de outro ambiente são rejeitados antes de consultar/controlar instâncias.

## 2. Namespaces e banco

| Contexto | DEV | Produção |
|---|---|---|
| GLOBAL novo | kalend_dev_global | kalend_global |
| COMPANY | kalend_dev_<UUID em minúsculas sem hífens> | kalend_<UUID em minúsculas sem hífens> |

O mesmo UUID em ambientes diferentes resulta em nomes distintos. Nenhuma recuperação, consulta, mensagem, restart, logout ou delete usa um nome do outro ambiente. environment persistido é conferido antes das operações, sob a lease para decisões mutáveis.

Produção pode preservar um nome GLOBAL antigo válido, já administrado no backend, desde que não ocupe o prefixo DEV ou um nome de Company. DEV não adota configuração GLOBAL legacy sem namespace DEV. Após atribuição, o vínculo/nome não muda em reload, polling, QR expirado, logout ou reconexão.

DATABASE_URL DEV e produção devem apontar para bancos distintos. Os índices companyId/globalKey continuam únicos: não há duas conexões da mesma empresa nem dois GLOBAL dentro do mesmo banco. Uma API ligada a banco contendo vínculo explicitamente atribuído ao outro ambiente falha, sem reinterpretar/reassociar silenciosamente esse vínculo.

## 3. Dados antigos e compatibilidade

A migration complementar deixa environment nulo nos registros antigos; não renomeia/apaga dados nem chama o provedor. A primeira preparação/consulta sob lease atribui o ambiente e verifica o nome antes de qualquer operação remota.

- COMPANY nova continua criada com conexão PENDING dentro da transação comercial. Seu nome local inicial conserva o padrão legacy e environment é nulo. Esse registro **não é usado remotamente** até a atribuição do ambiente; em DEV o serviço altera o vínculo para kalend_dev_<UUID> antes de fetch/create/webhook.
- Em produção, um vínculo antigo com nome coerente pode reutilizar a instância existente, reconfigurando seu webhook e token; sessão remota não é excluída.
- Em DEV, vínculo antigo sem prefixo DEV é transferido **somente no registro Kalend** para o nome DEV. Perfil/estado/segredo antigos são resetados. Não executa logout/delete/consulta da instância antiga sem namespace.
- Registros com environment já atribuído a outro ambiente são recusados, inclusive get/logout/delete/send/webhook.

**Consequência real:** empresas/dados comerciais continuam preservados; um WhatsApp DEV anteriormente vinculado a nome ambíguo pode exigir novo pareamento na instância DEV. Não existe endpoint de rename/migração de sessão comprovado na Evolution 2.3.7. Não é possível prometer preservação automática dessa sessão e simultaneamente garantir que DEV não controle produção. A instância antiga fica intocada; sua propriedade deve ser revisada pelo operador na homologação.

Bancos clonados depois da atribuição de environment não são reinterpretados automaticamente. Preflight aponta vínculos incompatíveis e o operador precisa revisar a estratégia de homologação; esta tarefa não executou reparo manual em banco.

## 4. GLOBAL idempotente

Fluxo definitivo: Super Admin → Comunicação → WhatsApp — Evolution API → Configurar. Montagem do painel dispara prepare automaticamente. Não é necessário provisionar no login nem na visão geral.

Upsert GLOBAL único, nome determinístico ou legado produtivo válido, lease no PostgreSQL e consulta fetchInstances antes de create. Falha/timeout ambíguo de create é recuperado consultando o mesmo nome. Duas abas/requests não geram nomes alternativos. A criação Company permanece assíncrona após commit e independente da disponibilidade/configuração imediata da Evolution; falhas ficam recuperáveis.

GLOBAL usa AdminGuard. COMPANY usa TenantGuard/TenantRoles OWNER/ADMIN e sessão selecionada. GLOBAL não serve como fallback da empresa; seu envio interno resolve Super Admin/proprietário ativo pelo banco, sem telefone arbitrário de clientes. SMTP, Meta, Push e demais canais não foram alterados nesta correção.

## 5. QR, expiração e recuperação

Endpoint real: GET /instance/connect/:instanceName. QR PNG data URI direto ou em qrcode.base64, validado pelo backend. Nenhum endpoint fictício.

QR e pairing code existem apenas na resposta corrente. O cache Map por processo foi removido. Cada réplica consulta a Evolution e compartilha no banco apenas:
- codeFingerprint: HMAC-SHA256 com token próprio da conexão, sem QR/código bruto; impede comparação/guessing offline de pairing curto;
- codeExpiresAt: janela local de exibição de 45 segundos;
- connectionRequested: intenção de pareamento pendente;
- lastRecoveryAt: cooldown de recuperação entre réplicas.

Ler o mesmo código em outra réplica não renova sua expiração. Mudança real de código gera nova janela. O TTL é política Kalend, não validade contratual do WhatsApp. Pairing utiliza a identidade do pairingCode, sem prolongar seu prazo por uma simples rotação da imagem QR.

Fluxo automático de recuperação:
1. Consulta estado e connect da **mesma instanceName**.
2. Se há código novo válido, mostra sem restart.
3. Se o código continua expirado/ausente após a janela da tentativa, consulta estado novamente.
4. Se open, não reinicia a sessão conectada.
5. Se close, usa connect: o controller 2.3.7 inicia a conexão nesse estado e recusa restart em close.
6. Se connecting e a tentativa continua sem código válido, usa POST /instance/restart/:instanceName e consulta connect novamente.
7. Cooldown persistido de 30 segundos impede restart repetido por diferentes abas/réplicas. O mesmo código expirado não ganha prazo novo artificialmente.

Não existe createInstance/deleteInstance nesse caminho. Se a instância sumir externamente, o erro é recuperável por preparação explícita posterior, não por loop de recriação no polling.

Webhook de queda/refused durante pareamento mantém a tentativa pendente para consulta/recuperação; não confunde isso com logout intencional. Ao detectar CONNECTED, limpa intenção/metadados de código. Logout/delete limpam a intenção e o polling não reconecta deliberadamente uma sessão desconectada.

A interface oculta QR expirado e informa que está solicitando novo código na mesma conexão. Polling de 10 segundos durante tentativa, sem consulta em documento oculto; para ao conectar, logout/delete, erro não recuperado, troca de tenant/sessão ou unmount. Requests e respostas tardias continuam abortados/versionados.

## 6. Pairing

Contrato confirmado: GET /instance/connect/:instanceName?number=... . Telefone com DDI validado/normalizado no frontend e backend; não adivinha país, não é persistido como configuração de pareamento. Código é mostrado exatamente como recebido.

Controller 2.3.7 ignora número novo em connecting: troca explícita de modo/número usa logout da sessão pendente antes de connect. Instância permanece a mesma. Quando recebe somente QR, permite QR e indica pairing pendente.

**Limite deliberado:** recuperação por polling não guarda/reenvia o número digitado. Se um pairing expirar e o provedor reiniciar sem esse número, a recuperação pode devolver QR; para novo pairing o usuário informa o telefone novamente. Não armazenamos o número ou pairing code permanentemente apenas para tentar reconstruir uma tentativa expirada.

## 7. Logout/delete/webhook

Logout confirmado fecha sessão e preserva registro/instância. Reconectar usa o mesmo vínculo. Delete confirmado é separado, remove a instância atual e reseta o registro; somente preparar/configurar de novo permite recriação.

Webhook exige contexto GLOBAL/COMPANY, ambiente persistido, nome autorizado, token exclusivo cifrado, comparação constante e timestamp válido. Token é reconferido após claim; eventos duplicados/anteriores são ignorados. Reset de namespace/delete invalida callbacks antigos. Body/headers/QR não são persistidos em logs.

## 8. Logs e credenciais

EVOLUTION_API_KEY exclusivamente process.env, só no EvolutionClient. Nenhuma NEXT_PUBLIC_EVOLUTION_API_KEY. Nenhum formulário técnico/instanceName/chave no browser; nenhum endpoint externo Evolution chamado pelo frontend. Nenhuma alteração de chave ou .env.

Kalend loga apenas mensagens/códigos fixos. Testes verificam ausência de API key, Authorization, apikey, token de webhook, credenciais e QR completos nos logs/respostas. HMAC/datas não são retornados ao frontend.

**Pendente VPS:** a própria Evolution 2.3.7 pode logar QR/pairing e envelopes com apikey conforme log level. Não foi alterada a instalação/configuração do provedor. Verificar logs e níveis, retenção e acesso durante homologação, sem copiar secrets para terminal/relatório.

## 9. Migrations e preflight

Ordem preservada:
1. 20261005160000_company_evolution: enum/tabela, PK, unique companyId/instanceName, FK Company CASCADE;
2. 20261005200000_global_evolution: CREATED/DELETING, companyId nullable, globalKey unique, CHECK exclusivo GLOBAL/COMPANY;
3. **20261005220000_evolution_environment_recovery**: enum DEV/PRODUCTION, environment nullable, connectionRequested, codeFingerprint, codeExpiresAt e lastRecoveryAt; substitui CHECK pelo equivalente com namespaces/ambiente.

As duas primeiras ficaram byte a byte intactas. Não remove dados ou altera índices/FK; a terceira permite os novos nomes com environment atribuído e os registros legacy ainda não atribuídos. Não salva payload QR/pairing. Nenhuma migration aplicada. Schema/SQL declarativos e testes não comprovam DDL no DEV real: **NÃO VALIDADO**.

Preflight disponível em scripts/evolution-preflight.mjs, com checker testável. Exige build local da API para o módulo dist.

Modo offline, sem banco:

    node scripts/evolution-preflight.mjs --snapshot /caminho/snapshot.json --environment DEV

Snapshot: objeto com rows; cada linha contém somente id, companyId, globalKey, instanceName, environment opcional e companyExists opcional. globalMigrationApplied informa se a segunda migration já consta aplicada. Nunca inclua credentials/QR/tokens. O checker ignora campos extras e não os imprime. Não modifica o snapshot.

Para operador autorizado, **DEV somente**, não executado nesta tarefa:

    node scripts/evolution-preflight.mjs --dev --environment DEV

Recusa modo produção e banco com nome diferente de kalend_dev; usa BEGIN READ ONLY, SELECTs de metadados/linhas e ROLLBACK. Não executa Prisma migrate deploy, UPDATE ou DDL. Recusa histórico Prisma incompleto/falho ou tabela sem a migration inicial registrada. O operador continua responsável por conferir host/URL realmente DEV, sem divulgar credenciais.

Detecta CHECK incompatível da segunda/terceira migration, contextos nulos/duplos, unique duplicado, órfãos quando há evidência de Company e environment divergente. Informa quantidade de vínculos legacy DEV que mudarão namespace. Dados DEV já prefixados antes da segunda migration pendente são apontados: a segunda CHECK poderia rejeitá-los mesmo que a terceira aceite.

Exit 0: snapshot compatível; exit 2: linhas incompatíveis; exit 1: configuração/histórico/entrada inválidos, erro sanitizado. Preflight não substitui backup, revisão da versão PostgreSQL, drift de schema ou aplicação em ambiente autorizado. Banco DEV real não foi consultado.

## 10. Variáveis e workflows

| Variável | Finalidade |
|---|---|
| EVOLUTION_API_KEY | Secret backend para a Evolution existente; valor não publicado |
| EVOLUTION_WEBHOOK_BASE_URL | Origin explícito api-dev.kalend.tech em DEV ou api.kalend.tech em produção |
| GATEWAY_ENCRYPTION_KEY | Secret existente do SecretVault; valor não publicado |
| DATABASE_URL | Conexão ao banco do ambiente; valor não publicado |
| BILLING_PUBLIC_API_URL | Variável existente; quando definida, precisa corresponder ao origin do ambiente |
| AUTH_* e demais existentes | Autenticação/Origin/sessões existentes, preservadas |
| NEXT_PUBLIC_API_URL | Somente URL pública do Kalend API, configurada no build Web; não é chave Evolution |

Sem nova variável pública de chave. Nenhum arquivo de ambiente foi alterado. Workflows intactos, Node 24.21.0:
- API: npm ci → prisma generate → prisma migrate deploy → npm run build → restart PM2 → health check;
- Web: npm ci → npm run build -- --webpack → restart PM2.

Esses passos foram **confirmados pela leitura**, não executados no deploy. API e Web têm workflows independentes; homologação deve publicar API/migrations antes de validar Web. A Evolution continua na infraestrutura pública oficial, sem badge Sandbox/seletor no canal; namespace DEV é separação de instâncias, não sandbox do WhatsApp.

## 11. Validação local

- API npm test: **628 casos / 38 arquivos aprovados**.
- API e2e: **119 casos / 6 arquivos aprovados**.
- Evolution HTTP/TLS integrada: **21 casos**, incluídos na suíte API, mantendo controllers/guards/cliente reais, Evolution simulada e três fluxos React reais no workspace conjunto.
- Web npm test: **16 arquivos aprovados**; Evolution específica: **25 casos aprovados**.
- Lint/build API e Web webpack aprovados; Prisma validate aprovado; git diff --check aprovado nos dois.
- Preflight por snapshot executado localmente com sucesso; CLI e helpers têm testes de incompatibilidade, recusa de produção e sanitização. Nenhum cliente de banco real foi conectado nos testes.
- Hashes das migrations anteriores conferidos; terceira migration comparada ao diff de schemas sem banco e acrescida do CHECK específico.

Tests/HTTP/subprocessos usam Node 24 existente e autorização de execução fora do sandbox quando necessária. Nenhuma dependência/infra foi instalada. Os resultados não significam funcionamento na VPS, PostgreSQL real ou aparelho físico.

## 12. Arquivos e pendências

Correção API: evolution-environment.ts/spec; evolution.ts; evolution.spec.ts; evolution-flow.integration.spec.ts; evolution-preflight.ts; evolution-preflight-cli.spec.ts; scripts/evolution-preflight.mjs; test/support/evolution-database.ts; prisma/schema.prisma; terceira migration; esta documentação.

Correção Web: components/evolution-settings.tsx; tests/evolution.test.cjs; docs/EVOLUTION-INTEGRATION.md. Alterações anteriores dos dois projetos foram preservadas.

Homologação real pendente (**NÃO VALIDADO**): ambiente/secrets publicados; propriedade de instâncias legacy; transição DEV sem perder dados comerciais; DDL/dados DEV; concorrência PostgreSQL/réplicas; callback público e token; QR real após limite, POST restart e races com conexão de celular; pairing/telefone após expiração; logout/delete/reconexão; isolamento DEV/produção; logs do provedor; navegador/aparelho real.

Fontes oficiais da tag 2.3.7: [controller connect/restart](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/controllers/instance.controller.ts), [rotas](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/instance.router.ts), [Baileys e limite QR](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts), [monitor no.connection](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/services/monitor.service.ts), [webhook/logging](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/event/webhook/webhook.controller.ts).

SEM GIT ADD.
SEM COMMIT.
SEM PUSH.
SEM DEPLOY.
SEM RESTART PM2.
SEM MIGRATION APLICADA.
