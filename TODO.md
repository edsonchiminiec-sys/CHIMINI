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
