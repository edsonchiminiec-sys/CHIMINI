# TODO — pendências fora dos 7 bugs da auditoria

Itens encontrados durante a auditoria dos 7 bugs principais. Entram na fila
**depois** da correção dos 7. Não são bloqueadores, mas vale registrar para
não esquecer.

## 1. `applyAntiRepetitionGuard` só roda em mensagens curtas do lead

**Onde:** `server.js:17229` (função `applyAntiRepetitionGuard`), linha
17244-17251 — early return quando `isShortNeutralLeadReply(leadText) === false`.

**Problema:** se o lead manda um parágrafo, todo o detector de repetição é
pulado, mesmo que a resposta da SDR repita tema. É "irmão" do Bug 4
(detector de tokens) — mesmo após o Bug 4 corrigido, esse detector continua
inerte para mensagens médias/longas do lead.

**Sugestão de correção:** ampliar `isShortNeutralLeadReply` para incluir
mensagens médias (até ~200 chars), ou aplicar o guard sempre, com
threshold de similaridade.

**Prioridade:** baixa-média.

---

## 2. Duplicação da lógica de "estado protegido"

**Onde:**
- `server.js:21603-21611` — filtro Mongo em `runFollowupCronTick`
- `server.js:20785` — função `isLeadInProtectedFollowupState`
- Vários outros pontos chamam `shouldStopBotByLifecycle` + `isLeadInProtectedFollowupState`

**Problema:** as condições de "lead protegido" estão duplicadas em dois
lugares (filtro Mongo + função imperativa). Foi exatamente essa duplicação
que abriu o Bug 1 (`cadenciaPausadaPorCliente` faltava em um dos dois).
Mantendo dois lugares, há risco recorrente de bug de divergência.

**Sugestão de correção:** uma única fonte da verdade — uma função
`buildProtectedLeadFilter()` que devolve o filtro Mongo, e
`isLeadInProtectedFollowupState` chamando a mesma lógica em modo
imperativo a partir do objeto lead.

**Prioridade:** baixa (dívida estrutural).

---

## 3. `getSmartFollowupMessage` é código morto

**Onde:** `server.js:20516` — definida mas nunca chamada em nenhum lugar
do arquivo (`grep -n "getSmartFollowupMessage" server.js` mostra só a
definição).

**Problema:** confunde leitura do fluxo de follow-up. Quem olha o código
acha que existem 3 funções de mensagem (`getSmartFollowupMessage`,
`getSafeStageFollowupMessage`, `getFinalFollowupMessage`), mas só duas são
usadas. Acabei caindo nessa quando fiz as correções dos Problemas 1-4.

**Sugestão de correção:** apagar a função inteira (~130 linhas).

**Prioridade:** baixa (cosmético, mas reduz ruído).

---

## 4. Bug E candidato — proteção 15min do cron sem ajuste de expediente

**Onde:** `server.js:~21900`, dentro de `runFollowupCronTick`, logo após pegar o lock atômico.

**Trecho:**
```js
const protecaoProximoFollowup = new Date(Date.now() + 15 * 60 * 1000);
await db.collection("leads").updateOne(
  { user: candidato.user, followupLockEm: novoLock },
  { $set: { proximoFollowupEm: protecaoProximoFollowup } }
);
```

**Problema:** seta `proximoFollowupEm = agora + 15min` sem ajustar para horário
comercial. Em condição normal, `sendAutomaticFollowupIfStillValid` roda em
seguida e sobrescreve com a data correta (via `computeNextFollowupDate` /
`adjustToBusinessBR`). Esse valor **só persiste** se a função falhar antes
do avanço (timeout do WhatsApp, erro no GPT, exception não tratada).

**Por que ficou fora do hotfix de cadência madrugada (Bugs A/B/C/D):** caso
raro — exige falha específica entre o lock e o avanço do step. Não foi a
causa direta do caso Paulo. O log defensivo do commit `0056e38` (instrumentação
temporária) captura via `disparo_fora_expediente_detectado` se acontecer.

