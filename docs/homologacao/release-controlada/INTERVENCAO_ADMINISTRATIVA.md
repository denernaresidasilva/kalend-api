# Intervenção administrativa DEV — revisão final para humano

**NÃO EXECUTADA. Plano original: REQUER CORREÇÕES, incorporadas nesta versão.**

Escopo mínimo da autorização inicial: inventário e fase A (novo auditor SQL). A fase B, que altera as contas DEV existentes, exige inventário aprovado de dependências CloudPanel. Backup/restore é fase C separada. Nenhuma fase deste plano autoriza push, deploy, migration comercial, restart PM2 ou mudança em PROD. O verificador de release continua sem comando de ativação.

## 1. Evidência e limites

Histórico de 22/10: usuários DEV 1021/1022 sem acesso direto aos paths PROD inspecionados, mas regra ALL permite clpctlWrapper; wrapper encaminha comandos a clp; clp possui sudo amplo. A regra global e o usuário clp são parte do funcionamento CloudPanel: NÃO remover, editar ou restringir indiscriminadamente. O código de uma aplicação sob identidade com caminho administrativo não está isolado só porque entrou por chave forçada.

A lista completa de consumidores do wrapper não é conhecida nos documentos locais. Ver [inventário obrigatório](DEPENDENCIAS_CLOUDPANEL.md). Esta revisão não fez SSH nem consulta à VPS. Também não confirmou a identidade CI por secrets mascarados, a ordem atual dos includes, ACL/PUBLIC/SECURITY DEFINER, RLS ou o backup real. Esses fatos são gates verificáveis pelo administrador, não suposições.

## 2. Pré-condições e parada

Antes de qualquer escrita administrativa: autorização da fase exata, hostname srv1119527, sessão de recuperação aberta, pacote revisado com hashes, origem das chaves públicas verificada fora de banda, espaço/inodes adequados e ausência de concorrência de outro administrador. Não imprimir .env, tokens, chaves privadas ou logs completos. Sem reset de checkout ou limpeza de backups.

O operador deve confirmar os paths reais de sshd_config/Includes, hba_file e ident_file, versão PostgreSQL e unit de reload SSH. Os paths abaixo são os conhecidos, não autorização para sobrescrever uma instalação diferente. **Parar** se conta/role/path novo já existir, algum alvo for symlink/gravável por DEV, um include posterior reabrir permissões, a versão não aceitar diretiva, houver erro de parser, acesso de recuperação divergir ou uma função legítima depender da permissão a retirar. Não improvisar flags de força.

## 3. Administrador: inventário e backup das configurações

Comandos propostos, não executados:

```sh
set -euo pipefail
umask 077
test "$(hostname -s)" = srv1119527
test "$(id -u)" = 0
# O staging abaixo deve ter sido criado pelo administrador, root:root 0700,
# sem arquivos recebidos de diretório público ou gravável por usuários DEV.
staging_dir=/root/kalend-admin-review-stage
test -d "$staging_dir"
stat -c '%U %G %a %n' "$staging_dir"
cd "$staging_dir"
sha256sum -c SHA256SUMS
admin_backup=$(mktemp -d /root/kalend-admin-access-backup.XXXXXXXX)
# Resolver e revisar antes os includes e paths PostgreSQL efetivos.
# O arquivo contém configurações privadas; jamais anexá-lo ao relatório público.
tar --acls --xattrs --numeric-owner -cpf "$admin_backup/access-config.tar" \
  /etc/sudoers /etc/sudoers.d /etc/ssh/sshd_config /etc/ssh/sshd_config.d \
  /etc/postgresql/16/main/pg_hba.conf /etc/postgresql/16/main/pg_ident.conf
sha256sum "$admin_backup/access-config.tar" > "$admin_backup/SHA256SUMS"
```

Se algum path não existir, parar e adaptar o manifesto revisado antes de criar backup; não ignorar erro de tar. Preservar arquivos de chaves centralizadas anteriores, se houver, separadamente com ACL/owner. Registrar quais novos alvos não existiam. Não copiar shadow ou restaurar passwd/sudoers global inteiro como rollback: isso poderia desfazer mudanças de outros sistemas. Executar e assinar o inventário do documento de dependências.

## 4. Fase A — somente nova identidade de auditoria

Não alterar shell, home, chaves ou sudo dos usuários existentes nesta fase.

### A1. Bloquear sudo da futura identidade antes de abrir seu acesso

