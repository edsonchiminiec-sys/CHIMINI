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
