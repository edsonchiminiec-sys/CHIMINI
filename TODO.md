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
