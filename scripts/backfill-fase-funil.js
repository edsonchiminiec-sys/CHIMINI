#!/usr/bin/env node
// /scripts/backfill-fase-funil.js
// Re-derive lead.faseFunil from lead state (etapas + status + rotaComercial).
//
// Usage:
//   node scripts/backfill-fase-funil.js          # DRY-RUN (default, no DB changes)
//   node scripts/backfill-fase-funil.js --apply  # LIVE (will modify DB)
//
// Idempotent. Safe to run multiple times. Function pura — leads já consistentes
// vão pro counter `alreadyConsistent`.
//
// REPLICATED FROM server.js @805-1760. Update both if changing core logic.

import { MongoClient } from "mongodb";
import fs from "node:fs";

// ============================================================
// CONSTANTES (verbatim server.js @805-844)
// ============================================================

const STATUS_OPERACIONAL_VALUES = [
  "ativo",
  "em_atendimento",
  "enviado_crm",
  "fechado",
  "negociado",
  "perdido",
  "erro_dados",
  "erro_envio_crm"
];

const FASE_FUNIL_VALUES = [
  "inicio",
  "esclarecimento",
  "beneficios",
  "estoque",
  "responsabilidades",
  "investimento",
  "compromisso",
  "coleta_dados",
  "confirmacao_dados",
  "pre_analise",
  "crm",
  "encerrado",
  "afiliado"
];

const TEMPERATURA_COMERCIAL_VALUES = [
  "indefinida",
  "frio",
  "morno",
  "quente"
];

const ROTA_COMERCIAL_VALUES = [
  "indefinida",
  "homologado",
  "afiliado",
  "ambos"
];

// ============================================================
// HELPERS (verbatim server.js @846-852)
// ============================================================

function keepAllowedValue(value, allowedValues, fallback) {
  if (allowedValues.includes(value)) {
    return value;
  }

  return fallback;
}

// ============================================================
// getLeadLifecycleFields — verbatim server.js @1600-1760
// ============================================================

function getLeadLifecycleFields(data = {}) {
  const status = data.status || "";
  const fase = data.faseQualificacao || "";
  const statusOuFase = status || fase;
  const etapas = data.etapas || null;

  const result = {};

  if (status || fase) {
    if (
      ["em_atendimento", "enviado_crm", "fechado", "perdido", "erro_dados", "erro_envio_crm"].includes(statusOuFase)
    ) {
      result.statusOperacional = statusOuFase;
    } else {
      result.statusOperacional = "ativo";
    }
  }

  const rotaInformada = data.rotaComercial || "";
  const origemConversao = data.origemConversao || "";

  const origemAfiliado = [
    "afiliado",
    "interesse_direto",
    "interesse_direto_afiliado",
    "recuperado_objecao",
    "recuperado_objecao_taxa_persistente"
  ].includes(origemConversao);

  const origemAmbos = [
    "ambos",
    "comparacao_homologado_afiliado"
  ].includes(origemConversao);

  if (rotaInformada === "homologado") {
    result.rotaComercial = "homologado";
  } else if (rotaInformada === "afiliado") {
    result.rotaComercial = "afiliado";
  } else if (rotaInformada === "ambos" || origemAmbos) {
    result.rotaComercial = "ambos";
  } else if (
    status === "afiliado" ||
    fase === "afiliado" ||
    data.interesseAfiliado === true ||
    origemAfiliado
  ) {
    result.rotaComercial = "afiliado";
  } else if (status || fase || origemConversao) {
    result.rotaComercial = "homologado";
  }
  if (
    data.interesseReal === true ||
    ["quente", "pre_analise", "qualificado", "dados_confirmados"].includes(statusOuFase)
  ) {
    result.temperaturaComercial = "quente";
  } else if (statusOuFase === "morno") {
    result.temperaturaComercial = "morno";
  } else if (statusOuFase === "perdido" || statusOuFase === "frio") {
    result.temperaturaComercial = "frio";
  } else if (status || fase) {
    result.temperaturaComercial = "indefinida";
  }

  if (status || fase || etapas) {
    if (status === "afiliado" || fase === "afiliado") {
      result.faseFunil = "afiliado";
    } else if (["enviado_crm", "em_atendimento"].includes(statusOuFase)) {
      result.faseFunil = "crm";
    } else if (["fechado", "perdido"].includes(statusOuFase)) {
      result.faseFunil = "encerrado";
    } else if (
      ["dados_confirmados", "pre_analise", "qualificado", "quente"].includes(statusOuFase)
    ) {
      result.faseFunil = "pre_analise";
    } else if (statusOuFase === "aguardando_confirmacao_dados") {
      result.faseFunil = "confirmacao_dados";
    } else if (
      [
        "coletando_dados",
        "dados_parciais",
        "aguardando_dados",
        "aguardando_confirmacao_campo",
        "corrigir_dado",
        "corrigir_dado_final",
        "aguardando_valor_correcao_final"
      ].includes(statusOuFase)
    ) {
      result.faseFunil = "coleta_dados";
    } else if (etapas?.compromisso) {
      result.faseFunil = "compromisso";
    } else if (etapas?.investimento) {
      result.faseFunil = "investimento";
    } else if (etapas?.responsabilidades) {
      result.faseFunil = "responsabilidades";
    } else if (etapas?.estoque) {
      result.faseFunil = "estoque";
    } else if (etapas?.beneficios || statusOuFase === "morno") {
      result.faseFunil = "beneficios";
    } else if (etapas?.programa || statusOuFase === "novo") {
      result.faseFunil = "esclarecimento";
    } else if (statusOuFase === "inicio") {
      result.faseFunil = "inicio";
    }
  }

  if (result.statusOperacional) {
    result.statusOperacional = keepAllowedValue(
      result.statusOperacional,
      STATUS_OPERACIONAL_VALUES,
      "ativo"
    );
  }

  if (result.faseFunil) {
    result.faseFunil = keepAllowedValue(
      result.faseFunil,
      FASE_FUNIL_VALUES,
      "inicio"
    );
  }

  if (result.temperaturaComercial) {
    result.temperaturaComercial = keepAllowedValue(
      result.temperaturaComercial,
      TEMPERATURA_COMERCIAL_VALUES,
      "indefinida"
    );
  }

  if (result.rotaComercial) {
    result.rotaComercial = keepAllowedValue(
      result.rotaComercial,
      ROTA_COMERCIAL_VALUES,
      "homologado"
    );
  }

  return result;
}