**Sugestão de correção:** ajustar a proteção também ao horário comercial.
Algo como:
```js
const protecaoProximoFollowup = isBusinessTime()
  ? new Date(Date.now() + 15 * 60 * 1000)
  : adjustToBusinessBR(new Date(Date.now() + 15 * 60 * 1000));
```

**Prioridade:** baixa-média. Só ataca se o `disparo_fora_expediente_detectado`
mostrar evidência de disparo causado por esse caminho nos próximos 14 dias.

---

## 5. Bug 7b candidato — 3 caminhos que consomem `positiveCommitment` sem cruzamento local

**Contexto:** o fix do Bug 7 (commit principal: defesa em profundidade no prompt
do classificador + função `iqgLeadHasStrongUnderstandingSignal`) ataca a fonte
(prompt GPT) e o consumo central (atalho da função `hasStrongUnderstanding`).
Três outros consumidores de `semanticIntent?.positiveCommitment === true`
NÃO foram tocados:

**(a) `server.js:6298`** — parte de condição de avanço comercial:
```js
(positiveRealInterest === true ||
 positiveCommitment === true ||
 semanticContinuity?.leadQuerAvancar === true)
```
Risco médio. Tem OR com `leadQuerAvancar` de outro analyzer (continuidade),
o que dá salvaguarda parcial. Se o GPT errar e os outros não compensarem,
dispara avanço comercial indevido.

**(b) `server.js:6402`** — `classifierSawCommitment` (gate central do Ponto 3
do mapa de etapas; consolidação de compromisso):
```js
const classifierSawCommitment =
  semanticIntent?.positiveCommitment === true &&
  semanticConfidenceOk &&
  !hasObjection;
```
Risco alto. Tem `semanticConfidenceOk` e `!hasObjection` como salvaguarda,
mas se o GPT marca com confidence alta e não há objeção textual, dispara
marcar `etapas.compromisso = true` + `etapas.compromissoPerguntado = true`.

**(c) `server.js:14833`** — `strongAcceptance` (decisão de aceite de taxa
para liberar pré-cadastro):
```js
const strongAcceptance =
  !mensagemAtualEhSaudacaoOuVazia &&
  (taxDecisionMessageIsStrongAcceptance(text) ||
   semanticIntent?.positiveCommitment === true ||
   semanticIntent?.paymentIntent === true);
```
Risco médio-alto. Proteção contra saudação vazia existe, mas não contra
ack composto tipo "Por enquanto sim, fale mais".

**Estratégia de correção (quando virar prioridade):** aplicar mesmo padrão
do Bug 7 (b) — exigir co-ocorrência com âncora textual local antes de
confiar no flag do GPT. Pode reutilizar a constante
`STRONG_UNDERSTANDING_TEXT_ANCHORS` definida em server.js.

**Critério de priorização:** se aparecer evidência nos próximos dias de
etapas avançando em cascata (lead diz "sim, fale mais" e fica com
`compromisso: true` no banco), promover este TODO a fix dedicado.

**Prioridade:** média. Defesa em profundidade adicional, não bloqueia hoje.

---

## 6. Bug 5b candidato — findings de prioridade ALTA não revalidados após regeneração

**Contexto:** o fix do Bug 5 introduziu loop de revalidação após regeneração,
mas apenas para findings de prioridade `critica`. Findings de prioridade
`alta` que reaparecem após regeneração seguem para `sendWhatsAppMessage` sem
nova tentativa.

**Findings altos não revalidados:**
- `loop_resposta_repetida`
- `repeticao_de_tema`
- `repeticao_objecao_taxa`
- `resposta_generica_ou_fraca`
- `tentativa_reiniciar_funil`

**Por que ficaram de fora do Bug 5:** custo de revalidação adicional
(`runFinalRouteMixGuard` é async com fetch OpenAI; rodar para todos os
altos dobraria latência). Impacto comercial menor que críticos (não
queimam lead diretamente, mas degradam qualidade conversacional).

**Estratégia de correção (quando virar prioridade):** estender
`revalidarCriticosEstruturais` para receber parâmetro `incluirAltos: bool`
e rerodar `applyAntiRepetitionGuard`, `applyTaxObjectionAntiRepetitionGuard`,
`isRepeatedBotReply`, etc. Ou: criar função análoga
`revalidarAltosEstruturais` chamada SOMENTE se críticos já estão zerados
e o monitoramento mostrar volume relevante.

