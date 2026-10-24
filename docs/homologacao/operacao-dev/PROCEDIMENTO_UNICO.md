> **Atualização de 24/10/2026:** a proposta de publicação manual deste documento
> foi superada pela decisão do proprietário de manter GitHub Actions por push em
> develop. Preservado como histórico técnico; não executar a sequência de publicação
> manual nem desabilitar Actions com base neste documento. Os verificadores offline
> associados não são um executor nem uma aprovação do fluxo atual. As restrições
> DEV/PROD e os achados de privilégios continuam válidos.

# Intervenção mínima e release DEV — proposta única para revisão humana

**NÃO EXECUTADA. Não autoriza push ou escrita remota nesta tarefa.**
Candidatos de aplicação: API db182667ca565bdb18370dc1c209d129e6e139a0;
Web 5c7bf8c792050cb9ed9d69a4dd73c2062bc5f326. Novos commits são operacionais,
sem alteração de código de produto. Os testes financeiros permanecem aplicáveis.

## Decisão A versus B

| Opção | O que exige para proteger PROD | Decisão |
|---|---|---|
| A delimitada | Retirar sudo SOMENTE dos executores DEV; separar roles DEV; peer/HBA; impedir uso das credenciais SQL antigas por TCP; neutralizar gatilhos | Escolhida: mantém CloudPanel, Nginx, PM2, diretórios e aplicações existentes |
| B única supervisionada | Os MESMOS controles enquanto código/hook/runtime puder executar como usuários DEV; ou sandbox/proxies novos para todas as integrações | Não reduz o conjunto de controles; não é atalho seguro |

A publicação será humana/supervisionada após A, sem identidade CI com SSH.
Root apenas prepara metadados/configurações aprovadas. Node/npm/Prisma/PM2 e
promoção de aplicação executam como usuários não root. Não criar um executor root
que receba shell, SQL, URL ou paths arbitrários do CI.

## Fatos novos e controle da credencial legada

Leitura de srv1119527 confirmou UIDs DEV 1021/1022, PROD 1019/1020; API DEV ainda
usa a role SQL kalend compartilhada. Os usuários DEV possuem sub-UID/sub-GID:
1148576:65536 e 1214112:65536, sem sobreposição com outros usuários no inventário.
Logo, trocar DATABASE_URL e chown de tabelas NÃO elimina a credencial antiga.

A tabela nft **exclusiva** inet/kalend_dev_release rejeita TCP/5432 somente dos
UIDs DEV, do migrador dedicado e de TODAS suas faixas sub-UID. Demais UIDs/portas
não são selecionados. Não dá flush nem substitui regras UFW/Docker/fail2ban.
Runtime e migrador usam exclusivamente socket PostgreSQL + peer/ident por OS UID.
A credencial kalend antiga não autentica por peer sob esses usuários e não pode
ser usada por TCP. Não é necessário alterar senha/role/configuração de PROD.

nft 1.0.9 está instalado; UFW ativo; nftables.service desabilitado. Validar que UFW,
CloudPanel e rotinas administrativas não removem a tabela dedicada em reload/boot.
Esse ponto NÃO foi testado por reload real e é gate obrigatório. Sub-UIDs futuros
exigem revalidação antes de uso: não remover essa cobertura nem desabilitar userns
globalmente. Conferir também grupos, capabilities, helpers/SUID e acesso a sockets
privilegiados; uma via administrativa adicional bloqueia a intervenção.

## 0. Revisão administrativa antes de qualquer escrita

Operador precisa comprovar console de recuperação independente, ausência de
intervenção concorrente, hostname, disponibilidade, espaço, PIDs e identidades.
Aceitar inventário CloudPanel e confirmar que retirar sudo apenas dos dois usuários
não rompe administração legítima: transferir essa administração para humano se
necessário. Não retirar clp/ALL globalmente. Não executar o wrapper como teste.

GitHub: há um workflow em develop de cada repo; main não tem workflows. Foram
consultados todos os 29/22 runs retornados: nenhum pendente no momento da coleta.
Isso não prova ausência futura de corrida, hooks, Apps ou CI externo. O conector
não expõe administração desses itens; o administrador deve inventariar Settings
→ Webhooks, Apps/Integrations, Actions/runners, deployments/environments e CI externo.

