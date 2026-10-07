# Evolution API 2.3.7 — integração Kalend

Atualizado em 07/10/2026 após o diagnóstico e as reproduções de concorrência, perda do QR e close/401. Implementação e testes locais; **nenhum deploy, restart, migration na VPS ou mudança na Evolution real**.

## Escopos e ambiente

GLOBAL: `AdminGuard`, Super Admin, independente de selectedCompanyId e membership. Base `/communication/evolution` e callback `/webhooks/communication/evolution/global/:id`.

COMPANY: `TenantGuard`, OWNER/ADMIN, companyId da sessão; base `/company/communication/evolution`, callback `/webhooks/communication/evolution/:id`. Não há fallback GLOBAL nem seleção de instância pelo browser.

DEV usa `kalend_dev_global` e `kalend_dev_<UUID sem hífens>`. Produção usa `kalend_global` ou GLOBAL legado autorizado, e `kalend_<UUID sem hífens>`. `EvolutionConnection` possui unicidade e CHECK de contexto. Banco DEV e produtivo devem ser distintos. Registros atribuídos a outro deployment são recusados. Vínculos legados sem ambiente são verificados sob lease antes de uso remoto; instâncias antigas ambíguas não são excluídas automaticamente.

## Variáveis

| Variável | Uso |
| --- | --- |
| EVOLUTION_API_KEY | Somente backend, header apikey para https://evolution-api.kalend.tech |
| EVOLUTION_WEBHOOK_BASE_URL | Obrigatória: origin https://api-dev.kalend.tech ou https://api.kalend.tech, raiz sem credenciais/query |
| GATEWAY_ENCRYPTION_KEY | Chave existente AES-256-GCM do SecretVault; 64 caracteres hexadecimais |
| DATABASE_URL | Prisma/PostgreSQL; DEV exige database kalend_dev |
| BILLING_PUBLIC_API_URL | Se presente, origin deve coincidir com o webhook |
| AUTH_JWT_SECRET / AUTH_ALLOWED_ORIGINS / AUTH_TRUSTED_PROXY_CIDRS | Autenticação, Origin/CORS e proxy existentes |
| NEXT_PUBLIC_API_URL | URL pública **Kalend API**, embutida no build Web |

Não há nova variável obrigatória. EVOLUTION_API_URL e COMMUNICATION_EVOLUTION_HOSTS não são lidas pelo cliente atual, que usa origin fixo. Não criar NEXT_PUBLIC_EVOLUTION_API_KEY. NODE_ENV não define deployment. O campo environment PRODUCTION de GlobalCommunicationProvider representa o canal real; EvolutionConnection.environment representa DEV/produção e namespace.

## Endpoints e DTO

Todas as operações abaixo usam a base do próprio contexto e autenticação Kalend; mutações exigem Origin autorizada.

| Método / sufixo | Comportamento |
| --- | --- |
| GET / e GET /status | Snapshot temporário + reconciliação de estado quando necessária; nunca connect/restart/logout |
| POST /prepare, body {} | Provisiona/repara instância e webhook; primeira configuração pode iniciar QR; preserva tentativa ativa e logout concluído |
| POST /connect, body {} | Solicita QR; reutiliza tentativa válida |
| POST /pairing-code, body {phone} | Solicita pairing com telefone normalizado |
| POST /reconnect, body {} | Nova tentativa; mantém PHONE/número da tentativa ainda dentro do prazo |
| POST /logout, body {} | Cancela intenção/códigos antes da chamada remota e confirma estado local desconectado |
| DELETE /, body {} | Invalida token/códigos, exclui instância remota e reseta vínculo local; não recria em polling |
| COMPANY POST /send-test, body {} | Envia somente ao telefone do usuário autenticado OWNER/ADMIN da própria empresa |

Gerenciamento POST mantém HTTP 201; GET retorna 200. Receiver Evolution retorna **HTTP 200** para eventos aceitos/duplicados/obsoletos. `/communication/providers/EVOLUTION/pair` permanece como rota legada, mas agora devolve **o mesmo DTO de sessão**, sem retornar 503 apenas por QR ainda pendente. Clientes antigos que consumiam `connected:boolean` nessa rota precisam usar `status`.

Contrato único da sessão:

```ts
{
  status: 'PENDING' | 'CREATED' | 'CREATING' | 'DELETING' | 'CONNECTING'
        | 'QR_AVAILABLE' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
  qrCode: string | null; qrExpiresAt: string | null;
  pairingCode: string | null; pairingExpiresAt: string | null;
  attemptExpiresAt: string | null;
  disconnectReason: number | null;
  operationPending: boolean; pairingSupported: boolean;
  phone: string | null; profileName: string | null; connectedAt: string | null;
  errorCode: string | null; message: string | null;
}
```