```sh
# Verificar inexistência prévia de conta/role/path. Se existir, parar, não reaproveitar.
if getent passwd kalend_dev_audit >/dev/null; then exit 1; fi
test ! -e /etc/sudoers.d/zz-kalend-audit-deny
visudo -c
visudo -c -f sudoers-audit-only.conf
# Sem ponto no nome final: sudoers.d pode ignorar nomes contendo ponto.
install -o root -g root -m 0440 sudoers-audit-only.conf /etc/sudoers.d/zz-kalend-audit-deny
visudo -c
adduser --disabled-password --gecos '' --shell /bin/dash kalend_dev_audit
# Home não gravável evita substituição de .ssh, rc/profile/environment.
chown root:root /home/kalend_dev_audit
chmod 0755 /home/kalend_dev_audit
id kalend_dev_audit
sudo -l -U kalend_dev_audit
# Apenas consulta de política, NÃO executa o wrapper. Deve ser negado:
if sudo -l -U kalend_dev_audit /usr/bin/clpctlWrapper; then
  echo 'PARAR: wrapper permitido ao auditor' >&2
  exit 1
fi
# Revisar a listagem completa: !ALL deve prevalecer e nenhum outro comando ser permitido.
```

Aceite: grupo primário próprio, sem clp/docker/lxd/sudo/grupos PROD, e nenhum comando privilegiado permitido. Inspecionar toda a ordem efetiva dos includes: !ALL não é uma negação absoluta se uma regra posterior liberar novamente. Nenhuma chave é instalada antes disso. Validar ausência de ACL/capability adicional. A conta está com senha desabilitada; não definir senha ou habilitar password authentication para contornar falha de SSH.

### A2. Instalar arquivos confiáveis e acesso SSH somente da nova conta

```sh
test ! -e /usr/local/libexec/kalend-dev-audit
test ! -e /usr/local/share/kalend-dev-audit
# Pais compartilhados devem existir e ser confiáveis; NÃO mudar suas permissões.
test -d /usr/local/libexec
namei -l /usr/local/libexec
namei -l /usr/local/share
install -d -o root -g root -m 0755 /usr/local/share/kalend-dev-audit
install -o root -g root -m 0755 kalend-dev-audit /usr/local/libexec/kalend-dev-audit
install -o root -g root -m 0644 backfill-audit.sql /usr/local/share/kalend-dev-audit/backfill-audit.sql
test ! -e /etc/ssh/kalend-dev-keys
install -d -o root -g root -m 0755 /etc/ssh/kalend-dev-keys
# audit.authorized_keys: arquivo revisado com UMA chave pública real e opções restrict/command.
# Nunca instalar REPLACE_* literalmente, nem uma chave privada.
/usr/bin/python3 -I "$staging_dir/check-audit-public-key.py" audit.authorized_keys SHA256:MQmrBnZRCRjUppy8C6MC2hnQhA806Kq3bETpMPzmupI
install -o root -g kalend_dev_audit -m 0640 audit.authorized_keys /etc/ssh/kalend-dev-keys/kalend_dev_audit
namei -l /usr/local/libexec/kalend-dev-audit
namei -l /usr/local/share/kalend-dev-audit/backfill-audit.sql
namei -l /etc/ssh/kalend-dev-keys/kalend_dev_audit
# Executar check-audit-files.py depois de instalar também o fragmento SSH (abaixo).
```

Verificador e SQL rejeitam symlinks, ancestrais não root e qualquer permissão de escrita por grupo/outros. ACL com escrita também deve ser excluída. Uma chave guardada sob home gravável não é fronteira suficiente: o dono pode renomear o diretório, ainda que o inode do arquivo seja root-owned. Chaves centrais e home nova root-owned evitam esse problema. Dash não login -c não lê rc interativo; PermitUserRC=no, autenticação somente publickey e ambiente sanitizado são camadas adicionais.

Instalar `sshd-audit.fragment.conf` **somente em um ponto de Include já existente e confirmado**. Nome sugerido: /etc/ssh/sshd_config.d/90-kalend-audit.conf, se inexistente e nessa cadeia de inclusão. Se não houver Include ou houver Match anterior conflitante, parar e revisar um patch mínimo do arquivo principal; não acrescentar Include global cegamente. `PermitUserEnvironment` não pode ser definido em Match na versão local testada: exigir global no e AcceptEnv seguro; se houver LD_*, ENV, BASH_ENV, PYTHON* ou outras entradas perigosas, parar sem mudar o comportamento dos demais usuários.