O administrador GitHub deve pausar Actions NOS DOIS repositórios e os consumidores
externos relevantes ANTES do push; revisar todos os runs, não apenas o mais recente.
Registrar IDs/configuração anterior sem tokens/URLs privadas. Não desabilitar Apps
organizacionais ou integrações de outros projetos. Se não houver controle desse
caminho, parar sem escrita na VPS/push. Não usar secrets CI mascarados como prova
sobre o usuário SSH efetivo. Não abrir credencial SSH nova para CI nesta operação.

Arquivos locais deploy-dev.yml agora são verificadores manuais SEM SSH, secrets,
build, migration ou deploy. Remoto permanece antigo até publicação autorizada.
workflow_dispatch depende de arquivo na default branch; como main está fora do
escopo e sem workflow, NÃO depender de despacho desse job. A verificação de versões
é local, e o arquivo manual é somente substituto inerte do gatilho push. Não mudar
main/default branch para contornar esse requisito.

## 1. Backup administrativo e preparação — humano root

Todos os comandos desta seção são FUTUROS. Executar em bash, não copiar placeholders.
Staging /root/kalend-dev-release-stage deve conter somente pacote revisado e hashes,
root:root 0700. Nenhum segredo, dump ou .env é versionado nesse pacote.

```sh
set -euo pipefail
umask 077
test "$(hostname -s)" = srv1119527
test "$(id -u)" = 0
cd /root/kalend-dev-release-stage
sha256sum -c docs/homologacao/operacao-dev/SHA256SUMS
op_backup=$(mktemp -d /root/kalend-dev-release-config.XXXXXXXX)
tar --acls --xattrs --numeric-owner -cpf "$op_backup/config.tar" \
 /etc/sudoers /etc/sudoers.d /etc/postgresql/16/main/pg_hba.conf \
 /etc/postgresql/16/main/pg_ident.conf /etc/systemd/system/pm2-kalend-dev.service \
 /etc/systemd/system/pm2-kalend-api-dev.service \
 /etc/systemd/system/kalend-communication-worker-dev.service \
 /etc/systemd/system/kalend-communication-worker-dev.timer
sha256sum "$op_backup/config.tar" > "$op_backup/SHA256SUMS"
```

Registrar também estados enabled/active, dados PM2/dumps/backs privados e catálogo
owner/ACL/default privileges de DEV. Adaptar o manifesto se algum path divergir,
ANTES de executar; não ignorar falha de tar. Salvar diff e regras nft existentes
privadamente para comparar, não exportar regras de outros projetos para Git.

A decisão operacional deve nomear explicitamente o timer/service de comunicação DEV
listado acima. Não parar/reiniciar PostgreSQL, Redis, Docker, Evolution, Nginx ou PROD.

## 2. Janela e isolamento — humano root; somente objetos DEV

Parar agendamento DEV e aguardar worker inativo antes de parar sua unit. Registrar
o estado para recuperação; não disparar worker para testar. Parar os dois apps
exclusivamente por nome no PM2 de seus usuários, após lista privada confirmar que
não há outro consumidor/instância concorrente. Não usar pm2 all/kill/resurrect.

```sh
systemctl stop kalend-communication-worker-dev.timer
worker_state="$(systemctl is-active kalend-communication-worker-dev.service || true)"
test "$worker_state" = inactive || { echo "PARAR: worker ainda ativo/falhado" >&2; exit 1; }
# Se estiver processando: aguardar drenagem aprovada; não matar tarefa comercial.
# Só depois de inativo, garantir que a unit não permaneça em execução:
systemctl stop kalend-communication-worker-dev.service
runuser -u kalend-dev -- env -i HOME=/home/kalend-dev PM2_HOME=/home/kalend-dev/.pm2 \
 PATH=/home/kalend-dev/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin \
 /home/kalend-dev/.nvm/versions/node/v24.21.0/bin/node \
 /home/kalend-dev/.nvm/versions/node/v24.21.0/lib/node_modules/pm2/bin/pm2 stop kalend-web-dev
runuser -u kalend-api-dev -- env -i HOME=/home/kalend-api-dev PM2_HOME=/home/kalend-api-dev/.pm2 \
 PATH=/home/kalend-api-dev/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin \
 /home/kalend-api-dev/.nvm/versions/node/v24.21.0/bin/node \
 /home/kalend-api-dev/.nvm/versions/node/v24.21.0/lib/node_modules/pm2/bin/pm2 stop kalend-api-dev
```

Esse stop é SOMENTE parte da futura janela autorizada. Verificar portas 3002/3003
sem concorrente e todos os processos/sessões DEV drenados. Não iniciar candidato
se CI externo/sessão de deploy ainda puder concorrer.

