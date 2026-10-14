# Isolamento de comunicação em DEV

O envio de Email do backend DEV usa exclusivamente um sink SMTP local. O transporte fixa o destino em `127.0.0.1:1025`, não autentica, não negocia TLS e substitui o remetente. Configuração SMTP salva não determina host, porta ou autenticação do transporte; Gmail também não é selecionado.

Antes de habilitar o envio no ambiente DEV, provisionar Mailpit (ou sink equivalente compatível com SMTP) no próprio host e publicar somente em loopback:

- SMTP: `127.0.0.1:1025`
- interface de inspeção: `127.0.0.1:8025`, acessível localmente ou por túnel SSH; nunca publicar a interface diretamente na internet.

No ambiente privado da API DEV, configurar:

- `COMMUNICATION_DEV_SMTP_SANDBOX_ENABLED=true`
- `QA_COMMUNICATION_EMAIL_ALLOWLIST` com os endereços de homologação autorizados

Quando o runtime é identificado como DEV, o envio falha fechado se o sandbox não estiver habilitado ou o destinatário normalizado não estiver na allowlist. A allowlist é aplicada na expansão, na revalidação da delivery e novamente antes de abrir o socket SMTP. Não guardar endereços reais no repositório.

O código não instala Mailpit, não altera configuração privada do servidor e não habilita o sandbox automaticamente. Sem a instalação e as variáveis privadas acima, Email comercial em DEV fica bloqueado. Não há fallback para SMTP live.

O model `GatewayEnvironment` não possui `DEV`. Por isso, novas deliveries SMTP e Evolution criadas no runtime DEV usam `SANDBOX` como marcador não produtivo. A lista de providers apresenta o `EvolutionConnection.environment` real (`DEV`), enquanto a resolução de envio exige a instância global `kalend_dev_global`. A conexão `kalend_global` é rejeitada em runtime DEV. Push mantém a resolução e o environment existentes.

Deliveries antigas não são regravadas. Uma tentativa posterior de retry SMTP com rótulo histórico `PRODUCTION` só pode chegar ao sink loopback e ainda precisa passar pela allowlist. Retry de Evolution exige novamente a conexão DEV e a instância esperada.
