# Providers globais — fontes e contratos

Consulta: **29/09/2026**. Nenhuma credencial real, conexão SMTP, conta Google, WABA ou instância Evolution foi usada. Contratos exercitados por mocks não são homologação.

## SMTP

Fontes oficiais: [Nodemailer SMTP](https://nodemailer.com/smtp), [segurança da mensagem](https://nodemailer.com/message), [erros SMTP](https://nodemailer.com/errors).

Nodemailer 10.0.12, versão fixada no lock; Node 22 usado na validação. `host`, `port`, `secure`, `username`, `fromName`, `fromEmail`, `replyTo` são públicos; `secrets.password` é write-only. Valores da configuração são strings: `port:"587",secure:"false"` exige STARTTLS; `port:"465",secure:"true"` exige TLS implícito. Certificado validado pelo hostname original mesmo com IP público fixado. Sem porta 25, TLS opcional, URL SMTP, proxy, certificados ignorados ou anexos/URLs externos. Timeout de conexão/greeting 10s, socket 15s, operação 20s, além da resolução DNS limitada. Hosts personalizados precisam estar em `COMMUNICATION_SMTP_HOSTS`. Os hosts oficiais smtp.gmail.com, smtp-mail.outlook.com e smtp.mail.me.com são pré-autorizados, independentemente dessa variável.

`verify()` testa negociação/autenticação, não aceitação de um remetente ou entrega. `lastVerifiedAt` é distinto de `lastSentAt`; SMTP aceito não significa caixa de entrada. Não existe sandbox universal SMTP: ambiente SANDBOX é classificação local, não bloqueia entrega real. Homologar com mailbox de teste e infraestrutura apropriada antes de habilitar eventos.

## Gmail

Implementado na Fase 3 via Gmail API e OAuth 2.0 (gmail.send + openid/email), state single-use, PKCE S256, binding de navegador/sessão e tokens cifrados. Não aceita senha Google ou refresh token administrativo. Fonte/contratos completos e configuração operacional: [Fase 3](PHASE3-COMMUNICATION.md). O gerenciador SMTP permite smtp.gmail.com com senha de app; essa opção é distinta da integração Gmail API legada.

## Meta WhatsApp Cloud API

As páginas principais Meta retornaram HTTP 429 nesta consulta, inclusive as URLs atuais `developers.facebook.com/documentation/business-messaging/whatsapp/...`. Foram consultadas fontes oficiais alternativas:

- [Coleção oficial Meta: autenticação, permissões, paginação e WABA](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-ba924e99-3d98-4954-b4e3-73a519939c33).
- [Envio de template — coleção Meta](https://www.postman.com/meta/whatsapp-business-platform/request/lwtlz1k/send-message-template-interactive).
- [Listagem de templates — coleção Meta](https://www.postman.com/meta/whatsapp-business-platform/request/qtgr0i7/get-all-templates-default-fields).
- [SDK Business oficial atual: WABA, listagem/criação, categorias/status](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/whatsappbusinessaccount.py).
- [Recibos de status — coleção Meta](https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications).
- [SDK Node oficial: template](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/template/) e [assinatura de webhooks](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/). **SDK arquivado**: usado como referência complementar, não instalado nem apresentado como SDK atual. Homologar o comportamento com a versão fixada.

REST em `https://graph.facebook.com/{version}`; Bearer `accessToken`. `whatsapp_business_management` para administrar templates, `whatsapp_business_messaging` para mensagens. Permissão de portfolio não solicitada automaticamente. Configuração: `phoneNumberId`, `businessAccountId`, `graphVersion`; segredos write-only `accessToken`, `appSecret`, `verifyToken`. Não há URL arbitrária de Graph. Versão sem default: `graphVersion` precisa coincidir com `COMMUNICATION_META_GRAPH_VERSION`. `v25.0` aparece apenas nos testes fake; não é alegação de versão mais recente/definitivamente homologada. Operador deve selecionar e fixar versão suportada na homologação.

- GET `/{WABA}/message_templates`: teste de acesso à gestão, não prova permissão de envio/telefone registrado.
- POST `/{phoneNumberId}/messages`: somente template `BODY` textual; verifica id/nome/idioma/APPROVED no WABA antes de enviar. Sem texto livre, mídia, header ou botões silenciosamente descartados. Suporta parâmetros posicionais de texto de templates existentes, mapeados para allowlist do evento. Retorno `messages[0].id` vira providerMessageId, status ACCEPTED.
- GET/POST `/webhooks/communication/meta`: challenge com verifyToken independente e assinatura `X-Hub-Signature-256` HMAC-SHA256 do raw body com appSecret. Somente conta/telefone configurados; recibos sent/delivered/read/failed. Não armazena mensagens recebidas, contatos nem payload bruto. Replay não gera nova entrega/log de transição. READ não regride. Recibo anterior à persistência de messageId recebe 503 para redelivery. Em crash com messageId perdido, a entrega permanece incerta e pode exigir investigação externa.

Configurar callback HTTPS e assinatura do campo `messages`/app no WABA pelo procedimento Meta. Nenhuma inscrição automática é feita por teste. `appSecret`/`verifyToken` são necessários para o receiver; token de teste temporário não equivale a token operacional. Conta/número de teste, destinatários permitidos e restrições de produção dependem do setup Meta; homologar antes de ativar. Templates comerciais exigem consentimento/uso permitido e aprovação vigente; este motor não cria opt-in por suposição.

## Meta Templates administrativos

GET/POST `/{WABA}/message_templates` conforme SDK oficial. Submissão implementada somente para categoria UTILITY e componente BODY **estático** (nome, idioma, texto). Templates com variáveis podem ser sincronizados de modelos criados no WhatsApp Manager; envio aceita parâmetros posicionais de texto. Submissão de modelos com exemplos, mídia, marketing, authentication ou outros componentes exige ampliação de contrato e homologação; não é aceita por suposição.

Status é sempre fornecido pela Meta e sincronizado; nunca atribuído APPROVED por criação local. IDs são persistidos em `GlobalCommunicationMetaTemplate` durante sincronização. Submissão retorna id externo e `syncRequired`; em erro/timeout, sincronizar antes de qualquer nova tentativa. Não há retry automático de criação. Listagem local limitada a 100; sincronização remota é uma página por chamada com cursor `after` e sinal explícito de continuação. Nunca segue `paging.next` com token. Sync não significa que o inventário completo foi percorrido. Antes de envio, status é reconsultado, sem depender apenas do cache local.

## Evolution API

O portal `doc.evolution-api.com/v2` estava indisponível pela ferramenta. Contrato conferido no repositório oficial, cuja versão declarada consultada era **2.3.7**:

- [Manifest/version](https://github.com/EvolutionAPI/evolution-api/blob/main/package.json).
- [Rotas de mensagens](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/routes/sendMessage.router.ts) e [DTO number/text](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/dto/sendMessage.dto.ts).
- [Rotas de instância](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/routes/instance.router.ts), [controller de conexão/status](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/controllers/instance.controller.ts), [tipo de QR](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/types/wa.types.ts).
- [Autenticação apikey](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/guards/auth.guard.ts).

Implementação vigente em 07/10/2026: [Evolution — contratos, retenção e operação](EVOLUTION-INTEGRATION.md). Backend usa origin fixo https://evolution-api.kalend.tech e EVOLUTION_API_KEY em ambiente; configuração/credenciais/instanceName não são editáveis no Web. COMMUNICATION_EVOLUTION_HOSTS não é consumida.

GET connectionState confirma open. GET connect e connect?number são usados somente em operações explícitas de conexão; polling não inicia handshake/restart/logout. QR/pairing recebidos pelo webhook são preservados cifrados e com TTL no PostgreSQL Kalend. API fornece o mesmo DTO de sessão para endpoints nativos e pareamento legado. Código/QR ainda pendente não causa 503. Receiver exige token exclusivo por vínculo/contexto, não sessão do usuário; HTTP 200 somente após aceite durável ou evento já obsoleto/duplicado.

POST message/sendText envia number internacional, text e linkPreview:false; key.id confirma aceitação. GLOBAL resolve destinatário autorizado; COMPANY usa seu vínculo e possui send-test para o próprio usuário OWNER/ADMIN. Confirmação de entrega Evolution não foi implementada: estado máximo atual é ACCEPTED. Pairing por número está implementado. Não existe sandbox universal WhatsApp; homologar na instância DEV corretamente atribuída e com aparelho de teste, sem modificar a instalação Evolution.

## Push

O identificador compatível PUSH_PENDING agora possui transporte WEB_PUSH real, VAPID write-only, subscriptions globais cifradas e delivery por dispositivo no outbox existente. Android/iOS nativo continuam indisponíveis explicitamente. Contratos, segurança de rede, operação e fontes: [Fase 3](PHASE3-COMMUNICATION.md).
