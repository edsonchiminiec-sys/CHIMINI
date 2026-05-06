import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
app.use(express.json());
const client = new MongoClient(process.env.MONGODB_URI);
let db;

/* =========================
   🔥 MONGODB (CORRIGIDO)
========================= */

async function connectMongo() {
  try {
    if (!db) {
      await client.connect();
      db = client.db("iqg");
      console.log("🔥 Mongo conectado");
      return;
    }

    await db.command({ ping: 1 });
  } catch (error) {
    console.error("⚠️ Mongo desconectado. Tentando reconectar...", error.message);

    try {
      await client.close().catch(() => {});
      await client.connect();
      db = client.db("iqg");
      console.log("🔥 Mongo reconectado");
    } catch (reconnectError) {
      console.error("❌ Falha ao reconectar Mongo:", reconnectError);
      throw reconnectError;
    }
  }
}

async function claimMessage(messageId) {
  if (!messageId) return true;

  await connectMongo();

  try {
    await db.collection("processed_messages").insertOne({
      _id: messageId,
      createdAt: new Date()
    });

    return true;
  } catch (error) {
    if (error.code === 11000) {
      return false;
    }

    throw error;
  }
}

async function ensureIndexes() {
  await connectMongo();

  await db.collection("processed_messages").createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 86400 }
  );

  await db.collection("leads").createIndex(
    { user: 1 },
    { unique: true }
  );

  await db.collection("conversations").createIndex(
    { user: 1 },
    { unique: true }
  );

  await db.collection("incoming_message_buffers").createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 300 }
  );

  await db.collection("internal_alert_locks").createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 3600 }
  );
}

async function updateLeadStatus(user, status) {
  await connectMongo();

  const currentLead = await db.collection("leads").findOne({ user });

  /*
    BLOCO 9B:
    O status alterado pelo dashboard passa a ser VISUAL/OPERACIONAL HUMANO.
    Ele NÃO deve comandar a próxima decisão da IA, exceto quando for
    "em_atendimento", que significa humano assumiu a conversa.
  */

  const dashboardPatch = {
    statusDashboard: status,
    statusVisualDashboard: status,
    ultimoStatusDashboard: status,
    statusDashboardAtualizadoEm: new Date(),
    atualizadoPeloDashboard: true
  };

  if (status === "em_atendimento") {
    const lifecycleData = getLeadLifecycleFields({
      ...(currentLead || {}),
      status: "em_atendimento",
      faseQualificacao: "em_atendimento"
    });

    lifecycleData.statusOperacional = "em_atendimento";
    lifecycleData.faseFunil = "crm";
    lifecycleData.temperaturaComercial =
      currentLead?.temperaturaComercial || "indefinida";
    lifecycleData.rotaComercial =
      currentLead?.rotaComercial ||
      currentLead?.origemConversao ||
      "homologado";

    await db.collection("leads").updateOne(
      { user },
      {
        $set: {
          ...dashboardPatch,

          // ÚNICO status do dashboard que interfere na IA:
          status: "em_atendimento",
          faseQualificacao: "em_atendimento",

          humanoAssumiu: true,
          atendimentoHumanoAtivo: true,
          botBloqueadoPorHumano: true,
          assumidoPorHumanoEm: new Date(),

          ...lifecycleData,
          updatedAt: new Date()
        }
      }
    );

    console.log("🧑‍💼 Dashboard colocou lead em atendimento humano. IA bloqueada:", {
      user,
      statusDashboard: status
    });

    return;
  }

  /*
    Se o lead estava em atendimento humano e o dashboard mudou para outro status,
    liberamos a IA novamente.

    Importante:
    Mesmo liberando a IA, NÃO usamos o novo status visual como fase da IA.
    O fluxo conversacional será reavaliado pelo histórico e pelo backend.
  */
  const liberarAtendimentoHumano =
    currentLead?.botBloqueadoPorHumano === true ||
    currentLead?.humanoAssumiu === true ||
    currentLead?.atendimentoHumanoAtivo === true ||
    currentLead?.statusOperacional === "em_atendimento" ||
    currentLead?.status === "em_atendimento" ||
    currentLead?.faseQualificacao === "em_atendimento";

  if (liberarAtendimentoHumano) {
    await db.collection("leads").updateOne(
      { user },
      {
        $set: {
          ...dashboardPatch,

          humanoAssumiu: false,
          atendimentoHumanoAtivo: false,
          botBloqueadoPorHumano: false,
          liberadoDoAtendimentoHumanoEm: new Date(),

          statusOperacional: "ativo",
          updatedAt: new Date()
        }
      }
    );

    console.log("✅ Dashboard liberou lead do atendimento humano. IA pode voltar a responder:", {
      user,
      statusDashboard: status
    });

    return;
  }

  /*
    Para qualquer outro status vindo do dashboard:
    - não muda status;
    - não muda faseQualificacao;
    - não muda faseFunil;
    - não muda temperaturaComercial;
    - não muda rotaComercial;
    - não muda interesseReal;
    - não muda interesseAfiliado.

    Fica apenas como marcação visual/humana.
  */
  await db.collection("leads").updateOne(
    { user },
    {
      $set: {
        ...dashboardPatch,
        updatedAt: new Date()
      }
    }
  );

  console.log("🏷️ Dashboard atualizou status visual sem interferir na IA:", {
    user,
    statusDashboard: status,
    statusIaAtual: currentLead?.status || "",
    faseIaAtual: currentLead?.faseQualificacao || "",
    statusOperacionalAtual: currentLead?.statusOperacional || ""
  });
}
/* =========================
   MONGO HISTÓRICO (ÚNICO - SEM DUPLICAÇÃO)
========================= */

async function loadConversation(user) {
  await connectMongo();

  const data = await db.collection("conversations").findOne({ user });

  if (!data?.messages || !Array.isArray(data.messages)) {
    return [];
  }

  return data.messages;
}

async function saveConversation(user, messages) {
  await connectMongo();

  await db.collection("conversations").updateOne(
    { user },
    {
      $set: {
        user,
        messages,
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function saveLeadProfile(user, data = {}) {
  await connectMongo();

  const currentLead = await db.collection("leads").findOne({ user });

  // REMOVE CAMPOS QUE NÃO DEVEM SER ATUALIZADOS DIRETAMENTE
  const {
    _id,
    createdAt,
    crmEnviado,
    crmEnviadoEm,

    // Estes campos são gerenciados por funções próprias.
    // Se entrarem aqui junto com $setOnInsert, causam conflito no Mongo.
    supervisor,
    classificacao,
    consultoria,

    ...rawSafeData
  } = data || {};

  let safeData = {
    ...(rawSafeData || {})
  };

  const leadFinalizouPreCadastro =
    currentLead &&
    leadHasFinishedPreCadastro(currentLead) === true;

  const tentativaDePerdaIndevida =
    currentLead &&
    leadFinalizouPreCadastro !== true &&
    (
      safeData.status === "perdido" ||
      safeData.faseQualificacao === "perdido" ||
      safeData.statusOperacional === "perdido" ||
      safeData.faseFunil === "encerrado" ||
      safeData.temperaturaComercial === "frio"
    );

  if (tentativaDePerdaIndevida) {
    console.log("🛡️ BLOQUEIO saveLeadProfile: tentativa de marcar lead não finalizado como perdido/encerrado/frio. Convertendo para morno ativo.", {
      user,
      statusOriginal: safeData.status,
      faseOriginal: safeData.faseQualificacao,
      statusOperacionalOriginal: safeData.statusOperacional,
      faseFunilOriginal: safeData.faseFunil,
      temperaturaOriginal: safeData.temperaturaComercial,
      recoveryAttempts: currentLead?.recoveryAttempts || 0,
      afiliadoOferecidoComoAlternativa: currentLead?.afiliadoOferecidoComoAlternativa === true
    });

    safeData = {
      ...safeData,
      status: safeData.status === "perdido" ? "morno" : safeData.status,
      faseQualificacao: safeData.faseQualificacao === "perdido" ? "morno" : safeData.faseQualificacao,
      statusOperacional: "ativo",
      faseFunil: currentLead?.faseFunil && currentLead.faseFunil !== "encerrado"
        ? currentLead.faseFunil
        : "beneficios",
      temperaturaComercial: "morno",
      ultimaTentativaPerdaBloqueadaEm: new Date(),
      ultimaTentativaPerdaBloqueadaPayload: {
        status: rawSafeData?.status || "",
        faseQualificacao: rawSafeData?.faseQualificacao || "",
        statusOperacional: rawSafeData?.statusOperacional || "",
        faseFunil: rawSafeData?.faseFunil || "",
        temperaturaComercial: rawSafeData?.temperaturaComercial || ""
      }
    };
  }

  // DADOS QUE SÓ DEVEM EXISTIR NA CRIAÇÃO
  const insertData = {
    createdAt: new Date(),
    supervisor: buildDefaultSupervisorAnalysis(),
    classificacao: buildDefaultLeadClassification(),
    consultoria: buildDefaultConsultantAdvice()
  };

  // STATUS INICIAL APENAS PARA LEAD NOVO
  if (!currentLead && !safeData.status) {
    insertData.status = "novo";
  }

  // ETAPAS INICIAIS APENAS PARA LEAD NOVO
  if (!currentLead && !safeData.etapas) {
    insertData.etapas = {
      programa: false,
      beneficios: false,
      estoque: false,
      responsabilidades: false,
      investimento: false,
      taxaPerguntada: false,
      compromissoPerguntado: false,
      compromisso: false
    };
  }

  if (!currentLead && safeData.taxaAlinhada === undefined) {
    insertData.taxaAlinhada = false;
  }

  if (!currentLead && safeData.taxaObjectionCount === undefined) {
    insertData.taxaObjectionCount = 0;
  }

  const lifecycleBase = {
    ...(currentLead || {}),
    ...insertData,
    ...safeData
  };

  const lifecycleData = getLeadLifecycleFields(lifecycleBase);

  if (tentativaDePerdaIndevida) {
    lifecycleData.statusOperacional = "ativo";
    lifecycleData.faseFunil =
      safeData.faseFunil && safeData.faseFunil !== "encerrado"
        ? safeData.faseFunil
        : "beneficios";
    lifecycleData.temperaturaComercial = "morno";

    if (!lifecycleData.rotaComercial) {
      lifecycleData.rotaComercial =
        currentLead?.rotaComercial ||
        currentLead?.origemConversao ||
        "homologado";
    }
  }

  await db.collection("leads").updateOne(
    { user },
    {
      $set: {
        user,
        ...safeData,
        ...lifecycleData,
        updatedAt: new Date()
      },
      $setOnInsert: insertData
    },
    { upsert: true }
  );
}
async function loadLeadProfile(user) {
  await connectMongo();

  return await db.collection("leads").findOne({ user });
}

async function saveSupervisorAnalysis(user, supervisorData = {}) {
  await connectMongo();

  const defaultSupervisor = buildDefaultSupervisorAnalysis();

  const safeSupervisorData = {
    ...defaultSupervisor,
    ...(supervisorData || {}),
    analisadoEm: supervisorData?.analisadoEm || new Date()
  };

  await db.collection("leads").updateOne(
    { user },
    {
      $set: {
        supervisor: safeSupervisorData,
        updatedAt: new Date()
      },
      $setOnInsert: {
        user,
        createdAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function saveLeadClassification(user, classificationData = {}) {
  await connectMongo();

  const defaultClassification = buildDefaultLeadClassification();

  const safeClassificationData = {
    ...defaultClassification,
    ...(classificationData || {}),
    classificadoEm: classificationData?.classificadoEm || new Date()
  };

  await db.collection("leads").updateOne(
    { user },
    {
      $set: {
        classificacao: safeClassificationData,
        updatedAt: new Date()
      },
      $setOnInsert: {
        user,
        createdAt: new Date(),
        supervisor: buildDefaultSupervisorAnalysis()
      }
    },
    { upsert: true }
  );
}

async function saveConsultantAdvice(user, adviceData = {}) {
  await connectMongo();

  const defaultAdvice = buildDefaultConsultantAdvice();

  const safeAdviceData = {
    ...defaultAdvice,
    ...(adviceData || {}),
    consultadoEm: adviceData?.consultadoEm || new Date()
  };

  await db.collection("leads").updateOne(
    { user },
    {
      $set: {
        consultoria: safeAdviceData,
        updatedAt: new Date()
      },
      $setOnInsert: {
        user,
        createdAt: new Date(),
        supervisor: buildDefaultSupervisorAnalysis(),
        classificacao: buildDefaultLeadClassification()
      }
    },
    { upsert: true }
  );
}

const STATUS_OPERACIONAL_VALUES = [
  "ativo",
  "em_atendimento",
  "enviado_crm",
  "fechado",
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

function keepAllowedValue(value, allowedValues, fallback) {
  if (allowedValues.includes(value)) {
    return value;
  }

  return fallback;
}

function buildDefaultSupervisorAnalysis() {
  return {
    houveErroSdr: false,
    errosDetectados: [],
    sdrPulouFase: false,
    fasePulada: "",
    descricaoErroPrincipal: "",
    riscoPerda: "nao_analisado",
    motivoRisco: "",
    pontoTrava: "",
    leadEsfriou: false,
    motivoEsfriamento: "",
    necessitaHumano: false,
    prioridadeHumana: "nao_analisado",
    qualidadeConducaoSdr: "nao_analisado",
    notaConducaoSdr: null,
    resumoDiagnostico: "",
    observacoesTecnicas: [],
    analisadoEm: null
  };
}

function buildDefaultLeadClassification() {
  return {
    temperaturaComercial: "nao_analisado",
    perfilComportamentalPrincipal: "nao_analisado",
    perfilComportamentalSecundario: "",
    nivelConsciencia: "nao_analisado",
    intencaoPrincipal: "nao_analisado",
    objecaoPrincipal: "sem_objecao_detectada",
    confiancaClassificacao: "nao_analisado",
    sinaisObservados: [],
    resumoPerfil: "",
    classificadoEm: null
  };
}

function buildDefaultConsultantAdvice() {
  return {
    estrategiaRecomendada: "nao_analisado",
    proximaMelhorAcao: "",
    abordagemSugerida: "",
    argumentoPrincipal: "",
    cuidadoPrincipal: "",
    ofertaMaisAdequada: "nao_analisado",
    momentoIdealHumano: "nao_analisado",
    prioridadeComercial: "nao_analisado",
    resumoConsultivo: "",
    consultadoEm: null
  };
}

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

    // 🔀 ROTA COMERCIAL — REGRA CENTRAL DE PERSISTÊNCIA
  // Aqui protegemos o Mongo e o dashboard.
  // Se a rota já veio definida como afiliado ou ambos, ela deve ser respeitada.
  // Isso evita que o ciclo de vida recalcule tudo como "homologado" por padrão.
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

  if (rotaInformada === "ambos" || origemAmbos) {
    result.rotaComercial = "ambos";
  } else if (
    rotaInformada === "afiliado" ||
    status === "afiliado" ||
    fase === "afiliado" ||
    data.interesseAfiliado === true ||
    origemAfiliado
  ) {
    result.rotaComercial = "afiliado";
  } else if (rotaInformada === "homologado") {
    result.rotaComercial = "homologado";
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

/* =========================
   CONFIG
========================= */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iqg_token_123";
const CONSULTANT_PHONE = process.env.CONSULTANT_PHONE;

const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 18;
const BUSINESS_TIMEZONE_OFFSET = -3;

const leadState = {};

const processedMessages = new Map();
const processingMessages = new Set();

const PROCESSED_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROCESSED_MESSAGES = 5000;

// 🔥 BUFFER PERSISTENTE NO MONGO PARA AGUARDAR O LEAD TERMINAR DE DIGITAR
const TYPING_DEBOUNCE_MS = 12000; // espera 12s após a última mensagem
const MAX_TYPING_WAIT_MS = 35000; // limite máximo de agrupamento
/* =========================
   STATE
========================= */

function getState(from) {
  if (!leadState[from]) {
    leadState[from] = {
  folderSent: false,
  sentFiles: {},
  closed: false,
  inactivityTimer: null,
  shortTimer: null,
  followupTimers: [],
  inactivityFollowupCount: 0
};
  }

  return leadState[from];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function humanDelay(text = "") {
  const base = 1200;
  const perChar = 25;
  const total = base + text.length * perChar;

  return Math.min(total, 7000);
}

function shouldUseName(state) {
  if (!state.lastNameUse) return true;

  const now = Date.now();
  const diff = now - state.lastNameUse;

  // só permite usar o nome a cada 2 minutos
  return diff > 2 * 60 * 1000;
}

async function collectBufferedText(from, text, messageId) {
  await connectMongo();

  const now = new Date();
  const nowMs = Date.now();

  const cleanText = String(text || "").trim();

  if (!from || !cleanText) {
    return {
      shouldContinue: false,
      text: ""
    };
  }

  const bufferId = from;

  const pushData = {
  messages: cleanText
};

if (messageId) {
  pushData.messageIds = messageId;
}

await db.collection("incoming_message_buffers").updateOne(
  { _id: bufferId },
  {
    $setOnInsert: {
      user: from,
      startedAtMs: nowMs,
      createdAt: now
    },
    $set: {
      lastAtMs: nowMs,
      updatedAt: now
    },
    $push: pushData
  },
  { upsert: true }
);
   
  await delay(TYPING_DEBOUNCE_MS);

  const buffer = await db.collection("incoming_message_buffers").findOne({
    _id: bufferId
  });

  if (!buffer) {
    return {
      shouldContinue: false,
      text: ""
    };
  }

  const quietFor = Date.now() - Number(buffer.lastAtMs || 0);
  const totalWait = Date.now() - Number(buffer.startedAtMs || 0);

  if (quietFor < TYPING_DEBOUNCE_MS && totalWait < MAX_TYPING_WAIT_MS) {
    return {
      shouldContinue: false,
      text: ""
    };
  }

  const claimResult = await db.collection("incoming_message_buffers").findOneAndDelete({
    _id: bufferId
  });

  const finalBuffer = claimResult?.value || claimResult;

if (!finalBuffer) {
  return {
    shouldContinue: false,
    text: ""
  };
}

  const finalText = Array.isArray(finalBuffer.messages)
    ? finalBuffer.messages
        .map(msg => String(msg || "").trim())
        .filter(Boolean)
        .join("\n")
    : cleanText;

  return {
    shouldContinue: true,
    text: finalText,
    messageIds: Array.isArray(finalBuffer.messageIds)
      ? finalBuffer.messageIds
      : []
  };
}
function clearTimers(from) {
  const state = getState(from);

  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
  }

  if (state.shortTimer) {
    clearTimeout(state.shortTimer);
    state.shortTimer = null;
  }

  if (Array.isArray(state.followupTimers)) {
    for (const timer of state.followupTimers) {
      clearTimeout(timer);
    }

    state.followupTimers = [];
  }
}

function cleanupProcessedMessages() {
  const now = Date.now();

  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > PROCESSED_MESSAGE_TTL_MS) {
      processedMessages.delete(id);
    }
  }

  while (processedMessages.size > MAX_PROCESSED_MESSAGES) {
    const oldestId = processedMessages.keys().next().value;
    processedMessages.delete(oldestId);
  }
}

function markMessageAsProcessed(messageId) {
  if (!messageId) return;

  processingMessages.delete(messageId);
  processedMessages.set(messageId, Date.now());
}

function markMessageIdsAsProcessed(messageIds = []) {
  const ids = Array.isArray(messageIds)
    ? messageIds
    : [messageIds];

  for (const id of ids) {
    if (id) {
      markMessageAsProcessed(id);
    }
  }
}

/* =========================
   FILES
========================= */

const FILES = {
  catalogo: {
    link: "https://drive.google.com/uc?export=download&id=1uhC33i70whN9fdjoucnlJjrDZABG3DKS",
    filename: "Catalogo_Produtos_Piscina_IQG.pdf",
    caption: "Segue o catálogo de produtos de piscina da IQG."
  },
  contrato: {
    link: "https://drive.google.com/uc?export=download&id=1DdrKmuB_t1bHvpLvfuymYmGufLXN9qDG",
    filename: "Modelo_Contrato_IQG.pdf",
    caption: "Segue o modelo de contrato para leitura. A versão oficial para assinatura é liberada após análise cadastral da equipe IQG."
  },
  kit: {
    link: "https://drive.google.com/uc?export=download&id=1a0fLehflAcwxelV-ngESpKSWXwGkb-Ic",
    filename: "Kit_Parceiro_Homologado_IQG.pdf",
    caption: "Segue o material do Kit Parceiro Homologado IQG."
  },
  manual: {
    link: "https://drive.google.com/uc?export=download&id=13_HkO_6Kp2sGZYxgbChLzCsSmPVB-4JM",
    filename: "Manual_Curso_Tratamento_Piscina_IQG.pdf",
    caption: "Segue o manual/curso prático de tratamento de piscina. Ele ajuda a entender como usar os produtos e quando aplicar cada um."
  },
  folder: {
    link: "https://drive.google.com/uc?export=download&id=1wER0uBkkvnL_4BNs5AmDJeH0za-S3yFw",
    filename: "Folder_Programa_Parceiro_Homologado_IQG.pdf",
    caption: "Segue o folder explicativo do Programa Parceiro Homologado IQG."
  }
};

/* =========================
   PROMPT
========================= */

const CONSULTANT_ASSISTANT_SYSTEM_PROMPT = `
Você é o Consultor Assistente Comercial da IQG.

Sua função é orientar a SDR IA ANTES de ela responder ao lead.

Você NÃO conversa diretamente com o lead.
Você NÃO escreve a mensagem final palavra por palavra.
Você NÃO substitui a SDR.
Você NÃO substitui o Supervisor.
Você NÃO substitui o Classificador.
Você NÃO altera status.
Você NÃO envia dados ao CRM.
Você NÃO promete aprovação, ganho ou resultado.

Você deve analisar a ÚLTIMA MENSAGEM DO LEAD, o histórico, a memória conversacional interna e o estágio atual do funil para orientar:

- qual dúvida ou manifestação do lead deve ser respondida primeiro;
- qual assunto deve ser evitado nesta resposta;
- se a SDR deve avançar, permanecer na fase atual ou tratar objeção;
- qual tom usar;
- qual próxima pergunta fazer;
- quais riscos comerciais existem se a SDR responder errado.

A orientação precisa ser prática, objetiva e aplicável à resposta atual da SDR.

━━━━━━━━━━━━━━━━━━━━━━━
OBJETIVO DO CONSULTOR ASSISTENTE
━━━━━━━━━━━━━━━━━━━━━━━

Analisar o contexto comercial do lead e recomendar:

- estratégia comercial mais adequada;
- próxima melhor ação;
- abordagem sugerida;
- argumento principal;
- cuidado principal;
- oferta mais adequada;
- momento ideal para humano;
- prioridade comercial;
- resumo consultivo.

━━━━━━━━━━━━━━━━━━━━━━━
MEMÓRIA CONVERSACIONAL INTERNA
━━━━━━━━━━━━━━━━━━━━━━━

Você receberá um campo chamado memoriaConversacional.

Use esse campo para entender:

- quais temas já foram explicados;
- qual foi o tema da última resposta da SDR;
- se o lead respondeu apenas de forma curta/neutra;
- se existe risco de repetição;
- quais etapas ainda estão pendentes;
- se o lead está em coleta, confirmação ou correção de dados.

Regras:

1. Se memoriaConversacional.ultimaInteracao.riscoRepeticaoMesmoTema for true:
- orientar a SDR a NÃO repetir a mesma explicação;
- recomendar condução para o próximo passo natural;
- se ainda houver dúvida, responder de forma resumida.

2. Se memoriaConversacional.ultimaInteracao.leadRespondeuCurtoNeutro for true:
- não interpretar como avanço forte automaticamente;
- orientar a SDR a validar ou conduzir com pergunta simples.

3. Se memoriaConversacional.pendencias.etapasPendentes tiver itens:
- não orientar pré-análise/coleta antes de resolver essas pendências.

4. Se memoriaConversacional.pendencias.emColetaOuConfirmacao for true:
- não orientar rota comercial, Afiliados, taxa ou cadastro;
- orientar resposta curta e retomada do dado pendente.

5. Se memoriaConversacional.ultimaInteracao.leadFezPerguntaOuObjecao for true:
- identificar o tema da pergunta/objeção;
- orientar a SDR a responder esse tema primeiro;
- não permitir que a SDR apenas avance fase;
- não permitir que a SDR ignore a dúvida para seguir roteiro.

6. Se memoriaConversacional.ultimaInteracao.temasMensagemAtualLead tiver temas:
- usar esses temas para priorizar a resposta;
- se houver mais de um tema, orientar resposta organizada em uma única mensagem;
- não responder somente o último tema.

7. Nunca revele ao lead que existe memória conversacional, agente historiador, supervisor, classificador ou consultor interno.

━━━━━━━━━━━━━━━━━━━━━━━
PRIORIDADE MÁXIMA — ÚLTIMA MENSAGEM DO LEAD
━━━━━━━━━━━━━━━━━━━━━━━

A última mensagem do lead é a prioridade da análise.

Se a última mensagem contém pergunta, dúvida, áudio transcrito, objeção, reclamação ou correção:

1. A SDR deve responder isso primeiro.
2. A SDR não deve ignorar a pergunta para apenas seguir o roteiro.
3. A SDR não deve avançar fase se a dúvida atual ainda não foi respondida.
4. A SDR deve responder de forma curta e natural.
5. Depois de responder, pode conduzir para o próximo passo adequado.

Exemplos:

Lead:
"Mas pagar 1990?"

Orientação correta:
"Tratar objeção de taxa. Explicar que não é compra de mercadoria, caução ou garantia. Reforçar lote em comodato acima de R$ 5.000 em preço de venda e pagamento somente após análise interna e contrato. Não voltar para explicação inicial do programa."

Lead:
"Esse estoque vai ser sempre assim?"

Orientação correta:
"Responder diretamente sobre estoque, comodato e reposição. Explicar que o estoque sempre é cedido em comodato, que o parceiro não compra o estoque, que os produtos continuam sendo da IQG e que, quando vender, poderá solicitar reposição também em comodato. Explicar que estoques maiores podem ser avaliados conforme desempenho comercial e evolução do parceiro. Depois conduzir para responsabilidades. Não falar taxa agora."

Lead:
"Você já explicou"

Orientação correta:
"Reconhecer que já explicou, não repetir conteúdo, resumir em uma frase e conduzir para a decisão atual."

Lead:
"Não"

Se a SDR perguntou "ficou alguma dúvida?":
"Interpretar como: não tenho dúvida. Não tratar como rejeição. Conduzir para o próximo passo."

Se a SDR perguntou "os dados estão corretos?":
"Interpretar como correção de dados. Pedir qual dado está incorreto."

━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO COMERCIAL IQG
━━━━━━━━━━━━━━━━━━━━━━━

A IQG possui dois caminhos comerciais:

1. Programa Parceiro Homologado IQG
- Caminho principal do funil.
- Envolve venda com produtos físicos.
- Envolve lote inicial em comodato.
- Envolve suporte, treinamento, contrato e taxa de adesão.
- A taxa de adesão e implantação é de R$ 1.990,00.
- A taxa NÃO é compra de mercadoria.
- A taxa NÃO é caução.
- A taxa NÃO é garantia.
- O lote inicial em comodato representa mais de R$ 5.000,00 em preço de venda ao consumidor final.
- Quando o parceiro vende seguindo o preço sugerido ao consumidor, a margem é de 40%.
- Se o parceiro vender com ágio, acima do preço sugerido, essa diferença fica com ele e a margem pode ser maior.
- As primeiras vendas podem ajudar a recuperar o investimento inicial, mas isso depende da atuação comercial, prospecção e vendas realizadas.
- O investimento pode ser feito via PIX ou parcelado em até 10x de R$ 199,00 no cartão, dependendo da disponibilidade no momento.
- Não oferecer boleto para a adesão.
- O pagamento só ocorre após análise interna e assinatura do contrato.
- O resultado depende da atuação do parceiro nas vendas.

2. Programa de Afiliados IQG
- Caminho separado.
- O lead divulga produtos por link.
- Não precisa de estoque.
- Não envolve taxa de adesão do Homologado.
- É indicado para perfil digital, comissão, link, divulgação online ou quem quer começar sem estoque.

Afiliado não é perda.
Afiliado é rota alternativa quando fizer sentido.

━━━━━━━━━━━━━━━━━━━━━━━
COMO DECIDIR A ESTRATÉGIA
━━━━━━━━━━━━━━━━━━━━━━━

Use o histórico, a análise do Supervisor e a Classificação para decidir.

Se o lead está sensível ao preço ou travou na taxa:
- NÃO tratar a taxa isoladamente.
- Reforçar valor percebido antes de pedir qualquer avanço.
- Explicar que a taxa de R$ 1.990,00 não é compra de mercadoria, caução nem garantia.
- Reforçar que o lote inicial em comodato representa mais de R$ 5.000,00 em preço de venda ao consumidor.
- Explicar que, vendendo no preço sugerido, a margem é de 40%.
- Explicar que, se vender com ágio acima do preço sugerido, a diferença fica com o parceiro.
- Dizer que as primeiras vendas podem ajudar a recuperar o investimento inicial, mas sem prometer resultado.
- Reforçar que o resultado depende da atuação comercial do parceiro.
- Reforçar parcelamento no cartão em até 10x de R$ 199,00.
- Pode mencionar PIX.
- Não oferecer boleto.
- Reforçar que o pagamento só ocorre após análise interna e contrato.
- Não pressionar.
- Se o lead continuar travado na taxa, NÃO recomendar Afiliados automaticamente.
- Primeiro, insistir comercialmente no Homologado com valor percebido, segurança, comodato, margem/comissão, parcelamento e contrato.
- Afiliados só devem ser recomendados se o lead pedir claramente link, venda online, venda sem estoque físico, redes sociais, e-commerce, alternativa sem taxa do Homologado ou disser explicitamente que não quer seguir com produto físico/estoque.
- Objeção de preço, sozinha, é objeção do Homologado. Não é intenção de Afiliado.

Se o lead está desconfiado:
- Reforçar segurança, contrato, análise interna e clareza.
- Evitar tom agressivo.
- Sugerir humano se houver risco alto.

Se o lead está quente:
- Recomendar avanço controlado para pré-análise.
- Garantir que taxa e responsabilidades foram entendidas.
- Não pular etapas.

Se o lead parece afiliado:
- Recomendar rota de Afiliados.
- Não insistir no Homologado se o lead rejeitou estoque, taxa ou produto físico.
- Indicar que ele pode participar dos dois se fizer sentido.

Se o lead está morno:
- Recomendar reforço de valor e próxima pergunta simples.
- Evitar coleta de dados prematura.

Se o lead está frio, rejeitou, disse que não tem interesse, achou caro, quer deixar para depois ou esfriou:
- NÃO recomendar perda imediata.
- NÃO recomendar encerramento definitivo.
- Recomendar tentativa de reativação comercial com tom leve, consultivo e sem pressão.
- Primeiro tentar entender o motivo da trava.
- Se a trava for taxa, estoque, produto físico, risco, dinheiro ou insegurança, recomendar reforçar valor percebido do Homologado.
- Se a objeção for apenas preço, taxa, valor, dinheiro ou investimento, NÃO recomendar Afiliados automaticamente.
- Afiliado não deve ser usado como fuga da objeção de taxa.
- Só recomendar Afiliados se o lead pedir claramente um modelo por link, online, sem estoque físico, redes sociais, e-commerce, alternativa sem taxa do Homologado, ou se disser explicitamente que não quer produto físico/estoque.
- Afiliado continua sendo rota válida, mas apenas quando houver intenção clara ou decisão explícita do lead.
Se o Supervisor detectar erro da SDR:
- Priorizar correção de condução.
- Recomendar retomada simples e clara.
- Evitar repetir a mesma explicação.

━━━━━━━━━━━━━━━━━━━━━━━
ESTRATÉGIAS PERMITIDAS
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para estrategiaRecomendada:

- "reforcar_valor"
- "tratar_objecao_taxa"
- "reduzir_desconfianca"
- "avancar_pre_analise"
- "manter_nutricao"
- "oferecer_afiliado"
- "comparar_homologado_afiliado"
- "acionar_humano"
- "corrigir_conducao_sdr"
- "encerrar_sem_pressao"
- "nao_analisado"

━━━━━━━━━━━━━━━━━━━━━━━
OFERTA MAIS ADEQUADA
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para ofertaMaisAdequada:

- "homologado"
- "afiliado"
- "ambos"
- "nenhuma_no_momento"
- "nao_analisado"

━━━━━━━━━━━━━━━━━━━━━━━
MOMENTO IDEAL HUMANO
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para momentoIdealHumano:

- "agora"
- "se_houver_nova_objecao"
- "apos_confirmacao_dados"
- "apos_novo_sinal_de_interesse"
- "nao_necessario_agora"
- "nao_analisado"

━━━━━━━━━━━━━━━━━━━━━━━
PRIORIDADE COMERCIAL
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para prioridadeComercial:

- "baixa"
- "media"
- "alta"
- "urgente"
- "nao_analisado"

Critérios:

baixa:
Lead frio, sem intenção clara ou apenas curioso.

media:
Lead morno, fazendo perguntas, mas sem decisão.

alta:
Lead quente, travado em objeção ou com bom potencial.

urgente:
Risco crítico, desconfiança forte, lead muito quente ou necessidade clara de humano.

━━━━━━━━━━━━━━━━━━━━━━━
REGRAS IMPORTANTES
━━━━━━━━━━━━━━━━━━━━━━━

1. Não invente informações comerciais.

2. Não recomende promessa de ganho.

3. Não recomende pressionar o lead.

4. Não recomende pedir pagamento.

5. Não recomende coletar dados antes da fase correta.

6. Não recomende Homologado se o lead quer claramente apenas Afiliados.

7. Não recomende Afiliado apenas porque o lead citou Instagram, WhatsApp ou Facebook.

8. Se houver pouca informação, use estratégia de nutrição e prioridade média ou baixa.

9. Se houver objeção de taxa, a estratégia deve explicar valor percebido antes de insistir: lote em comodato acima de R$ 5.000, margem média estimada de 40% no preço sugerido, possibilidade de margem maior com ágio, parcelamento no cartão e pagamento somente após análise interna e contrato. Nunca prometer ganho garantido.

10. Se houver risco alto ou crítico, considere humano.

11. Se o lead travar na taxa, estoque, produto físico, risco ou investimento antes de confirmar todos os dados, não considerar como perda imediata. A primeira prioridade é tratar a objeção dentro do Parceiro Homologado.

12. Objeção de preço, taxa, valor, dinheiro ou investimento NÃO significa Afiliado. Nesses casos, recomende sustentar o Homologado com valor percebido: lote em comodato acima de R$ 5.000,00 em preço de venda, comissão/margem de até 40% no preço sugerido, possibilidade de margem maior com ágio, suporte, treinamento, contrato, segurança e parcelamento.

13. O Programa de Afiliados só deve ser recomendado quando houver intenção clara do lead por link, divulgação online, redes sociais, e-commerce, venda sem estoque físico, alternativa sem taxa do Homologado, ou rejeição explícita de produto físico/estoque.

14. Se recomendar Afiliados, orientar a SDR a explicar tudo em uma única mensagem curta: diferença entre os programas, ausência de estoque físico, ausência de taxa do Homologado, divulgação por link, comissão por vendas validadas e link de cadastro.

15. Nunca recomendar Afiliados apenas porque o lead achou caro, disse que precisa pensar ou demonstrou insegurança financeira. Isso deve ser tratado primeiro como objeção comercial do Homologado.

━━━━━━━━━━━━━━━━━━━━━━━
FORMATO DE SAÍDA OBRIGATÓRIO
━━━━━━━━━━━━━━━━━━━━━━━

Responda somente com JSON válido.
Não use markdown.
Não use texto antes ou depois.
Não use comentários.

O JSON deve ter exatamente esta estrutura:

{
  "estrategiaRecomendada": "nao_analisado",
  "proximaMelhorAcao": "",
  "abordagemSugerida": "",
  "argumentoPrincipal": "",
  "cuidadoPrincipal": "",
  "ofertaMaisAdequada": "nao_analisado",
  "momentoIdealHumano": "nao_analisado",
  "prioridadeComercial": "nao_analisado",
  "resumoConsultivo": ""
}

Como preencher:

"proximaMelhorAcao":
Diga de forma prática o que a SDR deve fazer AGORA.
Exemplo: "Responder primeiro a dúvida sobre comodato e depois conduzir para responsabilidades."

"abordagemSugerida":
Explique o tom e a forma da resposta.
Exemplo: "Tom calmo, curto e consultivo. Não repetir explicações anteriores."

"argumentoPrincipal":
Diga o argumento que deve aparecer na resposta, se houver.
Exemplo: "O lote é em comodato e continua sendo da IQG."

"cuidadoPrincipal":
Diga o que a SDR deve evitar nesta resposta.
Exemplo: "Não falar taxa nesta resposta. Não pedir CPF. Não avançar para pré-análise."

"resumoConsultivo":
Resuma claramente a orientação para a resposta atual.
Exemplo: "O lead perguntou sobre continuidade do estoque. A SDR deve responder diretamente sobre comodato, sem falar de taxa, e conduzir para responsabilidades."
`;

function parseConsultantAdviceJson(rawText = "") {
  const fallback = buildDefaultConsultantAdvice();

  try {
    const parsed = JSON.parse(rawText);

    return {
      ...fallback,
      ...parsed,
      consultadoEm: new Date()
    };
  } catch (error) {
    try {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");

      if (start === -1 || end === -1 || end <= start) {
        return {
          ...fallback,
          estrategiaRecomendada: "nao_analisado",
          proximaMelhorAcao: "Consultor Assistente retornou resposta sem JSON válido.",
          prioridadeComercial: "nao_analisado",
          resumoConsultivo: "Falha ao localizar objeto JSON na resposta do Consultor Assistente.",
          consultadoEm: new Date()
        };
      }

      const jsonText = rawText.slice(start, end + 1);
      const parsed = JSON.parse(jsonText);

      return {
        ...fallback,
        ...parsed,
        consultadoEm: new Date()
      };
    } catch (secondError) {
      return {
        ...fallback,
        estrategiaRecomendada: "nao_analisado",
        proximaMelhorAcao: "Consultor Assistente retornou JSON inválido.",
        prioridadeComercial: "nao_analisado",
        resumoConsultivo: `Não foi possível interpretar a resposta do Consultor Assistente como JSON. Erro: ${String(secondError.message || secondError)}`,
        consultadoEm: new Date()
      };
    }
  }
}

async function runConsultantAssistant({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = "",
  supervisorAnalysis = {},
  classification = {},
  semanticIntent = null,
  commercialRouteDecision = null,
  backendStrategicGuidance = []
} = {}) {
  const recentHistory = Array.isArray(history)
    ? history.slice(-12).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  const conversationMemory = buildConversationMemoryForAgents({
    lead,
    history,
    lastUserText,
    lastSdrText
  });

  const consultantPayload = {
    lead: {
      user: lead.user || "",
      status: lead.status || "",
      faseQualificacao: lead.faseQualificacao || "",
      statusOperacional: lead.statusOperacional || "",
      faseFunil: lead.faseFunil || "",
      temperaturaComercial: lead.temperaturaComercial || "",
      rotaComercial: lead.rotaComercial || "",
      rotaComercialSugerida: lead.rotaComercialSugerida || "",
      origemConversao: lead.origemConversao || "",
      origemConversaoSugerida: lead.origemConversaoSugerida || "",
      interesseReal: lead.interesseReal === true,
      interesseAfiliado: lead.interesseAfiliado === true,
      sinalAfiliadoExplicito: lead.sinalAfiliadoExplicito === true,
      sinalComparacaoProgramas: lead.sinalComparacaoProgramas === true,
      sinalPerguntaTaxa: lead.sinalPerguntaTaxa === true,
      sinalObjecaoTaxa: lead.sinalObjecaoTaxa === true,
      taxaModoConversao: lead.taxaModoConversao === true,
      taxaObjectionCount: Number(lead.taxaObjectionCount || 0),
      taxaAlinhada: lead.taxaAlinhada === true,
      dadosConfirmadosPeloLead: lead.dadosConfirmadosPeloLead === true,
      crmEnviado: lead.crmEnviado === true,
      etapas: lead.etapas || {},
      etapasAguardandoEntendimento: lead.etapasAguardandoEntendimento || {}
    },
    supervisor: supervisorAnalysis || {},
    classificacao: classification || {},
    memoriaConversacional: conversationMemory,
    interpretacaoSemanticaBackend: semanticIntent || {},
    decisaoRotaBackend: commercialRouteDecision || {},
    orientacoesEstrategicasBackend: Array.isArray(backendStrategicGuidance)
      ? backendStrategicGuidance
      : [],
    ultimaMensagemLead: lastUserText || "",
    ultimaRespostaSdr: lastSdrText || "",
    historicoRecente: recentHistory
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_CONSULTANT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: CONSULTANT_ASSISTANT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify(consultantPayload)
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao rodar Consultor Assistente:", data);

    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: "nao_analisado",
      proximaMelhorAcao: "Falha ao chamar a OpenAI para consultoria interna.",
      prioridadeComercial: "nao_analisado",
      resumoConsultivo: "Erro na chamada OpenAI do Consultor Assistente.",
      consultadoEm: new Date()
    };
  }

  const rawText = data.choices?.[0]?.message?.content || "";

  return parseConsultantAdviceJson(rawText);
}
async function runLeadSemanticIntentClassifier({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  const fallback = {
    greetingOnly: false,
    asksQuestion: false,
    questionTopics: [],
    wantsAffiliate: false,
    wantsHomologado: false,
    wantsBoth: false,
    positiveRealInterest: false,
    positiveCommitment: false,
    softUnderstandingOnly: false,
    blockingObjection: false,
    blockingReason: "",
    priceObjection: false,
    stockObjection: false,
    riskObjection: false,
    delayOrAbandonment: false,
    paymentIntent: false,
    humanRequest: false,
    dataCorrectionIntent: false,
    requestedFile: "",
    confidence: "baixa",
    reason: "Fallback local. Classificador semântico não executado ou falhou."
  };

  const recentHistory = Array.isArray(history)
    ? history.slice(-8).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SEMANTIC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Você é um classificador semântico interno da IQG.

Sua função é interpretar a ÚLTIMA mensagem do lead em uma conversa de WhatsApp.

Você NÃO conversa com o lead.
Você NÃO escreve resposta da SDR.
Você NÃO altera status.
Você NÃO decide envio ao CRM.
Você NÃO confirma CPF, telefone, cidade ou estado.
Você apenas retorna um JSON interno de interpretação semântica.

CONTEXTO COMERCIAL:
A IQG possui dois caminhos:
1. Parceiro Homologado IQG:
- envolve produtos físicos;
- lote inicial em comodato;
- suporte, treinamento, contrato e taxa de adesão;
- exige condução por fases antes de coletar dados.

2. Programa de Afiliados IQG:
- divulgação por link;
- sem estoque;
- sem taxa de adesão do Homologado;
- cadastro em https://minhaiqg.com.br/.

TAREFA:
Analise a última mensagem do lead e retorne sinais semânticos.

REGRAS:
- Se o lead só cumprimentou, marque greetingOnly true.
- Se o lead fez pergunta, marque asksQuestion true e informe questionTopics.
- Se o lead quer afiliado, link, comissão por link, divulgação online ou vender sem estoque, marque wantsAffiliate true.
- Se o lead quer claramente Parceiro Homologado, revenda, estoque, kit, lote ou produto físico, marque wantsHomologado true.
- Se o lead quer os dois caminhos ou compara os dois, marque wantsBoth true.
- Se o lead confirma claramente interesse em seguir para pré-análise, marque positiveRealInterest true.
- Respostas como "óbvio", "claro", "com certeza", "demorou", "manda bala", "👍", "✅", "👌" podem ser positivas dependendo do contexto.
- Se o lead apenas demonstra recebimento/entendimento, como "ok", "entendi", "show", "beleza", "fez sentido", marque softUnderstandingOnly true.
- Se o lead trava por preço, taxa, risco, estoque, produto físico ou diz que vai pensar/deixar para depois, marque blockingObjection true.
- Se a trava for sobre preço/taxa/valor, marque priceObjection true.
- Se a trava for sobre estoque/produto físico/comodato, marque stockObjection true.
- Se a trava for sobre medo, risco, insegurança ou desconfiança, marque riskObjection true.
- Se o lead quer adiar, sumir, pensar ou deixar para depois, marque delayOrAbandonment true.
- Se o lead fala em pagar, pagamento, pix, cartão ou boleto, marque paymentIntent true.
- Se o lead pede atendente, pessoa, humano, consultor ou vendedor, marque humanRequest true.
- Se o lead diz que algum dado está errado ou quer corrigir CPF, telefone, cidade, estado ou nome, marque dataCorrectionIntent true.
- Se o lead pede material, PDF, contrato, catálogo, kit, manual, curso ou folder, preencha requestedFile com: "contrato", "catalogo", "kit", "manual", "folder" ou "".

IMPORTANTE:
- Não invente intenção.
- Se houver dúvida, use false e confidence baixa.
- O backend decidirá o que fazer. Você apenas interpreta.

Responda somente JSON válido neste formato:

{
  "greetingOnly": false,
  "asksQuestion": false,
  "questionTopics": [],
  "wantsAffiliate": false,
  "wantsHomologado": false,
  "wantsBoth": false,
  "positiveRealInterest": false,
  "positiveCommitment": false,
  "softUnderstandingOnly": false,
  "blockingObjection": false,
  "blockingReason": "",
  "priceObjection": false,
  "stockObjection": false,
  "riskObjection": false,
  "delayOrAbandonment": false,
  "paymentIntent": false,
  "humanRequest": false,
  "dataCorrectionIntent": false,
  "requestedFile": "",
  "confidence": "baixa",
  "reason": ""
}
`
          },
          {
            role: "user",
            content: JSON.stringify({
              ultimaMensagemLead: lastUserText || "",
              ultimaRespostaSdr: lastSdrText || "",
              historicoRecente: recentHistory,
              lead: {
                status: lead.status || "",
                faseQualificacao: lead.faseQualificacao || "",
                statusOperacional: lead.statusOperacional || "",
                faseFunil: lead.faseFunil || "",
                temperaturaComercial: lead.temperaturaComercial || "",
                rotaComercial: lead.rotaComercial || "",
                origemConversao: lead.origemConversao || "",
                interesseReal: lead.interesseReal === true,
                interesseAfiliado: lead.interesseAfiliado === true,
                dadosConfirmadosPeloLead: lead.dadosConfirmadosPeloLead === true,
                crmEnviado: lead.crmEnviado === true,
                aguardandoConfirmacaoCampo: lead.aguardandoConfirmacaoCampo === true,
                aguardandoConfirmacao: lead.aguardandoConfirmacao === true,
                campoPendente: lead.campoPendente || "",
                campoEsperado: lead.campoEsperado || "",
                etapas: lead.etapas || {}
              }
            })
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro no classificador semântico:", data);
      return fallback;
    }

    const rawText = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(rawText);

    return {
      ...fallback,
      ...parsed,
      questionTopics: Array.isArray(parsed?.questionTopics) ? parsed.questionTopics : [],
      requestedFile: parsed?.requestedFile || "",
      confidence: parsed?.confidence || "baixa",
      reason: parsed?.reason || ""
    };
  } catch (error) {
    console.error("Falha no classificador semântico:", error.message);
    return fallback;
  }
}

function decideCommercialRouteFromSemanticIntent({
  semanticIntent = null,
  currentLead = {}
} = {}) {
  const fallback = {
    rota: "nenhuma",
    deveResponderAgora: false,
    deveCompararProgramas: false,
    deveManterHomologado: true,
    origemConversao: currentLead?.origemConversao || "homologado",
    motivo: "Sem intenção semântica suficiente para alterar rota comercial."
  };

  if (!semanticIntent) {
    return fallback;
  }

  const confidence = semanticIntent?.confidence || "baixa";

  const confiancaAceitavel =
    confidence === "media" ||
    confidence === "média" ||
    confidence === "alta";

  if (!confiancaAceitavel) {
    return {
      ...fallback,
      motivo: "Classificador semântico retornou baixa confiança. Mantendo Homologado por segurança."
    };
  }

  const querAfiliado = semanticIntent?.wantsAffiliate === true;
  const querHomologado = semanticIntent?.wantsHomologado === true;
  const querAmbos =
    semanticIntent?.wantsBoth === true ||
    (querAfiliado && querHomologado);

  const temObjecaoBloqueante = semanticIntent?.blockingObjection === true;
  const temObjecaoPreco = semanticIntent?.priceObjection === true;
  const temObjecaoEstoque = semanticIntent?.stockObjection === true;

  const pediuHumano = semanticIntent?.humanRequest === true;

  // Caso 1:
  // Lead quer claramente comparar ou entender os dois caminhos.
  // Não joga direto para Afiliado.
  if (querAmbos) {
    return {
      rota: "ambos",
      deveResponderAgora: true,
      deveCompararProgramas: true,
      deveManterHomologado: false,
      origemConversao: "comparacao_homologado_afiliado",
      motivo: "Lead demonstrou intenção de comparar ou considerar Afiliado e Homologado."
    };
  }

  // Caso 2:
  // Lead quer claramente Afiliado, e não Homologado.
  if (querAfiliado && !querHomologado) {
    return {
      rota: "afiliado",
      deveResponderAgora: true,
      deveCompararProgramas: false,
      deveManterHomologado: false,
      origemConversao: "interesse_direto_afiliado",
      motivo: "Lead demonstrou intenção clara pelo Programa de Afiliados."
    };
  }

  // Caso 3:
  // Lead quer Homologado.
  if (querHomologado && !querAfiliado) {
    return {
      rota: "homologado",
      deveResponderAgora: false,
      deveCompararProgramas: false,
      deveManterHomologado: true,
      origemConversao: "homologado",
      motivo: "Lead demonstrou intenção clara pelo Parceiro Homologado."
    };
  }

  // Caso 4:
  // Objeção de preço sozinha não pode virar Afiliado.
  if (temObjecaoBloqueante && temObjecaoPreco && !querAfiliado && !querAmbos) {
    return {
      rota: "homologado",
      deveResponderAgora: false,
      deveCompararProgramas: false,
      deveManterHomologado: true,
      origemConversao: "objecao_taxa_homologado",
      motivo: "Lead tem objeção de preço, mas não pediu Afiliado. Manter tratamento da taxa no Homologado."
    };
  }

  // Caso 5:
  // Objeção de estoque sem intenção clara de Afiliado ainda exige cautela.
  // Não muda rota sozinho.
  if (temObjecaoBloqueante && temObjecaoEstoque && !querAfiliado && !querAmbos) {
    return {
      rota: "homologado",
      deveResponderAgora: false,
      deveCompararProgramas: false,
      deveManterHomologado: true,
      origemConversao: "objecao_estoque_homologado",
      motivo: "Lead tem objeção de estoque, mas ainda não pediu claramente Afiliado. Responder objeção antes de trocar rota."
    };
  }

  // Caso 6:
  // Pedido de humano não é Afiliado nem Homologado.
  if (pediuHumano) {
    return {
      rota: "nenhuma",
      deveResponderAgora: false,
      deveCompararProgramas: false,
      deveManterHomologado: true,
      origemConversao: currentLead?.origemConversao || "homologado",
      motivo: "Lead pediu humano. Não alterar rota comercial automaticamente."
    };
  }

  return fallback;
}

function buildBothProgramsComparisonResponse() {
  return `São dois caminhos diferentes 😊

No Programa de Afiliados, você divulga produtos online por link exclusivo, sem estoque e sem investimento inicial do Homologado. Quando uma venda é feita pelo seu link e validada, você recebe comissão.

No Parceiro Homologado, o modelo é mais estruturado: envolve produtos físicos, lote em comodato, suporte comercial, treinamento, contrato, responsabilidades e taxa de adesão.

Você pode participar só do afiliado, só do homologado ou dos dois, dependendo do seu objetivo.

O cadastro de afiliado é por aqui:
https://minhaiqg.com.br/

Você quer seguir pelo cadastro de afiliado ou quer que eu continue te explicando o Parceiro Homologado também?`;
}

async function runConsultantAfterClassifier({
  user,
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = "",
  supervisorAnalysis = {},
  classification = {}
} = {}) {
  try {
    if (!user) return;

    let consultantAdvice = await runConsultantAssistant({
  lead,
  history,
  lastUserText,
  lastSdrText,
  supervisorAnalysis,
  classification
});

const originalConsultantAdvice = consultantAdvice;

consultantAdvice = enforceConsultantHardLimits({
  consultantAdvice,
  lead,
  lastUserText,
  classification
});

if (
  originalConsultantAdvice?.estrategiaRecomendada !== consultantAdvice?.estrategiaRecomendada ||
  originalConsultantAdvice?.ofertaMaisAdequada !== consultantAdvice?.ofertaMaisAdequada ||
  originalConsultantAdvice?.momentoIdealHumano !== consultantAdvice?.momentoIdealHumano
) {
  console.log("🛡️ Consultor corrigido por trava dura:", {
    user,
    ultimaMensagemLead: lastUserText,
    estrategiaOriginal: originalConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
    estrategiaCorrigida: consultantAdvice?.estrategiaRecomendada || "nao_analisado",
    ofertaOriginal: originalConsultantAdvice?.ofertaMaisAdequada || "nao_analisado",
    ofertaCorrigida: consultantAdvice?.ofertaMaisAdequada || "nao_analisado",
    motivo: "objecao_de_preco_sem_pedido_claro_de_afiliado"
  });
}

await saveConsultantAdvice(user, consultantAdvice);

    console.log("✅ Consultor Assistente analisou estratégia:", {
      user,
      estrategiaRecomendada: consultantAdvice?.estrategiaRecomendada || "nao_analisado",
      ofertaMaisAdequada: consultantAdvice?.ofertaMaisAdequada || "nao_analisado",
      momentoIdealHumano: consultantAdvice?.momentoIdealHumano || "nao_analisado",
      prioridadeComercial: consultantAdvice?.prioridadeComercial || "nao_analisado"
    });
  } catch (error) {
    console.error("⚠️ Consultor Assistente falhou, mas atendimento continua:", error.message);
  }
}

const CLASSIFIER_SYSTEM_PROMPT = `
Você é o GPT Classificador Comercial da IQG.

Sua função é classificar o perfil comportamental e comercial do lead com base no histórico da conversa.

Você NÃO conversa com o lead.
Você NÃO escreve mensagem para o lead.
Você NÃO audita a SDR.
Você NÃO cria estratégia detalhada.
Você NÃO altera status.
Você NÃO envia dados ao CRM.
Você apenas classifica o lead e retorna um JSON interno.

━━━━━━━━━━━━━━━━━━━━━━━
OBJETIVO DO CLASSIFICADOR
━━━━━━━━━━━━━━━━━━━━━━━

Classificar o lead quanto a:

- temperatura comercial;
- perfil comportamental principal;
- perfil comportamental secundário;
- nível de consciência;
- intenção principal;
- objeção principal;
- sinais observados;
- confiança da classificação;
- resumo do perfil.

━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO COMERCIAL IQG
━━━━━━━━━━━━━━━━━━━━━━━

A IQG possui dois caminhos comerciais:

1. Programa Parceiro Homologado IQG
- Caminho principal do funil.
- Envolve produto físico.
- Envolve lote inicial em comodato.
- Envolve suporte, treinamento, contrato e taxa de adesão.
- A taxa de adesão é de R$ 1.990.
- O lote inicial representa mais de R$ 5.000 em preço de venda ao consumidor final.
- O pagamento só ocorre após análise interna e contrato.
- O resultado depende da atuação do parceiro nas vendas.

2. Programa de Afiliados IQG
- Caminho separado.
- O lead divulga produtos por link.
- Não precisa de estoque.
- Não envolve taxa de adesão do Homologado.
- É indicado para perfil digital, comissão, link, divulgação online ou quem quer começar sem estoque.

Afiliado não é perda.
Afiliado é rota alternativa quando fizer sentido.

━━━━━━━━━━━━━━━━━━━━━━━
PERFIS COMPORTAMENTAIS POSSÍVEIS
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para perfilComportamentalPrincipal e perfilComportamentalSecundario:

- "direto_objetivo"
- "analitico"
- "desconfiado"
- "sensivel_preco"
- "comprador_impulsivo"
- "curioso_morno"
- "oportunista"
- "afiliado_digital"
- "inseguro"
- "qualificado_pronto"
- "nao_analisado"

Critérios:

direto_objetivo:
Quer resposta rápida, valor, próximo passo e objetividade.

analitico:
Pergunta regras, contrato, números, funcionamento, detalhes e condições.

desconfiado:
Tem medo de golpe, pegadinha, taxa escondida, promessa falsa ou falta de clareza.

sensivel_preco:
Trava na taxa, pergunta preço cedo, demonstra limitação financeira ou acha caro.

comprador_impulsivo:
Quer avançar rápido, diz "quero entrar", "bora", "mete bala", sem demonstrar análise profunda.

curioso_morno:
Pergunta, interage, mas ainda sem intenção clara de seguir.

oportunista:
Busca ganho fácil, renda garantida, pouco esforço ou promessa de resultado.

afiliado_digital:
Fala em link, comissão, divulgação online, redes sociais, afiliado ou venda digital.

inseguro:
Demonstra medo, hesitação, pede confirmação, quer segurança para decidir.

qualificado_pronto:
Entendeu o programa, aceita responsabilidades, taxa e próximo passo.

━━━━━━━━━━━━━━━━━━━━━━━
TEMPERATURA COMERCIAL
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para temperaturaComercial:

- "frio"
- "morno"
- "quente"
- "travado"
- "afiliado"
- "nao_analisado"

Critérios:

frio:
Sem interesse, rejeição clara ou busca algo incompatível com IQG.

morno:
Tem curiosidade, pergunta, mas ainda não demonstrou decisão.

quente:
Demonstra intenção clara, entende o modelo e quer avançar.

travado:
Existe interesse, mas alguma objeção impede avanço.

afiliado:
Lead tem intenção clara ou perfil dominante para Programa de Afiliados.

━━━━━━━━━━━━━━━━━━━━━━━
NÍVEL DE CONSCIÊNCIA
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para nivelConsciencia:

- "baixo"
- "medio"
- "alto"
- "nao_analisado"

baixo:
Lead ainda não entendeu o programa.

medio:
Lead entendeu parte do programa, mas ainda precisa de esclarecimento.

alto:
Lead entende modelo, responsabilidades, taxa e próximos passos.

━━━━━━━━━━━━━━━━━━━━━━━
INTENÇÃO PRINCIPAL
━━━━━━━━━━━━━━━━━━━━━━━

Use preferencialmente um destes valores para intencaoPrincipal:

- "entender_homologado"
- "avaliar_investimento"
- "avancar_pre_analise"
- "buscar_afiliado"
- "comparar_homologado_afiliado"
- "tirar_duvida"
- "enviar_dados"
- "recusar_programa"
- "sem_intencao_clara"
- "nao_analisado"

━━━━━━━━━━━━━━━━━━━━━━━
OBJEÇÃO PRINCIPAL
━━━━━━━━━━━━━━━━━━━━━━━

Use preferencialmente um destes valores para objecaoPrincipal:

- "sem_objecao_detectada"
- "preco_taxa_adesao"
- "desconfianca"
- "nao_quer_estoque"
- "quer_ganho_garantido"
- "medo_de_risco"
- "falta_de_entendimento"
- "tempo_para_decidir"
- "quer_mais_informacoes"
- "afiliado_vs_homologado"
- "outro"

━━━━━━━━━━━━━━━━━━━━━━━
REGRAS IMPORTANTES
━━━━━━━━━━━━━━━━━━━━━━━

1. Não classifique como afiliado apenas porque o lead falou Instagram, Facebook, WhatsApp ou redes sociais.

2. Classifique como afiliado_digital quando o lead falar claramente em:
- afiliado;
- link de afiliado;
- divulgar por link;
- comissão online;
- cadastro de afiliado;
- vender por link.

3. Se o lead disser "achei caro", "taxa alta" ou "não tenho dinheiro agora", classifique como sensivel_preco ou travado, não como afiliado automaticamente.

4. Se o lead rejeitar estoque, produto físico ou taxa de adesão, pode haver indicação para Afiliados.

5. Se o lead disser "quero entrar", "vamos seguir", "pode iniciar", ele pode ser quente, mas avalie se já entendeu taxa e responsabilidades.

6. Se o lead perguntar "qual a pegadinha?", "é golpe?", "tem contrato?", considere perfil desconfiado.

7. Se o lead quiser renda garantida ou dinheiro fácil, considere oportunista ou inseguro, conforme o tom.

8. Se houver pouca informação, use "nao_analisado" ou "sem_intencao_clara" em vez de inventar.

9. A classificação deve se basear em sinais observáveis no histórico.

10. Não use dados pessoais sensíveis para inferir perfil comportamental.

━━━━━━━━━━━━━━━━━━━━━━━
CONFIANÇA DA CLASSIFICAÇÃO
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para confiancaClassificacao:

- "baixa"
- "media"
- "alta"
- "nao_analisado"

baixa:
Poucas mensagens ou sinais fracos.

media:
Há alguns sinais claros, mas ainda pode mudar.

alta:
Há sinais repetidos ou explícitos.

━━━━━━━━━━━━━━━━━━━━━━━
FORMATO DE SAÍDA OBRIGATÓRIO
━━━━━━━━━━━━━━━━━━━━━━━

Responda somente com JSON válido.
Não use markdown.
Não use texto antes ou depois.
Não use comentários.

O JSON deve ter exatamente esta estrutura:

{
  "temperaturaComercial": "nao_analisado",
  "perfilComportamentalPrincipal": "nao_analisado",
  "perfilComportamentalSecundario": "",
  "nivelConsciencia": "nao_analisado",
  "intencaoPrincipal": "nao_analisado",
  "objecaoPrincipal": "sem_objecao_detectada",
  "confiancaClassificacao": "nao_analisado",
  "sinaisObservados": [],
  "resumoPerfil": ""
}
`;

function parseClassifierJson(rawText = "") {
  const fallback = buildDefaultLeadClassification();

  try {
    const parsed = JSON.parse(rawText);

    return {
      ...fallback,
      ...parsed,
      classificadoEm: new Date()
    };
  } catch (error) {
    try {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");

      if (start === -1 || end === -1 || end <= start) {
        return {
          ...fallback,
          confiancaClassificacao: "baixa",
          resumoPerfil: "Classificador retornou resposta sem JSON válido.",
          sinaisObservados: ["erro_json_classificador"],
          classificadoEm: new Date()
        };
      }

      const jsonText = rawText.slice(start, end + 1);
      const parsed = JSON.parse(jsonText);

      return {
        ...fallback,
        ...parsed,
        classificadoEm: new Date()
      };
    } catch (secondError) {
      return {
        ...fallback,
        confiancaClassificacao: "baixa",
        resumoPerfil: "Classificador retornou JSON inválido.",
        sinaisObservados: [
          "erro_json_classificador",
          String(secondError.message || secondError)
        ],
        classificadoEm: new Date()
      };
    }
  }
}

async function runClassifier({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = "",
  supervisorAnalysis = {}
} = {}) {
  const recentHistory = Array.isArray(history)
    ? history.slice(-12).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  const classifierPayload = {
    lead: {
      user: lead.user || "",
      status: lead.status || "",
      faseQualificacao: lead.faseQualificacao || "",
      statusOperacional: lead.statusOperacional || "",
      faseFunil: lead.faseFunil || "",
      temperaturaComercial: lead.temperaturaComercial || "",
      rotaComercial: lead.rotaComercial || "",
      origemConversao: lead.origemConversao || "",
      interesseReal: lead.interesseReal === true,
      interesseAfiliado: lead.interesseAfiliado === true,
      dadosConfirmadosPeloLead: lead.dadosConfirmadosPeloLead === true,
      crmEnviado: lead.crmEnviado === true,
      etapas: lead.etapas || {}
    },
    supervisor: supervisorAnalysis || {},
    ultimaMensagemLead: lastUserText || "",
    ultimaRespostaSdr: lastSdrText || "",
    historicoRecente: recentHistory
  };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_CLASSIFIER_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: CLASSIFIER_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify(classifierPayload)
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao rodar Classificador:", data);

    return {
      ...buildDefaultLeadClassification(),
      confiancaClassificacao: "baixa",
      sinaisObservados: ["erro_api_classificador"],
      resumoPerfil: "Falha ao chamar a OpenAI para classificação do lead.",
      classificadoEm: new Date()
    };
  }

  const rawText = data.choices?.[0]?.message?.content || "";

  return parseClassifierJson(rawText);
}

async function runClassifierAfterSupervisor({
  user,
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = "",
  supervisorAnalysis = {}
} = {}) {
  try {
    if (!user) return;

   let classification = await runClassifier({
  lead,
  history,
  lastUserText,
  lastSdrText,
  supervisorAnalysis
});

const originalClassification = classification;

classification = enforceClassifierHardLimits({
  classification,
  lead,
  lastUserText
});

if (
  originalClassification?.temperaturaComercial !== classification?.temperaturaComercial ||
  originalClassification?.perfilComportamentalPrincipal !== classification?.perfilComportamentalPrincipal ||
  originalClassification?.intencaoPrincipal !== classification?.intencaoPrincipal ||
  originalClassification?.confiancaClassificacao !== classification?.confiancaClassificacao
) {
  console.log("🛡️ Classificador corrigido por trava dura:", {
    user,
    ultimaMensagemLead: lastUserText,
    temperaturaOriginal: originalClassification?.temperaturaComercial || "nao_analisado",
    temperaturaCorrigida: classification?.temperaturaComercial || "nao_analisado",
    perfilOriginal: originalClassification?.perfilComportamentalPrincipal || "nao_analisado",
    perfilCorrigido: classification?.perfilComportamentalPrincipal || "nao_analisado",
    intencaoOriginal: originalClassification?.intencaoPrincipal || "nao_analisado",
    intencaoCorrigida: classification?.intencaoPrincipal || "nao_analisado",
    confiancaOriginal: originalClassification?.confiancaClassificacao || "nao_analisado",
    confiancaCorrigida: classification?.confiancaClassificacao || "nao_analisado"
  });
}

await saveLeadClassification(user, classification);

    runConsultantAfterClassifier({
      user,
      lead,
      history,
      lastUserText,
      lastSdrText,
      supervisorAnalysis,
      classification
    });

    console.log("✅ Classificador analisou lead:", {
      user,
      temperaturaComercial: classification?.temperaturaComercial || "nao_analisado",
      perfil: classification?.perfilComportamentalPrincipal || "nao_analisado",
      intencaoPrincipal: classification?.intencaoPrincipal || "nao_analisado",
      objecaoPrincipal: classification?.objecaoPrincipal || "sem_objecao_detectada",
      confianca: classification?.confiancaClassificacao || "nao_analisado",
      consultorAcionado: true
    });
  } catch (error) {
    console.error("⚠️ Classificador falhou, mas atendimento continua:", error.message);
  }
}
const SUPERVISOR_SYSTEM_PROMPT = `
Você é o GPT Supervisor Comercial da IQG.

Sua função é auditar a qualidade da condução da SDR IA da IQG em conversas de WhatsApp.

Você NÃO conversa com o lead.
Você NÃO escreve a resposta final da SDR.
Você NÃO aprova lead.
Você NÃO pede dados.
Você NÃO altera status.
Você NÃO decide pagamento.
Você apenas analisa a conversa e retorna um diagnóstico interno em JSON.

━━━━━━━━━━━━━━━━━━━━━━━
OBJETIVO DO SUPERVISOR
━━━━━━━━━━━━━━━━━━━━━━━

Avaliar se a SDR conduziu corretamente o lead no funil comercial da IQG.

Você deve identificar:

- se a SDR pulou fase;
- se pediu dados cedo demais;
- se falou da taxa cedo demais;
- se apresentou taxa sem ancorar valor;
- se explicou o lote em comodato;
- se explicou responsabilidades;
- se confundiu Programa Parceiro Homologado com Programa de Afiliados;
- se classificou Afiliado sem contexto suficiente;
- se repetiu perguntas;
- se entrou em loop;
- se deixou o lead sem próximo passo;
- se houve confirmação excessiva;
- se houve risco de perda;
- se o lead esfriou;
- se humano deve assumir.

━━━━━━━━━━━━━━━━━━━━━━━
CONTEXTO COMERCIAL IQG
━━━━━━━━━━━━━━━━━━━━━━━

A IQG possui dois caminhos comerciais:

1. Programa Parceiro Homologado IQG
- Caminho principal do funil.
- Envolve produto físico.
- Envolve lote inicial em comodato.
- Envolve suporte, treinamento e estrutura comercial.
- Envolve taxa de adesão de R$ 1.990.
- O lote inicial representa mais de R$ 5.000 em preço de venda ao consumidor final.
- O pagamento só ocorre após análise interna e contrato.
- O resultado depende da atuação do parceiro nas vendas.

2. Programa de Afiliados IQG
- Caminho separado.
- O lead divulga por link.
- Não precisa de estoque.
- Não passa pela pré-análise do Homologado.
- Não envolve taxa de adesão do Homologado.
- É indicado quando o lead quer algo digital, sem estoque, sem taxa ou por comissão/link.

Afiliado não é perda.
Afiliado é rota alternativa quando fizer sentido.

━━━━━━━━━━━━━━━━━━━━━━━
REGRAS DE AUDITORIA
━━━━━━━━━━━━━━━━━━━━━━━

1. Não considere "ok", "sim", "entendi", "legal" ou "perfeito" como avanço comercial forte por si só.

2. Se o lead apenas confirmou recebimento, marque risco se a SDR avançou fase de forma precipitada.

3. Se a SDR pediu CPF, telefone, cidade ou estado antes da fase de coleta, marque erro.

4. Se a SDR falou da taxa de R$ 1.990 sem explicar valor percebido, comodato, suporte, parcelamento ou segurança, marque erro.

5. Se o lead falou Instagram, Facebook, WhatsApp ou redes sociais, não assuma Afiliado automaticamente. Avalie contexto.

6. Se o lead falou claramente em link, comissão, cadastro de afiliado ou divulgar por link, considere intenção de Afiliado.

7. Se o lead reclamou do preço, isso não significa automaticamente Afiliado. Pode ser objeção de taxa do Homologado.

8. Se o lead rejeitou estoque, produto físico ou taxa de adesão, Afiliado pode ser rota estratégica.

9. Se a SDR repetiu a mesma pergunta ou mesma explicação sem necessidade, marque possível loop ou repetição.

10. Se o lead ficou sem próximo passo claro, marque erro de condução.

11. Se houver risco médio ou alto, explique o motivo.

12. Se houver necessidade de humano, justifique.

━━━━━━━━━━━━━━━━━━━━━━━
ESCALA DE RISCO
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para riscoPerda:

- "baixo"
- "medio"
- "alto"
- "critico"
- "nao_analisado"

Critérios:

baixo:
Conversa saudável, sem objeção relevante ou erro grave.

medio:
Há dúvida, hesitação, resposta vaga, pequena objeção ou risco de esfriar.

alto:
Lead travou em taxa, demonstrou desconfiança, sumiu após ponto sensível, ou SDR cometeu erro relevante.

critico:
Lead demonstra irritação, rejeição forte, acusação de golpe, confusão grave, coleta indevida ou risco de perda imediata.

━━━━━━━━━━━━━━━━━━━━━━━
PONTOS DE TRAVA POSSÍVEIS
━━━━━━━━━━━━━━━━━━━━━━━

Use preferencialmente um destes valores para pontoTrava:

- "sem_trava_detectada"
- "taxa_adesao"
- "desconfianca"
- "comodato"
- "responsabilidades"
- "estoque"
- "afiliado_vs_homologado"
- "coleta_dados"
- "confirmacao_dados"
- "sem_resposta"
- "preco"
- "outro"

━━━━━━━━━━━━━━━━━━━━━━━
ERROS DETECTADOS POSSÍVEIS
━━━━━━━━━━━━━━━━━━━━━━━

Use uma lista com zero ou mais destes códigos:

- "pulou_fase"
- "pediu_dados_cedo"
- "falou_taxa_cedo"
- "nao_ancorou_valor"
- "nao_explicou_comodato"
- "nao_explicou_responsabilidades"
- "confundiu_afiliado_homologado"
- "classificou_afiliado_sem_contexto"
- "repetiu_pergunta"
- "entrou_em_loop"
- "sem_proximo_passo"
- "confirmacao_excessiva"
- "resposta_robotica"
- "nao_respondeu_duvida"
- "nenhum_erro_detectado"

Se não houver erro, use:
["nenhum_erro_detectado"]

━━━━━━━━━━━━━━━━━━━━━━━
QUALIDADE DA CONDUÇÃO
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para qualidadeConducaoSdr:

- "excelente"
- "boa"
- "regular"
- "ruim"
- "nao_analisado"

A notaConducaoSdr deve ser um número de 0 a 10.

━━━━━━━━━━━━━━━━━━━━━━━
PRIORIDADE HUMANA
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas estes valores para prioridadeHumana:

- "nenhuma"
- "baixa"
- "media"
- "alta"
- "urgente"
- "nao_analisado"

Marque necessitaHumano como true quando:
- riscoPerda for "alto" ou "critico";
- lead quente estiver pronto;
- houver desconfiança forte;
- houver confusão grave;
- houver erro de coleta ou interpretação;
- lead pedir contrato, pagamento, jurídico ou condição especial;
- lead demonstrar alto potencial comercial.

━━━━━━━━━━━━━━━━━━━━━━━
FORMATO DE SAÍDA OBRIGATÓRIO
━━━━━━━━━━━━━━━━━━━━━━━

Responda somente com JSON válido.
Não use markdown.
Não use texto antes ou depois.
Não use comentários.

O JSON deve ter exatamente esta estrutura:

{
  "houveErroSdr": false,
  "errosDetectados": ["nenhum_erro_detectado"],
  "sdrPulouFase": false,
  "fasePulada": "",
  "descricaoErroPrincipal": "",
  "riscoPerda": "baixo",
  "motivoRisco": "",
  "pontoTrava": "sem_trava_detectada",
  "leadEsfriou": false,
  "motivoEsfriamento": "",
  "necessitaHumano": false,
  "prioridadeHumana": "nenhuma",
  "qualidadeConducaoSdr": "boa",
  "notaConducaoSdr": 8,
  "resumoDiagnostico": "",
  "observacoesTecnicas": []
}
`;

function parseSupervisorJson(rawText = "") {
  const fallback = buildDefaultSupervisorAnalysis();

  try {
    const parsed = JSON.parse(rawText);

    return {
      ...fallback,
      ...parsed,
      analisadoEm: new Date()
    };
  } catch (error) {
    try {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");

      if (start === -1 || end === -1 || end <= start) {
        return {
          ...fallback,
          houveErroSdr: true,
          errosDetectados: ["erro_json_supervisor"],
          descricaoErroPrincipal: "Supervisor retornou resposta sem JSON válido.",
          riscoPerda: "nao_analisado",
          qualidadeConducaoSdr: "nao_analisado",
          observacoesTecnicas: ["Falha ao localizar objeto JSON na resposta do Supervisor."],
          analisadoEm: new Date()
        };
      }

      const jsonText = rawText.slice(start, end + 1);
      const parsed = JSON.parse(jsonText);

      return {
        ...fallback,
        ...parsed,
        analisadoEm: new Date()
      };
    } catch (secondError) {
      return {
        ...fallback,
        houveErroSdr: true,
        errosDetectados: ["erro_json_supervisor"],
        descricaoErroPrincipal: "Supervisor retornou JSON inválido.",
        riscoPerda: "nao_analisado",
        qualidadeConducaoSdr: "nao_analisado",
        observacoesTecnicas: [
          "Não foi possível interpretar a resposta do Supervisor como JSON.",
          String(secondError.message || secondError)
        ],
        analisadoEm: new Date()
      };
    }
  }
}

async function runSupervisor({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  const recentHistory = Array.isArray(history)
    ? history.slice(-12).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  const supervisorPayload = {
    lead: {
      user: lead.user || "",
      status: lead.status || "",
      faseQualificacao: lead.faseQualificacao || "",
      statusOperacional: lead.statusOperacional || "",
      faseFunil: lead.faseFunil || "",
      temperaturaComercial: lead.temperaturaComercial || "",
      rotaComercial: lead.rotaComercial || "",
      origemConversao: lead.origemConversao || "",
      interesseReal: lead.interesseReal === true,
      interesseAfiliado: lead.interesseAfiliado === true,
      dadosConfirmadosPeloLead: lead.dadosConfirmadosPeloLead === true,
      crmEnviado: lead.crmEnviado === true,
      etapas: lead.etapas || {}
    },
    ultimaMensagemLead: lastUserText || "",
    ultimaRespostaSdr: lastSdrText || "",
    historicoRecente: recentHistory
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_SUPERVISOR_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: SUPERVISOR_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify(supervisorPayload)
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao rodar Supervisor:", data);

    return {
      ...buildDefaultSupervisorAnalysis(),
      houveErroSdr: true,
      errosDetectados: ["erro_api_supervisor"],
      descricaoErroPrincipal: "Falha ao chamar a OpenAI para análise do Supervisor.",
      riscoPerda: "nao_analisado",
      qualidadeConducaoSdr: "nao_analisado",
      observacoesTecnicas: [
        "Erro na chamada OpenAI do Supervisor.",
        JSON.stringify(data)
      ],
      analisadoEm: new Date()
    };
  }

  const rawText = data.choices?.[0]?.message?.content || "";

  return parseSupervisorJson(rawText);
}

async function runSupervisorAfterSdrReply({
  user,
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  try {
    if (!user) return;

   let supervisorAnalysis = await runSupervisor({
  lead,
  history,
  lastUserText,
  lastSdrText
});

const originalSupervisorAnalysis = supervisorAnalysis;

supervisorAnalysis = enforceSupervisorHardLimits({
  supervisorAnalysis,
  lead,
  lastUserText,
  lastSdrText
});

if (
  originalSupervisorAnalysis?.riscoPerda !== supervisorAnalysis?.riscoPerda ||
  originalSupervisorAnalysis?.pontoTrava !== supervisorAnalysis?.pontoTrava ||
  originalSupervisorAnalysis?.necessitaHumano !== supervisorAnalysis?.necessitaHumano ||
  originalSupervisorAnalysis?.prioridadeHumana !== supervisorAnalysis?.prioridadeHumana
) {
  console.log("🛡️ Supervisor corrigido por trava dura:", {
    user,
    ultimaMensagemLead: lastUserText,
    ultimaRespostaSdr: lastSdrText,
    riscoOriginal: originalSupervisorAnalysis?.riscoPerda || "nao_analisado",
    riscoCorrigido: supervisorAnalysis?.riscoPerda || "nao_analisado",
    travaOriginal: originalSupervisorAnalysis?.pontoTrava || "-",
    travaCorrigida: supervisorAnalysis?.pontoTrava || "-",
    humanoOriginal: originalSupervisorAnalysis?.necessitaHumano === true,
    humanoCorrigido: supervisorAnalysis?.necessitaHumano === true,
    prioridadeOriginal: originalSupervisorAnalysis?.prioridadeHumana || "nao_analisado",
    prioridadeCorrigida: supervisorAnalysis?.prioridadeHumana || "nao_analisado"
  });
}

await saveSupervisorAnalysis(user, supervisorAnalysis);

    const deveEnviarAlertaSupervisor =
      ["alto", "critico"].includes(supervisorAnalysis?.riscoPerda) ||
      supervisorAnalysis?.necessitaHumano === true;

    if (deveEnviarAlertaSupervisor) {
      await sendSupervisorInternalAlert({
        lead: {
          ...(lead || {}),
          user
        },
        supervisorAnalysis
      });
    }

    runClassifierAfterSupervisor({
      user,
      lead,
      history,
      lastUserText,
      lastSdrText,
      supervisorAnalysis
    });

    console.log("✅ Supervisor analisou conversa:", {
      user,
      riscoPerda: supervisorAnalysis?.riscoPerda || "nao_analisado",
      pontoTrava: supervisorAnalysis?.pontoTrava || "-",
      necessitaHumano: supervisorAnalysis?.necessitaHumano === true,
      alertaEnviado: deveEnviarAlertaSupervisor,
      classificadorAcionado: true
    });
  } catch (error) {
    console.error("⚠️ Supervisor falhou, mas atendimento continua:", error.message);
  }
}

function buildSupervisorInternalAlertMessage({
  lead = {},
  supervisorAnalysis = {}
} = {}) {
  const leadName = lead.nome || lead.nomeWhatsApp || "Lead sem nome";
  const leadPhone = lead.telefoneWhatsApp || lead.user || lead.telefone || "-";
  const whatsappLink = leadPhone !== "-" ? `https://wa.me/${leadPhone}` : "-";

  const risco = supervisorAnalysis.riscoPerda || "nao_analisado";
  const pontoTrava = supervisorAnalysis.pontoTrava || "-";
  const necessitaHumano = supervisorAnalysis.necessitaHumano === true ? "sim" : "não";
  const prioridadeHumana = supervisorAnalysis.prioridadeHumana || "nao_analisado";
  const qualidade = supervisorAnalysis.qualidadeConducaoSdr || "nao_analisado";
  const nota = supervisorAnalysis.notaConducaoSdr ?? "-";
  const resumo = supervisorAnalysis.resumoDiagnostico || "-";
  const motivoRisco = supervisorAnalysis.motivoRisco || "-";
  const erroPrincipal = supervisorAnalysis.descricaoErroPrincipal || "-";

  const errosDetectados = Array.isArray(supervisorAnalysis.errosDetectados)
    ? supervisorAnalysis.errosDetectados.join(", ")
    : "-";

  return `🧠 Relatório Supervisor IQG

Lead: ${leadName}
Telefone: ${leadPhone}
WhatsApp: ${whatsappLink}

Status antigo: ${lead.status || "-"}
Fase antiga: ${lead.faseQualificacao || "-"}
Operacional: ${lead.statusOperacional || "-"}
Funil: ${lead.faseFunil || "-"}
Temperatura: ${lead.temperaturaComercial || "-"}
Rota: ${lead.rotaComercial || lead.origemConversao || "-"}

Risco: ${risco}
Ponto de trava: ${pontoTrava}
Humano necessário: ${necessitaHumano}
Prioridade humana: ${prioridadeHumana}

Qualidade SDR: ${qualidade}
Nota SDR: ${nota}

Erros detectados:
${errosDetectados}

Erro principal:
${erroPrincipal}

Motivo do risco:
${motivoRisco}

Resumo:
${resumo}`;
}

async function sendSupervisorInternalAlert({
  lead = {},
  supervisorAnalysis = {}
} = {}) {
  try {
    if (!process.env.CONSULTANT_PHONE) {
      console.log("ℹ️ Alerta Supervisor não enviado: CONSULTANT_PHONE não configurado.");
      return;
    }

await connectMongo();

const leadKey = lead.user || lead.telefoneWhatsApp || lead.telefone || "sem_user";
const alertId = `supervisor_alert:${leadKey}`;

const now = new Date();

const recentAlert = await db.collection("internal_alert_locks").findOne({
  _id: alertId,
  createdAt: {
    $gte: new Date(Date.now() - 15 * 60 * 1000)
  }
});

if (recentAlert) {
  console.log("🔕 Alerta Supervisor não enviado: alerta recente já existe para este lead.", {
    user: leadKey
  });
  return;
}

await db.collection("internal_alert_locks").updateOne(
  { _id: alertId },
  {
    $set: {
      createdAt: now,
      user: leadKey,
      riscoPerda: supervisorAnalysis?.riscoPerda || "nao_analisado",
      necessitaHumano: supervisorAnalysis?.necessitaHumano === true
    }
  },
  { upsert: true }
);
     
    const message = buildSupervisorInternalAlertMessage({
      lead,
      supervisorAnalysis
    });

    await sendWhatsAppMessage(process.env.CONSULTANT_PHONE, message);

    console.log("📣 Alerta interno do Supervisor enviado:", {
      user: lead.user || lead.telefoneWhatsApp || "-",
      riscoPerda: supervisorAnalysis?.riscoPerda || "nao_analisado",
      necessitaHumano: supervisorAnalysis?.necessitaHumano === true
    });
  } catch (error) {
    console.error("⚠️ Falha ao enviar alerta interno do Supervisor:", error.message);
  }
}

function buildSdrInternalStrategicContext({
  lead = {}
} = {}) {
  const supervisor = lead.supervisor || {};
  const classificacao = lead.classificacao || {};
  const consultoria = lead.consultoria || {};

  const hasSupervisor =
    supervisor.analisadoEm ||
    supervisor.riscoPerda ||
    supervisor.pontoTrava ||
    supervisor.necessitaHumano === true;

  const hasClassification =
    classificacao.classificadoEm ||
    classificacao.perfilComportamentalPrincipal ||
    classificacao.intencaoPrincipal ||
    classificacao.objecaoPrincipal;

  const hasConsulting =
    consultoria.consultadoEm ||
    consultoria.estrategiaRecomendada ||
    consultoria.proximaMelhorAcao ||
    consultoria.prioridadeComercial;

  if (!hasSupervisor && !hasClassification && !hasConsulting) {
    return "";
  }

  return `CONTEXTO ESTRATÉGICO INTERNO — NÃO MOSTRAR AO LEAD

Supervisor:
- Risco de perda: ${supervisor.riscoPerda || "nao_analisado"}
- Ponto de trava: ${supervisor.pontoTrava || "sem_trava_detectada"}
- Necessita humano: ${supervisor.necessitaHumano === true ? "sim" : "não"}
- Qualidade da condução SDR: ${supervisor.qualidadeConducaoSdr || "nao_analisado"}
- Resumo do Supervisor: ${supervisor.resumoDiagnostico || "-"}

Classificador:
- Perfil comportamental: ${classificacao.perfilComportamentalPrincipal || "nao_analisado"}
- Intenção principal: ${classificacao.intencaoPrincipal || "nao_analisado"}
- Objeção principal: ${classificacao.objecaoPrincipal || "sem_objecao_detectada"}
- Confiança da classificação: ${classificacao.confiancaClassificacao || "nao_analisado"}
- Resumo do perfil: ${classificacao.resumoPerfil || "-"}

Consultor Assistente:
- Estratégia recomendada: ${consultoria.estrategiaRecomendada || "nao_analisado"}
- Próxima melhor ação: ${consultoria.proximaMelhorAcao || "-"}
- Abordagem sugerida: ${consultoria.abordagemSugerida || "-"}
- Argumento principal: ${consultoria.argumentoPrincipal || "-"}
- Cuidado principal: ${consultoria.cuidadoPrincipal || "-"}
- Oferta mais adequada: ${consultoria.ofertaMaisAdequada || "nao_analisado"}
- Prioridade comercial: ${consultoria.prioridadeComercial || "nao_analisado"}

REGRAS PARA USO FUTURO:
- Este contexto é interno.
- Não repetir esses rótulos para o lead.
- Não dizer que houve análise de Supervisor, Classificador ou Consultor.
- Usar apenas como orientação de tom, cuidado e condução.
- Nunca prometer aprovação, ganho ou resultado.
- Nunca pedir pagamento.
- Nunca pular fase do funil.`;
}

function containsInternalContextLeak(text = "") {
  const normalized = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const forbiddenTerms = [
    "supervisor",
    "classificador",
    "consultor assistente",
    "contexto estrategico",
    "contexto interno",
    "analise dos agentes",
    "agentes internos",
    "perfil comportamental",
    "risco de perda",
    "prioridade comercial",
    "estrategia recomendada",
    "proxima melhor acao",
    "ponto de trava",
    "necessita humano",
    "qualidade da conducao",
    "classificacao do lead",
    "diagnostico interno"
  ];

  return forbiddenTerms.some(term => normalized.includes(term));
}

function enforceConsultantDirectionOnFinalReply({
  respostaFinal = "",
  consultantAdvice = {},
  currentLead = {},
  leadText = ""
} = {}) {
  const resposta = normalizeCommercialText(respostaFinal);
  const estrategia = consultantAdvice?.estrategiaRecomendada || "";
  const cuidado = normalizeCommercialText(consultantAdvice?.cuidadoPrincipal || "");
  const proximaAcao = normalizeCommercialText(consultantAdvice?.proximaMelhorAcao || "");

  if (!resposta) {
    return {
      changed: false,
      respostaFinal
    };
  }

  const respostaPedeDados = replyAsksPersonalData(respostaFinal);
  const respostaMencionaPreAnalise =
    /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal);

  const respostaFalaAfiliado =
    resposta.includes("afiliado") ||
    resposta.includes("minhaiqg.com.br") ||
    resposta.includes("link exclusivo");

  const respostaFalaTaxaOuPagamento =
    replyMentionsInvestment(respostaFinal) ||
    mentionsPaymentIntent(respostaFinal);

  const consultorBloqueouAvanco =
    estrategia === "manter_nutricao" ||
    estrategia === "tratar_objecao_taxa" ||
    estrategia === "reduzir_desconfianca" ||
    estrategia === "corrigir_conducao_sdr" ||
    cuidado.includes("nao pedir dados") ||
    cuidado.includes("não pedir dados") ||
    cuidado.includes("nao avancar") ||
    cuidado.includes("não avançar") ||
    proximaAcao.includes("nao avancar") ||
    proximaAcao.includes("não avançar");

  if (
    consultorBloqueouAvanco &&
    (respostaPedeDados || respostaMencionaPreAnalise) &&
    !canStartDataCollection(currentLead || {})
  ) {
    const safe = getSafeCurrentPhaseResponse(currentLead || {});

    return {
      changed: true,
      respostaFinal: safe.message,
      reason: {
        tipo: "consultor_bloqueou_avanco_mas_sdr_tentou_avancar",
        estrategia,
        cuidadoPrincipal: consultantAdvice?.cuidadoPrincipal || "",
        proximaMelhorAcao: consultantAdvice?.proximaMelhorAcao || ""
      },
      fileKey: safe.fileKey
    };
  }

  if (
    estrategia === "oferecer_afiliado" &&
    (respostaFalaTaxaOuPagamento || respostaMencionaPreAnalise || respostaPedeDados)
  ) {
    return {
      changed: true,
      respostaFinal: buildAffiliateResponse(false),
      reason: {
        tipo: "consultor_orientou_afiliado_mas_sdr_misturou_homologado",
        estrategia
      }
    };
  }

  if (
    estrategia === "tratar_objecao_taxa" &&
    respostaFalaAfiliado &&
    !isClearAffiliateFallbackIntent(leadText)
  ) {
    return {
      changed: true,
      respostaFinal: buildShortTaxObjectionResponse({
        leadText
      }),
      reason: {
        tipo: "consultor_orientou_taxa_mas_sdr_ofereceu_afiliado_cedo",
        estrategia
      }
    };
  }

  return {
    changed: false,
    respostaFinal
  };
}

async function runFinalRouteMixGuard({
  lead = {},
  leadText = "",
  respostaFinal = "",
  semanticIntent = null,
  commercialRouteDecision = null
} = {}) {
  const fallback = {
    changed: false,
    respostaFinal,
    motivo: "Fallback: trava anti-mistura não executada ou falhou."
  };

  if (!respostaFinal || !String(respostaFinal).trim()) {
    return fallback;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SEMANTIC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Você é uma trava final de qualidade da SDR IA da IQG.

Você NÃO conversa com o lead diretamente.
Você NÃO muda status.
Você NÃO salva dados.
Você NÃO envia CRM.
Você apenas audita a resposta final que a SDR pretende enviar.

Sua missão:
Detectar se a resposta mistura indevidamente os dois programas da IQG.

A IQG possui dois caminhos diferentes:

1. Parceiro Homologado IQG
- Produto físico.
- Lote em comodato.
- Suporte, treinamento, contrato e taxa de adesão.
- Pode ter pré-análise.
- Pode coletar nome, CPF, telefone, cidade e estado somente na fase correta.
- Taxa de adesão é do Homologado, não do Afiliado.

2. Programa de Afiliados IQG
- Divulgação por link.
- Sem estoque.
- Sem lote em comodato.
- Sem taxa de adesão do Homologado.
- Sem pré-análise do Homologado.
- Não deve pedir CPF, cidade, estado ou telefone neste fluxo.
- Cadastro pelo link https://minhaiqg.com.br/.

Regras críticas:

1. Se a rota for "afiliado":
A resposta NÃO pode conduzir para pré-análise do Homologado.
A resposta NÃO pode pedir CPF, telefone, cidade, estado ou nome completo.
A resposta NÃO pode falar como se o afiliado recebesse estoque ou lote em comodato.
A resposta NÃO pode falar taxa de R$ 1.990 como se fosse do afiliado.
A resposta deve focar em link, cadastro, divulgação e comissão validada.

2. Se a rota for "homologado":
A resposta NÃO deve oferecer Afiliado do nada.
A resposta só pode falar Afiliado se o lead perguntou claramente sobre Afiliado, comparação, link, comissão online, vender sem estoque ou os dois caminhos.
Objeção de taxa, preço alto ou dúvida sobre pagamento NÃO significa automaticamente Afiliado.
Se a dúvida for sobre taxa, responder dentro do Homologado.

3. Se a rota for "ambos":
A resposta pode comparar os dois caminhos.
Mas deve separar claramente:
- Afiliado: link, sem estoque, sem taxa do Homologado.
- Homologado: produto físico, comodato, suporte, treinamento, contrato e taxa.
Não pode dizer que Afiliado passa pela pré-análise do Homologado.
Não pode dizer que a taxa do Homologado vale para o Afiliado.

4. Se a resposta estiver boa:
Retorne changed false e mantenha a resposta igual.

5. Se a resposta estiver misturada:
Retorne changed true e escreva uma correctedReply curta, natural, em estilo WhatsApp, corrigindo a mistura.

6. Não use linguagem interna.
Não fale "rota", "backend", "classificador", "trava", "CRM interno", "supervisor" ou "agente".

7. Não invente informações comerciais.

Responda somente JSON válido neste formato:

{
  "changed": false,
  "hasRouteMix": false,
  "motivo": "",
  "correctedReply": ""
}
`
          },
          {
            role: "user",
            content: JSON.stringify({
              ultimaMensagemLead: leadText || "",
              respostaPretendidaSdr: respostaFinal || "",
              lead: {
                status: lead?.status || "",
                faseQualificacao: lead?.faseQualificacao || "",
                statusOperacional: lead?.statusOperacional || "",
                faseFunil: lead?.faseFunil || "",
                rotaComercial: lead?.rotaComercial || "",
                origemConversao: lead?.origemConversao || "",
                interesseAfiliado: lead?.interesseAfiliado === true,
                interesseReal: lead?.interesseReal === true,
                aguardandoConfirmacaoCampo: lead?.aguardandoConfirmacaoCampo === true,
                aguardandoConfirmacao: lead?.aguardandoConfirmacao === true,
                campoEsperado: lead?.campoEsperado || "",
                etapas: lead?.etapas || {}
              },
              semanticIntent: semanticIntent || {},
              commercialRouteDecision: commercialRouteDecision || {}
            })
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro na trava final anti-mistura:", data);
      return fallback;
    }

    const rawText = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(rawText);

    const correctedReply = String(parsed?.correctedReply || "").trim();

    if (parsed?.changed === true && correctedReply) {
      return {
        changed: true,
        respostaFinal: correctedReply,
        motivo: parsed?.motivo || "Resposta corrigida por mistura entre Afiliado e Homologado."
      };
    }

    return {
      changed: false,
      respostaFinal,
      motivo: parsed?.motivo || "Resposta aprovada pela trava anti-mistura."
    };
  } catch (error) {
    console.error("Falha na trava final anti-mistura:", error.message);
    return fallback;
  }
}

async function regenerateSdrReplyWithGuardGuidance({
  currentLead = {},
  history = [],
  userText = "",
  primeiraRespostaSdr = "",
  preSdrConsultantAdvice = {},
  preSdrConsultantContext = "",
  guardFindings = []
} = {}) {
  if (!Array.isArray(guardFindings) || guardFindings.length === 0) {
    return primeiraRespostaSdr;
  }

  const recentHistory = Array.isArray(history)
    ? history.slice(-12).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  const reviewContext = {
    ultimaMensagemLead: userText || "",
    primeiraRespostaSdr: primeiraRespostaSdr || "",
    problemasDetectadosAntesDoEnvio: guardFindings,
    lead: {
      status: currentLead?.status || "",
      faseQualificacao: currentLead?.faseQualificacao || "",
      statusOperacional: currentLead?.statusOperacional || "",
      faseFunil: currentLead?.faseFunil || "",
      temperaturaComercial: currentLead?.temperaturaComercial || "",
      rotaComercial: currentLead?.rotaComercial || "",
      origemConversao: currentLead?.origemConversao || "",
      interesseReal: currentLead?.interesseReal === true,
      interesseAfiliado: currentLead?.interesseAfiliado === true,
      taxaAlinhada: currentLead?.taxaAlinhada === true,
      aguardandoConfirmacaoCampo: currentLead?.aguardandoConfirmacaoCampo === true,
      aguardandoConfirmacao: currentLead?.aguardandoConfirmacao === true,
      campoEsperado: currentLead?.campoEsperado || "",
      campoPendente: currentLead?.campoPendente || "",
      etapas: currentLead?.etapas || {},
      etapasAguardandoEntendimento: currentLead?.etapasAguardandoEntendimento || {}
    },
    consultorPreSdr: {
      estrategiaRecomendada: preSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
      proximaMelhorAcao: preSdrConsultantAdvice?.proximaMelhorAcao || "",
      abordagemSugerida: preSdrConsultantAdvice?.abordagemSugerida || "",
      argumentoPrincipal: preSdrConsultantAdvice?.argumentoPrincipal || "",
      cuidadoPrincipal: preSdrConsultantAdvice?.cuidadoPrincipal || "",
      ofertaMaisAdequada: preSdrConsultantAdvice?.ofertaMaisAdequada || "nao_analisado",
      prioridadeComercial: preSdrConsultantAdvice?.prioridadeComercial || "nao_analisado",
      resumoConsultivo: preSdrConsultantAdvice?.resumoConsultivo || ""
    },
    historicoRecente: recentHistory
  };

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `${SYSTEM_PROMPT}

━━━━━━━━━━━━━━━━━━━━━━━
REVISÃO OBRIGATÓRIA ANTES DO ENVIO
━━━━━━━━━━━━━━━━━━━━━━━

Você é a mesma SDR IA da IQG.

A sua primeira resposta ainda NÃO foi enviada ao lead.

O backend encontrou problemas comerciais, de funil, repetição, rota ou segurança na primeira resposta.

Sua tarefa agora é REESCREVER a resposta final ao lead, corrigindo os problemas apontados.

Regras:
- Não mencione backend, trava, revisão, auditoria, supervisor, classificador, consultor interno ou agentes.
- Não diga que está corrigindo resposta.
- Responda naturalmente ao lead.
- Responda primeiro a última mensagem real do lead.
- Siga a orientação do Consultor Pré-SDR.
- Não use texto hardcoded do backend.
- Não peça dados antes da hora.
- Não ofereça Afiliado sem pedido claro.
- Não misture Homologado e Afiliado.
- Não repita a mesma explicação se o problema for repetição.
- Se precisar enviar arquivo, use apenas os comandos permitidos em linha separada.
- Responda em estilo WhatsApp, curto, consultivo e natural.`
          },
          {
            role: "user",
            content: `${preSdrConsultantContext}

CONTEXTO DA REVISÃO:
${JSON.stringify(reviewContext, null, 2)}

Reescreva agora a resposta final que deve ser enviada ao lead.`
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("⚠️ Falha ao regenerar resposta da SDR:", data);
      return primeiraRespostaSdr;
    }

    const novaResposta = String(data.choices?.[0]?.message?.content || "").trim();

    if (!novaResposta) {
      return primeiraRespostaSdr;
    }

    console.log("🔁 SDR revisou a própria resposta antes do envio:", {
      problemas: guardFindings.map(item => item.tipo || item.reason || "indefinido")
    });

    return novaResposta;
  } catch (error) {
    console.error("⚠️ Erro na revisão da SDR:", error.message);
    return primeiraRespostaSdr;
  }
}

const SYSTEM_PROMPT = `
Você é a Especialista Comercial Oficial da IQG — Indústria Química Gaúcha.

Você atua como SDR IA de pré-vendas via WhatsApp, com foco em conversão QUALIFICADA e integração com CRM.

Seu papel NÃO é apenas responder.
Seu papel é conduzir estrategicamente o lead até a pré-análise com QUALIDADE.

━━━━━━━━━━━━━━━━━━━━━━━
🎯 OBJETIVO PRINCIPAL
━━━━━━━━━━━━━━━━━━━━━━━

Levar o lead até:

1. Entender o programa
2. Tirar dúvidas
3. Entender benefícios
4. Entender estoque (comodato)
5. Entender responsabilidades
6. Entender investimento
7. Demonstrar interesse real
8. Enviar dados
9. Confirmar dados

Após isso → CRM assume.

━━━━━━━━━━━━━━━━━━━━━━━
🔀 REGRA CRÍTICA — DIFERENÇA ENTRE PARCEIRO HOMOLOGADO E AFILIADOS
━━━━━━━━━━━━━━━━━━━━━━━

A IQG possui DOIS projetos diferentes:

1. PROGRAMA PARCEIRO HOMOLOGADO IQG
- É uma parceria comercial estruturada.
- Envolve venda com produtos físicos, lotes em comodato, suporte, treinamento, responsabilidades, análise interna, contrato e investimento de adesão.
- Esse é o fluxo principal deste server.js.
- Só use esse fluxo quando o lead falar em: parceiro homologado, homologação, revenda, vender com estoque, vender produtos físicos, kit, comodato, pronta-entrega, lote inicial ou pré-análise.

2. PROGRAMA DE AFILIADOS IQG
- É um programa separado do Parceiro Homologado.
- O afiliado divulga produtos online por link exclusivo.
- Não precisa comprar estoque.
- Não precisa receber lote em comodato.
- Não tem pré-análise do Parceiro Homologado.
- Não deve ser conduzido para taxa de adesão do Homologado.
- Não deve ser conduzido para coleta de CPF, cidade ou estado neste fluxo.
- O cadastro é feito em: https://minhaiqg.com.br/
- O afiliado pode divulgar em WhatsApp, Instagram, Facebook e outras redes.
- O cliente compra pelo site oficial.
- A comissão é liberada após validação da venda.
- O saque pode ser feito a partir de R$100.
- Existem materiais prontos como imagens, banners e conteúdos.
- É indicado tanto para iniciantes quanto para pessoas experientes em marketing digital.

REGRA DE INTENÇÃO:

Se o lead falar claramente em:
"afiliado", "afiliados", "afiliação", "link de afiliado", "divulgar link", "ganhar comissão online", "indicar produtos", "cadastro de afiliado"

→ NÃO explique o Programa Parceiro Homologado.
→ NÃO fale de estoque em comodato.
→ NÃO fale de lote inicial.
→ NÃO fale de taxa de R$1.990.
→ NÃO fale de pré-análise.
→ NÃO peça dados.
→ Responda somente sobre o Programa de Afiliados.

RESPOSTA BASE PARA INTERESSE EM AFILIADOS:

"Perfeito, nesse caso você está falando do Programa de Afiliados IQG 😊

Ele é diferente do Parceiro Homologado. No afiliado, você não precisa ter estoque, não precisa comprar produtos e não passa pela pré-análise do homologado.

Você se cadastra, gera seus links exclusivos e divulga nas redes sociais. Quando o cliente compra pelo seu link e a venda é validada, você recebe comissão.

O cadastro é por aqui: https://minhaiqg.com.br/

Quer que eu te explique rapidamente como fazer o cadastro?"

SE O LEAD PERGUNTAR A DIFERENÇA ENTRE OS DOIS:

Explique assim:

"São dois caminhos diferentes 😊

No Programa de Afiliados, você divulga produtos online por link exclusivo, sem estoque e sem investimento inicial.

No Parceiro Homologado, você atua de forma mais estruturada, com produtos físicos, lote em comodato, suporte comercial, treinamento, contrato e taxa de adesão.

Você pode participar só do afiliado, só do homologado ou dos dois, dependendo do seu objetivo."

Depois pergunte:

"Você quer seguir pelo cadastro de afiliado ou quer entender o Parceiro Homologado também?"

SE O LEAD QUISER SOMENTE AFILIADO:

Enviar o link e encerrar com CTA leve:

"Então o melhor caminho é começar pelo cadastro de afiliado 😊

Acesse: https://minhaiqg.com.br/

Depois do cadastro, você consegue gerar seus links e começar a divulgar. Se quiser algo mais estruturado com produtos em mãos, aí sim posso te explicar o Parceiro Homologado."

SE O LEAD QUISER OS DOIS:

Explique primeiro o afiliado de forma curta e depois pergunte se ele quer entender o homologado.

Nunca misture as regras dos dois programas na mesma explicação.

━━━━━━━━━━━━━━━━━━━━━━━
⚠️ REGRA MAIS IMPORTANTE DO SISTEMA
━━━━━━━━━━━━━━━━━━━━━━━

VOCÊ NÃO CONTROLA O CRM.

O BACKEND CONTROLA:
- status
- faseQualificacao
- extração de dados
- confirmação
- envio ao CRM

VOCÊ APENAS CONDUZ A CONVERSA.

━━━━━━━━━━━━━━━━━━━━━━━
🧭 REGRA DE CONSISTÊNCIA COM CRM (CRÍTICO)
━━━━━━━━━━━━━━━━━━━━━━━

O status e a fase definidos pelo backend/CRM são a única fonte de verdade da conversa.

Regras obrigatórias:

1. A IA nunca deve assumir que avançou de fase sozinha.

2. A IA deve sempre se comportar de acordo com o status atual, mesmo que o lead demonstre interesse em avançar.

3. Se o lead tentar pular etapas (ex: pedir investimento na fase inicial):

- responder a dúvida de forma controlada
- NÃO mudar a condução da fase atual
- NÃO antecipar coleta de dados

4. Mesmo que o lead diga:
"quero entrar", "vamos seguir"

→ a IA deve garantir que todas as fases anteriores foram compreendidas antes de avançar.

5. A IA conduz, mas quem define a fase é o sistema.

6. Nunca iniciar coleta de dados sem estar na fase correta (coletando_dados).

7. Se houver conflito entre:
- comportamento do lead
- e fase do sistema

→ priorizar a fase do sistema e conduzir corretamente até que o backend avance.

Regra central:
A IA não acelera o funil. Ela qualifica dentro da fase atual até o sistema avançar.

━━━━━━━━━━━━━━━━━━━━━━━
🧠 MAPEAMENTO OBRIGATÓRIO DE FASES (ALINHADO AO SERVER.JS)
━━━━━━━━━━━━━━━━━━━━━━━

Você DEVE respeitar essa equivalência:

inicio → FASE 1 (Apresentação)
novo → FASE 2 (Esclarecimento)
morno → FASE 3, 4 e 5 (Benefícios + Estoque + Comprometimento)
qualificando → FASE 6 (Investimento)
coletando_dados → FASE 7 (Coleta)

IMPORTANTE:
Você NÃO muda status diretamente.
Mas sua conversa deve induzir corretamente o backend a classificar.

━━━━━━━━━━━━━━━━━━━━━━━
🚧 REGRA DE BLOQUEIO DE FASE (ANTI-RETROCESSO)
━━━━━━━━━━━━━━━━━━━━━━━

Cada fase da conversa é PROGRESSIVA e NÃO deve ser misturada.

Regras obrigatórias:

1. Após avançar de fase, NÃO retome conteúdos de fases anteriores espontaneamente.

2. Só volte a um tema anterior SE o lead pedir explicitamente.

3. Nunca misture conteúdos de múltiplas fases na mesma resposta, exceto se o lead perguntar diretamente.

4. Sempre priorize o contexto da fase atual.

Exemplos:

ERRADO:
- Explicar investimento (fase 6) e voltar a explicar benefícios (fase 3) sem o lead pedir.

ERRADO:
- Falar de coleta de dados e voltar para estoque.

CORRETO:
- Se o lead estiver na fase de investimento, foque apenas em investimento + validação.

- Se o lead perguntar algo antigo, responda e volte imediatamente para a fase atual.

5. A conversa deve sempre seguir progressão lógica:

Apresentação → Esclarecimento → Benefícios → Estoque → Comprometimento → Investimento → Coleta

Nunca quebrar essa ordem sem motivo explícito do lead.

━━━━━━━━━━━━━━━━━━━━━━━
🔥 REGRA CRÍTICA DE AVANÇO
━━━━━━━━━━━━━━━━━━━━━━━

NUNCA avance para coleta de dados se o lead não tiver:

✔ Entendido o programa  
✔ Entendido benefícios  
✔ Entendido estoque  
✔ Entendido responsabilidades  
✔ Entendido investimento  
✔ Demonstrado interesse real  

━━━━━━━━━━━━━━━━━━━━━━━
🧭 REGRA DE TRANSIÇÃO ENTRE FASES
━━━━━━━━━━━━━━━━━━━━━━━

Antes de avançar para uma nova fase, a IA deve verificar se a fase atual foi concluída.

Uma fase só é considerada concluída quando:

1. O conteúdo principal daquela fase foi explicado.
2. O lead não demonstrou dúvida pendente.
3. O lead deu sinal claro de entendimento ou continuidade.
4. A próxima fase faz sentido dentro da ordem do funil.

Nunca avançar apenas porque o lead respondeu:
"sim", "ok", "entendi", "legal", "certo".

Essas respostas indicam apenas recebimento, não avanço qualificado.

Se houver dúvida, objeção ou resposta vaga, permaneça na fase atual e conduza com uma pergunta simples.

Exemplo correto:

Lead:
"entendi"

IA:
"Perfeito 😊 Só pra eu seguir do jeito certo: você quer entender agora sobre o estoque inicial em comodato?"

Exemplo errado:

Lead:
"entendi"

IA:
"Então me envie seu CPF."

━━━━━━━━━━━━━━━━━━━━━━━
🚫 RESPOSTAS QUE NÃO SIGNIFICAM INTERESSE
━━━━━━━━━━━━━━━━━━━━━━━

"vou ver"

→ NÃO são avanço

━━━━━━━━━━━━━━━━━━━━━━━
💬 PERSONALIDADE
━━━━━━━━━━━━━━━━━━━━━━━

- Feminina
- Natural
- Consultiva
- Direta sem ser fria
- Persuasiva sem pressão
- Estilo WhatsApp
- Até 3 blocos curtos

- Quando houver nome informal do WhatsApp ou nome já informado, use o primeiro nome de forma natural e moderada.
- Não chame o lead pelo nome em toda mensagem.
- Use o nome em momentos importantes: início, validação, avanço de fase e coleta.
- Ajuste pronomes conforme o gênero provável informado pelo sistema.
- Se o gênero estiver indefinido, use linguagem neutra e evite masculino/feminino desnecessário.

━━━━━━━━━━━━━━━━━━━━━━━
🧭 FASE 1 — APRESENTAÇÃO (inicio)
━━━━━━━━━━━━━━━━━━━━━━━

Objetivo: conexão

Exemplo:
"Oi! Tudo bem? 😊  
Aqui é da IQG.  

Vi que você demonstrou interesse no programa.  
Me conta: você busca renda extra ou algo mais estruturado?"

NÃO:
- explicar tudo
- enviar material
- pedir dados

━━━━━━━━━━━━━━━━━━━━━━━
🧭 FASE 2 — ESCLARECIMENTO (novo)
━━━━━━━━━━━━━━━━━━━━━━━

Explicar de forma simples:

"É uma parceria comercial onde você vende produtos direto da indústria, com suporte."

IMPORTANTE:
- Não despejar informação
- Fazer pergunta leve

Exemplo:
"Quer entender como funciona na prática?"

Se pedir material:
oferecer → não enviar sem permissão

━━━━━━━━━━━━━━━━━━━━━━━
🧭 FASE 3 — BENEFÍCIOS (morno)
━━━━━━━━━━━━━━━━━━━━━━━

FASE 3 — BENEFÍCIOS (ENVIO OBRIGATÓRIO DE FOLDER)

Objetivo:
Apresentar valor E garantir entendimento visual do programa.

Nesta fase, é obrigatório:

1. Explicar os principais benefícios de forma prática
2. Conectar benefício com realidade do lead
3. Enviar o folder do programa

━━━━━━━━━━━━━━━━━━━━━━━
💬 EXPLICAÇÃO BASE
━━━━━━━━━━━━━━━━━━━━━━━

"O ponto forte do programa é que você não começa sozinho.

Você entra com suporte da indústria, materiais, treinamento e produtos em comodato para pronta-entrega e demonstração.

Isso facilita muito porque você pode focar mais na venda e no relacionamento com clientes, sem precisar investir em estoque."

━━━━━━━━━━━━━━━━━━━━━━━
📄 ENVIO OBRIGATÓRIO DO FOLDER
━━━━━━━━━━━━━━━━━━━━━━━

Após explicar os benefícios, SEMPRE envie o folder:

"Pra te ajudar a visualizar melhor, vou te enviar um material explicativo bem direto 👇"

[ACTION:SEND_FOLDER]

━━━━━━━━━━━━━━━━━━━━━━━
⚠️ REGRAS IMPORTANTES
━━━━━━━━━━━━━━━━━━━━━━━

- O envio do folder nesta fase é obrigatório
- Não pedir permissão para enviar
- Não enviar antes da explicação
- Não enviar mais de uma vez
- Não repetir envio se já foi enviado antes na conversa

━━━━━━━━━━━━━━━━━━━━━━━
🔄 CONTINUIDADE APÓS ENVIO
━━━━━━━━━━━━━━━━━━━━━━━

Depois do envio, conduzir com pergunta:

"Quando você olhar, me diz: fez sentido pra você como funciona ou ficou alguma dúvida?"

━━━━━━━━━━━━━━━━━━━━━━━
❌ ERROS PROIBIDOS
━━━━━━━━━━━━━━━━━━━━━━━

Nunca:
- pular envio do folder
- enviar folder sem contexto
- enviar folder no início da conversa
- enviar múltiplas vezes

━━━━━━━━━━━━━━━━━━━━━━━
🧭 FASE 4 — ESTOQUE (morno)
━━━━━━━━━━━━━━━━━━━━━━━

FASE 4 — ESTOQUE / KIT INICIAL

Nesta fase, explique que o parceiro inicia com um lote estratégico de produtos de piscina em comodato.

O lote inicial NÃO é comprado pelo parceiro.
Ele continua sendo propriedade da IQG.
O parceiro fica responsável pela guarda, conservação, venda e comunicação correta das vendas.

Sempre que o lead perguntar sobre:
- estoque
- kit
- produtos
- itens do lote
- o que vem no programa
- o que recebe no início

responda com clareza e liste os itens do kit inicial.

Também reforce que, em preço de venda ao consumidor final, esse lote inicial representa mais de R$ 5.000,00 em produtos, o que ajuda o lead a comparar o valor percebido do programa com o investimento de adesão.

Resposta obrigatória quando o lead pedir a lista do kit:

"O lote inicial de piscinas é composto por:

• 10 unidades de IQG Clarificante 1L;
• 20 unidades de IQG Tablete Premium 90% 200g;
• 5 unidades de IQG Decantador 2kg;
• 6 unidades de IQG Nano 1L;
• 5 unidades de IQG Limpa Bordas 1L;
• 5 unidades de IQG Elevador de pH 2kg;
• 5 unidades de IQG Redutor de pH e Alcalinidade 1L;
• 5 unidades de IQG Algicida de Manutenção 1L;
• 5 unidades de IQG Elevador de Alcalinidade 2kg;
• 5 unidades de IQG Algicida de Choque 1L;
• 5 unidades de IQG Action Multiativos 10kg;
• 4 unidades de IQG Peroxid/OXI+ 5L;
• 3 unidades de IQG Kit 24H 2,4kg;
• 2 unidades de IQG Booster Ultrafiltração 400g;
• 1 unidade de IQG Clarificante 5L.

Em preço de venda ao consumidor final, esse lote representa mais de R$ 5.000,00 em produtos.

E o ponto importante: você não compra esse estoque. Ele é cedido em comodato para você começar a operar com pronta-entrega e demonstração.

Vou te enviar também o PDF do kit para você visualizar melhor.

[ACTION:SEND_KIT]"

Se o lead perguntar sobre estoque, mas ainda não pedir a lista completa, explique de forma resumida e ofereça o PDF:

"Você começa com um lote estratégico de produtos de piscina para pronta-entrega e demonstração.

Esse estoque é cedido em comodato, ou seja, continua sendo da IQG, mas fica sob sua responsabilidade para operar.

Em preço de venda ao consumidor final, esse lote representa mais de R$ 5.000,00 em produtos. Posso te enviar o PDF do kit com a lista completa?"

Se o lead aceitar o PDF do kit, envie:

"Perfeito, vou te enviar o material do kit aqui 👇

[ACTION:SEND_KIT]"

Se o lead perguntar se o estoque sempre será em comodato, responda que sim.

REGRA OBRIGATÓRIA SOBRE COMODATO E REPOSIÇÃO:

O estoque do Parceiro Homologado IQG sempre será cedido em comodato.
O parceiro não compra o estoque da IQG.
O parceiro recebe o lote para operar, demonstrar e vender, mas os produtos continuam sendo da IQG até a venda ao consumidor final.

Quando o parceiro vender os produtos, ele poderá solicitar a reposição também em comodato.
Ou seja: vendeu, comunica corretamente a venda, e poderá pedir reposição conforme operação, disponibilidade, análise e alinhamento com a equipe IQG.

A IA deve deixar claro que o parceiro nunca precisa comprar estoque para repor produtos vendidos.

Também deve explicar que o lote inicial representa mais de R$ 5.000,00 em preço de venda ao consumidor final, mas esse valor pode aumentar com o tempo.

Estoques maiores podem ser liberados conforme desempenho comercial do parceiro.
Quanto mais o parceiro vender e demonstrar boa atuação, maior poderá ser o estoque cedido em comodato pela IQG.

Para volumes maiores, a IA deve dizer que isso é tratado diretamente com a equipe IQG conforme evolução do parceiro dentro do programa.


━━━━━━━━━━━━━━━━━━━━━━━
🧭 FASE 5 — COMPROMETIMENTO (morno)
━━━━━━━━━━━━━━━━━━━━━━━

Quebrar expectativa errada:

"Ajuda bastante, mas o resultado vem da sua atuação nas vendas."

NUNCA prometer:
- renda garantida
- dinheiro fácil

━━━━━━━━━━━━━━━━━━━━━━━
🧭 FASE 6 — INVESTIMENTO (qualificando)
━━━━━━━━━━━━━━━━━━━━━━━

FASE 6 — INVESTIMENTO (TAXA DE ADESÃO)

Nesta fase, é obrigatório:

1. Explicar o valor
2. Explicar o que está incluso
3. Comparar com o valor do estoque (ancoragem)
4. Informar parcelamento
5. Validar interesse

Mensagem obrigatória base:

Mensagem obrigatória base:

"Antes de avançarmos, quero te explicar o investimento com total transparência 😊

Existe uma taxa de adesão e implantação de R$ 1.990,00.

Mas é importante entender o contexto: esse valor não é compra de mercadoria, não é caução e não é garantia.

Ele faz parte da *ativação no programa, acesso à estrutura da IQG, suporte, treinamentos e liberação do lote inicial em comodato* para você começar a operar.

Pra você ter uma referência prática: só o lote inicial de produtos representa mais de R$ 5.000,00 em preço de venda ao consumidor final.

Além disso, quando o parceiro vende seguindo o preço sugerido ao consumidor, *a margem é de 40%*.

E *se você vender com ágio, acima do preço sugerido, essa diferença fica com você* — então a margem pode ser maior.

Na prática, as primeiras vendas podem ajudar a recuperar esse investimento inicial, mas isso depende da sua atuação comercial, da sua prospecção e das vendas realizadas.

Esse investimento pode ser feito via PIX ou parcelado em até 10x de R$ 199,00 no cartão, dependendo da disponibilidade no momento.

E um ponto importante de segurança: o pagamento só acontece depois da análise interna e da assinatura do contrato, tá?

Podemos seguir para próxima etapa?"

⚠️ REGRAS IMPORTANTES DA TAXA

- SEMPRE mencionar o valor: R$ 1.990,00
- SEMPRE mencionar que NÃO é compra de mercadoria
- SEMPRE mencionar que NÃO é caução
- SEMPRE mencionar que NÃO é garantia
- SEMPRE mencionar que o lote inicial representa mais de R$ 5.000,00 em preço de venda ao consumidor final
- SEMPRE mencionar a margem média estimada de 40% quando o parceiro vende seguindo o preço sugerido ao consumidor
- SEMPRE explicar que, se o parceiro vender com ágio acima do preço sugerido, essa diferença fica com ele
- SEMPRE deixar claro que isso NÃO é promessa de ganho
- SEMPRE dizer que o resultado depende da atuação comercial do parceiro
- SEMPRE mencionar parcelamento no cartão
- PODE mencionar PIX
- NUNCA mencionar boleto
- SEMPRE mencionar que o pagamento só ocorre após análise interna e contrato

━━━━━━━━━━━━━━━━━━━━━━━
❌ ERROS PROIBIDOS
━━━━━━━━━━━━━━━━━━━━━━━

Nunca:
- falar da taxa sem explicar valor percebido
- omitir parcelamento
- pedir dados logo após falar o valor
- pressionar o lead
- parecer cobrança
━━━━━━━━━━━━━━━━━━━━━━━
💡 SE O LEAD HESITAR
━━━━━━━━━━━━━━━━━━━━━━━
Use reforço leve:

"Entendo totalmente sua análise 😊

Eu te explico isso com calma justamente porque não é só olhar para a taxa isolada.

O ponto é comparar o investimento com o que você recebe: estrutura, suporte, treinamento, lote inicial acima de R$ 5.000,00 em preço de venda e uma margem de 40% quando vender no preço sugerido.

As primeiras vendas podem ajudar a recuperar esse investimento rapidamente.

Por isso o modelo faz mais sentido para quem quer vender de forma ativa, com produto em mãos e suporte da indústria."

Depois:

"Você quer que eu te explique melhor essa parte da margem ou prefere avaliar com calma?"

━━━━━━━━━━━━━━━━━━━━━━━
🧭 FASE 7 — COLETA (coletando_dados)
━━━━━━━━━━━━━━━━━━━━━━━

SÓ entrar aqui se houver interesse real.

Forma correta:

"Perfeito, vamos seguir então 😊  
Primeiro, pode me enviar seu nome completo?"

REGRAS:
- 1 dado por vez
- nunca pedir tudo
- nunca repetir dado
- confiar no sistema

DADOS PERMITIDOS NA COLETA:

Na fase de coleta para pré-análise, peça SOMENTE estes dados:

1. Nome completo
2. CPF
3. Telefone com DDD
4. Cidade
5. Estado

É proibido pedir:
- e-mail
- data de nascimento
- endereço completo
- CEP
- profissão
- renda
- comprovante
- documentos adicionais
- nome da mãe
- qualquer outro dado não listado acima

Mesmo que pareça útil, NÃO peça.

O backend/CRM deste sistema está preparado para capturar apenas:
nome, CPF, telefone, cidade e estado.

Se algum dado adicional for necessário no futuro, isso será tratado pelo consultor humano da IQG, não pela IA.

ORDEM OBRIGATÓRIA DA COLETA:

1. Primeiro peça o nome completo.
2. Depois CPF.
3. Depois telefone com DDD.
4. Depois cidade.
5. Depois estado.

Nunca peça todos juntos.

Nunca use formulário.

Nunca diga:
"me envie nome, CPF, telefone, e-mail, endereço..."

Forma correta:
"Primeiro, pode me enviar seu nome completo?"

Depois que o sistema confirmar o nome:
"Agora pode me enviar seu CPF?"

Depois:
"Pode me passar seu telefone com DDD?"

Depois:
"Qual é sua cidade?"

Depois:
"Qual é seu estado?"

━━━━━━━━━━━━━━━━━━━━━━━
🔁 REGRA DE CONFIRMAÇÃO (CRÍTICA)
━━━━━━━━━━━━━━━━━━━━━━━

O backend faz:

→ confirmação campo a campo  
→ confirmação final  

Você deve:

Se "sim" → avançar  
Se "não" → pedir correção  

Nunca confirmar manualmente todos os dados.

━━━━━━━━━━━━━━━━━━━━━━━
📦 COMANDOS DE ARQUIVO
━━━━━━━━━━━━━━━━━━━━━━━

Use apenas:

[ACTION:SEND_FOLDER]
[ACTION:SEND_CATALOGO]
[ACTION:SEND_CONTRATO]
[ACTION:SEND_KIT]
[ACTION:SEND_MANUAL]

Regras:
- só no final
- linha separada
- nunca explicar
- nunca duplicar envio

━━━━━━━━━━━━━━━━━━━━━━━
🚫 PROIBIDO
━━━━━━━━━━━━━━━━━━━━━━━

Nunca:
- prometer ganho
- falar que é emprego
- falar que é franquia
- inventar preço
- pedir pagamento
- aprovar lead
- pular fase
- pedir dados cedo

━━━━━━━━━━━━━━━━━━━━━━━
📊 COMPORTAMENTO POR STATUS (CRM)
━━━━━━━━━━━━━━━━━━━━━━━

inicio/novo:
→ abrir conversa

morno:
→ aprofundar valor

qualificando:
→ alinhar investimento

coletando_dados:
→ pedir dados

dados_confirmados:
→ encerrar e informar análise

em_atendimento:
→ não competir com humano

━━━━━━━━━━━━━━━━━━━━━━━
🔥 REGRA DE OURO
━━━━━━━━━━━━━━━━━━━━━━━

Seu papel não é acelerar.

É QUALIFICAR.

Lead bom:
- entende tudo
- aceita regras
- entra consciente

━━━━━━━━━━━━━━━━━━━━━━━
🧠 INTERPRETAÇÃO DE RESPOSTAS CURTAS
━━━━━━━━━━━━━━━━━━━━━━━

Depende do contexto:

Após folder:
→ apenas recebeu

Após confirmação:
→ confirma dado

Após taxa:
→ pode ser ciência (validar)

Nunca assumir avanço automático.

━━━━━━━━━━━━━━━━━━━━━━━
🔁 REGRA DE RETOMADA INTELIGENTE (ANTI-LOOP)
━━━━━━━━━━━━━━━━━━━━━━━

Após qualquer resposta curta do lead, a IA deve retomar a condução com clareza.

Regras obrigatórias:

1. Se o lead responder de forma curta:
"ok", "sim", "entendi", "certo"

→ NÃO repetir conteúdo
→ NÃO mudar de fase automaticamente

2. A IA deve:

- assumir que o lead apenas recebeu a informação
- retomar a condução com uma pergunta simples e direta

3. Sempre conectar com a fase atual.

Exemplos corretos:

Após benefícios:
"Perfeito 😊 Quer que eu te explique agora como funciona o estoque inicial?"

Após estoque:
"Você entendeu como funciona questão do estoque ou tem alguma dúvida ainda?"

Após investimento:
"Faz sentido pra você nesse formato?"

4. Nunca deixar a conversa “morrer” após resposta curta.

5. Nunca responder apenas:
"perfeito", "ótimo", "legal"

→ Sempre conduzir o próximo passo.

6. Se houver dúvida sobre o próximo passo:
→ conduzir com pergunta leve ao invés de assumir avanço.

Exemplo:

"Só pra eu te direcionar melhor: você quer entender mais algum ponto ou podemos avançar?"

━━━━━━━━━━━━━━━━━━━━━━━
🔥 DETECÇÃO DE INTERESSE REAL
━━━━━━━━━━━━━━━━━━━━━━━

Apenas considerar avanço se o lead disser:

- "quero entrar"
- "vamos seguir"
- "como faço"
- "pode iniciar"
- "tenho interesse"

━━━━━━━━━━━━━━━━━━━━━━━
💡 CONDUÇÃO INTELIGENTE
━━━━━━━━━━━━━━━━━━━━━━━

Sempre:

- responder dúvida
- depois conduzir

Nunca:

- responder seco
- deixar conversa morrer

━━━━━━━━━━━━━━━━━━━━━━━
🎯 REGRA DE FOCO NA RESPOSTA (ANTI-MISTURA)
━━━━━━━━━━━━━━━━━━━━━━━

Cada resposta deve ter UM FOCO PRINCIPAL.

Regras obrigatórias:

1. Sempre priorizar responder exatamente o que o lead perguntou.

2. Após responder, conduzir apenas para o próximo passo natural da fase atual.

3. Nunca misturar múltiplos temas de fases diferentes na mesma resposta sem necessidade.

4. Nunca antecipar conteúdos de fases futuras sem o lead pedir.

5. Evitar respostas que:
- expliquem benefício + estoque + investimento juntos
- respondam e já puxem outro assunto não solicitado

6. Estrutura ideal da resposta:

- Parte 1: responder a dúvida do lead
- Parte 2: condução leve (1 pergunta ou 1 avanço)

Exemplo correto:

Lead:
"tem estoque?"

IA:
(explica estoque)

"Quer que eu te envie a lista completa do kit?"

Exemplo errado:

IA:
(explica estoque + benefícios + investimento + já pede dado)

7. Menos é mais:
Respostas mais focadas aumentam clareza e conversão.

━━━━━━━━━━━━━━━━━━━━━━━
⚖️ EQUILÍBRIO DE EXPECTATIVA
━━━━━━━━━━━━━━━━━━━━━━━

Sempre incluir:

"o resultado depende da sua atuação"

━━━━━━━━━━━━━━━━━━━━━━━
📈 LEAD QUENTE
━━━━━━━━━━━━━━━━━━━━━━━

Sinais:
- quer entrar
- pergunta investimento
- aceita regras
- envia dados

Ação:
→ avançar

━━━━━━━━━━━━━━━━━━━━━━━
📉 LEAD MORNO
━━━━━━━━━━━━━━━━━━━━━━━

Sinais:
- curioso
- indeciso

Ação:
→ reforçar valor

❄️ LEAD FRIO / LEAD TRAVADO / LEAD QUASE PERDIDO

Sinais:
- diz que não tem interesse
- achou caro
- quer deixar para depois
- está inseguro
- rejeitou ou questionou o investimento
- não quer assumir risco
- não entendeu ainda o valor do programa
- está em dúvida se vale a pena

Ação:
→ nunca abandonar de primeira
→ nunca marcar como perda
→ nunca descartar o lead por objeção de taxa
→ responder a objeção atual primeiro
→ entender o motivo real da trava
→ reforçar valor percebido do Homologado
→ sustentar a conversa com tom consultivo e sem pressão
→ não oferecer Afiliados automaticamente só porque o lead achou caro
→ não fugir da objeção de taxa oferecendo outro programa cedo demais

Quando a trava for taxa, preço, dinheiro ou investimento:

1. Acolha:
"Entendo sua análise, faz sentido olhar com cuidado."

2. Reposicione:
"Mas é importante não olhar a taxa isolada."

3. Ancore valor:
- taxa de R$ 1.990,00 não é compra de mercadoria;
- não é caução;
- não é garantia;
- envolve ativação, suporte, treinamento e estrutura;
- lote inicial em comodato representa mais de R$ 5.000,00 em preço de venda ao consumidor;
- comissão/margem pode chegar a 40% no preço sugerido;
- se vender com ágio, a diferença fica com o parceiro;
- pagamento só ocorre após análise interna e contrato;
- pode haver parcelamento em até 10x de R$ 199,00 no cartão, se disponível.

4. Valide a raiz da objeção:
"Hoje o que mais pesa pra você: o valor inicial, o receio de vender ou entender melhor como recupera esse investimento?"

Afiliados só podem ser mencionados se:
- o lead pedir claramente link;
- falar em venda online;
- falar em redes sociais;
- falar em e-commerce;
- pedir modelo sem estoque físico;
- pedir alternativa sem taxa do Homologado;
- disser explicitamente que não quer trabalhar com produto físico ou estoque.

Se isso acontecer, explique Afiliados como caminho separado, sem misturar com a taxa, estoque ou pré-análise do Homologado.

Regra central:
Objeção de taxa deve ser tratada primeiro como oportunidade de conversão do Homologado, não como motivo para mudar de rota.
━━━━━━━━━━━━━━━━━━━━━━━
🧾 CONTRATO
━━━━━━━━━━━━━━━━━━━━━━━

Só após análise interna.

Nunca antecipar.

━━━━━━━━━━━━━━━━━━━━━━━
💳 PAGAMENTO
━━━━━━━━━━━━━━━━━━━━━━━

Nunca pedir.

Só após contrato.

━━━━━━━━━━━━━━━━━━━━━━━
🧑‍💼 ESCALONAMENTO
━━━━━━━━━━━━━━━━━━━━━━━

Encaminhar humano se:
- jurídico
- contrato
- pagamento
- avalista

━━━━━━━━━━━━━━━━━━━━━━━
📦 USO DE MATERIAIS
━━━━━━━━━━━━━━━━━━━━━━━

Enviar quando:

- dúvida
- insegurança
- reforço

Nunca:
- sem contexto
- mais de um
- repetir envio

━━━━━━━━━━━━━━━━━━━━━━━
🧠 HIERARQUIA DE DECISÃO DA IA
━━━━━━━━━━━━━━━━━━━━━━━

Quando houver conflito entre regras, dúvidas ou possíveis caminhos, a IA deve seguir esta ordem de prioridade:

1. SEGURANÇA E PROIBIÇÕES
Nunca violar regras proibidas:
- não prometer ganho
- não pedir pagamento
- não aprovar lead
- não pedir dados não permitidos
- não pular coleta

2. FASE ATUAL
Sempre respeitar a fase atual identificada pelo backend/status.

3. DÚVIDA DO LEAD
Responder primeiro a pergunta feita pelo lead.

4. BLOQUEIO DE AVANÇO
Antes de avançar, verificar se todos os requisitos da fase anterior foram cumpridos.

5. DADOS JÁ EXISTENTES
Nunca pedir novamente um dado que o lead já informou.

6. CONDUÇÃO
Após responder, conduzir apenas um próximo passo natural.

7. ESTILO
Manter linguagem curta, consultiva e natural para WhatsApp.

Regra central:
Se houver dúvida entre avançar ou permanecer na fase atual, permaneça na fase atual e faça uma pergunta leve de validação.

━━━━━━━━━━━━━━━━━━━━━━━
🧠 CONTROLE DE REPETIÇÃO (ANTI-REDUNDÂNCIA)
━━━━━━━━━━━━━━━━━━━━━━━

A IA deve evitar repetir conteúdos já explicados ao longo da conversa.

Regras obrigatórias:

1. Se um tema já foi explicado claramente, NÃO repetir a explicação completa.

2. Só retomar um tema se:
- o lead demonstrar dúvida real
- o lead pedir novamente
- houver objeção clara

3. Ao retomar, seja mais curto e direto, nunca repetir o texto completo anterior.

4. Nunca repetir automaticamente:
- benefícios
- explicação do programa
- explicação do estoque
- explicação da taxa

5. Após envio de material (folder, kit, etc):
- NÃO reexplicar tudo novamente
- conduzir com pergunta

Exemplo correto:
"Se quiser, te reforço esse ponto, mas basicamente funciona assim..."

6. Se o lead apenas disser:
"ok", "entendi", "sim"

→ NÃO repetir explicação
→ apenas conduzir para o próximo passo

7. Priorizar avanço, não repetição.


━━━━━━━━━━━━━━━━━━━━━━━
🎯 RESUMO FINAL
━━━━━━━━━━━━━━━━━━━━━━━

Você é uma SDR IA de alta performance.

Seu objetivo NÃO é falar mais.

Seu objetivo é:

CONDUZIR MELHOR    
CONVERTER MELHOR  

Sem pular etapas.

━━━━━━━━━━━━━━━━━━━━━━━
🧠 TRATAMENTO DE MÚLTIPLAS PERGUNTAS (CRÍTICO)
━━━━━━━━━━━━━━━━━━━━━━━

O lead pode enviar:

- várias perguntas em uma única mensagem
- ou dividir perguntas em 2 ou 3 mensagens seguidas

ANTES de responder, você deve:

1. Ler TODAS as mensagens recentes do lead
2. Identificar TODAS as perguntas feitas
3. Agrupar mentalmente as perguntas
4. Responder TUDO em UMA única resposta organizada

━━━━━━━━━━━━━━━━━━━━━━━
💬 FORMA CORRETA DE RESPOSTA
━━━━━━━━━━━━━━━━━━━━━━━

Se houver múltiplas dúvidas, responda assim:

- Comece respondendo cada ponto de forma clara
- Use separação natural (parágrafos curtos ou bullets)
- Depois conduza a conversa

Exemplo:

"Ótimas perguntas, vou te explicar 👇

Sobre o estoque:  
(explicação)

Sobre ganhos:  
(explicação)

Sobre investimento:  
(explicação)

Agora me diz: fez sentido pra você até aqui?"

━━━━━━━━━━━━━━━━━━━━━━━
⚠️ REGRAS IMPORTANTES
━━━━━━━━━━━━━━━━━━━━━━━

- Nunca responder em mensagens separadas
- Nunca responder parcialmente
- Nunca ignorar perguntas
- Nunca responder só a última pergunta

━━━━━━━━━━━━━━━━━━━━━━━
❌ ERRO GRAVE
━━━━━━━━━━━━━━━━━━━━━━━

ERRADO:

Lead:
"quanto ganha? precisa vender? tem estoque?"

IA:
(resposta 1)
(resposta 2)
(resposta 3)

CORRETO:

IA responde tudo junto em uma única mensagem organizada.

━━━━━━━━━━━━━━━━━━━━━━━
🎯 OBJETIVO
━━━━━━━━━━━━━━━━━━━━━━━

A conversa deve parecer humana e inteligente.

Responder tudo de forma estruturada:
→ aumenta confiança  
→ reduz fricção  
→ aumenta conversão

━━━━━━━━━━━━━━━━━━━━━━━
`;

async function sendWhatsAppMessage(to, body) {
  const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao enviar mensagem WhatsApp:", data);
    throw new Error("Falha ao enviar mensagem WhatsApp");
  }
}

async function sendTypingIndicator(messageId) {
  if (!messageId) return;

  const response = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: {
        type: "text"
      }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao enviar typing indicator:", data);
  }
}

async function notifyConsultant(lead) {
  if (!process.env.CONSULTANT_PHONE) return;

  const leadPhone = lead.telefoneWhatsApp || lead.user;
  const whatsappLink = `https://wa.me/${leadPhone}`;

  const message = `
🔥 Lead quente!

Telefone: ${leadPhone}
Mensagem: ${lead.ultimaMensagem || "-"}
Status: ${lead.status}

Abrir conversa:
${whatsappLink}
`;

  await sendWhatsAppMessage(process.env.CONSULTANT_PHONE, message);
}
async function sendWhatsAppDocument(to, file) {
  const fileResponse = await fetch(file.link);

  if (!fileResponse.ok) {
    throw new Error(`Erro ao baixar arquivo: ${fileResponse.status}`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", buffer, {
    filename: file.filename,
    contentType: "application/pdf"
  });

  const upload = await fetch(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        ...form.getHeaders()
      },
      body: form
    }
  );

  const uploadData = await upload.json();

  if (!upload.ok) {
    console.error("Erro ao subir documento para WhatsApp:", uploadData);
    throw new Error("Falha ao subir documento para WhatsApp");
  }

  const sendDocument = await fetch(
    `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          id: uploadData.id,
          filename: file.filename,
          caption: file.caption
        }
      })
    }
  );

  const sendDocumentData = await sendDocument.json();

  if (!sendDocument.ok) {
    console.error("Erro ao enviar documento WhatsApp:", sendDocumentData);
    throw new Error("Falha ao enviar documento WhatsApp");
  }
}
async function getWhatsAppMediaUrl(mediaId) {
  const response = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
    }
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao buscar URL da mídia:", data);
    throw new Error("Falha ao buscar URL da mídia do WhatsApp");
  }

  return data.url;
}

async function downloadWhatsAppMedia(mediaUrl) {
  const response = await fetch(mediaUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(`Falha ao baixar mídia do WhatsApp: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function transcribeAudioBuffer(buffer, filename = "audio.ogg") {
  const form = new FormData();

  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "pt");
  form.append(
    "prompt",
    "Transcreva o áudio em português do Brasil. O contexto é uma conversa comercial sobre o Programa Parceiro Homologado IQG."
  );

  form.append("file", buffer, {
    filename,
    contentType: "audio/ogg"
  });

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders()
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao transcrever áudio:", data);
    throw new Error("Falha ao transcrever áudio");
  }

  return data.text || "";
}

function detectRequestedFile(text = "") {
  const normalizedText = text.toLowerCase();

  if (normalizedText.includes("contrato")) return "contrato";
  if (normalizedText.includes("catálogo") || normalizedText.includes("catalogo")) return "catalogo";
  if (normalizedText.includes("kit")) return "kit";
  if (normalizedText.includes("manual") || normalizedText.includes("curso")) return "manual";
  if (normalizedText.includes("folder")) return "folder";

  return null;
}

function hasExplicitFileRequest(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return (
    // pedidos genéricos claros
    t.includes("me manda o material") ||
    t.includes("me mande o material") ||
    t.includes("pode mandar o material") ||
    t.includes("pode me mandar o material") ||
    t.includes("quero o material") ||
    t.includes("tem material") ||
    t.includes("tem algum material") ||
    t.includes("tem pdf") ||
    t.includes("tem algum pdf") ||
    t.includes("me manda o pdf") ||
    t.includes("me mande o pdf") ||
    t.includes("pode mandar o pdf") ||
    t.includes("me envia o material") ||
    t.includes("me envie o material") ||
    t.includes("pode enviar o material") ||

    // pedidos específicos
    t.includes("me manda o folder") ||
    t.includes("me mande o folder") ||
    t.includes("quero o folder") ||
    t.includes("me manda o catalogo") ||
    t.includes("me mande o catalogo") ||
    t.includes("quero o catalogo") ||
    t.includes("me manda o contrato") ||
    t.includes("me mande o contrato") ||
    t.includes("quero o contrato") ||
    t.includes("me manda o kit") ||
    t.includes("me mande o kit") ||
    t.includes("quero o kit") ||
    t.includes("me manda o manual") ||
    t.includes("me mande o manual") ||
    t.includes("quero o manual") ||

    // formas naturais
    t.includes("tem uma apresentacao") ||
    t.includes("tem apresentação") ||
    t.includes("quero ver a lista") ||
    t.includes("me mostra a lista") ||
    t.includes("manda a lista dos produtos") ||
    t.includes("mande a lista dos produtos")
  );
}

function extractActions(reply = "") {
  const actions = [];

  const actionMap = {
    "[ACTION:SEND_FOLDER]": "folder",
    "[ACTION:SEND_CATALOGO]": "catalogo",
    "[ACTION:SEND_CONTRATO]": "contrato",
    "[ACTION:SEND_KIT]": "kit",
    "[ACTION:SEND_MANUAL]": "manual"
  };

  let cleanReply = reply;

  for (const [action, fileKey] of Object.entries(actionMap)) {
    if (cleanReply.includes(action)) {
      actions.push(fileKey);
      cleanReply = cleanReply.replaceAll(action, "").trim();
    }
  }

  return {
    cleanReply,
    actions
  };
}

function syncActionsFromFinalReply({
  respostaFinal = "",
  actions = []
} = {}) {
  const extracted = extractActions(respostaFinal || "");

  const cleanReply = String(extracted.cleanReply || "").trim();
  const finalActions = Array.isArray(extracted.actions)
    ? extracted.actions
    : [];

  if (Array.isArray(actions)) {
    actions.splice(0, actions.length, ...finalActions);
  }

  return {
    respostaFinal: cleanReply || respostaFinal,
    actions
  };
}

function getFirstName(name = "") {
  const cleanName = String(name || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!cleanName) return "";

  return cleanName.split(" ")[0];
}

function detectGenderByName(name = "") {
  const firstName = getFirstName(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (!firstName) return "";

  const maleNames = [
    "edson", "joao", "jose", "antonio", "carlos", "paulo", "pedro",
    "lucas", "marcos", "marcelo", "rafael", "rodrigo", "fernando",
    "ricardo", "luiz", "luis", "bruno", "gustavo", "felipe", "andre",
    "alexandre", "daniel", "diego", "fabio", "leandro", "mateus",
    "matheus", "thiago", "tiago", "vinicius"
  ];

  const femaleNames = [
    "maria", "ana", "julia", "juliana", "fernanda", "patricia",
    "carla", "camila", "amanda", "bruna", "beatriz", "larissa",
    "mariana", "aline", "vanessa", "renata", "leticia", "gabriela",
    "cristina", "sandra", "monica", "priscila", "viviane", "daniela"
  ];

  if (maleNames.includes(firstName)) return "masculino";
  if (femaleNames.includes(firstName)) return "feminino";

  return "";
}

function onlyDigits(value = "") {
  return String(value).replace(/\D/g, "");
}

function extractExplicitCorrection(text = "") {
  const fullText = String(text || "").trim();

  const lower = fullText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const correction = {};

  // CPF correto enviado diretamente
  const cpfMatch = fullText.match(/\bcpf\s*(?:correto\s*)?(?:é|e|:|-)?\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/i);

  if (cpfMatch) {
    correction.cpf = formatCPF(cpfMatch[1]);
    return correction;
  }

  // Telefone correto enviado diretamente
  const telefoneMatch = fullText.match(/\b(?:telefone|celular|whatsapp)\s*(?:correto\s*)?(?:é|e|:|-)?\s*((?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4})\b/i);

  if (telefoneMatch) {
    correction.telefone = formatPhone(telefoneMatch[1]);
    return correction;
  }

  // Estado correto enviado diretamente
  const estadoMatch = fullText.match(/\b(?:estado|uf)\s*(?:correto\s*)?(?:é|e|:|-)?\s*([A-Za-zÀ-ÿ\s]{2,}|AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\s*$/i);

  if (estadoMatch) {
    const uf = normalizeUF(estadoMatch[1]);

    if (VALID_UFS.includes(uf)) {
      correction.estado = uf;
      return correction;
    }
  }

  // Cidade correta enviada diretamente
  const cidadeMatch = fullText.match(/\bcidade\s*(?:correta\s*)?(?:é|e|:|-)?\s*([A-Za-zÀ-ÿ.'\-\s]{2,})$/i);

  if (cidadeMatch) {
    const cidade = cidadeMatch[1]
      .replace(/\b(errada|incorreta|correta)\b/gi, "")
      .trim();

    if (cidade && !/\b(esta|está|errada|incorreta)\b/i.test(cidade)) {
      correction.cidade = cidade;
      return correction;
    }
  }

  // Nome correto enviado diretamente
  const nomeMatch = fullText.match(/\b(?:meu\s+)?nome\s*(?:correto\s*)?(?:é|e|:|-)?\s*([A-Za-zÀ-ÿ.'\-\s]{3,})$/i);

  if (nomeMatch) {
    const nome = nomeMatch[1]
      .replace(/\b(errado|incorreto|correto)\b/gi, "")
      .trim();

    if (
      nome &&
      nome.split(/\s+/).length >= 2 &&
      !/\b(esta|está|errado|incorreto)\b/i.test(nome)
    ) {
      correction.nome = nome;
      return correction;
    }
  }

  // Detecta quando o lead apenas informou QUAL campo está errado.
  // Exemplo: "nome está errado", "CPF incorreto", "cidade errada".
  const temPalavraDeErro =
    /\b(errado|errada|incorreto|incorreta|corrigir|correcao|correção|alterar|trocar)\b/i.test(fullText);

  if (!temPalavraDeErro) {
    return correction;
  }

  if (lower.includes("nome")) {
    correction.campoParaCorrigir = "nome";
    return correction;
  }

  if (lower.includes("cpf")) {
    correction.campoParaCorrigir = "cpf";
    return correction;
  }

  if (
    lower.includes("telefone") ||
    lower.includes("celular") ||
    lower.includes("whatsapp")
  ) {
    correction.campoParaCorrigir = "telefone";
    return correction;
  }

  if (lower.includes("cidade")) {
    correction.campoParaCorrigir = "cidade";
    return correction;
  }

  if (
    lower.includes("estado") ||
    lower.includes("uf")
  ) {
    correction.campoParaCorrigir = "estado";
    return correction;
  }

  return correction;
}

function isInvalidLooseNameCandidate(value = "") {
  const raw = String(value || "").trim();

  if (!raw) {
    return true;
  }

  const normalized = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const invalidExact = [
    "mas vamos la",
    "vamos la",
    "esta correto",
    "esta correta",
    "esta certo",
    "esta certa",
    "ta correto",
    "ta correta",
    "ta certo",
    "ta certa",
    "tudo certo",
    "tudo correto",
    "que confirmacao",
    "qual confirmacao",
    "esta errado",
    "esta errada",
    "nome errado",
    "nome esta errado",
    "cpf errado",
    "telefone errado",
    "cidade errada",
    "estado errado",
    "voce nao respondeu",
    "nao respondeu minha pergunta",
    "ja enviei acima",
    "ja passei acima",
    "voce ja tem",
    "voces ja tem",
    "pode seguir",
    "pode continuar",
    "vamos seguir",
    "quero seguir"
  ];

  if (invalidExact.includes(normalized)) {
    return true;
  }

  const invalidParts = [
    "confirmacao",
    "confirmar",
    "corrigir",
    "correcao",
    "errado",
    "errada",
    "incorreto",
    "incorreta",
    "respondeu",
    "pergunta",
    "duvida",
    "nao entendi",
    "nao estou entendendo",
    "ja enviei",
    "ja passei",
    "esta correto",
    "tudo certo",
    "pode seguir",
    "pode continuar",
    "vamos seguir",
    "me explica",
    "como funciona",
    "por que",
    "porque"
  ];

  if (invalidParts.some(term => normalized.includes(term))) {
    return true;
  }

  const words = normalized.split(" ").filter(Boolean);

  if (words.length < 2) {
    return true;
  }

  if (words.length > 5) {
    return true;
  }

  return false;
}

function isInvalidLocationCandidate(value = "") {
  const raw = String(value || "").trim();

  if (!raw) {
    return true;
  }

  const normalized = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const invalidExact = [
    "sim",
    "nao",
    "não",
    "ok",
    "certo",
    "correto",
    "esta correto",
    "esta correta",
    "ta certo",
    "tudo certo",
    "tudo correto",
    "ja enviei",
    "ja enviei acima",
    "ja passei",
    "ja passei acima",
    "voce ja tem",
    "voces ja tem",
    "voce nao esta analisando",
    "voce nao respondeu",
    "nao respondeu minha pergunta",
    "que confirmacao",
    "qual confirmacao",
    "nome esta errado",
    "cpf esta errado",
    "telefone esta errado",
    "cidade esta errada",
    "estado esta errado",
    "dados estao errados"
  ];

  if (invalidExact.includes(normalized)) {
    return true;
  }

  const invalidParts = [
    "ja enviei",
    "ja passei",
    "voce ja tem",
    "voces ja tem",
    "nao respondeu",
    "voce nao respondeu",
    "nao esta analisando",
    "confirmacao",
    "confirmar",
    "corrigir",
    "correcao",
    "errado",
    "errada",
    "incorreto",
    "incorreta",
    "duvida",
    "pergunta",
    "me explica",
    "como funciona",
    "por que",
    "porque",
    "taxa",
    "comodato",
    "estoque",
    "afiliado",
    "link",
    "contrato",
    "pagamento",
    "cpf",
    "telefone",
    "celular",
    "whatsapp",
    "nome completo"
  ];

  if (invalidParts.some(term => normalized.includes(term))) {
    return true;
  }

  // Cidade muito longa costuma ser frase, não cidade.
  const words = normalized.split(" ").filter(Boolean);

  if (words.length > 5) {
    return true;
  }

  return false;
}

function extractLeadData(text = "", currentLead = {}) {
  const data = {};
  const fullText = String(text || "").trim();
  const lower = fullText.toLowerCase();
   const { _id, ...safeCurrentLead } = currentLead || {};

  // CPF com ou sem pontuação
const cpfMatch = fullText.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);

if (cpfMatch) {
  const possibleCpf = cpfMatch[0];
  const hasCpfLabel = /\bcpf\b/i.test(fullText);

  if (hasCpfLabel || isValidCPF(possibleCpf)) {
    data.cpf = formatCPF(possibleCpf);
  }
}

  // Telefone com DDD, aceitando espaços, hífen, parênteses e +55
const phoneRegex = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4}/g;
const phoneCandidates = fullText.match(phoneRegex);

if (phoneCandidates?.length) {
  const cpfDigits = onlyDigits(data.cpf || "");

  const validPhone = phoneCandidates.find(candidate => {
    let digits = onlyDigits(candidate);

    if (digits.startsWith("55") && digits.length > 11) {
      digits = digits.slice(2);
    }

    return (
      digits.length >= 10 &&
      digits.length <= 11 &&
      digits !== cpfDigits &&
      !isRepeatedDigits(digits)
    );
  });

  if (validPhone) {
    let digits = onlyDigits(validPhone);

    if (digits.startsWith("55") && digits.length > 11) {
      digits = digits.slice(2);
    }

    data.telefone = formatPhone(digits);
  }
}

  // Linhas organizadas: Nome:, CPF:, Cidade:, Estado:, Telefone:
  const lines = fullText.split("\n").map(line => line.trim()).filter(Boolean);

  for (const line of lines) {
    const cleanLine = line.replace(/\s+/g, " ").trim();
    const lineLower = cleanLine.toLowerCase();

    if (/^nome\s*[:\-]/i.test(cleanLine)) {
      data.nome = cleanLine.split(/[:\-]/).slice(1).join("-").trim();
    }

    if (/^cpf\s*[:\-]/i.test(cleanLine)) {
      const value = cleanLine.split(/[:\-]/).slice(1).join("-").trim();
      if (value) data.cpf = formatCPF(value);
    }

    if (/^(telefone|celular|whatsapp)\s*[:\-]/i.test(cleanLine)) {
      const value = cleanLine.split(/[:\-]/).slice(1).join("-").trim();
      if (value) data.telefone = formatPhone(value);
    }

    if (/^cidade\s*[:\-]/i.test(cleanLine)) {
      data.cidade = cleanLine.split(/[:\-]/).slice(1).join("-").trim();
    }

    if (/^(estado|uf)\s*[:\-]/i.test(cleanLine)) {
      data.estado = normalizeUF(cleanLine.split(/[:\-]/).slice(1).join("-").trim());
    }

    if (/^cidade\/estado\s*[:\-]/i.test(cleanLine)) {
      const value = cleanLine.split(/[:\-]/).slice(1).join("-").trim();
      const parts = value.split(/[\/,-]/).map(p => p.trim()).filter(Boolean);

      if (parts[0]) data.cidade = parts[0];
      if (parts[1]) data.estado = normalizeUF(parts[1]);
      data.cidadeEstado = value;
    }
  }
// Cidade/UF escrita com espaço: "Duartina sp", "São Paulo SP"
const cidadeUfSpaceMatch = fullText.match(
  /^\s*([A-Za-zÀ-ÿ\s]{3,})\s+(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\s*$/i
);

if (cidadeUfSpaceMatch) {
  data.cidade = cidadeUfSpaceMatch[1].trim();
  data.estado = normalizeUF(cidadeUfSpaceMatch[2]);
  data.cidadeEstado = `${data.cidade}/${data.estado}`;
}
   
  // Cidade/UF no meio do texto: "Curitiba PR", "São Paulo/SP"
   // 🔥 CORREÇÃO EXPLÍCITA DE ESTADO (PRIORIDADE ALTA)
// Evita interpretar frases como "estado o correto é sc" como cidade
const estadoCorrecaoMatch = fullText.match(
  /\b(?:estado|uf)\b.*\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/i
);

if (estadoCorrecaoMatch) {
  data.estado = normalizeUF(estadoCorrecaoMatch[1]);

  return {
    ...safeCurrentLead,
    ...data
  };
}
  const cidadeUfMatch = fullText.match(
  /(?:moro em|sou de|resido em|cidade\s*[:\-]?\s*)?\s*([A-Za-zÀ-ÿ\s]{3,})\s*[\/,-]\s*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/i
);

if (cidadeUfMatch) {
  const rawCity = cidadeUfMatch[1].trim();

  const cityWords = rawCity
    .split(/\s+/)
    .slice(-3)
    .join(" ")
    .replace(/moro em|sou de|resido em|cidade|estado|uf/gi, "")
    .trim();

  data.cidade = cityWords;
  data.estado = normalizeUF(cidadeUfMatch[2]);
  data.cidadeEstado = `${data.cidade}/${data.estado}`;
}

  // Nome solto quando a pessoa escreve "meu nome é..."
  const namePatterns = [
    /meu nome é\s+([A-Za-zÀ-ÿ\s]{3,})/i,
    /me chamo\s+([A-Za-zÀ-ÿ\s]{3,})/i,
    /sou\s+([A-Za-zÀ-ÿ\s]{3,})/i
  ];

  for (const pattern of namePatterns) {
    const match = fullText.match(pattern);

    if (match?.[1]) {
      let name = match[1]
        .replace(/cpf|telefone|celular|whatsapp|cidade|estado|uf/gi, "")
        .replace(/\d+/g, "")
        .trim();

      if (name.split(" ").length >= 2) {
        data.nome = name;
        break;
      }
    }
  }
// Se o texto parece cidade + UF, não deixa cair como nome solto
const looksLikeCidadeUf =
  /^\s*[A-Za-zÀ-ÿ\s]{3,}\s+(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\s*$/i.test(fullText);

if (looksLikeCidadeUf && data.cidade && data.estado) {
  return {
    ...safeCurrentLead,
    ...data
  };
}
   // Nome solto (liberado durante coleta de dados)
if (!data.nome) {
  const isDataContext =
  currentLead?.faseQualificacao === "coletando_dados" ||
  currentLead?.faseQualificacao === "dados_parciais" ||
  currentLead?.faseQualificacao === "aguardando_confirmacao_campo" ||
  currentLead?.faseQualificacao === "aguardando_confirmacao_dados" ||
  currentLead?.faseQualificacao === "corrigir_dado";

  const hasNameContext =
    /\bnome\b/i.test(fullText) ||
    /\bmeu nome é\b/i.test(fullText) ||
    /\bme chamo\b/i.test(fullText) ||
    /\bsou o\b/i.test(fullText) ||
    /\bsou a\b/i.test(fullText);

  if (hasNameContext || isDataContext) {
    let textWithoutNoise = fullText
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, " ")
      .replace(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d[\d\s.-]{7,}\b/g, " ")
      .replace(/\b(oi|olá|ola|bom dia|boa tarde|boa noite|cpf|telefone|celular|whatsapp|cidade|estado|uf|sim|ok|pode|certo|entendi|legal)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    const possibleName = textWithoutNoise.match(
  /\b[A-Za-zÀ-ÿ]{2,}(?:\s+[A-Za-zÀ-ÿ]{2,})+\b/
);

    if (possibleName) {
  const nomeEncontrado = possibleName[0].trim();

  const blacklist = [
    "nome limpo",
    "tenho nome limpo",
    "nao tenho nome limpo",
    "não tenho nome limpo",
    "tenho restricao",
    "tenho restrição",
    "nao tenho restricao",
    "não tenho restrição"
  ];

  const nomeNormalizado = nomeEncontrado
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const isInvalidName = blacklist.some(term =>
    nomeNormalizado.includes(
      term
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
    )
  );

 if (
  nomeEncontrado.split(/\s+/).length >= 2 &&
  !isInvalidName &&
  !isInvalidLooseNameCandidate(nomeEncontrado)
) {
  data.nome = nomeEncontrado;
}
}
  }
}

   
  // Área de atuação
  if (
    lower.includes("vendas") ||
    lower.includes("piscina") ||
    lower.includes("manutenção") ||
    lower.includes("manutencao") ||
    lower.includes("agro") ||
    lower.includes("limpeza") ||
    lower.includes("comércio") ||
    lower.includes("comercio")
  ) {
    data.areaAtuacao = fullText;
  }

  // Nome limpo
  if (
    lower.includes("nome limpo") ||
    lower.includes("sem restrição") ||
    lower.includes("sem restricao") ||
    lower.includes("não tenho restrição") ||
    lower.includes("nao tenho restricao")
  ) {
    data.nomeLimpo = "sim";
  }

  if (
    lower.includes("tenho restrição") ||
    lower.includes("tenho restricao") ||
    lower.includes("negativado") ||
    lower.includes("protesto") ||
    lower.includes("sujo")
  ) {
    data.nomeLimpo = "nao";
  }

  if (data.cidade && data.estado) {
    data.cidadeEstado = `${data.cidade}/${data.estado}`;
  }

return {
  ...safeCurrentLead,
  ...data
};
}

function formatCPF(value = "") {
  const digits = onlyDigits(value);

  if (digits.length !== 11) return value;

  return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

function isValidCPF(value = "") {
  const cpf = onlyDigits(value);

  if (cpf.length !== 11) return false;
  if (isRepeatedDigits(cpf)) return false;

  let sum = 0;

  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }

  let digit1 = 11 - (sum % 11);
  if (digit1 >= 10) digit1 = 0;

  if (digit1 !== Number(cpf[9])) return false;

  sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }

  let digit2 = 11 - (sum % 11);
  if (digit2 >= 10) digit2 = 0;

  return digit2 === Number(cpf[10]);
}

function formatPhone(value = "") {
  const digits = onlyDigits(value);

  if (digits.length === 11) {
    return digits.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  }

  if (digits.length === 10) {
    return digits.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  }

  return value;
}

function isValidPhone(value = "") {
  const digits = onlyDigits(value);

  if (digits.length < 10 || digits.length > 11) return false;
  if (isRepeatedDigits(digits)) return false;

  return true;
}

function isPositiveConfirmation(text = "") {
  const rawText = String(text || "").trim();

  const t = rawText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Confirmações por emoji comuns no WhatsApp.
  const positiveEmojiPatterns = [
    /^👍$/,
    /^👍🏻$/,
    /^👍🏼$/,
    /^👍🏽$/,
    /^👍🏾$/,
    /^👍🏿$/,
    /^✅$/,
    /^👌$/,
    /^👌🏻$/,
    /^👌🏼$/,
    /^👌🏽$/,
    /^👌🏾$/,
    /^👌🏿$/
  ];

  if (positiveEmojiPatterns.some(pattern => pattern.test(rawText))) {
    return true;
  }

  const positivePatterns = [
    // confirmações simples
    /^sim$/,
    /^s$/,
    /^isso$/,
    /^isso mesmo$/,
    /^isso ai$/,
    /^isso aí$/,
    /^correto$/,
    /^correto sim$/,
    /^certo$/,
    /^certo sim$/,
    /^ta certo$/,
    /^tá certo$/,
    /^esta certo$/,
    /^está certo$/,
    /^esta correto$/,
    /^está correto$/,
    /^ta correto$/,
    /^tá correto$/,
    /^esta$/,
    /^está$/,
    /^ta$/,
    /^tá$/,
    /^ok$/,
    /^perfeito$/,
    /^exato$/,
    /^confirmo$/,
    /^confirmado$/,

    // confirmações finais de dados
    /^estao$/,
    /^estão$/,
    /^sim estao$/,
    /^sim estão$/,
    /^estao corretos$/,
    /^estão corretos$/,
    /^estao corretas$/,
    /^estão corretas$/,
    /^sim estao corretos$/,
    /^sim estão corretos$/,
    /^sim estao corretas$/,
    /^sim estão corretas$/,
    /^todos corretos$/,
    /^todas corretas$/,
    /^todos estao corretos$/,
    /^todos estão corretos$/,
    /^todas estao corretas$/,
    /^todas estão corretas$/,
    /^todos certos$/,
    /^todas certas$/,
    /^dados corretos$/,
    /^os dados estao corretos$/,
    /^os dados estão corretos$/,
    /^esta tudo correto$/,
    /^está tudo correto$/,
    /^esta tudo certo$/,
    /^está tudo certo$/,
    /^ta tudo certo$/,
    /^tá tudo certo$/,
    /^ta tudo correto$/,
    /^tá tudo correto$/,
    /^tudo certo$/,
    /^tudo correto$/,
    /^tudo ok$/,

    // autorização para seguir após confirmação
    /^pode seguir$/,
    /^pode$/,
    /^pode continuar$/,
    /^pode encaminhar$/,
    /^pode enviar$/,
    /^pode mandar$/,
    /^pode finalizar$/,
    /^segue$/,
    /^segue ai$/,
    /^segue aí$/,
    /^vai em frente$/,

    // confirmações comerciais naturais
    /^claro$/,
    /^claro que sim$/,
    /^com certeza$/,
    /^certeza$/,
    /^faz sim$/,
    /^faz sentido$/,
    /^fez sentido$/,
    /^pra mim faz sentido$/,
    /^para mim faz sentido$/,
    /^gostei$/,
    /^top$/,
    /^top demais$/,
    /^beleza$/,
    /^blz$/,
    /^show$/,
    /^show de bola$/,
    /^entendi sim$/,
    /^entendi perfeitamente$/,
    /^estou de acordo$/,
    /^to de acordo$/,
    /^tô de acordo$/,
    /^concordo$/,
    /^vamos seguir$/,
    /^podemos seguir$/,
    /^bora$/,
    /^bora seguir$/,
    /^quero seguir$/,
    /^quero continuar$/
  ];

  return positivePatterns.some(pattern => pattern.test(t));
}

function isNegativeConfirmation(text = "") {
  const rawText = String(text || "").trim();

  const t = rawText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) {
    return false;
  }

  // Evita interpretar frases como "não está errado" como negativa.
  if (
    t.includes("nao esta errado") ||
    t.includes("nao esta errada") ||
    t.includes("nao tem erro") ||
    t.includes("nao ha erro")
  ) {
    return false;
  }

  const negativePatterns = [
    /^nao$/,
    /^não$/,
    /^n$/,
    /^negativo$/,
    /^errado$/,
    /^errada$/,
    /^incorreto$/,
    /^incorreta$/,
    /^nao esta correto$/,
    /^não está correto$/,
    /^nao esta correta$/,
    /^não está correta$/,
    /^nao estao corretos$/,
    /^não estão corretos$/,
    /^nao estao corretas$/,
    /^não estão corretas$/,
    /^nao estao$/,
    /^não estão$/,
    /^tem erro$/,
    /^tem coisa errada$/,
    /^tem dado errado$/,
    /^tem dados errados$/,
    /^precisa corrigir$/,
    /^quero corrigir$/,
    /^preciso corrigir$/,
    /^vou corrigir$/,
    /^dados errados$/,
    /^os dados estao errados$/,
    /^os dados estão errados$/
  ];

  if (negativePatterns.some(pattern => pattern.test(t))) {
    return true;
  }

  const fieldThenError =
    /\b(nome|cpf|telefone|celular|whatsapp|cidade|estado|uf)\b.*\b(errado|errada|incorreto|incorreta|corrigir|correcao|correção|alterar|trocar)\b/i.test(rawText);

  const errorThenField =
    /\b(errado|errada|incorreto|incorreta|corrigir|correcao|correção|alterar|trocar)\b.*\b(nome|cpf|telefone|celular|whatsapp|cidade|estado|uf)\b/i.test(rawText);

  if (fieldThenError || errorThenField) {
    return true;
  }

  return false;
}

function isNoMeaningNoDoubt({
  leadText = "",
  history = []
} = {}) {
  const t = String(leadText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isSimpleNo = [
    "nao",
    "não",
    "n",
    "negativo"
  ].includes(t);

  if (!isSimpleNo) {
    return false;
  }

  const lastAssistantMessage = getLastAssistantMessage(history);

  const last = String(lastAssistantMessage || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const assistantAskedAboutDoubt =
    last.includes("ficou alguma duvida") ||
    last.includes("ficou alguma dúvida") ||
    last.includes("tem alguma duvida") ||
    last.includes("tem alguma dúvida") ||
    last.includes("alguma duvida") ||
    last.includes("alguma dúvida") ||
    last.includes("ficou claro") ||
    last.includes("conseguiu entender") ||
    last.includes("fez sentido pra voce") ||
    last.includes("fez sentido pra você") ||
    last.includes("faz sentido pra voce") ||
    last.includes("faz sentido pra você");

  const assistantAskedDecision =
    last.includes("quer seguir") ||
    last.includes("podemos seguir") ||
    last.includes("vamos seguir") ||
    last.includes("quer avancar") ||
    last.includes("quer avançar") ||
    last.includes("seguir para a pre-analise") ||
    last.includes("seguir para a pré-análise") ||
    last.includes("seguir para pre analise") ||
    last.includes("seguir para pré análise") ||
    last.includes("tem interesse em seguir") ||
    last.includes("voce tem interesse") ||
    last.includes("você tem interesse");

  return assistantAskedAboutDoubt && !assistantAskedDecision;
}

function isCommitmentConfirmation(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const commitmentPatterns = [
    /^sim estou de acordo$/,
    /^sim eu estou de acordo$/,
    /^estou de acordo$/,
    /^to de acordo$/,
    /^tô de acordo$/,
    /^concordo$/,
    /^sim concordo$/,
    /^entendo e concordo$/,
    /^sim entendo$/,
    /^sim entendi$/,
    /^sim entendo que depende de mim$/,
    /^entendo que depende de mim$/,
    /^sim entendo que depende da minha atuacao$/,
    /^sim entendo que depende da minha atuação$/,
    /^entendo que depende da minha atuacao$/,
    /^entendo que depende da minha atuação$/,
    /^sim o resultado depende da minha atuacao$/,
    /^sim o resultado depende da minha atuação$/,
    /^o resultado depende da minha atuacao$/,
    /^o resultado depende da minha atuação$/,
    /^sei que depende da minha atuacao$/,
    /^sei que depende da minha atuação$/,
    /^sim sei que depende da minha atuacao$/,
    /^sim sei que depende da minha atuação$/,
    /^combinado$/,
    /^combinado entendi$/,
    /^combinado estou de acordo$/
  ];

  return commitmentPatterns.some(pattern => pattern.test(t));
}

function isTaxaAlinhadaConfirmation(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const taxaAlinhadaPatterns = [
    /^sim entendi a taxa$/,
    /^entendi a taxa$/,
    /^sim ficou claro a taxa$/,
    /^ficou claro a taxa$/,
    /^sim ficou claro o investimento$/,
    /^ficou claro o investimento$/,
    /^sim faz sentido o investimento$/,
    /^faz sentido o investimento$/,
    /^sim faz sentido nesse formato$/,
    /^faz sentido nesse formato$/,
    /^sim estou ciente da taxa$/,
    /^estou ciente da taxa$/,
    /^sim estou de acordo com a taxa$/,
    /^estou de acordo com a taxa$/,
    /^sim estou de acordo com o investimento$/,
    /^estou de acordo com o investimento$/,
    /^sim entendi o investimento$/,
    /^entendi o investimento$/,
    /^combinado entendi a taxa$/,
    /^combinado entendi o investimento$/
  ];

  return taxaAlinhadaPatterns.some(pattern => pattern.test(t));
}

function isLikelyAutoReplyMessage(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  const autoReplyPatterns = [
    "obrigado por sua mensagem",
    "obrigada por sua mensagem",
    "agradecemos sua mensagem",
    "recebemos sua mensagem",
    "em breve retornaremos",
    "em breve responderemos",
    "fora do horario de atendimento",
    "fora do horário de atendimento",
    "nosso horario de atendimento",
    "nosso horário de atendimento",
    "mensagem automatica",
    "mensagem automática",
    "resposta automatica",
    "resposta automática",
    "acesse a area me ajuda",
    "acesse a área me ajuda",
    "sou.nu/meajuda"
  ];

  return autoReplyPatterns.some(pattern => t.includes(
    pattern
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
  ));
}

function isSimpleGreetingOnly(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const greetingPatterns = [
    /^oi$/,
    /^ola$/,
    /^olá$/,
    /^opa$/,
    /^e ai$/,
    /^eai$/,
    /^bom dia$/,
    /^boa tarde$/,
    /^boa noite$/,
    /^tudo bem$/,
    /^oi tudo bem$/,
    /^ola tudo bem$/,
    /^olá tudo bem$/,
    /^bom dia tudo bem$/,
    /^boa tarde tudo bem$/,
    /^boa noite tudo bem$/
  ];

  return greetingPatterns.some(pattern => pattern.test(t));
}

function enforceClassifierHardLimits({
  classification = {},
  lead = {},
  lastUserText = ""
} = {}) {
  const safeClassification = {
    ...buildDefaultLeadClassification(),
    ...(classification || {})
  };

  const etapas = lead?.etapas || {};

  const nenhumaEtapaConcluida =
    etapas.programa !== true &&
    etapas.beneficios !== true &&
    etapas.estoque !== true &&
    etapas.responsabilidades !== true &&
    etapas.investimento !== true &&
    etapas.compromisso !== true;

  const etapaAtual = getCurrentFunnelStage(lead || {});
  const mensagemEhCumprimentoSimples = isSimpleGreetingOnly(lastUserText);

  // 1) Cumprimento simples não pode virar lead quente, pronto ou pré-análise.
  if (mensagemEhCumprimentoSimples && nenhumaEtapaConcluida && etapaAtual <= 1) {
    return {
      ...safeClassification,
      temperaturaComercial: "nao_analisado",
      perfilComportamentalPrincipal: "nao_analisado",
      perfilComportamentalSecundario: "",
      nivelConsciencia: "baixo",
      intencaoPrincipal: "sem_intencao_clara",
      objecaoPrincipal: "sem_objecao_detectada",
      confiancaClassificacao: "baixa",
      sinaisObservados: ["cumprimento_inicial_sem_sinal_comercial"],
      resumoPerfil: "Lead enviou apenas um cumprimento inicial. Não há sinal suficiente para classificar como quente, qualificado ou pronto para pré-análise.",
      classificadoEm: new Date()
    };
  }

  // 2) Classificador não pode liberar pré-análise se o backend ainda não permite coleta.
  if (
    safeClassification.intencaoPrincipal === "avancar_pre_analise" &&
    !canStartDataCollection(lead || {})
  ) {
    return {
      ...safeClassification,
      temperaturaComercial:
        safeClassification.temperaturaComercial === "quente"
          ? "morno"
          : safeClassification.temperaturaComercial,
      perfilComportamentalPrincipal:
        safeClassification.perfilComportamentalPrincipal === "qualificado_pronto"
          ? "curioso_morno"
          : safeClassification.perfilComportamentalPrincipal,
      intencaoPrincipal: "tirar_duvida",
      confiancaClassificacao: "baixa",
      sinaisObservados: [
        ...(Array.isArray(safeClassification.sinaisObservados)
          ? safeClassification.sinaisObservados
          : []),
        "pre_analise_bloqueada_por_etapas_incompletas"
      ],
      resumoPerfil: "O Classificador indicou avanço para pré-análise, mas o backend bloqueou porque ainda faltam etapas obrigatórias do funil. A intenção do lead deve ser tratada com cautela.",
      classificadoEm: new Date()
    };
  }

  // 3) Objeção leve de taxa/preço NÃO pode virar Afiliado sem pedido claro.
  const mensagemTemObjeçãoDePreço =
    isPreCrmBlockingObjection(lastUserText) &&
    !isClearAffiliateFallbackIntent(lastUserText);

  const classificadorForcouAfiliadoSemPedidoClaro =
    mensagemTemObjeçãoDePreço &&
    (
      safeClassification.perfilComportamentalPrincipal === "afiliado_digital" ||
      safeClassification.intencaoPrincipal === "buscar_afiliado" ||
      safeClassification.temperaturaComercial === "afiliado"
    );

  if (classificadorForcouAfiliadoSemPedidoClaro) {
    return {
      ...safeClassification,
      temperaturaComercial:
        safeClassification.temperaturaComercial === "afiliado"
          ? "travado"
          : safeClassification.temperaturaComercial === "quente"
            ? "travado"
            : safeClassification.temperaturaComercial,

      perfilComportamentalPrincipal:
        safeClassification.perfilComportamentalPrincipal === "afiliado_digital"
          ? "sensivel_preco"
          : safeClassification.perfilComportamentalPrincipal,

      intencaoPrincipal:
        safeClassification.intencaoPrincipal === "buscar_afiliado"
          ? "avaliar_investimento"
          : safeClassification.intencaoPrincipal,

      objecaoPrincipal: "preco_taxa_adesao",

      confiancaClassificacao:
        safeClassification.confiancaClassificacao === "alta"
          ? "media"
          : safeClassification.confiancaClassificacao,

      sinaisObservados: [
        ...(Array.isArray(safeClassification.sinaisObservados)
          ? safeClassification.sinaisObservados
          : []),
        "afiliado_bloqueado_por_objecao_de_preco_sem_pedido_claro"
      ],

      resumoPerfil:
        "O Classificador tentou interpretar objeção de preço como intenção de Afiliado, mas o backend corrigiu porque o lead não pediu claramente link, afiliado, venda sem estoque ou alternativa sem taxa. A leitura correta é objeção de investimento no Homologado.",

      classificadoEm: new Date()
    };
  }

  return safeClassification;
}

function enforceConsultantHardLimits({
  consultantAdvice = {},
  lead = {},
  lastUserText = "",
  classification = {}
} = {}) {
  const safeAdvice = {
    ...buildDefaultConsultantAdvice(),
    ...(consultantAdvice || {})
  };

  const mensagemTemObjeçãoDePreço =
    isPreCrmBlockingObjection(lastUserText) &&
    !isClearAffiliateFallbackIntent(lastUserText);

  const consultorForcouAfiliadoSemPedidoClaro =
    mensagemTemObjeçãoDePreço &&
    (
      safeAdvice.estrategiaRecomendada === "oferecer_afiliado" ||
      safeAdvice.ofertaMaisAdequada === "afiliado" ||
      classification?.intencaoPrincipal === "buscar_afiliado" ||
      classification?.perfilComportamentalPrincipal === "afiliado_digital"
    );

  if (consultorForcouAfiliadoSemPedidoClaro) {
    return {
      ...safeAdvice,
      estrategiaRecomendada: "tratar_objecao_taxa",
      ofertaMaisAdequada: "homologado",
      momentoIdealHumano: "se_houver_nova_objecao",
      prioridadeComercial:
        safeAdvice.prioridadeComercial === "urgente"
          ? "alta"
          : safeAdvice.prioridadeComercial || "alta",
      proximaMelhorAcao:
        "Tratar a objeção de taxa antes de oferecer Afiliados. A SDR deve reforçar valor percebido: lote inicial acima de R$ 5.000,00 em preço de venda, margem é de 40% no preço sugerido, possibilidade de margem maior com ágio, parcelamento no cartão e pagamento somente após análise interna e contrato.",
      abordagemSugerida:
        "Tom acolhedor e consultivo. Validar que o valor merece análise, mas não tratar a taxa isoladamente. Não pressionar e não oferecer Afiliados ainda, pois o lead não pediu claramente link, venda sem estoque ou alternativa sem taxa.",
      argumentoPrincipal:
        "A taxa de R$ 1.990,00 deve ser comparada com a estrutura recebida, suporte, treinamento, lote em comodato acima de R$ 5.000,00 em preço de venda e margem é de 40% quando vende no preço sugerido.",
      cuidadoPrincipal:
        "Não transformar objeção de preço em intenção de Afiliado. Só apresentar Afiliados se o lead rejeitar claramente taxa, estoque, produto físico ou pedir uma alternativa por link/sem estoque.",
      resumoConsultivo:
        "O Consultor tentou orientar Afiliados diante de objeção de preço, mas o backend corrigiu porque o lead ainda não pediu claramente Afiliado. A próxima resposta deve tratar a objeção de taxa com proposta de valor do Parceiro Homologado."
    };
  }

  return safeAdvice;
}

function enforceSupervisorHardLimits({
  supervisorAnalysis = {},
  lead = {},
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  const safeSupervisor = {
    ...buildDefaultSupervisorAnalysis(),
    ...(supervisorAnalysis || {})
  };

  const etapas = lead?.etapas || {};

  const nenhumaEtapaConcluida =
    etapas.programa !== true &&
    etapas.beneficios !== true &&
    etapas.estoque !== true &&
    etapas.responsabilidades !== true &&
    etapas.investimento !== true &&
    etapas.compromisso !== true;

  const etapaAtual = getCurrentFunnelStage(lead || {});
  const mensagemEhCumprimentoSimples = isSimpleGreetingOnly(lastUserText);

  const sdrFalouAlgoPerigoso =
    /pre[-\s]?analise|pré[-\s]?análise/i.test(lastSdrText) ||
    replyMentionsInvestment(lastSdrText) ||
    replyAsksPersonalData(lastSdrText) ||
    mentionsPaymentIntent(lastSdrText);

  if (
    mensagemEhCumprimentoSimples &&
    nenhumaEtapaConcluida &&
    etapaAtual <= 1 &&
    !sdrFalouAlgoPerigoso
  ) {
    return {
      ...safeSupervisor,
      houveErroSdr: false,
      errosDetectados: ["nenhum_erro_detectado"],
      sdrPulouFase: false,
      fasePulada: "",
      descricaoErroPrincipal: "",
      riscoPerda: "baixo",
      motivoRisco: "Lead enviou apenas um cumprimento inicial e a SDR não avançou para tema sensível.",
      pontoTrava: "sem_trava_detectada",
      leadEsfriou: false,
      motivoEsfriamento: "",
      necessitaHumano: false,
      prioridadeHumana: "nenhuma",
      qualidadeConducaoSdr: "boa",
      notaConducaoSdr: 8,
      resumoDiagnostico: "Conversa inicial sem sinal de risco. Não há motivo para acionar humano neste momento.",
      observacoesTecnicas: ["supervisor_corrigido_por_cumprimento_inicial"],
      analisadoEm: new Date()
    };
  }

  if (
    safeSupervisor.necessitaHumano === true &&
    safeSupervisor.riscoPerda === "medio" &&
    !mentionsPaymentIntent(lastUserText) &&
    !mentionsPaymentIntent(lastSdrText) &&
    !/contrato|juridico|jurídico|humano|atendente|consultor|vendedor/i.test(lastUserText)
  ) {
    return {
      ...safeSupervisor,
      necessitaHumano: false,
      prioridadeHumana:
        safeSupervisor.prioridadeHumana === "urgente" || safeSupervisor.prioridadeHumana === "alta"
          ? "media"
          : safeSupervisor.prioridadeHumana || "media",
      observacoesTecnicas: [
        ...(Array.isArray(safeSupervisor.observacoesTecnicas)
          ? safeSupervisor.observacoesTecnicas
          : []),
        "necessita_humano_reduzido_por_risco_medio_sem_gatilho_critico"
      ],
      resumoDiagnostico:
        safeSupervisor.resumoDiagnostico ||
        "Risco médio identificado, mas sem gatilho crítico para acionar humano automaticamente."
    };
  }

  return safeSupervisor;
}

function isCommercialProgressConfirmation(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Confirmações fracas indicam entendimento, não avanço comercial.
  // Exemplos: "ok", "sim", "entendi", "fez sentido".
  if (isSoftUnderstandingConfirmation(text)) {
    return false;
  }

  const commercialPatterns = [
    /^quero seguir$/,
    /^quero continuar$/,
    /^quero avancar$/,
    /^quero avançar$/,
    /^podemos seguir$/,
    /^podemos avancar$/,
    /^podemos avançar$/,
    /^vamos seguir$/,
    /^vamos avancar$/,
    /^vamos avançar$/,
    /^bora seguir$/,
    /^bora avancar$/,
    /^bora avançar$/,
    /^pode seguir$/,
    /^pode continuar$/,
    /^pode avancar$/,
    /^pode avançar$/,
    /^pode iniciar$/,
    /^quero iniciar$/,
    /^vamos iniciar$/,
    /^quero entrar$/,
    /^quero participar$/,
    /^quero aderir$/,
    /^tenho interesse em seguir$/,
    /^tenho interesse em avancar$/,
    /^tenho interesse em avançar$/,
    /^tenho interesse em entrar$/,
    /^faz sentido podemos seguir$/,
    /^faz sentido pode seguir$/,
    /^faz sentido quero seguir$/,
    /^faz sentido vamos seguir$/,
    /^estou de acordo podemos seguir$/,
    /^estou de acordo vamos seguir$/,
    /^estou de acordo pode seguir$/
  ];

  return commercialPatterns.some(pattern => pattern.test(t));
}

function isCadastroOuParticipacaoIntent(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  const patterns = [
    "como me cadastro",
    "como eu me cadastro",
    "quero me cadastrar",
    "quero cadastrar",
    "fazer cadastro",
    "como faco o cadastro",
    "como faço o cadastro",
    "como faço para cadastrar",
    "como faco para cadastrar",
    "como faço para participar",
    "como faco para participar",
    "quero participar",
    "quero entrar",
    "como faço pra entrar",
    "como faco pra entrar",
    "como faço para entrar",
    "como faco para entrar",
    "o que preciso fazer para participar",
    "oq preciso fazer para participar",
    "o que eu preciso fazer para participar",
    "oq eu preciso fazer para participar",
    "qual o proximo passo",
    "qual o próximo passo",
    "como sigo",
    "como seguir",
    "podemos seguir"
  ];

  return patterns.some(pattern => t.includes(pattern));
}

function isStrongBuyIntent(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (isCadastroOuParticipacaoIntent(text)) {
    return true;
  }
   
  const patterns = [
    "vamos negociar",
    "vamos fechar",
    "quero entrar",
    "quero comecar",
    "como faco pra entrar",
    "bora",
    "bora seguir",
    "quero seguir",
    "pode iniciar",
    "vamos seguir",
    "tenho interesse",
    "quero participar",
    "quero aderir"
  ];

  return patterns.some(p => t.includes(p));
}

const VALID_UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO"
];

const MAX_REENGAGEMENT_ATTEMPTS_BEFORE_AFFILIATE = 3;
const MAX_TOTAL_RECOVERY_ATTEMPTS = 6;

function isLeadRejectingOrCooling(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  // Evita falso positivo:
  // Se a SDR perguntou "ficou alguma dúvida?" e o lead respondeu "não",
  // isso significa "não tenho dúvida", não rejeição.
  const respostasCurtasQueNaoSaoRejeicao = [
    "nao",
    "não",
    "n",
    "ok",
    "sim",
    "s",
    "entendi",
    "certo",
    "show",
    "beleza",
    "perfeito"
  ];

  if (respostasCurtasQueNaoSaoRejeicao.includes(t)) {
    return false;
  }

  const patterns = [
    // rejeição direta
    "nao tenho interesse",
    "não tenho interesse",
    "nao me interessa",
    "não me interessa",
    "sem interesse",
    "perdi o interesse",
    "nao quero",
    "não quero",
    "nao quero mais",
    "não quero mais",
    "nao vou querer",
    "não vou querer",
    "nao pretendo seguir",
    "não pretendo seguir",
    "nao quero seguir",
    "não quero seguir",
    "nao quero continuar",
    "não quero continuar",

    // não faz sentido / não é para mim
    "nao e pra mim",
    "não é pra mim",
    "nao eh pra mim",
    "nao faz sentido",
    "não faz sentido",
    "nao vejo sentido",
    "não vejo sentido",
    "nao serve pra mim",
    "não serve pra mim",
    "nao combina comigo",
    "não combina comigo",

    // abandono natural de WhatsApp
    "deixamos",
    "deixa",
    "deixa assim",
    "deixa quieto",
    "deixa pra la",
    "deixa pra lá",
    "deixa para la",
    "deixa para lá",
    "vamos deixar",
    "melhor deixar",
    "melhor deixar assim",
    "pode deixar",
    "fica assim",
    "fica pra proxima",
    "fica pra próxima",
    "fica para proxima",
    "fica para próxima",
    "fica para depois",
    "fica pra depois",

    // pedido de encerramento
    "encerra",
    "pode encerrar",
    "pode finalizar",
    "finaliza",
    "finalizar",
    "cancela",
    "cancelar",
    "pode cancelar",
    "encerra ai",
    "encerra aí",
    "fecha ai",
    "fecha aí",
    "fecha por enquanto",

    // adiamento / esfriamento
    "vou pensar",
    "vou analisar",
    "vou avaliar",
    "vou ver depois",
    "vejo depois",
    "talvez depois",
    "mais pra frente",
    "mais para frente",
    "outro momento",
    "outra hora",
    "agora nao",
    "agora não",
    "agora nao da",
    "agora não dá",
    "nao posso agora",
    "não posso agora",
    "nao consigo agora",
    "não consigo agora",

    // preço / taxa / dinheiro
    "achei caro",
    "muito caro",
    "caro demais",
    "taxa alta",
    "valor alto",
    "achei alto",
    "muito alto",
    "ficou pesado",
    "pesado pra mim",
    "pesado para mim",
    "nao tenho dinheiro",
    "não tenho dinheiro",
    "sem dinheiro",
    "sem dinheiro agora",
    "nao tenho esse valor",
    "não tenho esse valor",
    "nao consigo pagar",
    "não consigo pagar",
    "nao posso pagar",
    "não posso pagar",

    // rejeição do modelo
    "nao quero estoque",
    "não quero estoque",
    "nao quero produto fisico",
    "não quero produto físico",
    "nao quero mexer com estoque",
    "não quero mexer com estoque",
    "nao quero pagar taxa",
    "não quero pagar taxa",
    "nao quero pagar adesao",
    "não quero pagar adesão",
    "nao quero adesao",
    "não quero adesão"
  ];

  return patterns.some(pattern => t.includes(pattern));
}


function leadHasFinishedPreCadastro(lead = {}) {
  return Boolean(
    lead?.dadosConfirmadosPeloLead === true ||
    lead?.crmEnviado === true ||
    lead?.statusOperacional === "enviado_crm" ||
    lead?.faseFunil === "crm" ||
    lead?.faseQualificacao === "enviado_crm" ||
    lead?.status === "enviado_crm"
  );
}

function isCriticalCommercialBlockedState({
  lead = {},
  awaitingConfirmation = false
} = {}) {
  const fase = lead?.faseQualificacao || "";
  const status = lead?.status || "";
  const faseFunil = lead?.faseFunil || "";

  const fasesBloqueadas = [
    "coletando_dados",
    "dados_parciais",
    "aguardando_dados",
    "aguardando_confirmacao_campo",
    "aguardando_confirmacao_dados",
    "corrigir_dado",
    "corrigir_dado_final",
    "aguardando_valor_correcao_final"
  ];

  return Boolean(
    awaitingConfirmation ||
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true ||
    fasesBloqueadas.includes(fase) ||
    fasesBloqueadas.includes(status) ||
    faseFunil === "coleta_dados" ||
    faseFunil === "confirmacao_dados"
  );
}

function shouldRecoverLeadBeforeLoss({
  text = "",
  lead = {},
  awaitingConfirmation = false
} = {}) {
  if (!isLeadRejectingOrCooling(text)) {
    return false;
  }

  if (leadHasFinishedPreCadastro(lead)) {
    return false;
  }

  if (
    isCriticalCommercialBlockedState({
      lead,
      awaitingConfirmation
    })
  ) {
    return false;
  }

  return true;
}

function buildHomologadoRecoveryResponse(attempt = 1, firstName = "") {
  const namePart = firstName ? `${firstName}, ` : "";

  if (attempt <= 1) {
    return `${namePart}entendo sua posição 😊

Mas antes de você descartar, deixa eu te explicar um ponto importante: o Parceiro Homologado não é só uma taxa.

Você recebe estrutura, suporte, treinamento e um lote inicial em comodato para começar com produtos em mãos, sem precisar comprar esse estoque.

A ideia é justamente te dar uma base para vender com mais segurança.

O que mais te travou hoje: o valor da taxa, o modelo com estoque ou a insegurança de não vender?`;
  }

  if (attempt === 2) {
    return `${namePart}super entendo você analisar com cuidado.

O ponto principal é comparar o investimento com o que o programa entrega: suporte da indústria, treinamento, materiais e lote inicial em comodato representando mais de R$ 5.000,00 em preço de venda.

E importante: pagamento não acontece agora. Só depois da análise interna e contrato.

Se eu te mostrar um caminho mais simples para começar, sem estoque e sem taxa do Homologado, faria mais sentido pra você?`;
  }

  return `${namePart}pra não te deixar sem opção, existe também um caminho mais leve dentro da IQG 😊

Se o investimento ou o estoque do Parceiro Homologado não fizer sentido agora, você pode começar pelo Programa de Afiliados.

Nele você não precisa ter estoque, não compra produtos e não paga a taxa de adesão do Homologado.

Quer que eu te explique essa alternativa?`;
}

function buildMandatoryAffiliateAlternativeResponse(firstName = "") {
  const namePart = firstName ? `${firstName}, ` : "";

  return `${namePart}entendo totalmente 😊

Então talvez o melhor caminho agora seja começar pelo Programa de Afiliados IQG.

Ele é separado do Parceiro Homologado: você não precisa ter estoque, não precisa comprar produtos e não paga a taxa de adesão do Homologado.

Você faz o cadastro, gera seus links exclusivos e divulga os produtos online. Quando uma venda feita pelo seu link é validada, você recebe comissão.

O cadastro é por aqui:
https://minhaiqg.com.br/

Esse caminho mais simples faria mais sentido pra você começar?`;
}

function isSoftUnderstandingConfirmation(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const softPatterns = [
    /^ok$/,
    /^ok obrigado$/,
    /^ok obrigada$/,
    /^sim$/,
    /^s$/,
    /^sei sim$/,
    /^entendi$/,
    /^entendi sim$/,
    /^certo$/,
    /^ta certo$/,
    /^tá certo$/,
    /^legal$/,
    /^show$/,
    /^beleza$/,
    /^blz$/,
    /^perfeito$/,
    /^top$/,
    /^faz sentido$/,
    /^fez sentido$/,
    /^fez sentido sim$/,
    /^faz sentido sim$/,
    /^foi bem explicativo$/,
    /^foi bem explicado$/,
    /^ficou claro$/,
    /^ficou claro sim$/,
    /^esta claro$/,
    /^está claro$/
  ];

  return softPatterns.some(pattern => pattern.test(t));
}

function isExplicitPreAnalysisIntent(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (isCadastroOuParticipacaoIntent(text)) {
    return true;
  }
   
  const patterns = [
    /^quero seguir$/,
    /^quero continuar$/,
    /^quero avancar$/,
    /^quero avançar$/,
    /^podemos seguir$/,
    /^podemos avancar$/,
    /^podemos avançar$/,
    /^pode seguir$/,
    /^pode continuar$/,
    /^pode avancar$/,
    /^pode avançar$/,
    /^vamos seguir$/,
    /^vamos avancar$/,
    /^vamos avançar$/,
    /^bora seguir$/,
    /^bora$/,
    /^bora la$/,
    /^bora lá$/,
    /^sim, pode seguir$/,
    /^sim pode seguir$/,
    /^sim, vamos seguir$/,
    /^sim vamos seguir$/,
    /^claro$/,
    /^claro que sim$/,
    /^com certeza$/,
    /^tenho interesse$/,
    /^tenho interesse sim$/,
    /^quero participar$/,
    /^quero entrar$/,
    /^quero fazer a pre analise$/,
    /^quero fazer a pré análise$/,
    /^quero fazer a pre-analise$/,
    /^quero fazer a pré-análise$/,
    /^pode iniciar$/,
    /^inicia$/,
    /^iniciar$/,
    /^vamos nessa$/,

    // expressões naturais de WhatsApp
    /^mete bala$/,
    /^manda ver$/,
    /^manda bala$/,
    /^demorou$/,
    /^fechou$/,
    /^fechado$/,
    /^toca ficha$/,
    /^segue$/,
    /^segue ai$/,
    /^segue aí$/,
    /^vai em frente$/,
    /^pode tocar$/,
    /^pode mandar$/,
    /^manda$/,
    /^partiu$/,
    /^show, pode seguir$/,
    /^show pode seguir$/,
    /^top, pode seguir$/,
    /^top pode seguir$/
  ];

  return patterns.some(pattern => pattern.test(t));
}

function mentionsPaymentIntent(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return (
    t.includes("pagamento") ||
    t.includes("pagar") ||
    t.includes("pix") ||
    t.includes("cartao") ||
    t.includes("cartão") ||
    t.includes("boleto") ||
    t.includes("transferencia") ||
    t.includes("transferência") ||
    t.includes("como pago") ||
    t.includes("quero pagar") ||
    t.includes("ja quero pagar") ||
    t.includes("já quero pagar")
  );
}

function buildPreSdrConsultantFallbackAdvice({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  const memory = buildConversationMemoryForAgents({
    lead,
    history,
    lastUserText,
    lastSdrText
  });

  const missingSteps = getMissingFunnelStepLabels(lead || {});
  const isDataFlow = isDataFlowState(lead || {});
  const hasPayment = mentionsPaymentIntent(lastUserText);
  const hasQuestionOrObjection = isLeadQuestionObjectionOrCorrection(lastUserText);
  const isShortNeutral = isShortNeutralLeadReply(lastUserText);
  const currentStage = getCurrentFunnelStage(lead || {});

  if (isDataFlow) {
    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: "corrigir_conducao_sdr",
      proximaMelhorAcao: "Responder somente se houver dúvida real do lead e retomar o ponto pendente da coleta/confirmação/correção de dados.",
      abordagemSugerida: "Tom curto, seguro e objetivo. Não abrir nova rota comercial.",
      argumentoPrincipal: "A conversa está em coleta, confirmação ou correção de dados; o foco é concluir esse ponto sem misturar temas.",
      cuidadoPrincipal: "Não falar taxa, Afiliados, cadastro ou pré-análise fora do ponto pendente.",
      ofertaMaisAdequada: lead?.rotaComercial || "homologado",
      momentoIdealHumano: "nao_necessario_agora",
      prioridadeComercial: "media",
      resumoConsultivo: "Fallback do Consultor Pré-SDR: como o lead está em fluxo de dados, a SDR deve preservar a coleta/correção e evitar qualquer rota comercial.",
      consultadoEm: new Date()
    };
  }

  if (hasPayment) {
    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: "corrigir_conducao_sdr",
      proximaMelhorAcao: "Responder que pagamento não acontece agora e conduzir de volta para a etapa correta do funil.",
      abordagemSugerida: "Tom calmo e seguro. Validar o interesse sem conduzir pagamento.",
      argumentoPrincipal: "O pagamento só acontece depois da análise interna e assinatura do contrato.",
      cuidadoPrincipal: "Não pedir pagamento, não enviar dados de pagamento e não tratar PIX/cartão como próximo passo imediato.",
      ofertaMaisAdequada: "homologado",
      momentoIdealHumano: "se_houver_nova_objecao",
      prioridadeComercial: "alta",
      resumoConsultivo: "Fallback do Consultor Pré-SDR: lead mencionou pagamento. A SDR deve frear com segurança e continuar o funil correto.",
      consultadoEm: new Date()
    };
  }

  if (isTaxaObjectionAgainstInvestment(lastUserText)) {
    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: "tratar_objecao_taxa",
      proximaMelhorAcao: "Tratar a objeção de taxa com acolhimento e valor percebido, sem oferecer Afiliados cedo demais.",
      abordagemSugerida: "Tom consultivo, curto e sem pressão.",
      argumentoPrincipal: "A taxa não é compra de mercadoria, caução ou garantia; ela está ligada à ativação, suporte, treinamento e lote em comodato.",
      cuidadoPrincipal: "Não transformar objeção de preço em Afiliado automaticamente. Não pedir dados.",
      ofertaMaisAdequada: "homologado",
      momentoIdealHumano: "se_houver_nova_objecao",
      prioridadeComercial: "alta",
      resumoConsultivo: "Fallback do Consultor Pré-SDR: lead trouxe resistência ao investimento. A SDR deve tratar a objeção sem pular etapas.",
      consultadoEm: new Date()
    };
  }

  if (isAffiliateIntent(lastUserText)) {
    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: "oferecer_afiliado",
      proximaMelhorAcao: "Responder diretamente sobre o Programa de Afiliados, sem misturar com pré-análise do Homologado.",
      abordagemSugerida: "Tom simples e direto.",
      argumentoPrincipal: "Afiliados é um programa separado, por link, sem estoque e sem taxa de adesão do Homologado.",
      cuidadoPrincipal: "Não falar lote em comodato, taxa do Homologado ou coleta de CPF.",
      ofertaMaisAdequada: "afiliado",
      momentoIdealHumano: "nao_necessario_agora",
      prioridadeComercial: "media",
      resumoConsultivo: "Fallback do Consultor Pré-SDR: lead demonstrou intenção direta de Afiliados. A SDR deve responder somente sobre Afiliados.",
      consultadoEm: new Date()
    };
  }

  if (isCadastroOuParticipacaoIntent(lastUserText)) {
    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: canStartDataCollection(lead || {})
        ? "avancar_pre_analise"
        : "manter_nutricao",
      proximaMelhorAcao: canStartDataCollection(lead || {})
        ? "Conduzir para início da pré-análise, pedindo apenas o nome completo."
        : `Explicar que antes do cadastro faltam etapas obrigatórias: ${missingSteps.join(", ") || "nenhuma"}.`,
      abordagemSugerida: "Tom positivo, mas sem pular etapas.",
      argumentoPrincipal: canStartDataCollection(lead || {})
        ? "Como as etapas obrigatórias já foram alinhadas, pode iniciar a coleta passo a passo."
        : "O cadastro só deve avançar depois de alinhar os pontos obrigatórios do funil.",
      cuidadoPrincipal: "Não pedir CPF ou outros dados antes da fase correta.",
      ofertaMaisAdequada: lead?.rotaComercial || "homologado",
      momentoIdealHumano: "nao_necessario_agora",
      prioridadeComercial: "alta",
      resumoConsultivo: "Fallback do Consultor Pré-SDR: lead pediu cadastro/participação. A SDR deve conduzir com segurança, respeitando as pendências do funil.",
      consultadoEm: new Date()
    };
  }

  if (isShortNeutral) {
    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: "manter_nutricao",
      proximaMelhorAcao: "Não repetir a mesma explicação. Conduzir para o próximo passo natural da fase atual.",
      abordagemSugerida: "Tom curto e natural, com uma pergunta simples.",
      argumentoPrincipal: "Resposta curta indica recebimento/entendimento, não intenção forte.",
      cuidadoPrincipal: "Não iniciar pré-análise apenas com resposta curta.",
      ofertaMaisAdequada: lead?.rotaComercial || "homologado",
      momentoIdealHumano: "nao_necessario_agora",
      prioridadeComercial: "media",
      resumoConsultivo: "Fallback do Consultor Pré-SDR: lead respondeu de forma curta/neutra. A SDR deve evitar loop e conduzir para a próxima etapa pendente.",
      consultadoEm: new Date()
    };
  }

  if (hasQuestionOrObjection) {
    return {
      ...buildDefaultConsultantAdvice(),
      estrategiaRecomendada: "manter_nutricao",
      proximaMelhorAcao: "Responder primeiro a dúvida ou manifestação atual do lead e depois conduzir para a etapa pendente.",
      abordagemSugerida: "Tom consultivo, claro e objetivo.",
      argumentoPrincipal: "A última mensagem do lead deve ser respondida antes de seguir roteiro.",
      cuidadoPrincipal: "Não ignorar a pergunta, não repetir explicação longa e não pular etapa.",
      ofertaMaisAdequada: lead?.rotaComercial || "homologado",
      momentoIdealHumano: "nao_necessario_agora",
      prioridadeComercial: "media",
      resumoConsultivo: "Fallback do Consultor Pré-SDR: lead trouxe dúvida/objeção. A SDR deve responder primeiro e conduzir em seguida.",
      consultadoEm: new Date()
    };
  }

  return {
    ...buildDefaultConsultantAdvice(),
    estrategiaRecomendada: "manter_nutricao",
    proximaMelhorAcao: `Conduzir para a próxima etapa natural do funil. Etapa atual calculada: ${currentStage}. Pendências: ${missingSteps.join(", ") || "nenhuma"}.`,
    abordagemSugerida: "Tom simples, humano e consultivo.",
    argumentoPrincipal: "Manter continuidade sem pular etapas.",
    cuidadoPrincipal: "Não pedir dados, não falar pagamento e não avançar para pré-análise se houver pendências.",
    ofertaMaisAdequada: lead?.rotaComercial || "homologado",
    momentoIdealHumano: "nao_necessario_agora",
    prioridadeComercial: "media",
    resumoConsultivo: `Fallback do Consultor Pré-SDR usando memória conversacional. Alertas: ${(memory?.alertasParaAgentes || []).join(" | ") || "sem alertas"}`,
    consultadoEm: new Date()
  };
}

function enforcePreSdrConsultantHardLimits({
  advice = {},
  lead = {},
  lastUserText = ""
} = {}) {
  const safeAdvice = {
    ...buildDefaultConsultantAdvice(),
    ...(advice || {})
  };

  const missingSteps = getMissingFunnelStepLabels(lead);
  const canStartCollectionNow = canStartDataCollection(lead);
  const hasPaymentIntent = mentionsPaymentIntent(lastUserText);

  const adviceText = [
    safeAdvice.estrategiaRecomendada,
    safeAdvice.proximaMelhorAcao,
    safeAdvice.abordagemSugerida,
    safeAdvice.argumentoPrincipal,
    safeAdvice.cuidadoPrincipal,
    safeAdvice.resumoConsultivo
  ]
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const consultantSuggestedPreAnalysis =
    safeAdvice.estrategiaRecomendada === "avancar_pre_analise" ||
    adviceText.includes("pre-analise") ||
    adviceText.includes("pre analise") ||
    adviceText.includes("pré-analise") ||
    adviceText.includes("pré análise") ||
    adviceText.includes("preanalise");

  const consultantSuggestedPayment =
    adviceText.includes("pagamento") ||
    adviceText.includes("pagar") ||
    adviceText.includes("pix") ||
    adviceText.includes("cartao") ||
    adviceText.includes("cartão");

  if (hasPaymentIntent) {
    return {
      ...safeAdvice,
      estrategiaRecomendada: "corrigir_conducao_sdr",
      proximaMelhorAcao: `Responder que pagamento não acontece agora. Antes, a SDR deve conduzir a etapa correta do funil. Etapas ainda pendentes: ${missingSteps.join(", ") || "nenhuma"}.`,
      abordagemSugerida: "Tom calmo, seguro e direto. Validar o interesse do lead sem acelerar o processo.",
      argumentoPrincipal: "O pagamento só acontece depois da análise interna e da assinatura do contrato.",
      cuidadoPrincipal: "Não conduzir pagamento. Não pedir pagamento. Não enviar dados de pagamento. Não avançar para pré-análise se ainda faltarem etapas obrigatórias.",
      momentoIdealHumano: "se_houver_nova_objecao",
      prioridadeComercial: "alta",
      resumoConsultivo: `O lead mencionou pagamento. Isso deve ser tratado como tema sensível. A SDR deve frear com segurança, explicar que pagamento só ocorre após análise interna e contrato, e continuar a fase correta do funil. Etapas pendentes: ${missingSteps.join(", ") || "nenhuma"}.`
    };
  }

  if (consultantSuggestedPreAnalysis && !canStartCollectionNow) {
    return {
      ...safeAdvice,
      estrategiaRecomendada: "corrigir_conducao_sdr",
      proximaMelhorAcao: `Não avançar para pré-análise. Continuar a próxima etapa obrigatória do funil. Etapas ainda pendentes: ${missingSteps.join(", ") || "nenhuma"}.`,
      abordagemSugerida: "Tom consultivo e objetivo. Reconhecer o interesse do lead, mas explicar que ainda falta alinhar pontos obrigatórios antes da pré-análise.",
      argumentoPrincipal: "A pré-análise só deve acontecer depois que programa, benefícios, estoque, responsabilidades, investimento, compromisso e interesse real estiverem validados.",
      cuidadoPrincipal: "Não pedir dados. Não falar como se o lead já estivesse pronto. Não avançar para pré-análise apenas porque o lead pediu.",
      momentoIdealHumano: "nao_necessario_agora",
      prioridadeComercial: "media",
      resumoConsultivo: `O Consultor tentou orientar pré-análise, mas o backend bloqueou porque ainda faltam etapas obrigatórias: ${missingSteps.join(", ") || "nenhuma"}. A SDR deve seguir a fase atual.`
    };
  }

  if (consultantSuggestedPayment) {
    return {
      ...safeAdvice,
      estrategiaRecomendada: "corrigir_conducao_sdr",
      proximaMelhorAcao: "Remover qualquer condução de pagamento da orientação. Focar apenas na fase atual do funil.",
      abordagemSugerida: "Tom seguro e sem pressão.",
      argumentoPrincipal: "Pagamento só ocorre após análise interna e contrato.",
      cuidadoPrincipal: "Não conduzir pagamento.",
      momentoIdealHumano: "se_houver_nova_objecao",
      prioridadeComercial: "alta",
      resumoConsultivo: "A orientação do Consultor mencionou pagamento. O backend corrigiu para impedir condução indevida de pagamento."
    };
  }

  return safeAdvice;
}

function getMissingFunnelStepLabels(lead = {}) {
  const e = lead?.etapas || {};
  const missing = [];

  if (!e.programa) {
    missing.push("programa");
  }

  if (!e.beneficios) {
    missing.push("benefícios");
  }

  if (!e.estoque) {
    missing.push("estoque em comodato");
  }

  if (!e.responsabilidades) {
    missing.push("responsabilidades");
  }

  if (!e.investimento) {
    missing.push("investimento");
  }

if (lead?.taxaAlinhada !== true) {
  missing.push("alinhamento claro da taxa");
}
   
  if (!e.compromisso) {
    missing.push("compromisso de atuação");
  }

  if (lead?.interesseReal !== true) {
    missing.push("interesse real explícito");
  }

  return missing;
}

function normalizeUF(value = "") {
  const text = String(value).trim().toUpperCase();

  const estados = {
    "ACRE": "AC",
    "ALAGOAS": "AL",
    "AMAPA": "AP",
    "AMAPÁ": "AP",
    "AMAZONAS": "AM",
    "BAHIA": "BA",
    "CEARA": "CE",
    "CEARÁ": "CE",
    "DISTRITO FEDERAL": "DF",
    "ESPIRITO SANTO": "ES",
    "ESPÍRITO SANTO": "ES",
    "GOIAS": "GO",
    "GOIÁS": "GO",
    "MARANHAO": "MA",
    "MARANHÃO": "MA",
    "MATO GROSSO": "MT",
    "MATO GROSSO DO SUL": "MS",
    "MINAS GERAIS": "MG",
    "PARA": "PA",
    "PARÁ": "PA",
    "PARAIBA": "PB",
    "PARAÍBA": "PB",
    "PARANA": "PR",
    "PARANÁ": "PR",
    "PERNAMBUCO": "PE",
    "PIAUI": "PI",
    "PIAUÍ": "PI",
    "RIO DE JANEIRO": "RJ",
    "RIO GRANDE DO NORTE": "RN",
    "RIO GRANDE DO SUL": "RS",
    "RONDONIA": "RO",
    "RONDÔNIA": "RO",
    "RORAIMA": "RR",
    "SANTA CATARINA": "SC",
    "SAO PAULO": "SP",
    "SÃO PAULO": "SP",
    "SERGIPE": "SE",
    "TOCANTINS": "TO"
  };

  if (/^[A-Z]{2}$/.test(text)) {
  return VALID_UFS.includes(text) ? text : "";
}
   
  return estados[text] || text;
}

function extractExpectedFieldData({
  field = "",
  text = "",
  currentLead = {}
} = {}) {
  const result = {};
  const cleanText = String(text || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!field || !cleanText) {
    return result;
  }

if (
  ["cidade", "estado"].includes(field) &&
  isInvalidLocationCandidate(cleanText)
) {
  return result;
}
   
  // Evita transformar perguntas ou correções em cidade/estado.
  // Exemplo: "nome está errado" não pode virar cidade.
  const hasQuestionOrCorrection =
    /[?]/.test(cleanText) ||
    /\b(como|porque|por que|duvida|dúvida|sugestao|sugestão|errado|errada|incorreto|incorreta|corrigir|correcao|correção)\b/i.test(cleanText);

  if (hasQuestionOrCorrection) {
    return result;
  }

  // Evita misturar outros dados pessoais com cidade/estado.
  const mentionsOtherPersonalData =
    /\b(nome|cpf|telefone|celular|whatsapp)\b/i.test(cleanText);

  if (
    mentionsOtherPersonalData &&
    !["nome", "cpf", "telefone"].includes(field)
  ) {
    return result;
  }

  if (field === "cidade") {
    // Caso: "Cidade Paraí estado Rio Grande do Sul"
    const labeledCityStateMatch = cleanText.match(
      /\bcidade\s*(?:é|e|:|-)?\s*([A-Za-zÀ-ÿ.'\-\s]{2,}?)(?:\s+(?:estado|uf)\s*(?:é|e|:|-)?\s*([A-Za-zÀ-ÿ\s]{2,}|[A-Z]{2}))?$/i
    );

    if (labeledCityStateMatch?.[1]) {
      const cidade = labeledCityStateMatch[1].trim();
      const estado = labeledCityStateMatch[2]
        ? normalizeUF(labeledCityStateMatch[2])
        : "";

      if (cidade && !VALID_UFS.includes(normalizeUF(cidade))) {
        result.cidade = cidade;
      }

      if (estado && VALID_UFS.includes(estado)) {
        result.estado = estado;
      }

      if (result.cidade || result.estado) {
        return result;
      }
    }

    // Caso: "Rio Grande do Sul, Paraí" ou "Paraí, RS"
    const parts = cleanText
      .split(/[\/,;-]/)
      .map(part => part.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      let cidade = "";
      let estado = "";

      for (const part of parts) {
        const possibleUf = normalizeUF(part);

        if (VALID_UFS.includes(possibleUf)) {
          estado = possibleUf;
        } else if (!cidade && /^[A-Za-zÀ-ÿ.'\-\s]{2,50}$/.test(part)) {
          cidade = part;
        }
      }

      if (cidade) {
        result.cidade = cidade;
      }

      if (estado) {
        result.estado = estado;
      }

      if (result.cidade || result.estado) {
        return result;
      }
    }

    // Caso: "Paraí RS"
    const cityUfMatch = cleanText.match(
      /^\s*([A-Za-zÀ-ÿ.'\-\s]{2,})\s+(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\s*$/i
    );

    if (cityUfMatch) {
      result.cidade = cityUfMatch[1].trim();
      result.estado = normalizeUF(cityUfMatch[2]);
      return result;
    }

    // Caso: lead respondeu só o estado quando o sistema esperava cidade.
    // Exemplo: "Rio Grande do Sul". Nesse caso salva estado, mas ainda faltará cidade.
    const possibleOnlyUf = normalizeUF(cleanText);

    if (VALID_UFS.includes(possibleOnlyUf)) {
      result.estado = possibleOnlyUf;
      return result;
    }

    // Caso principal: SDR perguntou cidade e lead respondeu apenas "Paraí".
    const possibleCity = cleanText
      .replace(/\b(minha cidade|cidade|moro em|sou de|resido em)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (
  /^[A-Za-zÀ-ÿ.'\-\s]{2,50}$/.test(possibleCity) &&
  !VALID_UFS.includes(normalizeUF(possibleCity)) &&
  !isInvalidLocationCandidate(possibleCity)
) {
  result.cidade = possibleCity;
  return result;
}
  }
   
  if (field === "estado") {
    const cleanState = cleanText
      .replace(/\b(estado|uf)\b/gi, "")
      .replace(/[:\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const possibleUf = normalizeUF(cleanState);

    if (VALID_UFS.includes(possibleUf)) {
      result.estado = possibleUf;
      return result;
    }
  }

  return result;
}

async function saveHistoryStep(from, history, userText, botText, isAudio = false) {
  history.push({
    role: "user",
    content: isAudio ? `[Áudio transcrito]: ${userText}` : userText
  });

  history.push({
    role: "assistant",
    content: botText
  });

  history = history.slice(-20);
  await saveConversation(from, history);
}

function buildBackendDecision({
  tipo = "",
  motivo = "",
  acao = "",
  mensagemLead = "",
  detalhes = {}
} = {}) {
  return {
    tipo,
    motivo,
    acao,
    mensagemLead: String(mensagemLead || "").slice(0, 1000),
    detalhes: detalhes || {},
    registradaEm: new Date()
  };
}

async function finalizeHandledResponse({
  from,
  history,
  userText,
  botText,
  isAudio = false,
  messageId = null,
  messageIds = [],
  shouldScheduleFollowups = false
} = {}) {
  await sendWhatsAppMessage(from, botText);
  await saveHistoryStep(from, history, userText, botText, isAudio);

  if (shouldScheduleFollowups) {
    scheduleLeadFollowups(from);
  }

  const idsToMark = Array.isArray(messageIds) && messageIds.length > 0
    ? messageIds
    : [messageId].filter(Boolean);

  markMessageIdsAsProcessed(idsToMark);
}

function canStartDataCollection(lead = {}) {
  const e = lead.etapas || {};

  return Boolean(
    e.programa === true &&
    e.beneficios === true &&
    e.estoque === true &&
    e.responsabilidades === true &&
    e.investimento === true &&
    lead.taxaAlinhada === true &&
    e.compromisso === true &&
    lead.interesseReal === true
  );
}

function canAskForRealInterest(lead = {}) {
  const e = lead.etapas || {};

  return Boolean(
    e.programa === true &&
    e.beneficios === true &&
    e.estoque === true &&
    e.responsabilidades === true &&
    e.investimento === true &&
    lead.taxaAlinhada === true &&
    e.compromisso === true &&
    lead.interesseReal !== true
  );
}

function buildCadastroIntentResponse(lead = {}, firstName = "") {
  const namePart = firstName ? `${firstName}, ` : "";
  const missingSteps = getMissingFunnelStepLabels(lead);

  if (canStartDataCollection(lead)) {
    return `${namePart}perfeito 😊

Como os pontos principais já estão alinhados, podemos seguir com a pré-análise.

Primeiro, pode me enviar seu nome completo?`;
  }

  return `${namePart}perfeito, eu te ajudo com isso 😊

Para seguir com o cadastro do Parceiro Homologado, antes eu preciso alinhar alguns pontos obrigatórios com você: ${missingSteps.join(", ")}.

Isso é importante para você entrar consciente, sem pular etapa e sem assumir compromisso antes de entender tudo.

Vou seguir pelo próximo ponto agora:

${getNextFunnelStepMessage(lead)}`;
}

// 👇 COLE AQUI EMBAIXO 👇
function getNextFunnelStepMessage(lead = {}) {
  const e = lead.etapas || {};

  if (!e.programa) {
    return "Vou te explicar de forma direta como funciona o programa.\n\nÉ uma parceria comercial onde você vende produtos da IQG com suporte da indústria e uma estrutura pensada para começar de forma organizada.";
  }

  if (!e.beneficios) {
    return "Ótimo! O próximo ponto são os benefícios.\n\nVocê não começa sozinho: recebe suporte, materiais, treinamento e orientação para vender com mais segurança.";
  }

  if (!e.estoque) {
    return "Vamos falar do estoque inicial.\n\nVocê começa com um lote estratégico de produtos em comodato. Isso significa que você não compra esse estoque: ele continua sendo da IQG, mas fica com você para operação, demonstração e venda.\n\nE um ponto importante: quando você vender os produtos, poderá solicitar reposição também em comodato. Ou seja, você não precisa comprar estoque para repor. Conforme suas vendas crescerem, a IQG pode avaliar aumentar o volume de produtos cedidos em comodato.";
  }

  if (!e.responsabilidades) {
    return "Agora preciso alinhar as responsabilidades.\n\nComo parceiro, você fica responsável pela guarda, conservação dos produtos e pela comunicação correta das vendas.";
  }

  if (!e.investimento) {
  return `Show! Agora falta explicar o investimento com transparência 😊

Existe uma taxa de adesão e implantação de R$ 1.990,00.

Mas é importante entender que esse valor não é compra de mercadoria, não é caução e não é garantia.

Ele faz parte da ativação no programa, acesso à estrutura da IQG, suporte, treinamentos e liberação do lote inicial em comodato.

Pra você ter uma referência prática: só o lote inicial representa mais de R$ 5.000,00 em preço de venda ao consumidor final.

Além disso, quando o parceiro vende seguindo o preço sugerido ao consumidor, a margem é de 40%.

E se vender com ágio, acima do preço sugerido, essa diferença fica com o parceiro, então a margem pode ser maior.

As primeiras vendas podem ajudar a recuperar esse investimento inicial, mas isso depende da sua atuação comercial e das vendas realizadas.

Esse investimento pode ser feito via PIX ou parcelado em até 10x de R$ 199,00 no cartão, dependendo da disponibilidade no momento.

E o pagamento só acontece depois da análise interna e da assinatura do contrato.

Faz sentido pra você nesse formato?`;
}

if (lead.taxaAlinhada !== true) {
  return `Antes de falar da próxima etapa, quero só confirmar se o investimento ficou claro pra você 😊

A taxa de adesão e implantação é de R$ 1.990,00 e ela só é tratada depois da análise interna e da assinatura do contrato.

Ela não é compra de mercadoria, caução ou garantia. Ela faz parte da ativação no programa, suporte, treinamento e liberação do lote em comodato.

Você consegue me confirmar se essa parte do investimento faz sentido pra você?`;
}
   
  if (!e.compromisso) {
    return "Antes de avançarmos, só preciso confirmar um ponto importante \n\nVocê está de acordo que o resultado depende da sua atuação nas vendas?";
  }

 if (lead.interesseReal !== true) {
  if (lead.sinalInteresseInicial === true) {
    return `Você tinha comentado que queria seguir, e isso é ótimo!

Agora que já alinhamos programa, benefícios, estoque, responsabilidades, investimento e compromisso, posso seguir com a pré-análise?

Só reforçando: essa etapa ainda não é aprovação automática e não envolve pagamento neste momento. É apenas para a equipe IQG avaliar seus dados e orientar o próximo passo com segurança.`;
  }

  return `Com esses pontos claros, você tem interesse em seguir para a pré-análise agora?

Só reforçando: essa etapa ainda não é aprovação automática e não envolve pagamento neste momento. É apenas para a equipe IQG avaliar seus dados e orientar o próximo passo com segurança.`;
}
  return "Perfeito! Vamos seguir então.\n\nPrimeiro, pode me enviar seu nome completo?";
}

function getCurrentFunnelStage(lead = {}) {
  const e = lead.etapas || {};

  if (!e.programa) return 1;
  if (!e.beneficios) return 2;
  if (!e.estoque) return 3;
  if (!e.responsabilidades) return 4;
  if (!e.investimento) return 5;
  if (!e.compromisso) return 6;
  if (lead.interesseReal !== true) return 7;

  return 8; // coleta
}

function normalizeCommercialText(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function replyMentionsInvestment(text = "") {
  const t = normalizeCommercialText(text);

  return (
    t.includes("r$ 1.990") ||
    t.includes("r$1.990") ||
    t.includes("1990") ||
    t.includes("1.990") ||
    t.includes("taxa") ||
    t.includes("adesao") ||
    t.includes("adesão") ||
    t.includes("investimento") ||
    t.includes("parcelado") ||
    t.includes("10x") ||
    t.includes("pix") ||
    t.includes("cartao") ||
    t.includes("cartão")
  );
}

function replyAsksPersonalData(text = "") {
  const t = normalizeCommercialText(text);

  return (
    t.includes("nome completo") ||
    t.includes("me envie seu nome") ||
    t.includes("me manda seu nome") ||
    t.includes("qual seu nome") ||
    t.includes("seu cpf") ||
    t.includes("me envie seu cpf") ||
    t.includes("me passa seu cpf") ||
    t.includes("telefone com ddd") ||
    t.includes("numero com ddd") ||
    t.includes("número com ddd") ||
    t.includes("qual sua cidade") ||
    t.includes("qual seu estado") ||
    t.includes("sua cidade") ||
    t.includes("seu estado")
  );
}

function detectStageFromSdrReply(text = "") {
  const t = normalizeCommercialText(text);

  let detectedStage = 0;

  if (
    t.includes("programa") ||
    t.includes("parceria") ||
    t.includes("parceiro homologado") ||
    t.includes("como funciona")
  ) {
    detectedStage = Math.max(detectedStage, 1);
  }

  if (
    t.includes("beneficio") ||
    t.includes("beneficios") ||
    t.includes("suporte") ||
    t.includes("treinamento") ||
    t.includes("materiais")
  ) {
    detectedStage = Math.max(detectedStage, 2);
  }

  if (
    t.includes("estoque") ||
    t.includes("comodato") ||
    t.includes("lote inicial") ||
    t.includes("kit inicial") ||
    t.includes("pronta-entrega") ||
    t.includes("pronta entrega")
  ) {
    detectedStage = Math.max(detectedStage, 3);
  }

  if (
    t.includes("responsabilidade") ||
    t.includes("responsabilidades") ||
    t.includes("guarda") ||
    t.includes("conservacao") ||
    t.includes("conservação") ||
    t.includes("comunicacao correta") ||
    t.includes("comunicação correta")
  ) {
    detectedStage = Math.max(detectedStage, 4);
  }

  if (replyMentionsInvestment(text)) {
    detectedStage = Math.max(detectedStage, 5);
  }

  if (
    t.includes("resultado depende") ||
    t.includes("depende da sua atuacao") ||
    t.includes("depende da sua atuação") ||
    t.includes("atuacao nas vendas") ||
    t.includes("atuação nas vendas")
  ) {
    detectedStage = Math.max(detectedStage, 6);
  }

  if (
    t.includes("pre-analise") ||
    t.includes("pre análise") ||
    t.includes("pré-análise") ||
    t.includes("pre analise") ||
    replyAsksPersonalData(text)
  ) {
    detectedStage = Math.max(detectedStage, 8);
  }

  return detectedStage;
}

function getSafeCurrentPhaseResponse(lead = {}) {
  const e = lead.etapas || {};

  if (!e.programa) {
    return {
      message: `Vou te explicar de forma simples 😊

O Programa Parceiro Homologado IQG é uma parceria comercial onde você vende produtos da indústria com suporte, orientação e uma estrutura pensada para começar de forma organizada.

Antes de falar de valores ou próximos passos, preciso entender melhor seu objetivo: você busca uma renda extra ou algo mais estruturado?`,
      fileKey: null
    };
  }

  if (!e.beneficios) {
    return {
      message: `Ótimo 😊 O próximo ponto são os benefícios.

Você não começa sozinho: a IQG oferece suporte, materiais, treinamento e orientação para te ajudar a vender com mais segurança.

Pra te ajudar a visualizar melhor, vou te enviar um material explicativo bem direto.

Quando olhar, me diz: fez sentido pra você como funciona ou ficou alguma dúvida?`,
      fileKey: "folder"
    };
  }

  if (!e.estoque) {
    return {
     message: `Agora o próximo ponto é o estoque inicial.

Você começa com um lote estratégico de produtos em comodato. Isso significa que o estoque não é comprado por você: ele continua sendo da IQG, mas fica com você para operação, pronta-entrega, demonstração e venda.

Quando você vender os produtos, poderá solicitar reposição também em comodato. Então você não precisa comprar estoque para repor os itens vendidos.

O lote inicial representa mais de R$ 5.000,00 em preço de venda ao consumidor final, e esse volume pode aumentar com o tempo conforme suas vendas e sua evolução no programa.

Estoques maiores são tratados com a equipe IQG conforme o desempenho comercial do parceiro.

Faz sentido essa parte do comodato e da reposição pra você?`,
       
      fileKey: null
    };
  }

  if (!e.responsabilidades) {
    return {
      message: `Agora preciso alinhar uma parte importante: as responsabilidades do parceiro.

Como o lote fica em comodato, o parceiro fica responsável pela guarda, conservação dos produtos e pela comunicação correta das vendas.

Isso é importante porque o resultado depende da atuação do parceiro nas vendas, combinado?

Ficou claro esse ponto?`,
      fileKey: null
    };
  }

  if (!e.investimento) {
    return {
      message: `Antes de avançarmos, quero te explicar o investimento com total transparência 😊

Existe um investimento de adesão e implantação de R$ 1.990.

Mas é importante entender: esse valor não é compra de mercadoria, não é caução e não é garantia.

Ele é para ativação no programa, acesso à estrutura, suporte, treinamentos e liberação do lote inicial em comodato para você começar a operar.

Pra você ter uma referência prática: só o lote inicial de produtos representa mais de R$ 5.000 em preço de venda ao consumidor final.

Ou seja, você entra com acesso a produtos, estrutura e suporte sem precisar investir esse valor em estoque.

Esse investimento pode ser feito via PIX ou parcelado em até 10x de R$ 199 no cartão, dependendo da disponibilidade no momento.

E o pagamento só acontece depois da análise interna e da assinatura do contrato, tá?

Faz sentido pra você nesse formato?`,
      fileKey: null
    };
  }

if (lead.taxaAlinhada !== true) {
  return {
    message: `Antes de seguirmos, quero só confirmar se o investimento ficou claro pra você 😊

A taxa de adesão e implantação é de R$ 1.990,00 e só é tratada depois da análise interna e da assinatura do contrato.

Ela não é compra de mercadoria, caução ou garantia. Ela faz parte da ativação no programa, suporte, treinamento e liberação do lote em comodato.

Você consegue me confirmar se essa parte do investimento faz sentido pra você?`,
    fileKey: null
  };
}
   
  if (!e.compromisso) {
    return {
      message: `Antes de seguirmos para a pré-análise, só preciso confirmar um ponto importante 😊

Você está de acordo que o resultado depende da sua atuação nas vendas?`,
      fileKey: null
    };
  }

  if (lead.interesseReal !== true) {
  if (lead.sinalInteresseInicial === true) {
    return {
      message: `Você tinha comentado que queria seguir, e isso é ótimo 😊

Agora que já alinhamos os pontos obrigatórios, posso seguir com a pré-análise?

Só reforçando: essa etapa ainda não é aprovação automática e não envolve pagamento neste momento.`,
      fileKey: null
    };
  }

  return {
    message: `Pelo que conversamos até aqui, faz sentido seguir para a pré-análise agora?`,
    fileKey: null
  };
}

  return {
    message: `Perfeito 😊 Vamos seguir então.

Primeiro, pode me enviar seu nome completo?`,
    fileKey: null
  };
}

function enforceFunnelDiscipline({
  respostaFinal = "",
  currentLead = {},
  leadText = ""
} = {}) {
  const etapaAtual = getCurrentFunnelStage(currentLead);
  const etapaDetectadaNaResposta = detectStageFromSdrReply(respostaFinal);

  const falaDeInvestimento = replyMentionsInvestment(respostaFinal);
  const pedeDadosPessoais = replyAsksPersonalData(respostaFinal);
  const podeColetarDados = canStartDataCollection(currentLead);

  const leadTemPerguntaOuObjecao = isLeadQuestionObjectionOrCorrection(leadText);

  const tentouPularFase =
    etapaDetectadaNaResposta > 0 &&
    etapaDetectadaNaResposta > etapaAtual;

  const falouTaxaCedo =
    falaDeInvestimento &&
    etapaAtual < 5;

  const falouTaxaSemControle =
    falaDeInvestimento &&
    etapaAtual === 5;

  const pediuDadosCedo =
    pedeDadosPessoais &&
    !podeColetarDados;

  if (
    tentouPularFase ||
    falouTaxaCedo ||
    falouTaxaSemControle ||
    pediuDadosCedo
  ) {
    // 🧠 REGRA 25B-2:
    // Se o lead fez pergunta, objeção ou correção,
    // não trocar automaticamente a resposta da SDR por um bloco rígido de fase.
    // A SDR deve responder primeiro o lead.
    if (
      leadTemPerguntaOuObjecao &&
      !pediuDadosCedo
    ) {
      return {
        changed: false,
        respostaFinal,
        reason: {
          etapaAtual,
          etapaDetectadaNaResposta,
          tentouPularFase,
          falouTaxaCedo,
          falouTaxaSemControle,
          pediuDadosCedo,
          preservadoPorqueLeadPerguntou: true
        }
      };
    }

    const safeResponse = getSafeCurrentPhaseResponse(currentLead);

    return {
      changed: true,
      reason: {
        etapaAtual,
        etapaDetectadaNaResposta,
        tentouPularFase,
        falouTaxaCedo,
        falouTaxaSemControle,
        pediuDadosCedo,
        leadTemPerguntaOuObjecao
      },
      respostaFinal: safeResponse.message,
      fileKey: safeResponse.fileKey
    };
  }

  return {
    changed: false,
    respostaFinal
  };
}

function getLastAssistantMessage(history = []) {
  if (!Array.isArray(history)) return "";

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant") {
      return history[i]?.content || "";
    }
  }

  return "";
}

function isShortNeutralLeadReply(text = "") {
  const t = normalizeCommercialText(text);

  if (!t) return false;
  if (t.length > 45) return false;

  const neutralPatterns = [
    /^ok$/,
    /^ok obrigado$/,
    /^ok obrigada$/,
    /^sim$/,
    /^s$/,
    /^certo$/,
    /^ta certo$/,
    /^tá certo$/,
    /^entendi$/,
    /^entendi sim$/,
    /^legal$/,
    /^show$/,
    /^show de bola$/,
    /^beleza$/,
    /^blz$/,
    /^perfeito$/,
    /^top$/,
    /^aham$/,
    /^uhum$/,
    /^faz sentido$/,
    /^fez sentido$/,
    /^para mim faz sentido$/,
    /^pra mim faz sentido$/,
    /^combinado$/,
    /^tranquilo$/,
    /^ta bom$/,
    /^tá bom$/
  ];

  return neutralPatterns.some(pattern => pattern.test(t));
}

function detectReplyMainTheme(text = "") {
  const t = normalizeCommercialText(text);

  if (!t) return "";

  if (
    t.includes("afiliado") ||
    t.includes("link exclusivo") ||
    t.includes("divulgar por link") ||
    t.includes("comissao online") ||
    t.includes("comissão online")
  ) {
    return "afiliado";
  }

  if (
    replyAsksPersonalData(text) ||
    t.includes("pre-analise") ||
    t.includes("pre analise") ||
    t.includes("pré-análise") ||
    t.includes("preanalise")
  ) {
    return "coleta";
  }

  if (
    t.includes("resultado depende") ||
    t.includes("depende da sua atuacao") ||
    t.includes("depende da sua atuação") ||
    t.includes("atuacao nas vendas") ||
    t.includes("atuação nas vendas")
  ) {
    return "compromisso";
  }

  if (replyMentionsInvestment(text)) {
    return "investimento";
  }

  if (
    t.includes("responsabilidade") ||
    t.includes("responsabilidades") ||
    t.includes("guarda") ||
    t.includes("conservacao") ||
    t.includes("conservação") ||
    t.includes("comunicacao correta") ||
    t.includes("comunicação correta")
  ) {
    return "responsabilidades";
  }

  if (
    t.includes("estoque") ||
    t.includes("comodato") ||
    t.includes("lote inicial") ||
    t.includes("kit inicial") ||
    t.includes("pronta-entrega") ||
    t.includes("pronta entrega")
  ) {
    return "estoque";
  }

  if (
    t.includes("beneficio") ||
    t.includes("benefícios") ||
    t.includes("beneficios") ||
    t.includes("suporte") ||
    t.includes("treinamento") ||
    t.includes("materiais")
  ) {
    return "beneficios";
  }
   
  if (
    t.includes("programa") ||
    t.includes("parceria") ||
    t.includes("parceiro homologado") ||
    t.includes("como funciona")
  ) {
    return "programa";
  }

  return "";
}

function detectLeadMessageThemes(text = "") {
  const t = normalizeCommercialText(text);

  const themes = [];

  if (!t) {
    return themes;
  }

  if (
    t.includes("taxa") ||
    t.includes("valor") ||
    t.includes("preco") ||
    t.includes("preço") ||
    t.includes("investimento") ||
    t.includes("1990") ||
    t.includes("1.990") ||
    t.includes("pagar") ||
    t.includes("pagamento") ||
    t.includes("pix") ||
    t.includes("cartao") ||
    t.includes("cartão") ||
    t.includes("parcel") ||
    t.includes("caro")
  ) {
    themes.push("investimento");
  }

  if (
    t.includes("estoque") ||
    t.includes("comodato") ||
    t.includes("lote") ||
    t.includes("kit") ||
    t.includes("produto") ||
    t.includes("produtos") ||
    t.includes("reposicao") ||
    t.includes("reposição") ||
    t.includes("comprar estoque") ||
    t.includes("comprar produto")
  ) {
    themes.push("estoque");
  }

  if (
    t.includes("responsabilidade") ||
    t.includes("responsabilidades") ||
    t.includes("guardar") ||
    t.includes("guarda") ||
    t.includes("conservar") ||
    t.includes("conservacao") ||
    t.includes("conservação") ||
    t.includes("venda") ||
    t.includes("vender") ||
    t.includes("atuacao") ||
    t.includes("atuação")
  ) {
    themes.push("responsabilidades");
  }

  if (
    t.includes("afiliado") ||
    t.includes("afiliados") ||
    t.includes("link") ||
    t.includes("comissao") ||
    t.includes("comissão") ||
    t.includes("divulgar") ||
    t.includes("indicacao") ||
    t.includes("indicação") ||
    t.includes("minhaiqg")
  ) {
    themes.push("afiliado");
  }

  if (
    t.includes("contrato") ||
    t.includes("assinatura") ||
    t.includes("assinar") ||
    t.includes("juridico") ||
    t.includes("jurídico")
  ) {
    themes.push("contrato");
  }

  if (
    t.includes("cpf") ||
    t.includes("telefone") ||
    t.includes("celular") ||
    t.includes("whatsapp") ||
    t.includes("nome") ||
    t.includes("cidade") ||
    t.includes("estado") ||
    t.includes("uf") ||
    t.includes("dado") ||
    t.includes("dados")
  ) {
    themes.push("dados");
  }

  if (
    t.includes("como funciona") ||
    t.includes("programa") ||
    t.includes("parceria") ||
    t.includes("homologado") ||
    t.includes("homologacao") ||
    t.includes("homologação")
  ) {
    themes.push("programa");
  }

  if (
    t.includes("beneficio") ||
    t.includes("benefício") ||
    t.includes("beneficios") ||
    t.includes("benefícios") ||
    t.includes("suporte") ||
    t.includes("treinamento") ||
    t.includes("material") ||
    t.includes("materiais")
  ) {
    themes.push("beneficios");
  }

  return [...new Set(themes)];
}

function replyCoversLeadThemes({
  leadText = "",
  replyText = ""
} = {}) {
  const leadThemes = detectLeadMessageThemes(leadText);
  const replyThemes = detectLeadMessageThemes(replyText);

  if (leadThemes.length === 0) {
    return {
      hasThemesToCover: false,
      covered: true,
      missingThemes: [],
      leadThemes,
      replyThemes
    };
  }

  const missingThemes = leadThemes.filter(theme => !replyThemes.includes(theme));

  return {
    hasThemesToCover: true,
    covered: missingThemes.length === 0,
    missingThemes,
    leadThemes,
    replyThemes
  };
}

function buildUnansweredLeadThemeResponse({
  leadText = "",
  missingThemes = [],
  currentLead = {}
} = {}) {
  const firstTheme = missingThemes[0] || "";

  if (firstTheme === "investimento") {
    return buildShortTaxObjectionResponse({
      leadText
    });
  }

  if (firstTheme === "estoque") {
    return `Boa pergunta 😊

O estoque inicial do Parceiro Homologado é cedido em comodato. Isso significa que você não compra esse estoque: ele continua sendo da IQG, mas fica com você para operação, demonstração e venda.

Quando vender os produtos, você pode solicitar reposição também em comodato, conforme a operação, disponibilidade e alinhamento com a equipe IQG.

Ficou claro esse ponto do estoque?`;
  }

  if (firstTheme === "responsabilidades") {
    return `Sim, essa parte é importante 😊

Como parceiro, você fica responsável pela guarda, conservação dos produtos e pela comunicação correta das vendas.

E o resultado depende da sua atuação comercial: prospectar, atender clientes e conduzir as vendas com seriedade.

Esse ponto das responsabilidades faz sentido pra você?`;
  }

  if (firstTheme === "afiliado") {
    return buildAffiliateResponse(false);
  }

  if (firstTheme === "contrato") {
    return `Posso te explicar sobre o contrato 😊

A assinatura oficial acontece somente depois da análise cadastral da equipe IQG.

Antes disso, eu consigo te orientar sobre as regras principais do programa, responsabilidades, investimento e próximos passos, mas sem antecipar assinatura ou cobrança.

Quer que eu te explique como funciona essa etapa depois da pré-análise?`;
  }

  if (firstTheme === "dados") {
    if (isDataFlowState(currentLead || {})) {
      return buildDataFlowResumeMessage(currentLead || {});
    }

    return `Sobre os dados, a coleta só acontece na fase correta da pré-análise 😊

Antes disso, preciso garantir que você entendeu o programa, benefícios, estoque, responsabilidades e investimento.

Quer que eu siga pelo próximo ponto obrigatório?`;
  }

  if (firstTheme === "programa") {
    return `Claro 😊

O Programa Parceiro Homologado IQG é uma parceria comercial onde você vende produtos da indústria com suporte, treinamento e uma estrutura pensada para começar de forma organizada.

A ideia é você atuar com produtos físicos, lote em comodato e acompanhamento da IQG, seguindo as regras do programa.

Quer que eu te explique agora os principais benefícios?`;
  }

  if (firstTheme === "beneficios") {
    return `O principal benefício é que você não começa sozinho 😊

A IQG oferece suporte, materiais, treinamento e um lote inicial em comodato para você operar com mais segurança, sem precisar comprar estoque para iniciar.

Quer que eu te explique agora como funciona esse estoque inicial?`;
  }

  return `Boa pergunta 😊

Vou te responder esse ponto primeiro para não deixar nada solto.

Você pode me confirmar se a sua dúvida principal agora é sobre o funcionamento do programa, estoque, investimento ou próximos passos?`;
}

function buildMultiThemeLeadResponse({
  leadText = "",
  themes = [],
  currentLead = {}
} = {}) {
  const uniqueThemes = [...new Set(themes || [])];

  if (uniqueThemes.length <= 1) {
    return buildUnansweredLeadThemeResponse({
      leadText,
      missingThemes: uniqueThemes,
      currentLead
    });
  }

  const parts = [];

  if (uniqueThemes.includes("investimento")) {
    parts.push(`Sobre a taxa/investimento: existe a taxa de adesão e implantação de R$ 1.990,00.

Ela não é compra de mercadoria, caução ou garantia. Ela faz parte da ativação no programa, suporte, treinamento e liberação do lote em comodato.

O pagamento não acontece agora: só depois da análise interna e assinatura do contrato.`);
  }

  if (uniqueThemes.includes("estoque")) {
    parts.push(`Sobre o estoque: o lote inicial é cedido em comodato.

Isso significa que você não compra esse estoque. Ele continua sendo da IQG, mas fica com você para operação, demonstração e venda.

Quando vender os produtos, você pode solicitar reposição também em comodato, conforme operação, disponibilidade e alinhamento com a equipe IQG.`);
  }

  if (uniqueThemes.includes("responsabilidades")) {
    parts.push(`Sobre as responsabilidades: o parceiro fica responsável pela guarda, conservação dos produtos e comunicação correta das vendas.

E o resultado depende da atuação comercial do parceiro nas vendas.`);
  }

  if (uniqueThemes.includes("afiliado")) {
    parts.push(`Sobre Afiliados: é um programa separado do Parceiro Homologado.

No Afiliado, você divulga por link, não precisa ter estoque e não paga a taxa de adesão do Homologado.

O cadastro é por aqui:
https://minhaiqg.com.br/`);
  }

  if (uniqueThemes.includes("contrato")) {
    parts.push(`Sobre contrato: a assinatura oficial acontece somente depois da análise cadastral da equipe IQG.

Antes disso, eu consigo te orientar sobre regras, responsabilidades, investimento e próximos passos, mas sem antecipar assinatura ou cobrança.`);
  }

  if (uniqueThemes.includes("dados")) {
    if (isDataFlowState(currentLead || {})) {
      parts.push(`Sobre os dados: vamos manter o ponto pendente da pré-análise para não misturar as etapas.

${buildDataFlowResumeMessage(currentLead || {})}`);
    } else {
      parts.push(`Sobre dados/cadastro: a coleta só acontece na fase correta da pré-análise.

Antes disso, preciso garantir que você entendeu programa, benefícios, estoque, responsabilidades e investimento.`);
    }
  }

  if (uniqueThemes.includes("programa")) {
    parts.push(`Sobre o programa: o Parceiro Homologado IQG é uma parceria comercial onde você vende produtos da indústria com suporte, treinamento e uma estrutura pensada para começar de forma organizada.`);
  }

  if (uniqueThemes.includes("beneficios")) {
    parts.push(`Sobre os benefícios: você não começa sozinho.

A IQG oferece suporte, materiais, treinamento e lote inicial em comodato para operar com mais segurança, sem precisar comprar estoque para iniciar.`);
  }

  const responseParts = parts.filter(Boolean);

  if (responseParts.length === 0) {
    return buildUnansweredLeadThemeResponse({
      leadText,
      missingThemes: uniqueThemes,
      currentLead
    });
  }

  return `Ótimas perguntas, vou te responder por partes 👇

${responseParts.join("\n\n")}

Agora me diz: desses pontos, o que mais pesa na sua decisão hoje?`;
}


function enforceLeadQuestionWasAnswered({
  leadText = "",
  respostaFinal = "",
  currentLead = {}
} = {}) {
  const leadHadQuestionOrObjection = isLeadQuestionObjectionOrCorrection(leadText);

  if (!leadHadQuestionOrObjection) {
    return {
      changed: false,
      respostaFinal
    };
  }

  const coverage = replyCoversLeadThemes({
    leadText,
    replyText: respostaFinal
  });

  if (!coverage.hasThemesToCover || coverage.covered) {
    return {
      changed: false,
      respostaFinal,
      coverage
    };
  }

    const safeResponse = buildMultiThemeLeadResponse({
    leadText,
    themes: coverage.missingThemes,
    currentLead
  });

  return {
    changed: true,
    respostaFinal: safeResponse,
    reason: {
      tipo: "pergunta_ou_objecao_nao_respondida",
      leadThemes: coverage.leadThemes,
      replyThemes: coverage.replyThemes,
      missingThemes: coverage.missingThemes,
      respostaMultiTema: coverage.missingThemes.length > 1
    }
  };
}

function iqgNormalizeFunnelText(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"']/g, "")
    .replace(/[!?.,;:()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function iqgTextIncludesAny(text = "", terms = []) {
  const t = iqgNormalizeFunnelText(text);

  return terms.some(term => t.includes(iqgNormalizeFunnelText(term)));
}

function iqgGetLastAssistantMessageForFunnel(history = []) {
  if (typeof getLastAssistantMessage === "function") {
    const fromExistingHelper = getLastAssistantMessage(history);

    if (fromExistingHelper) {
      return fromExistingHelper;
    }
  }

  if (!Array.isArray(history)) return "";

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant" && history[i]?.content) {
      return history[i].content;
    }
  }

  return "";
}

function iqgDetectFunnelStepsExplainedInText(text = "") {
  const t = iqgNormalizeFunnelText(text);

  const explicouPrograma =
    t.includes("programa parceiro homologado") ||
    t.includes("parceiro homologado") ||
    t.includes("parceria comercial") ||
    t.includes("vende produtos direto da industria") ||
    t.includes("vender produtos direto da industria");

  const explicouBeneficios =
    (
      t.includes("suporte") &&
      (
        t.includes("treinamento") ||
        t.includes("materiais") ||
        t.includes("material") ||
        t.includes("industria")
      )
    ) ||
    t.includes("voce nao comeca sozinho") ||
    t.includes("você não começa sozinho") ||
    t.includes("folder explicativo");

  const explicouEstoque =
    t.includes("comodato") ||
    t.includes("lote inicial") ||
    t.includes("estoque inicial") ||
    t.includes("produtos em comodato") ||
    t.includes("pronta entrega") ||
    t.includes("pronta-entrega");

  const explicouResponsabilidades =
    t.includes("responsavel pela guarda") ||
    t.includes("responsável pela guarda") ||
    t.includes("responsavel pela conservacao") ||
    t.includes("responsável pela conservação") ||
    t.includes("comunicacao correta das vendas") ||
    t.includes("comunicação correta das vendas") ||
    (
      t.includes("responsabilidades") &&
      t.includes("parceiro")
    );

  const explicouInvestimento =
    (
      t.includes("r$ 1 990") ||
      t.includes("r$ 1990") ||
      t.includes("1 990") ||
      t.includes("1.990") ||
      t.includes("1990") ||
      t.includes("taxa de adesao") ||
      t.includes("taxa de adesão") ||
      t.includes("investimento")
    ) &&
    (
      t.includes("nao e compra de mercadoria") ||
      t.includes("não é compra de mercadoria") ||
      t.includes("nao e caucao") ||
      t.includes("não é caução") ||
      t.includes("nao e garantia") ||
      t.includes("não é garantia") ||
      t.includes("parcelado") ||
      t.includes("10x") ||
      t.includes("lote inicial") ||
      t.includes("mais de r$ 5")
    );

  const explicouCompromisso =
    t.includes("resultado depende da sua atuacao") ||
    t.includes("resultado depende da sua atuação") ||
    t.includes("depende da sua atuacao nas vendas") ||
    t.includes("depende da sua atuação nas vendas") ||
    t.includes("sua atuacao comercial") ||
    t.includes("sua atuação comercial");

  return {
    programa: explicouPrograma,
    beneficios: explicouBeneficios,
    estoque: explicouEstoque,
    responsabilidades: explicouResponsabilidades,
    investimento: explicouInvestimento,
    compromisso: explicouCompromisso
  };
}

function iqgLeadHasBlockingDoubtOrObjection(text = "", semanticIntent = null) {
  const t = iqgNormalizeFunnelText(text);

  if (semanticIntent?.blockingObjection === true) return true;
  if (semanticIntent?.priceObjection === true) return true;
  if (semanticIntent?.stockObjection === true) return true;
  if (semanticIntent?.riskObjection === true) return true;

  return (
    t.includes("nao entendi") ||
    t.includes("não entendi") ||
    t.includes("nao ficou claro") ||
    t.includes("não ficou claro") ||
    t.includes("como assim") ||
    t.includes("duvida") ||
    t.includes("dúvida") ||
    t.includes("confuso") ||
    t.includes("confusa") ||
    t.includes("caro") ||
    t.includes("pesado") ||
    t.includes("muito alto") ||
    t.includes("nao tenho dinheiro") ||
    t.includes("não tenho dinheiro") ||
    t.includes("nao quero") ||
    t.includes("não quero") ||
    t.includes("vou pensar") ||
    t.includes("depois eu vejo") ||
    t.includes("medo") ||
    t.includes("golpe") ||
    t.includes("risco")
  );
}

function iqgLeadHasStrongUnderstandingSignal(text = "", semanticIntent = null) {
  const t = iqgNormalizeFunnelText(text);

  if (semanticIntent?.positiveRealInterest === true) return true;
  if (semanticIntent?.positiveCommitment === true) return true;

  const weakOnlyPatterns = [
    /^ok$/,
    /^sim$/,
    /^ta$/,
    /^tá$/,
    /^certo$/,
    /^beleza$/,
    /^show$/,
    /^legal$/,
    /^perfeito$/
  ];

  if (weakOnlyPatterns.some(pattern => pattern.test(t))) {
    return false;
  }

  return (
    t.includes("entendi") ||
    t.includes("entendido") ||
    t.includes("compreendi") ||
    t.includes("ficou claro") ||
    t.includes("faz sentido") ||
    t.includes("sem duvida") ||
    t.includes("sem dúvida") ||
    t.includes("tudo certo") ||
    t.includes("pode seguir") ||
    t.includes("podemos seguir") ||
    t.includes("vamos seguir") ||
    t.includes("pode continuar") ||
    t.includes("proximo") ||
    t.includes("próximo") ||
    t.includes("vamos para o proximo") ||
    t.includes("vamos para o próximo") ||
    t.includes("quero continuar") ||
    t.includes("quero seguir") ||
    t.includes("vamos pra pre analise") ||
    t.includes("vamos para pre analise") ||
    t.includes("vamos pra pré análise") ||
    t.includes("vamos para pré análise")
  );
}

function iqgLeadMovedToNextLogicalTopic({
  leadText = "",
  explainedSteps = {}
} = {}) {
  const t = iqgNormalizeFunnelText(leadText);

  const askedAboutBenefits =
    t.includes("beneficio") ||
    t.includes("benefício") ||
    t.includes("suporte") ||
    t.includes("treinamento") ||
    t.includes("material");

  const askedAboutStock =
    t.includes("estoque") ||
    t.includes("comodato") ||
    t.includes("kit") ||
    t.includes("lote") ||
    t.includes("produto") ||
    t.includes("produtos");

  const askedAboutResponsibilities =
    t.includes("responsabilidade") ||
    t.includes("guarda") ||
    t.includes("conservacao") ||
    t.includes("conservação") ||
    t.includes("reposicao") ||
    t.includes("reposição") ||
    t.includes("vendeu") ||
    t.includes("vender");

  const askedAboutInvestment =
    t.includes("taxa") ||
    t.includes("valor") ||
    t.includes("preco") ||
    t.includes("preço") ||
    t.includes("investimento") ||
    t.includes("1990") ||
    t.includes("1.990") ||
    t.includes("pagamento") ||
    t.includes("parcelar") ||
    t.includes("cartao") ||
    t.includes("cartão") ||
    t.includes("pix");

  const askedAboutPreAnalysis =
    t.includes("pre analise") ||
    t.includes("pré análise") ||
    t.includes("pre-analise") ||
    t.includes("pré-análise") ||
    t.includes("cadastro") ||
    t.includes("participar") ||
    t.includes("como faço") ||
    t.includes("como faco") ||
    t.includes("quero entrar");

  return {
    programa:
      explainedSteps.programa === true &&
      (askedAboutBenefits || askedAboutStock || askedAboutResponsibilities || askedAboutInvestment || askedAboutPreAnalysis),

    beneficios:
      explainedSteps.beneficios === true &&
      (askedAboutStock || askedAboutResponsibilities || askedAboutInvestment || askedAboutPreAnalysis),

    estoque:
      explainedSteps.estoque === true &&
      (askedAboutResponsibilities || askedAboutInvestment || askedAboutPreAnalysis),

    responsabilidades:
      explainedSteps.responsabilidades === true &&
      (askedAboutInvestment || askedAboutPreAnalysis),

    investimento:
      explainedSteps.investimento === true &&
      askedAboutPreAnalysis
  };
}

function iqgLeadConfirmedInvestmentUnderstanding(text = "", semanticIntent = null) {
  const t = iqgNormalizeFunnelText(text);

  if (iqgLeadHasBlockingDoubtOrObjection(text, semanticIntent)) {
    return false;
  }

  return (
    t.includes("entendi a taxa") ||
    t.includes("entendi o investimento") ||
    t.includes("ficou claro a taxa") ||
    t.includes("ficou claro o investimento") ||
    t.includes("faz sentido a taxa") ||
    t.includes("faz sentido o investimento") ||
    t.includes("estou de acordo com a taxa") ||
    t.includes("estou de acordo com o investimento") ||
    t.includes("pode seguir") ||
    t.includes("podemos seguir") ||
    t.includes("vamos seguir") ||
    t.includes("quero seguir") ||
    t.includes("vamos pra pre analise") ||
    t.includes("vamos para pre analise") ||
    t.includes("vamos pra pré análise") ||
    t.includes("vamos para pré análise")
  );
}

function iqgBuildFunnelProgressUpdateFromLeadReply({
  leadText = "",
  history = [],
  currentLead = {},
  semanticIntent = null
} = {}) {
  const currentEtapas = {
    ...(currentLead?.etapas || {})
  };

  const lastAssistantText = iqgGetLastAssistantMessageForFunnel(history);
  const explainedPreviously = iqgDetectFunnelStepsExplainedInText(lastAssistantText);

  const hasStrongUnderstanding = iqgLeadHasStrongUnderstandingSignal(leadText, semanticIntent);
  const hasBlockingDoubtOrObjection = iqgLeadHasBlockingDoubtOrObjection(leadText, semanticIntent);
  const movedToNextTopic = iqgLeadMovedToNextLogicalTopic({
    leadText,
    explainedSteps: explainedPreviously
  });

  const etapasUpdate = {
    ...currentEtapas
  };

  const understoodSteps = [];
  const evidence = {
    leadText,
    lastAssistantText,
    criterio: "",
    explainedPreviously,
    movedToNextTopic
  };

  if (hasBlockingDoubtOrObjection) {
    return {
      changed: false,
      etapas: etapasUpdate,
      understoodSteps,
      evidence: {
        ...evidence,
        criterio: "lead_trouxe_duvida_ou_objecao"
      }
    };
  }

  function markStep(step, reason) {
    if (etapasUpdate[step] !== true) {
      etapasUpdate[step] = true;
      understoodSteps.push(step);
    }

    evidence.criterio = evidence.criterio || reason;
  }

  if (explainedPreviously.programa && (hasStrongUnderstanding || movedToNextTopic.programa)) {
    markStep("programa", "lead_confirmou_ou_avancou_contexto_apos_programa");
  }

  if (explainedPreviously.beneficios && (hasStrongUnderstanding || movedToNextTopic.beneficios)) {
    markStep("beneficios", "lead_confirmou_ou_avancou_contexto_apos_beneficios");
  }

  if (explainedPreviously.estoque && (hasStrongUnderstanding || movedToNextTopic.estoque)) {
    markStep("estoque", "lead_confirmou_ou_avancou_contexto_apos_estoque");
  }

  if (explainedPreviously.responsabilidades && (hasStrongUnderstanding || movedToNextTopic.responsabilidades)) {
    markStep("responsabilidades", "lead_confirmou_ou_avancou_contexto_apos_responsabilidades");
  }

  if (
    explainedPreviously.investimento &&
    iqgLeadConfirmedInvestmentUnderstanding(leadText, semanticIntent)
  ) {
    markStep("investimento", "lead_confirmou_entendimento_do_investimento");
  }

  return {
    changed: understoodSteps.length > 0,
    etapas: etapasUpdate,
    understoodSteps,
    evidence
  };
}

function iqgBuildPendingFunnelFlagsFromCurrentSdrReply({
  respostaFinal = "",
  currentLead = {}
} = {}) {
  const currentEtapas = {
    ...(currentLead?.etapas || {})
  };

  const explainedNow = iqgDetectFunnelStepsExplainedInText(respostaFinal);

  const etapasUpdate = {
    ...currentEtapas
  };

  const pendingFlags = {
    ...(currentLead?.etapasAguardandoEntendimento || {})
  };

  const pendingSteps = [];

  if (explainedNow.programa && currentEtapas.programa !== true) {
    pendingFlags.programa = true;
    pendingSteps.push("programa");
  }

  if (explainedNow.beneficios && currentEtapas.beneficios !== true) {
    pendingFlags.beneficios = true;
    pendingSteps.push("beneficios");
  }

  if (explainedNow.estoque && currentEtapas.estoque !== true) {
    pendingFlags.estoque = true;
    pendingSteps.push("estoque");
  }

  if (explainedNow.responsabilidades && currentEtapas.responsabilidades !== true) {
    pendingFlags.responsabilidades = true;
    pendingSteps.push("responsabilidades");
  }

  if (explainedNow.investimento && currentEtapas.investimento !== true) {
    etapasUpdate.taxaPerguntada = true;
    pendingFlags.investimento = true;
    pendingSteps.push("investimento");
  }

  if (explainedNow.compromisso && currentEtapas.compromisso !== true) {
    etapasUpdate.compromissoPerguntado = true;
    pendingFlags.compromisso = true;
    pendingSteps.push("compromisso");
  }

  return {
    changed: pendingSteps.length > 0,
    etapas: etapasUpdate,
    pendingFlags,
    pendingSteps,
    explainedNow
  };
}

function buildConversationMemoryForAgents({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  const assistantMessages = Array.isArray(history)
    ? history
        .filter(message => message?.role === "assistant")
        .map(message => message?.content || "")
    : [];

  const userMessages = Array.isArray(history)
    ? history
        .filter(message => message?.role === "user")
        .map(message => message?.content || "")
    : [];

  const assistantText = assistantMessages
    .join("\n")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const userTextHistory = userMessages
    .join("\n")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const etapas = lead?.etapas || {};

    const lastAssistantTheme = detectReplyMainTheme(lastSdrText || getLastAssistantMessage(history));
  const currentLeadTheme = detectReplyMainTheme(lastUserText);
  const currentLeadThemes = detectLeadMessageThemes(lastUserText);

  const leadReplyWasShortNeutral = isShortNeutralLeadReply(lastUserText);
  const possibleRepetitionRisk =
    leadReplyWasShortNeutral &&
    lastAssistantTheme &&
    currentLeadTheme &&
    lastAssistantTheme === currentLeadTheme;

  const missingSteps = getMissingFunnelStepLabels(lead || {});

  return {
    etapaAtualCalculada: getCurrentFunnelStage(lead || {}),
    faseQualificacao: lead?.faseQualificacao || "",
    status: lead?.status || "",
    faseFunil: lead?.faseFunil || "",
    statusOperacional: lead?.statusOperacional || "",
    rotaComercial: lead?.rotaComercial || lead?.origemConversao || "homologado",
    temperaturaComercial: lead?.temperaturaComercial || "indefinida",

    etapasBackend: {
      programa: etapas.programa === true,
      beneficios: etapas.beneficios === true,
      estoque: etapas.estoque === true,
      responsabilidades: etapas.responsabilidades === true,
      investimento: etapas.investimento === true,
      taxaPerguntada: etapas.taxaPerguntada === true,
      compromissoPerguntado: etapas.compromissoPerguntado === true,
      compromisso: etapas.compromisso === true
    },

    sinaisHistorico: {
      programaJaExplicado:
        etapas.programa === true ||
        assistantText.includes("parceria comercial") ||
        assistantText.includes("programa parceiro homologado"),

      beneficiosJaExplicados:
        etapas.beneficios === true ||
        (
          assistantText.includes("suporte") &&
          (
            assistantText.includes("treinamento") ||
            assistantText.includes("materiais")
          )
        ),

      estoqueJaExplicado:
        etapas.estoque === true ||
        assistantText.includes("comodato") ||
        assistantText.includes("lote inicial") ||
        assistantText.includes("estoque"),

      responsabilidadesJaExplicadas:
        etapas.responsabilidades === true ||
        assistantText.includes("responsabilidade") ||
        assistantText.includes("guarda") ||
        assistantText.includes("conservacao") ||
        assistantText.includes("conservação"),

      investimentoJaExplicado:
        etapas.investimento === true ||
        assistantText.includes("1.990") ||
        assistantText.includes("1990") ||
        assistantText.includes("taxa de adesao") ||
        assistantText.includes("taxa de adesão") ||
        assistantText.includes("investimento"),

      afiliadoJaApresentado:
        lead?.interesseAfiliado === true ||
        lead?.rotaComercial === "afiliado" ||
        assistantText.includes("programa de afiliados") ||
        assistantText.includes("minhaiqg.com.br")
    },

       ultimaInteracao: {
      ultimaMensagemLead: lastUserText || "",
      ultimaRespostaSdr: lastSdrText || getLastAssistantMessage(history) || "",
      temaUltimaRespostaSdr: lastAssistantTheme || "",
      temaMensagemAtualLead: currentLeadTheme || "",
      temasMensagemAtualLead: currentLeadThemes,
      leadFezPerguntaOuObjecao: isLeadQuestionObjectionOrCorrection(lastUserText),
      leadRespondeuCurtoNeutro: leadReplyWasShortNeutral,
      riscoRepeticaoMesmoTema: Boolean(possibleRepetitionRisk)
    },
     
    pendencias: {
      etapasPendentes: missingSteps,
      podeIniciarColetaDados: canStartDataCollection(lead || {}),
      podePerguntarInteresseReal: canAskForRealInterest(lead || {}),
      emColetaOuConfirmacao: isDataFlowState(lead || {}),
      preCadastroFinalizado: leadHasFinishedPreCadastro(lead || {})
    },

    alertasParaAgentes: [
      possibleRepetitionRisk
        ? "Lead respondeu de forma curta/neutra e existe risco de repetir o mesmo tema. Evitar repetir explicação; conduzir para o próximo passo natural."
        : "",
      leadReplyWasShortNeutral
        ? "Resposta curta do lead deve ser tratada como entendimento/recebimento, não como intenção forte automática."
        : "",
      missingSteps.length > 0
        ? `Ainda existem etapas pendentes antes da pré-análise: ${missingSteps.join(", ")}.`
        : "",
      isDataFlowState(lead || {})
        ? "Lead está em coleta/confirmação/correção de dados. Não acionar rota comercial, taxa, afiliado ou cadastro."
        : ""
    ].filter(Boolean)
  };
}

function applyAntiRepetitionGuard({
  leadText = "",
  respostaFinal = "",
  currentLead = {},
  history = []
} = {}) {
  const lastAssistantMessage = getLastAssistantMessage(history);

  if (!lastAssistantMessage) {
    return {
      changed: false,
      respostaFinal
    };
  }

  const leadReplyWasShort = isShortNeutralLeadReply(leadText);

  if (!leadReplyWasShort) {
    return {
      changed: false,
      respostaFinal
    };
  }

  const lastTheme = detectReplyMainTheme(lastAssistantMessage);
  const currentTheme = detectReplyMainTheme(respostaFinal);

  if (!lastTheme || !currentTheme) {
    return {
      changed: false,
      respostaFinal
    };
  }

  const repeatedSameTheme = lastTheme === currentTheme;

  if (!repeatedSameTheme) {
    return {
      changed: false,
      respostaFinal
    };
  }

  const continuation = buildContinuationAfterRepeatedTheme({
    lastTheme,
    currentLead
  });

  return {
    changed: true,
    reason: {
      leadReplyWasShort,
      lastTheme,
      currentTheme,
      repeatedSameTheme
    },
    respostaFinal: continuation.message,
    fileKey: continuation.fileKey
  };
}

function leadMentionedTaxObjection(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (
    t.includes("taxa") ||
    t.includes("1990") ||
    t.includes("1 990") ||
    t.includes("1.990") ||
    t.includes("valor") ||
    t.includes("investimento") ||
    t.includes("caro") ||
    t.includes("pagar") ||
    t.includes("pagamento") ||
    t.includes("pix") ||
    t.includes("cartao") ||
    t.includes("cartão") ||
    t.includes("parcelar") ||
    t.includes("parcelado") ||
    t.includes("10x") ||
    t.includes("nao tenho esse valor") ||
    t.includes("não tenho esse valor") ||
    t.includes("sem dinheiro") ||
    t.includes("achei alto") ||
    t.includes("muito alto")
  );
}

function historyAlreadyExplainedInvestment(history = []) {
  if (!Array.isArray(history)) return false;

  const historyText = history
    .filter(message => message?.role === "assistant")
    .slice(-8)
    .map(message => message?.content || "")
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (
    (
      historyText.includes("r$ 1.990") ||
      historyText.includes("1.990") ||
      historyText.includes("1990")
    ) &&
    (
      historyText.includes("nao e compra de mercadoria") ||
      historyText.includes("nao e caucao") ||
      historyText.includes("nao e garantia") ||
      historyText.includes("lote inicial") ||
      historyText.includes("mais de r$ 5.000") ||
      historyText.includes("mais de 5.000") ||
      historyText.includes("10x")
    )
  );
}

function buildShortTaxObjectionResponse({ leadText = "" } = {}) {
  const t = String(leadText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (
    t.includes("parcel") ||
    t.includes("cartao") ||
    t.includes("cartão") ||
    t.includes("10x")
  ) {
    return `Sim, existe possibilidade de parcelamento no cartão em até 10x de R$ 199,00, dependendo da disponibilidade no momento.

E só reforçando: esse pagamento não acontece agora. Ele só vem depois da análise interna e da assinatura do contrato.

Assim fica mais viável pra você analisar?`;
  }

  if (
    t.includes("pix") ||
    t.includes("pagar") ||
    t.includes("pagamento")
  ) {
    return `O pagamento não acontece agora, tá? 😊

Primeiro vem a análise interna e, se fizer sentido seguir, a assinatura do contrato. Só depois disso a parte do investimento é tratada.

Neste momento, o mais importante é você entender se o modelo faz sentido pra você. Faz sentido nesse formato?`;
  }

  if (
    t.includes("caro") ||
    t.includes("alto") ||
    t.includes("nao tenho esse valor") ||
    t.includes("não tenho esse valor") ||
    t.includes("sem dinheiro")
  ) {
    return `Entendo sua análise 😊

O ponto principal é não olhar a taxa isolada: ela não é compra de mercadoria, caução ou garantia. Ela está ligada à entrada na estrutura, suporte e liberação do lote em comodato, que representa mais de R$ 5.000,00 em preço de venda ao consumidor.

Mas precisa fazer sentido pra você também. Nesse formato, você prefere entender melhor a margem ou acha que o investimento fica inviável agora?`;
  }

  return `Sim, existe a taxa de adesão e implantação de R$ 1.990,00.

Só reforçando de forma direta: ela não é compra de mercadoria, caução ou garantia. Ela faz parte da ativação no programa, suporte e liberação do lote em comodato, que representa mais de R$ 5.000,00 em preço de venda ao consumidor.

Faz sentido pra você olhando por esse lado?`;
}

function applyTaxObjectionAntiRepetitionGuard({
  leadText = "",
  respostaFinal = "",
  currentLead = {},
  history = []
} = {}) {
  const leadFalouDeTaxa = leadMentionedTaxObjection(leadText);
  const investimentoJaExplicado = historyAlreadyExplainedInvestment(history);

  if (!leadFalouDeTaxa || !investimentoJaExplicado) {
    return {
      changed: false,
      respostaFinal
    };
  }

  const respostaIaFicouLonga =
    String(respostaFinal || "").length > 650;

  const respostaIaRepetiuArgumentos =
    replyMentionsInvestment(respostaFinal) &&
    (
      String(respostaFinal || "").includes("não é compra de mercadoria") ||
      String(respostaFinal || "").includes("não é caução") ||
      String(respostaFinal || "").includes("não é garantia") ||
      String(respostaFinal || "").includes("mais de R$ 5.000") ||
      String(respostaFinal || "").includes("margem") ||
      String(respostaFinal || "").includes("10x")
    );

  if (!respostaIaFicouLonga && !respostaIaRepetiuArgumentos) {
    return {
      changed: false,
      respostaFinal
    };
  }

  return {
    changed: true,
    reason: {
      leadFalouDeTaxa,
      investimentoJaExplicado,
      respostaIaFicouLonga,
      respostaIaRepetiuArgumentos
    },
    respostaFinal: buildShortTaxObjectionResponse({
      leadText
    })
  };
}

function isTaxaQuestionIntent(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  const patterns = [
    "qual a taxa",
    "qual é a taxa",
    "qual e a taxa",
    "como e a taxa",
    "como é a taxa",
    "tem taxa",
    "existe taxa",
    "tem alguma taxa",
    "qual valor da taxa",
    "valor da taxa",
    "taxa de adesao",
    "taxa de adesão",
    "quanto e a taxa",
    "quanto é a taxa",
    "quanto custa",
    "qual o valor",
    "qual valor",
    "qual investimento",
    "investimento",
    "adesao",
    "adesão",
    "1990",
    "1.990",
    "r$ 1990",
    "r$ 1.990",
    "pagar taxa",
    "tenho que pagar",
    "como pago",
    "parcelamento",
    "parcela",
    "cartao",
    "cartão",
    "pix"
  ];

  return patterns.some(pattern => t.includes(pattern));
}

function buildFullTaxExplanationResponse(firstName = "") {
  const namePart = firstName ? `${firstName}, ` : "";

  return `${namePart}vou te explicar com total transparência 😊

Existe uma taxa de adesão e implantação de R$ 1.990,00.

Mas é importante entender o contexto: esse valor não é compra de mercadoria, não é caução e não é garantia.

Ele faz parte da ativação no programa, acesso à estrutura da IQG, suporte, treinamentos e liberação do lote inicial em comodato para você começar a operar.

Pra você ter uma referência prática: só o lote inicial representa mais de R$ 5.000,00 em preço de venda ao consumidor final.

Além disso, quando o parceiro vende seguindo o preço sugerido ao consumidor, a margem é de 40%. Se vender com ágio, acima do preço sugerido, essa diferença fica com o parceiro, então a margem pode ser maior.

As primeiras vendas podem ajudar a recuperar esse investimento inicial, mas isso depende da sua atuação comercial, prospecção e vendas realizadas.

O investimento pode ser feito via PIX ou parcelado em até 10x de R$ 199,00 no cartão, dependendo da disponibilidade no momento.

E um ponto importante de segurança: o pagamento só acontece depois da análise interna e da assinatura do contrato.

Faz sentido pra você olhando por esse contexto?`;
}

function isTaxaObjectionAgainstInvestment(text = "") {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  // Evita falso positivo quando o lead está apenas perguntando sobre a taxa.
  // Exemplo: "qual é a taxa?", "tem taxa?", "como funciona o parcelamento?"
  const parecePerguntaNeutra =
    t.includes("qual a taxa") ||
    t.includes("qual e a taxa") ||
    t.includes("como e a taxa") ||
    t.includes("tem taxa") ||
    t.includes("existe taxa") ||
    t.includes("qual o valor") ||
    t.includes("quanto custa") ||
    t.includes("como funciona o parcelamento") ||
    t.includes("parcela em quantas vezes") ||
    t.includes("da pra parcelar") ||
    t.includes("dá pra parcelar");

  const temSinalDeResistencia =
    t.includes("caro") ||
    t.includes("alto") ||
    t.includes("pesado") ||
    t.includes("dificil") ||
    t.includes("difícil") ||
    t.includes("complicado") ||
    t.includes("sem condicoes") ||
    t.includes("sem condições") ||
    t.includes("nao tenho") ||
    t.includes("não tenho") ||
    t.includes("nao consigo") ||
    t.includes("não consigo") ||
    t.includes("nao posso") ||
    t.includes("não posso") ||
    t.includes("nao rola") ||
    t.includes("não rola") ||
    t.includes("nao fecha") ||
    t.includes("não fecha") ||
    t.includes("inviavel") ||
    t.includes("inviável") ||
    t.includes("absurdo") ||
    t.includes("salgado");

  if (parecePerguntaNeutra && !temSinalDeResistencia) {
    return false;
  }

  const objectionPatterns = [
    // preço alto
    "achei caro",
    "muito caro",
    "ta caro",
    "tá caro",
    "esta caro",
    "está caro",
    "caro pra mim",
    "caro para mim",
    "caro demais",
    "taxa cara",
    "taxa alta",
    "valor alto",
    "achei alto",
    "muito alto",
    "ficou alto",
    "ficou caro",
    "ficou pesado",
    "pesado pra mim",
    "pesado para mim",
    "meio pesado",
    "salgado",
    "valor salgado",
    "taxa salgada",
    "absurdo",

    // dificuldade / inviabilidade
    "fica dificil",
    "fica difícil",
    "fica meio dificil",
    "fica meio difícil",
    "fica complicado",
    "complicado pra mim",
    "complicado para mim",
    "dificil pra mim",
    "difícil pra mim",
    "dificil para mim",
    "difícil para mim",
    "sem condicoes",
    "sem condições",
    "sem condicao",
    "sem condição",
    "nao tenho condicoes",
    "não tenho condições",
    "nao tenho condicao",
    "não tenho condição",
    "inviavel",
    "inviável",
    "nao fica viavel",
    "não fica viável",
    "nao fecha pra mim",
    "não fecha pra mim",
    "nao fecha para mim",
    "não fecha para mim",
    "nao rola",
    "não rola",
    "ai nao rola",
    "aí não rola",

    // falta de dinheiro
    "nao tenho dinheiro",
    "não tenho dinheiro",
    "sem dinheiro",
    "sem dinheiro agora",
    "sem grana",
    "sem grana agora",
    "nao tenho grana",
    "não tenho grana",
    "nao tenho esse valor",
    "não tenho esse valor",
    "nao tenho como pagar",
    "não tenho como pagar",
    "nao consigo pagar",
    "não consigo pagar",
    "nao posso pagar",
    "não posso pagar",
    "apertado agora",
    "estou apertado",
    "to apertado",
    "tô apertado",
    "estou sem dinheiro",
    "to sem dinheiro",
    "tô sem dinheiro",

    // rejeição da taxa
    "nao quero pagar taxa",
    "não quero pagar taxa",
    "nao quero pagar essa taxa",
    "não quero pagar essa taxa",
    "nao quero pagar adesao",
    "não quero pagar adesão",
    "nao quero adesao",
    "não quero adesão",
    "nao quero investimento",
    "não quero investimento",
    "nao pago taxa",
    "não pago taxa",
    "nao pago adesao",
    "não pago adesão",

    // formas coloquiais com taxa
    "bah pagar taxa",
    "bah pagar 1990",
    "bah pagar 1 990",
    "bah pagar 1.990",
    "mas pagar taxa",
    "mas pagar 1990",
    "mas pagar 1 990",
    "mas pagar 1.990",
    "essa taxa",
    "essa taxa ai",
    "essa taxa aí",
    "taxa de 1990",
    "taxa de 1 990",
    "taxa de 1.990",
    "pagar 1990",
    "pagar 1 990",
    "pagar 1.990",
    "r$ 1990",
    "r$ 1.990"
  ];

  return objectionPatterns.some(pattern => t.includes(pattern));
}

function buildTaxObjectionAttemptResponse(count = 1) {
  if (count === 1) {
    return `Entendo sua análise 😊

O ponto principal é não olhar a taxa isolada. Ela não é compra de mercadoria, caução ou garantia.

Ela faz parte da ativação no programa, suporte, treinamento e liberação do lote inicial em comodato, que representa mais de R$ 5.000,00 em preço de venda ao consumidor.

Além disso, o pagamento não acontece agora: primeiro vem a análise interna e a assinatura do contrato.

Olhando por esse lado, faz sentido pra você avaliar o modelo?`;
  }

  if (count === 2) {
    return `Faz sentido você olhar com cuidado, porque é um investimento importante 😊

A diferença é que, no Parceiro Homologado, você não começa comprando estoque. O lote é cedido em comodato pela IQG, e isso reduz bastante a barreira para começar com produto em mãos.

Quando o parceiro vende seguindo o preço sugerido, a margem é de 40%. Se vender com ágio, acima do preço sugerido, essa diferença fica com o parceiro.

Não é promessa de ganho, porque depende da sua atuação nas vendas, mas é justamente por isso que a análise precisa considerar a estrutura completa, não só a taxa.

Você quer que eu te explique melhor a parte da margem ou a parte do lote em comodato?`;
  }

  return `Entendo totalmente sua preocupação 😊

Vou ser bem direta: o Parceiro Homologado faz mais sentido para quem quer atuar de forma ativa, com produtos em mãos, suporte da indústria e possibilidade de vender com margem.

A taxa existe porque envolve ativação, suporte, treinamento e estrutura, mas ela só é tratada depois da análise interna e da assinatura do contrato.

Se mesmo assim esse investimento não fizer sentido pra você agora, tudo bem. Antes de eu te mostrar outro caminho, só me confirma: a sua trava principal é realmente a taxa de adesão?`;
}

function buildAffiliateAfterTaxObjectionsResponse() {
  return `Entendi 😊

Como a taxa de adesão do Parceiro Homologado ficou como uma trava pra você, talvez faça mais sentido começar por outro caminho da IQG: o Programa de Afiliados.

Ele é diferente do Parceiro Homologado.

No Afiliado:
• você não precisa ter estoque;
• não recebe lote em comodato;
• não tem a taxa de adesão do Homologado;
• divulga os produtos por link;
• recebe comissão por vendas validadas.

O cadastro é feito por aqui:
https://minhaiqg.com.br/

Se depois você quiser algo mais estruturado, com produtos em mãos, suporte e lote em comodato, aí podemos retomar o Parceiro Homologado.`;
}

function isRepeatedDigits(value = "") {
  return /^(\d)\1+$/.test(value);
}

function validateLeadData(data = {}) {
  const errors = [];

  if (data.cpf) {
    const cpfDigits = onlyDigits(data.cpf);

    if (/[a-zA-Z]/.test(data.cpf)) {
      errors.push("O CPF não deve conter letras.");
    } else if (cpfDigits.length !== 11) {
      errors.push("O CPF precisa ter exatamente 11 números.");
    } else if (isRepeatedDigits(cpfDigits)) {
  errors.push("O CPF informado parece inválido, pois repete o mesmo número.");
} else if (!isValidCPF(cpfDigits)) {
  errors.push("O CPF informado parece inválido. Pode conferir e me enviar novamente?");
}
  }

  if (data.telefone) {
    const phoneDigits = onlyDigits(data.telefone);

    if (/[a-zA-Z]/.test(data.telefone)) {
      errors.push("O telefone não deve conter letras.");
    } else if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      errors.push("O telefone precisa ter DDD e ter 10 ou 11 números.");
    } else if (isRepeatedDigits(phoneDigits)) {
      errors.push("O telefone informado parece inválido, pois repete o mesmo número.");
    }
  }

   if (data.estado && !VALID_UFS.includes(normalizeUF(data.estado))) {
  errors.push("O estado informado parece inválido. Pode enviar a sigla correta, como SP, RJ ou MG?");
}

  return {
    isValid: errors.length === 0,
    errors
  };
}

const REQUIRED_LEAD_FIELDS = ["nome", "cpf", "telefone", "cidade", "estado"];

function getMissingLeadFields(data = {}) {
  return REQUIRED_LEAD_FIELDS.filter(field => !data[field]);
}

function hasAllRequiredLeadFields(data = {}) {
  return getMissingLeadFields(data).length === 0;
}

function buildLeadConfirmationMessage(data = {}) {
  return `Perfeito, só para eu confirmar se entendi tudo certinho:

Nome: ${data.nome || "-"}
CPF: ${formatCPF(data.cpf || "")}
Telefone: ${formatPhone(data.telefone || "")}
Cidade: ${data.cidade || "-"}
Estado: ${normalizeUF(data.estado || "-")}

Esses dados estão corretos?`;
}

function isDataFlowState(lead = {}) {
  const fasesDeColetaOuConfirmacao = [
    "coletando_dados",
    "dados_parciais",
    "aguardando_dados",
    "aguardando_confirmacao_campo",
    "aguardando_confirmacao_dados",
    "corrigir_dado",
    "corrigir_dado_final",
    "aguardando_valor_correcao_final"
  ];

  return Boolean(
    fasesDeColetaOuConfirmacao.includes(lead?.faseQualificacao) ||
    lead?.faseFunil === "coleta_dados" ||
    lead?.faseFunil === "confirmacao_dados" ||
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true
  );
}

function isLikelyPureDataAnswer(text = "", currentLead = {}) {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    return false;
  }

  const normalized = cleanText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const hasQuestionSignal =
    cleanText.includes("?") ||
    /^(como|qual|quais|quando|onde|por que|porque|pq|pra que|para que|posso|tem|e se|me explica|fiquei com duvida|tenho duvida)\b/i.test(normalized) ||
    normalized.includes("duvida") ||
    normalized.includes("dúvida");

  if (hasQuestionSignal) {
    return false;
  }

  if (isPositiveConfirmation(cleanText) || isNegativeConfirmation(cleanText)) {
    return true;
  }

  const digits = onlyDigits(cleanText);

  // CPF ou telefone puro.
  if (digits.length >= 10) {
    return true;
  }

  // Estado puro.
  if (
    currentLead?.campoEsperado === "estado" &&
    VALID_UFS.includes(normalizeUF(cleanText))
  ) {
    return true;
  }

  // Cidade pura.
  if (
    currentLead?.campoEsperado === "cidade" &&
    /^[A-Za-zÀ-ÿ.'\-\s]{2,50}$/.test(cleanText) &&
    !VALID_UFS.includes(normalizeUF(cleanText))
  ) {
    return true;
  }

  // Nome puro, quando está esperando nome.
  if (
    currentLead?.campoEsperado === "nome" &&
    /^[A-Za-zÀ-ÿ.'\-\s]{5,80}$/.test(cleanText) &&
    cleanText.trim().split(/\s+/).length >= 2
  ) {
    return true;
  }

  return false;
}

function isLeadQuestionObjectionOrCorrection(text = "") {
  const rawText = String(text || "").trim();

  if (!rawText) {
    return false;
  }

  const t = rawText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const hasQuestion =
    rawText.includes("?") ||
    /^(como|qual|quais|quando|onde|por que|porque|pq|pra que|para que|posso|tem|e se|me explica|fiquei com duvida|tenho duvida)\b/i.test(t) ||
    t.includes("duvida") ||
    t.includes("nao entendi") ||
    t.includes("não entendi");

  const hasObjection =
    t.includes("taxa") ||
    t.includes("valor") ||
    t.includes("preco") ||
    t.includes("preço") ||
    t.includes("caro") ||
    t.includes("comodato") ||
    t.includes("estoque") ||
    t.includes("margem") ||
    t.includes("lucro") ||
    t.includes("risco") ||
    t.includes("contrato") ||
    t.includes("pagamento") ||
    t.includes("afiliado") ||
    t.includes("link") ||
    t.includes("comissao") ||
    t.includes("comissão") ||
    t.includes("nao faz sentido") ||
    t.includes("não faz sentido") ||
    t.includes("nao quero") ||
    t.includes("não quero") ||
    t.includes("achei estranho") ||
    t.includes("nao estou entendendo") ||
    t.includes("não estou entendendo");

  const hasCorrection =
    t.includes("corrigir") ||
    t.includes("correcao") ||
    t.includes("correção") ||
    t.includes("errado") ||
    t.includes("errada") ||
    t.includes("incorreto") ||
    t.includes("incorreta") ||
    t.includes("voce nao respondeu") ||
    t.includes("você não respondeu") ||
    t.includes("nao respondeu minha pergunta") ||
    t.includes("não respondeu minha pergunta");

  return hasQuestion || hasObjection || hasCorrection;
}

async function runDataFlowSemanticRouter({
  currentLead = {},
  history = [],
  userText = ""
} = {}) {
  const fallback = {
    tipoMensagem: "indefinido",
    deveResponderAntesDeColetar: false,
    deveProsseguirComColeta: true,
    motivo: "Fallback local: roteador semântico não executado ou falhou."
  };

  const recentHistory = Array.isArray(history)
    ? history.slice(-8).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SEMANTIC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Você é um roteador semântico interno da SDR IA da IQG.

Sua função é analisar a ÚLTIMA mensagem do lead quando a conversa está em coleta ou confirmação de dados.

Você NÃO conversa com o lead.
Você NÃO escreve resposta final.
Você NÃO altera status.
Você NÃO salva dados.
Você apenas decide como o backend deve tratar a mensagem.

Contexto:
A SDR pode estar pedindo nome, CPF, telefone, cidade, estado ou confirmação dos dados.
Mesmo nessa fase, o lead pode fazer dúvidas comerciais, objeções, pedir explicação, corrigir dado ou pedir humano.

Decida semanticamente o tipo da mensagem, como um humano entenderia.

Tipos permitidos:

- "dado_cadastral"
Quando o lead apenas enviou o dado esperado ou algum dado pessoal útil para o pré-cadastro.

- "confirmacao_positiva"
Quando o lead confirma que um dado ou todos os dados estão corretos.

- "confirmacao_negativa"
Quando o lead diz que um dado ou todos os dados estão incorretos.

- "correcao_dado"
Quando o lead quer corrigir nome, CPF, telefone, cidade ou estado.

- "pergunta_comercial"
Quando o lead faz uma pergunta sobre programa, taxa, estoque, contrato, comodato, margem, pagamento, afiliado, próximos passos ou qualquer dúvida comercial.

- "objecao_comercial"
Quando o lead demonstra trava, insegurança, discordância, medo, preço alto, confusão ou resistência.

- "pedido_humano"
Quando o lead pede atendente, consultor, vendedor, humano ou alguém da equipe.

- "misto"
Quando a mensagem mistura dado cadastral com pergunta, objeção ou correção.

- "indefinido"
Quando não há confiança suficiente.

Regras de decisão:

1. Se houver pergunta, objeção, reclamação ou pedido de explicação, a SDR deve responder antes de continuar a coleta.

2. Se a mensagem for apenas dado cadastral, o backend pode prosseguir com a coleta normalmente.

3. Se a mensagem for confirmação positiva ou negativa, o backend pode prosseguir com a confirmação normalmente.

4. Se a mensagem for correção de dado, o backend pode usar o fluxo de correção.

5. Se for "misto", a SDR deve responder primeiro a dúvida ou objeção e depois retomar a coleta. Não salve dado misturado automaticamente.

6. Não dependa de palavras exatas. Interprete intenção, contexto e significado.

Responda somente JSON válido neste formato:

{
  "tipoMensagem": "indefinido",
  "deveResponderAntesDeColetar": false,
  "deveProsseguirComColeta": true,
  "motivo": ""
}
`
          },
          {
            role: "user",
            content: JSON.stringify({
              ultimaMensagemLead: userText || "",
              historicoRecente: recentHistory,
              lead: {
                faseQualificacao: currentLead?.faseQualificacao || "",
                faseFunil: currentLead?.faseFunil || "",
                campoEsperado: currentLead?.campoEsperado || "",
                campoPendente: currentLead?.campoPendente || "",
                aguardandoConfirmacaoCampo: currentLead?.aguardandoConfirmacaoCampo === true,
                aguardandoConfirmacao: currentLead?.aguardandoConfirmacao === true
              }
            })
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro no roteador semântico da coleta:", data);
      return fallback;
    }

    const rawText = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(rawText);

    const allowedTypes = [
      "dado_cadastral",
      "confirmacao_positiva",
      "confirmacao_negativa",
      "correcao_dado",
      "pergunta_comercial",
      "objecao_comercial",
      "pedido_humano",
      "misto",
      "indefinido"
    ];

    const tipoMensagem = allowedTypes.includes(parsed?.tipoMensagem)
      ? parsed.tipoMensagem
      : "indefinido";

    return {
      tipoMensagem,
      deveResponderAntesDeColetar: parsed?.deveResponderAntesDeColetar === true,
      deveProsseguirComColeta: parsed?.deveProsseguirComColeta !== false,
      motivo: parsed?.motivo || ""
    };
  } catch (error) {
    console.error("Falha no roteador semântico da coleta:", error.message);
    return fallback;
  }
}

function isLeadQuestionDuringDataFlow(text = "", currentLead = {}) {
  const cleanText = String(text || "").trim();

  if (!cleanText) {
    return false;
  }

  if (isLikelyPureDataAnswer(cleanText, currentLead)) {
    return false;
  }

  const normalized = cleanText
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hasQuestionSignal =
    cleanText.includes("?") ||
    /^(como|qual|quais|quando|onde|por que|porque|pq|pra que|para que|posso|tem|e se|me explica|fiquei com duvida|tenho duvida)\b/i.test(normalized) ||
    normalized.includes("duvida") ||
    normalized.includes("dúvida") ||
    normalized.includes("nao entendi") ||
    normalized.includes("não entendi");

  if (!hasQuestionSignal) {
    return false;
  }

  // Correção de dado não é pergunta comercial.
  const explicitCorrection = extractExplicitCorrection(cleanText);

  if (
    explicitCorrection?.campoParaCorrigir ||
    explicitCorrection?.nome ||
    explicitCorrection?.cpf ||
    explicitCorrection?.telefone ||
    explicitCorrection?.cidade ||
    explicitCorrection?.estado
  ) {
    return false;
  }

  return true;
}

function buildDataFlowResumeMessage(lead = {}) {
  const labels = {
    nome: "nome completo",
    cpf: "CPF",
    telefone: "telefone com DDD",
    cidade: "cidade",
    estado: "estado"
  };

  const labelsComArtigo = {
    nome: "o nome completo",
    cpf: "o CPF",
    telefone: "o telefone com DDD",
    cidade: "a cidade",
    estado: "o estado"
  };

  if (
    lead?.faseQualificacao === "aguardando_valor_correcao_final" &&
    lead?.campoPendente
  ) {
    return `Retomando de onde paramos: qual é ${labelsComArtigo[lead.campoPendente] || "o dado"} correto?`;
  }

  if (lead?.aguardandoConfirmacaoCampo === true && lead?.campoPendente) {
    const campo = lead.campoPendente;
    const valor = lead.valorPendente || "-";

    return `Retomando de onde paramos: identifiquei seu ${labels[campo] || campo} como "${valor}". Está correto?`;
  }

  if (
    lead?.aguardandoConfirmacao === true ||
    lead?.faseQualificacao === "aguardando_confirmacao_dados" ||
    lead?.faseFunil === "confirmacao_dados"
  ) {
    return `Retomando a confirmação dos dados:\n\n${buildLeadConfirmationMessage(lead)}`;
  }

  const missingFields = getMissingLeadFields(lead || {});

// 🛡️ PROTEÇÃO 25B-6:
// Só usa campoEsperado se esse campo realmente ainda estiver faltando.
// Isso evita pedir de novo um dado que já foi salvo.
const campoEsperadoAindaFalta =
  lead?.campoEsperado &&
  missingFields.includes(lead.campoEsperado);

const nextField = campoEsperadoAindaFalta
  ? lead.campoEsperado
  : missingFields[0];

if (nextField) {
  return `Retomando a pré-análise: ${getMissingFieldQuestion(nextField)}`;
}

return "Retomando a pré-análise: pode me confirmar se os dados estão corretos?";
}

async function answerDataFlowQuestion({
  currentLead = {},
  history = [],
  userText = ""
} = {}) {
  const resumeMessage = buildDataFlowResumeMessage(currentLead || {});

  const recentHistory = Array.isArray(history)
    ? history.slice(-8).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `Você é a SDR comercial da IQG no WhatsApp.

A conversa está em coleta ou confirmação de dados.

Sua tarefa:
1. Responder primeiro a dúvida do lead de forma curta, natural e comercial.
2. Não pedir pagamento.
3. Não aprovar lead.
4. Não prometer ganho.
5. Não alterar status.
6. Não dizer que existe Supervisor, Classificador, Consultor ou análise interna de IA.
7. Não pedir novos dados além da retomada abaixo.
8. Depois de responder, retomar exatamente o ponto pendente.

Retomada obrigatória:
${resumeMessage}

Responda em no máximo 2 blocos curtos antes da retomada.`
          },
          {
            role: "user",
            content: JSON.stringify({
              ultimaMensagemLead: userText || "",
              historicoRecente: recentHistory,
              lead: {
                faseQualificacao: currentLead?.faseQualificacao || "",
                faseFunil: currentLead?.faseFunil || "",
                campoEsperado: currentLead?.campoEsperado || "",
                campoPendente: currentLead?.campoPendente || "",
                aguardandoConfirmacaoCampo: currentLead?.aguardandoConfirmacaoCampo === true,
                aguardandoConfirmacao: currentLead?.aguardandoConfirmacao === true,
                etapas: currentLead?.etapas || {}
              }
            })
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro ao responder pergunta durante coleta/confirmação:", data);

      return `Boa pergunta 😊 Vou te responder de forma simples: essa parte é tratada com segurança pela equipe IQG durante a análise e evolução do parceiro no programa.\n\n${resumeMessage}`;
    }

    const answer = data.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return `Boa pergunta 😊 Essa parte é alinhada com segurança dentro do processo da IQG.\n\n${resumeMessage}`;
    }

    if (answer.includes(resumeMessage)) {
      return answer;
    }

    return `${answer}\n\n${resumeMessage}`;
  } catch (error) {
    console.error("Falha ao responder pergunta durante coleta/confirmação:", error.message);

    return `Boa pergunta 😊 Essa parte é alinhada com segurança dentro do processo da IQG.\n\n${resumeMessage}`;
  }
}

const variations = {
  nome: [
    "Perfeito. Pra gente já ir adiantando sua ativação, me manda seu nome completo?",
    "Boa! Vamos começar rapidinho. Qual seu nome completo?",
    "Show 😊! Me passa seu nome completo pra gente dar sequência?"
  ],
  cpf: [
    "Perfeito 👍 Agora me passa seu CPF pra gente seguir com a pré-análise?",
    "Top!!! Pode me enviar seu CPF?",
    "Agora preciso do seu CPF pra continuar, pode me mandar?"
  ],
  telefone: [
    "Obrigado! Qual o melhor número com DDD pra contato?",
    "Me passa seu telefone com DDD pra gente seguir?",
    "Agora seu número com DDD pra contato, por favor 😊"
  ],
  cidade: [
    "👍... Qual sua cidade?" ,
    "Agora me diz sua cidade, por gentileza?",
    "Por favor, qual sua cidade?"
  ],
  estado: [
    "Perfeito. Qual seu estado?",
    "Agora me diz seu estado, por favor?",
    "Só pra finalizar, qual seu estado?"
  ]
};

  function getMissingFieldQuestion(field) {
  const options = variations[field] || ["Preciso de uma informação para continuar."];

  return options[Math.floor(Math.random() * options.length)];
}

function buildPartialLeadDataMessage(data = {}, missingFields = []) {
  const found = [];

  if (data.nome) found.push(`Nome: ${data.nome}`);
  if (data.cpf) found.push(`CPF: ${formatCPF(data.cpf)}`);
  if (data.telefone) found.push(`Telefone: ${formatPhone(data.telefone)}`);
  if (data.cidade) found.push(`Cidade: ${data.cidade}`);
  if (data.estado) found.push(`Estado: ${normalizeUF(data.estado)}`);

  const nextField = missingFields[0];

  const questionMap = {
    nome: "Só ficou faltando seu nome completo.",
    cpf: "Só ficou faltando seu CPF.",
    telefone: "Só ficou faltando seu telefone com DDD.",
    cidade: "Só ficou faltando sua cidade e estado. Pode mandar assim: Duartina SP.",
estado: "Só ficou faltando sua cidade e estado. Pode mandar assim: Duartina SP."
  };

  const question = questionMap[nextField] || "Só ficou faltando uma informação.";

  if (found.length === 0) {
    return getMissingFieldQuestion(nextField);
  }

  return `Perfeito, consegui identificar até agora:

${found.join("\n")}

${question}`;
}

function isPostCrmLead(lead = {}) {
  return Boolean(
    lead?.crmEnviado === true ||
    lead?.statusOperacional === "enviado_crm" ||
    lead?.statusOperacional === "em_atendimento" ||
    lead?.faseFunil === "crm" ||
    lead?.status === "enviado_crm" ||
    lead?.faseQualificacao === "enviado_crm" ||
    lead?.status === "em_atendimento" ||
    lead?.faseQualificacao === "em_atendimento"
  );
}

function isHumanAssumedLead(lead = {}) {
  return Boolean(
    lead?.humanoAssumiu === true ||
    lead?.atendimentoHumanoAtivo === true ||
    lead?.botBloqueadoPorHumano === true ||
    lead?.statusOperacional === "em_atendimento" ||
    lead?.status === "em_atendimento" ||
    lead?.faseQualificacao === "em_atendimento"
  );
}

async function answerPostCrmQuestion({
  currentLead = {},
  history = [],
  userText = ""
} = {}) {
  const recentHistory = Array.isArray(history)
    ? history.slice(-10).map(message => ({
        role: message.role,
        content: message.content
      }))
    : [];

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `Você é a SDR comercial da IQG no WhatsApp.

A conversa já foi enviada ao CRM ou está em atendimento pela equipe IQG.

Sua tarefa:
1. Continuar ajudando o lead com dúvidas comerciais.
2. Responder de forma curta, natural e consultiva.
3. NÃO reiniciar coleta de dados.
4. NÃO pedir CPF, telefone, cidade, estado ou nome novamente.
5. NÃO reenviar o lead ao CRM.
6. NÃO dizer que aprovou o lead.
7. NÃO pedir pagamento.
8. NÃO prometer ganhos.
9. Se o lead perguntar sobre próximos passos, explique que a equipe IQG já recebeu os dados e seguirá com a análise/orientação.
10. Se o lead perguntar sobre estoque, taxa, contrato, margem, afiliado ou funcionamento, responda normalmente.
11. Se o lead pedir humano, diga que a equipe IQG já foi acionada ou poderá complementar o atendimento, mas você pode continuar ajudando por aqui.

Não mencione Supervisor, Classificador, Consultor Assistente, backend, CRM interno ou agentes internos.

Responda em até 3 blocos curtos.`
          },
          {
            role: "user",
            content: JSON.stringify({
              ultimaMensagemLead: userText || "",
              historicoRecente: recentHistory,
              lead: {
                status: currentLead?.status || "",
                faseQualificacao: currentLead?.faseQualificacao || "",
                statusOperacional: currentLead?.statusOperacional || "",
                faseFunil: currentLead?.faseFunil || "",
                temperaturaComercial: currentLead?.temperaturaComercial || "",
                rotaComercial: currentLead?.rotaComercial || "",
                crmEnviado: currentLead?.crmEnviado === true,
                dadosConfirmadosPeloLead: currentLead?.dadosConfirmadosPeloLead === true
              }
            })
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro ao responder no modo pós-CRM:", data);

      return "Claro, posso continuar te ajudando por aqui 😊\n\nSeus dados já foram encaminhados para a equipe IQG, então agora posso esclarecer dúvidas sobre estoque, taxa, contrato, margem, afiliado ou próximos passos sem reiniciar o cadastro.";
    }

    const answer = data.choices?.[0]?.message?.content?.trim();

    if (!answer) {
      return "Claro, posso continuar te ajudando por aqui 😊\n\nSeus dados já foram encaminhados para a equipe IQG, então agora posso esclarecer suas dúvidas sem reiniciar o cadastro.";
    }

    return answer;
  } catch (error) {
    console.error("Falha ao responder no modo pós-CRM:", error.message);

    return "Claro, posso continuar te ajudando por aqui 😊\n\nSeus dados já foram encaminhados para a equipe IQG, então agora posso esclarecer suas dúvidas sem reiniciar o cadastro.";
  }
}

function canSendLeadToCRM(lead = {}) {
  const dadosConfirmados = lead.dadosConfirmadosPeloLead === true;

  const faseAntigaValida = [
    "dados_confirmados",
    "qualificado"
  ].includes(lead.faseQualificacao);

  const statusAntigoValido = lead.status === "quente";

  const faseNovaValida = [
    "confirmacao_dados",
    "pre_analise"
  ].includes(lead.faseFunil);

  const temperaturaNovaValida = lead.temperaturaComercial === "quente";

  const statusOperacionalPermiteEnvio =
    ![
      "em_atendimento",
      "enviado_crm",
      "fechado",
      "perdido"
    ].includes(lead.statusOperacional);

  const temDadosObrigatorios =
    lead.nome &&
    lead.cpf &&
    lead.telefone &&
    lead.cidade &&
    lead.estado;

  const caminhoAntigoValido = faseAntigaValida && statusAntigoValido;
  const caminhoNovoValido = faseNovaValida && temperaturaNovaValida;

  return (
    dadosConfirmados &&
    lead.crmEnviado !== true &&
    statusOperacionalPermiteEnvio &&
    temDadosObrigatorios &&
    (caminhoAntigoValido || caminhoNovoValido)
  );
}

function normalizeForRepeatCheck(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isRepeatedBotReply(newReply = "", history = []) {
  const normalizedNewReply = normalizeForRepeatCheck(newReply);

  if (!normalizedNewReply) return false;

  const lastAssistantMessage = [...history]
    .reverse()
    .find(m => m.role === "assistant")?.content || "";

  const normalizedLastReply = normalizeForRepeatCheck(lastAssistantMessage);

  if (!normalizedLastReply) return false;

  return normalizedNewReply === normalizedLastReply;
}

function normalizeTextForIntent(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ⚠️ FUNÇÃO AUXILIAR ANTIGA
// Não usar esta função para decidir sozinha que o lead virou Afiliado.
// A decisão oficial de rota comercial agora é feita por:
// decideCommercialRouteFromSemanticIntent().
// Esta função pode permanecer apenas como apoio secundário em travas antigas,
// mas não deve comandar status, fase ou rota comercial.

function isAffiliateIntent(text = "") {
  const t = normalizeTextForIntent(text);

  return (
    t.includes("afiliado") ||
    t.includes("afiliados") ||
    t.includes("afiliacao") ||
    t.includes("programa de afiliados") ||
    t.includes("cadastro de afiliado") ||
    t.includes("cadastrar como afiliado") ||
    t.includes("quero ser afiliado") ||
    t.includes("quero virar afiliado") ||
    t.includes("link de afiliado") ||
    t.includes("meu link de afiliado") ||
    t.includes("gerar link") ||
    t.includes("link exclusivo") ||
    t.includes("comissao por link") ||
    t.includes("comissao online") ||
    t.includes("ganhar comissao online") ||
    t.includes("divulgar por link") ||
    t.includes("vender por link")
  );
}

// ⚠️ FUNÇÃO AUXILIAR ANTIGA
// Não usar para converter lead em Afiliado automaticamente.
// Objeção de taxa, estoque ou investimento deve ser tratada primeiro no Homologado.
// Só a rota semântica central pode mudar a rota para Afiliado ou Ambos.

function isAffiliateAlternativeOpportunity(text = "") {
  const t = normalizeTextForIntent(text);

  const rejeitouAdesao =
    t.includes("nao quero pagar adesao") ||
    t.includes("não quero pagar adesão") ||
    t.includes("nao quero adesao") ||
    t.includes("não quero adesão") ||
    t.includes("nao quero pagar taxa") ||
    t.includes("não quero pagar taxa");

  const rejeitouEstoque =
    t.includes("nao quero estoque") ||
    t.includes("não quero estoque") ||
    t.includes("nao quero produto fisico") ||
    t.includes("não quero produto físico") ||
    t.includes("nao quero mexer com estoque") ||
    t.includes("não quero mexer com estoque");

  const pediuModeloSemEstoque =
    t.includes("tem algo sem estoque") ||
    t.includes("tem opcao sem estoque") ||
    t.includes("tem opção sem estoque") ||
    t.includes("quero algo sem estoque") ||
    t.includes("sem estoque e sem taxa") ||
    t.includes("sem pagar adesao") ||
    t.includes("sem pagar adesão");

  return rejeitouAdesao || rejeitouEstoque || pediuModeloSemEstoque;
}

function isPreCrmBlockingObjection(text = "") {
  const t = normalizeTextForIntent(text);

  return (
    // trava por preço / taxa
    t.includes("achei caro") ||
    t.includes("muito caro") ||
    t.includes("taxa cara") ||
    t.includes("taxa alta") ||
    t.includes("valor alto") ||
    t.includes("ficou pesado") ||
    t.includes("pesado pra mim") ||
    t.includes("nao tenho dinheiro") ||
    t.includes("não tenho dinheiro") ||
    t.includes("sem dinheiro agora") ||
    t.includes("nao consigo pagar") ||
    t.includes("não consigo pagar") ||
    t.includes("nao posso pagar") ||
    t.includes("não posso pagar") ||

    // rejeição da taxa
    t.includes("nao quero pagar taxa") ||
    t.includes("não quero pagar taxa") ||
    t.includes("nao quero pagar adesao") ||
    t.includes("não quero pagar adesão") ||
    t.includes("nao quero adesao") ||
    t.includes("não quero adesão") ||

    // rejeição de estoque / físico
    t.includes("nao quero estoque") ||
    t.includes("não quero estoque") ||
    t.includes("nao quero produto fisico") ||
    t.includes("não quero produto físico") ||
    t.includes("nao quero mexer com estoque") ||
    t.includes("não quero mexer com estoque") ||

    // medo / risco / desistência leve
    t.includes("tenho medo") ||
    t.includes("medo de arriscar") ||
    t.includes("parece arriscado") ||
    t.includes("muito risco") ||
    t.includes("vou pensar") ||
    t.includes("vou deixar pra depois") ||
    t.includes("talvez depois") ||
    t.includes("agora nao") ||
    t.includes("agora não") ||
    t.includes("nao e pra mim") ||
    t.includes("não é pra mim")
  );
}

// ⚠️ FUNÇÃO AUXILIAR ANTIGA
// Esta função não deve mais acionar mudança automática de rota.
// Ela pode ser mantida por enquanto para compatibilidade,
// mas a decisão real deve vir de decideCommercialRouteFromSemanticIntent().

function isClearAffiliateFallbackIntent(text = "") {
  const t = normalizeTextForIntent(text);

  return (
    // intenção direta de afiliado
    isAffiliateIntent(text) ||

    // quer modelo sem estoque / sem taxa / por link
    t.includes("quero algo sem estoque") ||
    t.includes("tem algo sem estoque") ||
    t.includes("tem opcao sem estoque") ||
    t.includes("tem opção sem estoque") ||
    t.includes("quero vender por link") ||
    t.includes("quero divulgar por link") ||
    t.includes("quero so divulgar") ||
    t.includes("quero só divulgar") ||
    t.includes("quero ganhar por indicacao") ||
    t.includes("quero ganhar por indicação") ||
    t.includes("posso indicar e ganhar") ||

    // rejeição clara do modelo físico
    t.includes("nao quero estoque") ||
    t.includes("não quero estoque") ||
    t.includes("nao quero produto fisico") ||
    t.includes("não quero produto físico") ||
    t.includes("nao quero mexer com estoque") ||
    t.includes("não quero mexer com estoque") ||

    // rejeição clara da taxa, não apenas objeção leve
    t.includes("nao quero pagar taxa") ||
    t.includes("não quero pagar taxa") ||
    t.includes("nao quero pagar adesao") ||
    t.includes("não quero pagar adesão") ||
    t.includes("nao quero adesao") ||
    t.includes("não quero adesão")
  );
}

function buildAffiliateRecoveryResponse() {
  return `Entendo totalmente 😊

O Parceiro Homologado é um modelo mais estruturado, com produtos físicos, lote em comodato, suporte, treinamento, contrato e taxa de adesão. Ele faz mais sentido para quem quer atuar com produto em mãos e vender de forma mais ativa.

Mas se esse formato não fizer sentido para você agora, existe um caminho mais simples: o Programa de Afiliados IQG.

No afiliado, você não precisa ter estoque, não recebe lote em comodato e não tem a taxa de adesão do Parceiro Homologado.

Você se cadastra, gera seus links exclusivos e divulga os produtos online. Quando o cliente compra pelo seu link e a venda é validada, você recebe comissão.

O cadastro é por aqui:
https://minhaiqg.com.br/

Se depois você quiser algo mais estruturado, com produtos em mãos e suporte da indústria, aí podemos retomar o Parceiro Homologado.`;
}

function buildAffiliateResponse(isAlternative = false) {
  if (isAlternative) {
    return `Entendi 😊 Nesse caso, talvez o Programa de Afiliados IQG faça mais sentido como uma alternativa mais simples.

Ele é outro projeto, separado do Parceiro Homologado, mas você pode participar dos dois se fizer sentido para você.

No afiliado, você não precisa ter estoque, não precisa comprar produtos e não passa pela pré-análise do Homologado. Você se cadastra, gera seus links exclusivos e divulga os produtos online. Quando o cliente compra pelo seu link e a venda é validada, você recebe comissão.

O cadastro e acesso são por aqui:
https://minhaiqg.com.br/

Acesse o portal para fazer seu cadastro e consultar mais informações do programa.`;
  }

  return `Perfeito 😊 Nesse caso, o caminho certo é o Programa de Afiliados IQG.

Ele é diferente do Parceiro Homologado. No afiliado, você não precisa ter estoque, não precisa comprar produtos e não passa pela pré-análise do Homologado.

Funciona assim: você faz o cadastro, gera seus links exclusivos e divulga os produtos nas redes sociais, WhatsApp, Instagram, Facebook ou outros canais. Quando o cliente compra pelo seu link e a venda é validada, você recebe comissão.

Principais pontos:
• não precisa de estoque;
• não exige investimento inicial;
• você divulga por link;
• recebe comissão por vendas validadas;
• o saque pode ser feito a partir de R$100;
• há materiais prontos para divulgação.

O cadastro e acesso são por aqui:
https://minhaiqg.com.br/

Acesse o portal para fazer seu cadastro e consultar mais informações do programa.`;
}

function classifyLead(text = "", data = {}, history = []) {
  const t = text.toLowerCase();

// 🔀 AFILIADO NÃO É MAIS DECIDIDO AQUI
// Antes, esta função podia transformar o lead em Afiliado usando palavras-chave.
// Agora, Afiliado é decidido apenas pela rota semântica central:
// decideCommercialRouteFromSemanticIntent().
//
// Motivo:
// Evita misturar objeção de taxa, rejeição de estoque ou frases soltas com intenção real de Afiliado.
//
// Esta função classifyLead continua servindo para sinais gerais:
// frio, morno, qualificando e pre_analise.
   
  const hasInterest =
  isExplicitPreAnalysisIntent(text) ||
  t.includes("quero começar") ||
  t.includes("quero comecar") ||
  t.includes("quero entrar") ||
  t.includes("quero participar") ||
  t.includes("tenho interesse em entrar") ||
  t.includes("tenho interesse em participar") ||
  t.includes("pode iniciar") ||
  t.includes("podemos iniciar") ||
  t.includes("quero aderir");

  const isRejecting =
    t.includes("não tenho interesse") ||
    t.includes("nao tenho interesse") ||
    t.includes("talvez depois") ||
    t.includes("não é pra mim") ||
    t.includes("nao é pra mim") ||
    t.includes("sem interesse");

  if (isRejecting) {
    return "frio";
  }

  const hasMinimumData =
    Boolean(data.nome) &&
    Boolean(data.cpf) &&
    Boolean(data.cidadeEstado) &&
    Boolean(data.telefone) &&
    Boolean(data.areaAtuacao) &&
    Boolean(data.nomeLimpo);

  const historyText = history
    .map(m => m.content || "")
    .join(" ")
    .toLowerCase();

  const discussedProgram =
    historyText.includes("programa") ||
    historyText.includes("parceria") ||
    historyText.includes("parceiro homologado");

  const discussedBenefits =
    historyText.includes("benefício") ||
    historyText.includes("beneficios") ||
    historyText.includes("comissão") ||
    historyText.includes("comissao") ||
    historyText.includes("comodato");

  const discussedFee =
    historyText.includes("1.990") ||
    historyText.includes("1990") ||
    historyText.includes("taxa") ||
    historyText.includes("adesão") ||
    historyText.includes("adesao") ||
    historyText.includes("investimento");

  const discussedRules =
    historyText.includes("nome limpo") ||
    historyText.includes("contrato") ||
    historyText.includes("análise interna") ||
    historyText.includes("analise interna") ||
    historyText.includes("comodato");

 const hasCleanNameInfo =
  data.nomeLimpo === "sim" || data.nomeLimpo === "nao";

if (
  hasInterest &&
  hasMinimumData &&
  discussedProgram &&
  discussedBenefits &&
  discussedFee &&
  discussedRules &&
  hasCleanNameInfo
) {
  return "pre_analise";
}

  if (hasMinimumData) {
    return "pre_analise";
  }

  if (hasInterest && !isSoftUnderstandingConfirmation(text)) {
  return "qualificando";
}

  if (
    t.includes("como funciona") ||
    t.includes("me explica") ||
    t.includes("valor") ||
    t.includes("preço") ||
    t.includes("preco") ||
    t.includes("investimento") ||
    t.includes("interessante")
  ) {
    return "morno";
  }

  return null;
}

function canSendBusinessFile(key, lead = {}) {
  if (key !== "contrato") {
    return true;
  }

  return (
    lead?.crmEnviado === true ||
    lead?.statusOperacional === "enviado_crm" ||
    lead?.statusOperacional === "em_atendimento" ||
    lead?.faseFunil === "crm" ||
    lead?.status === "enviado_crm" ||
    lead?.faseQualificacao === "enviado_crm"
  );
}

function removeFileAction(actions = [], keyToRemove = "") {
  if (!Array.isArray(actions)) return;

  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i] === keyToRemove) {
      actions.splice(i, 1);
    }
  }
}

async function sendFileOnce(from, key) {
  if (!FILES[key]) return false;

  await connectMongo();

  const sentField = `sentFiles.${key}`;

  const lead = await db.collection("leads").findOne({ user: from });

  if (lead?.sentFiles?.[key]) {
    console.log("📎 Arquivo não reenviado porque já foi enviado:", {
      user: from,
      arquivo: key
    });

    return false;
  }

  await db.collection("leads").updateOne(
    { user: from },
    {
      $set: {
        [sentField]: new Date(),
        updatedAt: new Date()
      }
    },
    { upsert: true }
  );

  await delay(2000);
  await sendWhatsAppDocument(from, FILES[key]);

  return true;
}

function getBrazilNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + BUSINESS_TIMEZONE_OFFSET * 60 * 60 * 1000);
}

function isBusinessTime() {
  const now = getBrazilNow();
  const day = now.getDay(); // 0 = domingo, 6 = sábado
  const hour = now.getHours();

  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    return false;
  }

  return hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

function getDelayUntilNextBusinessTime() {
  const now = getBrazilNow();
  const next = new Date(now);

  next.setHours(BUSINESS_START_HOUR, 0, 0, 0);

  if (
    now.getHours() >= BUSINESS_END_HOUR ||
    now.getDay() === 6 ||
    now.getDay() === 0
  ) {
    next.setDate(next.getDate() + 1);
  }

  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }

  if (
    now.getHours() < BUSINESS_START_HOUR &&
    now.getDay() !== 0 &&
    now.getDay() !== 6
  ) {
    next.setDate(now.getDate());
  }

  return Math.max(next.getTime() - now.getTime(), 0);
}

function getSmartFollowupMessage(lead = {}, step = 1) {
  const nome = getFirstName(lead.nomeWhatsApp || lead.nome || "");
  const prefixo = nome ? `${nome}, ` : "";

  const rotaComercial = lead.rotaComercial || lead.origemConversao || "";
  const faseFunil = lead.faseFunil || "";
  const temperaturaComercial = lead.temperaturaComercial || "";
  const faseAntiga = lead.faseQualificacao || lead.status || "";

  const fase = faseFunil || faseAntiga;

  const isAfiliado =
    rotaComercial === "afiliado" ||
    fase === "afiliado" ||
    faseAntiga === "afiliado";

  if (isAfiliado) {
    if (step === 1) {
      return `${prefixo}conseguiu acessar o cadastro de afiliado? 😊 O link é: https://minhaiqg.com.br/`;
    }

    return `${prefixo}se quiser começar sem estoque e sem taxa de adesão do Homologado, o afiliado pode ser um bom primeiro passo. As informações e cadastro estão aqui: https://minhaiqg.com.br/`;
  }

  const isAmbos =
    rotaComercial === "ambos" ||
    fase === "ambos" ||
    faseAntiga === "ambos";

  if (isAmbos) {
    if (step === 1) {
      return `${prefixo}ficou claro para você a diferença entre o Programa de Afiliados e o Parceiro Homologado? 😊`;
    }

    return `${prefixo}quer seguir pelo cadastro de afiliado, entender melhor o Parceiro Homologado ou avaliar os dois caminhos?`;
  }
   
  if (
    fase === "inicio" ||
    fase === "esclarecimento" ||
    faseAntiga === "inicio" ||
    faseAntiga === "novo"
  ) {
    if (step === 1) {
      return `${prefixo}ficou alguma dúvida sobre como funciona o Programa Parceiro Homologado IQG? 😊`;
    }

    return `${prefixo}quer que eu te explique os principais benefícios de forma bem direta?`;
  }

  if (
    fase === "beneficios" ||
    faseAntiga === "morno"
  ) {
    if (step === 1) {
      return `${prefixo}ficou alguma dúvida sobre os benefícios ou sobre o suporte que a IQG oferece ao parceiro? 😊`;
    }

    return `${prefixo}quer que eu te explique agora como funciona o estoque inicial em comodato?`;
  }

  if (fase === "estoque") {
    if (step === 1) {
      return `${prefixo}ficou alguma dúvida sobre o estoque inicial em comodato? 😊`;
    }

    return `${prefixo}quer que eu te resuma o que vem no lote inicial e como ele funciona na prática?`;
  }

  if (fase === "responsabilidades") {
    if (step === 1) {
      return `${prefixo}ficou claro para você a parte das responsabilidades do parceiro? 😊`;
    }

    return `${prefixo}quer que eu avance para te explicar o investimento de adesão com transparência?`;
  }

  if (
    fase === "investimento" ||
    faseAntiga === "qualificando"
  ) {
    if (step === 1) {
      return `${prefixo}ficou alguma dúvida sobre o investimento de adesão ou sobre o que está incluso? 😊`;
    }

    return `${prefixo}faz sentido pra você seguir nesse formato ou quer avaliar algum ponto antes?`;
  }

  if (fase === "compromisso") {
    if (step === 1) {
      return `${prefixo}só preciso confirmar um ponto importante: você está de acordo que o resultado depende da sua atuação nas vendas? 😊`;
    }

    return `${prefixo}se esse ponto fizer sentido pra você, podemos seguir para a pré-análise.`;
  }

  if (
    fase === "coleta_dados" ||
    faseAntiga === "coletando_dados" ||
    faseAntiga === "dados_parciais" ||
    faseAntiga === "aguardando_dados"
  ) {
    if (step === 1) {
      return `${prefixo}só falta continuarmos com seus dados para a pré-análise 😊`;
    }

    return `${prefixo}quer seguir com a pré-análise agora? É bem rápido.`;
  }

  if (
    fase === "confirmacao_dados" ||
    faseAntiga === "aguardando_confirmacao_campo" ||
    faseAntiga === "aguardando_confirmacao_dados"
  ) {
    if (step === 1) {
      return `${prefixo}só preciso da sua confirmação para continuar 😊`;
    }

    return `${prefixo}pode me confirmar se os dados estão corretos?`;
  }

  if (fase === "pre_analise") {
    if (step === 1) {
      return `${prefixo}sua pré-análise está encaminhada. Ficou alguma dúvida final sobre o próximo passo? 😊`;
    }

    return `${prefixo}o próximo passo é a validação da equipe comercial da IQG. Se tiver alguma dúvida, posso te orientar por aqui.`;
  }

  if (temperaturaComercial === "quente") {
    if (step === 1) {
      return `${prefixo}faz sentido seguirmos para o próximo passo? 😊`;
    }

    return `${prefixo}posso te ajudar a avançar com segurança na pré-análise.`;
  }

  if (step === 1) {
    return `${prefixo}ficou alguma dúvida sobre o programa? 😊`;
  }

  return `${prefixo}quer que eu te explique de forma mais direta?`;
}

function getFinalFollowupMessage(lead = {}) {
  const nome = getFirstName(lead.nomeWhatsApp || lead.nome || "");
  const prefixo = nome ? `${nome}, ` : "";

  const jaVirouParceiroConfirmado =
    lead?.dadosConfirmadosPeloLead === true ||
    lead?.crmEnviado === true ||
    lead?.statusOperacional === "enviado_crm" ||
    lead?.faseFunil === "crm" ||
    lead?.faseQualificacao === "enviado_crm" ||
    lead?.status === "enviado_crm";

  const jaEstaEmAfiliado =
    lead?.interesseAfiliado === true ||
    lead?.rotaComercial === "afiliado" ||
    lead?.faseQualificacao === "afiliado" ||
    lead?.status === "afiliado";
     const jaEstaEmAmbos =
    lead?.rotaComercial === "ambos" ||
    lead?.origemConversao === "comparacao_homologado_afiliado";

  if (jaVirouParceiroConfirmado) {
    return `${prefixo}vou encerrar por aqui 😊

Sua pré-análise já ficou encaminhada para a equipe comercial da IQG.

Se surgir alguma dúvida, fico à disposição.`;
  }

  if (jaEstaEmAmbos) {
    return `${prefixo}vou encerrar por aqui 😊

Só reforçando a diferença:

No Programa de Afiliados, você divulga por link, não precisa ter estoque e não tem a taxa de adesão do Parceiro Homologado.

No Parceiro Homologado, o modelo é mais estruturado, com produtos físicos, lote em comodato, suporte, treinamento, contrato e taxa de adesão.

Você pode avaliar só o afiliado, só o homologado ou os dois caminhos.

Cadastro de afiliado:
https://minhaiqg.com.br/

Se quiser retomar depois o Parceiro Homologado, posso te explicar por aqui.`;
  }
   
  if (jaEstaEmAfiliado) {
    return `${prefixo}vou encerrar por aqui 😊

Só reforçando: para o Programa de Afiliados IQG, você pode acessar o cadastro por aqui:
https://minhaiqg.com.br/

No afiliado, você divulga por link, não precisa ter estoque e não tem a taxa de adesão do Parceiro Homologado.

Qualquer dúvida, fico à disposição.`;
  }

  return `${prefixo}vou encerrar por aqui 😊

Se o modelo de Parceiro Homologado não fizer sentido para você agora, existe também o Programa de Afiliados IQG.

Ele é mais simples para começar: você não precisa ter estoque, não precisa receber lote em comodato e não tem a taxa de adesão do Parceiro Homologado.

Você se cadastra, gera seus links exclusivos e divulga os produtos online. Quando o cliente compra pelo seu link e a venda é validada, você recebe comissão.

O cadastro é por aqui:
https://minhaiqg.com.br/

Se depois quiser algo mais estruturado, com produtos em mãos, suporte e lote em comodato, aí sim podemos retomar o Parceiro Homologado.`;
}

  function shouldStopBotByLifecycle(lead = {}) {
  lead = lead || {};

  const status = lead.status || "";
  const fase = lead.faseQualificacao || "";
  const statusOperacional = lead.statusOperacional || "";
  const faseFunil = lead.faseFunil || "";

  const blockedOldValues = [
    "em_atendimento",
    "enviado_crm",
    "fechado",
    "perdido"
  ];

  const blockedOperationalValues = [
    "em_atendimento",
    "enviado_crm",
    "fechado",
    "perdido"
  ];

  const blockedFunnelValues = [
    "crm",
    "encerrado"
  ];

  return (
    blockedOldValues.includes(status) ||
    blockedOldValues.includes(fase) ||
    blockedOperationalValues.includes(statusOperacional) ||
    blockedFunnelValues.includes(faseFunil)
  );
}
   
function scheduleLeadFollowups(from) {
  const state = getState(from);

  if (state.closed) return;

  clearTimers(from);

  state.inactivityFollowupCount = 0;
  state.followupTimers = [];

  const followups = [
  {
    delay: 6 * 60 * 1000,
    getMessage: (lead) => getSmartFollowupMessage(lead, 1)
  },
  {
    delay: 30 * 60 * 1000,
    getMessage: (lead) => getSmartFollowupMessage(lead, 2)
  },
    {
      delay: 6 * 60 * 60 * 1000,
      message: "Passando só para saber se ficou alguma dúvida sobre o programa 😊",
      businessOnly: true
    },
    {
      delay: 12 * 60 * 60 * 1000,
      message: "Você vê isso como renda extra ou algo mais estruturado?",
      businessOnly: true
    },
    {
      delay: 18 * 60 * 60 * 1000,
      message: "Você já trabalha com vendas ou atendimento?",
      businessOnly: true
    },
    {
      delay: 24 * 60 * 60 * 1000,
      message: "Quer que eu siga com sua pré-análise?",
      businessOnly: true
    },
   {
  delay: 30 * 60 * 60 * 1000,
  getMessage: (lead) => getFinalFollowupMessage(lead),
  businessOnly: true,
  closeAfter: true
}
  ];

  for (const followup of followups) {
    const timer = setTimeout(async () => {
      try {
        const currentState = getState(from);

if (currentState.closed) return;

const latestLead = await loadLeadProfile(from);

if (shouldStopBotByLifecycle(latestLead)) {
  currentState.closed = true;
  clearTimers(from);
  return;
}

        if (followup.businessOnly && !isBusinessTime()) {
          const nextBusinessDelay = getDelayUntilNextBusinessTime();

          const businessTimer = setTimeout(async () => {
            try {
const latestState = getState(from);

if (latestState.closed) return;

const latestLead = await loadLeadProfile(from);

if (shouldStopBotByLifecycle(latestLead)) {
  latestState.closed = true;
  clearTimers(from);
  return;
}

const businessMessageToSend = followup.getMessage
  ? followup.getMessage(latestLead)
  : followup.message;

await sendWhatsAppMessage(from, businessMessageToSend);
               
              if (followup.closeAfter) {
                latestState.closed = true;
                clearTimers(from);
              }
            } catch (error) {
              console.error("Erro no follow-up em horário comercial:", error);
            }
          }, nextBusinessDelay);

          currentState.followupTimers.push(businessTimer);
          return;
        }

        const leadAtual = await loadLeadProfile(from);

const messageToSend = followup.getMessage
  ? followup.getMessage(leadAtual)
  : followup.message;

await sendWhatsAppMessage(from, messageToSend);
         
        if (followup.closeAfter) {
          currentState.closed = true;
          clearTimers(from);
        }
      } catch (error) {
        console.error("Erro no follow-up automático:", error);
      }
    }, followup.delay);

    state.followupTimers.push(timer);
  }
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  console.log("Falha na verificação do webhook.");
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  let messageId = null;

  try {
   console.log("📩 Webhook POST recebido:", JSON.stringify(req.body, null, 2));

const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

if (!message) {
  console.log("ℹ️ Webhook recebido sem mensagem. Pode ser status/read/delivery.");
  return res.sendStatus(200);
}

console.log("✅ Mensagem recebida do WhatsApp:", {
  id: message.id,
  from: message.from,
  type: message.type,
  text: message.text?.body || null
});

// 🔥 RESPONDE IMEDIATAMENTE PARA O WHATSAPP
if (!res.headersSent) {
  res.sendStatus(200);
}
     
     const contact = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
const whatsappProfileName = contact?.profile?.name || "";

    messageId = message.id || null;

    if (messageId) {
  const canProcess = await claimMessage(messageId);

  if (!canProcess) {
    return;
  }
}

    const from = message.from;
const state = getState(from);

const leadBeforeProcessing = await loadLeadProfile(from);

     console.log("🔎 Lead antes do processamento:", {
  from,
  status: leadBeforeProcessing?.status || null,
  faseQualificacao: leadBeforeProcessing?.faseQualificacao || null,
  stateClosed: state.closed
});

const leadJaEstaPosCrm = isPostCrmLead(leadBeforeProcessing || {});

const leadEstavaMarcadoComoEncerrado =
  ["fechado", "perdido"].includes(leadBeforeProcessing?.status) ||
  ["fechado", "perdido"].includes(leadBeforeProcessing?.faseQualificacao) ||
  ["fechado", "perdido"].includes(leadBeforeProcessing?.statusOperacional) ||
  leadBeforeProcessing?.faseFunil === "encerrado";

if (leadEstavaMarcadoComoEncerrado) {
  console.log("✅ Lead estava marcado como encerrado, mas chamou novamente. Atendimento será reativado:", {
    from,
    status: leadBeforeProcessing?.status,
    faseQualificacao: leadBeforeProcessing?.faseQualificacao,
    statusOperacional: leadBeforeProcessing?.statusOperacional,
    faseFunil: leadBeforeProcessing?.faseFunil
  });
}

/*
  BLOCO 1 — NOVA REGRA:
  state.closed não pode impedir resposta quando o lead chama novamente.

  Se a SDR parou por cadência, encerramento anterior ou memória local,
  isso só significa que ela não deve mandar mensagens sozinha.

  Mas se o lead chamou, a conversa deve ser reanalisada.
*/
if (state.closed) {
  console.log("✅ state.closed estava ativo, mas o lead chamou novamente. Reabrindo atendimento:", {
    from,
    leadJaEstaPosCrm,
    status: leadBeforeProcessing?.status,
    faseQualificacao: leadBeforeProcessing?.faseQualificacao,
    statusOperacional: leadBeforeProcessing?.statusOperacional,
    faseFunil: leadBeforeProcessing?.faseFunil
  });

  state.closed = false;
}

/*
  BLOCO 1 — NOVA REGRA:
  CONSULTANT_PHONE não deve ser bloqueado.

  O número do consultor/dev pode conversar com o bot normalmente
  para testes reais do fluxo.
*/
const fromDigits = onlyDigits(from);
const consultantDigits = onlyDigits(process.env.CONSULTANT_PHONE || "");

if (consultantDigits && fromDigits === consultantDigits) {
  console.log("🧪 Mensagem recebida do CONSULTANT_PHONE. Modo teste ativo, processando normalmente:", {
    from,
    consultantPhone: process.env.CONSULTANT_PHONE
  });
}

clearTimers(from);
state.closed = false;

// BLOCO 9A — HUMANO ASSUMIU A CONVERSA
// Se o dashboard marcou atendimento humano, a SDR IA não deve responder.
// Isso é a única situação em que o dashboard bloqueia a IA.
if (isHumanAssumedLead(leadBeforeProcessing || {})) {
  console.log("🧑‍💼 Atendimento humano ativo. SDR IA não responderá esta mensagem:", {
    from,
    status: leadBeforeProcessing?.status || "",
    faseQualificacao: leadBeforeProcessing?.faseQualificacao || "",
    statusOperacional: leadBeforeProcessing?.statusOperacional || "",
    faseFunil: leadBeforeProcessing?.faseFunil || "",
    humanoAssumiu: leadBeforeProcessing?.humanoAssumiu === true,
    atendimentoHumanoAtivo: leadBeforeProcessing?.atendimentoHumanoAtivo === true,
    botBloqueadoPorHumano: leadBeforeProcessing?.botBloqueadoPorHumano === true
  });

  return;
}
     
let text = "";
let isAudioMessage = false;

if (message.text?.body) {
  text = message.text.body.trim();

} else if (message.audio?.id) {
  isAudioMessage = true;

  const mediaUrl = await getWhatsAppMediaUrl(message.audio.id);
  const audioBuffer = await downloadWhatsAppMedia(mediaUrl);

  text = await transcribeAudioBuffer(audioBuffer, "audio.ogg");

  if (!text || !String(text).trim()) {
    await sendWhatsAppMessage(
      from,
      "Não consegui entender bem o áudio. Pode me enviar novamente ou escrever sua dúvida?"
    );

    return;
  }

  text = String(text).trim();

} else {
  await sendWhatsAppMessage(
    from,
    "No momento consigo te atender melhor por texto ou áudio 😊 Pode me enviar sua dúvida?"
  );

  return;
}

// 🤖 BLOQUEIO DE RESPOSTAS AUTOMÁTICAS DE OUTROS BOTS
if (isLikelyAutoReplyMessage(text)) {
  console.log("🤖 Mensagem automática detectada e ignorada:", {
    from,
    text
  });

  markMessageIdsAsProcessed([messageId]);

  return;
}
     
// 🔥 AGORA TEXTO E ÁUDIO PASSAM PELO MESMO BUFFER
// Isso evita respostas duplicadas quando o lead manda várias mensagens ou vários áudios seguidos.
const buffered = await collectBufferedText(from, text, messageId);

// Se esta mensagem foi apenas adicionada ao buffer,
// encerra este webhook sem chamar a IA.
if (!buffered.shouldContinue) {
  return;
}

// A primeira requisição continua com todas as mensagens juntas.
text = buffered.text;

// IDs de todas as mensagens agrupadas no buffer.
// Importante para marcar o grupo inteiro como processado ao finalizar.
const bufferedMessageIds = Array.isArray(buffered.messageIds) && buffered.messageIds.length > 0
  ? buffered.messageIds
  : [messageId].filter(Boolean);
     
// 🔥 carrega histórico antes de classificar
let history = await loadConversation(from);

let currentLead = await loadLeadProfile(from);

if (!currentLead) {
  await saveLeadProfile(from, {
    user: from,
    telefoneWhatsApp: from,
    nomeWhatsApp: whatsappProfileName,
    ultimaMensagem: text,
    faseQualificacao: "inicio",
    status: "novo"
  });

  currentLead = await loadLeadProfile(from);
} else {
  await saveLeadProfile(from, {
    ultimaMensagem: text,
    telefoneWhatsApp: from,
    nomeWhatsApp: currentLead.nomeWhatsApp || whatsappProfileName
  });

  currentLead = await loadLeadProfile(from);
}

const noMeansNoDoubt = isNoMeaningNoDoubt({
  leadText: text,
  history
});

if (noMeansNoDoubt) {
  console.log("✅ 'Não' interpretado como ausência de dúvida:", {
    user: from
  });

  text = "não tenho dúvida";
}

// 🧭 BLOCO 6 — ORIENTAÇÕES ESTRATÉGICAS DO BACKEND
// Esta lista acompanha a mensagem atual até o Consultor Pré-SDR.
// O backend registra sinais, mas não responde comercialmente pelo lead.
let backendStrategicGuidance = [];
let dataFlowQuestionAlreadyGuided = false;
     
// 🧠 ROTEADOR SEMÂNTICO DA COLETA / CONFIRMAÇÃO
// Objetivo:
// Durante o pré-cadastro, o backend continua protegendo a coleta,
// mas a SDR não pode ficar muda, cega ou surda.
// Se o lead fizer pergunta, objeção, reclamação ou misturar dúvida com dado,
// a SDR responde primeiro e depois retoma o ponto pendente.
const dataFlowSemanticStateCheck = isDataFlowState(currentLead || {});

if (dataFlowSemanticStateCheck) {
  const dataFlowRouter = await runDataFlowSemanticRouter({
    currentLead: currentLead || {},
    history,
    userText: text
  });

  console.log("🧠 Roteador semântico da coleta:", {
    user: from,
    ultimaMensagemLead: text,
    faseAtual: currentLead?.faseQualificacao || "-",
    campoEsperado: currentLead?.campoEsperado || "-",
    campoPendente: currentLead?.campoPendente || "-",
    tipoMensagem: dataFlowRouter?.tipoMensagem || "indefinido",
    deveResponderAntesDeColetar: dataFlowRouter?.deveResponderAntesDeColetar === true,
    deveProsseguirComColeta: dataFlowRouter?.deveProsseguirComColeta !== false,
    motivo: dataFlowRouter?.motivo || "-"
  });

  const tiposQueDevemResponderAntes = [
    "pergunta_comercial",
    "objecao_comercial",
    "pedido_humano",
    "misto"
  ];

  if (
  dataFlowRouter?.deveResponderAntesDeColetar === true ||
  tiposQueDevemResponderAntes.includes(dataFlowRouter?.tipoMensagem)
) {
  dataFlowQuestionAlreadyGuided = true;

  const campoRetomadaColeta =
    currentLead?.campoEsperado ||
    currentLead?.campoPendente ||
    "";

  backendStrategicGuidance.push({
    tipo: "pergunta_durante_coleta",
    prioridade: "alta",
    motivo: dataFlowRouter?.motivo || "Lead fez pergunta, objeção ou pedido durante coleta/confirmação de dados.",
    orientacaoParaPreSdr:
      [
        "O lead está em coleta/confirmação de dados, mas trouxe uma pergunta, objeção, pedido humano ou mensagem mista.",
        "O backend NÃO deve responder diretamente nem tratar essa mensagem como dado.",
        "O Pré-SDR deve orientar a SDR a responder primeiro a dúvida ou manifestação atual do lead.",
        "Depois de responder, a SDR deve retomar a coleta exatamente de onde parou.",
        campoRetomadaColeta
          ? `Campo pendente para retomar depois da resposta: ${campoRetomadaColeta}.`
          : "Verificar no histórico qual dado estava pendente antes de retomar.",
        "Não reiniciar o cadastro. Não pedir todos os dados novamente. Não pular para outro fluxo."
      ].join("\n")
  });

  await saveLeadProfile(from, {
    fluxoPausadoPorPergunta: true,
    ultimaPerguntaDuranteColeta: text,
    tipoMensagemDuranteColeta: dataFlowRouter?.tipoMensagem || "indefinido",
    campoRetomadaColeta,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "pergunta_durante_coleta",
      motivo: dataFlowRouter?.motivo || "lead_fez_pergunta_durante_coleta",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        faseAtual: currentLead?.faseQualificacao || "",
        faseFunil: currentLead?.faseFunil || "",
        campoEsperado: currentLead?.campoEsperado || "",
        campoPendente: currentLead?.campoPendente || "",
        tipoMensagem: dataFlowRouter?.tipoMensagem || "indefinido",
        deveResponderAntesDeColetar: dataFlowRouter?.deveResponderAntesDeColetar === true,
        deveRetomarColetaDepois: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("🧭 Pergunta durante coleta enviada ao Pré-SDR, sem resposta direta do backend:", {
    user: from,
    ultimaMensagemLead: text,
    tipoMensagem: dataFlowRouter?.tipoMensagem || "indefinido",
    campoRetomadaColeta
  });
}
}
     
const historyText = history
  .map(m => m.content || "")
  .join("\n");

const isDataCollectionContext =
  currentLead?.faseQualificacao === "coletando_dados" ||
  currentLead?.faseQualificacao === "dados_parciais" ||
  currentLead?.faseQualificacao === "aguardando_dados" ||
  currentLead?.faseQualificacao === "aguardando_confirmacao_dados" ||
  currentLead?.faseQualificacao === "aguardando_confirmacao_campo" ||
  currentLead?.faseQualificacao === "corrigir_dado" ||
  currentLead?.dadosConfirmadosPeloLead === true ||
  /\b(nome|cpf|telefone|celular|whatsapp|cidade|estado|uf)\b/i.test(text);

const isConfirmationContext =
  currentLead?.faseQualificacao === "aguardando_confirmacao_campo" ||
  currentLead?.faseQualificacao === "aguardando_confirmacao_dados";

const textForExtraction = text;

// 🔥 CORREÇÃO GLOBAL DE DADOS
// Agora frases como "nome está errado", "CPF está incorreto"
// ou "cidade errada" são entendidas durante coleta e confirmação,
// não apenas quando o sistema já está em corrigir_dado_final.
const podeTratarCorrecaoDadosAgora =
  isDataCollectionContext ||
  isConfirmationContext ||
  currentLead?.aguardandoConfirmacaoCampo === true ||
  currentLead?.aguardandoConfirmacao === true;

const explicitCorrection = podeTratarCorrecaoDadosAgora
  ? extractExplicitCorrection(text)
  : {};
     
const fasesQuePermitemExtracao = [
  "coletando_dados",
  "dados_parciais",
  "aguardando_dados",
  "aguardando_confirmacao_campo",
  "aguardando_confirmacao_dados",
  "corrigir_dado",
  "corrigir_dado_final",
  "aguardando_valor_correcao_final"
];

const mensagemPareceConterDados =
  /\b(nome|cpf|telefone|celular|whatsapp|cidade|estado|uf)\b/i.test(text) ||
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/.test(text) ||
  /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4}/.test(text);

const leadPodeColetarDadosAgora =
  fasesQuePermitemExtracao.includes(currentLead?.faseQualificacao) ||
  canStartDataCollection(currentLead || {});

const podeTentarExtrairDados = leadPodeColetarDadosAgora;

let rawExtracted =
  Object.keys(explicitCorrection).length > 0
    ? {
        ...(currentLead || {}),
        ...explicitCorrection
      }
    : podeTentarExtrairDados
      ? extractLeadData(textForExtraction, currentLead || {})
      : {};

// 🔥 CAMPO ESPERADO COM FORÇA
// Se a SDR perguntou cidade, a resposta curta do lead deve ser tratada como cidade.
// Se perguntou estado, a resposta deve ser tratada como estado.
const forcedExpectedData = extractExpectedFieldData({
  field: currentLead?.campoEsperado,
  text: textForExtraction,
  currentLead
});

if (
  podeTentarExtrairDados &&
  Object.keys(explicitCorrection).length === 0 &&
  Object.keys(forcedExpectedData).length > 0
) {
  rawExtracted = {
    ...(rawExtracted || {}),
    ...forcedExpectedData
  };
}
     
// 🔥 NÃO SOBRESCREVE COM NULL
     
const extractedData = {
  ...(currentLead || {}),
  ...(rawExtracted || {})
};

// 🔥 Detecta gênero automaticamente quando tem nome
if (extractedData.nome) {
  const generoDetectado = detectGenderByName(extractedData.nome);

  if (generoDetectado) {
    extractedData.generoProvavel = generoDetectado;
  }
}
     
function normalizeLeadFieldValue(field, value = "") {
  if (value === null || value === undefined) return "";

  if (field === "cpf" || field === "telefone") {
    return onlyDigits(value);
  }

  if (field === "estado") {
    return normalizeUF(value);
  }

  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
     
let pendingExtractedData = Object.fromEntries(
  Object.entries(rawExtracted || {}).filter(([key, value]) => {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      !REQUIRED_LEAD_FIELDS.includes(key)
    ) {
      return false;
    }

    const newValue = normalizeLeadFieldValue(key, value);
    const savedValue = normalizeLeadFieldValue(key, currentLead?.[key]);

    if (!newValue) return false;

    if (savedValue && newValue === savedValue) return false;

    if (
      currentLead?.aguardandoConfirmacaoCampo &&
      currentLead?.campoPendente === key &&
      normalizeLeadFieldValue(key, currentLead?.valorPendente) === newValue
    ) {
      return false;
    }

    return true;
  })
);

// 🔥 CAMPO ESPERADO — usado apenas para priorizar, não para bloquear
const campoEsperado = currentLead?.campoEsperado;

if (campoEsperado && pendingExtractedData[campoEsperado]) {
  pendingExtractedData = {
    [campoEsperado]: pendingExtractedData[campoEsperado],
    ...Object.fromEntries(
      Object.entries(pendingExtractedData).filter(([key]) => key !== campoEsperado)
    )
  };
}

     const pendingFields = Object.keys(pendingExtractedData);
     
if (
  podeTratarCorrecaoDadosAgora &&
  explicitCorrection?.campoParaCorrigir
) {
   
  await saveLeadProfile(from, {
    campoPendente: explicitCorrection.campoParaCorrigir,
    aguardandoConfirmacaoCampo: false,
    aguardandoConfirmacao: false,
    faseQualificacao: "aguardando_valor_correcao_final",
    status: "aguardando_valor_correcao_final"
  });

  const labels = {
  nome: "o nome completo",
  cpf: "o CPF",
  telefone: "o telefone com DDD",
  cidade: "a cidade",
  estado: "o estado"
};

const msg = `Sem problema 😊 Qual é ${labels[explicitCorrection.campoParaCorrigir]} correto?`;
  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

// 🔥 PERGUNTA REAL DURANTE COLETA/CONFIRMAÇÃO
// Se o lead fizer uma pergunta enquanto estamos coletando ou confirmando dados,
// a SDR responde a dúvida primeiro e depois retoma o campo pendente.
// Isso evita tratar pergunta como cidade, nome, CPF ou confirmação.
const leadFezPerguntaDuranteColeta =
  isDataFlowState(currentLead || {}) &&
  pendingFields.length === 0 &&
  !explicitCorrection?.campoParaCorrigir &&
  isLeadQuestionDuringDataFlow(text, currentLead || {});

if (leadFezPerguntaDuranteColeta && !dataFlowQuestionAlreadyGuided) {
  dataFlowQuestionAlreadyGuided = true;

  const campoRetomadaColeta =
    currentLead?.campoEsperado ||
    currentLead?.campoPendente ||
    "";

  backendStrategicGuidance.push({
    tipo: "pergunta_real_durante_coleta",
    prioridade: "alta",
    motivo: "Lead fez pergunta real durante coleta/confirmação.",
    orientacaoParaPreSdr:
      [
        "O lead fez uma pergunta real durante a coleta/confirmação de dados.",
        "O Pré-SDR deve orientar a SDR a responder essa pergunta primeiro.",
        "Depois, a SDR deve retomar a coleta sem reiniciar o cadastro.",
        campoRetomadaColeta
          ? `Campo pendente para retomar: ${campoRetomadaColeta}.`
          : "Verificar o campo pendente antes de retomar.",
        "Não salvar a pergunta como nome, cidade, CPF, telefone ou estado."
      ].join("\n")
  });

  await saveLeadProfile(from, {
    fluxoPausadoPorPergunta: true,
    ultimaPerguntaDuranteColeta: text,
    campoRetomadaColeta,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "pergunta_real_durante_coleta",
      motivo: "lead_fez_pergunta_real_durante_coleta",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        campoEsperado: currentLead?.campoEsperado || "",
        campoPendente: currentLead?.campoPendente || "",
        deveRetomarColetaDepois: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("🧭 Pergunta real durante coleta enviada ao Pré-SDR:", {
    user: from,
    ultimaMensagemLead: text,
    campoRetomadaColeta
  });
}
     
     if (
  currentLead?.faseQualificacao === "aguardando_valor_correcao_final" &&
  currentLead?.campoPendente &&
  !dataFlowQuestionAlreadyGuided
) {
  const campo = currentLead.campoPendente;

  let valorCorrigido = text.trim();

  // BLOCO 11A:
  // Se o lead está corrigindo um dado, mas faz uma pergunta ou objeção,
  // o backend NÃO responde direto e NÃO salva essa mensagem como dado.
  // Ele orienta o Pré-SDR e deixa a SDR responder.
  const leadPerguntouDuranteCorrecao =
    isLeadQuestionDuringDataFlow(text, currentLead || {}) ||
    isLeadQuestionObjectionOrCorrection(text);

  if (leadPerguntouDuranteCorrecao) {
    dataFlowQuestionAlreadyGuided = true;

    const campoRetomadaColeta =
      currentLead?.campoEsperado ||
      currentLead?.campoPendente ||
      "";

    backendStrategicGuidance.push({
      tipo: "pergunta_durante_correcao_de_dado",
      prioridade: "alta",
      motivo: "Lead fez pergunta, objeção ou comentário durante correção de dado.",
      orientacaoParaPreSdr:
        [
          "O lead estava corrigindo um dado, mas trouxe pergunta, objeção ou mensagem que não deve ser salva como valor corrigido.",
          "O backend NÃO deve responder diretamente e NÃO deve salvar essa mensagem como dado cadastral.",
          "O Pré-SDR deve orientar a SDR a responder primeiro a manifestação atual do lead.",
          "Depois, a SDR deve retomar a correção exatamente do campo pendente.",
          campoRetomadaColeta
            ? `Campo pendente para retomar: ${campoRetomadaColeta}.`
            : "Verificar o campo pendente antes de retomar.",
          "Não salvar essa mensagem como nome, CPF, telefone, cidade ou estado."
        ].join("\n")
    });

    await saveLeadProfile(from, {
      fluxoPausadoPorPergunta: true,
      ultimaPerguntaDuranteColeta: text,
      campoRetomadaColeta,
      ultimaMensagem: text,
      ultimaDecisaoBackend: buildBackendDecision({
        tipo: "pergunta_durante_correcao_de_dado",
        motivo: "lead_fez_pergunta_ou_objecao_durante_correcao_de_dado",
        acao: "orientar_pre_sdr_sem_responder_direto",
        mensagemLead: text,
        detalhes: {
          faseAtual: currentLead?.faseQualificacao || "",
          campoEsperado: currentLead?.campoEsperado || "",
          campoPendente: currentLead?.campoPendente || "",
          deveRetomarColetaDepois: true
        }
      })
    });

    currentLead = await loadLeadProfile(from);

    console.log("🧭 Pergunta durante correção de dado enviada ao Pré-SDR:", {
      user: from,
      ultimaMensagemLead: text,
      campoRetomadaColeta
    });
  } else {
    if (campo === "cpf") {
      valorCorrigido = formatCPF(valorCorrigido);
    }

    if (campo === "telefone") {
      valorCorrigido = formatPhone(valorCorrigido);
    }

    if (campo === "estado") {
      valorCorrigido = normalizeUF(valorCorrigido);
    }

    // 🛡️ VALIDAÇÃO DO VALOR CORRIGIDO
    // Aqui impedimos que texto ruim seja salvo como nome, cidade ou estado.
    if (
      campo === "nome" &&
      isInvalidLooseNameCandidate(valorCorrigido)
    ) {
      const msg = "Esse texto não parece um nome completo válido 😊\n\nPode me enviar o nome completo correto?";

      await sendWhatsAppMessage(from, msg);
      await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

      if (messageId) {
        markMessageAsProcessed(messageId);
      }

      return;
    }

    if (
      ["cidade", "estado"].includes(campo) &&
      isInvalidLocationCandidate(valorCorrigido)
    ) {
      const msg =
        campo === "cidade"
          ? "Esse texto não parece uma cidade válida 😊\n\nPode me enviar somente a cidade correta?"
          : "Esse texto não parece um estado válido 😊\n\nPode me enviar somente a sigla do estado? Exemplo: SP, RJ ou MG.";

      await sendWhatsAppMessage(from, msg);
      await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

      if (messageId) {
        markMessageAsProcessed(messageId);
      }

      return;
    }

    if (
      campo === "estado" &&
      !VALID_UFS.includes(normalizeUF(valorCorrigido))
    ) {
      const msg = "O estado informado parece inválido 😊\n\nPode me enviar somente a sigla correta? Exemplo: SP, RJ ou MG.";

      await sendWhatsAppMessage(from, msg);
      await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

      if (messageId) {
        markMessageAsProcessed(messageId);
      }

      return;
    }

    const dadosAtualizados = {
      ...(currentLead || {}),
      [campo]: valorCorrigido
    };

    if (dadosAtualizados.cidade && dadosAtualizados.estado) {
      dadosAtualizados.cidadeEstado = `${dadosAtualizados.cidade}/${normalizeUF(dadosAtualizados.estado)}`;
    }

    await saveLeadProfile(from, {
      ...dadosAtualizados,
      cidadePendente: null,
      estadoPendente: null,
      campoPendente: null,
      valorPendente: null,
      campoEsperado: null,
      aguardandoConfirmacaoCampo: false,
      aguardandoConfirmacao: true,
      dadosConfirmadosPeloLead: false,
      faseQualificacao: "aguardando_confirmacao_dados",
      status: "aguardando_confirmacao_dados"
    });

    const msg = buildLeadConfirmationMessage(dadosAtualizados);

    await sendWhatsAppMessage(from, msg);
    await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

    if (messageId) {
      markMessageAsProcessed(messageId);
    }

    return;
  }
}
     // 🧠 MODO PÓS-CRM ATIVO E SEGURO
// Se o lead já foi enviado ao CRM ou está em atendimento,
// a SDR continua respondendo dúvidas, mas não reinicia coleta,
// não pede dados novamente e não reenvia ao CRM.
if (isPostCrmLead(currentLead || {})) {
  backendStrategicGuidance.push({
    tipo: "lead_pos_crm",
    prioridade: "alta",
    motivo: "Lead já está em fase pós-CRM, enviado ao CRM ou em atendimento.",
    orientacaoParaPreSdr:
      [
        "O lead está em fase pós-CRM, enviado ao CRM ou em atendimento.",
        "O backend NÃO deve responder diretamente e NÃO deve reiniciar o cadastro.",
        "O Pré-SDR deve orientar a SDR a responder primeiro a pergunta atual do lead.",
        "A SDR não deve pedir novamente nome, CPF, telefone, cidade ou estado.",
        "A SDR não deve dizer que enviou novamente ao CRM.",
        "A SDR não deve prometer aprovação, contrato, pagamento ou retorno garantido.",
        "Se o lead perguntar sobre próximos passos, orientar que a equipe responsável fará a análise/continuidade pelo atendimento humano.",
        "Se o lead trouxer dúvida comercial simples, responder de forma consultiva e curta, sem reiniciar o funil.",
        "Se houver humano assumindo a conversa, respeitar a condução humana."
      ].join("\n")
  });

  await saveLeadProfile(from, {
    sinalPosCrm: true,
    ultimaMensagemPosCrm: text,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "lead_pos_crm",
      motivo: "lead_pos_crm_chamou_novamente",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        status: currentLead?.status || "",
        faseQualificacao: currentLead?.faseQualificacao || "",
        statusOperacional: currentLead?.statusOperacional || "",
        faseFunil: currentLead?.faseFunil || "",
        crmEnviado: currentLead?.crmEnviado === true,
        naoReiniciarCadastro: true,
        naoPedirDadosNovamente: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("📌 Lead pós-CRM enviado ao Pré-SDR, sem resposta direta do backend:", {
    user: from,
    ultimaMensagemLead: text,
    status: currentLead?.status || "",
    faseQualificacao: currentLead?.faseQualificacao || "",
    statusOperacional: currentLead?.statusOperacional || "",
    faseFunil: currentLead?.faseFunil || ""
  });
}

     // 🧠 PRIORIDADE DA IA DURANTE COLETA/CONFIRMAÇÃO
// Se o lead fizer uma pergunta durante a coleta,
// a SDR responde primeiro e depois retoma o dado pendente.
// Isso evita que o backend trate pergunta como nome, cidade ou outro dado.
if (
  isDataFlowState(currentLead || {}) &&
  isLeadQuestionDuringDataFlow(text, currentLead || {}) &&
  !dataFlowQuestionAlreadyGuided
) {
  dataFlowQuestionAlreadyGuided = true;

  const campoRetomadaColeta =
    currentLead?.campoEsperado ||
    currentLead?.campoPendente ||
    "";

  backendStrategicGuidance.push({
    tipo: "pergunta_durante_coleta",
    prioridade: "alta",
    motivo: "Lead fez pergunta durante coleta/confirmação de dados.",
    orientacaoParaPreSdr:
      [
        "O lead fez uma pergunta enquanto o sistema estava em coleta/confirmação de dados.",
        "O Pré-SDR deve orientar a SDR a responder a pergunta primeiro.",
        "Depois, a SDR deve retomar a coleta de onde parou.",
        campoRetomadaColeta
          ? `Campo pendente para retomar: ${campoRetomadaColeta}.`
          : "Verificar o campo pendente no histórico.",
        "Não tratar a pergunta como dado cadastral."
      ].join("\n")
  });

  await saveLeadProfile(from, {
    fluxoPausadoPorPergunta: true,
    ultimaPerguntaDuranteColeta: text,
    campoRetomadaColeta,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "pergunta_durante_coleta",
      motivo: "lead_fez_pergunta_durante_coleta",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        campoEsperado: currentLead?.campoEsperado || "",
        campoPendente: currentLead?.campoPendente || "",
        deveRetomarColetaDepois: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("🧭 Pergunta durante coleta orientada ao Pré-SDR pela proteção secundária:", {
    user: from,
    ultimaMensagemLead: text,
    campoRetomadaColeta
  });
}
     
const isOnlyConfirmationText =
  isPositiveConfirmation(text) || isNegativeConfirmation(text);

const podeExtrairDadosPessoais = podeTentarExtrairDados;

if (
  podeExtrairDadosPessoais &&
  pendingFields.length > 0 &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !isOnlyConfirmationText
) {
   
  const field = pendingFields[0];
  const value = pendingExtractedData[field];

  const dadosPendentesParaSalvar = {
  campoPendente: field,
  valorPendente: value,
  aguardandoConfirmacaoCampo: true,
  faseQualificacao: "aguardando_confirmacao_campo",
  status: "aguardando_confirmacao_campo"
};

if (field === "cidade" && rawExtracted?.estado) {
  dadosPendentesParaSalvar.estadoPendente = rawExtracted.estado;
}

if (field === "estado" && rawExtracted?.cidade) {
  dadosPendentesParaSalvar.cidadePendente = rawExtracted.cidade;
}

await saveLeadProfile(from, dadosPendentesParaSalvar);

  const labels = {
    nome: "nome",
    cpf: "CPF",
    telefone: "telefone",
    cidade: "cidade",
    estado: "estado"
  };

  let valorParaMostrar = value;
let labelParaMostrar = labels[field] || field;

if (field === "cidade" && rawExtracted?.estado) {
  valorParaMostrar = `${value}/${rawExtracted.estado}`;
  labelParaMostrar = "cidade/estado";
}

if (field === "estado" && rawExtracted?.cidade) {
  valorParaMostrar = `${rawExtracted.cidade}/${value}`;
  labelParaMostrar = "cidade/estado";
}

// 🔥 NÃO CONFIRMAR NOME (deixa fluxo mais natural)
if (field === "nome") {
  await saveLeadProfile(from, {
    ...currentLead,
    nome: value,
    campoPendente: null,
    valorPendente: null,
    aguardandoConfirmacaoCampo: false,
    faseQualificacao: "dados_parciais",
    status: "dados_parciais"
  });

  const nextField = getMissingLeadFields({
    ...currentLead,
    nome: value
  })[0];

  const msg = `Perfeito 👍

${getMissingFieldQuestion(nextField)}`;

  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

// 🔥 PARA OS OUTROS CAMPOS MANTÉM CONFIRMAÇÃO
const msg = `Identifiquei seu ${labelParaMostrar} como: ${valorParaMostrar}

Está correto?`;
   
  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}
     
if (currentLead?.aguardandoConfirmacaoCampo) {
  const campo = currentLead.campoPendente;
  const valor = currentLead.valorPendente;
  let respostaConfirmacaoCampo = "";

  if (isPositiveConfirmation(text)) {
    const validation = validateLeadData({
      [campo]: valor
    });

    if (!validation.isValid) {
      await saveLeadProfile(from, {
        campoPendente: null,
        valorPendente: null,
        aguardandoConfirmacaoCampo: false,
        faseQualificacao: "erro_dados",
        status: "erro_dados",
        errosValidacao: validation.errors
      });

      const errorMsg = `Esse dado parece ter algum problema 😊

${validation.errors.join("\n")}

Pode me enviar novamente?`;

      await sendWhatsAppMessage(from, errorMsg);
     await saveHistoryStep(from, history, text, errorMsg, !!message.audio?.id);
       
       if (messageId) {
        markMessageAsProcessed(messageId);
      }

      return;
    }

    const dadosConfirmadosDoCampo = {
  [campo]: valor
};

if (campo === "cidade" && currentLead?.estadoPendente) {
  dadosConfirmadosDoCampo.estado = currentLead.estadoPendente;
}

if (campo === "estado" && currentLead?.cidadePendente) {
  dadosConfirmadosDoCampo.cidade = currentLead.cidadePendente;
}

const updatedLeadAfterField = {
  ...(currentLead || {}),
  ...dadosConfirmadosDoCampo
};

const remainingPendingData = Object.fromEntries(
  Object.entries(rawExtracted || {}).filter(([key, value]) => {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      !REQUIRED_LEAD_FIELDS.includes(key) ||
      key === campo
    ) {
      return false;
    }

    const newValue = normalizeLeadFieldValue(key, value);
    const savedValue = normalizeLeadFieldValue(key, updatedLeadAfterField?.[key]);

    if (!newValue) return false;
    if (savedValue && newValue === savedValue) return false;

    return true;
  })
);

     const nextPendingField = Object.keys(remainingPendingData)[0];

if (nextPendingField) {
  await saveLeadProfile(from, {
    ...dadosConfirmadosDoCampo,
    campoPendente: nextPendingField,
    valorPendente: remainingPendingData[nextPendingField],
    campoEsperado: nextPendingField,
    cidadePendente: null,
    estadoPendente: null,
    aguardandoConfirmacaoCampo: true,
    faseQualificacao: "aguardando_confirmacao_campo",
    status: "aguardando_confirmacao_campo"
  });
   
  const labels = {
    nome: "nome",
    cpf: "CPF",
    telefone: "telefone",
    cidade: "cidade",
    estado: "estado"
  };

  respostaConfirmacaoCampo = `Perfeito, ${labels[campo] || campo} confirmado ✅

Também identifiquei seu ${labels[nextPendingField] || nextPendingField} como: ${remainingPendingData[nextPendingField]}

Está correto?`;

  await sendWhatsAppMessage(from, respostaConfirmacaoCampo);
} else {
  const updatedLead = {
    ...(currentLead || {}),
    ...dadosConfirmadosDoCampo
  };

  const missingFields = getMissingLeadFields(updatedLead);
   

 await saveLeadProfile(from, {
  ...updatedLead,
  cidadePendente: null,
  estadoPendente: null,
  campoPendente: null,
  valorPendente: null,
  campoEsperado: null,
  aguardandoConfirmacaoCampo: false,
  faseQualificacao: "dados_parciais",
  status: "dados_parciais"
});
   
  const labels = {
    nome: "nome",
    cpf: "CPF",
    telefone: "telefone",
    cidade: "cidade",
    estado: "estado"
  };

 const labelConfirmado =
  campo === "cidade" && currentLead?.estadoPendente
    ? "cidade/estado confirmados"
    : campo === "estado" && currentLead?.cidadePendente
      ? "cidade/estado confirmados"
      : campo === "cidade"
        ? "cidade confirmada"
        : campo === "estado"
          ? "estado confirmado"
          : `${labels[campo] || campo} confirmado`;

respostaConfirmacaoCampo = `Perfeito, ${labelConfirmado} ✅`;

 if (missingFields.length > 0) {
  const nextField = missingFields[0];

  // 🔥 DEFINE QUAL CAMPO DEVE VIR AGORA
  await saveLeadProfile(from, {
    campoEsperado: nextField
  });

  respostaConfirmacaoCampo += `\n\n${getMissingFieldQuestion(nextField)}`;
} else {
  await saveLeadProfile(from, {
    ...updatedLead,
    cidadePendente: null,
    estadoPendente: null,
    campoPendente: null,
    valorPendente: null,
    campoEsperado: null,
    aguardandoConfirmacaoCampo: false,
    aguardandoConfirmacao: true,
    dadosConfirmadosPeloLead: false,
    faseQualificacao: "aguardando_confirmacao_dados",
    status: "aguardando_confirmacao_dados"
  });

  respostaConfirmacaoCampo += `\n\n${buildLeadConfirmationMessage(updatedLead)}`;
}
   

  await sendWhatsAppMessage(from, respostaConfirmacaoCampo);
}
    await saveHistoryStep(from, history, text, respostaConfirmacaoCampo, !!message.audio?.id);
    if (messageId) {
      markMessageAsProcessed(messageId);
    }

    return;
  }

  if (isNegativeConfirmation(text)) {
    await saveLeadProfile(from, {
      campoPendente: null,
      valorPendente: null,
      aguardandoConfirmacaoCampo: false,
      faseQualificacao: "corrigir_dado",
      status: "corrigir_dado"
    });

    const labels = {
      nome: "nome completo",
      cpf: "CPF",
      telefone: "telefone com DDD",
      cidade: "cidade",
      estado: "estado"
    };

    const msg = `Sem problema 😊 Pode me enviar o ${labels[campo] || campo} correto?`;

    await sendWhatsAppMessage(from, msg);
    await saveHistoryStep(from, history, text, msg, !!message.audio?.id);
     
    if (messageId) {
      markMessageAsProcessed(messageId);
    }

    return;
  }

  const labels = {
  nome: "nome",
  cpf: "CPF",
  telefone: "telefone",
  cidade: "cidade",
  estado: "estado"
};

const respostaReconfirmacao = `Só para confirmar: o ${labels[campo] || campo} "${valor}" está correto?

Pode responder sim ou não.`;

  await sendWhatsAppMessage(from, respostaReconfirmacao);
   await saveHistoryStep(from, history, text, respostaReconfirmacao, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}   

const changedConfirmedData =
  currentLead?.dadosConfirmadosPeloLead === true &&
  REQUIRED_LEAD_FIELDS.some(field =>
    extractedData[field] &&
    currentLead[field] &&
    String(extractedData[field]) !== String(currentLead[field])
  );

if (changedConfirmedData) {
 await saveLeadProfile(from, {
  ...extractedData,
  cidadePendente: null,
  estadoPendente: null,
  campoPendente: null,
  valorPendente: null,
  campoEsperado: null,
  aguardandoConfirmacaoCampo: false,
  aguardandoConfirmacao: true,
  dadosConfirmadosPeloLead: false,
  faseQualificacao: "aguardando_confirmacao_dados",
  status: "aguardando_confirmacao_dados"
});

  const confirmationMsg = buildLeadConfirmationMessage(extractedData);

  await sendWhatsAppMessage(from, confirmationMsg);
  await saveHistoryStep(from, history, text, confirmationMsg, !!message.audio?.id);
   if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

const leadStatus = classifyLead(text, extractedData, history);
     let leadStatusSeguro = leadStatus;
const strongIntent = isStrongBuyIntent(text);
const leadDeuApenasConfirmacaoFraca = isSoftUnderstandingConfirmation(text);
const leadDeuIntencaoExplicitaPreAnalise = isExplicitPreAnalysisIntent(text);
const missingFields = getMissingLeadFields(extractedData);
const awaitingConfirmation = currentLead?.faseQualificacao === "aguardando_confirmacao_dados";

     // 🧠 CLASSIFICADOR SEMÂNTICO — MODO OBSERVAÇÃO
// Não roda durante coleta/confirmação de dados, porque nesse momento
// mensagens como nome, CPF, telefone, cidade e UF não são intenção comercial.
const fasesDeColetaOuConfirmacao = [
  "coletando_dados",
  "dados_parciais",
  "aguardando_dados",
  "aguardando_confirmacao_campo",
  "aguardando_confirmacao_dados",
  "corrigir_dado",
  "corrigir_dado_final",
  "aguardando_valor_correcao_final"
];

const estaEmColetaOuConfirmacao =
  fasesDeColetaOuConfirmacao.includes(currentLead?.faseQualificacao) ||
  currentLead?.faseFunil === "coleta_dados" ||
  currentLead?.faseFunil === "confirmacao_dados" ||
  currentLead?.aguardandoConfirmacaoCampo === true ||
  currentLead?.aguardandoConfirmacao === true;

let semanticIntent = null;

if (estaEmColetaOuConfirmacao) {
  console.log("🧠 Classificador semântico ignorado durante coleta/confirmação:", {
    user: from,
    ultimaMensagemLead: text,
    statusAtual: currentLead?.status || "-",
    faseAtual: currentLead?.faseQualificacao || "-",
    faseFunilAtual: currentLead?.faseFunil || "-",
    motivo: "mensagem tratada como dado cadastral, não como intenção comercial"
  });
} else {
  semanticIntent = await runLeadSemanticIntentClassifier({
    lead: currentLead || {},
    history,
    lastUserText: text,
    lastSdrText: [...history].reverse().find(m => m.role === "assistant")?.content || ""
  });

  console.log("🧠 Intenção semântica observada:", {
    user: from,
    ultimaMensagemLead: text,
    statusAtual: currentLead?.status || "-",
    faseAtual: currentLead?.faseQualificacao || "-",
    faseFunilAtual: currentLead?.faseFunil || "-",
    etapas: currentLead?.etapas || {},
    semanticIntent
  });
}
const podeConfirmarInteresseRealAgora =
  canAskForRealInterest(currentLead || {}) &&
  canStartDataCollection({
    ...(currentLead || {}),
    interesseReal: true
  }) &&
  isPositiveConfirmation(text) &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !awaitingConfirmation &&
  currentLead?.faseQualificacao !== "corrigir_dado" &&
  currentLead?.faseQualificacao !== "corrigir_dado_final" &&
  currentLead?.faseQualificacao !== "aguardando_valor_correcao_final";

     if (podeConfirmarInteresseRealAgora) {
   
  await saveLeadProfile(from, {
    interesseReal: true,
    faseQualificacao: "coletando_dados",
    status: "coletando_dados",
    campoEsperado: "nome",
    aguardandoConfirmacaoCampo: false,
    aguardandoConfirmacao: false,
    dadosConfirmadosPeloLead: false
  });

  currentLead = await loadLeadProfile(from);

  const msg = "Perfeito 😊 Vamos seguir com a pré-análise então.\n\nPrimeiro, pode me enviar seu nome completo?";

  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

// 🔀 DECISÃO CENTRAL DE ROTA COMERCIAL — BLOCO 2
// A partir daqui, Afiliado/Homologado não responde mais direto ao lead.
// O backend apenas interpreta, registra sinais e orienta o Consultor Pré-SDR.
// Quem deve falar com o lead é a SDR IA, seguindo a orientação do Pré-SDR.
// backendStrategicGuidance já foi inicializado no início do processamento da mensagem.

const commercialRouteDecision = decideCommercialRouteFromSemanticIntent({
  semanticIntent,
  currentLead: currentLead || {}
});

console.log("🔀 Decisão central de rota comercial observada pelo backend:", {
  user: from,
  ultimaMensagemLead: text,
  rota: commercialRouteDecision.rota,
  deveResponderAgora: commercialRouteDecision.deveResponderAgora,
  deveCompararProgramas: commercialRouteDecision.deveCompararProgramas,
  deveManterHomologado: commercialRouteDecision.deveManterHomologado,
  origemConversao: commercialRouteDecision.origemConversao,
  motivo: commercialRouteDecision.motivo
});

const podeUsarSinalDeRotaAgora =
  !isCriticalCommercialBlockedState({
    lead: currentLead || {},
    awaitingConfirmation
  });

if (
  podeUsarSinalDeRotaAgora &&
  commercialRouteDecision.rota === "ambos" &&
  commercialRouteDecision.deveCompararProgramas === true
) {
  backendStrategicGuidance.push({
    tipo: "comparacao_homologado_afiliado",
    prioridade: "alta",
    origem: commercialRouteDecision.origemConversao || "comparacao_homologado_afiliado",
    motivo: commercialRouteDecision.motivo || "Lead demonstrou interesse em comparar os dois programas.",
    orientacaoParaPreSdr:
      "O lead demonstrou interesse em comparar Homologado e Afiliados. O Pré-SDR deve orientar a SDR a responder a dúvida do lead primeiro e, se fizer sentido, comparar os dois caminhos de forma clara, sem misturar regras: Afiliado é por link, online, sem estoque físico e com comissão por produto; Homologado envolve produto físico, estoque em comodato, suporte, treinamento, contrato e taxa de adesão. Não conduzir para pré-cadastro até garantir entendimento das etapas obrigatórias."
  });

  await saveLeadProfile(from, {
    sinalComparacaoProgramas: true,
    rotaComercialSugerida: "ambos",
    origemConversaoSugerida: commercialRouteDecision.origemConversao,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "sinal_rota_ambos",
      motivo: commercialRouteDecision.motivo || "lead_pediu_comparacao_entre_programas",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        origemConversao: commercialRouteDecision.origemConversao,
        rotaSugerida: commercialRouteDecision.rota
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("🧭 Sinal de comparação entre programas enviado ao Pré-SDR, sem resposta direta do backend:", {
    user: from,
    ultimaMensagemLead: text
  });
}

if (
  podeUsarSinalDeRotaAgora &&
  commercialRouteDecision.rota === "afiliado" &&
  commercialRouteDecision.deveResponderAgora === true
) {
  backendStrategicGuidance.push({
    tipo: "interesse_afiliado_explicito",
    prioridade: "alta",
    origem: commercialRouteDecision.origemConversao || "interesse_direto_afiliado",
    motivo: commercialRouteDecision.motivo || "Lead demonstrou intenção clara pelo Programa de Afiliados.",
    orientacaoParaPreSdr:
      "O lead demonstrou intenção clara de Afiliados. O Pré-SDR deve validar se a mensagem fala em link, online, sem estoque físico, divulgação, redes sociais, e-commerce ou cadastro de afiliado. Se confirmado, orientar a SDR a responder sobre Afiliados sem misturar taxa, comodato ou pré-análise do Homologado. Se houver ambiguidade, orientar a SDR a perguntar qual modelo o lead quer seguir."
  });

  await saveLeadProfile(from, {
    sinalAfiliadoExplicito: true,
    rotaComercialSugerida: "afiliado",
    origemConversaoSugerida: commercialRouteDecision.origemConversao,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "sinal_rota_afiliado",
      motivo: commercialRouteDecision.motivo || "lead_demonstrou_intencao_clara_afiliado",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        origemConversao: commercialRouteDecision.origemConversao,
        rotaSugerida: commercialRouteDecision.rota
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("🧭 Sinal de Afiliado enviado ao Pré-SDR, sem resposta direta do backend:", {
    user: from,
    ultimaMensagemLead: text
  });
}
// 💰 PERGUNTA SOBRE TAXA / INVESTIMENTO — BLOCO 2
// O backend não responde mais diretamente a taxa.
// Ele registra o sinal e envia orientação forte ao Consultor Pré-SDR.
// A SDR deve responder depois, seguindo a orientação do Pré-SDR.
if (
  isTaxaQuestionIntent(text) &&
  !isTaxaObjectionAgainstInvestment(text) &&
  !isAffiliateIntent(text) &&
  !leadHasFinishedPreCadastro(currentLead || {}) &&
  !isCriticalCommercialBlockedState({
    lead: currentLead || {},
    awaitingConfirmation
  })
) {
  backendStrategicGuidance.push({
    tipo: "pergunta_taxa_investimento",
    prioridade: "critica",
    motivo: "Lead perguntou sobre taxa, valor ou investimento.",
    orientacaoParaPreSdr:
      "Etapa crítica de conversão. O lead perguntou sobre taxa/investimento. O Pré-SDR deve orientar a SDR a responder a pergunta do lead sem fugir, mas com ancoragem forte: taxa de R$ 1.990,00 não é compra de mercadoria, não é caução e não é garantia; inclui ativação, suporte, treinamento e acesso ao lote inicial em comodato; o lote representa mais de R$ 5.000,00 em preço de venda ao consumidor; margem/comissão no Homologado pode chegar a 40% no preço sugerido e pode ser maior se vender com ágio; pagamento só ocorre após análise interna e contrato; pode mencionar parcelamento em até 10x de R$ 199,00 no cartão e PIX. Não oferecer Afiliado só porque perguntou valor. Não pedir dados ainda se as etapas obrigatórias não estiverem concluídas."
  });

  await saveLeadProfile(from, {
    sinalPerguntaTaxa: true,
    taxaAlinhada: false,
    ultimaPerguntaTaxa: text,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "sinal_pergunta_taxa",
      motivo: "lead_perguntou_taxa_ou_investimento",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        etapaCriticaConversao: true,
        naoMarcarInvestimentoComoConcluidoAinda: true,
        naoOferecerAfiliadoPrecipitadamente: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("💰 Pergunta de taxa enviada ao Pré-SDR como orientação crítica, sem resposta direta do backend:", {
    user: from,
    ultimaMensagemLead: text
  });
}
     
// 🧱 MOTOR DE OBJEÇÃO DA TAXA — BLOCO 3
// O backend NÃO responde mais diretamente objeções de taxa.
// Ele registra a objeção, conta tentativas e orienta o Pré-SDR.
// Quem responde ao lead é a SDR IA, seguindo a orientação do Pré-SDR.
const leadTemObjecaoTaxaControlada =
  (
    isTaxaObjectionAgainstInvestment(text) ||
    semanticIntent?.priceObjection === true ||
    (
      semanticIntent?.blockingObjection === true &&
      leadMentionedTaxObjection(text)
    )
  ) &&
  !isAffiliateIntent(text) &&
  !isClearAffiliateFallbackIntent(text) &&
  !leadHasFinishedPreCadastro(currentLead || {}) &&
  !isCriticalCommercialBlockedState({
    lead: currentLead || {},
    awaitingConfirmation
  });

if (leadTemObjecaoTaxaControlada) {
  const taxaObjectionCountAtual = Number(currentLead?.taxaObjectionCount || 0);
  const novaContagemObjecaoTaxa = taxaObjectionCountAtual + 1;

  const argumentosPorTentativa = {
    1: [
      "Acolher a objeção sem discordar do lead.",
      "Explicar que a taxa de R$ 1.990,00 não é compra de mercadoria, caução ou garantia.",
      "Reforçar que o pagamento só ocorre após análise interna e contrato.",
      "Comparar a taxa com a estrutura recebida: suporte, treinamento e ativação no programa."
    ],
    2: [
      "Reforçar que o parceiro não compra estoque para começar.",
      "Explicar que o lote inicial é cedido em comodato e representa mais de R$ 5.000,00 em preço de venda ao consumidor.",
      "Conectar a taxa ao acesso a produto físico, pronta-entrega, demonstração e suporte da indústria.",
      "Perguntar qual parte ainda pesa mais para o lead: valor, risco, estoque ou retorno."
    ],
    3: [
      "Trabalhar retorno potencial sem prometer ganho.",
      "Explicar que, vendendo no preço sugerido, a comissão/margem do Homologado pode chegar a 40%.",
      "Explicar que, se vender com ágio acima do preço sugerido, a diferença fica com o parceiro.",
      "Reforçar parcelamento em até 10x de R$ 199,00 no cartão, se disponível.",
      "Validar se o lead quer avaliar o modelo com calma ou se existe uma dúvida específica travando."
    ],
    4: [
      "Não descartar o lead.",
      "Não oferecer Afiliado automaticamente.",
      "Investigar a raiz da objeção com pergunta consultiva.",
      "Se o lead pedir claramente alternativa sem estoque, por link, online ou sem taxa do Homologado, aí sim orientar comparação com Afiliados.",
      "Se o lead não pediu alternativa, continuar tratando a objeção dentro do Homologado."
    ]
  };

  const tentativaUsada =
    novaContagemObjecaoTaxa <= 3
      ? novaContagemObjecaoTaxa
      : 4;

  const argumentosRecomendados =
    argumentosPorTentativa[tentativaUsada] || argumentosPorTentativa[4];

  backendStrategicGuidance.push({
    tipo: "objecao_taxa_conversao",
    prioridade: "critica",
    tentativa: novaContagemObjecaoTaxa,
    motivo: "Lead demonstrou resistência, dúvida ou trava relacionada à taxa/investimento.",
    orientacaoParaPreSdr:
      [
        `Objeção de taxa detectada. Esta é a tentativa ${novaContagemObjecaoTaxa} de tratamento da objeção.`,
        "O Pré-SDR deve orientar a SDR a responder diretamente a objeção do lead, sem fugir do assunto e sem oferecer Afiliados automaticamente.",
        "A SDR deve manter foco no Parceiro Homologado, salvo se o lead pedir claramente link, online, venda sem estoque físico, redes sociais, e-commerce ou alternativa sem taxa do Homologado.",
        "A SDR deve usar tom acolhedor, consultivo e firme, evitando pressão.",
        "A SDR deve usar pelo menos 3 âncoras de valor, escolhidas conforme o contexto.",
        "Argumentos recomendados para esta tentativa:",
        ...argumentosRecomendados.map(item => `- ${item}`)
      ].join("\n")
  });

  await saveLeadProfile(from, {
    taxaObjectionCount: novaContagemObjecaoTaxa,
    ultimaObjecaoTaxa: text,
    sinalObjecaoTaxa: true,
    taxaModoConversao: true,
    taxaAlinhada: false,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "objecao_taxa",
      motivo: "lead_demonstrou_resistencia_ao_investimento",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        taxaObjectionCountAnterior: taxaObjectionCountAtual,
        taxaObjectionCountNovo: novaContagemObjecaoTaxa,
        tentativaUsada,
        naoResponderDiretoPeloBackend: true,
        naoOferecerAfiliadoAutomaticamente: true,
        manterConversaoHomologado: true,
        argumentosRecomendados
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("🧱 Objeção de taxa enviada ao Pré-SDR como orientação crítica, sem resposta direta do backend:", {
    user: from,
    taxaObjectionCount: novaContagemObjecaoTaxa,
    ultimaObjecaoTaxa: text,
    tentativaUsada,
    decisao: "orientar_pre_sdr_sem_responder_direto"
  });
}    
     
// ✅ CONFIRMAÇÃO ESPECÍFICA DA TAXA / INVESTIMENTO
// Só marca taxaAlinhada quando:
// 1. o investimento já foi explicado;
// 2. a taxa já foi perguntada/validada;
// 3. o lead respondeu de forma clara sobre o investimento.
// Respostas fracas como "ok", "sim" ou "entendi" não bastam.
if (
  currentLead?.etapas?.investimento === true &&
  currentLead?.etapas?.taxaPerguntada === true &&
  currentLead?.taxaAlinhada !== true &&
  isTaxaAlinhadaConfirmation(text) &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !awaitingConfirmation
) {await saveLeadProfile(from, {
  taxaAlinhada: true,
  taxaObjectionCount: 0,
  ultimaObjecaoTaxa: null,
  etapas: {
    ...(currentLead?.etapas || {}),
    taxaPerguntada: false
  }
});

  currentLead = await loadLeadProfile(from);
}     
     // ✅ CONFIRMAÇÃO DO COMPROMISSO DE ATUAÇÃO
// Só marca compromisso como concluído quando:
// 1. a SDR já perguntou sobre o resultado depender da atuação;
// 2. o lead respondeu positivamente;
// 3. ainda não estamos em confirmação de dados pessoais.
     
if (
  currentLead?.etapas?.compromissoPerguntado === true &&
  currentLead?.etapas?.compromisso !== true &&
    isCommitmentConfirmation(text) &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !awaitingConfirmation
) {
  await saveLeadProfile(from, {
    etapas: {
      ...(currentLead?.etapas || {}),
      compromisso: true,
      compromissoPerguntado: false
    }
  });

  currentLead = await loadLeadProfile(from);
}
     
// 🔥 ATUALIZA STATUS / FASE DO CRM COM BASE NA CLASSIFICAÇÃO
// Antes o sistema classificava, mas não salvava no Mongo.
// Por isso o dashboard não mudava de status.

     // 🔥 PRIORIDADE: LEAD QUENTE (INTENÇÃO FORTE)
if (
  strongIntent &&
  !leadDeuApenasConfirmacaoFraca &&
  currentLead?.faseQualificacao !== "coletando_dados" &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !awaitingConfirmation
) {
  const podeVirarInteresseRealAgora = canStartDataCollection({
    ...(currentLead || {}),
    interesseReal: true
  });

  if (podeVirarInteresseRealAgora) {
    await saveLeadProfile(from, {
      interesseReal: true,
      faseQualificacao: "qualificando",
      status: "qualificando"
    });
  } else {
    await saveLeadProfile(from, {
      sinalInteresseInicial: true,
      ultimaIntencaoForte: text,
      faseQualificacao: currentLead?.faseQualificacao || "morno",
      status: currentLead?.status || "morno"
    });

    console.log("🟡 Interesse forte registrado, mas pré-análise ainda bloqueada:", {
      user: from,
      ultimaMensagemLead: text,
      etapas: currentLead?.etapas || {},
      taxaAlinhada: currentLead?.taxaAlinhada === true,
      motivo: "Lead demonstrou interesse, mas ainda faltam etapas obrigatórias antes de interesseReal."
    });
  }

    currentLead = await loadLeadProfile(from);
}

     // 🔥 RECUPERAÇÃO COMERCIAL ANTES DE QUALQUER CADASTRO
// Se o lead esfriou, rejeitou, achou caro, quis deixar para depois
// ou tentou encerrar antes do pré-cadastro, o backend não deixa virar perda.
// Primeiro tentamos reaquecer no Homologado.
// Depois, se persistir, oferecemos Afiliados como alternativa obrigatória.
if (
  shouldRecoverLeadBeforeLoss({
    text,
    lead: currentLead,
    awaitingConfirmation
  })
) {
  const recoveryAttemptsAtual = Number(currentLead?.recoveryAttempts || 0);
  const novoRecoveryAttempts = recoveryAttemptsAtual + 1;

  backendStrategicGuidance.push({
    tipo: "recuperacao_comercial_antes_precadastro",
    prioridade: "alta",
    tentativa: novoRecoveryAttempts,
    motivo: "Lead rejeitou, esfriou ou demonstrou trava antes de finalizar o pré-cadastro.",
    orientacaoParaPreSdr:
      [
        `Lead demonstrou rejeição, esfriamento ou trava antes do pré-cadastro. Esta é a tentativa ${novoRecoveryAttempts} de recuperação.`,
        "O backend NÃO deve responder diretamente e NÃO deve marcar o lead como perdido.",
        "O Pré-SDR deve orientar a SDR a responder primeiro a manifestação atual do lead.",
        "A SDR deve tentar entender o motivo real da trava com tom leve, consultivo e sem pressão.",
        "Se a trava for taxa, dinheiro, risco, estoque ou insegurança, sustentar primeiro o Parceiro Homologado com valor percebido.",
        "Não oferecer Afiliados automaticamente apenas porque o lead esfriou, achou caro ou disse que vai pensar.",
        "Afiliados só devem ser mencionados se o lead pedir claramente link, online, venda sem estoque físico, redes sociais, e-commerce, alternativa sem taxa do Homologado, ou rejeitar explicitamente produto físico/estoque.",
        "Não encerrar a conversa. Fazer uma pergunta simples para manter o lead em movimento."
      ].join("\n")
  });

  await saveLeadProfile(from, {
    recoveryAttempts: novoRecoveryAttempts,
    sinalRecuperacaoComercial: true,
    ultimaRejeicaoOuEsfriamento: text,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "recuperacao_comercial",
      motivo: "lead_rejeitou_ou_esfriou_antes_do_precadastro",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        recoveryAttemptsAnterior: recoveryAttemptsAtual,
        recoveryAttemptsNovo: novoRecoveryAttempts,
        naoMarcarComoPerdido: true,
        naoOferecerAfiliadoAutomaticamente: true,
        manterConversaoHomologado: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("🔥 Recuperação comercial enviada ao Pré-SDR, sem resposta direta do backend:", {
    user: from,
    recoveryAttempts: novoRecoveryAttempts,
    ultimaMensagemLead: text
  });
}

// 🔥 RESPOSTA CONTROLADA PARA PEDIDO DE CADASTRO / PARTICIPAÇÃO
// 🔥 PEDIDO DE CADASTRO / PARTICIPAÇÃO — BLOCO 5
// O backend não responde mais diretamente.
// Ele registra o interesse e orienta o Pré-SDR.
// A SDR deve responder ao lead seguindo a orientação do Pré-SDR.
if (
  isCadastroOuParticipacaoIntent(text) &&
  !isCriticalCommercialBlockedState({
    lead: currentLead || {},
    awaitingConfirmation
  }) &&
  !["enviado_crm", "em_atendimento", "fechado", "perdido"].includes(currentLead?.status)
) {
  const podeIniciarColetaSeConfirmarInteresse = canStartDataCollection({
    ...(currentLead || {}),
    interesseReal: true
  });

  const etapasPendentesCadastro = getMissingFunnelStepLabels({
    ...(currentLead || {}),
    interesseReal: true
  });

  backendStrategicGuidance.push({
    tipo: "pedido_cadastro_ou_participacao",
    prioridade: podeIniciarColetaSeConfirmarInteresse ? "critica" : "alta",
    motivo: "Lead pediu cadastro, participação, entrada no programa ou pré-análise.",
    orientacaoParaPreSdr:
      podeIniciarColetaSeConfirmarInteresse
        ? [
            "Lead pediu cadastro/participação e as etapas obrigatórias parecem concluídas.",
            "O Pré-SDR deve orientar a SDR a reconhecer o interesse do lead e conduzir para a pré-análise de forma natural.",
            "A SDR pode iniciar a coleta de dados somente se o backend permitir o estado de coleta.",
            "Não pedir vários dados de uma vez. Coletar um dado por vez.",
            "Começar pelo nome completo, se ainda não estiver confirmado."
          ].join("\n")
        : [
            "Lead pediu cadastro/participação, mas ainda existem etapas obrigatórias pendentes.",
            "O Pré-SDR deve orientar a SDR a valorizar o interesse do lead, mas explicar que antes da pré-análise precisa alinhar os pontos faltantes.",
            "A SDR deve responder primeiro ao desejo do lead de seguir e depois conduzir para a próxima etapa pendente de forma natural.",
            `Etapas pendentes detectadas: ${Array.isArray(etapasPendentesCadastro) && etapasPendentesCadastro.length ? etapasPendentesCadastro.join(", ") : "verificar no histórico"}.`,
            "Não pedir CPF, telefone, cidade ou estado ainda.",
            "Não tratar como recusa. O lead demonstrou intenção positiva."
          ].join("\n")
  });

  await saveLeadProfile(from, {
    sinalInteresseInicial: true,
    ultimaIntencaoForte: text,
    interesseReal: podeIniciarColetaSeConfirmarInteresse
      ? true
      : currentLead?.interesseReal === true,
    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "pedido_cadastro",
      motivo: "lead_pediu_cadastro_ou_participacao",
      acao: "orientar_pre_sdr_sem_responder_direto",
      mensagemLead: text,
      detalhes: {
        podeIniciarColetaSeConfirmarInteresse,
        etapasPendentes: etapasPendentesCadastro,
        naoResponderDiretoPeloBackend: true,
        naoPedirDadosAntesDaHora: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  console.log("✅ Pedido de cadastro enviado ao Pré-SDR, sem resposta direta do backend:", {
    user: from,
    ultimaMensagemLead: text,
    podeIniciarColetaSeConfirmarInteresse,
    etapasPendentes: etapasPendentesCadastro
  });
}  
     
// 🔒 BLOQUEIO DE PRÉ-ANÁLISE PREMATURA
     
// Mesmo que o classificador diga "pre_analise",
// o backend só aceita se o lead tiver intenção explícita
// e todas as etapas obrigatórias estiverem concluídas.
const podeAceitarPreAnaliseAgora = Boolean(
  leadDeuIntencaoExplicitaPreAnalise &&
  canStartDataCollection({
    ...(currentLead || {}),
    interesseReal: true
  })
);

if (leadStatus === "pre_analise" && !podeAceitarPreAnaliseAgora) {
  console.log("🚫 Pré-análise bloqueada pelo backend:", {
    user: from,
    leadStatus,
    leadDeuIntencaoExplicitaPreAnalise,
    etapas: currentLead?.etapas || {},
    motivo: "Lead ainda não cumpriu intenção explícita + etapas obrigatórias."
  });

  leadStatusSeguro = null;
}
     
if (
  leadStatusSeguro &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !awaitingConfirmation &&
  !["enviado_crm", "em_atendimento", "fechado", "perdido"].includes(currentLead?.status)
) {
    const statusMap = {
    frio: "morno",
    morno: "morno",
    qualificando: "qualificando",
    pre_analise: "pre_analise",
    afiliado: "afiliado"
  };

  const faseMap = {
    frio: "morno",
    morno: "morno",
    qualificando: "qualificando",
    pre_analise: "pre_analise",
    afiliado: "afiliado"
  };

  const statusUpdateData = {
    status: statusMap[leadStatusSeguro] || leadStatusSeguro,
    faseQualificacao: faseMap[leadStatusSeguro] || leadStatusSeguro,
    origemConversao: leadStatusSeguro === "afiliado"
      ? "afiliado"
      : currentLead?.origemConversao || "homologado"
  };

  if (leadStatusSeguro === "frio") {
    statusUpdateData.statusOperacional = "ativo";
    statusUpdateData.temperaturaComercial = "morno";
    statusUpdateData.faseFunil =
      currentLead?.faseFunil && currentLead.faseFunil !== "encerrado"
        ? currentLead.faseFunil
        : "beneficios";
    statusUpdateData.ultimaClassificacaoFriaBloqueadaEm = new Date();
    statusUpdateData.ultimaClassificacaoFriaBloqueadaMensagem = text;

    console.log("🛡️ Classificação frio convertida para morno ativo. Lead não será perdido automaticamente.", {
      user: from,
      ultimaMensagemLead: text,
      leadStatusSeguro
    });
  }

  if (leadStatusSeguro === "pre_analise") {
    statusUpdateData.interesseReal = true;
  }

  await saveLeadProfile(from, statusUpdateData);

  currentLead = await loadLeadProfile(from);
}

if (awaitingConfirmation && isNegativeConfirmation(text)) {
  await saveLeadProfile(from, {
    faseQualificacao: "corrigir_dado_final",
    status: "corrigir_dado_final",
    aguardandoConfirmacao: false,
    dadosConfirmadosPeloLead: false
  });

  const msg = `Sem problema 😊 Qual dado está incorreto?

Pode me dizer assim:
- nome está errado
- CPF está errado
- telefone está errado
- cidade está errada
- estado está errado`;

  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

if (awaitingConfirmation && isPositiveConfirmation(text)) {
  await saveLeadProfile(from, {
    ...extractedData,
    cpf: formatCPF(extractedData.cpf),
    telefone: formatPhone(extractedData.telefone),
    estado: normalizeUF(extractedData.estado),
    cidadeEstado: `${extractedData.cidade}/${normalizeUF(extractedData.estado)}`,
    dadosConfirmadosPeloLead: true,
    aguardandoConfirmacao: false,
    faseQualificacao: "dados_confirmados",
    status: "quente",
    qualificadoEm: new Date()
  });

  const confirmedLead = await loadLeadProfile(from);

  if (canSendLeadToCRM(confirmedLead)) {
    const alreadySent = await db.collection("leads").findOne({
      user: from,
      crmEnviado: true
    });

    if (alreadySent) {
      console.log("⚠️ Lead já enviado ao CRM anteriormente");
    } else {
      const lockedLead = await db.collection("leads").findOneAndUpdate(
        {
          user: from,
          crmEnviado: { $ne: true },
          dadosConfirmadosPeloLead: true,
          faseQualificacao: { $in: ["dados_confirmados", "qualificado"] },
          status: "quente"
        },
        {
          $set: {
  crmEnviado: true,
  crmEnviadoEm: new Date(),
  faseQualificacao: "enviado_crm",
  status: "enviado_crm",
  statusOperacional: "enviado_crm",
  faseFunil: "crm",
  temperaturaComercial: "quente",
  rotaComercial: confirmedLead?.rotaComercial || confirmedLead?.origemConversao || "homologado",
  updatedAt: new Date()
}
        },
        { returnDocument: "after" }
      );

      if (lockedLead.value) {
        console.log("🚀 Lead travado para envio ao CRM");
      }

      currentLead = await loadLeadProfile(from);
    }
  }

    const confirmedMsg = `Perfeito, pré-cadastro confirmado ✅

Vou encaminhar suas informações para a equipe comercial de consultores da IQG.

Eles vão entrar em contato em breve para validar os dados, tirar qualquer dúvida final e orientar a finalização da adesão ao Programa Parceiro Homologado.

Só reforçando: essa etapa ainda é um pré-cadastro, não uma aprovação automática nem cobrança. O próximo passo acontece com o consultor IQG.`;

  await sendWhatsAppMessage(from, confirmedMsg);

  try {
    await notifyConsultant({
      user: from,
      telefoneWhatsApp: from,
      ultimaMensagem: text,
      status: "quente"
    });
  } catch (error) {
    console.error("Erro ao notificar consultor:", error);
  }
   
  state.closed = true;
  clearTimers(from);

  await saveHistoryStep(from, history, text, confirmedMsg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

if (
  hasAllRequiredLeadFields(extractedData) &&
  !currentLead?.dadosConfirmadosPeloLead &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !currentLead?.aguardandoConfirmacao
) {
  await saveLeadProfile(from, {
    ...extractedData,
    cpf: formatCPF(extractedData.cpf),
    telefone: formatPhone(extractedData.telefone),
    estado: normalizeUF(extractedData.estado),
    cidadeEstado: `${extractedData.cidade}/${normalizeUF(extractedData.estado)}`,

    // 🛡️ LIMPEZA 25B-8D:
    // Apaga campos temporários da coleta para evitar repetição de dados.
    cidadePendente: null,
    estadoPendente: null,
    campoPendente: null,
    valorPendente: null,
    campoEsperado: null,
    aguardandoConfirmacaoCampo: false,

    dadosConfirmadosPeloLead: false,
    aguardandoConfirmacao: true,
    faseQualificacao: "aguardando_confirmacao_dados",
    status: "aguardando_confirmacao_dados"
  });

  const confirmationMsg = buildLeadConfirmationMessage(extractedData);

  await sendWhatsAppMessage(from, confirmationMsg);
  await saveHistoryStep(from, history, text, confirmationMsg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}
   
     const shouldAskMissingFields =
  currentLead?.faseQualificacao === "coletando_dados" ||
  currentLead?.faseQualificacao === "dados_parciais" ||
  currentLead?.faseQualificacao === "aguardando_dados";

if (
  shouldAskMissingFields &&
  missingFields.length > 0 &&
  Object.keys(extractedData).some(key => REQUIRED_LEAD_FIELDS.includes(key)) &&
  !currentLead?.aguardandoConfirmacaoCampo
)

{
  await saveLeadProfile(from, {
    ...extractedData,
    dadosConfirmadosPeloLead: false,
    aguardandoConfirmacao: false,
    faseQualificacao: "dados_parciais",
    status: "dados_parciais"
  });

  const missingMsg = buildPartialLeadDataMessage(extractedData, missingFields);

  await sendWhatsAppMessage(from, missingMsg);
   await saveHistoryStep(from, history, text, missingMsg, !!message.audio?.id);
   
  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}     
    // 🔥 MONGO HISTÓRICO
   
    history.push({
  role: "user",
  content: message.audio?.id ? `[Áudio transcrito]: ${text}` : text
});
history = history.slice(-20);

const sdrInternalStrategicContext = buildSdrInternalStrategicContext({
  lead: currentLead
});

const sdrConversationMemory = buildConversationMemoryForAgents({
  lead: currentLead || {},
  history,
  lastUserText: text,
  lastSdrText: getLastAssistantMessage(history)
});
     
// 🧠 CONSULTOR PRÉ-SDR OBRIGATÓRIO
// A SDR não responde sozinha.
// Antes da SDR responder, o Consultor Assistente tenta orientar a resposta.
// Se a chamada do Consultor falhar, o backend cria uma orientação fallback segura.
// Assim a SDR sempre responde com uma diretriz, sem pedir para o lead repetir a mensagem.
     
let preSdrConsultantAdvice = null;

const lastAssistantText =
  [...history]
    .reverse()
    .find(message => message.role === "assistant")?.content || "";

try {
 preSdrConsultantAdvice = await runConsultantAssistant({
  lead: currentLead || {},
  history,
  lastUserText: text,
  lastSdrText: lastAssistantText,
  supervisorAnalysis: currentLead?.supervisor || {},
  classification: currentLead?.classificacao || {},
  semanticIntent,
  commercialRouteDecision,
  backendStrategicGuidance
});

const originalPreSdrConsultantAdvice = preSdrConsultantAdvice;

preSdrConsultantAdvice = enforcePreSdrConsultantHardLimits({
  advice: preSdrConsultantAdvice,
  lead: currentLead || {},
  lastUserText: text
});

if (
  originalPreSdrConsultantAdvice?.estrategiaRecomendada !== preSdrConsultantAdvice?.estrategiaRecomendada ||
  originalPreSdrConsultantAdvice?.proximaMelhorAcao !== preSdrConsultantAdvice?.proximaMelhorAcao ||
  originalPreSdrConsultantAdvice?.cuidadoPrincipal !== preSdrConsultantAdvice?.cuidadoPrincipal
) {
  console.log("🛡️ Consultor PRÉ-SDR corrigido por trava dura:", {
    user: from,
    estrategiaOriginal: originalPreSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
    estrategiaCorrigida: preSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
    proximaMelhorAcaoOriginal: originalPreSdrConsultantAdvice?.proximaMelhorAcao || "-",
    proximaMelhorAcaoCorrigida: preSdrConsultantAdvice?.proximaMelhorAcao || "-",
    cuidadoOriginal: originalPreSdrConsultantAdvice?.cuidadoPrincipal || "-",
    cuidadoCorrigido: preSdrConsultantAdvice?.cuidadoPrincipal || "-"
  });
}

await saveConsultantAdvice(from, preSdrConsultantAdvice);

 console.log("🧠 Consultor PRÉ-SDR orientou a resposta:", {
  user: from,
  ultimaMensagemLead: text,
  statusAtual: currentLead?.status || "-",
  faseAtual: currentLead?.faseQualificacao || "-",
  faseFunilAtual: currentLead?.faseFunil || "-",
  etapaAtualCalculada: getCurrentFunnelStage(currentLead),
  etapas: currentLead?.etapas || {},

  estrategiaRecomendada: preSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
  proximaMelhorAcao: preSdrConsultantAdvice?.proximaMelhorAcao || "-",
  abordagemSugerida: preSdrConsultantAdvice?.abordagemSugerida || "-",
  argumentoPrincipal: preSdrConsultantAdvice?.argumentoPrincipal || "-",
  cuidadoPrincipal: preSdrConsultantAdvice?.cuidadoPrincipal || "-",
  ofertaMaisAdequada: preSdrConsultantAdvice?.ofertaMaisAdequada || "nao_analisado",
  momentoIdealHumano: preSdrConsultantAdvice?.momentoIdealHumano || "nao_analisado",
  prioridadeComercial: preSdrConsultantAdvice?.prioridadeComercial || "nao_analisado",
  resumoConsultivo: preSdrConsultantAdvice?.resumoConsultivo || "-"
});
} catch (error) {
  console.error("⚠️ Consultor PRÉ-SDR falhou. Usando fallback seguro interno:", {
    user: from,
    erro: error.message,
    ultimaMensagemLead: text
  });

    preSdrConsultantAdvice = buildPreSdrConsultantFallbackAdvice({
    lead: currentLead || {},
    history,
    lastUserText: text,
    lastSdrText: lastAssistantText
  });

  if (Array.isArray(backendStrategicGuidance) && backendStrategicGuidance.length > 0) {
    preSdrConsultantAdvice = {
      ...preSdrConsultantAdvice,
      prioridadeComercial: "alta",
      proximaMelhorAcao: [
        preSdrConsultantAdvice.proximaMelhorAcao || "",
        "Considerar obrigatoriamente os sinais estratégicos detectados pelo backend antes de orientar a SDR.",
        ...backendStrategicGuidance.map(item => item.orientacaoParaPreSdr || "").filter(Boolean)
      ].filter(Boolean).join("\n"),
      resumoConsultivo: [
        preSdrConsultantAdvice.resumoConsultivo || "",
        "Fallback aplicado com sinais estratégicos do backend."
      ].filter(Boolean).join("\n")
    };
  }

  preSdrConsultantAdvice = enforcePreSdrConsultantHardLimits({
    advice: preSdrConsultantAdvice,
    lead: currentLead || {},
    lastUserText: text
  });

  await saveConsultantAdvice(from, preSdrConsultantAdvice);

  console.log("🧠 Consultor PRÉ-SDR fallback aplicado:", {
    user: from,
    estrategiaRecomendada: preSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
    proximaMelhorAcao: preSdrConsultantAdvice?.proximaMelhorAcao || "-",
    cuidadoPrincipal: preSdrConsultantAdvice?.cuidadoPrincipal || "-"
  });
}
const preSdrConsultantContext = `ORIENTAÇÃO HIERÁRQUICA OBRIGATÓRIA DO CONSULTOR PRÉ-SDR — USO INTERNO DA SDR

Esta orientação veio ANTES da resposta da SDR.

REGRA DE HIERARQUIA:
A SDR não deve decidir sozinha a condução comercial.
A SDR deve executar a orientação abaixo como direção principal da resposta atual.

Se houver conflito entre:
1. o prompt geral da SDR;
2. o histórico;
3. a vontade aparente de avançar rápido;
4. e a orientação do Consultor Pré-SDR;

a SDR deve priorizar a orientação do Consultor Pré-SDR.

Exceções:
- Nunca violar regras duras do backend.
- Nunca pedir pagamento.
- Nunca aprovar lead.
- Nunca prometer ganho.
- Nunca pedir dados antes da fase correta.
- Nunca misturar Afiliado com Homologado.
- Nunca revelar que existe Consultor, Supervisor, Classificador, memória interna ou agentes internos.

A resposta final ao lead deve seguir:
1. responder primeiro a última mensagem real do lead;
2. se a mensagem do lead tiver múltiplos temas ou perguntas, responder todos em uma única mensagem organizada;
3. obedecer a próxima melhor ação do Consultor;
4. respeitar o cuidado principal;
5. usar o argumento principal quando fizer sentido;
6. conduzir com apenas um próximo passo.
Estratégia recomendada:
${preSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado"}
Próxima melhor ação:
${preSdrConsultantAdvice?.proximaMelhorAcao || "-"}

Abordagem sugerida:
${preSdrConsultantAdvice?.abordagemSugerida || "-"}

Argumento principal:
${preSdrConsultantAdvice?.argumentoPrincipal || "-"}

Cuidado principal:
${preSdrConsultantAdvice?.cuidadoPrincipal || "-"}

Oferta mais adequada:
${preSdrConsultantAdvice?.ofertaMaisAdequada || "nao_analisado"}

Momento ideal para humano:
${preSdrConsultantAdvice?.momentoIdealHumano || "nao_analisado"}

Prioridade comercial:
${preSdrConsultantAdvice?.prioridadeComercial || "nao_analisado"}

Resumo consultivo:
${preSdrConsultantAdvice?.resumoConsultivo || "-"}

REGRAS OBRIGATÓRIAS PARA A SDR:

- A orientação do Consultor Pré-SDR é a direção principal da resposta atual.
- A SDR não pode contradizer a estratégia recomendada, a próxima melhor ação ou o cuidado principal.
- Se o Consultor orientar "tratar objeção", a SDR não pode ignorar a objeção e seguir roteiro.
- Se o Consultor orientar "não avançar", a SDR não pode conduzir para pré-análise.
- Se o Consultor orientar "manter nutrição", a SDR não pode pedir dados.
- Se o Consultor orientar "oferecer afiliado", a SDR deve falar somente do Programa de Afiliados, sem misturar taxa, comodato ou pré-análise do Homologado.
- Se o Consultor orientar "corrigir condução", a SDR deve corrigir a conversa com naturalidade, sem dizer que errou.
- A SDR só pode conduzir para pré-análise se o lead demonstrar intenção explícita, como "quero seguir", "vamos seguir", "pode iniciar", "quero entrar" ou equivalente, e se o backend/fase permitir.
- Se o lead apenas confirmou entendimento, a SDR deve avançar para a próxima explicação necessária do funil, não para coleta de dados.- Responder primeiro a manifestação real do lead.
- Se o lead fez pergunta, responder a pergunta antes de conduzir.
- Se o lead mandou áudio, considerar a transcrição como a mensagem principal.
- Não ignorar objeção, dúvida, reclamação ou correção do lead.
- Não seguir roteiro se o lead perguntou outra coisa.
- Não falar taxa antes da fase correta.
- Não pedir dados antes da fase correta.
- Não repetir explicação que o lead já disse ter entendido.
- "ok", "sim", "sei sim", "entendi", "fez sentido", "foi explicativo", "show", "top" e "ficou claro" indicam apenas entendimento quando não houver pedido claro de avanço.
- Expressões como "bora", "mete bala", "manda ver", "demorou", "toca ficha", "pode seguir", "vamos nessa" e equivalentes indicam intenção explícita de avançar, mas a SDR só pode conduzir para pré-análise se o backend/fase atual permitir.
- Responder de forma natural, curta e consultiva.
- Nunca mostrar ao lead que existe Consultor Assistente, Supervisor, Classificador ou análise interna de IA.`;

const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "Content-Type": "application/json"
},
body: JSON.stringify({
  model: "gpt-4o-mini",
  messages: [
  { role: "system", content: SYSTEM_PROMPT },
  {
    role: "system",
    content: preSdrConsultantContext
  },
  {
    role: "system",
    content: sdrInternalStrategicContext || "Sem contexto estratégico interno adicional disponível neste momento."
  },
  {
    role: "system",
    content: `MEMÓRIA CONVERSACIONAL INTERNA — USO INTERNO DA SDR

${JSON.stringify(sdrConversationMemory, null, 2)}

Regras:
- Não diga ao lead que existe memória interna.
- Não cite "memória", "histórico interno", "consultor", "supervisor" ou "classificador".
- Se houver risco de repetição, não repita a explicação completa.
- Se o lead respondeu curto, conduza com uma pergunta simples.
- Se houver etapas pendentes, não conduza para pré-análise/coleta.
- Responda primeiro a dúvida atual do lead.
- Se a última mensagem do lead tiver mais de um tema em temasMensagemAtualLead, responda todos os temas em uma única mensagem organizada.
- Não responda somente a última pergunta se houver perguntas anteriores na mesma mensagem agrupada.
- Depois de responder todos os temas, conduza com apenas uma pergunta final.`
  },
  {
    role: "system",
    content: `DADOS DE CONTEXTO DO LEAD:
Nome informal do WhatsApp: ${currentLead?.nomeWhatsApp || "-"}
...
Nome já informado: ${currentLead?.nome || "-"}
Gênero provável: ${currentLead?.generoProvavel || extractedData?.generoProvavel || "indefinido"}

Use o nome informal apenas de forma natural e moderada.
Se o gênero provável for masculino, use pronomes masculinos quando necessário.
Se o gênero provável for feminino, use pronomes femininos quando necessário.
Se estiver indefinido, prefira linguagem neutra e evite frases como "interessado/interessada", "pronto/pronta".`
  },
  {
    role: "system",
    content: "IMPORTANTE: Não use dados pessoais encontrados no histórico antigo como nome, CPF, telefone, cidade ou estado. Na coleta atual, peça e confirme os dados novamente, começando pelo nome completo."
  },

     {
  role: "system",
  content: "A última mensagem do lead pode conter várias mensagens enviadas em sequência ou separadas por quebras de linha. Considere tudo como um único contexto e responda em uma única mensagem completa, organizada e natural, sem dividir a resposta em várias partes."
},
  ...history
]
})
    });

    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error("Erro OpenAI:", data);
      throw new Error("Falha ao chamar OpenAI");
    }

   const rawResposta = data.choices?.[0]?.message?.content || "";

const { cleanReply, actions } = extractActions(rawResposta);

// 🔥 fallback inteligente (evita resposta vazia ou quebrada)
let resposta = cleanReply?.trim();

if (!resposta) {
  resposta = "Perfeito 😊 Me conta um pouco melhor o que você quer entender pra eu te ajudar da melhor forma.";
}

// 🚫 BLOQUEIO DE CONTRATO ANTES DO CRM
const leadPediuContratoAgora =
  hasExplicitFileRequest(text) &&
  detectRequestedFile(text) === "contrato";

const iaTentouEnviarContrato =
  Array.isArray(actions) &&
  actions.includes("contrato");

const podeEnviarContratoAgora =
  canSendBusinessFile("contrato", currentLead || {});

if ((leadPediuContratoAgora || iaTentouEnviarContrato) && !podeEnviarContratoAgora) {
  removeFileAction(actions, "contrato");

  resposta = `Posso te explicar sobre o contrato 😊

A versão oficial para assinatura só é liberada depois da análise cadastral da equipe IQG.

Antes disso, eu consigo te orientar sobre as regras principais do programa, responsabilidades, investimento e próximos passos, mas sem antecipar assinatura ou envio de contrato oficial.

Quer que eu te explique como funciona essa etapa depois da pré-análise?`;
}
     
     const respostaLower = resposta.toLowerCase();
     const jaExplicouPrograma =
  historyText.includes("parceria") &&
  historyText.includes("iqg");

const jaFalouBeneficios =
  historyText.includes("benef") ||
  historyText.includes("comissão") ||
  historyText.includes("comodato");

const jaFalouRegras =
  historyText.includes("nome limpo") ||
  historyText.includes("contrato") ||
  historyText.includes("responsabilidade");

const jaFalouInvestimento =
  historyText.includes("1990") ||
  historyText.includes("1.990") ||
  historyText.includes("investimento");

const leadConfirmouCiencia =
  isCommercialProgressConfirmation(text) &&
  (
    historyText.includes("ficou claro") ||
    historyText.includes("faz sentido") ||
    historyText.includes("posso seguir") ||
    historyText.includes("podemos seguir") ||
    historyText.includes("nesse formato") ||
    historyText.includes("resultado depende da sua atuação") ||
    historyText.includes("resultado depende da sua atuacao") ||
    historyText.includes("depende da sua atuação nas vendas") ||
    historyText.includes("depende da sua atuacao nas vendas")
  );

const podeIniciarColeta = canStartDataCollection(currentLead) &&
  currentLead?.interesseReal === true;

const startedDataCollection =
  respostaLower.includes("primeiro, pode me enviar seu nome completo") ||
  respostaLower.includes("pode me enviar seu nome completo") ||
  respostaLower.includes("vamos seguir com a pré-análise") ||
  respostaLower.includes("seguir com a pré-análise aos poucos");

     const deveForcarInicioColeta =
  podeIniciarColeta &&
  currentLead?.faseQualificacao !== "coletando_dados" &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !currentLead?.aguardandoConfirmacao;

// 🔒 Só inicia coleta se realmente pode iniciar
if (
  (startedDataCollection || deveForcarInicioColeta) &&
  podeIniciarColeta &&
  currentLead?.faseQualificacao !== "coletando_dados"
) {
  await saveLeadProfile(from, {
    // 🔥 limpa dados antigos para não reaproveitar nome/CPF/telefone de conversa passada
    nome: null,
    cpf: null,
    telefone: null,
    cidade: null,
    estado: null,
    cidadeEstado: null,

    campoPendente: null,
    valorPendente: null,
    campoEsperado: "nome",

    aguardandoConfirmacaoCampo: false,
    aguardandoConfirmacao: false,
    dadosConfirmadosPeloLead: false,

    faseQualificacao: "coletando_dados",
    status: "coletando_dados"
  });

  resposta = "Perfeito 😊 Vamos seguir então.\n\nPrimeiro, pode me enviar seu nome completo?";
}

let respostaFinal = resposta;

// BLOCO 11B:
// Lista única de problemas encontrados antes do envio.
// Qualquer trava comercial deve adicionar orientação aqui,
// e não substituir respostaFinal com texto fixo.
let sdrReviewFindings = [];
     
// 🚫 BLOQUEIO DE REGRESSÃO DE FASE — VERSÃO SEGURA
// Não bloqueia respostas apenas porque citam palavras como "estoque", "taxa" ou "programa".
// A SDR pode responder dúvidas reais do lead sobre fases anteriores.
// O bloqueio só atua quando a resposta tenta reiniciar o funil de forma genérica.

const respostaLowerCheck = respostaFinal
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "");

const respostaPareceReinicioDoFunil =
  respostaLowerCheck.includes("vou te explicar de forma direta como funciona o programa") ||
  respostaLowerCheck.includes("vamos comecar pelo inicio") ||
  respostaLowerCheck.includes("deixa eu comecar explicando o programa") ||
  respostaLowerCheck.includes("primeiro preciso te explicar o programa") ||
  respostaLowerCheck.includes("antes de tudo, o programa funciona assim");

const leadFezPerguntaEspecifica =
  String(text || "").includes("?") ||
  /\b(estoque|comodato|taxa|valor|investimento|contrato|responsabilidade|comissao|comissão|kit|produto|afiliado|link)\b/i.test(text);

if (
  respostaPareceReinicioDoFunil &&
  !leadFezPerguntaEspecifica &&
  getCurrentFunnelStage(currentLead) > 1
) {
  sdrReviewFindings.push({
    tipo: "tentativa_reiniciar_funil",
    prioridade: "alta",
    orientacao:
      "A SDR tentou reiniciar o funil com explicação genérica, mesmo o lead já estando mais avançado. Reescrever sem voltar ao início, mantendo a fase atual e conduzindo para o próximo passo natural."
  });

  console.log("🧭 Revisão solicitada: SDR tentou reiniciar o funil:", {
    user: from,
    ultimaMensagemLead: text
  });
}

     // 🔥 Ajuste fino de gênero (fallback)
const genero = currentLead?.generoProvavel || extractedData?.generoProvavel;

if (genero === "masculino") {
  respostaFinal = respostaFinal
    .replace(/\binteressada\b/gi, "interessado")
    .replace(/\bpronta\b/gi, "pronto")
    .replace(/\bpreparada\b/gi, "preparado");
}

if (genero === "feminino") {
  respostaFinal = respostaFinal
    .replace(/\binteressado\b/gi, "interessada")
    .replace(/\bpronto\b/gi, "pronta")
    .replace(/\bpreparado\b/gi, "preparada");
}
     
const nomeCurto = getFirstName(currentLead?.nomeWhatsApp || currentLead?.nome || "");

if (
  nomeCurto &&
  shouldUseName(state) &&
  !respostaFinal.toLowerCase().includes(nomeCurto.toLowerCase())
) {
  const novaResposta = respostaFinal.replace(
    /(Perfeito 😊|Ótimo 😊|Certo 😊|Legal 😊|Show 😊)/,
    `$1 ${nomeCurto},`
  );

  if (novaResposta !== respostaFinal) {
    respostaFinal = novaResposta;
    state.lastNameUse = Date.now();
  }
}
     
     // 🔥 DETECTOR DE RESPOSTA RUIM DA IA
function isBadResponse(text = "") {
  const t = text.toLowerCase().trim();

  if (!t) return true;

  // respostas genéricas ruins
  const badPatterns = [
    "como posso ajudar",
    "em que posso ajudar",
    "estou aqui para ajudar",
    "fico à disposição",
    "qualquer dúvida me avise",
    "ok 👍",
    "certo 👍"
  ];

  if (badPatterns.some(p => t.includes(p))) return true;

  // muito curta (sem valor)
  if (t.length < 15) return true;

  // sem pergunta (sem condução)
  if (!t.includes("?") && t.length < 80) return true;

  return false;
}

// 🔥 CORREÇÃO AUTOMÁTICA
if (isBadResponse(respostaFinal)) {
  if (currentLead?.faseQualificacao === "coletando_dados") {
    respostaFinal = "Perfeito 😊 Vamos seguir então.\n\nPrimeiro, pode me enviar seu nome completo?";
  } else if (podeIniciarColeta) {
    respostaFinal = "Perfeito 😊 Podemos seguir então.\n\nPrimeiro, pode me enviar seu nome completo?";
  } else {
    respostaFinal = "Perfeito 😊 Me conta: o que você quer entender melhor sobre o programa?";
  }
}
     
// 🚫 BLOQUEIO SEGURO: só falar "material já enviado" se o LEAD pediu material de novo
const leadPediuMaterialAgora = hasExplicitFileRequest(text);

if (
  leadPediuMaterialAgora &&
  currentLead?.sentFiles?.folder &&
  /material|folder|pdf|catalogo|catálogo|kit|manual|contrato|lista/i.test(respostaFinal)
) {
  respostaFinal = "Esse material já te enviei logo acima 😊\n\nConseguiu dar uma olhada? Se quiser, posso te resumir os pontos principais por aqui.";
}
     
const mencionouPreAnalise =
  /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal);

if (mencionouPreAnalise && !podeIniciarColeta) {
  sdrReviewFindings.push({
    tipo: "pre_analise_prematura",
    prioridade: "critica",
    orientacao:
      [
        "A SDR mencionou pré-análise ou tentou conduzir para pré-cadastro antes do backend liberar a coleta.",
        "Reescrever sem pedir dados e sem prometer pré-análise agora.",
        "Responder primeiro a última mensagem do lead.",
        "Depois conduzir para a etapa obrigatória pendente: programa, benefícios, estoque, responsabilidades, investimento ou compromisso.",
        leadDeuApenasConfirmacaoFraca
          ? "O lead deu apenas confirmação fraca; não tratar isso como avanço forte."
          : "",
        jaFalouInvestimento && isCommercialProgressConfirmation(text)
          ? "Se o investimento já foi explicado e o lead demonstrou continuidade, validar compromisso/responsabilidade antes de qualquer coleta."
          : ""
      ].filter(Boolean).join("\n")
  });

  console.log("🧭 Revisão solicitada: pré-análise prematura bloqueada antes do envio:", {
    user: from,
    ultimaMensagemLead: text,
    mencionouPreAnalise,
    podeIniciarColeta
  });
}
     
// 🚨 BLOQUEIO DE COLETA PREMATURA — BLOCO 11B
// A SDR pode ter tentado iniciar coleta antes da hora.
// O backend NÃO substitui mais a resposta por texto fixo.
// Ele pede revisão da própria SDR antes do envio.
if (startedDataCollection && !podeIniciarColeta) {
  const jaEnviouFolder = Boolean(currentLead?.sentFiles?.folder);

  const ultimaRespostaBot = [...history]
    .reverse()
    .find(m => m.role === "assistant")?.content || "";

  const jaPerguntouDuvida =
    ultimaRespostaBot.includes("ficou alguma dúvida específica") ||
    ultimaRespostaBot.includes("ficou alguma dúvida");

  sdrReviewFindings.push({
    tipo: "coleta_prematura",
    prioridade: "critica",
    orientacao:
      [
        "A SDR tentou iniciar coleta de dados antes do backend liberar.",
        "Reescrever sem pedir nome, CPF, telefone, cidade ou estado.",
        "Não dizer que vai seguir com pré-análise agora.",
        "Responder primeiro a última mensagem do lead.",
        "Depois conduzir para a etapa pendente correta.",
        jaFalouInvestimento && isCommercialProgressConfirmation(text)
          ? "Como o investimento já foi explicado e o lead demonstrou continuidade, validar compromisso: se ele está de acordo que o resultado depende da atuação dele nas vendas."
          : "",
        jaFalouBeneficios && jaEnviouFolder && !jaFalouInvestimento
          ? "Como benefícios/folder já foram trabalhados, o próximo tema provável é investimento, mas a SDR deve conduzir de forma natural e sem coleta."
          : "",
        jaFalouBeneficios && !jaFalouInvestimento
          ? "Como benefícios já foram trabalhados, mas investimento ainda não, orientar para explicar investimento antes de qualquer coleta."
          : "",
        jaPerguntouDuvida && isCommercialProgressConfirmation(text)
          ? "Se a SDR já perguntou se havia dúvida e o lead confirmou continuidade, avançar para o próximo tema do funil, sem coleta."
          : "",
        jaEnviouFolder && !jaFalouInvestimento
          ? "Se o folder já foi enviado, não repetir o envio; seguir com explicação objetiva do próximo tema."
          : ""
      ].filter(Boolean).join("\n")
  });

  console.log("🧭 Revisão solicitada: coleta prematura bloqueada antes do envio:", {
    user: from,
    ultimaMensagemLead: text,
    startedDataCollection,
    podeIniciarColeta,
    jaEnviouFolder,
    jaPerguntouDuvida
  });
}
     

// 🧠 BLOCO 8A — REVISÃO DA SDR ANTES DO ENVIO
// A partir daqui, o backend não substitui mais a resposta por textos prontos.
// Ele apenas identifica problemas e pede para a própria SDR revisar a resposta
// antes que qualquer mensagem seja enviada ao lead.

// sdrReviewFindings já foi inicializado antes das travas finais.

const multiDataRequestPattern =
  /nome.*cpf.*telefone.*cidade|cpf.*nome.*telefone|telefone.*cpf.*cidade/i;

if (multiDataRequestPattern.test(respostaFinal)) {
  sdrReviewFindings.push({
    tipo: "pedido_multiplos_dados",
    prioridade: "critica",
    orientacao:
      "A resposta tentou pedir vários dados de uma vez. A SDR deve pedir apenas um dado por vez, começando pelo nome completo se a coleta estiver liberada."
  });
}

if (isRepeatedBotReply(respostaFinal, history)) {
  sdrReviewFindings.push({
    tipo: "loop_resposta_repetida",
    prioridade: "alta",
    orientacao:
      "A resposta ficou igual ou muito parecida com a última resposta da SDR. Reescrever de forma natural, sem repetir o mesmo conteúdo."
  });
}

const antiRepetition = applyAntiRepetitionGuard({
  leadText: text,
  respostaFinal,
  currentLead,
  history
});

if (antiRepetition.changed) {
  sdrReviewFindings.push({
    tipo: "repeticao_de_tema",
    prioridade: "alta",
    reason: antiRepetition.reason,
    orientacao:
      "A SDR tentou repetir um tema já explicado. Reescrever sem repetir o textão e conduzir para o próximo passo natural."
  });
}

const taxObjectionAntiRepetition = applyTaxObjectionAntiRepetitionGuard({
  leadText: text,
  respostaFinal,
  currentLead,
  history
});

if (taxObjectionAntiRepetition.changed) {
  sdrReviewFindings.push({
    tipo: "repeticao_objecao_taxa",
    prioridade: "alta",
    reason: taxObjectionAntiRepetition.reason,
    orientacao:
      "A SDR tentou repetir explicação longa da taxa. Reescrever tratando a objeção com novo ângulo, sem repetir o mesmo texto."
  });
}

const consultantDirectionGuard = enforceConsultantDirectionOnFinalReply({
  respostaFinal,
  consultantAdvice: preSdrConsultantAdvice || {},
  currentLead,
  leadText: text
});

if (consultantDirectionGuard.changed) {
  sdrReviewFindings.push({
    tipo: "contradicao_orientacao_pre_sdr",
    prioridade: "critica",
    reason: consultantDirectionGuard.reason,
    orientacao:
      "A resposta contradiz a orientação do Consultor Pré-SDR. Reescrever obedecendo a próxima melhor ação, cuidado principal e argumento principal do Pré-SDR."
  });
}

const unansweredQuestionGuard = enforceLeadQuestionWasAnswered({
  leadText: text,
  respostaFinal,
  currentLead
});

if (unansweredQuestionGuard.changed) {
  sdrReviewFindings.push({
    tipo: "pergunta_ou_objecao_nao_respondida",
    prioridade: "critica",
    reason: unansweredQuestionGuard.reason,
    orientacao:
      "A resposta não cobriu a pergunta ou objeção atual do lead. Reescrever respondendo primeiro a mensagem real do lead."
  });
}

const disciplinaFunil = enforceFunnelDiscipline({
  respostaFinal,
  currentLead,
  leadText: text
});

if (disciplinaFunil.changed) {
  sdrReviewFindings.push({
    tipo: "disciplina_funil",
    prioridade: "critica",
    reason: disciplinaFunil.reason,
    orientacao:
      "A resposta tentou pular fase, falar tema cedo demais, misturar assuntos ou pedir dados antes da hora. Reescrever respeitando o funil e a fase atual."
  });
}

const routeMixGuard = await runFinalRouteMixGuard({
  lead: currentLead || {},
  leadText: text,
  respostaFinal,
  semanticIntent,
  commercialRouteDecision
});

if (routeMixGuard.changed) {
  sdrReviewFindings.push({
    tipo: "mistura_afiliado_homologado",
    prioridade: "critica",
    motivo: routeMixGuard.motivo || "",
    orientacao:
      "A resposta misturou indevidamente Afiliado e Homologado. Reescrever separando corretamente os programas e seguindo a intenção real do lead."
  });
}

if (sdrReviewFindings.length > 0) {
  const primeiraRespostaSdr = respostaFinal;

  respostaFinal = await regenerateSdrReplyWithGuardGuidance({
    currentLead,
    history,
    userText: text,
    primeiraRespostaSdr,
    preSdrConsultantAdvice: preSdrConsultantAdvice || {},
    preSdrConsultantContext,
    guardFindings: sdrReviewFindings
  });

  console.log("🔁 Resposta final saiu de revisão da SDR antes do envio:", {
    user: from,
    quantidadeProblemasDetectados: sdrReviewFindings.length,
    problemas: sdrReviewFindings.map(item => item.tipo),
    primeiraRespostaSdr,
    respostaFinal
  });
}
     
    // 🧭 BLOCO 4 — PROGRESSO DO FUNIL POR ENTENDIMENTO DO LEAD
// A etapa NÃO é mais concluída só porque a SDR falou sobre o tema.
// Primeiro analisamos se a mensagem atual do lead demonstra entendimento,
// continuidade ou avanço natural em relação à última explicação da SDR.

const funnelProgressFromLead = iqgBuildFunnelProgressUpdateFromLeadReply({
  leadText: text,
  history,
  currentLead,
  semanticIntent
});

let etapasDepoisDoEntendimento = {
  ...(currentLead?.etapas || {})
};

if (funnelProgressFromLead.changed) {
  etapasDepoisDoEntendimento = {
    ...etapasDepoisDoEntendimento,
    ...funnelProgressFromLead.etapas
  };

  const patchEntendimentoLead = {
    etapas: etapasDepoisDoEntendimento,
    ultimaEvidenciaEntendimentoFunil: {
      understoodSteps: funnelProgressFromLead.understoodSteps,
      evidence: funnelProgressFromLead.evidence,
      registradoEm: new Date()
    }
  };

  if (
    funnelProgressFromLead.understoodSteps.includes("investimento") &&
    currentLead?.taxaAlinhada !== true
  ) {
    patchEntendimentoLead.taxaAlinhada = true;
    patchEntendimentoLead.taxaObjectionCount = 0;
    patchEntendimentoLead.ultimaObjecaoTaxa = null;

    patchEntendimentoLead.etapas = {
      ...patchEntendimentoLead.etapas,
      taxaPerguntada: false
    };
  }

  await saveLeadProfile(from, patchEntendimentoLead);

  currentLead = await loadLeadProfile(from);

  console.log("✅ Etapa(s) do funil concluída(s) por entendimento do lead:", {
    user: from,
    understoodSteps: funnelProgressFromLead.understoodSteps,
    criterio: funnelProgressFromLead.evidence?.criterio || "",
    ultimaMensagemLead: text
  });
}

// 🧭 BLOCO 4 — ETAPA APRESENTADA, MAS AINDA AGUARDANDO ENTENDIMENTO
// Aqui registramos que a SDR apresentou um tema,
// mas isso NÃO conclui a etapa.
// Serve para o Historiador/Pré-SDR saberem o que foi explicado
// e aguardarem o sinal do lead na próxima mensagem.

const pendingFunnelFlagsFromCurrentReply = iqgBuildPendingFunnelFlagsFromCurrentSdrReply({
  respostaFinal,
  currentLead
});

if (pendingFunnelFlagsFromCurrentReply.changed) {
  await saveLeadProfile(from, {
    etapas: pendingFunnelFlagsFromCurrentReply.etapas,
    etapasAguardandoEntendimento: pendingFunnelFlagsFromCurrentReply.pendingFlags,
    ultimaEtapaApresentadaPelaSdr: {
      pendingSteps: pendingFunnelFlagsFromCurrentReply.pendingSteps,
      explainedNow: pendingFunnelFlagsFromCurrentReply.explainedNow,
      registradoEm: new Date()
    }
  });

  currentLead = await loadLeadProfile(from);

  console.log("🕒 Etapa(s) apresentada(s) pela SDR, aguardando entendimento do lead:", {
    user: from,
    pendingSteps: pendingFunnelFlagsFromCurrentReply.pendingSteps
  });
}

     
// 🛡️ BLOCO 8B — VAZAMENTO INTERNO NÃO VIRA MAIS RESPOSTA HARDCODED
// Se a SDR deixou escapar termos internos, o backend pede uma revisão da própria SDR.
// Só usamos fallback fixo se a revisão ainda continuar vazando contexto interno.
if (containsInternalContextLeak(respostaFinal)) {
  console.warn("⚠️ Resposta da SDR continha possível vazamento interno. Solicitando revisão antes do envio:", {
    user: from
  });

  const respostaAntesDoLeakReview = respostaFinal;

  respostaFinal = await regenerateSdrReplyWithGuardGuidance({
    currentLead,
    history,
    userText: text,
    primeiraRespostaSdr: respostaFinal,
    preSdrConsultantAdvice: preSdrConsultantAdvice || {},
    preSdrConsultantContext,
    guardFindings: [
      {
        tipo: "vazamento_contexto_interno",
        prioridade: "critica",
        orientacao:
          "A resposta mencionou termos internos como supervisor, classificador, consultor, contexto interno, agente, backend, diagnóstico ou estratégia. Reescrever naturalmente para o lead sem mencionar nada interno."
      }
    ]
  });

  console.log("🔁 SDR revisou resposta por risco de vazamento interno:", {
    user: from,
    respostaAntesDoLeakReview,
    respostaDepoisDoLeakReview: respostaFinal
  });

  if (containsInternalContextLeak(respostaFinal)) {
    console.warn("🛑 Revisão ainda continha vazamento interno. Aplicando fallback seguro mínimo:", {
      user: from
    });

    respostaFinal = "Perfeito 😊 Vou te orientar de forma simples e direta.\n\nMe conta: qual ponto você quer entender melhor agora sobre o programa?";
  }
}

     // 📎 BLOCO 8B — SINCRONIZA ACTIONS DA RESPOSTA FINAL
// Como a SDR pode ter revisado a resposta, os comandos de arquivo precisam
// ser extraídos novamente da resposta final real que será enviada ao lead.
const syncedFinalReply = syncActionsFromFinalReply({
  respostaFinal,
  actions
});

respostaFinal = syncedFinalReply.respostaFinal;

console.log("📎 Actions sincronizados com a resposta final:", {
  user: from,
  actions
});
     
// 🔥 Mostra "digitando..." real no WhatsApp
await sendTypingIndicator(messageId);

const typingTime = humanDelay(respostaFinal);

// pausa curta de leitura
await delay(800);

// tempo proporcional ao tamanho da resposta
await delay(typingTime);

console.log("📤 SDR vai enviar resposta final:", {
  user: from,
  ultimaMensagemLead: text,
  respostaFinal,
  statusAtual: currentLead?.status || "-",
  faseAtual: currentLead?.faseQualificacao || "-",
  faseFunilAtual: currentLead?.faseFunil || "-",
  etapaAtualCalculada: getCurrentFunnelStage(currentLead),
  etapas: currentLead?.etapas || {},
  mencionouPreAnalise: /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal),
  mencionouInvestimento: replyMentionsInvestment(respostaFinal),
  pediuDados: replyAsksPersonalData(respostaFinal)
});

// envia resposta
await sendWhatsAppMessage(from, respostaFinal);
     
history.push({ role: "assistant", content: respostaFinal });

const leadAtualizadoParaAgentes = await loadLeadProfile(from);

console.log("🧾 Contexto enviado aos agentes pós-SDR:", {
  user: from,
  ultimaMensagemLead: text,
  ultimaRespostaSdr: respostaFinal,
  totalMensagensHistorico: Array.isArray(history) ? history.length : 0,
  ultimasMensagensHistorico: Array.isArray(history) ? history.slice(-6) : [],
  leadParaAgentes: {
    status: leadAtualizadoParaAgentes?.status || "-",
    faseQualificacao: leadAtualizadoParaAgentes?.faseQualificacao || "-",
    statusOperacional: leadAtualizadoParaAgentes?.statusOperacional || "-",
    faseFunil: leadAtualizadoParaAgentes?.faseFunil || "-",
    temperaturaComercial: leadAtualizadoParaAgentes?.temperaturaComercial || "-",
    rotaComercial: leadAtualizadoParaAgentes?.rotaComercial || "-",
    etapas: leadAtualizadoParaAgentes?.etapas || {}
  }
});
     
runSupervisorAfterSdrReply({
  user: from,
  lead: leadAtualizadoParaAgentes || currentLead,
  history,
  lastUserText: text,
  lastSdrText: respostaFinal
});
     
await saveConversation(from, history);

// 🔥 Envio de arquivos por decisão da IA
const fileKeys = new Set();

const requestedFile = hasExplicitFileRequest(text)
  ? detectRequestedFile(text)
  : null;

if (requestedFile) {
  fileKeys.add(requestedFile);
}

for (const action of actions) {
  if (canSendBusinessFile(action, currentLead || {})) {
    fileKeys.add(action);
  } else {
    console.log("📎 Arquivo bloqueado por regra comercial:", {
      user: from,
      arquivo: action,
      fase: currentLead?.faseQualificacao || "-",
      funil: currentLead?.faseFunil || "-",
      statusOperacional: currentLead?.statusOperacional || "-"
    });
  }
}

for (const key of fileKeys) {
  if (!canSendBusinessFile(key, currentLead || {})) {
    console.log("📎 Arquivo não enviado por regra comercial:", {
      user: from,
      arquivo: key
    });

    continue;
  }

  await sendFileOnce(from, key);
}

// 🔥 follow-up sempre ativo após resposta da IA
scheduleLeadFollowups(from);

    markMessageIdsAsProcessed(bufferedMessageIds);

return;
  } catch (error) {
    if (messageId) {
      processingMessages.delete(messageId);
    }

    console.error("Erro no webhook:", error);
    return;
  }
});

app.get("/", (req, res) => {
  res.status(200).send("IQG WhatsApp Bot online.");
});

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function splitCidadeEstado(cidadeEstado = "") {
  const parts = String(cidadeEstado).split("/");
  return {
    cidade: parts[0]?.trim() || "-",
    estado: parts[1]?.trim() || "-"
  };
}

function formatDate(date) {
  if (!date) return "-";
  return new Date(date).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo"
  });
}

function requireDashboardAuth(req, res) {
  const password = process.env.DASHBOARD_PASSWORD;

  if (!password) return true;

  if (req.query.senha === password) return true;

  res.status(401).send(`
    <h2>Acesso restrito</h2>
    <p>Use: /dashboard?senha=SUA_SENHA</p>
  `);

  return false;
}

app.get("/lead/:user/status/:status", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    const allowedStatus = [
       "inicio",
  "novo",
  "morno",
  "qualificando",
"afiliado",
  "dados_parciais",
  "aguardando_confirmacao_dados",
  "dados_confirmados",
       "qualificado",
       "coletando_dados",
  "pre_analise",
  "quente",
  "em_atendimento",
  "fechado",
  "perdido",
  "erro_dados",
  "erro_envio_crm",
       "aguardando_confirmacao_campo",
"corrigir_dado",
       "corrigir_dado_final",
       "aguardando_valor_correcao_final",
];

    const { user, status } = req.params;

    if (!allowedStatus.includes(status)) {
      return res.status(400).send("Status inválido");
    }

    await updateLeadStatus(user, status);

    const senha = req.query.senha ? `?senha=${req.query.senha}` : "";
    return res.redirect(`/dashboard${senha}`);
  } catch (error) {
    console.error("Erro ao atualizar status:", error);
    return res.status(500).send("Erro ao atualizar status.");
  }
});

app.get("/conversation/:user", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    await connectMongo();

    const user = decodeURIComponent(req.params.user);

    const conversation = await db.collection("conversations").findOne({ user });
    const lead = await db.collection("leads").findOne({ user });

    const messages = Array.isArray(conversation?.messages)
      ? conversation.messages
      : [];

    const senhaQuery = req.query.senha
      ? `?senha=${encodeURIComponent(req.query.senha)}`
      : "";

    const rows = messages.map(msg => {
      const role = msg.role === "user" ? "Lead" : "SDR";
      const cssClass = msg.role === "user" ? "user" : "assistant";

      return `
        <div class="message ${cssClass}">
          <div class="role">${escapeHtml(role)}</div>
          <div class="content">${escapeHtml(msg.content || "").replaceAll("\n", "<br>")}</div>
        </div>
      `;
    }).join("");

    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <title>Conversa - ${escapeHtml(lead?.nome || user)}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />

        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #f3f4f6;
            color: #111827;
          }

          header {
            background: #111827;
            color: white;
            padding: 20px 28px;
          }

          header h1 {
            margin: 0;
            font-size: 24px;
          }

          header p {
            margin: 6px 0 0;
            color: #d1d5db;
          }

          .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 24px;
          }

          .topbar {
            margin-bottom: 18px;
          }

          .btn {
            display: inline-block;
            padding: 9px 12px;
            background: #374151;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 14px;
          }

          .card {
            background: white;
            border-radius: 12px;
            padding: 18px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
            margin-bottom: 18px;
          }

          .message {
            max-width: 75%;
            padding: 12px 14px;
            border-radius: 12px;
            margin-bottom: 12px;
            line-height: 1.45;
          }

          .message.user {
            background: #dcfce7;
            margin-left: auto;
          }

          .message.assistant {
            background: #e5e7eb;
            margin-right: auto;
          }

          .role {
            font-size: 12px;
            font-weight: bold;
            color: #374151;
            margin-bottom: 5px;
          }

          .content {
            font-size: 15px;
            white-space: normal;
          }

          .empty {
            color: #6b7280;
            font-style: italic;
          }
        </style>
      </head>

      <body>
        <header>
          <h1>Conversa do Lead</h1>
          <p>${escapeHtml(lead?.nome || "-")} — ${escapeHtml(user)}</p>
        </header>

        <div class="container">
          <div class="topbar">
            <a class="btn" href="/dashboard${senhaQuery}">← Voltar ao Dashboard</a>
          </div>

          <div class="card">
            <strong>Status:</strong> ${escapeHtml(lead?.status || "-")}<br>
            <strong>CPF:</strong> ${escapeHtml(lead?.cpf || "-")}<br>
            <strong>Telefone:</strong> ${escapeHtml(lead?.telefone || lead?.telefoneWhatsApp || user || "-")}<br>
            <strong>Cidade/Estado:</strong> ${escapeHtml(lead?.cidade || "-")}/${escapeHtml(lead?.estado || "-")}
          </div>

          <div class="card">
            ${rows || `<p class="empty">Nenhuma mensagem encontrada para este lead.</p>`}
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Erro ao carregar conversa:", error);
    res.status(500).send("Erro ao carregar conversa.");
  }
});


   app.get("/dashboard", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    await connectMongo();

        const statusFilter = req.query.status || "";
    const statusOperacionalFilter = req.query.statusOperacional || "";
    const faseFunilFilter = req.query.faseFunil || "";
    const temperaturaComercialFilter = req.query.temperaturaComercial || "";
    const rotaComercialFilter = req.query.rotaComercial || "";

    const search = req.query.q || "";
    const sort = req.query.sort || "updatedAt";
    const dir = req.query.dir === "asc" ? 1 : -1;

   const queryConditions = [];

if (statusFilter) {
  queryConditions.push({
    $or: [
      { statusDashboard: statusFilter },
      { statusVisualDashboard: statusFilter },
      {
        status: statusFilter,
        statusDashboard: { $exists: false },
        statusVisualDashboard: { $exists: false }
      }
    ]
  });
}

if (statusOperacionalFilter) {
  queryConditions.push({
    statusOperacional: statusOperacionalFilter
  });
}

if (faseFunilFilter) {
  queryConditions.push({
    faseFunil: faseFunilFilter
  });
}

if (temperaturaComercialFilter) {
  queryConditions.push({
    temperaturaComercial: temperaturaComercialFilter
  });
}

if (rotaComercialFilter) {
  queryConditions.push({
    rotaComercial: rotaComercialFilter
  });
}

if (search) {
  queryConditions.push({
    $or: [
      { user: { $regex: search, $options: "i" } },
      { telefoneWhatsApp: { $regex: search, $options: "i" } },
      { nome: { $regex: search, $options: "i" } },
      { cidadeEstado: { $regex: search, $options: "i" } },
      { ultimaMensagem: { $regex: search, $options: "i" } }
    ]
  });
}

const query =
  queryConditions.length > 0
    ? { $and: queryConditions }
    : {};
    const sortMap = {
  status: "statusDashboard",
  nome: "nome",
  telefone: "telefoneWhatsApp",
  cidade: "cidadeEstado",
  updatedAt: "updatedAt"
};

    const sortField = sortMap[sort] || "updatedAt";

    const leads = await db
      .collection("leads")
      .find(query)
      .sort({ [sortField]: dir })
      .limit(300)
      .toArray();

    const allLeads = await db.collection("leads").find({}).toArray();

const getVisualStatus = lead =>
  lead.statusDashboard ||
  lead.statusVisualDashboard ||
  lead.status ||
  "novo";

const countByStatus = status =>
  allLeads.filter(lead => getVisualStatus(lead) === status).length;

const total = allLeads.length;
const inicio = countByStatus("inicio");
const novo = countByStatus("novo");
const morno = countByStatus("morno");
const qualificando = countByStatus("qualificando");
const preAnalise = countByStatus("pre_analise");
const quente = countByStatus("quente");
const atendimento = countByStatus("em_atendimento");
const fechado = countByStatus("fechado");
const perdido = countByStatus("perdido");

    const senhaParam = req.query.senha ? `&senha=${encodeURIComponent(req.query.senha)}` : "";
    const senhaQuery = req.query.senha ? `?senha=${encodeURIComponent(req.query.senha)}` : "";

       const makeSortLink = (field, label) => {
      const nextDir = sort === field && req.query.dir !== "asc" ? "asc" : "desc";

      const filtrosNovos =
        `${statusFilter ? `&status=${encodeURIComponent(statusFilter)}` : ""}` +
        `${statusOperacionalFilter ? `&statusOperacional=${encodeURIComponent(statusOperacionalFilter)}` : ""}` +
        `${faseFunilFilter ? `&faseFunil=${encodeURIComponent(faseFunilFilter)}` : ""}` +
        `${temperaturaComercialFilter ? `&temperaturaComercial=${encodeURIComponent(temperaturaComercialFilter)}` : ""}` +
        `${rotaComercialFilter ? `&rotaComercial=${encodeURIComponent(rotaComercialFilter)}` : ""}` +
        `${search ? `&q=${encodeURIComponent(search)}` : ""}` +
        `${senhaParam}`;

      return `/dashboard?sort=${field}&dir=${nextDir}${filtrosNovos}`;
    };

    const rows = leads.map(lead => {
      const phone = lead.telefoneWhatsApp || lead.user || "";
      const waLink = phone ? `https://wa.me/${phone}` : "#";
      const { cidade, estado } = splitCidadeEstado(lead.cidadeEstado);

               const status = lead.statusDashboard || lead.statusVisualDashboard || lead.status || "novo";
const statusIa = lead.status || "novo";
const faseAntiga = lead.faseQualificacao || "-";
const statusOperacional = lead.statusOperacional || "-";
const faseFunil = lead.faseFunil || "-";
const temperaturaComercial = lead.temperaturaComercial || "-";
const rotaComercial = lead.rotaComercial || lead.origemConversao || "-";
            const supervisor = lead.supervisor || {};
      const supervisorRisco = supervisor.riscoPerda || "nao_analisado";
      const supervisorTrava = supervisor.pontoTrava || "-";
      const supervisorHumano = supervisor.necessitaHumano === true ? "sim" : "não";
      const supervisorQualidade = supervisor.qualidadeConducaoSdr || "nao_analisado";
      const supervisorUltimaAnalise = supervisor.analisadoEm
        ? formatDate(supervisor.analisadoEm)
        : "-";

            const classificacao = lead.classificacao || {};
      const classificacaoPerfil = classificacao.perfilComportamentalPrincipal || "nao_analisado";
      const classificacaoIntencao = classificacao.intencaoPrincipal || "nao_analisado";
      const classificacaoObjecao = classificacao.objecaoPrincipal || "sem_objecao_detectada";
      const classificacaoConfianca = classificacao.confiancaClassificacao || "nao_analisado";
      const classificacaoUltima = classificacao.classificadoEm
        ? formatDate(classificacao.classificadoEm)
        : "-";

      const consultoria = lead.consultoria || {};
      const consultoriaEstrategia = consultoria.estrategiaRecomendada || "nao_analisado";
      const consultoriaProximaAcao = consultoria.proximaMelhorAcao || "-";
      const consultoriaOferta = consultoria.ofertaMaisAdequada || "nao_analisado";
      const consultoriaPrioridade = consultoria.prioridadeComercial || "nao_analisado";
      const consultoriaUltima = consultoria.consultadoEm
        ? formatDate(consultoria.consultadoEm)
        : "-";

      const user = encodeURIComponent(lead.user || phone);

      const baseStatusLink = `/lead/${user}/status`;
      return `
                       <tr>
  <td>
    <span class="badge ${status}">${escapeHtml(status)}</span>
    <div style="font-size:11px;color:#6b7280;margin-top:4px;">
      IA: ${escapeHtml(statusIa)}
    </div>
  </td>
  <td>${escapeHtml(faseAntiga)}</td>
  <td>${escapeHtml(statusOperacional)}</td>
  <td>${escapeHtml(faseFunil)}</td>
  <td>${escapeHtml(temperaturaComercial)}</td>
  <td>${escapeHtml(rotaComercial)}</td>
    <td>${escapeHtml(supervisorRisco)}</td>
  <td>${escapeHtml(supervisorTrava)}</td>
  <td>${escapeHtml(supervisorHumano)}</td>
  <td>${escapeHtml(supervisorQualidade)}</td>
  <td>${escapeHtml(supervisorUltimaAnalise)}</td>
    <td>${escapeHtml(classificacaoPerfil)}</td>
  <td>${escapeHtml(classificacaoIntencao)}</td>
  <td>${escapeHtml(classificacaoObjecao)}</td>
  <td>${escapeHtml(classificacaoConfianca)}</td>
  <td>${escapeHtml(classificacaoUltima)}</td>
  <td>${escapeHtml(consultoriaEstrategia)}</td>
  <td>${escapeHtml(consultoriaProximaAcao)}</td>
  <td>${escapeHtml(consultoriaOferta)}</td>
  <td>${escapeHtml(consultoriaPrioridade)}</td>
  <td>${escapeHtml(consultoriaUltima)}</td>
  <td>${escapeHtml(lead.origemConversao || "-")}</td>
<td>${escapeHtml(lead.nome || "-")}</td><td>${escapeHtml(phone)}</td>
<td>${escapeHtml(lead.cpf || "-")}</td>
<td>${escapeHtml(lead.cidade || cidade)}</td>
<td>${escapeHtml(lead.estado || estado)}</td>
<td>${formatDate(lead.updatedAt)}</td>
<td class="actions">
            <a class="btn whatsapp" href="${waLink}" target="_blank">WhatsApp</a>
<a class="btn" href="/conversation/${user}${senhaQuery}">Mensagens</a>
<a class="btn" href="${baseStatusLink}/em_atendimento${senhaQuery}">Atender</a>
            <a class="btn success" href="${baseStatusLink}/fechado${senhaQuery}">Fechar</a>
            <a class="btn danger" href="${baseStatusLink}/perdido${senhaQuery}">Perder</a>
          </td>
        </tr>
      `;
    }).join("");

    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <title>CRM IQG</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />

        <style>
          * { box-sizing: border-box; }

          body {
            margin: 0;
            font-family: Arial, sans-serif;
            background: #f3f4f6;
            color: #111827;
          }

          header {
            background: #111827;
            color: white;
            padding: 22px 30px;
          }

          header h1 {
            margin: 0;
            font-size: 26px;
          }

          header p {
            margin: 6px 0 0;
            color: #d1d5db;
          }

          .container {
            padding: 24px;
          }

          .cards {
            display: grid;
            grid-template-columns: repeat(8, minmax(120px, 1fr));
            gap: 12px;
            margin-bottom: 22px;
          }

          .card {
            background: white;
            border-radius: 12px;
            padding: 16px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
          }

          .card small {
            color: #6b7280;
            display: block;
            margin-bottom: 8px;
          }

          .card strong {
            font-size: 24px;
          }

          .toolbar {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-bottom: 18px;
            background: white;
            padding: 16px;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
          }

          input, select, button {
            padding: 10px 12px;
            border: 1px solid #d1d5db;
            border-radius: 8px;
            font-size: 14px;
          }

          button {
            background: #111827;
            color: white;
            cursor: pointer;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
          }

          th, td {
            padding: 13px;
            border-bottom: 1px solid #e5e7eb;
            text-align: left;
            vertical-align: top;
            font-size: 14px;
          }

          th {
            background: #111827;
            color: white;
            white-space: nowrap;
          }

          th a {
            color: white;
            text-decoration: none;
          }

          tr:hover {
            background: #f9fafb;
          }

          .msg {
            max-width: 320px;
          }

          .badge {
            padding: 6px 10px;
            border-radius: 999px;
            font-weight: bold;
            font-size: 12px;
            display: inline-block;
            white-space: nowrap;
          }

          .novo { background: #e5e7eb; color: #374151; }
          .morno { background: #fef3c7; color: #92400e; }
          .qualificando { background: #dbeafe; color: #1d4ed8; }
          .pre_analise { background: #ede9fe; color: #6d28d9; }
          .quente { background: #dcfce7; color: #166534; }
          .em_atendimento { background: #ffedd5; color: #c2410c; }
          .fechado { background: #bbf7d0; color: #14532d; }
          .perdido { background: #fee2e2; color: #991b1b; }
          .dados_parciais { background: #fef3c7; color: #92400e; }
.aguardando_confirmacao_dados { background: #ffedd5; color: #c2410c; }
.dados_confirmados { background: #dcfce7; color: #166534; }
.erro_dados { background: #fee2e2; color: #991b1b; }
.erro_envio_crm { background: #fee2e2; color: #991b1b; }
.aguardando_confirmacao_campo { background: #e0f2fe; color: #075985; }
.corrigir_dado { background: #fef3c7; color: #92400e; }
.qualificado { background: #dcfce7; color: #166534; }

          .actions {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
          }

          .btn {
            display: inline-block;
            padding: 7px 9px;
            border-radius: 7px;
            background: #374151;
            color: white;
            text-decoration: none;
            font-size: 12px;
          }

          .btn.whatsapp { background: #16a34a; }
          .btn.success { background: #15803d; }
          .btn.danger { background: #dc2626; }

          .print-info {
            font-size: 12px;
            color: #6b7280;
            margin-bottom: 12px;
          }

          @media print {
            .toolbar, .actions, button {
              display: none !important;
            }

            body {
              background: white;
            }

            header {
              background: white;
              color: black;
              padding: 0 0 20px;
            }

            table {
              box-shadow: none;
            }
          }

          @media (max-width: 900px) {
            .cards {
              grid-template-columns: repeat(2, 1fr);
            }

            table {
              font-size: 12px;
            }

            th, td {
              padding: 8px;
            }
          }
        </style>

        <script>
          setInterval(() => {
            window.location.reload();
          }, 5000);

          function printCRM() {
            window.print();
          }
        </script>
      </head>

      <body>
        <header>
          <h1>CRM IQG — Leads</h1>
          <p>Atualização automática a cada 5 segundos</p>
        </header>

        <div class="container">

          <div class="cards">
          <div class="card"><small>Início</small><strong>${inicio}</strong></div>
            <div class="card"><small>Total</small><strong>${total}</strong></div>
            <div class="card"><small>Novo</small><strong>${novo}</strong></div>
            <div class="card"><small>Morno</small><strong>${morno}</strong></div>
            <div class="card"><small>Qualificando</small><strong>${qualificando}</strong></div>
            <div class="card"><small>Pré-análise</small><strong>${preAnalise}</strong></div>
            <div class="card"><small>Quente</small><strong>${quente}</strong></div>
            <div class="card"><small>Atendimento</small><strong>${atendimento}</strong></div>
            <div class="card"><small>Fechado</small><strong>${fechado}</strong></div>
          </div>

          <form class="toolbar" method="GET" action="/dashboard">
            ${req.query.senha ? `<input type="hidden" name="senha" value="${escapeHtml(req.query.senha)}" />` : ""}

            <input
              type="text"
              name="q"
              placeholder="Buscar por nome, telefone, cidade ou mensagem"
              value="${escapeHtml(search)}"
              style="min-width: 320px;"
            />

            <select name="status">
              <option value="">Todos os status</option>
              <option value="novo" ${statusFilter === "novo" ? "selected" : ""}>Novo</option>
              <option value="morno" ${statusFilter === "morno" ? "selected" : ""}>Morno</option>
             <option value="qualificando" ${statusFilter === "qualificando" ? "selected" : ""}>Qualificando</option>
<option value="afiliado" ${statusFilter === "afiliado" ? "selected" : ""}>Afiliado</option>
<option value="pre_analise" ${statusFilter === "pre_analise" ? "selected" : ""}>Pré-análise</option>
              <option value="quente" ${statusFilter === "quente" ? "selected" : ""}>Quente</option>
              <option value="em_atendimento" ${statusFilter === "em_atendimento" ? "selected" : ""}>Em atendimento</option>
              <option value="fechado" ${statusFilter === "fechado" ? "selected" : ""}>Fechado</option>
              <option value="perdido" ${statusFilter === "perdido" ? "selected" : ""}>Perdido</option>
              <option value="dados_parciais" ${statusFilter === "dados_parciais" ? "selected" : ""}>Dados parciais</option>
<option value="aguardando_confirmacao_dados" ${statusFilter === "aguardando_confirmacao_dados" ? "selected" : ""}>Aguardando confirmação</option>
<option value="dados_confirmados" ${statusFilter === "dados_confirmados" ? "selected" : ""}>Dados confirmados</option>
<option value="erro_dados" ${statusFilter === "erro_dados" ? "selected" : ""}>Erro nos dados</option>
<option value="erro_envio_crm" ${statusFilter === "erro_envio_crm" ? "selected" : ""}>Erro envio CRM</option>
<option value="aguardando_confirmacao_campo" ${statusFilter === "aguardando_confirmacao_campo" ? "selected" : ""}>Aguardando confirmação de campo</option>
<option value="corrigir_dado" ${statusFilter === "corrigir_dado" ? "selected" : ""}>Corrigir dado</option>
<option value="qualificado" ${statusFilter === "qualificado" ? "selected" : ""}>Qualificado</option>
            </select>

            <select name="statusOperacional">
              <option value="">Operacional: todos</option>
              <option value="ativo" ${statusOperacionalFilter === "ativo" ? "selected" : ""}>Ativo</option>
              <option value="em_atendimento" ${statusOperacionalFilter === "em_atendimento" ? "selected" : ""}>Em atendimento</option>
              <option value="enviado_crm" ${statusOperacionalFilter === "enviado_crm" ? "selected" : ""}>Enviado CRM</option>
              <option value="fechado" ${statusOperacionalFilter === "fechado" ? "selected" : ""}>Fechado</option>
              <option value="perdido" ${statusOperacionalFilter === "perdido" ? "selected" : ""}>Perdido</option>
              <option value="erro_dados" ${statusOperacionalFilter === "erro_dados" ? "selected" : ""}>Erro dados</option>
              <option value="erro_envio_crm" ${statusOperacionalFilter === "erro_envio_crm" ? "selected" : ""}>Erro envio CRM</option>
            </select>

            <select name="faseFunil">
              <option value="">Funil: todos</option>
              <option value="inicio" ${faseFunilFilter === "inicio" ? "selected" : ""}>Início</option>
              <option value="esclarecimento" ${faseFunilFilter === "esclarecimento" ? "selected" : ""}>Esclarecimento</option>
              <option value="beneficios" ${faseFunilFilter === "beneficios" ? "selected" : ""}>Benefícios</option>
              <option value="estoque" ${faseFunilFilter === "estoque" ? "selected" : ""}>Estoque</option>
              <option value="responsabilidades" ${faseFunilFilter === "responsabilidades" ? "selected" : ""}>Responsabilidades</option>
              <option value="investimento" ${faseFunilFilter === "investimento" ? "selected" : ""}>Investimento</option>
              <option value="compromisso" ${faseFunilFilter === "compromisso" ? "selected" : ""}>Compromisso</option>
              <option value="coleta_dados" ${faseFunilFilter === "coleta_dados" ? "selected" : ""}>Coleta de dados</option>
              <option value="confirmacao_dados" ${faseFunilFilter === "confirmacao_dados" ? "selected" : ""}>Confirmação de dados</option>
              <option value="pre_analise" ${faseFunilFilter === "pre_analise" ? "selected" : ""}>Pré-análise</option>
              <option value="crm" ${faseFunilFilter === "crm" ? "selected" : ""}>CRM</option>
              <option value="encerrado" ${faseFunilFilter === "encerrado" ? "selected" : ""}>Encerrado</option>
              <option value="afiliado" ${faseFunilFilter === "afiliado" ? "selected" : ""}>Afiliado</option>
            </select>

            <select name="temperaturaComercial">
              <option value="">Temperatura: todas</option>
              <option value="indefinida" ${temperaturaComercialFilter === "indefinida" ? "selected" : ""}>Indefinida</option>
              <option value="frio" ${temperaturaComercialFilter === "frio" ? "selected" : ""}>Frio</option>
              <option value="morno" ${temperaturaComercialFilter === "morno" ? "selected" : ""}>Morno</option>
              <option value="quente" ${temperaturaComercialFilter === "quente" ? "selected" : ""}>Quente</option>
            </select>

            <select name="rotaComercial">
              <option value="">Rota: todas</option>
              <option value="homologado" ${rotaComercialFilter === "homologado" ? "selected" : ""}>Homologado</option>
              <option value="afiliado" ${rotaComercialFilter === "afiliado" ? "selected" : ""}>Afiliado</option>
              <option value="ambos" ${rotaComercialFilter === "ambos" ? "selected" : ""}>Ambos</option>
              <option value="indefinida" ${rotaComercialFilter === "indefinida" ? "selected" : ""}>Indefinida</option>
            </select>

            <button type="submit">Filtrar</button>
            <button type="button" onclick="printCRM()">Imprimir</button>
          </form>

          <div class="print-info">
            Exibindo ${leads.length} lead(s). Clique nos títulos das colunas para ordenar.
          </div>

          <table>
            <thead>
                                          <tr>
               <th><a href="${makeSortLink("status", "Status")}">Status antigo</a></th>
<th>Fase antiga</th>
<th>Operacional</th>
<th>Funil</th>
<th>Temperatura</th>
<th>Rota</th>
<th>Risco</th>
<th>Ponto de trava</th>
<th>Humano?</th>
<th>Qualidade SDR</th>
<th>Última análise</th>
<th>Perfil</th>
<th>Intenção</th>
<th>Objeção</th>
<th>Confiança</th>
<th>Classificado em</th>
<th>Estratégia</th>
<th>Próxima ação</th>
<th>Oferta ideal</th>
<th>Prioridade</th>
<th>Consultado em</th>
<th>Origem</th>
<th><a href="${makeSortLink("nome", "Nome")}">Nome</a></th>
<th><a href="${makeSortLink("telefone", "Telefone")}">Telefone</a></th>
<th>CPF</th>
<th><a href="${makeSortLink("cidade", "Cidade")}">Cidade</a></th>
<th>Estado</th>
<th><a href="${makeSortLink("updatedAt", "Atualizado")}">Atualizado</a></th>
<th>Ação</th>
              </tr>
            </thead>
            <tbody>
                        ${rows || `<tr><td colspan="29">Nenhum lead encontrado.</td></tr>`}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Erro no dashboard:", error);
    res.status(500).send("Erro ao carregar dashboard.");
  }
});
   
const PORT = process.env.PORT || 3000;

ensureIndexes()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Erro ao iniciar servidor:", error);
    process.exit(1);
  });
