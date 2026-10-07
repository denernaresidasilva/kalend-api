# Política temporal do webhook Evolution

## Diagnóstico específico de 2026-10-07

Na imagem OCI `evoapicloud/evolution-api:v2.3.7` disponível em
`../evolution-api/evolution-api-v2.3.7.tar`, a configuração da imagem inclui
`TZ=America/Sao_Paulo`. O código compilado
`evolution/dist/api/abstract/abstract.router.js`, método `sendDataWebhook`, calcula:

```js
const offset = new Date().getTimezoneOffset() * 60000;
const dateTime = new Date(Date.now() - offset).toISOString();
```

O controlador de webhook transmite `dateTime` como `date_time`. O produtor desloca
um instante pelo offset local e o serializa com `Z`. Isso explica a diferença
observada de três horas; não é necessário corrigir timezone no consumidor.
A imagem local comprova o comportamento dessa versão, não as configurações
runtime da VPS, que não foram consultadas ou alteradas nesta correção.

O Kalend recebe o campo em `EvolutionService.webhook`. Antes da correção,
`new Date(payload.date_time)` interpretava `Z` como UTC, offset explícito como o
instante correspondente e datetime sem offset no timezone local do Node.
`Date.now()` é epoch em milissegundos, independente de timezone. O erro era usar
o instante deslocado do produtor como início do TTL e compará-lo com
`attemptStartedAt`, do relógio local. `codePatch` podia então salvar fingerprint e
`QR_AVAILABLE`, mas ciphertext nulo e `CODE_EXPIRED`.

A checagem anterior de `date < attemptStartedAt` também podia rejeitar o webhook
antes da persistência. Portanto, um log `QR received` isolado não comprova que esse
mesmo payload tenha passado esse guard: o log existe também na captura da resposta
HTTP. Para distinguir a trajetória exata na VPS são necessários os logs completos
correlacionados. O defeito e o cenário dos horários informados estão reproduzidos
nos testes locais.

`ERROR` com `connectionRequested=false` pode ser produzido pelo timeout da
tentativa (inclusive maintenance) ou pelo evento sem imagem de limite de QR. Não é
o estado diretamente produzido por `codePatch`. A consulta final, feita minutos
depois, não identifica sozinha qual desses caminhos ocorreu.

## Relógios separados

- `receivedAt`: capturado na entrada do método, antes do banco e dos retries.
- QR novo: TTL visual de 60 segundos após recebimento; pairing: 120 segundos.
- Fingerprint idêntico: conserva a expiração original, inclusive após expirar.
- `lastQrAt` e `lastSeenAt`: horário local de captura/observação do código.
- `lastWebhookAt`: watermark do provedor para `qrcode.updated`.
- `lastConnectionEventAt`: watermark do provedor para `connection.update`.
- Logout não injeta mais horário local no watermark do provedor.
- `attemptStartedAt` / `attemptExpiresAt`: relógio local; a tentativa continua
  finita e não é reaberta pelo webhook após cancelamento/timeout.

Os watermarks podem legitimamente estar atrás da tentativa local. Não são campos
que comprovam o horário de chegada. O recebimento está nos logs e `lastSeenAt`;
nenhum watermark existente é convertido ou reescrito automaticamente.

O schema Prisma e as migrations usam `TIMESTAMP(3)` sem timezone. Esses campos
não guardam o timezone do servidor. Datas escritas via Prisma representam as datas
JS serializadas pelo adapter; a expiração é comparada na aplicação antes da
persistência e não depende de `SHOW timezone`. O timezone runtime do PostgreSQL
DEV e o `TZ` runtime do Node da VPS não foram verificados, nem são inferidos dos
valores SQL apresentados.

## Ordenação, replay e limites

Timestamp válido exige offset explícito (`Z` ou `±HH:MM`); datetime ambíguo é
rejeitado. Admissão tolera no máximo 24 horas de diferença absoluta entre os
relógios, em ambas as direções. É uma janela de tolerância de relógio/transporte,
não uma conversão de timezone nem TTL do código. A simetria acomoda o comportamento
do produtor também em offsets positivos. Fora dessa janela o evento não modifica
o snapshot.

Watermarks persistidos rejeitam QR com timestamp menor ou igual, QR anterior à
última transição e transição anterior ao QR atual. Duplicatas com timestamp posterior
e o mesmo código não estendem TTL. Mantêm-se autenticação por segredo/instância,
restrições de ambiente, tentativa ativa, prioridade terminal em empates e escritas
com controle otimista de versão. Connecting preserva código válido; open remove
códigos e encerra a tentativa.

Limite do protocolo: sem identificador de tentativa emitido pelo provedor, timestamp
absoluto confiável ou identificador único de evento, não é possível distinguir um
primeiro evento nunca observado, atrasado dentro da tolerância, de um evento novo
com relógio deslocado. A janela limita esse risco; watermarks impedem replay já
observado e eventos antigos substituindo QR novo. Não se afirma proteção absoluta
contra um evento antigo nunca observado dentro da tolerância. Também não se
promete que o WhatsApp aceite o código durante todo o TTL visual local.

## Escopo e validação

Sem ajuste de horas, sem timezone codificado, sem mudanças na Evolution ou Web,
sem acesso/mutação ao DEV e sem nova migration. Testes incluem os horários exatos
20:24:51Z / 17:24:51Z, QR/pairing, substituição, replay, connecting/open, expiração,
offset positivo e datetime sem offset. O teste HTTP usa o banco em memória da
suíte, o cliente Web real e renderização React; não usa PostgreSQL DEV real.