Após inventário CloudPanel aceito, negar sudo antes de criar o migrador:

```sh
test ! -e /etc/sudoers.d/zz-kalend-dev-release-deny
visudo -c -f docs/homologacao/operacao-dev/sudoers.conf
install -o root -g root -m 0440 docs/homologacao/operacao-dev/sudoers.conf /etc/sudoers.d/zz-kalend-dev-release-deny
visudo -c
if getent passwd kalend-dev-release >/dev/null; then exit 1; fi
useradd --system --user-group --no-create-home --home-dir /var/lib/kalend-dev-release --shell /usr/sbin/nologin kalend-dev-release
install -d -o kalend-dev-release -g kalend-dev-release -m 0700 /var/lib/kalend-dev-release
for u in kalend-dev kalend-api-dev kalend-dev-release; do
 id "$u"
 sudo -l -U "$u"
 if sudo -l -U "$u" /usr/bin/clpctlWrapper; then exit 1; fi
done
```

Revisar listagem inteira: nenhum comando permitido, sem grupos privilegiados,
ACL/capability/helpers administrativos adicionais. Sem chaves/SSH para migrador.
Não presumir que visudo ou apenas negação do wrapper comprovem o resto da política.

Preparar somente novos arquivos sob /etc/kalend-dev-release e um serviço dedicado:

```sh
test ! -e /etc/kalend-dev-release
test ! -e /etc/systemd/system/kalend-dev-sql-fence.service
install -d -o root -g root -m 0755 /etc/kalend-dev-release
python3 -I scripts/ops/collect_identities.py > "$op_backup/identities.private.json"
set -C
python3 -I scripts/ops/release_safety.py --render-fence "$op_backup/identities.private.json" > /etc/kalend-dev-release/sql-fence.nft
set +C
chmod 0644 /etc/kalend-dev-release/sql-fence.nft
nft -c -f /etc/kalend-dev-release/sql-fence.nft
if nft list table inet kalend_dev_release >/dev/null 2>&1; then exit 1; fi
install -o root -g root -m 0644 docs/homologacao/operacao-dev/kalend-dev-sql-fence.service /etc/systemd/system/kalend-dev-sql-fence.service
systemd-analyze verify /etc/systemd/system/kalend-dev-sql-fence.service
```

Se a tabela já existir, PARAR; não fazer flush para forçar sucesso. Criar drop-ins
require-fence.conf apenas das duas units PM2 DEV e da unit do worker DEV, arquivo
90-kalend-dev-fence.conf novo, root:root 0644; preservar qualquer outro drop-in.
Diretório existente deve ser confiável, sem chmod/chown indiscriminado de pais.

```sh
for unit in pm2-kalend-dev.service pm2-kalend-api-dev.service kalend-communication-worker-dev.service; do
 d="/etc/systemd/system/$unit.d"
 if test ! -e "$d"; then install -d -o root -g root -m 0755 "$d"; fi
 test ! -e "$d/90-kalend-dev-fence.conf"
 install -o root -g root -m 0644 docs/homologacao/operacao-dev/require-fence.conf "$d/90-kalend-dev-fence.conf"
done
```
 O timer não executa código próprio. Registrar que os
daemons PM2 atuais estão fora das units (units inativas): drop-in sozinho não os
confina. A tabela nft LIVE protege seus UIDs; NoNewPrivileges protege os futuros
processos gerenciados. A adoção systemd posterior permanece verificação separada.

```sh
systemctl daemon-reload
systemctl enable --now kalend-dev-sql-fence.service
nft -j list table inet kalend_dev_release
```

Conferir UIDs/faixas, counters e regra LIVE; testar somente em fixture descartável,
sem tentar escrita/conexão em PROD. Validar preservação por UFW/boot sob plano
aprovado; não executar reboot/reload global como teste nesta janela. Se a persistência
não puder ser comprovada por configuração/ordem/teste isolado equivalente, parar.
Nenhum ExecStop da nova unit remove a proteção enquanto um daemon possa estar vivo.

## 3. Banco DEV — humano DBA para configuração; migrador NOSUPERUSER para DDL da release

Backup NOVO consistente de kalend_dev e restore verificado, método já comprovado,
antes da mudança; classificador READ ONLY revalidado com dados atuais. Capturar
owner/ACL para rollback antes do isolamento, somente neste banco:

