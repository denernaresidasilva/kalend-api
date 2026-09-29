# Providers globais — fontes e contratos

Consulta: **29/09/2026**. Nenhuma credencial real, conexão SMTP, conta Google, WABA ou instância Evolution foi usada. Contratos exercitados por mocks não são homologação.

## SMTP

Fontes oficiais: [Nodemailer SMTP](https://nodemailer.com/smtp), [segurança da mensagem](https://nodemailer.com/message), [erros SMTP](https://nodemailer.com/errors).

Nodemailer 10.0.12, versão fixada no lock; Node 22 usado na validação. `host`, `port`, `secure`, `username`, `fromName`, `fromEmail`, `replyTo` são públicos; `secrets.password` é write-only. Valores da configuração são strings: `port:"587",secure:"false"` exige STARTTLS; `port:"465",secure:"true"` exige TLS implícito. Certificado validado pelo hostname original mesmo com IP público fixado. Sem porta 25, TLS opcional, URL SMTP, proxy, certificados ignorados ou anexos/URLs externos. Timeout de conexão/greeting 10s, socket 15s, operação 20s, além da resolução DNS limitada. Host precisa estar em `COMMUNICATION_SMTP_HOSTS`.

`verify()` testa negociação/autenticação, não aceitação de um remetente ou entrega. `lastVerifiedAt` é distinto de `lastSentAt`; SMTP aceito não significa caixa de entrada. Não existe sandbox universal SMTP: ambiente SANDBOX é classificação local, não bloqueia entrega real. Homologar com mailbox de teste e infraestrutura apropriada antes de habilitar eventos.

## Gmail

Fontes oficiais: [SASL XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol), [OAuth web server/offline](https://developers.google.com/identity/protocols/oauth2/web-server), [scopes Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes).

A base aceita `clientId`, `fromEmail`, `secrets.clientSecret` e `secrets.refreshToken`; rejeita senha Google. É explicitamente **indisponível para ativar/testar/enviar**, sem OAuth simulado. SMTP `smtp.gmail.com` não aceita fallback de senha por este módulo.

SMTP XOAUTH2 usa `https://mail.google.com/`, amplo demais para presumir uma decisão de envio apenas. Preferência para a implementação futura: Gmail API com `https://www.googleapis.com/auth/gmail.send`, sujeita a consentimento/verificação. Não há aplicativo OAuth/callback registrado no repositório nem fluxo de autorização existente que possa ser reaproveitado. Antes de implementar: projeto Google, tela de consentimento, test users, redirect HTTPS exato, state opaco de uso único vinculado à sessão Super Admin, PKCE quando aplicável, escopos mínimos, armazenamento de refresh token, revogação e reconexão. Endpoints documentados: `https://accounts.google.com/o/oauth2/v2/auth`, `https://oauth2.googleapis.com/token`, `https://oauth2.googleapis.com/revoke`; **não chamados nem implementados** nesta base. Confirmar expiração/limites no modo Testing e requisitos para publicação do app. Não há API key ou senha de conta como substituto de OAuth.

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

Config: `baseUrl` HTTPS root/443, `instance`, `version:"2.3.7"`; secret `apiKey`. Base host em `COMMUNICATION_EVOLUTION_HOSTS`, resolução pública e socket fixado, sem redirects. Mesmo Evolution autohospedado não tem exceção para IP interno. API key pode ser da instância conforme instalação; usar menor privilégio possível.

GET `/instance/connectionState/{instance}` exige `instance.state=open`; POST `/message/sendText/{instance}` envia `number` internacional sem `+`, `text`, `linkPreview:false`; resposta requer `key.id`. Nunca presume aprovação de template Meta. POST administrativo de pareamento chama GET `/instance/connect/{instance}` e retorna somente estado aberto ou QR PNG base64 validado; não retorna API key/hash da instância. QR é material de pareamento temporário: não persistir/logar/cachear. Pareamento por código/telefone fornecido não está implementado.

Não há sandbox padronizado Evolution: usar instância e número exclusivamente de teste. Confirmação de entrega por webhook Evolution fica pendente de contrato/autenticação da instalação exata; não foi criado receiver permissivo. Estado máximo atual do envio é ACCEPTED. Homologar `key.id`, QR, versão instalada, opt-in e operação da conta. Não usar API Evolution de versão diferente por mera semelhança.

## Push

Contrato Transport + canal PUSH + conteúdo title/text e provider indisponível PUSH_PENDING. O repositório não tem Expo/React Native, app IDs, registro de dispositivos ou provider Push. Nenhum token é aceito/persistido e nenhum canal Push pode ser ativado. Definir FCM/APNs/Expo, consentimento, device ownership, credenciais e deep links em fase própria; o motor global não reutilizará tokens tenant.
