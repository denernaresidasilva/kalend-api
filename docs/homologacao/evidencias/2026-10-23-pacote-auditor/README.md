# Correção local do pacote auditor — 23/10/2026

22 regressões Python aprovadas, incluindo ACL Linux real em diretório temporário.
Um cenário SQL nativo PostgreSQL 16.15 aprovado, com múltiplas negações de acesso.
Parser SSH local 9.2 aprovado e 12 contextos não alvo preservados; sem daemon.
Código oficial OpenSSH 9.6p1 confirma leitura de AuthorizedKeysFile sob UID alvo:
https://github.com/openssh/openssh-portable/blob/V_9_6_P1/auth2-pubkey.c#L560-L580
Não equivale a teste de login na versão Ubuntu real. Sudoers parseado e negação
final verificada no modelo; sudo -l efetivo na VPS é gate obrigatório, não executado.
Lint e typecheck API aprovados com Node 24.21.0. 14 blocos Bash validados.
Nenhuma auditoria funcional completa foi repetida; nenhum código de produto alterado.

A primeira tentativa SQL usou Node 18 padrão e falhou antes dos testes; seu cluster
foi parado. Nova execução com Node 24 passou e o cluster foi parado em finally.
Dados sintéticos/logs ficam em /tmp, fora do Git. Nenhuma VPS acessada, nenhuma
conta/role real criada. Recuperação administrativa não comprovada, instalação
continua condicionada aos gates de produção descritos no procedimento.

Pacote corrigido localmente, apto à revisão humana. NÃO autoriza instalar, reload,
publicar, migrar ou afirmar isolamento das contas DEV/proprietário SQL existentes.