```sh
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql \
 /usr/lib/postgresql/16/bin/psql -X -qAt -v ON_ERROR_STOP=1 -d kalend_dev \
 < docs/homologacao/operacao-dev/capture-ownership-rollback.sql > "$op_backup/ownership-rollback.private.sql"
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql \
 /usr/lib/postgresql/16/bin/psql -X -v ON_ERROR_STOP=1 -d kalend_dev \
 < docs/homologacao/operacao-dev/isolate-dev.sql
```

Isso é provisionamento administrativo delimitado, NÃO execução da migration como
superuser. Script guarda banco/owners/schema/roles e aplica atomicamente só DEV;
não altera role kalend/senha/objetos de PROD nem usa REASSIGN OWNED. Criar roles
novas já com peer e sem senha, sem membership antiga e sem privilégios de cluster.

Inserir blocos marcados pg_hba.fragment.conf e pg_ident.fragment.conf antes dos
allows genéricos, preservando todos os demais bytes e owner/mode. Conferir views
pg_hba_file_rules/pg_ident_file_mappings sem erro; reload PostgreSQL autorizado
por pg_reload_conf(), sem restart. A ordem é essencial, pois PUBLIC pode permitir
CONNECT em outros bancos. Não revogar PUBLIC globalmente.

Alterar SOMENTE DATABASE_URL do runtime DEV em cópia privada de .env e na definição
PM2 aprovada: URI sem senha `postgresql://kalend_dev_runtime@localhost:5432/kalend_dev?host=%2Fvar%2Frun%2Fpostgresql`.
Conservar outros valores apenas após revisão privada de escopo DEV/sandbox, inclusive
JWT, integrações e chaves; credencial PROD compartilhada fora SQL é impeditivo.
Não imprimir valores. Não confiar em dotenv para sobrepor env antigo do PM2.

Remover env legado dos dumps/backs ativos DEV SOMENTE depois de revisar lista exata
com um app autorizado por daemon; arquivar originais privadamente, sem Mailpit.
Nenhum pm2 save indiscriminado. Credencial antiga remanescente não é a fronteira:
a fronteira é peer por OS UID + rejeição TCP UID/sub-UID, que deve permanecer LIVE.

## 4. Publicação de código, build e artefatos — operador local e usuários não root

Somente após Actions/hooks/Apps/CI externo pausados e autorização de publicação:
publicar commits operacionais aprovados por fast-forward, SEM force/main. Não
usar push como teste. Os artefatos continuam presos aos SHAs de aplicação testados,
independentes dos commits de documentação/workflow. Conferir árvores e manifests.

Na estação: git archive dos SHAs aprovados, revisar caminhos/symlinks e rejeitar
.env privado, dumps, submódulos ou arquivos fora da raiz. Copiar somente source e
artefatos aprovados, nunca chaves privadas ou dados DEV. Build pode ser local Linux
compatível ou scratch DEV sob kalend-dev (sem role peer SQL), com fence/sudo já
validados; NÃO usar o migrador para executar hooks de build.

Executar npm ci --ignore-scripts, Prisma generate explícito com config inerte e
build aprovado, com env -i, HOME scratch, NPM_CONFIG_USERCONFIG=/dev/null e SEM
credenciais runtime/migration. Se algum install script for necessário, parar e
revisar esse comando específico; não habilitar todos os hooks por conveniência.
Validar Node 24.21.0, arquitetura e bindings nativos antes da janela de ativação.

Candidatos ficam no mesmo filesystem e parent de app: candidate.<SHA>. Administrador
verifica hashes e cria RELEASE.json root-owned legível ao usuário do serviço,
com sha e database=kalend_dev, e aprova /etc/kalend-dev-release/approved.json
root:root, sem escrita por terceiros. Esse arquivo não contém credenciais e
seleciona os SHAs exatos; registrar inventory/gates em área privada. O helper de
promoção NÃO substitui a verificação de hash nem é fronteira contra código do próprio
UID; ele apenas impede paths/ref acidentais, symlinks e sobrescrita do backup.

Instalar scripts de operação root-owned 0755 sob /usr/local/libexec/kalend-dev-release/
para chamadas fixas e /opt/kalend-dev-release/node-v24.21.0/bin/node aprovado por
hash. Não executar Node/npm de home gravável como root. Paths de app permanecem
os anteriores, evitando mudar Nginx/upstreams e regras de startup por release.

## 5. Migration, promoção, ativação e homologação — passos separados

Antes do DDL real, coletar TODOS os gates e executar a validação local/offline.
release_safety.py não executa comandos, mesmo com input fabricado; o operador
precisa das provas efetivas. Gate atual do pacote deliberadamente reprova.

