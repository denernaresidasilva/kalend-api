# Preparação definitiva — somente local

27 regressões Python aprovadas, parser SSH local 9.2 e 12 contextos não alvo,
sudoers parseado com !ALL final, 17 blocos Bash. Regressão SQL restrita 1/1 em
PostgreSQL nativo 16.15; nenhum teste usa superuser, cluster encerrado. Lint e
typecheck API aprovados. Suites funcionais/financeiras não repetidas.

Chave nova Ed25519: somente pública e fingerprint no pacote. Privada local fora
do repositório, 0600/0700, sem ACL; sem passphrase, agent ou transmissão. Par de
chaves conferido localmente sem imprimir chave privada. Não há aceitação SSH
real do auditor ainda inexistente. A aprovação da fingerprint é pré-instalação.

Usuário confirmou root/srv1119527 no Web Console. A documentação oficial não
prova sozinha a independência da sessão em relação ao sshd; solicitada evidência
somente leitura do tty/processos. Nenhuma indisponibilidade foi provocada.
Nenhuma VPS foi conectada ou modificada nesta execução local. Resultado
operacional condicionado à recuperação independente e autorização específica.
