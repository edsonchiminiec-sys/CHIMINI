# Projeto IQG — SDR IA para WhatsApp

## O que é este sistema

CRM/SDR com IA para WhatsApp da empresa IQG (Indústria Química Gaúcha).
Atende leads automaticamente: explica o programa, qualifica, coleta dados de
cadastro, faz follow-up e agenda recontatos.

- **Arquivo principal:** `server.js` (~33 mil linhas, Node.js + Express + MongoDB)
- **Produção:** roda no Render — https://iqg-whatsapp-bot.onrender.com (porta 10000)
- **Modelo de IA usado internamente:** GPT-4o-mini via API da OpenAI
- **O dono do projeto não é programador.** Explique tudo em linguagem simples,
  sem jargão. Antes de editar, diga o que vai fazer e por quê.

## Regras de trabalho (importantes)

1. **Sempre use Git.** Antes de qualquer alteração, garanta que há um commit
   limpo para poder reverter. Depois de cada correção testada, faça commit.
2. **Uma correção por vez.** Não empilhe várias mudanças. Corrija, teste,
   confirme que funciona, só então passe para a próxima.
3. **Teste antes de entregar.** No mínimo, rode `node server.js` para confirmar
   que sobe sem erro de sintaxe. Crie testes quando fizer sentido.
4. **Nunca edite direto na produção.** Trabalhe local, teste, e só então o dono
   sobe para o Render manualmente.
5. **Rastreie dependências antes de editar.** Se for mexer numa variável ou
   função, procure TODOS os usos dela antes. (Um bug grave já aconteceu por
   editar uma variável usada em duas funções sem perceber.)

## Arquitetura — como uma mensagem é processada

Cada mensagem do lead passa por ~10 camadas no webhook:
webhook → buffer → extração de dados → roteador semântico da coleta →
classificador semântico → historiador de continuidade → política do turno →
consultor Pré-SDR → SDR (gera a resposta) → travas pós-resposta → supervisor.

Funções e conceitos-chave:
- `runLeadSemanticIntentClassifier` — classifica a intenção da mensagem do lead
- `runConversationContinuityAnalyzer` — o "Historiador", entende continuidade
- `runConsultantAssistant` — o "Pré-SDR", orienta a resposta
- `obterDataHojeBrasil()` — função única que dá data/hora atual (fuso Brasília)
- `recuperarDadosCadastraisDoHistorico` — varre o histórico e recupera dados
  já confirmados pelo lead
- `scheduleClientCallback` — cria recontato agendado no banco
- `dataFlowQuestionAlreadyGuided` — flag: "esta mensagem não é dado cadastral,
  os GPTs precisam processá-la"
- Collections MongoDB: `leads`, `conversations`, `scheduled_callbacks`
- Crons: follow-ups e recontatos rodam a cada 60s
- Dashboard em `/dashboard` (5 janelas + caixa de Recontatos Agendados)

## Estado atual (correções já aplicadas em 18/05/2026)

Estas correções já estão em produção e funcionando:
1. Bloco de extração de dados respeita `dataFlowQuestionAlreadyGuided`
2. Detecção de agendamento é semântica (campo `schedulingRequest` do classificador)
3. O classificador calcula a data do agendamento (`schedulingDate`, `schedulingTime`)
4. Orientação `agendamento_decisivo` resolve contradição de orientações
5. Caixa de "Recontatos Agendados" no dashboard
6. Função `obterDataHojeBrasil()` — fonte única de data
7. Extrator de nome rejeita frases que não são nome (`palavrasQueNuncaSaoNome`)
8. Detector de confirmação só salva campo se lead não negou e valor é válido
9. Função `recuperarDadosCadastraisDoHistorico`

## Problemas conhecidos a corrigir (ver relatório de auditoria)

Há um relatório de auditoria detalhado (arquivo `auditoria-conversas-followups.md`).
Resumo dos problemas em aberto, em ordem de prioridade:

1. **Nome-lixo nos follow-ups** — a saudação usa o nome do perfil do WhatsApp,
   que pode ser e-mail, número ou emoji. Validar o nome antes de usar; se for
   inválido, usar saudação neutra. Reaproveitar `isInvalidLooseNameCandidate`.
2. **Follow-up fala de "investimento que conversamos"** para leads que nunca
   chegaram nessa fase. A mensagem deve conferir a fase real do lead.
3. **Cadência regride/rebaixa** — follow-up trata lead avançado como iniciante;
   step 5 oferece Afiliado a lead que estava quase fechando.
4. **Mensagens de follow-up genéricas e repetitivas** — cada step deveria ter
   um propósito distinto.

Há também uma fragilidade de arquitetura: o sistema tem muitas camadas
(roteadores, travas, políticas) que às vezes se contradizem — aparece nos logs
como `contradicao_orientacao_pre_sdr`. Vale avaliar uma consolidação dessas
camadas, mas com cuidado, testando bastante.

## Como validar mudanças

- O sistema gera logs detalhados e relatórios de auditoria em JSON
  (acessíveis pelo dashboard, rota `/auditoria`).
- Lead de teste: telefone `555496223975`.
- Ao testar uma correção, peça ao dono para mandar uma mensagem de teste pelo
  WhatsApp e conferir o log/auditoria do resultado.