DTO não contém chaves, tokens, instanceName, companyId, lease, versão, ciphertext ou telefone digitado da tentativa. Testes de envio retornam `{accepted:true,delivered:false}`; aceitação não comprova entrega. O envio GLOBAL continua nos endpoints do provider e resolve Super Admin/OWNER ativo no banco.

## QR e pairing: continuidade e retenção

Evolution → qrcode.updated → validação de callback → transação curta PostgreSQL → codeEncrypted → GET Kalend → `<img>` / código no Web. **A imagem não depende de ser obtida novamente do connect da Evolution.** Réplicas usam o mesmo snapshot cifrado no banco, sem Map por processo e sem Redis novo.

Imagem PNG é validada (data URI, assinatura, IHDR/IEND, dimensões e limite de tamanho). O campo textual code da Evolution não é renderizado como imagem. PairingCode é exibido exatamente como recebido, dentro do formato suportado. Payloads podem ser diretos ou em qrcode. A tentativa PHONE pode mostrar QR como fallback, com aviso de pairing pendente.

| Dado | Política local |
| --- | --- |
| QR | 60 segundos desde o evento ou resposta que forneceu código novo |
| Pairing | 120 segundos |
| Tentativa/telefone de pairing | Máximo 5 minutos |
| Tentativa sem qualquer código | Termina espera em 60 segundos |

Esses limites são política de exibição/retentativa Kalend, **não TTL contratual do WhatsApp**. Fingerprint HMAC impede renovar o mesmo código só por repetição/polling. Código novo substitui o anterior. Open, logout, close/refused e delete removem imediatamente os códigos/telefone temporários. GET não mostra material expirado. Manutenção de 30 segundos remove ciphertext expirado mesmo sem visitante, enquanto o processo configurado está ativo; após uma parada, dados vencidos continuam inacessíveis e são removidos no próximo sweep. Backups seguem a política de retenção do PostgreSQL e contêm somente ciphertext.

Telefone digitado é cifrado com AAD própria da conexão. `+55 (12) 99605-5129` resulta em `5512996055129`: apenas separadores são removidos, sem inventar ou eliminar dígitos. GET não pede número ao browser nem inicia handshake. Reconnect explícito usa o telefone preservado da tentativa; após encerrar/expirar a tentativa, o usuário deve informar novamente o número.

## Concorrência e webhook

Operações remotas usam lease PostgreSQL de 120 segundos. Pedidos de preparação/conexão concorrentes são coalescidos e devolvem snapshot com operationPending; operações destrutivas em conflito recebem 409. Há versão otimista por conexão. Resposta HTTP antiga não sobrescreve QR/open/close recebido durante a operação.

Webhook não adquire a lease e não chama Evolution. Exige UUID, escopo, ambiente, instanceName, token exclusivo cifrado, comparação constante e timestamp válido. Transação curta grava snapshot/version e estado global de provider conjuntamente. Não armazena body bruto/apikey do envelope. QR e conexão têm clocks separados; timestamps iguais de tipos diferentes não são deduplicados entre si. Para transições de conexão empatadas, close/refused vence open e open vence connecting. Duplicatas e eventos anteriores à tentativa não revivem estado/código.

CAS é repetido até oito vezes, somente em escrita concorrente no banco, sem sleep. Contenção da lease não produz 503 no receiver. Se a escrita não puder ser confirmada, não há ACK falso: conflito extremo recebe 409 para redelivery; falha de persistência recebe 500. Token inválido retorna 401; payload inválido retorna 400. Banco/cofre/configuração indisponíveis continuam erros reais, não sucesso mascarado.

Somente state open de webhook autenticado ou connectionState remoto confirmado marca CONNECTED. Close limpa intenção/códigos e grava motivo; 401 significa sessão WhatsApp encerrada/revogada, **não erro da API key REST**. Não é convertido em CONNECTING. Connecting posterior não mascara logout/timeout sem nova tentativa explícita. O logout local protege contra open recebido durante sua execução e finaliza com novo limite temporal de eventos.

## Operações remotas

Cliente continua usando os endpoints 2.3.7: POST instance/create, GET fetchInstances, GET connectionState, GET connect?number, POST restart, DELETE logout, DELETE delete, POST webhook/set, POST message/sendText. Origin fixo, header apikey backend, HTTPS verificado, DNS público fixado ao socket, sem redirect, timeout HTTP 15 segundos por chamada e resposta limitada.

