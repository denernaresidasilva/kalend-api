# Preparação definitiva do auditor DEV — sem instalação

Data: 23/10/2026. **FASE A AINDA NÃO LIBERADA.**

## Web Console: evidência, fonte e limite

Usuário informou ter acessado como root e confirmado srv1119527 no Web Console.
Isso demonstra acesso administrativo relatado. Não demonstra, sozinho, o transporte.
Fonte oficial: https://www.hostinger.com/support/how-to-use-the-web-console-in-hostinger/
A página descreve operação semelhante a SSH e menciona terminal serial0 como cenário;
não afirma explicitamente que toda conexão ignore sshd_config ou dispense o sshd.
Outra fonte: https://www.hostinger.com/support/11484348-how-to-recover-from-vps-filesystem-corruption-at-hostinger/
Descreve acesso pela infraestrutura do provedor e Emergency Mode, mas não é prova
operacional do transporte da sessão em uso. NÃO ativar Emergency Mode/reboot/fsck.

No PRÓPRIO Web Console, somente leitura (não na sessão SSH habitual):

```sh
tty
ps -o pid,ppid,tty,comm -p $$,$PPID
if test -n "$SSH_CONNECTION"; then
  echo SSH_CONNECTION=PRESENTE
else
  echo SSH_CONNECTION=AUSENTE
fi
```

Somente nomes de processos/TTY e presença da variável; não imprimir argumentos,
ambiente integral ou credenciais. Ausência de SSH_CONNECTION sozinha NÃO prova
independência. TTY serial e cadeia de login/getty sem sshd, vinculados à sessão
root desta VPS, permitem avaliar recuperação sem alterar serviços. Se ambíguo,
obter confirmação técnica do provedor para esse canal. Não provocar indisponibilidade.
A coleta foi solicitada ao usuário; sem saída recebida, permanece NÃO COMPROVADO.

## Chave definitiva preparada

- Algoritmo: Ed25519.
- Fingerprint pública: `SHA256:MQmrBnZRCRjUppy8C6MC2hnQhA806Kq3bETpMPzmupI`.
- Pública instalável: `audit.authorized_keys`, UMA entrada com restrict/command.
- Metadata pública: `audit-key-public.json`; não contém segredo.
- Privada: somente local, diretório 0700 e arquivo 0600; fora dos repositórios.
  Caminho local registrado em usage.json no próprio diretório privado .ssh.
- Sem passphrase; não foi enviada à VPS, copiada para Git ou registrada no agent.
- Origem from= não configurada: ainda não há CIDR estável aprovado. Não inventar.

Comandos de validação LOCAL, sem conexão:

```sh
python3 -I check-audit-public-key.py audit.authorized_keys SHA256:MQmrBnZRCRjUppy8C6MC2hnQhA806Kq3bETpMPzmupI
ssh-keygen -lf audit.authorized_keys -E sha256
sha256sum -c SHA256SUMS
```

Executar a partir do pacote. A fingerprint esperada deve ser aprovada fora de banda
antes de instalar; não aprender a fingerprint esperada de um arquivo remoto alterável.
O verificador recusa key duplicada, placeholder, blob inválido, outro algoritmo,
comando distinto, permissão de TTY/agent-forwarding e origem não aprovada.

## Uso futuro, somente DEPOIS da instalação autorizada

Na estação local, após conferir host key conhecida, usar a identidade privada
exclusiva e não herdar comandos/proxies/forwardings de ~/.ssh/config:

```sh
umask 077
audit_identity="$HOME/.ssh/kalend-dev-audit-20261023-1yi_l96x/id_ed25519"
ssh -F /dev/null -i "$audit_identity" -o IdentitiesOnly=yes -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o ForwardAgent=no -o ClearAllForwardings=yes -T \
  kalend_dev_audit@72.61.47.145 backfill-audit > backfill-dev.private.json
```

NÃO EXECUTADO. Esse arquivo financeiro deve permanecer privado e fora do Git.
No servidor, a chave será root:kalend_dev_audit 0640; diretório root:root 0755.
Pública pode ser entregue futuramente; NUNCA copiar a identidade privada ou usage.json.
O comando forçado, checagem de usuário/entrada, SQL fixo, ACL e HBA limitam o acesso;
a chave sozinha não impede uso indevido se instalada em outra conta.

## Próxima intervenção exata — ainda exige autorização

1. Comprovar canal de recuperação independente sem alterar SSH; manter console
   aberto e uma sessão SSH administrativa como precaução adicional.
2. Aprovar fingerprint/titular da chave pública e eventual CIDR. Repetir preflight
   remoto imediato, confirmar conta/grupo/role/paths ausentes, PIDs/HTTP e parsers.
3. Autorizar especificamente A1–A4 do INTERVENCAO_ADMINISTRATIVA.md. Criar staging
   root-private e backup protegido dos arquivos de configuração; conferir hashes.
4. Instalar somente negação sudo do auditor; criar conta/grupo; conferir sudo efetivo
   negando TODOS os comandos, inclusive wrapper, ANTES de liberar qualquer acesso.
5. Instalar helper/SQL/chave pública e fragmento SSH sem reload. Validar modos,
   ancestrais, ACL, symlinks e fingerprint ANTES e DEPOIS de copiar a pública.
6. Criar somente role auditora de leitura e grants explícitos; aplicar só bloco
   HBA específico, antes dos genéricos; validar e fazer reload autorizado de HBA.
7. Comparar configurações SSH dos não alvo, parsers e recuperação. Só então
   reload SSH autorizado. Não restart. Testar comando fixo e rejeição de comando
   inválido, JSON completo, ausência de acesso a outros bancos por política.
8. Confirmar serviços/PIDs/HTTP e registrar evidências. Rollback só dos novos
   arquivos/blocos/role/conta, conforme procedimento; não restaurar políticas globais.

CloudPanel/clp e usuários DEV existentes não mudam. Role kalend compartilhada,
backup real, Fases B/C, migration/deploy e homologação ficam separados.
Nenhuma conexão ou intervenção remota foi feita nesta preparação local.