```sh
# Capturar contextos ANTES de instalar este fragmento; repetir depois para comparar.
test ! -e /etc/ssh/sshd_config.d/90-kalend-audit.conf
install -o root -g root -m 0644 sshd-audit.fragment.conf /etc/ssh/sshd_config.d/90-kalend-audit.conf
/usr/bin/python3 -I "$staging_dir/check-audit-files.py"
/usr/bin/python3 -I "$staging_dir/check-audit-public-key.py" /etc/ssh/kalend-dev-keys/kalend_dev_audit SHA256:MQmrBnZRCRjUppy8C6MC2hnQhA806Kq3bETpMPzmupI
sshd -t
# Registrar antes/depois em área protegida para root, clp, usuários PROD e DEV.
# addr/host devem refletir origem real do operador e do CI, pois há Match por endereço.
sshd -T -C user=kalend_dev_audit,host=localhost,addr=127.0.0.1
sshd -T -C user=kalend,host=localhost,addr=127.0.0.1
sshd -T -C user=kalend-api,host=localhost,addr=127.0.0.1
# Somente após comparar todos os contextos não alvo e validar a sessão de recuperação:
# Reload SSH somente em A4, DEPOIS de validar a role/HBA em A3.
```

O reload é administrativo e só na futura autorização, não restart. Confirmar nome da unit, comparar também contextos reais por endereço/host. Critério: root/clp/PROD/DEV preexistentes idênticos; auditor com ForceCommand, chave central, nenhum forwarding/TTY/password/CA/AuthorizedKeysCommand externo. Não abrir um segundo mecanismo de login. `restrict` e ForceCommand não restringem por si o código de startup de uma conta existente; por isso não se aplica essa receita automaticamente aos usuários DEV atuais.

### A3. Role SQL e HBA restritos

Antes do SQL: administrador verifica que kalend_dev existe, role nova não existe, PUBLIC não permite escrita em tabelas, schema público não é criável por auditor, não há memberships/owners indevidos nem SECURITY DEFINER acessível capaz de escrita/elevação. Se houver, parar e apresentar alteração específica; não revogar EXECUTE/CREATE de PUBLIC globalmente. Role tem SELECT explícito; default read_only não é fronteira de segurança. `row_security=off` faz a consulta falhar quando RLS ocultaria registros, em vez de certificar relatório parcial.

```sh
# Provisionamento administrativo, não credencial de CI ou identidade de teste.
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql /usr/lib/postgresql/16/bin/psql -X -v ON_ERROR_STOP=1 -d kalend_dev < readonly-role.sql
```

O arquivo é transacional, recusa banco diferente de kalend_dev, cria role sem superuser/ownership/membership e limita conexões a duas. Sem grants em kalend, User, credenciais, provedores ou sequences. PUBLIC pode conceder CONNECT em outros bancos: HBA é necessário; não afirmar que apenas GRANT CONNECT em DEV nega acesso aos demais.

Inserir o bloco **marcado e limitado à nova role** de pg_hba.fragment.conf antes de regras genéricas, no hba_file efetivo. Não substituir o arquivo inteiro. Manter bytes das demais regras; não alterar pg_ident para o auditor, pois peer usa OS/SQL homônimos. Guardar diff revisado no backup administrativo.

```sh
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql /usr/lib/postgresql/16/bin/psql -X -d kalend_dev -c \
  'SELECT rule_number,file_name,line_number,type,database,user_name,auth_method,error FROM pg_hba_file_rules ORDER BY rule_number'
# Parar se existir qualquer erro ou precedência que contorne as regras.
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql /usr/lib/postgresql/16/bin/psql -X -d kalend_dev -c 'SELECT pg_reload_conf()'
```

Reload só após aprovação; não reinicia PostgreSQL nem desconecta sessões existentes. Confirmar que novas conexões das identidades não alvo continuam normais, sem executar mutações de aplicação. Não usar o superuser para testes automáticos de acesso.

### A4. Ativação SSH e aceite — após A3

Administrador: comparar novamente todos os contextos e executar somente após A3
passar, arquivos/grupo validados, sudo efetivamente negado e recuperação comprovada:

```sh
/usr/bin/python3 -I "$staging_dir/check-audit-files.py"
/usr/bin/python3 -I "$staging_dir/check-audit-public-key.py" /etc/ssh/kalend-dev-keys/kalend_dev_audit SHA256:MQmrBnZRCRjUppy8C6MC2hnQhA806Kq3bETpMPzmupI
sshd -t
systemctl reload ssh.service
```

Operador sem root, na estação autorizada:

```sh
# Na estação autorizada: saída contém identificadores financeiros, manter privada.
umask 077
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes kalend_dev_audit@72.61.47.145 backfill-audit > backfill-dev.private.json
# Requisição inválida deve falhar, sem shell/comando alternativo.
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes kalend_dev_audit@72.61.47.145 invalid-command
```

Validar JSON, banco kalend_dev, todas as contagens e classificações, snapshot/timeout e ausência de relatório parcial. Não tentar INSERT/DELETE, modificar PROD ou enviar mensagens para testar negação. Verificar HBA/ACL por leitura administrativa e negativa de conexão da role a banco temporário não DEV quando houver alvo de teste autorizado; nunca tentar escrita em kalend. Classificação ambígua bloqueia migration. Não versionar o JSON real.