Configure/prepare consulta o mesmo nome antes de criar e recupera timeout/duplicidade consultando novamente. Instância preparada tem webhook reparado em preparação explícita. Abrir tela/polling/repetir QR válido não executa logout. Troca real de método/número pode cancelar uma sessão pendente porque 2.3.7 ignora number em connecting; antes de cancelar, estado é reconferido para não encerrar uma sessão que acabou de abrir. Expiração pede código atual antes de recuperar. Restart é restrito a pedido explícito e código/tentativa vencidos; não acontece em GET. Recuperação tem cooldown de 30 segundos. PHONE vencido pode exigir cancelamento da sessão pendente para reaplicar o número; isso é distinto de repetir um pairing válido.

## Provisionamento de empresa e envio

A transação de criação de empresa grava provisionRequested e provisionRetryAt. Após commit há tentativa imediata de preparar **sem gerar QR**. A flag sobrevive a falha/restart; manutenção processa até duas pendências por sweep com lease e retry de um minuto. Configuração ausente não rejeita a Promise destacada nem derruba a criação comercial. QR começa somente na configuração do usuário.

Envio GLOBAL permanece no engine/outbox/worker existentes; sua supervisão precisa ser homologada na VPS. A empresa dispõe do send-test e do método interno sendTextMessage(companyId,number,text), sem reutilizar a conexão global. Automação de mensagens de domínio da empresa requer consumidor/outbox próprio conforme os eventos de negócio; não foi criada campanha genérica para destinatário arbitrário.

Erros distinguem 400/401/403/404/409/429/5xx do provider e preservam status sanitizado. REST 401/403 da Evolution vira erro de integração 502 para não renovar indevidamente a sessão do browser; instância ausente/conflito 409, rate limit 429, timeout 504, indisponibilidade 503 e resposta inválida 502. QR/pairing aguardando não são indisponibilidade. Envio distingue rejeição/transitório de aceitação realmente incerta.

## Logs e operação

Logs EVOLUTION contêm ação, connectionId, instanceName/contexto, companyId quando aplicável, evento, estado, motivo, status e duração do webhook. Nunca contêm API key, token, telefone completo de pairing, QR/base64, pairingCode ou body remoto. A instalação Evolution pode possuir logging sensível próprio; ela não foi modificada e seus logs permanecem pendentes de auditoria real.

Migration nova: `20261007150000_evolution_session_snapshot`, aditiva ao schema Kalend. Não muda nomes/contextos de instâncias nem a Evolution. Acrescenta snapshot cifrado, controle de tentativa/version, clock de conexão, motivo e fila de preparação. Preserva clock anterior e limita intenções antigas a cinco minutos, em UTC. As migrations anteriores ficaram intactas. Atualizar schema antes de iniciar o novo backend; não misturar writers antigos e novos durante transição.

Para publicação posteriormente autorizada: revisar preflight e backup → migration Kalend → prisma generate → build API → restart/reload API → build Web com NEXT_PUBLIC_API_URL correto → publicação Web → homologação com aparelho real. Nenhuma dessas operações foi feita na VPS. Não há nova Evolution, Redis, fila externa ou alteração em volumes/configuração do provedor.

## Homologação real pendente

1. Super Admin sem empresa selecionada: preparar/reutilizar kalend_dev_global, receber QR por callback 200 e exibir no navegador.
2. Repetir pedido e abrir duas abas: mesmo vínculo/instância, sem logout indevido ou 503 por lease.
3. Expirar/renovar QR; escanear; observar open e retirada da imagem.
4. Solicitar pairing pelo telefone formatado, verificar dígitos/código, confirmar no celular e observar open.
5. Logout pelo celular e pelo Kalend; close/401 deve mostrar desconectado e limpar códigos.
6. Reconectar, excluir e recriar; token antigo rejeitado, mesmo nome por contexto.
7. Repetir com empresas A/B; usuários comuns bloqueados em GLOBAL e em conexão de outra empresa.
8. Enviar teste GLOBAL/COMPANY para destinatário autenticado; diferenciar aceitação de entrega.
9. Correlacionar logs Kalend/Nginx/Evolution com horários; conferir env, migration/DDL, PM2 e privacidade dos logs do provedor.

Testes HTTP/TLS locais usam provider e persistência simulados; PNGs completos de QR de teste são legíveis, gerados offline e não correspondem a sessões reais. O código de produção somente recebe imagens da Evolution. Homologação física/VPS e a perícia do 503/logout histórico **não são substituídas por testes locais**.