**Critério de priorização:** observar `regeneracao_sdr_tentativa_sucesso`
nos próximos 14-30 dias. Se respostas regeneradas estão saindo com finding
alto não tratado em volume relevante (>20% dos turnos pós-regen), atacar.

**Prioridade:** baixa-média. Depende dos números do monitoramento.

---

## 7. Bug 9 candidato — barreiras finais do orquestrador sobrescrevem fallback humano do Bug 5

**Onde:** `server.js:~28085` (fallback humano do Bug 5 substitui `respostaFinal`) →
`server.js:~28400+` (barreiras finais de coleta podem sobrescrever em casos
limítrofes).

**Problema:** quando o fallback do Bug 5 dispara (regeneração falhou em
eliminar críticos após 2 tentativas), substitui `respostaFinal` pela
mensagem de handoff humano. Mas o flow continua: linhas 28253, 28284,
28292, 28400+ ainda rodam sobre essa string. Se o lead tiver dados
completos no banco, a barreira final 28400+ pode trocar o handoff humano
por uma mensagem de coleta automática — anulando o fallback.

**Identificado:** Fase 1 da auditoria de fluidez, observação S-1.

**Sugestão:** após substituir `respostaFinal` no fallback humano, definir
flag `respostaFinalIsHumanHandoff = true` e fazer as barreiras finais
checarem essa flag antes de sobrescrever.

**Prioridade:** média. Não bloqueia produção, mas anula a proteção do Bug 5
em cenário específico (lead com dados completos + regeneração falhando).

---

## 8. Bug 10 candidato — latência 12-20s por GPTs em cascata

**Onde:** caminho crítico inteiro do webhook (~7-8 chamadas OpenAI no pior
caso: 3 classifiers + composer + regenerator + revalidação async +
finalRouteMixGuard).

**Problema:** latência total no pior cenário atinge ~12-20s. Já está no
limite do que o lead aguarda no WhatsApp sem mandar nova mensagem (que
quebra contexto, força debounce, etc.).

**Identificado:** Fase 1 da auditoria de fluidez, observação S-4.

**Estratégia possível:** rodar classifiers em paralelo onde possível
(continuidade + intent + truncamento podem ser merged num só prompt),
adicionar cache de continuity analyzer pra turnos consecutivos, fazer
runFinalRouteMixGuard estritamente sob demanda.

**Prioridade:** baixa-média. Projeto à parte. Atacar quando outros fixes
estabilizarem e métricas mostrarem latência percebida como problema real
pelos leads (drop-off por debounce, etc.).

---

## 9. Bug 11 candidato — possível chamada órfã de regenerateSdr

**Onde:** `server.js:~28209` — segunda chamada a `regenerateSdrReplyWithGuardGuidance`,
fora do loop introduzido pelo Bug 5.

**Problema suspeito:** o Bug 5 introduziu loop com retry no gate principal
(linha ~27641). Mas existe outra chamada a `regenerateSdrReplyWithGuardGuidance`
na linha ~28209 — pode ser:
(a) remanescente pré-Bug 5 que deveria ter sido removida, ou
(b) chamada legítima de outro fluxo paralelo.

**Identificado:** Fase 1 da auditoria de fluidez, observação S-2.

**Próximo passo:** investigar o contexto da linha 28209 — se for remanescente,
remover; se for legítimo, documentar.

**Prioridade:** baixa. Não causa bug observável (chamada redundante apenas
gasta 1 round trip OpenAI extra em alguns casos).

---

## 10. Bug 12 candidato — refatoração arquitetural do SYSTEM_PROMPT

**Onde:** SYSTEM_PROMPT principal (`server.js:9142-11002`, 1861 linhas) +
relação com Pré-SDR dinâmico.