// ============================================================
// SCRIPT
// ============================================================

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI não definida no ambiente");
    process.exit(1);
  }

  const startedAt = new Date().toISOString();
  console.log(`🔍 Mode: ${APPLY ? "LIVE (will modify DB)" : "DRY-RUN (no changes)"}`);
  console.log(`⏱️  Started at: ${startedAt}`);

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();
  const leads = db.collection("leads");

  // Filtro AMPLO: iterar TODOS leads (idempotente — já consistentes pulam).
  // Status terminal pulado explicitamente no loop pra contagem própria.
  const cursor = leads.find({});

  let total = 0;
  let modified = 0;
  let alreadyConsistent = 0;
  let skippedNoData = 0;
  let skippedTerminalStatus = 0;
  let errors = 0;
  const modifications = [];

  for await (const lead of cursor) {
    total++;
    try {
      // Pular leads em status terminal (fechado/perdido) — não devem ser
      // re-derivados, ficam como estão.
      if (["fechado", "perdido"].includes(lead.status)) {
        skippedTerminalStatus++;
        continue;
      }

      const lifecycle = getLeadLifecycleFields(lead);
      const expectedFase = lifecycle.faseFunil;

      if (!expectedFase) {
        // Não foi possível derivar (sem etapas + sem status reconhecível)
        skippedNoData++;
        continue;
      }

      if (lead.faseFunil === expectedFase) {
        alreadyConsistent++;
        continue;
      }

      const modification = {
        user: lead.user,
        before: lead.faseFunil || "(empty)",
        after: expectedFase,
        etapasTrue: Object.entries(lead.etapas || {})
          .filter(([k, v]) => v === true)
          .map(([k]) => k),
        status: lead.status,
        rotaComercial: lead.rotaComercial,
        lifecycle: {
          statusOperacional: lifecycle.statusOperacional,
          temperaturaComercial: lifecycle.temperaturaComercial,
          rotaComercial: lifecycle.rotaComercial,
          faseFunil: lifecycle.faseFunil
        }
      };
      modifications.push(modification);

      if (APPLY) {
        await leads.updateOne(
          { _id: lead._id },
          {
            $set: {
              faseFunil: expectedFase,
              statusOperacional: lifecycle.statusOperacional,
              temperaturaComercial: lifecycle.temperaturaComercial,
              rotaComercial: lifecycle.rotaComercial,
              updatedAt: new Date(),
              ultimaBackfillFaseFunilEm: new Date()
            }
          }
        );
      }
      modified++;
    } catch (err) {
      errors++;
      console.error(`❌ Error processing lead ${lead.user}:`, err.message);
    }
  }

  const finishedAt = new Date().toISOString();

  console.log("\n═══ SUMMARY ═══");
  console.log(`Total scanned:           ${total}`);
  console.log(`Modified:                ${modified}${DRY_RUN ? " (DRY-RUN, not persisted)" : ""}`);
  console.log(`Already consistent:      ${alreadyConsistent}`);
  console.log(`Skipped (no data):       ${skippedNoData}`);
  console.log(`Skipped (terminal stat): ${skippedTerminalStatus}`);
  console.log(`Errors:                  ${errors}`);
  console.log(`Finished at:             ${finishedAt}`);

  if (modifications.length > 0) {
    console.log("\n═══ MODIFICATIONS (preview, max 10) ═══");
    modifications.slice(0, 10).forEach(m => console.log(JSON.stringify(m)));
    if (modifications.length > 10) {
      console.log(`... e mais ${modifications.length - 10} (ver arquivo JSON)`);
    }
  }

  // Persistir output detalhado
  const timestamp = finishedAt.replace(/[:.]/g, "-");
  const outputFile = `/tmp/backfill-output-${timestamp}.json`;
  fs.writeFileSync(outputFile, JSON.stringify({
    startedAt,
    finishedAt,
    mode: APPLY ? "LIVE" : "DRY-RUN",
    total,
    modified,
    alreadyConsistent,
    skippedNoData,
    skippedTerminalStatus,
    errors,
    modifications
  }, null, 2));
  console.log(`\n📄 Output salvo: ${outputFile}`);

  await client.close();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