Instalação dos arquivos fixos de configuração, por humano root, após validar
artefato e paths. Estes arquivos não contêm secrets nem iniciam processos:

```sh
for f in pm2-api.json pm2-web.json prisma.migration.config.mjs; do
 test ! -e "/etc/kalend-dev-release/$f"
 install -o root -g root -m 0644 "docs/homologacao/operacao-dev/$f" "/etc/kalend-dev-release/$f"
done
```

Preparar config Prisma root-owned com schema/migrations do artefato aprovado e
URL FIXA `postgresql://kalend_dev_migrator@localhost:5432/kalend_dev?host=%2Fvar%2Frun%2Fpostgresql&options=-c%20lock_timeout%3D3000%20-c%20statement_timeout%3D30000`.
Nenhum segredo ou datasource herdado de .env. Confirmar current_database/current_user,
flags, ledger e hashes. Migração roda como OS kalend-dev-release e SQL migrator:

```sh
runuser -u kalend-dev-release -- env -i HOME=/var/lib/kalend-dev-release PATH=/usr/bin:/bin \
 DOTENV_CONFIG_PATH=/dev/null CHECKPOINT_DISABLE=1 \
 /opt/kalend-dev-release/node-v24.21.0/bin/node \
 /srv/kalend-dev-migration/db182667ca565bdb18370dc1c209d129e6e139a0/node_modules/prisma/build/index.js \
 migrate deploy --config /etc/kalend-dev-release/prisma.migration.config.mjs
```

O pacote de migração fica EXCLUSIVAMENTE em /srv/kalend-dev-migration/<SHA>, root-owned,
legível ao migrador. Copiar somente schema/migrations/dependências/CLI aprovados,
SEM .env. A config Prisma aponta para esse mesmo diretório. Não abrir home API
0770 nem adicionar migrador ao grupo que lê secrets. Não há path alternativo
arbitrário recebido de CI. Node aprovado por hash sob /opt, nunca executado como root.

Após ledger concluído/backfill verificado, promover por serviço como seu usuário:

```sh
runuser -u kalend-api-dev -- env -i PATH=/usr/bin:/bin /usr/bin/python3 -I /usr/local/libexec/kalend-dev-release/promote_dev.py api db182667ca565bdb18370dc1c209d129e6e139a0
runuser -u kalend-dev -- env -i PATH=/usr/bin:/bin /usr/bin/python3 -I /usr/local/libexec/kalend-dev-release/promote_dev.py web 5c7bf8c792050cb9ed9d69a4dd73c2062bc5f326
```

Não iniciar API antiga entre schema novo e ativação da candidata. Helper mantém
previous-before-<SHA> e não inicia processo algum; erro na segunda rename restaura
apenas o path, NÃO significa rollback de schema nem autorização para iniciar código.

Ativação: usar os arquivos pm2-api.json/pm2-web.json preparados a partir das definições
sanitizadas observadas (um app por daemon; max_restarts=1, min_uptime=60000,
watch=false, nenhum argumento Node extra). Copiar root-owned sem secrets para
/etc/kalend-dev-release/, validar e executar SOMENTE após promoção/schema/backup:

```sh
runuser -u kalend-api-dev -- env -i HOME=/home/kalend-api-dev PM2_HOME=/home/kalend-api-dev/.pm2 \
 PATH=/home/kalend-api-dev/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin \
 /home/kalend-api-dev/.nvm/versions/node/v24.21.0/bin/node \
 /home/kalend-api-dev/.nvm/versions/node/v24.21.0/lib/node_modules/pm2/bin/pm2 delete kalend-api-dev
runuser -u kalend-api-dev -- env -i HOME=/home/kalend-api-dev PM2_HOME=/home/kalend-api-dev/.pm2 \
 PATH=/home/kalend-api-dev/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin \
 /home/kalend-api-dev/.nvm/versions/node/v24.21.0/bin/node \
 /home/kalend-api-dev/.nvm/versions/node/v24.21.0/lib/node_modules/pm2/bin/pm2 start /etc/kalend-dev-release/pm2-api.json --only kalend-api-dev
runuser -u kalend-dev -- env -i HOME=/home/kalend-dev PM2_HOME=/home/kalend-dev/.pm2 \
 PATH=/home/kalend-dev/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin \
 /home/kalend-dev/.nvm/versions/node/v24.21.0/bin/node \
 /home/kalend-dev/.nvm/versions/node/v24.21.0/lib/node_modules/pm2/bin/pm2 delete kalend-web-dev
runuser -u kalend-dev -- env -i HOME=/home/kalend-dev PM2_HOME=/home/kalend-dev/.pm2 \
 PATH=/home/kalend-dev/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin \
 /home/kalend-dev/.nvm/versions/node/v24.21.0/bin/node \
 /home/kalend-dev/.nvm/versions/node/v24.21.0/lib/node_modules/pm2/bin/pm2 start /etc/kalend-dev-release/pm2-web.json --only kalend-web-dev
```

