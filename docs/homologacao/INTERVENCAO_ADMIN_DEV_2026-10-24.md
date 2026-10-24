> **Política vigente após simplificação de 24/10/2026:** este documento é
> histórico de uma intervenção mais ampla e não deve ser executado em bloco.
> Instalação de fence, negação sudo e console independente não são gates gerais
> para desenvolvimento, Git ou release DEV pelo Actions. Console/recuperação
> continuam pertinentes às mudanças de SSH/sudoers/autenticação administrativa.
> A release exige somente os controles objetivos da política vigente: destino e
> comandos DEV, migration SQL restrita, backup recuperável e ausência de operações
> em PROD/outros sistemas. Publicação já autorizada; não solicitar nova aprovação
> rotineira, desabilitar Actions ou usar o procedimento manual antigo.
> O conteúdo abaixo foi preservado como evidência histórica e proposta técnica.

# Intervenção administrativa DEV — escopo e gate de recuperação

## Estado: BLOQUEADA antes de qualquer instalação

Autorizadas nesta tarefa: preparação local e verificações remotas somente leitura.
Publicação continua autorizada após os controles. Antes de sudoers/firewall/HBA,
identidades ou ownership, o proprietário exige recuperação independente do sshd e
apresentação dos comandos/impacto. Esse requisito ainda não foi comprovado.
Não tratar esta documentação como instalação nem executá-la em bloco.

HEADs de entrada: API fa84bb6 (15 commits sobre develop remoto b1cc220a), Web
bbb668b (4 sobre 4d86829b). Modificações anteriores e arquivos não rastreados
preservados. Nenhuma bateria financeira repetida.

## Recuperação verificada e seus limites

O Web Console previamente testado utilizou sshd, conforme informado pelo
proprietário. A documentação oficial também descreve a sessão como equivalente
a uma conexão SSH. Isso não comprova console KVM/VNC/serial independente.

- Web Console: https://www.hostinger.com/support/how-to-use-the-web-console-in-hostinger/
- Recuperação Emergency Mode: https://www.hostinger.com/support/11484348-how-to-recover-from-vps-filesystem-corruption-at-hostinger/

Emergency Mode envolve recuperação/reinício conforme o procedimento do provedor.
Não foi ativado, nem proposto como teste na VPS compartilhada. Reset global de
SSH/firewall e restauração de snapshot da VPS inteira também não são rollback
limitado DEV. Não solicitar nem coletar senhas ou tokens.

Para liberar o gate: identificar um canal do provedor fora do sshd, vinculado a
srv1119527, com evidência operacional legítima da sessão administrativa e de sua
cadeia de acesso independente. Sessão SSH adicional, tmux, autorização declarada
ou disponibilidade genérica na documentação não bastam. Não provocar bloqueio,
parar sshd, reiniciar, ativar resgate ou modificar o host para produzir essa prova.
Não há ferramenta conectada de console/conta Hostinger nesta sessão.

## Identidade GitHub Actions — verificações realmente executadas

Últimos runs bem-sucedidos: API 38812563493 (15/10 21:47:52–21:48:49 UTC), Web
38646549731 (14/10 22:17:03–22:18:27 UTC). Consulta atual: nenhum run pendente
entre os 29/22 retornados. Não houve disparo de workflow.

As referências DEV_SSH_HOST/DEV_SSH_USER/DEV_SSH_KEY não identificam por si sós
seus valores ou privilégios efetivos. Logs anteriores mascaram a identidade.
Consulta journalctl ssh.service nas janelas correspondentes não retornou entradas;
consulta filtrada em auth.log, auth.log.1 e auth.log.2–4.gz não encontrou eventos
Accepted correspondentes. Ausência de retenção não prova qual conta foi usada.

É necessário atestar a conta/chave via configuração administrativa GitHub e sua
correspondência com a autorização SSH do servidor, sem revelar valores privados.
Não buscar ou imprimir a chave privada e não usar push/deploy para descobrir a conta.

## Comandos propostos e impacto exato — SOMENTE após gate comprovado