## 5. Fase B — contas e futura publicação DEV, condicionada

**BLOQUEADA até aprovar o inventário CloudPanel.** O arquivo sudoers-dev-only.conf não pode ser instalado junto da fase A por conveniência. Se uma função legítima depende do wrapper, separar administração humana de build/runtime antes de retirar acesso. Contas de deploy separadas não resolvem se a aplicação ainda executa sob identidade administrativa.

Após comprovar que a negação não quebra operação legítima, criar backup do alvo/inexistência, validar visudo e instalar só a regra específica (sem alterar clp/ALL/outros sites):

```sh
test ! -e /etc/sudoers.d/zz-kalend-dev-deny
visudo -c -f sudoers-dev-only.conf
install -o root -g root -m 0440 sudoers-dev-only.conf /etc/sudoers.d/zz-kalend-dev-deny
visudo -c
sudo -l -U kalend-dev
sudo -l -U kalend-api-dev
```

Não reinicia processos. Testar políticas efetivas de todas as identidades não alvo por leitura antes/depois, inclusive clp e PROD. Nova ordem/caminho permitido = parar e remover somente o novo fragmento, sem restaurar política global. Checar groups/ACL/capabilities/sockets, helpers administrativos acessíveis, credenciais DB superuser ou PROD e controle do PM2_HOME. Não tentar modificar PROD como teste.

O `kalend-dev-release-gate` endurecido só permite preflight e não autoriza deploy. Antes de qualquer chave CI para as contas existentes, avaliar shell/login rc/home graváveis: uma chave forçada não garante comando exclusivo se rc puder executar código primeiro. Não alterar shells/homes dessas contas automaticamente. Se necessário, preparar identidade de ingresso separada com home/shell/chaves controlados e promotor estreito, revisado em outra etapa. Nenhum helper executável privilegiado pode ser gravável por quem o invoca. Não conceder sudo para node, npm, git, bash, pm2, systemctl genérico, runuser ou script user-owned.

## 6. Fase C — backup e restauração, autorização separada

Não há backup real comprovado nesta revisão. `pg_restore --list` ou hash do arquivo não prova integridade recuperável.

Inventariar schemas de usuário, extensões, owners/ACL, RLS, large objects, foreign tables e volumes. A proposta backup-role.sql é transacional e só DEV: SELECT de tabelas/sequences public, sem superuser/bypass/global pg_read_all_data. Se houver objetos fora desse escopo ou RLS impedir dump, parar e revisar privilégios específicos — nunca permitir omissão silenciosa ou usar superuser como atalho para teste. Aplicar pg_hba-backup.fragment.conf e pg_ident-backup.fragment.conf apenas à nova role; OS postgres é usado pelo administrador, mas a conexão SQL é explicitamente kalend_dev_backup, não postgres. Nenhuma senha/chave CI de backup é criada.

### Snapshot consistente e manifesto

Administrador, após criar a role (`runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql /usr/lib/postgresql/16/bin/psql -X -v ON_ERROR_STOP=1 -d kalend_dev < backup-role.sql`) e validar/recarregar apenas esses blocos:

1. Abrir uma sessão `runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql /usr/lib/postgresql/16/bin/psql -X -U kalend_dev_backup -h /var/run/postgresql -d kalend_dev`. Confirmar current_database/current_user e rolsuper=false.
2. `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();` Manter a sessão aberta. Produzir contagens de TODAS as tabelas do inventário e ledger de migrations nessa MESMA sessão/snapshot. Registrar fingerprint das tabelas financeiras, FKs/constraints, sequences, extensões, owners/ACL e presença/ausência de PaymentEvidence/SubscriptionEntitlement. Usar saída privada com umask 077; sem PII no relatório.
3. Usar o snapshot exportado no dump abaixo. Não usar contagens capturadas depois como se fossem do snapshot. Não permitir DDL concorrente, mudança de catálogo ou dump sem o snapshot esperado. Definir orçamento de duração/lock conforme volumetria; snapshot longo retém versões e deve ser encerrado em falha.