**Problema:** o SYSTEM_PROMPT tem ~22 regras "NUNCA" + 13+ regras "SEMPRE"
absolutas. Quando o `runConsultantAssistant` (Pré-SDR) gera orientação
dinâmica contextual (ex: "este lead precisa de abordagem cuidadosa, evite
valores específicos"), essa orientação pode ser contradita por uma regra
"SEMPRE mencionar X" do prompt principal. Em produção o composer pende
para qualquer dos dois — pelo princípio de recência, geralmente o
Pré-SDR vence, mas em casos de ambiguidade reverte para o SYSTEM_PROMPT.

**Identificado:** Fase 2.2 da auditoria de fluidez, conflito P-2.

**Estratégia:** refatorar o SYSTEM_PROMPT para reduzir regras absolutas
("SEMPRE/NUNCA") em favor de regras condicionais ("SE X, ENTÃO Y, EXCETO
quando Z"), liberando espaço para o Pré-SDR moldar comportamento turno a
turno sem conflito.

**Prioridade:** média-alta. É o trabalho de longo prazo da fluidez
conversacional. As mudanças cirúrgicas da Fase 4 (em curso) atacam
sintomas; este Bug 12 ataca a causa estrutural.

**Não atacar agora.** Depende dos resultados da Fase 4 estabilizarem em
produção primeiro.

---

## 11. Bug 13 candidato — curva-bola jurídica/financeira grave (Cat 3 da auditoria)

**Cenário não coberto:** "vou processar a IQG", "minha empresa faliu",
"estou em recuperação judicial", "tive problema na justiça".

**Cobertura atual:** PARCIAL. SYSTEM_PROMPT (linhas 9242-9275) cobre nome
limpo / avalista / restrição / negativação / protesto. NÃO cobre falência,
processo judicial, ameaça de ação legal contra a IQG.

**Critério de priorização:** zero casos observados nas 95 conversas
pós-hotfix (24h). Atacar apenas se aparecer evidência de produção.

**Estratégia esboçada:** adicionar bloco no SYSTEM_PROMPT após a regra de
nome limpo, com orientação de "reconhecer, não minimizar, redirecionar para
equipe comercial humana via Janela 2".

**Prioridade:** baixa (latente).

---

## 12. Bug 14 candidato — silêncio prolongado, conteúdo da retomada (Cat 6)

**Cenário não coberto:** lead voltou após 7+ dias de silêncio, conversa
antiga. A cadência cobre o disparo do follow-up, mas o conteúdo da
retomada quando ele volta espontaneamente é genérico demais.

**Cobertura atual:** PARCIAL. Linhas 10298, 10311, 10670, 10675 do
SYSTEM_PROMPT cobrem "retomar com pergunta" e "não repetir texto
completo". NÃO cobrem: reconhecimento de tempo passado, oferecer
atualização breve, confirmar "de onde continuamos?".

**Critério de priorização:** zero casos observados. Atacar apenas se
aparecer.

**Estratégia esboçada:** adicionar bloco no SYSTEM_PROMPT com orientação
"se o lead voltou depois de mais de 5 dias de silêncio, reconheça
brevemente o tempo passado e proponha continuar de onde paramos".

**Prioridade:** baixa (latente).

---

## 13. Bug 15 candidato — comparação com concorrente (Cat 7)

**Cenário não coberto:** "vi outra empresa vendendo X mais barato",
"vocês vs Nano vs ProdutoY", "qual a diferença pra Z".

**Cobertura atual:** PARCIAL e DEFENSIVA. SYSTEM_PROMPT linha ~10262 proíbe
recomendar concorrente. NÃO há orientação OFENSIVA: como acolher a
curiosidade do lead, como pivotar para valor IQG sem atacar o concorrente,
como reconhecer o preço dele.

**Critério de priorização:** zero casos observados. Atacar apenas se
aparecer.

**Estratégia esboçada:** complementar a regra defensiva com bloco "reconheça
a comparação, reforce diferencial estrutural (suporte, treinamento,
comodato), evite ataque direto ao concorrente".

**Prioridade:** baixa (latente).

---

## 14. Bug 16 candidato — expertise técnica não-piscineiro (Cat 10)

**Cenário não coberto:** "trabalho com química há 20 anos", "sou químico
industrial", "sou agrônomo", "conheço esse mercado".

**Cobertura atual:** PARCIAL. SYSTEM_PROMPT linha 9748-9751 cobre persona
piscineiro especificamente. NÃO cobre outras expertises técnicas
relacionadas (químico, agrônomo, profissional setorial genérico).

**Critério de priorização:** zero casos observados. Atacar apenas se
aparecer.

**Estratégia esboçada:** generalizar a regra do piscineiro para "se lead
demonstra expertise técnica do setor (química, agronomia, indústria),
adaptar profundidade do tom e usar conhecimento dele como ponte de
credibilidade".

**Prioridade:** baixa (latente).

---

## 15. Bug 17 candidato — instrumentação do buffer absorvido

**Onde:** `server.js:1984-1989` (dentro de `consumeBuffer` ou similar) —
caminho onde uma invocação do webhook desperta após debounce e descobre
que o buffer já foi consumido por outra invocação.

**Trecho atual:**
```js
const buffer = await db.collection("incoming_message_buffers").findOne({ _id: bufferId });
if (!buffer) {
  return { shouldContinue: false, text: "" };
}
```

**Problema:** quando isso acontece, o `audit_event` registra
`respostaFinalSdr: ""` para o `messageId` absorvido. Aparece nos logs como
"SDR não respondeu ao lead", mas é comportamento legítimo (a SDR respondeu
via outra invocação que agregou o buffer). Confunde análise de auditoria
e induz a falsos alarmes.

**Confirmado empiricamente:** lead 554991870845 mandou 3 fragmentos rápidos,
buffer agregou em 1 mensagem combinada, SDR respondeu 1 vez. Audit dos 2
fragmentos absorvidos veio com `respostaFinalSdr: ""`.

**Estratégia esboçada:** quando detectar buffer ausente, em vez de retornar
silenciosamente, gravar audit_event tipo:
```js
{
  eventType: "buffer_absorbed_no_response_expected",
  payload: {
    bufferAbsorbedBy: <messageId_original>,
    messageId: <messageId_atual>
  }
}
```

**Prioridade:** baixa. É instrumentação de observabilidade, não corrige
comportamento. Atacar quando o time de monitoramento reportar confusão
recorrente com audit "vazio".

---

## 16. Bug 20-A Path A — investigado, sem bug

**Onde:** server.js, bloco de scheduling no webhook handler 
(~23298-23322) + função `scheduleClientCallback` (~20786-20880).

**Investigação:** durante a sessão de 2026-05-21, o Path A foi 
inicialmente classificado como tendo o mesmo bug do Path B 
(early-return sem preservar mensagem do lead no histórico). 
A hipótese surgiu da análise dos 6 paths de early-return do 
webhook handler, sem inspecionar o que as funções chamadas 
faziam internamente.

**Conclusão:** análise aprofundada da função `scheduleClientCallback` 
(chamada no Path A) revelou que ela JÁ FAZ load + push user + 
push assistant + save nas linhas 20855-20868, padrão idêntico 
ao R-A aplicado ao Path B (commit 2ff6211). Lead message vai 
com `content: detection.originalText, origem: "lead"`. Assistant 
message vai com `content: confirmationMsg, origem: "agendamento_confirmacao"`. 
Não há bug a corrigir.

**Lição metodológica:** mapeamento de paths de early-return deve 
olhar o que acontece DENTRO das funções chamadas, não apenas o 
webhook handler externo. Inspeção rasa pode gerar falsos positivos 
de "missing persistence".

**Status:** sem ação necessária. Item mantido no TODO como registro 
da investigação e da metodologia corrigida.

**Identificado:** sessão Anderson, análise inicial do Claude Code 
(2026-05-21). Invalidado na mesma sessão durante dúvidas pré-fix.

---

## 17. Bug 19 candidato — race condition em saveConversation

**Onde:** server.js, função saveConversation (~linha 570). Usado 
amplamente em ~30 call sites.

**Problema:** `saveConversation` faz `updateOne($set: { messages })` 
substituindo o array inteiro a cada chamada, sem version check ou 
optimistic locking. Quando 2 webhooks do mesmo lead processam em 
paralelo (caso real observado no Anderson, debounce do buffer 
expira entre mensagens), ambos carregam `history` em momentos 
diferentes, divergem em memória, e o último a salvar sobrescreve 
o outro. Resultado: mensagens silenciosamente perdidas do histórico.

**Sugestão de correção:** refatoração arquitetural. Opções:
(a) trocar $set por $push de elementos novos (mas complica retry/dedup);
(b) optimistic locking com `findOneAndUpdate` + campo `version` 
    incrementado por `$inc`, retry em caso de conflict;
(c) lock per-user no início do webhook (Map de Promises por `from`).
Operação grande — requer mapeamento completo de quem chama 
`saveConversation` e quem consome via `loadConversation`. Sessão 
dedicada, não atacar em ciclos curtos.

**Prioridade:** alta (impacto silencioso em produção) mas esforço alto.

**Identificado:** sessão Anderson, análise R-A do Claude Code 
(2026-05-21).

---

## 18. Bug 20 candidato — ampliar REVENDEDOR_LOJISTA_PATTERNS

**Onde:** server.js linhas 4534-4556 (12 regex patterns atuais).

**Problema:** após R-C mergeado (commit bbf6797), classifier 
sozinho não dispara handoff. Lead que é genuinamente revendedor 
mas usa fraseado fora dos 12 patterns atuais (ex: "sou dono de 
uma rede", "trabalho com volume") pode escapar da detecção, 
gerando handoff perdido (TP false negative). Patterns atuais são 
precisos mas restritos.

**Sugestão de correção:** após 30-60 dias com R-C/R-B em produção, 
revisar audit logs de `revendedor_classifier_descartado`. Identificar 
textos recorrentes que são TPs claros mas escaparam da heurística. 
Promover esses padrões a novos regex em `REVENDEDOR_LOJISTA_PATTERNS`. 
Candidatos iniciais:
- `/\bdono d[ea] (uma )?(rede|loja|comércio)\b/i`
- `/\btrabalho com volume\b/i`

**Prioridade:** baixa-média (depende de evidência empírica).

**Critério de priorização:** atacar somente se audit do 
`revendedor_classifier_descartado` mostrar TPs escapados.

**Identificado:** sessão Anderson, análise R-C do Claude Code 
(2026-05-21).

---

## 19. Bug 21 candidato — remover leadDeclareSerRevendedorOuLojista do classifier

**Onde:** server.js ~linha 5226 (schema retornado por 
`runLeadSemanticIntentClassifier`) e ~linha 25091 (consumo no 
gate de Bug 8).

**Problema:** após R-C mergeado, o campo 
`leadDeclareSerRevendedorOuLojista` retornado pelo classifier GPT 
só é usado em logging de descarte (`revendedor_classifier_descartado`). 
O gate efetivo passou a depender apenas de `revendedorHeuristica.detected`. 
Token gasto na inferência do campo no GPT vira parcialmente waste.

**Sugestão de correção:** após 30-60 dias com R-C/R-B validados:
(a) se audit de descartes mostrar zero valor analítico, remover 
    o campo do schema do classifier e da instrução do prompt 
    (economia de tokens, prompt menor);
(b) se audit revelar TPs escapados via classifier-only (Bug 20 acima), 
    promover patterns para a heurística e DEPOIS remover do classifier;
(c) se TP rate justificar, manter o campo como observabilidade 
    permanente.

**Prioridade:** baixa.

**Critério de priorização:** aguardar 60 dias de dados pós-R-C/R-B.

**Identificado:** sessão Anderson, análise R-C do Claude Code 
(2026-05-21).

---

## 20. Bug 22 candidato — dedup noop em processedMessages/processingMessages

**Onde:** server.js, declarações de `processedMessages` Map e 
`processingMessages` Set (~linha 2118), função 
`markMessageAsProcessed` e `markMessageIdsAsProcessed`.

**Problema:** as duas estruturas foram criadas como mecanismo de 
proteção contra reprocessamento de mensagens (idempotência de 
webhook). São escritas (`.set()`, `.add()`, `.delete()`) mas 
**nunca lidas via `.has()` em pontos de decisão**. O dedup nunca 
funcionou — é noop. `markMessageIdsAsProcessed` é apenas 
observabilidade/cleanup de memória com TTL.

**Sugestão de correção:** decidir entre 2 caminhos:
(a) **Ativar dedup:** adicionar `.has()` check no início do 
    handler do webhook, retornar early se messageId já processado. 
    Resolve uma classe inteira de bugs (retry de WhatsApp, 
    webhooks duplicados);
(b) **Remover código morto:** se decisão de produto é tolerar 
    duplicatas, deletar as estruturas e funções pra reduzir 
    confusão no leitor do código.

Recomendação: caminho (a). Risco baixo (só impede execuções 
realmente duplicadas) e alto valor.

**Prioridade:** média.

**Identificado:** sessão Anderson, análise R-A do Claude Code 
(2026-05-21).

---

## 21. Decisão de produto — mídia não-texto (Path E) no histórico

**Onde:** server.js, bloco de fallback "consigo te atender por 
texto/áudio 😊" em ~linhas 23262-23269 (Path E mapeado).

**Problema:** quando lead envia sticker, figurinha ou outro tipo 
de mídia não suportado, o sistema responde fallback mas **não 
registra nada no histórico**. Para o dashboard e a SDR, é como se 
o lead não tivesse interagido. Próximo turno do lead pode confundir 
a SDR (contexto de "lead sumiu" vs "lead mandou sticker e foi 
ignorado").

**Sugestão de correção:** decisão pendente do dono. Opções:
(a) registrar entrada `{ role: "user", content: "[lead enviou 
    sticker/mídia não-texto]", origem: "lead_midia_nao_suportada" }` 
    no histórico — dashboard vê, SDR tem contexto;
(b) manter comportamento atual (ignorar) — minimalismo, conta com 
    o lead reenviar.

**Prioridade:** baixa.

**Critério de priorização:** depende de evidência de leads 
confundindo SDR após enviar sticker. Atacar quando observado.

**Identificado:** sessão Anderson, análise R-A do Claude Code 
(2026-05-21).

---

## 22. Polimento — wording absolutista da EXCEÇÃO DE BREVIDADE Fase 6

**Onde:** server.js, EXCEÇÃO DE BREVIDADE da Fase 6 (~linha 10088 
pós R2c-1). Trecho específico: "NÃO resuma, NÃO encurte, NÃO corte 
partes."

**Problema:** após R2c-1 (commit 86ff33f) restringir a EXCEÇÃO a 
"conversa ATIVA", o wording absolutista remanescente ("NÃO resuma, 
NÃO encurte, NÃO corte partes") ainda força paredão mesmo quando o 
lead deu sinais inequívocos de aceite. Em casos onde lead diz "topo", 
"aceito", "pode mandar", mandar a mensagem-base obrigatória inteira 
(80+ linhas) pode ser pior que uma forma sintética.

**Sugestão de correção:** opcional, dependente de evidência empírica. 
Substituir wording absolutista por algo proporcional, tipo: "Cubra os 
5 pontos obrigatórios abaixo; tamanho proporcional ao engajamento do 
lead." OU adicionar branch: "Se o lead deu sinal inequívoco de aceite 
explícito, pular para forma sintética: 'Investimento R$ 1.990, 10x 
R$ 199, pode ser PIX. Vamos ao próximo passo?'"

**Prioridade:** baixa (polimento, não bug).

**Critério de priorização:** atacar somente se audit mostrar leads 
que aceitaram explicitamente mas receberam paredão e abandonaram.

**Identificado:** avaliação R3 do roadmap Fase 4, sessão de 2026-05-21 
(durante mapeamento R3 pós-R2c-1).

---

## 23. Polimento — duplicação "Mensagem obrigatória base:" Fase 6

**Onde:** server.js, Fase 6 do SYSTEM_PROMPT (~linhas 10107 e 10109 
pós R2c-1). Mesma string aparece literalmente 2 vezes consecutivas.

**Problema:** bug cosmético menor. Não impacta funcionamento (modelo 
ignora a duplicação), mas polui o prompt e gasta tokens marginalmente. 
Identificado durante análise do R2c-1 mas estava fora de escopo.

**Sugestão de correção:** remover uma das duas ocorrências (linha 10107 
OU 10109, manter a outra). Trivial — 1 linha deletada.

**Prioridade:** baixa (cosmético).

**Identificado:** avaliação R2c-1 do roadmap Fase 4, sessão de 
2026-05-21.

---

## 24. Refatoração — tamanho da mensagem-base obrigatória Fase 6

**Onde:** server.js, mensagem-base obrigatória da Fase 6 (~linhas 
10111-10180+ pós R2c-1, ~70 linhas total).

**Problema:** a mensagem-base obrigatória que o SDR é instruído a 
enviar quando apresenta a taxa de adesão tem ~70 linhas no prompt. 
Mesmo com R2c-1 protegendo cadência, em conversa ativa o modelo é 
forçado a gerar uma mensagem extensa que pode causar abandono em 
leads que preferem comunicação mais sintética.

**Sugestão de correção:** após R5 (substituição dos 17 few-shots 
pelos 42 validados) estabilizar, revisar a mensagem-base com possíveis 
abordagens:
(a) Reduzir wording mantendo os 5 pontos obrigatórios;
(b) Criar variantes "curta/média/longa" e instruir o modelo a escolher 
    conforme engajamento do lead;
(c) Quebrar em 2-3 mensagens consecutivas em vez de paredão único.

**Prioridade:** média (impacto direto em conversão na fase de 
investimento).

**Critério de priorização:** atacar após R5 + medição de taxa de 
abandono pós-apresentação de taxa.

**Identificado:** avaliação R3 do roadmap Fase 4, sessão de 2026-05-21.

---

## 25. Feature — Caminho 2 handoff dual para outras linhas IQG

**Onde:** SYSTEM_PROMPT principal (~linha 9482, após resposta-modelo 
do Caminho 1), CONSULTANT_ASSISTANT_SYSTEM_PROMPT, REVENDEDOR_LOJISTA_
PATTERNS, classificador semântico.

**Problema:** Regra atual cobre apenas Caminho 1 — lead pergunta sobre 
outra linha (ordenha/agro/dipping/cosmético vet) → SDR conduz de volta 
para piscina. NÃO há cobertura para Caminho 2 — lead INSISTE que NÃO 
quer piscina e SÓ aceitaria começar com outra linha IQG. Atualmente 
SDR entra em loop tentando conduzir para piscina, sem opção legítima.

**Sugestão de correção:** implementar handoff dual quando lead 
insistir em linha específica:

1. **SYSTEM_PROMPT:** adicionar bloco "EXCEÇÃO — CAMINHO 2" após 
   linha ~9482 com regra de roteamento (texto sugerido durante 
   investigação 22/05/2026)

2. **Classificador:** adicionar gatilho para detectar insistência 
   em linha não-piscina (não basta `mentionsOtherProductLine` 
   existente — precisa nuance de "insistência" vs "pergunta casual")

3. **REVENDEDOR_LOJISTA_PATTERNS:** ampliar ou criar novo array 
   `OUTRAS_LINHAS_INSISTENCIA_PATTERNS` para detectar via regex

4. **Mensagem padrão:** redigir texto canônico para handoff 
   (paralelo ao texto do Bug 8 lojista) direcionando para 
   "consultor humano da linha X"

5. **Audit event:** registrar lead com motivo "lead quer atuar em 
   linha específica fora do escopo atual do Programa Homologado"

**Prioridade:** baixa-média (depende de evidência empírica).

**Critério de priorização:** atacar quando audit mostrar pelo menos 
3-5 casos em 30 dias de leads que insistem em linha não-piscina e 
SDR entra em loop. Antes disso, casos podem ser tratados manualmente 
(operador humano intervém).

**Trabalho relacionado:** após F5 do roadmap (auditor especialista 
vendas IQG) estar rodando, pode usar dados do auditor para confirmar 
frequência do caso.

**Identificado:** investigação durante mapeamento R5d, sessão 
2026-05-22. Decisão de seguir Caminho A no R5d posterga implementação 
deste feature.