Executar apenas se a lista salva/ativa e inventário ainda corresponderem; se nome
sumiu ou processo diferente apareceu, PARAR e não repetir delete/start. O delete
é da definição específica já parada, com backup preservado, não exclui dados.
PM2 nos DOIS contextos originais, exclusivamente kalend-api-dev e kalend-web-dev. Usar definição revisada/env limpo para não herdar DATABASE_URL antiga;
API Node dist/main.js ESM, Web npm start/next start conforme definição validada,
portas 3003/3002, proteções de restart preservadas. Se definir processo novo, remover
somente o nome antigo após backup/lista revisada e iniciar somente o mesmo nome;
nenhum root PM2, all, kill, resurrect ou Mailpit. Salvar apenas lista correta e
validar dump principal/backup para reboot (método anterior já preparado).

Health de Web e /health, versão realmente implantada, banco/schema, logs e restart
loop, PIDs PROD/Redis/PostgreSQL/Docker/Evolution preservados. Health 200 sozinho
não homologa. Testar login/tenants A/B, pagamento sandbox e comunicação QA com
allowlist antes de declarar Super Admin homologado. Não retomar timer comercial
somente para provar entrega; retomada deve ter autorização e provedores QA seguros.

## Falha, parada e recuperação

Qualquer gate falso/desconhecido, colisão de UID/range/arquivo/role, acesso sudo,
credencial compartilhada fora controle, ausência de fence, parser inválido,
ambiguidade financeira, falha de build/backup/restore = parar antes do DDL.
Sem improvisar SSH/sudo/root, aumentar privilégios ou liberar firewall global.

Antes do DDL: preservar artefato antigo; rollback administrativo de ownership só
com script capturado, roles criadas por esta operação e schema ainda antigo. Script
recusa PaymentEvidence presente; qualquer dependência extra aborta a transação.
Não remover fence/sudo deny enquanto código DEV puder usar credencial legada.
Voltar à política antiga reabre risco anterior e NÃO permite publicar candidato.

Após falha de migration: inspecionar schema/fingerprints/funções/ledger e logs,
pois CLI pode mostrar 25P02 enquanto servidor registra lock timeout. Somente após
rollback integral comprovado considerar resolve --rolled-back específico; nunca
resolve/reset/seed automático. Cancelamento perto do COMMIT pode ser ambíguo.

Após COMMIT ou falha de API/Web/health: manter janela, NÃO ligar API antiga nem
restaurar banco automaticamente. Preferir correção forward compatível. Código
anterior só pode voltar se compatibilidade com schema novo for comprovada e aprovada.
Restore exige decisão específica sobre escritas posteriores, destino DEV e retenção;
nenhum --clean/--create contra banco real nesta proposta. Não há rollback de PROD.

Desinstalação do isolamento só com todos os processos/sessões DEV/migrador parados,
sem desfazer mudanças de terceiros: retirar apenas novos drop-ins/unit, tabela
inet/kalend_dev_release e blocos HBA/ident próprios; parsers antes de reloads
específicos. Nunca restart/flush global, restauração de passwd/sudoers inteiros,
DROP OWNED, REASSIGN OWNED global, userdel -r ou exclusão de backups.

## Fontes e limite de validação

- https://netfilter.org/projects/nftables/manpage.html — meta skuid/hook output.
- https://www.postgresql.org/docs/16/auth-pg-hba-conf.html — primeira regra HBA.
- https://www.postgresql.org/docs/16/ddl-priv.html — ownership e privilégios.
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository — pausar Actions.
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow — workflow_dispatch/default branch.

Testado localmente: parser/pacotes, UID fence IPv4/IPv6 em namespace, SQL/HBA/owner
em cluster descartável, falhas de gates/ordem/migration/startup/health e promoção
com preservação do anterior. NÃO equivale a validação do firewall/UFW/CloudPanel
ou identidade CI efetiva na VPS após instalação. Esse aceite ocorre dentro da
intervenção autorizada; nada foi instalado nesta tarefa.