```sh
set -euo pipefail
umask 077
backup_dir=$(mktemp -d /root/kalend-dev-release-backup.XXXXXXXX)
# Definir exclusivamente o ID produzido pela sessão anterior; validar formato antes de usar.
# Exemplo de formato, não valor real: 00000003-0000001B-1
# dev_snapshot deve vir da sessão aberta, não de input HTTP/CI.
: "${dev_snapshot:?snapshot exportado obrigatório}"
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql /usr/lib/postgresql/16/bin/pg_dump \
  -U kalend_dev_backup -h /var/run/postgresql -d kalend_dev -Fc \
  --snapshot="$dev_snapshot" --lock-wait-timeout=3s > "$backup_dir/kalend_dev.dump.partial"
test -s "$backup_dir/kalend_dev.dump.partial"
mv "$backup_dir/kalend_dev.dump.partial" "$backup_dir/kalend_dev.dump"
sha256sum "$backup_dir/kalend_dev.dump" > "$backup_dir/SHA256SUMS"
stat "$backup_dir/kalend_dev.dump" > "$backup_dir/file-metadata.txt"
# Encerrar COMMIT na sessão exportadora somente após dump/manifesto terminarem.
```

Arquivo original preserva metadados de owner/ACL; não usar --no-owner/--no-acl no dump como substituto de inventário. Guardar também artefatos/SHAs dos DOIS serviços, manifests de dependências, metadata DEV e configurações/dumps PM2 seguros em área protegida; nunca imprimir seus ambientes. Backup antes da migration contém o estado que realmente existe: não pode conter tabelas ainda ausentes. Quando existirem, dump integral/grants revisados devem incluir evidências e todos os relacionamentos. Não copiar dados reais para repositório, GitHub, /tmp público ou estação sem autorização.

### Restauração comprovável

Sequência completa de provisionamento, verificação e parada: [SANDBOX_RESTORE.md](SANDBOX_RESTORE.md).

Usar cluster nativo separado, socket privado e banco NOVO de prefixo kalend_restore_, dono NOSUPERUSER, sem memberships privilegiadas, sem acesso de filesystem/sockets/credenciais a PROD ou outros sistemas. A identidade OS dedicada kalend_restore_review também deve ter !ALL específico (a regra CloudPanel é global), sem grupos privilegiados, shell/chaves de ingresso ou credenciais reais, antes de executar o sandbox. Prover esse sandbox em intervenção separada; não reutilizar o cluster PostgreSQL real nem iniciar aplicação/workers. Dump pode conter código executável em funções/índices; revisar extensões/conteúdo e restringir egress e privilégios do processo. O bootstrap de um cluster pode provisionar roles; nenhuma conexão de teste/dump/restore pode usar superuser.

Após verificar host/socket/porta, data_directory, nome do destino, ownership e rolsuper=false:

```sh
# Variáveis exclusivamente do sandbox validado, nunca URLs/serviços herdados de .env.
# Alimentar stdin a partir do arquivo protegido evita abrir leitura global do backup.
runuser -u kalend_restore_review -- env -i PATH=/usr/bin:/bin HOME=/var/lib/kalend-dev-restore /usr/lib/postgresql/16/bin/pg_restore \
  -h "$restore_socket" -p "$restore_port" -U kalend_restore_review -d "$restore_db" \
  --no-owner --no-acl --single-transaction --exit-on-error < "$backup_dir/kalend_dev.dump"
```

**Proibidos --create/--clean e destinos kalend/kalend_dev.** --create pode selecionar o nome original gravado no arquivo. Validar prefixo estrito, cluster dedicado e todas as variáveis antes do comando; arquivo root privado é aberto pelo operador autorizado e entregue ao processo de restore sem ampliar permissões globais. Restore falho não promove backup a verificado.

Comparar TODAS as contagens do snapshot, fingerprints financeiros, evidências, referências, sequências e constraints, ledger/checksums e owners/ACL mapeados documentados. Nenhum dado pode ser omitido por RLS. Registrar versões, duração, hash, códigos de saída e resultado redigido. Só então backup real é comprovado. Ensaio da migration nessa cópia e medição de locks são uma autorização subsequente; não fazem parte desta intervenção de acesso.

## 7. CI/CD — manter publicação fechada

Os dois workflows atuais disparam push/develop, usam secrets de identidade não atestada, npm ci e build no diretório ativo. API executa migrate deploy antes de build. Grupos independentes e cancel-in-progress=true não garantem promoção conjunta nem preservam uma migration em execução. Falha pode deixar dependências/build/schema parcialmente trocados; não há rollback automático comprovado. pm2 restart usa contexto do login sem validar UID/PM2_HOME. Não executar push nem workflow existente para testar.

Proposta de preflight manual fica fora de .github/workflows e não faz deploy. Antes de publicar QUALQUER commit, o administrador GitHub precisa desabilitar ambos os workflows de deploy atuais por mudança de estado revisada (com estado anterior registrado), sem tocar main e sem push de teste; impedir corridas/runs em curso antes de uma janela aprovada. Só pausar o workflow não torna a VPS isolada. Não reabilitar o gatilho antigo ao concluir fase A.

