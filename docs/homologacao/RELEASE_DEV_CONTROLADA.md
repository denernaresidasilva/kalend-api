# Release DEV candidata — procedimento pendente, não executado

Data: 22/10/2026. Repositórios API e Web em develop. Nenhum push foi feito.

## Gate operacional

O acesso SSH observado é root (UID 0). Os workflows usam secrets DEV_SSH_USER/KEY, cujo valor/escopo não foi verificado; nomes de secrets não demonstram isolamento. O workflow API aplica `prisma migrate deploy` antes do build e não exige testes, backup ou aprovação de ambiente. Ambos fazem reset remoto e compilam dentro do diretório em uso. Não há deploy atômico ou recuperação automática comprovada. Push para develop está bloqueado nesta entrega.

Privilégio mínimo: credenciais SSH separadas para kalend-api-dev e kalend-dev; sem sudo amplo, acesso aos diretórios DEV e PM2_HOME próprios; banco/role restrito a kalend_dev, sem privilégios em kalend. Chave CI deve ter comando restrito ou wrapper root-owned que valide serviço/branch/paths e não permita shell arbitrário. Segredos não entram no Git. Alterar acessos/units é intervenção remota separada, não autorizada implicitamente por este documento.

## Sequência exata de preparação

1. Aprovar o par de commits candidatos e seus hashes de árvore; revisar o diff, inclusive os trabalhos financeiros anteriores. Conferir se o remoto tem mudanças posteriores antes de preparar qualquer push (fetch somente leitura remota e sem reset local).
2. Auditar permissões efetivas das duas credenciais CI e do usuário/role PostgreSQL. Comprovar ausência de sudo amplo e acesso a PROD. Sem essa evidência, solicitar intervenção específica ou provisionamento de acesso restrito.
3. Criar um job de validação separado de deploy, com lock/concurrency que não cancele uma migration em execução, actions fixadas por SHA revisado e environment protegido DEV. Não acionar o workflow atual como ensaio. Publicar uma branch sem gatilho de deploy apenas após auditar todos os gatilhos remotos e obter os pré-requisitos; esta tarefa não realizou push.
4. Somente mediante acesso restrito/autorização: inventariar schema e classificar o legado em transação READ ONLY. Reproduzir os casos ambíguos em cópia protegida, sem exportar dados reais para diretório público. A migration deve abortar com ENTITLEMENT_BACKFILL_REQUIRES_REVIEW se houver lacunas; não inventar grants/pagamentos para contornar o guard.
5. Preparar backup consistente somente de kalend_dev, local protegido, hash, tamanho, timestamp e confirmação de restauração em banco isolado. Definir retenção sem apagar backups existentes. Nenhum backup foi criado nesta auditoria.
6. Ensaiar migration em cópia isolada com volumetria equivalente; medir duração e locks. A migration contém DDL/índices, leitura de históricos e alteração de funções/triggers em transação. Os testes pequenos não estimam locks em dados reais. Definir limites de espera/execução na conexão migradora e plano de abortar, sem editar migration já aplicada nem fazer reset.
7. Preparar artefatos de release fora do diretório ativo, Node 24.21.0, dependências de lockfile, Prisma generate e build. Verificar o artefato ESM dist/main.js e comando direto Node; não usar nest start. Não imprimir .env nem copiar secrets para units.
8. Revisar compatibilidade durante a troca: funções SQL novas são usadas por comunicação e o novo código exige as tabelas. Programar uma janela DEV controlada e coordenar somente processos/workers DEV autorizados; não modificar timers ou parar nada nesta fase. Aprovar expressamente eventual indisponibilidade DEV.
9. Aplicar a migration somente após backup/ensaio/aprovação. Ativar os artefatos e reiniciar somente kalend-api-dev e kalend-web-dev no usuário correto, quando autorizado. Validar dumps/startup para não reintroduzir Nest CLI ou Mailpit; não executar pm2 save indiscriminado. Não tocar PROD nem outros serviços.
10. Executar a homologação QA abaixo, registrar commit, IDs de fixture/provedor redigidos, timestamps e resultados. Encerrar a janela apenas com estabilidade e nenhuma regressão nos serviços preservados.

## Homologação após publicação

- Contas QA explícitas Super Admin, OWNER, PROFESSIONAL e CLIENT, tenants A/B descartáveis e isolados. Não reutilizar Companies QA KALEND 4 / QA Billing Lifecycle para reset ou mutações históricas.
- Browser real → API → PostgreSQL: login/refresh/logout/revogação/desativação, CORS/Origin/cookies, negação 401/403, IDOR, seleção cruzada, mutação de valores/assinatura, bloqueio administrativo.
- Contratação sandbox correlacionada: trial/expiração, checkout, pending/approved/failed/overdue, primeira cobrança sem GRACE, renovação com graça legítima, suspensão, recuperação, cancelamento, estorno parcial/integral e callbacks duplicados/fora de ordem. Conferir Payment, Subscription, Entitlement, acesso, receita, auditoria e UI. Não usar cobrança real.
- Comunicação: validar geração → outbox → delivery → worker → aceite → entrega por canal. Destinatários QA allowlisted, sink de e-mail autorizado, instância WhatsApp QA e aparelho controlado. Mailpit desligado não autoriza fallback SMTP real.
- Push BUG-01: perfil afetado autorizado, permissão, origem, SW ativo/controlador, dispositivo, tenant e subscription do próprio usuário; evidência de não reaparecer convite com granted e de recebimento. Não apagar subscriptions de terceiros. Testes sintéticos já passaram e não encerram o incidente real.
- Todos os P0/P1 devem estar encerrados na release; não liberar novos painéis apenas por HTTP 200. Startup dinâmico systemd exige tarefa/autorização própria, sem reboot global.

## Recuperação

Antes da troca: cancelar publicação sem afetar os processos atuais. Se a migration abortar, confirmar rollback transacional e estado de _prisma_migrations antes de nova tentativa; não executar resolve/reset cegamente. Se houve commit da migration, rollback de código não a desfaz e as funções comerciais mudaram. Preferir correção forward validada. Restauração de snapshot requer janela DEV, avaliação de escritas posteriores e autorização específica; não executar SQL destrutivo improvisado. Manter artefatos, dumps seguros e backup protegido. Nenhum rollback de produção faz parte deste plano.