Pacote existente: operacao-dev/PROCEDIMENTO_UNICO.md. Sua parte manual de
publicação foi superada; manter Actions por push em develop e NÃO desabilitar jobs.
Os comandos abaixo referenciam arquivos já preparados. O staging deve ser root:root
0700, completo e conferido contra o manifesto. Backup/configurações originais,
owner/ACL e estados DEV devem estar registrados antes da primeira mudança.

### 1. Backup das configurações afetadas — root, sem executar aplicação

```sh
set -euo pipefail
umask 077
test "$(hostname -s)" = srv1119527
test "$(id -u)" = 0
cd /root/kalend-dev-release-stage
sha256sum -c docs/homologacao/operacao-dev/SHA256SUMS
op_backup=$(mktemp -d /root/kalend-dev-admin-config.XXXXXXXX)
tar --acls --xattrs --numeric-owner -cpf "$op_backup/config.tar" \
 /etc/sudoers /etc/sudoers.d \
 /etc/postgresql/16/main/pg_hba.conf /etc/postgresql/16/main/pg_ident.conf
sha256sum "$op_backup/config.tar" > "$op_backup/SHA256SUMS"
```

Impacto: novos arquivos privados, nenhuma mudança de autenticação. Fazer também
backup privado da configuração/dumps DEV antes de alterá-los; não versionar secrets.

### 2. Identidade migradora — root, somente nova conta sem SSH

```sh
if getent passwd kalend-dev-release >/dev/null; then exit 1; fi
useradd --system --user-group --no-create-home --home-dir /var/lib/kalend-dev-release --shell /usr/sbin/nologin kalend-dev-release
install -d -o kalend-dev-release -g kalend-dev-release -m 0700 /var/lib/kalend-dev-release
```

Impacto: nova identidade local sem chave/shell de login. Registrar seu UID antes de
renderizar proteção. Não adicionar ao grupo da API nem abrir seu home/secrets.

### 3. Sudo específico — root, dependências CloudPanel aceitas antes

```sh
test ! -e /etc/sudoers.d/zz-kalend-dev-release-deny
visudo -c -f docs/homologacao/operacao-dev/sudoers.conf
install -o root -g root -m 0440 docs/homologacao/operacao-dev/sudoers.conf /etc/sudoers.d/zz-kalend-dev-release-deny
visudo -c
sudo -l -U kalend-dev
sudo -l -U kalend-api-dev
sudo -l -U kalend-dev-release
```

Impacto: retira sudo somente dessas identidades. Não altera clp, wrapper ou regra
global. Alguma tarefa CloudPanel legítima sob esses usuários pode depender desse
acesso; não instalar sem decisão específica sobre essas dependências. Não executar
o wrapper para provar negação. Revisar listagem efetiva inteira e precedência.

### 4. Ownership/roles DEV — DBA, transação com guards, sem migration financeira

```sh
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql \
 /usr/lib/postgresql/16/bin/psql -X -qAt -v ON_ERROR_STOP=1 -d kalend_dev \
 < docs/homologacao/operacao-dev/capture-ownership-rollback.sql > "$op_backup/ownership-rollback.private.sql"
runuser -u postgres -- env -i PATH=/usr/bin:/bin HOME=/var/lib/postgresql \
 /usr/lib/postgresql/16/bin/psql -X -v ON_ERROR_STOP=1 -d kalend_dev \
 < docs/homologacao/operacao-dev/isolate-dev.sql
```

Impacto: cria roles NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS, owner/migrator
DEV e runtime com CRUD/sequences/functions/default privileges. Transfere apenas
objetos DEV enumerados; não muda senha/owner/ACL de PROD. Não é a migration
PaymentEvidence. Schemas/owners/objetos inesperados bloqueiam o script. Extensões
não revisadas exigem parada, não transferência genérica de objetos.

### 5. Autenticação e proteção da credencial antiga — root/DBA

Instalação futura EXATA dos blocos pg_hba.fragment.conf e pg_ident.fragment.conf,
antes dos allows genéricos, preservando as demais regras/bytes e permissões.
Nenhuma edição foi executada. Os blocos limitam as novas roles ao DEV por peer e
rejeitam outros bancos/TCP; validar views pg_hba_file_rules e pg_ident_file_mappings
antes de um reload específico, nunca restart:

```sh
runuser -u postgres -- /usr/lib/postgresql/16/bin/psql -X -v ON_ERROR_STOP=1 -d kalend_dev \
 -c 'SELECT * FROM pg_hba_file_rules WHERE error IS NOT NULL;' \
 -c 'SELECT * FROM pg_ident_file_mappings WHERE error IS NOT NULL;'
# Executar a linha seguinte apenas se ambos os resultados não contiverem erros:
runuser -u postgres -- /usr/lib/postgresql/16/bin/psql -X -v ON_ERROR_STOP=1 -d kalend_dev \
 -c 'SELECT pg_reload_conf();'
```

Impacto: reload do PostgreSQL compartilhado relê autenticação; conexões existentes
não são reiniciadas. Por isso a alteração precisa ser revisada/reversível e o gate
é obrigatório. Configuração runtime DEV passa para kalend_dev_runtime; é necessário
sobrescrever também env legado PM2 e dumps/backup ativos em janela exclusivamente
DEV. Não imprimir .env e não alterar configuração de PROD.

A proteção antiga preparada é tabela nft exclusiva inet/kalend_dev_release, TCP5432
somente UIDs DEV/migrador e suas faixas subordinadas. Comandos de renderização,
nft -c, unit dedicada e drop-ins DEV estão no procedimento existente. Impacto:
conexões TCP PostgreSQL desses executores serão bloqueadas; usar socket/peer após
transição. Outros UIDs/portas não devem ser selecionados. Não instalar enquanto
UFW/persistência/faixas/duplicação não forem comprovadas. Não fazer flush ruleset,
reset global ou reload UFW como teste. Trocar URL sem essa proteção não invalida
uma credencial antiga ainda conhecida pelos usuários DEV.

## Compatibilidade com Actions: bloqueio específico antes da instalação

O workflow existente executa npx prisma migrate deploy diretamente como a conta
SSH. A proposta peer exige kalend-dev-release para a role migradora, enquanto
kalend-api-dev autentica apenas como runtime. Portanto, instalar somente essas
roles/URLs fará a migration falhar. Não permitir DDL ao runtime para contornar.

Antes de aplicar os controles, fechar o caminho único de migration pelo Actions:
identidade SSH comprovada, comando de migration delegado de forma restrita e
artefato/CLI aprovados, executados como kalend-dev-release. A negação !ALL proposta
não concede essa delegação. Qualquer concessão adicional precisa de regra exata,
helper confiável, validação e escopo revisto; nenhum sudo amplo, argumento/SQL/path
arbitrário ou código como root. Mudança mínima técnica no comando de migration
pode ser necessária, mantendo o mesmo workflow/gatilho. Ainda não instalada nem
representada como pronta/testada. Não reaproveitar a sequência manual antiga para
substituir o Actions solicitado pelo proprietário.

## Parada, rollback e conclusão

Gate de recuperação ausente: parar antes da primeira escrita remota, como agora.
Outros gates: CI sem identidade comprovada, dependência CloudPanel pendente,
parser inválido, privilégio adicional, colisão de UID/role/arquivo, schema ou extensão
inesperada, backup/restore não comprovado ou legado ambíguo. Nenhum push de teste.

Rollback limitado: remover somente arquivos/blocos novos desta intervenção, com
parsers antes de reload; preservar regras de terceiros e processos PROD. Restaurar
ownership apenas pelo script capturado, antes do schema novo e sem dependências
extras. Não retirar fence/negação enquanto processos DEV puderem usar credenciais
legadas. Após migration financeira, não restaurar schema/dados nem iniciar API
antiga automaticamente. Não usar snapshot global da VPS como rollback DEV.

Após instalação/validação efetivas: backup DEV atualizado/restore, reclassificação
READ ONLY, revisão dos commits (a contagem muda com documentos novos), push normal
por develop, observação Actions, ledger/backfill, artefatos API/Web, health e QA real.
Nada disso foi declarado executado nesta preparação.