O fluxo futuro precisa de environment protegido, job manual, SHAs API/Web aprovados, acesso técnico restrito a DEV, credenciais separadas, host key validada, sem cancelamento durante schema/ativação, build sem credenciais de runtime/migration, release separada do checkout ativo, backfill/backup aprovados, migration explícita e ativação dos dois artefatos. Hooks npm/`prisma skills sync` não podem receber credenciais administrativas. Ativador e rollback precisam de revisão específica; preflight atual não os implementa.

## 8. Validação e rollback por fase

- **Configuração inválida antes de reload:** não recarregar. Remover só os novos fragmentos, ou desfazer apenas o bloco marcado HBA; validar parsers novamente. Sessões/serviços atuais permanecem.
- **SSH após reload:** usar sessão administrativa preservada, retirar somente o Include/fragmento novo; sshd -t e reload SSH aprovado. Não restaurar authorized_keys de outros usuários nem mudar SSH global. Revalidar contextos e acesso administrativo.
- **HBA:** remover só o bloco novo, comparar diff, pg_hba_file_rules sem erros e pg_reload_conf autorizado. Nunca restart PostgreSQL.
- **Auditor:** bloquear novas entradas removendo somente a nova chave/Match. Em sessão administrativa confirmar ausência de processos/objetos próprios; revogar os grants específicos de Subscription, Payment, _prisma_migrations, schema public e banco kalend_dev. Remover a role apenas se criada por esta operação e sem dependências inesperadas. Não usar DROP OWNED/REASSIGN OWNED global, nem matar sessões de outros usuários. Remover conta OS sem -r só quando nenhuma sessão a usar; home e backups protegidos podem permanecer para revisão.
- **Negação DEV fase B:** se causar regressão legítima, CI/deploy permanece desabilitado; remover só zz-kalend-dev-deny e validar sudoers. Isso reabre o risco anterior; não marcar isolamento aprovado. Nenhum processo PM2 precisa ser reiniciado.
- **Backup/restore:** conservar arquivos originais, falhas e manifests; não apagar backups anteriores. Sandbox inválido fica isolado sem promover resultado. Não restaurar snapshot em banco real nesta operação.
- **GitHub:** registrar estado anterior, mas não reativar automaticamente pipeline inseguro como rollback. Exige decisão humana posterior; nenhum push, main ou deploy PROD.

## 9. Aceite e decisão de instalação

Fase A pode ser submetida à autorização administrativa específica COM os pré-checks/rollback acima; não depende de retirar CloudPanel dos usuários existentes. Fases B/C e publicação ficam bloqueadas enquanto inventário completo, política efetiva, isolamento, role de aplicação/migration sem privilégios PROD e restauração real não forem comprovados. A revisão local não prova essas condições da VPS.

Testes desta revisão: comandos forçados com checagem de ancestrais/symlinks; visudo dos dois fragmentos; sshd -t/-T em modelo local com seis identidades não alvo preservadas; HBA local rejeitando outro banco/TCP e preservando conexão do dono/PID; role de consulta sem escrita/RLS parcial; dump/restore sintético por NOSUPERUSER com 29 tabelas e evidências; regressão nativa necessária após retirar superuser das conexões de teste. Ver evidências locais. Nenhuma migração, backup ou intervenção real ocorreu.

