# Revisão de ameaças — comunicação GLOBAL

Revisão local em 29/09/2026, sem pentest remoto, dados reais ou homologação. Não se declara isolamento PostgreSQL comprovado por mocks.

| Ameaça | Controle implementado | Limite/validação operacional |
| --- | --- | --- |
| SSRF SMTP | Allowlist exata de host definida por env; DNS A/AAAA público; IP fixado no socket; somente 465/TLS ou 587/STARTTLS; certificado/hostname verificados; sem acesso a arquivo/URL de conteúdo | Egress firewall recomendado; nenhum IP interno permitido nem em DEV. Testar provedor real após revisão |
| SSRF Evolution | HTTPS root/443, sem userinfo/query/fragment, host em allowlist, DNS/IP público fixado, sem redirects/proxy | Instância interna exige futura política explícita; não há bypass administrativo |
| DNS rebinding | Revalida a cada conexão; não re-resolve hostname após selecionar IP; rejeita respostas privadas/mistas | Resolver operacional deve ser confiável; falha de DNS sem socket é transitória |
| OAuth theft | Cofre write-only; OAuth real com state single-use, PKCE S256, binding de navegador/sessão e callback servidor | Homologação Google, cadastro externo do cliente e supressão de query do callback em proxy/APM pendentes |
| Secret leakage | AES-256-GCM e AAD segregado de gateways; listagem explícita; sem exceptions/payloads externos persistidos | Configurar redaction de proxy/APM e controle de acesso ao banco/backups; chave não deve ser logada |
| Mass assignment | Parsers runtime com allowlist; IDs/ambiente/provider/status não são aceitos fora do contrato | Não existe API tenant para config global |
| Template injection | Expressões limitadas a `{{variavel}}`, allowlist por evento e campos escalares; não executa JS/objetos nem substituição recursiva | Conteúdo válido pode ser inadequado editorialmente; revisão do Super Admin continua necessária |
| HTML/header injection | HTML derivado exclusivamente de texto escapado; sem HTML livre; CR/LF em subject/fromName rejeitados; limite de saída renderizada | Layout HTML/deep links avançados não suportados |
| Webhook spoofing | Meta HMAC-SHA256 sobre bytes originais, comparação constante, verificação antes de JSON; WABA/phoneId conferidos; corpo limitado | App/assinatura real precisa homologação; nenhum webhook Evolution permissivo |
| Replay/out-of-order | Atualização condicional e monotônica de recibos; logs só na transição; nenhum recibo cria comunicação ou altera financeiro | Recibo sem messageId correlacionado retorna 503 para redelivery; erro/crash pode exigir investigação |
| Cross-tenant leakage | Tabelas/config/templates explicitamente GLOBAL; sem campo de tenant configurável; referência companyId determina OWNER, revalidado ao envio | Futuro TENANT exige repositórios/config/secret/log separados, não fallback global |
| Abuso Super Admin | AdminGuard existente consulta sessão/usuário/privilégio atual; Origin/CSRF; rate limit compartilhado no PostgreSQL | Não adiciona MFA; conta Super Admin comprometida ainda pode mudar conteúdo público |
| Arbitrary recipient | Teste somente para e-mail/telefone atual do próprio Super Admin, sem parâmetro de endereço; eventos somente OWNER ativo | Telefone E.164 validado não comprova titularidade/consentimento; homologar política de contato |
| Test/pairing abuse | 5/admin e 20 globais por 5min; sem repetição automática de testes; QR limitado a PNG e não persistido | QR é dado sensível temporário destinado ao pareamento; nunca copiar para logs/cache |
| Queue poisoning | Evento/canal/variável/destinatário validados; nenhuma API pública de enqueue; eventos inválidos são finalizados como OUTBOX_INVALID; payload cifrado vinculado ao UUID | Escrita direta privilegiada no banco não é fronteira de segurança confiável; schema/migration exigem revisão |
| Duplicate delivery | Fato único por businessKey, entrega única evento/usuário/canal, claims condicionais, expansão transacional com SKIP LOCKED | Não promete exactly-once externo. Resultado incerto nunca é repetido automaticamente |
| Corrida config/template | Snapshot de revisões/ambiente, comparação no teste e revalidação antes do envio; mudança de conta/ambiente com histórico bloqueada | Alteração depois da última revalidação pode coincidir com requisição em voo; não há cancelamento distribuído de envio já iniciado |
| Provider timeout | DNS limitado, HTTPS deadline 15s/256KiB, SMTP prazo total 20s e socket controlado/destruído; 5 tentativas máximas | Timeout externo pode ter sido aceito; UNCERTAIN precisa investigação |
| Logs/PII | Código sanitizado, destinatário mascarado, ciphertext não exposto; corpo/contato criptografado e removido no terminal | Variáveis mínimas financeiras, IDs e logs precisam retenção operacional aprovada; nenhuma rotina destrutiva aplicada |
| Falha de comunicação afetar cobrança | Nenhum transporte/cofre/template em transação financeira; worker separado; Fase 1 preservada | A captura outbox é transacional: indisponibilidade da tabela/banco impede commit, como qualquer escrita durável. Não há catch que descarte fatos silenciosamente |

## Criptografia

Reutilização de SecretVault e GATEWAY_ENCRYPTION_KEY (32 bytes em hex), nonce aleatório de 12 bytes e autenticação GCM. Credenciais AAD `communication:GLOBAL:{provider}:{environment}:credentials`; snapshots AAD `communication:GLOBAL:delivery:{uuid}`. Ciphertext de gateway não descriptografa nesse domínio. PATCH segredo omitido/vazio preserva, null remove. API não retorna plaintext, ciphertext, refresh token, apiKey, appSecret ou verifyToken. Não há nova chave mestra.

Rotação da chave exige recriptografia de gateways, credenciais globais e snapshots pendentes antes de descartar a chave antiga. Essa rotina não foi executada/automatizada. Falha do cofre durante expansão faz rollback; não considera o evento enviado.

## Limitações explícitas

- Testes com banco fake não provam locks, unicidade e execução dos triggers em PostgreSQL. Migration deve ser aplicada posteriormente em banco descartável por procedimento autorizado, com testes de rollback/replay/concorrrência e transições comerciais.
- A captura usa triggers PostgreSQL: precisam ser mantidos junto da migration, pois Prisma schema não representa triggers. `db push` não substitui migrations. Não existe backfill automático nem envio de pagamentos históricos.
- Credenciais SANDBOX não são tecnicamente isoladas pelo provedor SMTP/Evolution: usar instâncias/contas de teste, separados de produção.
- SMTP/Evolution não têm confirmação de leitura/entrega implementada; ACCEPTED é somente aceitação pelo transporte.
- Gmail/Web Push implementados na Fase 3; infraestrutura externa e homologação real ainda necessárias. Veja PHASE3-COMMUNICATION.md. Meta suporta subconjunto documentado de templates e não sincroniza inventário completo numa única chamada.
- Proteção de rede adicional, opt-in/política de mensagens, retenção e homologação são etapas de operação. Nenhum dado/ambiente real foi usado para alegar conformidade legal.
