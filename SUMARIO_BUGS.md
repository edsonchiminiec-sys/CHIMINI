# Sumário de Bugs — Auditoria Forense Robotica Cirurgica

Status canônico dos 22 bugs identificados na auditoria 125-microauditorias.

| ID | Status | Resolução / Decisão |
|----|--------|---------------------|
| #15 | **FECHADO / FALSO_POSITIVO** | Co-Auditor confirmou em 2026-05-30: `etapas.investimento` (action SDR — "investimento foi explicado") e `taxaAlinhada` (action lead — "lead aceitou a taxa") são semanticamente diferentes POR DESIGN. Caso lead 555496223975 (etapas.investimento=true + etapasPendentes=[alinhamento taxa]) é o estado correto "explicado mas não aceito". Não é inconsistência arquitetural. NÃO criar scripts/migrate-etapas-schema.js. NÃO renomear campos. Gap #6 do CO_PILOT_SOLUTION_6_GAPS.md cancelado. |