Fontes técnicas: [OpenSSH ForceCommand/Match](https://man.openbsd.org/sshd_config), [ordem HBA PostgreSQL 16](https://www.postgresql.org/docs/16/auth-pg-hba-conf.html), [cuidados pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).


## 10. Correção pós-inventário — 23/10/2026 (somente local)

O inventário remoto de 22/10 confirmou Ubuntu 24.04.4, OpenSSH 9.6p1,
PostgreSQL 16.15, Include SSH existente e sem Match conflitante nos arquivos
examinados. HBA real: /etc/postgresql/16/main/pg_hba.conf, socket
/var/run/postgresql, porta 5432. A regra genérica local/all/all/peer estava
na linha 123: inserir o bloco novo antes das regras genéricas e conferir a
ordem novamente; números de linha não são contrato. pg_ident não muda na fase A.

**Defeito 1 corrigido:** AuthorizedKeysFile é aberto sob UID do usuário pelo
OpenSSH. O arquivo root:root 0600 anterior impediria autenticação. Permissão
final: diretório central root:root 0755; chave pública root:kalend_dev_audit
0640, grupo primário exclusivo, sem memberships adicionais ou outros usuários
com esse GID. O auditor lê, mas não escreve. Não é uma chave privada.
Manter restrict/command e qualquer from= aprovado; conferir UMA chave real
sem REPLACE_*. Fonte: [código OpenSSH V_9_6_P1](https://github.com/openssh/openssh-portable/blob/V_9_6_P1/auth2-pubkey.c#L560-L580), user_key_allowed2. Parser local disponível é 9.2; validação sshd -t/-T na versão Ubuntu 9.6p1 real continua obrigatória antes do reload. Não se fez SSH nesta correção.

**Defeito 2 corrigido:** getfacl está ausente na VPS. O pacote usa Python 3
os.listxattr(..., follow_symlinks=False), lstat e validação de TODOS os ancestrais,
incluindo /. Rejeita qualquer ACL de acesso/default (inclusive somente leitura),
ACL desconhecida e security.capability. Erro, permissão insuficiente ou filesystem
sem suporte à consulta bloqueia: nunca equivale a ausência de ACL. Não remove
ACLs nem altera pais compartilhados. O critério é conservador; não interpreta
ACL arbitrária como segura. Filesystems com outro mecanismo de autorização
não representado por esses atributos exigem revisão específica e bloqueiam o aceite.

O check-audit-files.py roda do staging root-private revisado, sem instalar outro
helper global; valida grupo exclusivo, modes finais, owners, symlinks e atributos.
Os comandos forçados também verificam ACL/capability antes de executar git/psql.
Não fazer chmod/chown de arquivos existentes para forçar aprovação.

**Ordem operacional:** nenhum acesso auditor pode ser liberado antes de validar
negação sudo efetiva, arquivos/grupo e SQL/HBA. A1 e A2 preparam arquivos sem reload;
A3 provisiona a role e valida/recarrega HBA; somente depois concluir validação
SSH, reload autorizado e A4. Qualquer falha deixa a chave sem ativação e exige
rollback limitado. Uma role nova não deve ser reusada de tentativa anterior.

**Recuperação obrigatória e ainda NÃO comprovada:** antes de qualquer escrita,
manter uma sessão SSH administrativa aberta e testar uma segunda conexão SSH
como precaução adicional. Ambas dependem do mesmo sshd e NÃO comprovam recuperação
independente. Validar operacionalmente o console do provedor ou outro caminho
independente da configuração SSH/sudo/HBA afetada, sem provocar indisponibilidade. Registrar operador, horário e método sem credenciais.
Sem isso, NÃO instalar/recarregar. Revalidar HTTP, PIDs, espaço/inodes, concorrência,
conta/role/paths ausentes e parsers no momento da intervenção. Testes locais não
substituem esse gate. Rollback continua restrito aos novos arquivos/bloco/role;
nunca restaurar passwd/sudoers globais, alterar PROD ou reiniciar serviços.

**Riscos separados:** o wrapper global e sudo de clp permanecem; contas DEV
existentes NÃO ficaram isoladas. kalend_dev e kalend têm proprietário SQL kalend
com CREATEDB; não usar essa credencial na auditoria/CI. Role auditora sem
SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS, sem memberships e SELECT explícito só
em Subscription, Payment e _prisma_migrations. ACL + HBA + comando fixo são as
fronteiras; read_only sozinho não basta. row_security=off recusa relatório parcial.

Fase B, backup/restore real, pipeline, publicação e migrations permanecem fora
da fase A. getfacl ausente não autoriza instalar pacote na VPS.
Evidências e limites desta correção: evidencias/2026-10-23-pacote-auditor/resumo.json
(relativo a docs/homologacao). Nenhuma intervenção remota nesta correção.

### Resultado da correção local

- 22/22 regressões Python, incluindo ACL default real criada em diretório temporário.
- 1/1 cenário PostgreSQL 16.15 nativo: guard transacional, flags da role, SELECT
  fixo, negações de escrita/DDL/leitura de User/SET ROLE e falha por RLS parcial.
- sshd local 9.2: sintaxe aprovada; 12 contextos não alvo (seis contas × duas origens)
  iguais; comando forçado, chave central, ausência de TTY/forwarding e autenticação
  restrita preservados. Não houve teste de login real nem daemon SSH local.
- Visudo dos fragmentos e modelo combinado aprovados; cvtsudoers confirma !ALL
  específico como última regra do modelo. Isso NÃO comprova sudo efetivo da VPS.
- 14 blocos Bash aprovados; lint e typecheck API aprovados com Node 24.21.0.
- Primeira tentativa SQL sob Node 18 falhou antes de executar asserts; cluster
  efêmero encerrado. Reexecução sob Node 24 passou, cluster também encerrado.

Código de produto e suites funcionais não alterados/reexecutados. Pacote local
corrigido para revisão humana; **instalação operacional ainda bloqueada** até
comprovar recuperação e preflight atual. Não há autorização implícita de Fase A.
SHA256SUMS acompanha os arquivos do pacote; copiar apenas de staging root-private,
validar hashes antes de usar e não instalar o exemplo de chave com placeholders.


## 11. Preflight final remoto somente leitura — 23/10/2026

Resultado: **NÃO INSTALAR AINDA**. Ver [plano consolidado](PREFLIGHT_FASE_A_2026-10-23.md).
Manifesto anterior íntegro (17 arquivos). Host srv1119527, OpenSSH Ubuntu 9.6p1,
PostgreSQL 16.15 e configurações atuais confirmados. O fragmento SSH foi avaliado
no parser REAL com conteúdo em memória via /dev/stdin, no ponto equivalente ao
Include proposto, sem criar arquivos: sintaxe aprovada e 12 contextos não alvo
preservados; auditor com todas as restrições esperadas. Isso não cria conta nem
prova login/leitura de uma chave ainda inexistente.

Sudoers atual e modelo futuro passaram no parser real; a negação !ALL seria a
última regra na ordem atual. Conta/grupo/role/paths continuam ausentes; não é
possível provar sudo efetivo da nova conta ou autenticação SQL/SSH antes de criá-la.
Esses são gates de aceite durante a intervenção, antes de liberar acesso.

ext4 nos ancestrais inspecionados, root owner, sem escrita de grupo/outros,
sem symlinks/ACL/capability; listxattr disponível sem getfacl. HBA sem erros,
peer local, scram TCP localhost; proposta deve preceder local all all peer.
PUBLIC não tem CREATE no schema public, tabelas-alvo sem ACL adicional ou RLS,
zero SECURITY DEFINER executável por PUBLIC. Proprietário SQL kalend compartilhado
continua com CREATEDB e não é identidade do auditor.

Console serial/getty ativos NÃO demonstram acesso pelo provedor. Nenhuma conexão
operacional ao console Hostinger foi comprovada; não havia ferramenta/sessão de
controle do provedor disponível nesta execução. Não se tentou reboot, rescue,
reset de senha ou indisponibilidade. Chave pública auditora definitiva também
não foi disponibilizada/atestada: o pacote contém somente authorized_keys.example
com placeholders. Não selecionar automaticamente uma chave SSH existente.

Evidências novas: docs/homologacao/evidencias/2026-10-23-preflight-final/.
Sem instalação, reload, restart, migration, alteração de banco, push ou deploy.
Os quatro endpoints retornaram 200; PIDs principais PROD/DEV e infraestrutura
preservados ao fim das consultas. Nenhum teste financeiro foi repetido.


## 12. Preparação definitiva local — chave e Web Console

Esta seção sucede os bloqueios históricos das seções anteriores; não declara instalação.
O usuário informou sessão root no Web Console com hostname srv1119527. Isso é
registro legítimo de acesso administrativo RELATADO, sem comprovar transporte serial
ou independência do sshd. A documentação oficial descreve login automático/manual,
funcionamento semelhante a SSH e mensagem de terminal serial, mas não promete que
qualquer sessão desse produto contorne a configuração SSH. Portanto independência
continua NÃO COMPROVADA. Não bloquear SSH, reiniciar VPS ou ativar Emergency Mode
para testar: isso ultrapassa esta preparação e afetaria outros sistemas.

Ver [preparação definitiva](PREPARACAO_FINAL_AUDITOR_2026-10-23.md) para as fontes,
comandos somente leitura a executar no próprio console e gates remanescentes.
Foi preparada uma chave Ed25519 NOVA exclusiva, sem reutilizar chave de PROD/CI.
A pública em audit.authorized_keys substitui o exemplo para futura instalação;
a fingerprint está em audit-key-public.json e é validada pelo novo verificador.
A privada está EXCLUSIVAMENTE em diretório local .ssh 0700, arquivo 0600, fora
DOS DOIS repositórios. Não tem passphrase: proteção atual é pelo filesystem local;
não foi carregada no agent nem enviada a servidor/provedor. Não copiar a privada
para staging/root/VPS, backup de configuração remoto ou Git. A autorização de gerar
não é autorização de instalar: conferir fingerprint com operador antes da intervenção.

Somente auditor@VPS DEV e comando backfill-audit. A exclusividade é uma política
conjunta de chave, conta, ForceCommand e HBA, a conferir na instalação; a criptografia
sozinha não limita uma chave a um usuário/comando. Nenhuma origem from= inventada.
Se uma origem estável for aprovada, acrescentar from= e validar com o mesmo valor
no terceiro argumento opcional de check-audit-public-key.py, atualizar hashes e
repetir testes específicos. Sem aprovação, permanecer sem restrição de origem e
registrar essa limitação, sem relaxar restrict/ForceCommand/TTY/forwarding.
