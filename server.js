import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import crypto from "crypto";

dotenv.config();

const app = express();

app.use(express.json());

/* =========================
   PWA DASHBOARD IQG
   Permite instalar o dashboard como app/atalho no celular.
========================= */

const DASHBOARD_APP_NAME = "CRM IQG";
const DASHBOARD_APP_SHORT_NAME = "CRM IQG";

function getDashboardPasswordFromRequest(req) {
  return String(
    req.query?.senha ||
    process.env.DASHBOARD_PASSWORD ||
    "iqg123"
  ).trim();
}

app.get("/iqg-icon.svg", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0ea5e9"/>
      <stop offset="52%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#0f172a" flood-opacity="0.28"/>
    </filter>
  </defs>

  <rect width="512" height="512" rx="116" fill="#f8fafc"/>
  <circle cx="256" cy="256" r="196" fill="url(#bg)" filter="url(#shadow)"/>
  <text x="256" y="250" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="104" font-weight="900" fill="#ffffff" letter-spacing="-6">
    IQG
  </text>
  <text x="256" y="310" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700" fill="#dbeafe" letter-spacing="3">
    CRM
  </text>
</svg>`);
});

app.get("/manifest.webmanifest", (req, res) => {
  const senha = encodeURIComponent(getDashboardPasswordFromRequest(req));

  const manifest = {
    name: DASHBOARD_APP_NAME,
    short_name: DASHBOARD_APP_SHORT_NAME,
    description: "Dashboard CRM IQG para acompanhamento de leads, funil, KPIs e Multi C-Level GPT.",
    start_url: `/dashboard?senha=${senha}`,
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f6f8fb",
    theme_color: "#0f172a",
    icons: [
      {
        src: "/iqg-icon.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any maskable"
      }
    ],
    shortcuts: [
      {
        name: "Abrir Dashboard",
        short_name: "Dashboard",
        description: "Abrir o CRM IQG",
        url: `/dashboard?senha=${senha}`,
        icons: [
          {
            src: "/iqg-icon.svg",
            sizes: "512x512",
            type: "image/svg+xml"
          }
        ]
      }
    ]
  };

  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(JSON.stringify(manifest, null, 2));
});

app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  res.send(`
const CACHE_NAME = "iqg-dashboard-pwa-v1";
const STATIC_ASSETS = [
  "/iqg-icon.svg"
];

self.addEventListener("install", event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(() => null)
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const requestUrl = new URL(event.request.url);

  // Não cachear dashboard, leads, rotas POST, APIs ou dados sensíveis.
  if (
    event.request.method !== "GET" ||
    requestUrl.pathname.startsWith("/dashboard") ||
    requestUrl.pathname.startsWith("/lead/") ||
    requestUrl.pathname.startsWith("/conversation/") ||
    requestUrl.pathname.startsWith("/webhook")
  ) {
    return;
  }

  if (requestUrl.pathname === "/iqg-icon.svg") {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request);
      })
    );
  }
});
`);
});

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

   await db.collection("file_send_logs").createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 7 * 24 * 60 * 60 }
  );

  await db.collection("crm_send_logs").createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60 }
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

const MAX_CONVERSATION_MESSAGES_DASHBOARD = 1000;

function normalizeConversationMessageForStorage(message = {}) {
  return {
    role: message.role || "system",
    content: String(message.content || ""),
    createdAt: message.createdAt || message.timestamp || message.date || new Date(),
    origem: message.origem || "",
    followupStep: message.followupStep || null
  };
}

function normalizeConversationMessagesForStorage(messages = []) {
  const safeMessages = Array.isArray(messages)
    ? messages
        .filter(message => message && String(message.content || "").trim())
        .map(normalizeConversationMessageForStorage)
    : [];

  /*
    Mantém até 1000 mensagens por lead.
    Isso evita perder histórico rapidamente, mas também evita um documento infinito no Mongo.
  */
  return safeMessages.slice(-MAX_CONVERSATION_MESSAGES_DASHBOARD);
}

async function saveConversation(user, messages) {
  await connectMongo();

  const safeMessages = normalizeConversationMessagesForStorage(messages);

  await db.collection("conversations").updateOne(
    { user },
    {
      $set: {
        user,
        messages: safeMessages,
        totalMessages: safeMessages.length,
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

function maskPhone(value = "") {
  const digits = onlyDigits(value);

  if (!digits) return "";

  if (digits.length <= 4) {
    return "****";
  }

  return `${digits.slice(0, 4)}*****${digits.slice(-2)}`;
}

function maskCPF(value = "") {
  const digits = onlyDigits(value);

  if (!digits) return "";

  if (digits.length !== 11) {
    return "***.***.***-**";
  }

  return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
}

function buildLeadAuditSnapshot(lead = {}) {
  return {
    user: maskPhone(lead.user || ""),
    status: lead.status || "",
    faseQualificacao: lead.faseQualificacao || "",
    statusOperacional: lead.statusOperacional || "",
    faseFunil: lead.faseFunil || "",
    temperaturaComercial: lead.temperaturaComercial || "",
    rotaComercial: lead.rotaComercial || "",
    origemConversao: lead.origemConversao || "",

    interesseReal: lead.interesseReal === true,
    interesseAfiliado: lead.interesseAfiliado === true,
    sinalAfiliadoExplicito: lead.sinalAfiliadoExplicito === true,
    sinalComparacaoProgramas: lead.sinalComparacaoProgramas === true,

    taxaAlinhada: lead.taxaAlinhada === true,
    taxaModoConversao: lead.taxaModoConversao === true,
    taxaObjectionCount: Number(lead.taxaObjectionCount || 0),

    aguardandoConfirmacaoCampo: lead.aguardandoConfirmacaoCampo === true,
    aguardandoConfirmacao: lead.aguardandoConfirmacao === true,
    campoEsperado: lead.campoEsperado || "",
    campoPendente: lead.campoPendente || "",

    dadosConfirmadosPeloLead: lead.dadosConfirmadosPeloLead === true,
    crmEnviado: lead.crmEnviado === true,

    nome: lead.nome ? "[PREENCHIDO]" : "",
    cpf: lead.cpf ? maskCPF(lead.cpf) : "",
    telefone: lead.telefone ? maskPhone(lead.telefone) : "",
    cidade: lead.cidade || "",
    estado: lead.estado || "",

    etapas: lead.etapas || {},
    etapasAguardandoEntendimento: lead.etapasAguardandoEntendimento || {},

        ultimaMensagem: lead.ultimaMensagem || "",
    ultimaDecisaoBackend: lead.ultimaDecisaoBackend || null,
    ultimaDecisaoBackendLimpaEm: lead.ultimaDecisaoBackendLimpaEm || null,
    ultimaDecisaoBackendLimpaMotivo: lead.ultimaDecisaoBackendLimpaMotivo || "",

    supervisorResumo: lead.supervisor
      ? {
          riscoPerda: lead.supervisor.riscoPerda || "",
          pontoTrava: lead.supervisor.pontoTrava || "",
          necessitaHumano: lead.supervisor.necessitaHumano === true,
          prioridadeHumana: lead.supervisor.prioridadeHumana || "",
          errosDetectados: lead.supervisor.errosDetectados || []
        }
      : null,

    classificacaoResumo: lead.classificacao
      ? {
          temperaturaComercial: lead.classificacao.temperaturaComercial || "",
          perfilComportamentalPrincipal: lead.classificacao.perfilComportamentalPrincipal || "",
          intencaoPrincipal: lead.classificacao.intencaoPrincipal || "",
          objecaoPrincipal: lead.classificacao.objecaoPrincipal || "",
          confiancaClassificacao: lead.classificacao.confiancaClassificacao || ""
        }
      : null,

    consultoriaResumo: lead.consultoria
      ? {
          estrategiaRecomendada: lead.consultoria.estrategiaRecomendada || "",
          ofertaMaisAdequada: lead.consultoria.ofertaMaisAdequada || "",
          momentoIdealHumano: lead.consultoria.momentoIdealHumano || "",
          prioridadeComercial: lead.consultoria.prioridadeComercial || ""
        }
      : null
  };
}

function isStaleBackendDecisionForCurrentLead({
  lead = {},
  text = ""
} = {}) {
  /*
    ETAPA 11 PRODUÇÃO — decisão antiga não pode contaminar etapa atual.

    Explicação simples:
    ultimaDecisaoBackend é como um bilhete antigo na mesa.

    Se o bilhete dizia:
    "corrigir telefone"

    Mas agora o lead já está informando cidade,
    esse bilhete antigo precisa sair da mesa.

    Isso não muda regra comercial.
    Só evita que os agentes e logs olhem para uma decisão vencida.
  */

  const decision = lead?.ultimaDecisaoBackend || null;

  if (!decision || typeof decision !== "object") {
    return false;
  }

  const tipo = decision.tipo || "";
  const detalhes = decision.detalhes || {};
  const faseFunilAtual = lead?.faseFunil || "";
  const faseAtual = lead?.faseQualificacao || lead?.status || "";
  const campoEsperadoAtual = lead?.campoEsperado || "";
  const campoPendenteAtual = lead?.campoPendente || "";

  const textoAtual = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const mensagemDaDecisao = String(decision.mensagemLead || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const campoEsperadoDecisao =
    detalhes.campoEsperado ||
    detalhes.campoPendente ||
    "";

  const faseFunilDecisao = detalhes.faseFunil || "";
  const faseAtualDecisao = detalhes.faseAtual || "";

  const textoMudou =
    textoAtual &&
    mensagemDaDecisao &&
    textoAtual !== mensagemDaDecisao;

  /*
    Caso 1:
    Decisão antiga era sobre campo de coleta,
    mas o campo atual mudou.

    Exemplo real que vimos:
    decisão antiga: telefone incorreto
    etapa atual: cidade
  */
  const decisaoDeCampoColeta =
    [
      "pergunta_durante_coleta",
      "confirmacao_campo",
      "confirmacao_negativa",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final"
    ].includes(tipo) ||
    Boolean(campoEsperadoDecisao);

  const campoMudou =
    campoEsperadoDecisao &&
    campoEsperadoAtual &&
    campoEsperadoDecisao !== campoEsperadoAtual;

  if (decisaoDeCampoColeta && campoMudou) {
    return true;
  }

  /*
    Caso 2:
    Decisão antiga era de coleta,
    mas o lead não está mais na mesma fase de coleta.
  */
  const faseFunilMudou =
    faseFunilDecisao &&
    faseFunilAtual &&
    faseFunilDecisao !== faseFunilAtual;

  const faseAtualMudou =
    faseAtualDecisao &&
    faseAtual &&
    faseAtualDecisao !== faseAtual;

  if (decisaoDeCampoColeta && (faseFunilMudou || faseAtualMudou) && textoMudou) {
    return true;
  }

  /*
    Caso 3:
    Decisão antiga era objeção de taxa/pergunta de investimento,
    mas agora o lead já está em coleta, confirmação, CRM ou Afiliado.
  */
  const decisaoComercialPreColeta =
  [
    "sinal_pergunta_taxa",
    "objecao_taxa",
    "interesse_forte_bloqueado",
    "corrigir_conducao_sdr",
    "continuidade_semantica",
    "oferecer_afiliado_como_alternativa"
  ].includes(tipo);

const leadVoltouParaHomologado =
  lead?.rotaComercial === "homologado" &&
  /\b(homologado|parceiro homologado|quero seguir|quero ser parceiro|como faremos|como faço|pre cadastro|pré cadastro|cadastro)\b/i.test(textoAtual);

if (tipo === "oferecer_afiliado_como_alternativa" && leadVoltouParaHomologado) {
  return true;
}

  const leadJaPassouDaParteComercial =
    [
      "coleta_dados",
      "confirmacao_dados",
      "pre_analise",
      "crm",
      "afiliado"
    ].includes(faseFunilAtual) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "dados_confirmados",
      "enviado_crm",
      "afiliado"
    ].includes(faseAtual);

  if (decisaoComercialPreColeta && leadJaPassouDaParteComercial && textoMudou) {
    return true;
  }

  /*
    Caso 4:
    Decisão pós-CRM só é válida se o lead realmente continua pós-CRM.
  */
  if (
    tipo === "lead_pos_crm" &&
    lead?.crmEnviado !== true &&
    lead?.statusOperacional !== "enviado_crm" &&
    faseFunilAtual !== "crm"
  ) {
    return true;
  }

  return false;
}

async function cleanupStaleOperationalMemory({
  user,
  lead = {},
  text = ""
} = {}) {
  /*
    ETAPA 11 PRODUÇÃO — limpeza leve no Mongo.

    Se a ultimaDecisaoBackend estiver velha,
    limpamos somente ela e registramos log técnico.

    Não limpamos dados do lead.
    Não limpamos CPF.
    Não limpamos telefone.
    Não limpamos cidade/UF.
    Não limpamos CRM.
  */

  if (!user || !lead) {
    return lead;
  }

  if (!isStaleBackendDecisionForCurrentLead({ lead, text })) {
    return lead;
  }

  await saveLeadProfile(user, {
    ultimaDecisaoBackend: null,
    ultimaDecisaoBackendLimpaEm: new Date(),
    ultimaDecisaoBackendLimpaMotivo:
      "decisao_operacional_antiga_nao_compativel_com_estado_atual",
    ultimaMensagem: text || lead?.ultimaMensagem || ""
  });

  const cleanedLead = await loadLeadProfile(user);

  console.log("🧹 Memória operacional antiga limpa:", {
    user,
    tipoDecisaoAntiga: lead?.ultimaDecisaoBackend?.tipo || "",
    faseFunilAtual: lead?.faseFunil || "",
    faseQualificacaoAtual: lead?.faseQualificacao || "",
    campoEsperadoAtual: lead?.campoEsperado || "",
    mensagemAtual: text
  });

  auditLog("Memoria operacional antiga limpa", {
    user: maskPhone(user),
    motivo: "ultimaDecisaoBackend antiga removida",
    decisaoAntiga: lead?.ultimaDecisaoBackend || null,
    leadDepois: buildLeadAuditSnapshot(cleanedLead || {})
  });

  return cleanedLead || lead;
}

/* =========================
    DIVERGENCE LOG — observabilidade IA vs travas
    Loga quando uma trava determinística sobrescreve a saída da IA.
    Sai o "bug invisível": agora dá pra ver no Render qual enforce
    mudou o quê, em qual lead, em qual turno.
========================= */
function logAiVsEnforceDivergence({
  agente = "",
  user = "",
  ultimaMensagemLead = "",
  iaDisse = null,
  sistemaUsou = null,
  camposObservados = []
} = {}) {
  if (!iaDisse || !sistemaUsou) return;
  const divergencias = [];
  for (const campo of camposObservados) {
    const valorIa = iaDisse?.[campo];
    const valorSistema = sistemaUsou?.[campo];
    const iaStr = JSON.stringify(valorIa);
    const sistemaStr = JSON.stringify(valorSistema);
    if (iaStr !== sistemaStr) {
      divergencias.push({
        campo,
        iaDisse: valorIa,
        sistemaUsou: valorSistema
      });
    }
  }
  if (divergencias.length === 0) return;
  console.log(`🔬 DIVERGÊNCIA IA vs TRAVA [${agente}]:`, {
    user: maskPhone(user || ""),
    ultimaMensagemLead: String(ultimaMensagemLead || "").slice(0, 120),
    totalDivergencias: divergencias.length,
    divergencias
  });
}

function auditLog(title, payload = {}) {
  if (!DEBUG_AUDIT) return;

  try {
    console.log(`🔎 AUDIT — ${title}:`, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.log(`🔎 AUDIT — ${title}:`, payload);
  }
}

/* =========================
   SISTEMA CENTRAL DE AUDITORIA — IQG
   Grava eventos estruturados no MongoDB para análise posterior.
   Não impacta o atendimento. Tudo é assíncrono.
========================= */

const APP_VERSION = process.env.APP_VERSION || "iqg-sdr-v1.0.0";

const AUDIT_COMPONENTS = {
  WEBHOOK: "webhook",
  GPT_SDR: "gpt_sdr",
  GPT_PRE_SDR: "gpt_pre_sdr_consultant",
  GPT_POS_SDR: "gpt_pos_sdr_consultant",
  GPT_SUPERVISOR: "gpt_supervisor",
  GPT_CLASSIFIER: "gpt_classifier",
  GPT_SEMANTIC_INTENT: "gpt_semantic_intent",
  GPT_SEMANTIC_CONTINUITY: "gpt_semantic_continuity",
  GPT_DATA_FLOW_ROUTER: "gpt_data_flow_router",
  GPT_ROUTE_MIX_GUARD: "gpt_route_mix_guard",
  GPT_REGENERATE_SDR: "gpt_regenerate_sdr",
  GPT_HUMAN_BRIEFING: "gpt_human_briefing",
  GPT_CLEVEL: "gpt_clevel",
  BACKEND_ORCHESTRATOR: "backend_orchestrator",
  TURN_POLICY: "turn_policy",
  COMMERCIAL_ROUTE: "commercial_route",
  DATA_COLLECTION: "data_collection",
  CRM_INTEGRATION: "crm_integration",
  FILE_DELIVERY: "file_delivery",
  WHATSAPP_INTEGRATION: "whatsapp_integration",
  HARD_LIMIT_ENFORCER: "hard_limit_enforcer",
  FOLLOWUP_SCHEDULER: "followup_scheduler"
};

const AUDIT_EVENT_TYPES = {
  REQUEST_RECEIVED: "request_received",
  REQUEST_COMPLETED: "request_completed",
  REQUEST_FAILED: "request_failed",
  GPT_CALL_STARTED: "gpt_call_started",
  GPT_CALL_SUCCESS: "gpt_call_success",
  GPT_CALL_ERROR: "gpt_call_error",
  DECISION_MADE: "decision_made",
  HARD_LIMIT_TRIGGERED: "hard_limit_triggered",
  GUARDRAIL_TRIGGERED: "guardrail_triggered",
  LEAD_STATE_CHANGED: "lead_state_changed",
  DATA_EXTRACTED: "data_extracted",
  CRM_SENT: "crm_sent",
  CRM_FAILED: "crm_failed",
  FILE_SENT: "file_sent",
  FILE_FAILED: "file_failed",
  ALERT_TRIGGERED: "alert_triggered"
};

function generateTraceId() {
  return crypto.randomUUID();
}

function generateEventId() {
  return crypto.randomUUID();
}

function sanitizeAuditPayload(payload = {}) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  try {
    const cloned = JSON.parse(JSON.stringify(payload));

    function walk(obj) {
      if (!obj || typeof obj !== "object") return;

      for (const key of Object.keys(obj)) {
        const value = obj[key];
        const lowerKey = String(key).toLowerCase();

        if (lowerKey === "cpf" && typeof value === "string") {
          obj[key] = maskCPF(value);
        } else if (
          (lowerKey === "telefone" ||
           lowerKey === "telefonewhatsapp" ||
           lowerKey === "user" ||
           lowerKey === "phone") &&
          typeof value === "string"
        ) {
          obj[key] = maskPhone(value);
        } else if (
          lowerKey.includes("password") ||
          lowerKey.includes("token") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("api_key") ||
          lowerKey.includes("secret")
        ) {
          obj[key] = "[REDACTED]";
        } else if (typeof value === "object") {
          walk(value);
        }
      }
    }

    walk(cloned);
    return cloned;
  } catch (error) {
    return { sanitize_error: error.message };
  }
}

function estimateTokens(text = "") {
  const t = String(text || "");
  if (!t) return 0;
  return Math.ceil(t.length / 4);
}

async function recordAuditEvent({
  traceId = null,
  component = "unknown",
  eventType = "unknown",
  payload = {},
  requiredLevel = "STANDARD",
  parentEventId = null,
  userPhone = "",
  severity = "low"
} = {}) {
  if (!shouldAuditAtLevel(requiredLevel)) {
    return null;
  }

  try {
    await connectMongo();

    const event = {
      _id: generateEventId(),
      traceId: traceId || generateTraceId(),
      parentEventId: parentEventId || null,
      timestamp: new Date(),
      component,
      eventType,
      severity,
      auditLevel: getCurrentAuditLevel(),
      appVersion: APP_VERSION,
      userMasked: userPhone ? maskPhone(userPhone) : "",
      payload: sanitizeAuditPayload(payload),
      createdAt: new Date()
    };

    db.collection("audit_events")
      .insertOne(event)
      .catch(error => {
        console.error("⚠️ Falha ao gravar evento de auditoria (não-crítico):", error.message);
      });

    if (shouldAuditAtLevel("DEEP")) {
      try {
        console.log(
          `📊 [${component}/${eventType}] trace=${event.traceId.slice(0, 8)}`,
          JSON.stringify(event.payload).slice(0, 500)
        );
      } catch (e) {
        // Ignora falha de log
      }
    }

    return event._id;
  } catch (error) {
    console.error("⚠️ Erro no recordAuditEvent (não-crítico):", error.message);
    return null;
  }
}

async function recordRequestCompleted({
  traceId = null,
  userPhone = "",
  mensagemLead = "",
  respostaFinal = "",
  currentLead = {},
  actions = [],
  sdrReviewFindings = [],
  turnPolicy = {},
  extras = {}
} = {}) {
  try {
    await recordAuditEvent({
      traceId,
      component: AUDIT_COMPONENTS.BACKEND_ORCHESTRATOR,
      eventType: AUDIT_EVENT_TYPES.REQUEST_COMPLETED,
      payload: {
        respostaFinalSdr: String(respostaFinal || "").slice(0, 1500),
        actions: Array.isArray(actions) ? actions : [],
        sdrReviewFindingsCount: Array.isArray(sdrReviewFindings) ? sdrReviewFindings.length : 0,
        sdrReviewFindings: Array.isArray(sdrReviewFindings)
          ? sdrReviewFindings.slice(0, 5).map(f => ({
              tipo: f.tipo,
              prioridade: f.prioridade
            }))
          : [],
        estadoLead: {
          status: currentLead?.status || "-",
          faseQualificacao: currentLead?.faseQualificacao || "-",
          faseFunil: currentLead?.faseFunil || "-",
          temperaturaComercial: currentLead?.temperaturaComercial || "-",
          rotaComercial: currentLead?.rotaComercial || "-",
          interesseReal: currentLead?.interesseReal === true,
          taxaAlinhada: currentLead?.taxaAlinhada === true,
          taxaObjectionCount: Number(currentLead?.taxaObjectionCount || 0),
          etapas: currentLead?.etapas || {},
          nome: currentLead?.nome ? "[PREENCHIDO]" : "",
          cpf: currentLead?.cpf ? "[PREENCHIDO]" : "",
          telefone: currentLead?.telefone ? "[PREENCHIDO]" : "",
          cidade: currentLead?.cidade || "",
          estado: currentLead?.estado || ""
        },
        turnPolicy: turnPolicy ? {
          modo: turnPolicy.modo || "-",
          ofertaPermitida: turnPolicy.ofertaPermitida || "-",
          podeFalarTaxa: turnPolicy.podeFalarTaxa === true,
          podePedirDados: turnPolicy.podePedirDados === true,
          podeFalarAfiliado: turnPolicy.podeFalarAfiliado === true
        } : null,
        ...extras
      },
      requiredLevel: "STANDARD",
      userPhone,
      severity: (Array.isArray(sdrReviewFindings) && sdrReviewFindings.length > 0) ? "medium" : "low"
    });
  } catch (error) {
    console.error("⚠️ Falha ao gravar request_completed (não-crítico):", error.message);
  }
}

async function recordAuditError({
  traceId = null,
  component = "unknown",
  eventType = "request_failed",
  error = null,
  payload = {},
  userPhone = ""
} = {}) {
  if (!isAuditEnabled()) {
    return null;
  }

  const errorPayload = {
    ...payload,
    error: {
      message: error?.message || String(error),
      stack: error?.stack ? String(error.stack).slice(0, 2000) : "",
      name: error?.name || "Error"
    }
  };

  return recordAuditEvent({
    traceId,
    component,
    eventType,
    payload: errorPayload,
    requiredLevel: "BASIC",
    severity: "high",
    userPhone
  });
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
  // Explicação simples:
  // A rota mais recente e explícita deve mandar mais que sinais antigos.
  //
  // Exemplo real:
  // Se antes apareceu Afiliado, mas depois o lead disse "quero Homologado",
  // rotaComercial = "homologado" precisa ser respeitada.
  //
  // Isso não é trava nova.
  // É só organização da prioridade da rota para o Mongo não contaminar os GPTs.
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

  /*
    Prioridade correta:

    1. Se rotaComercial veio explicitamente como "homologado", respeitar Homologado.
       Isso evita que interesseAfiliado antigo puxe o lead de volta para Afiliado.

    2. Se rotaComercial veio explicitamente como "afiliado", respeitar Afiliado.

    3. Se rotaComercial veio explicitamente como "ambos", respeitar Ambos.

    4. Só usar origemConversao/interesseAfiliado se não houver rota explícita atual.
  */
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

/* =========================
   CONFIG
========================= */
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iqg_token_123";
const CONSULTANT_PHONE = process.env.CONSULTANT_PHONE;

// 🔎 SISTEMA DE AUDITORIA IQG — CONTROLE LIGA/DESLIGA COM NÍVEIS
//
// Para controlar pelo Render, crie a variável de ambiente AUDIT_LEVEL
// com um destes valores:
//
// OFF       → auditoria desligada (zero custo, zero log extra)
// BASIC     → só eventos críticos e erros
// STANDARD  → eventos + decisões dos GPTs (recomendado para produção)
// DEEP      → tudo: prompts, respostas, tokens, latências, contexto
// FORENSIC  → DEEP + snapshots de estado a cada passo (use só para investigar)
//
// Compatibilidade: se você não criar AUDIT_LEVEL no Render mas tiver
// DEBUG_AUDIT=true, o sistema entra automaticamente em modo STANDARD.

const AUDIT_LEVELS = {
  OFF: 0,
  BASIC: 1,
  STANDARD: 2,
  DEEP: 3,
  FORENSIC: 4
};

function getCurrentAuditLevel() {
  // Lê dinamicamente a cada chamada, permitindo mudar no Render sem redeploy
  // (basta restart do serviço).
  const rawLevel = String(process.env.AUDIT_LEVEL || "").toUpperCase().trim();

  if (rawLevel && AUDIT_LEVELS[rawLevel] !== undefined) {
    return rawLevel;
  }

  // Compatibilidade com o sistema antigo:
  const legacyDebugAudit = String(process.env.DEBUG_AUDIT || "false").toLowerCase() === "true";

  if (legacyDebugAudit) {
    return "STANDARD";
  }

  return "OFF";
}

function isAuditEnabled() {
  return getCurrentAuditLevel() !== "OFF";
}

function shouldAuditAtLevel(requiredLevel) {
  const currentLevel = getCurrentAuditLevel();
  const currentValue = AUDIT_LEVELS[currentLevel] || 0;
  const requiredValue = AUDIT_LEVELS[requiredLevel] || 0;

  return currentValue >= requiredValue;
}

// Mantém a constante antiga para compatibilidade com o código já existente.
// O auditLog antigo continuará funcionando até a Etapa 4.
const DEBUG_AUDIT = isAuditEnabled();

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
      inactivityFollowupCount: 0,

      // Controle de segurança dos follow-ups.
      // Cada vez que o lead manda mensagem ou a conversa muda,
      // essa versão sobe. Timer antigo com versão velha não envia nada.
      followupVersion: 0,
      followupScheduledAtMs: 0
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

  /*
    Controle de versão dos follow-ups.

    Explicação simples:
    Toda vez que limpamos os timers, aumentamos uma "senha".
    Se um timer antigo acordar depois, ele vai ver que a senha mudou
    e NÃO vai mandar mensagem fora de contexto.
  */
  state.followupVersion = Number(state.followupVersion || 0) + 1;
  state.followupScheduledAtMs = 0;

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

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL SOBRE RENDA EXTRA
━━━━━━━━━━━━━━━━━━━━━━━

"Renda extra" NÃO significa Afiliado automaticamente.

Quando o lead disser algo como:
- "quero renda extra";
- "quero ganhar dinheiro";
- "quero uma oportunidade";
- "quero vender";
- "tenho clientes";
- "consigo vender";
- "quero trabalhar com vocês";

interprete como interesse comercial genérico.

Não oriente a SDR a mandar link de Afiliado.
Não oriente a SDR a focar em Afiliado.
Não trate automaticamente como Programa de Afiliados.

A orientação correta é descobrir ou respeitar o caminho comercial do lead.

Se o lead ainda não escolheu um programa:
- orientar uma explicação curta e neutra dos caminhos;
- não empurrar Afiliado;
- não empurrar Homologado;
- ajudar o lead a entender qual caminho combina melhor.

Se o lead demonstrar sinais de produto físico, clientes, revenda, pronta-entrega, estoque, comodato ou parceiro homologado:
- orientar foco no Programa Parceiro Homologado.

Se o lead demonstrar sinais de link, divulgação online, redes sociais, comissão por link, cadastro de afiliado ou vender sem estoque físico:
- orientar foco no Programa de Afiliados.

Exemplo errado:
Lead: "quero uma renda extra"
Orientação errada: "mandar cadastro de afiliado".

Exemplo correto:
Lead: "quero uma renda extra"
Orientação correta: "explicar que a IQG tem caminhos comerciais diferentes e entender se o lead quer atuar com produto físico/pronta-entrega ou divulgação online por link."

Exemplo correto:
Lead: "tenho bastante clientes, acho que consigo vender"
Orientação correta: "isso aponta mais para o Programa Parceiro Homologado, pois envolve venda para clientes, produto físico e atuação comercial."

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
REGRA CENTRAL SOBRE PREFERÊNCIA POR HOMOLOGADO
━━━━━━━━━━━━━━━━━━━━━━━

Quando o lead declarar preferência pelo Programa Parceiro Homologado, essa preferência deve prevalecer sobre qualquer sinal antigo de Afiliado.

Considere preferência clara por Homologado quando o lead disser algo como:
- "quero Homologado";
- "quero me homologar";
- "quero parceiro homologado";
- "programa homologado";
- "a opção do homologado";
- "apenas Homologado";
- "só Homologado";
- "não quero Afiliado";
- "já falei que é Homologado";
- "quero vender como parceiro";
- "quero trabalhar com produtos físicos";
- "tenho clientes e consigo vender";
- "quero revender";
- "quero vender para meus clientes".

Se o lead declarou preferência por Homologado, sua orientação para a SDR deve ser:

1. Reconhecer a escolha do lead.
2. Pedir desculpa brevemente se a SDR confundiu antes.
3. Focar somente no Programa Parceiro Homologado.
4. Não comparar novamente com Afiliado.
5. Não mandar link de Afiliado.
6. Não perguntar de novo qual programa o lead prefere.
7. Avançar para a próxima etapa real do Homologado.

Exemplo errado:
Lead: "quero me homologar nos parceiros homologados"
Orientação errada: "oferecer Afiliado como opção mais leve".

Exemplo correto:
Lead: "quero me homologar nos parceiros homologados"
Orientação correta: "focar no Homologado, reconhecer que ele quer esse caminho e conduzir para a próxima etapa pendente."

Se o histórico tiver sinal antigo de Afiliado, mas a mensagem mais recente do lead indicar Homologado, considere Homologado como preferência atual.

A última preferência clara do lead vale mais do que sinais antigos do funil.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL SOBRE REPETIÇÃO E HISTÓRICO
━━━━━━━━━━━━━━━━━━━━━━━

Quando o lead reclamar que a SDR está repetindo, se perdendo ou ignorando o histórico, isso NÃO é pedido para comparar programas.

Considere reclamação de repetição ou perda de contexto quando o lead disser algo como:
- "você está repetitiva";
- "você está se repetindo";
- "já falou isso";
- "já respondi";
- "já falei";
- "revisa o histórico";
- "revisita o histórico";
- "você está se perdendo";
- "você não está entendendo";
- "você não leu a conversa";
- "parece que esqueceu";
- "de novo isso?";
- "já falei que quero Homologado";
- "já falei que é apenas Homologado".

Nesses casos, sua orientação para a SDR deve ser:

1. Reconhecer a crítica de forma breve.
2. Pedir desculpa de forma simples.
3. Não repetir o resumo anterior.
4. Não explicar novamente a diferença entre Homologado e Afiliado.
5. Não oferecer Afiliado se o lead já escolheu Homologado.
6. Revisar a última preferência clara do lead.
7. Avançar para a próxima etapa real do caminho escolhido.

Exemplo errado:
Lead: "Vc está repetitiva"
Orientação errada: "explicar novamente a diferença entre Afiliado e Homologado".

Exemplo correto:
Lead: "Vc está repetitiva"
Orientação correta: "pedir desculpa brevemente, reconhecer que vai ser mais objetiva e seguir no caminho já escolhido pelo lead."

Exemplo errado:
Lead: "Já falei que apenas Homologados"
Orientação errada: "oferecer os dois programas novamente".

Exemplo correto:
Lead: "Já falei que apenas Homologados"
Orientação correta: "reconhecer a preferência por Homologado, não mencionar Afiliado e conduzir para a próxima etapa pendente do Homologado."

Modelo de orientação correta para a SDR:
"Reconheça a crítica rapidamente, diga que vai ser mais objetiva, confirme que seguirá apenas pelo Programa Parceiro Homologado e avance para a próxima etapa pendente. Não repita a comparação com Afiliado."

A reclamação de repetição é um alerta de experiência ruim.
A melhor resposta é reduzir repetição, não aumentar explicação.

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

━━━━━━━━━━━━━━━━━━━━━━━
HISTORIADOR SEMÂNTICO DE CONTINUIDADE
━━━━━━━━━━━━━━━━━━━━━━━

Você pode receber em orientacoesEstrategicasBackend um item do tipo:
"continuidade_semantica_historico".

Esse item deve ter prioridade alta.

Se ele indicar que:
- leadCriticouRepeticao = true;
- naoRepetirUltimoTema = true;
- leadQuerAvancar = true;
- leadEntendeuUltimaExplicacao = true;

então você deve orientar a SDR a NÃO repetir o tema anterior.

Se o lead criticou repetição:
- reconhecer brevemente;
- pedir desculpa ou ajustar a condução;
- não repetir taxa;
- não repetir responsabilidades;
- não repetir benefícios;
- não repetir estoque;
- conduzir para o próximo passo pendente.

Se o lead demonstrou entendimento e avanço:
- não repetir a explicação anterior;
- avançar se o backend permitir;
- se ainda faltar etapa obrigatória, validar apenas a menor pendência com uma pergunta curta.

O histórico real e a última mensagem do lead têm prioridade sobre status antigo.

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
- use como referência de condução, mas não trave automaticamente a pré-análise.
- se investimento/taxa já foi explicado e o lead sinalizou continuidade sem objeção nova, orientar avanço para pré-cadastro/coleta se o backend permitir.
- não exigir aceite formal em cada etapa.
- não mandar a SDR repetir benefício, estoque, responsabilidades ou taxa apenas porque a etapa ainda aparece pendente.

4. Se memoriaConversacional.pendencias.emColetaOuConfirmacao for true:
- não orientar rota comercial, Afiliados, taxa ou cadastro;
- orientar resposta curta e retomada do dado pendente.

5. Se memoriaConversacional.ultimaInteracao.leadFezPerguntaOuObjecao for true:
- identificar o tema da pergunta/objeção;
- orientar a SDR a responder esse tema primeiro;
- não permitir que a SDR apenas avance fase;
- não permitir que a SDR ignore a dúvida para seguir roteiro;
- não orientar coleta de dados na mesma resposta se a dúvida ainda for sobre produto, catálogo, kit, estoque, reposição, taxa, contrato, pagamento ou funcionamento do programa.

Regra importante:
Quando a última mensagem do lead é pergunta comercial aberta, a próxima melhor ação NÃO deve ser "conduzir para coleta".
A próxima melhor ação deve ser:
1. responder a pergunta;
2. se fizer sentido, perguntar se ficou claro ou se pode explicar o próximo ponto;
3. só avançar para coleta em mensagem posterior, quando o lead demonstrar continuidade real e o backend permitir.

Exemplo:
Lead:
"e se eu precisar de mais produtos depois?"

Orientação correta:
"Responder sobre reposição/comodato. Não pedir dados nesta resposta. Depois perguntar se ficou claro."

Exemplo:
Lead:
"tem catálogo desses produtos?"

Orientação correta:
"Responder que há catálogo/material dos produtos e orientar envio se disponível. Não pedir CPF. Não tratar a frase como nome."

REGRA CRÍTICA — FOLDER E KIT PODEM SER ENVIADOS:

Quando o lead pedir folder, kit, material ou catálogo de forma direta:
- NÃO dizer que não pode enviar
- NÃO dizer que o material não está disponível neste momento
- Folder e kit DEVEM ser enviados quando pedidos, desde que o lead esteja no Programa Parceiro Homologado
- A SDR deve incluir [ACTION:SEND_FOLDER] para folder e catálago e [ACTION:SEND_KIT] para kit
- Dizer que "não pode enviar folder" é um erro grave de condução

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
LINHAS DE PRODUTOS IQG
━━━━━━━━━━━━━━━━━━━━━━━

A IQG possui várias linhas de produtos, não apenas piscinas.

Linhas conhecidas:
- piscinas;
- cosméticos veterinários para cães e gatos;
- shampoos e condicionadores pet;
- desinfecção para equipamentos de ordenha;
- desincrustantes e detergentes;
- pré e pós dipping;
- linha agro;
- adjuvantes agrícolas;
- oxidantes de matérias orgânicas;
- adubos foliares.

Regra para orientar a SDR:

1. Se o lead perguntar sobre outras linhas da IQG:
- responder que a IQG realmente possui outras linhas;
- não negar;
- não inventar detalhes técnicos, preços, estoque ou disponibilidade;
- explicar que o Parceiro Homologado, neste início, está focado na linha de piscinas;
- dizer que outras linhas poderão ser disponibilizadas aos parceiros com o tempo, conforme estratégia e evolução comercial.

2. Se o lead veio pelo Programa de Afiliados e perguntou sobre outras linhas:
- explicar que no Afiliados ele pode consultar os produtos disponíveis no ambiente/site da IQG;
- não prometer que todas as linhas estarão liberadas;
- não misturar com estoque em comodato ou taxa do Homologado.

3. Se o lead quer Parceiro Homologado, mas cita pet, agro, ordenha ou outras linhas:
- responder a dúvida primeiro;
- alinhar expectativa;
- conduzir de volta ao modelo inicial de piscinas se fizer sentido.

4. Não transformar pergunta sobre outra linha em rejeição do Homologado.
5. Não tratar outras linhas como sinal automático de Afiliado.
6. Não oferecer Afiliado só porque o lead citou outra linha.

━━━━━━━━━━━━━━━━━━━━━━━
TABELA DE PREÇOS / E-COMMERCE IQG
━━━━━━━━━━━━━━━━━━━━━━━

Se o lead pedir tabela de preços, lista de preços, tabela de revenda, preço para parceiro ou valores dos produtos:

- orientar a SDR a responder primeiro esse pedido;
- explicar que a tabela oficial para parceiro é enviada após a fase contratual;
- explicar que a IQG evita enviar tabela no pré-atendimento porque preços podem oscilar e há promoções frequentes;
- indicar o e-commerce oficial para consulta prévia de preços:
https://www.loja.industriaquimicagaucha.com.br/
- explicar que a IQG padroniza os preços do e-commerce com marketplaces e com a tabela do Parceiro Homologado para evitar ruídos;
- tranquilizar o lead dizendo que a IQG busca oferecer ótimas condições para que o parceiro seja competitivo comercialmente;
- não inventar preços, descontos, tabela, margem por produto ou condição especial;
- não orientar envio de catálogo/PDF como substituto de tabela de preços;
- depois de responder, conduzir para o próximo passo adequado do funil.

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

REGRA SOBRE FRETE E ENVIO — PARCEIRO HOMOLOGADO:
- O primeiro envio (kit inicial) tem frete custeado pela IQG. O parceiro não paga frete para receber o kit.
- Nas reposições posteriores, os produtos continuam sendo cedidos em comodato (sem compra), mas o frete das reposições é custeado pelo parceiro.
- Se o lead perguntar sobre frete, envio, entrega ou custo de reposição, o Pré-SDR deve orientar a SDR a explicar essa distinção com clareza.
- NÃO orientar a SDR a dizer que frete é sempre grátis.
- NÃO orientar a SDR a dizer que a IQG paga todos os fretes de reposição.
- Orientar a SDR a separar: produto = comodato (sem compra); frete da reposição = por conta do parceiro.

BENEFÍCIO DE INDICAÇÃO (RENDA VITALÍCIA) — EXCLUSIVO DO PARCEIRO HOMOLOGADO:
- O Parceiro Homologado pode indicar novos parceiros para o Programa Homologado.
- Recebe 10% de comissão vitalícia sobre tudo o que o indicado vender, enquanto o indicado estiver ativo.
- Apenas 1 nível de indicação (sem multinível, sem pirâmide).
- Condição: o parceiro indicado precisa respeitar o valor mínimo de venda sugerido pela IQG.
- Controle: relatórios semanais de liquidação enviados em PDF ao parceiro indicador.
- Em breve: acompanhamento em tempo real via aplicativo.

PERFIL QUE MAIS SE BENEFICIA:
Piscineiros e profissionais com forte rede no setor. Existem parceiros homologados
que pagam a taxa de adesão, optam por NÃO receber o lote em comodato, e faturam
exclusivamente indicando colegas para o programa. É um modelo legítimo e estratégico.
Quando o lead for piscineiro, apresentar essa possibilidade proativamente como
benefício estratégico do programa.

REGRA ANTI-MISTURA (CRÍTICA):
- Este benefício pertence APENAS ao Programa Parceiro Homologado.
- NUNCA chamar de "link de afiliado", "Programa de Afiliados" ou "indicar pelo link".
- NUNCA migrar o lead para Afiliados quando ele perguntar sobre indicação.
- Se o lead estiver na rota Afiliados e perguntar sobre essa renda, explicar
  que este benefício específico é do Programa Homologado.

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
  backendStrategicGuidance = [],
  auditTraceId = null
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

auditLog("Payload enviado ao Consultor Pre-SDR", {
  lead: buildLeadAuditSnapshot(lead || {}),
  ultimaMensagemLead: lastUserText || "",
  ultimaRespostaSdr: lastSdrText || "",
  supervisorResumo: supervisorAnalysis || {},
  classificacaoResumo: classification || {},
  semanticIntent: semanticIntent || {},
  commercialRouteDecision: commercialRouteDecision || {},
  backendStrategicGuidance: backendStrategicGuidance || [],
  memoriaConversacional: conversationMemory || {},
  historicoRecente: recentHistory || []
});
   
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
const parsedConsultantAdvice = parseConsultantAdviceJson(rawText);

await recordAuditEvent({
  traceId: auditTraceId,
  component: AUDIT_COMPONENTS.GPT_PRE_SDR,
  eventType: AUDIT_EVENT_TYPES.GPT_CALL_SUCCESS,
  payload: {
    model: process.env.OPENAI_CONSULTANT_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    ultimaMensagemLead: lastUserText || "",
    estrategiaRecomendada: parsedConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
    proximaMelhorAcao: String(parsedConsultantAdvice?.proximaMelhorAcao || "").slice(0, 200),
    ofertaMaisAdequada: parsedConsultantAdvice?.ofertaMaisAdequada || "nao_analisado",
    prioridadeComercial: parsedConsultantAdvice?.prioridadeComercial || "nao_analisado",
    momentoIdealHumano: parsedConsultantAdvice?.momentoIdealHumano || "nao_analisado",
    cuidadoPrincipal: String(parsedConsultantAdvice?.cuidadoPrincipal || "").slice(0, 200)
  },
  requiredLevel: "STANDARD",
  userPhone: lead?.user || "",
  severity: "low"
});
   
auditLog("Resposta do Consultor Pre-SDR", {
  ultimaMensagemLead: lastUserText || "",
  rawText,
  parsedConsultantAdvice
});

return parsedConsultantAdvice;
}

async function runConversationContinuityAnalyzer({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  const fallback = {
    leadEntendeuUltimaExplicacao: false,
    leadQuerAvancar: false,
    leadCriticouRepeticao: false,
    naoRepetirUltimoTema: false,
    temaUltimaRespostaSdr: [],
    temaMensagemAtualLead: [],
    proximaAcaoSemantica: "nao_analisado",
    orientacaoParaPreSdr: "",
    confidence: "baixa",
    reason: "Fallback local. Analisador de continuidade não executado ou falhou."
  };

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
        model: process.env.OPENAI_SEMANTIC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Você é o Historiador Semântico de Continuidade da IQG.

Você NÃO conversa com o lead.
Você NÃO escreve a resposta final.
Você NÃO altera status.
Você NÃO envia CRM.
Você NÃO decide sozinho a próxima etapa.

Sua função é analisar:
- a última resposta da SDR;
- a última mensagem do lead;
- o histórico recente;
- o estado atual do lead;
e dizer se a SDR deve avançar, responder dúvida, parar repetição ou retomar coleta.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — CORREÇÃO DE CONTEXTO
━━━━━━━━━━━━━━━━━━━━━━━

Se o lead disser que a SDR falou de algo que ainda não foi explicado, pulou etapa, ignorou histórico, repetiu informação ou se perdeu, isso deve ser tratado como correção de contexto/condução.

Exemplos:
- "não falamos sobre investimento ainda";
- "você ainda não explicou a taxa";
- "esse follow-up ficou fora de contexto";
- "você está pulando etapa";
- "você está se perdendo";
- "você está repetitiva";
- "já falei isso";
- "já respondi isso";
- "revisa o histórico";
- "#mensagem ao desenvolvedor: follow-up contaminado".

Nesses casos, marque:
leadCriticouRepeticao = true
naoRepetirUltimoTema = true

Se o lead apenas corrigiu a condução, mas não recusou o projeto:
leadQuerAvancar pode ser false
leadEntendeuUltimaExplicacao pode ser false
proximaAcaoSemantica = "manter_fase"

Se o histórico mostrar que o lead já validou o ponto e quer continuar:
proximaAcaoSemantica = "nao_repetir_e_avancar"

Não classifique como objeção de taxa só porque a mensagem menciona taxa, investimento, adesão, valor ou pagamento.

Exemplo:
Lead: "Não falamos sobre investimento e taxa ainda. Follow-up contaminado."

Resposta correta:
leadCriticouRepeticao = true
naoRepetirUltimoTema = true
leadQuerAvancar = false
proximaAcaoSemantica = "manter_fase"
orientacaoParaPreSdr = "A SDR deve pedir desculpa brevemente pela confusão e retomar o ponto correto do funil, sem tratar como objeção de taxa."

FOCO PRINCIPAL:
Detectar quando a SDR acabou de explicar um tema e o lead:
- demonstrou entendimento;
- quer avançar;
- demonstrou pressa comercial;
- criticou repetição;
- disse que já entendeu;
- pediu para parar de repetir;
- ou trouxe nova pergunta.

REGRAS:

1. Se a última resposta da SDR explicou taxa, investimento, responsabilidades, benefícios ou estoque, e o lead demonstrou entendimento/aceite/continuidade, marque:
leadEntendeuUltimaExplicacao = true
leadQuerAvancar = true, se houver intenção de seguir.
naoRepetirUltimoTema = true.

2. Se o lead disser que a conversa está repetitiva, que a SDR já explicou, que já entendeu, ou reclamar de repetição, marque:
leadCriticouRepeticao = true
naoRepetirUltimoTema = true.

3. Se leadCriticouRepeticao for true:
A orientação ao Pré-SDR deve ser:
- reconhecer de forma curta;
- pedir desculpa ou ajustar rota;
- NÃO repetir taxa;
- NÃO repetir responsabilidades;
- conduzir para próximo passo pendente.

4. Se o lead fez pergunta nova:
A orientação deve ser responder a pergunta nova primeiro.

5. Se o lead aceitou taxa/responsabilidades e quer avançar:
A orientação deve ser avançar para coleta se liberado pelo backend, ou validar apenas a pendência mínima restante.
Não repetir explicações longas.

6. Se houver conflito entre status antigo e histórico:
Priorize o histórico real.

7. Nunca invente que o lead entendeu se ele trouxe objeção, dúvida ou rejeição.

Responda somente JSON válido, sem markdown, neste formato:

{
  "leadEntendeuUltimaExplicacao": false,
  "leadQuerAvancar": false,
  "leadCriticouRepeticao": false,
  "naoRepetirUltimoTema": false,
  "temaUltimaRespostaSdr": [],
  "temaMensagemAtualLead": [],
  "proximaAcaoSemantica": "nao_analisado",
  "orientacaoParaPreSdr": "",
  "confidence": "baixa",
  "reason": ""
}

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — CONTINUIDADE SEM LOOP
━━━━━━━━━━━━━━━━━━━━━━━

Você é o Historiador Semântico de Continuidade.

Sua função principal é proteger a fluidez da conversa.

Você deve identificar quando o lead já respondeu positivamente a uma validação anterior, para evitar que a SDR fique presa em loop perguntando várias vezes se pode seguir.

1. Quando a SDR pergunta se pode seguir e o lead responde positivamente, considere continuidade.

Exemplos de resposta positiva do lead:
- "ok";
- "sim";
- "claro";
- "pode ser";
- "pode seguir";
- "podemos seguir";
- "vamos seguir";
- "segue";
- "pode continuar";
- "entendi";
- "faz sentido";
- "está claro";
- "show";
- "beleza";
- "tranquilo";
- "sem problema".

Essas frases não são palavras mágicas isoladas.
Você deve olhar o contexto.

Se a última resposta da SDR foi uma validação como:
- "podemos seguir?";
- "o que você acha?";
- "ficou claro?";
- "faz sentido?";
- "quer que eu avance?";
- "posso seguir?";
- "se estiver tudo claro, podemos seguir";
- "quer entender mais algum ponto ou podemos avançar?";

e o lead respondeu positivamente, então a interpretação correta é:

leadEntendeuUltimaExplicacao = true
leadQuerAvancar = true
naoRepetirUltimoTema = true
proximaAcaoSemantica = "nao_repetir_e_avancar"

A orientação para o Pré-SDR deve ser:
"O lead já autorizou continuidade. Não repetir a validação anterior. Avançar para a próxima etapa real do funil."

2. Não transforme "validar pendência mínima" em repetição infinita.

Use "nao_repetir_e_validar_pendencia_minima" somente quando existir uma pendência específica, clara e ainda não validada.

Não use "nao_repetir_e_validar_pendencia_minima" quando:
- a SDR já perguntou se podia seguir;
- o lead respondeu "ok", "pode seguir", "claro", "pode ser" ou similar;
- a conversa já teve duas ou mais validações parecidas;
- o lead demonstrou irritação com repetição;
- o lead disse que a SDR está repetitiva ou se perdendo.

Nesses casos, use "nao_repetir_e_avancar".

3. Reclamação de repetição deve virar alerta forte para o Pré-SDR.

Se o lead disser algo como:
- "você está repetitiva";
- "você está se repetindo";
- "já falou isso";
- "já respondi";
- "já falei";
- "revisa o histórico";
- "você está se perdendo";
- "de novo isso?";

então:
leadCriticouRepeticao = true
naoRepetirUltimoTema = true
proximaAcaoSemantica = "nao_repetir_e_avancar"

A orientação para o Pré-SDR deve dizer:
"O lead criticou repetição. Não repetir resumo, não comparar programas novamente e não perguntar de novo se pode seguir. Revisar a preferência mais recente do lead e avançar de forma objetiva."

4. Se o lead escolheu Homologado, não reabrir Afiliado.

Se a mensagem atual ou o histórico recente mostram:
- "quero Homologado";
- "quero me homologar";
- "parceiro homologado";
- "apenas Homologado";
- "só Homologado";
- "opção 2 é Homologado";
- "já falei que é Homologado";

então a orientação para o Pré-SDR deve reforçar:
"Manter foco apenas no Programa Parceiro Homologado. Não falar de Afiliado, não comparar programas e não mandar link de Afiliado, salvo se o lead pedir Afiliado novamente."

5. Quando houver autorização para avançar, indique a próxima ação como avanço real.

Se o lead autorizou seguir e não trouxe pergunta nova nem objeção, a orientação deve ser:
- não repetir a explicação anterior;
- não pedir confirmação novamente;
- avançar para a próxima etapa pendente;
- manter resposta curta e objetiva.

Exemplo errado de orientação:
"Validar novamente se ficou claro."

Exemplo correto de orientação:
"O lead já validou continuidade. Avançar para a próxima etapa pendente do Homologado sem repetir o resumo anterior."

6. Se houver pergunta nova, responda a pergunta antes de avançar.

Se a mensagem atual do lead for uma pergunta sobre produto, catálogo, kit, estoque, reposição, taxa, contrato ou funcionamento:
- não marque isso como simples autorização para avançar;
- oriente responder a pergunta primeiro;
- depois perguntar de forma curta se ficou claro.

Mas se a mensagem atual for apenas "ok", "claro", "pode seguir" ou equivalente depois de uma validação da SDR, isso é continuidade, não pergunta nova.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — RENDA EXTRA E PREFERÊNCIA DECLARADA
━━━━━━━━━━━━━━━━━━━━━━━

Você deve ajudar o Pré-SDR a entender a preferência comercial mais recente do lead.

1. "Renda extra" é interesse comercial genérico.

Quando o lead disser algo como:
- "quero renda extra";
- "quero ganhar dinheiro";
- "quero uma oportunidade";
- "quero vender";
- "tenho clientes";
- "consigo vender";
- "quero trabalhar com vocês";

não assuma automaticamente Programa de Afiliados.

A interpretação correta é:
"O lead demonstrou interesse comercial, mas ainda não escolheu obrigatoriamente Afiliado."

A orientação para o Pré-SDR deve ser:
"Não tratar renda extra como Afiliado automático. Entender se o lead quer atuar com produto físico/pronta-entrega/clientes locais ou divulgação online por link."

2. Sinais que apontam para Homologado.

Se o lead disser ou demonstrar:
- "homologado";
- "parceiro homologado";
- "quero me homologar";
- "programa homologado";
- "opção 2";
- "a opção 2 é o programa homologado";
- "apenas Homologado";
- "só Homologado";
- "quero revender";
- "tenho clientes";
- "consigo vender para meus clientes";
- "kit inicial";
- "produtos físicos";
- "estoque";
- "comodato";
- "pronta-entrega";
- "demonstração";

então a preferência atual deve ser entendida como Homologado.

A orientação para o Pré-SDR deve ser:
"Manter foco no Programa Parceiro Homologado. Não comparar com Afiliado e não mandar link de Afiliado, salvo se o lead pedir Afiliado novamente."

3. Sinais que apontam para Afiliado.

Só considere preferência atual por Afiliado se o lead mencionar claramente:
- "afiliado";
- "programa de afiliados";
- "link";
- "link de afiliado";
- "divulgar online";
- "redes sociais";
- "comissão por link";
- "cadastro de afiliado";
- "sem estoque físico";
- "sem taxa";
- "vender pela internet".

Se esses sinais não estiverem claros, não empurre Afiliado.

4. Preferência atual vale mais que sinal antigo.

Se antes apareceu Afiliado, mas depois o lead disse:
- "quero Homologado";
- "quero me homologar";
- "apenas Homologado";
- "não quero Afiliado";
- "já falei que é Homologado";
- "a opção 2 é Homologado";

então a orientação correta é:
"Preferência atual do lead: Homologado. Desconsiderar sinal antigo de Afiliado para esta resposta."

5. Se o lead corrigiu a rota, não discutir.

Se o lead corrigir a SDR dizendo:
- "eu falei 2";
- "a opção 2 é Homologado";
- "já falei que apenas Homologados";
- "não é Afiliado";

então:
leadCriticouRepeticao pode ser true se houver tom de irritação ou correção forte.
naoRepetirUltimoTema deve ser true.
proximaAcaoSemantica deve ser "nao_repetir_e_avancar" ou "responder_pergunta_atual", conforme a mensagem.

A orientação para o Pré-SDR deve ser:
"Reconhecer a correção, pedir desculpa brevemente se necessário, focar apenas em Homologado e avançar para a próxima etapa real. Não explicar Afiliado."

6. Quando a preferência for Homologado, a orientação não deve sugerir comparação.

Mesmo que o histórico tenha citado Afiliado, se a preferência mais recente é Homologado, não orientar:
- comparar programas;
- explicar diferenças;
- mandar link de Afiliado;
- perguntar qual programa prefere.

Oriente apenas:
- continuar Homologado;
- responder dúvida atual;
- avançar para próxima etapa pendente;
- evitar repetição.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — PREFERÊNCIA COMERCIAL NÃO É COLETA
━━━━━━━━━━━━━━━━━━━━━━━

Nunca use "retomar_coleta" quando o objetivo for apenas entender a preferência comercial do lead.

Existe uma diferença muito importante:

1. Coleta de dados:
É quando o lead já está na fase de pré-cadastro/coleta e a SDR está pedindo ou confirmando:
- nome completo;
- CPF;
- telefone;
- cidade;
- estado;
- correção de dados;
- confirmação de dados.

Nesses casos, "retomar_coleta" pode fazer sentido.

2. Descoberta de preferência comercial:
É quando o lead ainda está entendendo se quer:
- Programa Parceiro Homologado;
- Programa de Afiliados;
- os dois;
- renda extra;
- produto físico;
- divulgação online;
- venda com clientes próprios;
- venda por link.

Nesses casos, NUNCA use "retomar_coleta".

Se o lead disser algo como:
- "quero renda extra";
- "estou procurando uma renda extra";
- "quero ganhar dinheiro";
- "quero uma oportunidade";
- "quero vender";
- "tenho clientes";
- "consigo vender";
- "quero trabalhar com vocês";

e ainda não houver coleta ativa de dados, a interpretação correta é:

leadEntendeuUltimaExplicacao = false
leadQuerAvancar = false
leadCriticouRepeticao = false
naoRepetirUltimoTema = false
proximaAcaoSemantica = "manter_fase"

A orientação para o Pré-SDR deve ser:
"O lead demonstrou interesse comercial genérico. Não tratar como coleta de dados. Não pedir CPF, nome completo, telefone, cidade ou estado. Orientar a SDR a explicar de forma curta os caminhos comerciais ou perguntar se o lead prefere atuar com produto físico/pronta-entrega ou divulgação online."

Exemplo errado:
Lead: "bom dia, estou procurando uma renda extra"
proximaAcaoSemantica errada: "retomar_coleta"

Exemplo correto:
Lead: "bom dia, estou procurando uma renda extra"
proximaAcaoSemantica correta: "manter_fase"
orientacaoParaPreSdr correta: "Explicar de forma curta os caminhos comerciais e entender a preferência do lead, sem pedir dados."

Exemplo errado:
Lead: "tenho clientes e acho que consigo vender"
proximaAcaoSemantica errada: "retomar_coleta"

Exemplo correto:
Lead: "tenho clientes e acho que consigo vender"
proximaAcaoSemantica correta: "manter_fase" ou "nao_repetir_e_avancar", conforme o histórico
orientacaoParaPreSdr correta: "Isso aponta para potencial comercial, especialmente Homologado se o contexto for produto físico/clientes. Não tratar como coleta de dados."

Regra importante:
"Coletar preferência comercial" não é "coleta de dados".
A palavra "coleta" no sistema deve ser reservada para dados cadastrais ou confirmação/correção de dados.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — ENCERRAMENTO DO HOMOLOGADO E SAÍDA PARA AFILIADO
━━━━━━━━━━━━━━━━━━━━━━━

Você deve reconhecer quando o lead não quer continuar no Programa Parceiro Homologado ou não vai finalizar o pré-cadastro.

Regra comercial obrigatória da IQG:

Se o lead NÃO finalizou o pré-cadastro do Programa Parceiro Homologado, ele deve receber a alternativa do Programa de Afiliados.

A lógica correta é:
- se finalizou o pré-cadastro do Homologado: seguir fluxo de consultor/CRM;
- se não finalizou o pré-cadastro e não quer seguir no Homologado: orientar Afiliado;
- não marcar simplesmente como perdido sem apresentar Afiliado;
- não insistir no Homologado quando o lead já desistiu;
- não encerrar seco sem deixar a alternativa de Afiliado.

Considere que o lead não quer continuar no Homologado quando disser algo como:
- "não quero nada";
- "não quero mais";
- "não quero continuar";
- "deixamos quieto";
- "deixa quieto";
- "deixa pra lá";
- "deixa para lá";
- "tchau";
- "obrigado, tchau";
- "pode encerrar";
- "encerra";
- "não tenho interesse";
- "não é pra mim";
- "vou deixar";
- "não vou seguir";
- "não quero esse programa";
- "paremos por aqui";
- "desisti";
- "vou desistir".

Quando houver esse tipo de encerramento antes do pré-cadastro finalizado, a interpretação correta é:

leadQuerAvancar = false
leadEntendeuUltimaExplicacao = false
naoRepetirUltimoTema = true
proximaAcaoSemantica = "manter_fase"

A orientação para o Pré-SDR deve ser:
"O lead não quer continuar no Homologado ou não vai finalizar o pré-cadastro. Não insistir no Homologado. Oferecer o Programa de Afiliados como alternativa obrigatória, de forma curta, respeitosa e sem pressão."

Não oriente:
- insistir no Homologado;
- pedir dados;
- perguntar novamente se pode seguir;
- tentar convencer;
- repetir benefícios;
- repetir taxa;
- repetir responsabilidades;
- comparar longamente os programas;
- acionar humano automaticamente só porque desistiu.

Oriente:
- reconhecer a decisão do lead;
- encerrar a pressão sobre o Homologado;
- apresentar Afiliado como alternativa mais simples;
- enviar o link/caminho do Afiliado se essa for a saída indicada;
- deixar claro que ele pode retomar no futuro se quiser.

Exemplo errado:
Lead: "não quero nada, tchau"
Orientação errada: "encerrar sem oferecer nada."

Exemplo errado:
Lead: "deixamos quieto"
Orientação errada: "insistir no Homologado ou perguntar se quer seguir."

Exemplo correto:
Lead: "não quero nada, tchau"
Orientação correta: "respeitar a decisão sobre o Homologado e oferecer o Programa de Afiliados como alternativa simples, sem pressão."

Modelo de orientação correta para o Pré-SDR:
"O lead demonstrou encerramento do caminho Homologado antes de finalizar o pré-cadastro. A SDR deve responder de forma breve e respeitosa, não insistir no Homologado e oferecer o Programa de Afiliados como alternativa obrigatória."

A resposta da SDR deve ser curta.

Exemplo de direção para a SDR:
"Entendo, Edson. Não vou insistir no Homologado. Como alternativa mais simples, você pode seguir pelo Programa de Afiliados, que não exige estoque físico nem pré-cadastro de parceiro homologado. O acesso é pelo link: https://minhaiqg.com.br/"

Se o lead demonstrar irritação forte, a SDR deve ser ainda mais curta e cuidadosa, mas ainda assim deve deixar a alternativa de Afiliado disponível.

A prioridade é:
1. respeitar a desistência do Homologado;
2. não gerar atrito;
3. oferecer Afiliado como caminho alternativo;
4. não manter follow-up insistente do Homologado.

Valores permitidos para proximaAcaoSemantica:
- "responder_pergunta_atual"
- "nao_repetir_e_avancar"
- "nao_repetir_e_validar_pendencia_minima"
- "tratar_objecao"
- "retomar_coleta"
- "manter_fase"
- "nao_analisado"

REGRA CRÍTICA SOBRE "retomar_coleta":

Não use "retomar_coleta" para entender preferência comercial.
Não use "retomar_coleta" para renda extra.
Não use "retomar_coleta" para escolher entre Homologado e Afiliado.
Não use "retomar_coleta" para perguntar se o lead prefere produto físico ou divulgação online.

Isso só pode acontecer quando o estado do lead indicar pelo menos um destes sinais:
- aguardandoConfirmacaoCampo = true;
- aguardandoConfirmacao = true;
- campoEsperado preenchido;
- campoPendente preenchido;
- faseFunil = "coleta_dados" ou "confirmacao_dados";
- status/faseQualificacao ligados a coleta, confirmação ou correção.

Nunca use "retomar_coleta" em:
- início;
- esclarecimento;
- benefícios;
- estoque;
- responsabilidades;
- investimento;
- compromisso;
- conversa inicial.

Se não houver coleta ativa, mas o lead demonstrou entendimento ou continuidade, use:
- "nao_repetir_e_avancar"; ou
- "nao_repetir_e_validar_pendencia_minima"; ou
- "manter_fase".

Se houver dúvida nova do lead, use:
- "responder_pergunta_atual".

Se houver objeção, use:
- "tratar_objecao".
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
                etapas: lead.etapas || {},
                etapasAguardandoEntendimento: lead.etapasAguardandoEntendimento || {},
                taxaAlinhada: lead.taxaAlinhada === true,
                aguardandoConfirmacaoCampo: lead.aguardandoConfirmacaoCampo === true,
                aguardandoConfirmacao: lead.aguardandoConfirmacao === true,
                campoEsperado: lead.campoEsperado || "",
                campoPendente: lead.campoPendente || ""
              }
            })
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro no Historiador Semântico de Continuidade:", data);
      return fallback;
    }

    const rawText = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(rawText);

    const semanticContinuityResult = {
  ...fallback,
  ...parsed,
  temaUltimaRespostaSdr: Array.isArray(parsed?.temaUltimaRespostaSdr)
    ? parsed.temaUltimaRespostaSdr
    : [],
  temaMensagemAtualLead: Array.isArray(parsed?.temaMensagemAtualLead)
    ? parsed.temaMensagemAtualLead
    : [],
  confidence: parsed?.confidence || "baixa",
  reason: parsed?.reason || ""
};

     await recordAuditEvent({
  traceId: null,
  component: AUDIT_COMPONENTS.GPT_SEMANTIC_CONTINUITY,
  eventType: AUDIT_EVENT_TYPES.GPT_CALL_SUCCESS,
  payload: {
    model: process.env.OPENAI_SEMANTIC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    ultimaMensagemLead: lastUserText || "",
    leadEntendeuUltimaExplicacao: semanticContinuityResult?.leadEntendeuUltimaExplicacao === true,
    leadQuerAvancar: semanticContinuityResult?.leadQuerAvancar === true,
    leadCriticouRepeticao: semanticContinuityResult?.leadCriticouRepeticao === true,
    naoRepetirUltimoTema: semanticContinuityResult?.naoRepetirUltimoTema === true,
    proximaAcaoSemantica: semanticContinuityResult?.proximaAcaoSemantica || "nao_analisado",
    confidence: semanticContinuityResult?.confidence || "baixa",
    reason: semanticContinuityResult?.reason || ""
  },
  requiredLevel: "STANDARD",
  userPhone: lead?.user || "",
  severity: "low"
});

auditLog("Resposta do Historiador Semantico", {
  ultimaMensagemLead: lastUserText || "",
  ultimaRespostaSdr: lastSdrText || "",
  lead: buildLeadAuditSnapshot(lead || {}),
  historicoRecente: recentHistory || [],
  semanticContinuityResult
});

return semanticContinuityResult;
  } catch (error) {
    console.error("Falha no Historiador Semântico de Continuidade:", error.message);
    return fallback;
  }
}

function enforceSemanticContinuityHardLimits({
  semanticContinuity = {},
  lead = {},
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  /*
    ETAPA 5 PRODUÇÃO — trava dura do Historiador Semântico.

    Explicação simples:
    O Historiador pode entender continuidade, repetição e avanço.
    Mas ele NÃO pode mandar "retomar_coleta" se o lead ainda não está em coleta.

    Isso evita o erro:
    lead acabou de chegar ou está entendendo o programa
    ↓
    Historiador manda retomar_coleta
    ↓
    Pré-SDR/SDR ficam com orientação errada.
  */

  const safeContinuity = {
    leadEntendeuUltimaExplicacao: semanticContinuity?.leadEntendeuUltimaExplicacao === true,
    leadQuerAvancar: semanticContinuity?.leadQuerAvancar === true,
    leadCriticouRepeticao: semanticContinuity?.leadCriticouRepeticao === true,
    naoRepetirUltimoTema: semanticContinuity?.naoRepetirUltimoTema === true,
    temaUltimaRespostaSdr: Array.isArray(semanticContinuity?.temaUltimaRespostaSdr)
      ? semanticContinuity.temaUltimaRespostaSdr
      : [],
    temaMensagemAtualLead: Array.isArray(semanticContinuity?.temaMensagemAtualLead)
      ? semanticContinuity.temaMensagemAtualLead
      : [],
    proximaAcaoSemantica: semanticContinuity?.proximaAcaoSemantica || "nao_analisado",
    orientacaoParaPreSdr: semanticContinuity?.orientacaoParaPreSdr || "",
    confidence: semanticContinuity?.confidence || "baixa",
    reason: semanticContinuity?.reason || ""
  };

  const status = lead?.status || "";
  const faseQualificacao = lead?.faseQualificacao || "";
  const faseFunil = lead?.faseFunil || "";

  const coletaAtiva =
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true ||
    Boolean(lead?.campoEsperado) ||
    Boolean(lead?.campoPendente) ||
    ["coleta_dados", "confirmacao_dados"].includes(faseFunil) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final"
    ].includes(status) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final"
    ].includes(faseQualificacao);

  if (
    safeContinuity.proximaAcaoSemantica === "retomar_coleta" &&
    !coletaAtiva
  ) {
    return {
      ...safeContinuity,
      proximaAcaoSemantica:
        safeContinuity.leadQuerAvancar === true || safeContinuity.naoRepetirUltimoTema === true
          ? "nao_repetir_e_validar_pendencia_minima"
          : "manter_fase",
      orientacaoParaPreSdr:
        [
          "Correção do backend: o Historiador sugeriu retomar coleta, mas não existe coleta ativa.",
          "Não pedir dados.",
          "Não tratar a conversa como coleta.",
          safeContinuity.leadQuerAvancar === true
            ? "O lead demonstrou avanço; validar somente a menor pendência obrigatória ou avançar se o backend permitir."
            : "",
          safeContinuity.naoRepetirUltimoTema === true
            ? "Não repetir o último tema já explicado."
            : "",
          "Conduzir de forma natural conforme a fase atual do funil."
        ].filter(Boolean).join("\n"),
      reason:
        [
          safeContinuity.reason || "",
          "Trava dura: retomar_coleta bloqueado porque o lead não está em coleta/confirmação/correção."
        ].filter(Boolean).join(" ")
    };
  }

  /*
    Se a confiança veio baixa, não deixamos o Historiador forçar avanço forte.
    Ele ainda pode orientar cuidado, mas não deve empurrar a SDR.
  */
  const confidence = normalizeSemanticConfidence(safeContinuity.confidence || "");

  if (
    confidence === "baixa" &&
    safeContinuity.leadQuerAvancar === true &&
    safeContinuity.leadEntendeuUltimaExplicacao !== true
  ) {
    return {
      ...safeContinuity,
      leadQuerAvancar: false,
      proximaAcaoSemantica:
        safeContinuity.proximaAcaoSemantica === "nao_repetir_e_avancar"
          ? "manter_fase"
          : safeContinuity.proximaAcaoSemantica,
      orientacaoParaPreSdr:
        [
          safeContinuity.orientacaoParaPreSdr || "",
          "Correção do backend: confiança baixa para avanço. A SDR deve validar com pergunta curta, sem pular fase."
        ].filter(Boolean).join("\n"),
      reason:
        [
          safeContinuity.reason || "",
          "Trava dura: avanço removido por baixa confiança sem entendimento confirmado."
        ].filter(Boolean).join(" ")
    };
  }

  return safeContinuity;
}

/* =========================
   NORMALIZAÇÃO SEMÂNTICA PÓS-CLASSIFICADOR
   Corrige incoerências do GPT classificador antes de contaminar
   Política do Turno, Pré-SDR, Historiador e travas.
========================= */

function iqgNormalizeSemanticText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function iqgAddUniqueTopic(topics = [], topic = "") {
  const safeTopics = Array.isArray(topics) ? [...topics] : [];
  const cleanTopic = String(topic || "").trim();

  if (cleanTopic && !safeTopics.includes(cleanTopic)) {
    safeTopics.push(cleanTopic);
  }

  return safeTopics;
}

function iqgTextHasCommercialInterest(text = "") {
  const t = iqgNormalizeSemanticText(text);

  return Boolean(
    /\b(tenho interesse|tenho interesse no programa|quero saber mais|quero entender|quero entender melhor|me explica|me conte|como funciona|como me cadastro|como faço|como faco|quero participar|quero entrar|quero ser parceiro|programa|parceiro homologado|homologado)\b/i.test(t)
  );
}

function iqgTextMentionsHomologadoContext(text = "") {
  const t = iqgNormalizeSemanticText(text);

  return Boolean(
    /\b(programa|parceiro|homologado|parceiro homologado|estoque|comodato|lote|produto|produtos|revenda|vender produtos|pronta entrega|industria|indústria)\b/i.test(t)
  );
}

function iqgTextIsOnlyGreeting(text = "") {
  const t = iqgNormalizeSemanticText(text);

  if (!t) return false;

  const withoutGreetings = t
    .replace(/\b(oi|ola|olá|bom dia|boa tarde|boa noite|tudo bem|td bem|opa|e ai|e aí)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return withoutGreetings.length === 0;
}

function iqgTextIsStockQuestionNotObjection(text = "") {
  const t = iqgNormalizeSemanticText(text);

  const mentionsStock =
    /\b(estoque|comodato|lote|kit|produtos|produto|vem nele|o que vem|o que vem no estoque|itens|unidades)\b/i.test(t);

  const asksOrShowsDoubt =
    /\b(duvida|dúvida|duvidas|dúvidas|tenho duvida|tenho dúvida|queria entender|quero entender|como funciona|o que vem|vem nele|quais produtos|quais itens|me explica|explica)\b/i.test(t) ||
    t.includes("?");

  const refusesStock =
    /\b(nao quero estoque|não quero estoque|nao consigo cuidar|não consigo cuidar|nao quero produto fisico|não quero produto físico|nao quero produto físico|nao posso receber estoque|não posso receber estoque|estoque e problema|estoque é problema)\b/i.test(t);

  return mentionsStock && asksOrShowsDoubt && !refusesStock;
}

function iqgTextDeclaresUnderstandingOfStep(text = "", step = "") {
  const t = iqgNormalizeSemanticText(text);

  const understoodSignal =
    /\b(ja entendi|já entendi|entendi bem|entendi|ficou claro|ta claro|tá claro|compreendi|li no folder|li todo folder|li o folder|vi no folder|pelo folder|ja li|já li|ja vi|já vi|faz sentido)\b/i.test(t);

  if (!understoodSignal) return false;

  if (step === "programa") {
    return /\b(programa|homologado|parceiro homologado|modelo)\b/i.test(t);
  }

  if (step === "beneficios") {
    return /\b(beneficio|beneficios|benefício|benefícios|vantagem|vantagens|folder)\b/i.test(t);
  }

  if (step === "estoque") {
    return /\b(estoque|comodato|lote|kit|produtos|produto)\b/i.test(t);
  }

  if (step === "responsabilidades") {
    return /\b(responsabilidade|responsabilidades|minha parte|compromisso|obrigações|obrigacoes)\b/i.test(t);
  }

  if (step === "investimento") {
        /*
            Onda 2 / Bug H soft:
            Lead só "declara entendimento de investimento" se mencionar
            valor ou termo específico da taxa.
            Palavras vagas como "valor", "investimento" sozinhas não bastam
            porque o lead pode estar PERGUNTANDO, não declarando entendimento.
            Exige menção explícita ao R$ ou à taxa de adesão.
        */
        return /\b(1990|1\.990|199|5000|5\.000|r\$|taxa de adesao|taxa de adesão|adesao|adesão|10x|parcelado)\b/i.test(t);
    }

  return false;
}

function iqgGetExplicitUnderstoodFunnelStepsFromLead(text = "") {
  const understoodSteps = [];

  if (iqgTextDeclaresUnderstandingOfStep(text, "programa")) {
    understoodSteps.push("programa");
  }

  if (iqgTextDeclaresUnderstandingOfStep(text, "beneficios")) {
    understoodSteps.push("beneficios");
  }

  if (iqgTextDeclaresUnderstandingOfStep(text, "estoque")) {
    understoodSteps.push("estoque");
  }

  if (iqgTextDeclaresUnderstandingOfStep(text, "responsabilidades")) {
    understoodSteps.push("responsabilidades");
  }

  if (iqgTextDeclaresUnderstandingOfStep(text, "investimento")) {
    understoodSteps.push("investimento");
  }

  return understoodSteps;
}

function iqgNormalizeSemanticIntentAfterClassifier({
  semanticIntent = {},
  lastUserText = "",
  lastSdrText = "",
  lead = {}
} = {}) {
  const normalized = {
    ...(semanticIntent || {}),
    questionTopics: Array.isArray(semanticIntent?.questionTopics)
      ? [...semanticIntent.questionTopics]
      : [],
    otherProductLineTopics: Array.isArray(semanticIntent?.otherProductLineTopics)
      ? [...semanticIntent.otherProductLineTopics]
      : []
  };

  const text = String(lastUserText || "");
  const normalizedText = iqgNormalizeSemanticText(text);

  const onlyGreeting = iqgTextIsOnlyGreeting(text);
  const hasCommercialInterest = iqgTextHasCommercialInterest(text);
  const mentionsHomologadoContext = iqgTextMentionsHomologadoContext(text);
  const stockQuestionNotObjection = iqgTextIsStockQuestionNotObjection(text);
  const understoodSteps = iqgGetExplicitUnderstoodFunnelStepsFromLead(text);

  /*
    Caso 1:
    Se a mensagem tem saudação + interesse comercial,
    NÃO é greetingOnly.
  */
  if (normalized.greetingOnly === true && !onlyGreeting && hasCommercialInterest) {
    normalized.greetingOnly = false;
    normalized.positiveRealInterest = true;
    normalized.asksQuestion = normalized.asksQuestion === true || /\b(quero saber|quero entender|como funciona|me explica|programa)\b/i.test(normalizedText);
    normalized.questionTopics = iqgAddUniqueTopic(normalized.questionTopics, "programa");
    normalized.reason = [
      normalized.reason || "",
      "Correção backend: mensagem tinha saudação, mas também interesse comercial. Não é apenas cumprimento."
    ].filter(Boolean).join(" ");
  }

  /*
    Caso 2:
    Se o lead fala de programa/homologado/estoque/comodato/produto físico,
    manter Homologado como contexto principal.
  */
  if (mentionsHomologadoContext) {
    normalized.wantsHomologado = true;
  }

  /*
    Caso 3:
    Pergunta de estoque/comodato não é automaticamente objeção bloqueante.
    Só é objeção se houver recusa ou trava real.
  */
  if (stockQuestionNotObjection) {
    normalized.asksQuestion = true;
    normalized.questionTopics = iqgAddUniqueTopic(normalized.questionTopics, "estoque");
    normalized.wantsHomologado = true;

    const existeOutraObjecaoReal =
      normalized.priceObjection === true ||
      normalized.riskObjection === true ||
      normalized.delayOrAbandonment === true ||
      normalized.humanRequest === true;

    if (!existeOutraObjecaoReal) {
      normalized.blockingObjection = false;
      normalized.stockObjection = false;
      normalized.blockingReason = "";
      normalized.reason = [
        normalized.reason || "",
        "Correção backend: dúvida sobre estoque/comodato foi tratada como pergunta objetiva, não como objeção bloqueante."
      ].filter(Boolean).join(" ");
    }
  }

  /*
    Caso 4:
    Quando o lead declara que já entendeu uma etapa,
    guardamos isso no próprio semanticIntent para o backend consolidar depois.
  */
  if (understoodSteps.length > 0) {
    normalized.softUnderstandingOnly = true;
    normalized.understoodStepsFromLeadText = understoodSteps;
    normalized.reason = [
      normalized.reason || "",
      `Correção backend: lead declarou entendimento explícito das etapas: ${understoodSteps.join(", ")}.`
    ].filter(Boolean).join(" ");
  }

   /*
    Caso 5 — Onda 3 / Bug #1:
    Detectar priceObjection em frases INDIRETAS de desconfiança ou
    resistência financeira que o Classificador Semântico costuma
    deixar passar.

    Três grupos de gatilhos:
      (A) Desconfiança financeira ("pegadinha", "bom demais pra ser
          verdade", "como assim investimento", "tem caroço", etc.)
      (B) Caro direto ("tá caro", "salgado", "fora do orçamento", etc.)
      (C) Reclamação retroativa ("nem me falou da taxa", "não me
          avisou do investimento", etc.)

    Se qualquer gatilho disparar, forçamos priceObjection=true e
    elevamos a confiança para 'alta' nesse campo, para acionar as
    travas de objeção de taxa do backend.
  */
  const priceObjectionIndirectPatterns = [
    // (A) Desconfiança financeira / cheiro de "pegadinha"
    /\bpegadinha[s]?\b/i,
    /\bpegadinho[s]?\b/i,
    /\bcaroc[oõ][s]?\b/i,
    /\bgato\s+escondido\b/i,
    /\bcoisa\s+escondida\b/i,
    /\bbom\s+dem(ais|as)\s+(pra|para|pro)\s+ser\s+verdade\b/i,
    /\bbom\s+dem(ais|as)\s+pra\s+ser\s+real\b/i,
    /\bperfeito\s+dem(ais|as)\b/i,
    /\bfacil\s+dem(ais|as)\b/i,
    /\bf[aá]cil\s+dem(ais|as)\b/i,
    /\bsuspeito\b/i,
    /\bdesconfio\b/i,
    /\bdesconfiad[oa]\b/i,
    /\bgolpe\b/i,
    /\benganaç[aã]o\b/i,
    /\benganacao\b/i,
    /\bfurada\b/i,
    /\bcilada\b/i,
    /\bcomo\s+assim\s+(investimento|taxa|valor|pagar|pagamento|adesao|adesão|mensalidade)\b/i,
    /\bque\s+(investimento|taxa|valor|pagamento|adesao|adesão|mensalidade)\s+(é\s+ess[ea]|e\s+ess[ea])\b/i,
    /\bque\s+(investimento|taxa|valor|pagamento|adesao|adesão|mensalidade)\b\s*[\?\.!]?\s*$/i,
    /\bque\s+hist[oó]ria\s+(é|e)\s+ess[ea]\s+de\s+(investimento|taxa|valor|pagar|pagamento|adesao|adesão)\b/i,
    /\bo\s+que\s+(é|e)\s+ess[ea]\s+(investimento|taxa|valor|pagamento|adesao|adesão)\b/i,
    /\b(é|e)\s+pago\b/i,
    /\btem\s+que\s+pagar\b/i,
    /\bvou\s+ter\s+que\s+pagar\b/i,
    /\bprecisa\s+pagar\b/i,
    /\bpaga\s+alguma\s+coisa\b/i,
    /\bpaga\s+algo\b/i,
    /\btem\s+custo\b/i,
    /\btem\s+algum\s+custo\b/i,
    /\bvem\s+custo\b/i,
    /\bcobra\s+algo\b/i,
    /\bcobra\s+alguma\s+coisa\b/i,
    /\bsabia\s+que\s+tinha\b/i,
    /\beu\s+sabia\b/i,
    /\bj[aá]\s+sabia\b/i,
    /\bn[aã]o\s+(é|e)\s+de\s+gra[çc]a\b/i,
    /\bn[aã]o\s+(é|e)\s+gratis\b/i,
    /\bn[aã]o\s+(é|e)\s+gr[aá]tis\b/i,

    // (B) Caro direto
    /\bt[aá]\s+caro\b/i,
    /\best[aá]\s+caro\b/i,
    /\bmuito\s+caro\b/i,
    /\bbem\s+caro\b/i,
    /\bcaro\s+dem(ais|as)\b/i,
    /\bsalgad[oa]\b/i,
    /\bpuxad[oa]\b/i,
    /\bpesad[oa](\s+pra|\s+para|\s+pro)?\s+(meu\s+bolso|minha\s+conta|mim)\b/i,
    /\bn[aã]o\s+tenho\s+(esse|esta|essa|tudo\s+isso|tanto)\b/i,
    /\bn[aã]o\s+tenho\s+(esse|essa)\s+(grana|valor|dinheiro|quantia)\b/i,
    /\bn[aã]o\s+tenho\s+como\s+pagar\b/i,
    /\bn[aã]o\s+tenho\s+condi[çc][oõ]es\b/i,
    /\bsem\s+condi[çc][oõ]es\b/i,
    /\bfora\s+do\s+(meu\s+)?or[çc]amento\b/i,
    /\bn[aã]o\s+cabe\s+no\s+(bolso|or[çc]amento)\b/i,
    /\bn[aã]o\s+entra\s+no\s+(bolso|or[çc]amento)\b/i,
    /\bapertad[oa](\s+de\s+grana|\s+financeiramente)?\b/i,
    /\bsem\s+grana\b/i,
    /\bsem\s+dinheiro\b/i,
    /\bestou\s+sem\s+(grana|dinheiro|condi[çc][oõ]es)\b/i,
    /\bt[oô]\s+sem\s+(grana|dinheiro|condi[çc][oõ]es)\b/i,
    /\bduro\b/i,
    /\bquebrad[oa]\b/i,
    /\bmes\s+(t[aá]|est[aá])\s+(dificil|díficil|complicad[oa]|apertad[oa])\b/i,
    /\bm[eê]s\s+apertad[oa]\b/i,
    /\bn[aã]o\s+da\s+(pra|para|pro)\s+pagar\b/i,
    /\bn[aã]o\s+d[aá]\s+(pra|para|pro)\s+pagar\b/i,
    /\bn[aã]o\s+tenho\s+esse\s+(dinheiro|valor)\s+(sobrando|agora)\b/i,
    /\bdinheiro\s+(curto|contado|apertado)\b/i,
    /\bor[çc]amento\s+(curto|apertado|baixo)\b/i,

    // (C) Reclamação retroativa
    /\b(nem|n[aã]o)\s+me\s+(falou|disse|avisou|informou|contou|comentou|explicou|mencionou)\s+(de|da|do|sobre)\s+(investimento|taxa|valor|pagamento|adesao|adesão|custo|mensalidade|pre[çc]o)\b/i,
    /\b(nem|n[aã]o)\s+(falou|disse|avisou|informou|contou|comentou|explicou|mencionou)\s+(de|da|do|sobre)\s+(investimento|taxa|valor|pagamento|adesao|adesão|custo|mensalidade|pre[çc]o)\b/i,
    /\bn[aã]o\s+sabia\s+que\s+(tinha|era|precisava|teria|ia\s+ter)\s+(taxa|investimento|pagamento|custo|valor)\b/i,
    /\bn[aã]o\s+(falaram|disseram|avisaram|comentaram)\s+(de|da|do|sobre)\s+(taxa|investimento|pagamento|custo|valor)\b/i,
    /\bn[aã]o\s+foi\s+(falado|dito|avisado|mencionado|comentado)\s+(de|da|do|sobre|nada\s+de)\s+(taxa|investimento|pagamento|custo|valor)\b/i,
    /\bpensei\s+que\s+(era|fosse)\s+(gratis|gr[aá]tis|de\s+gra[çc]a|sem\s+custo)\b/i,
    /\bachei\s+que\s+(era|fosse)\s+(gratis|gr[aá]tis|de\s+gra[çc]a|sem\s+custo)\b/i
  ];

  const detectedIndirectPriceObjection = priceObjectionIndirectPatterns.some(
    (rx) => rx.test(text)
  );

  if (detectedIndirectPriceObjection && normalized.priceObjection !== true) {
    normalized.priceObjection = true;
    normalized.confidence = "alta";
    normalized.reason = [
      normalized.reason || "",
      "Correção backend (Caso 5): detectada objeção de preço/taxa em frase indireta (desconfiança financeira, 'caro' direto ou reclamação retroativa). priceObjection forçado para true."
    ].filter(Boolean).join(" ");
  }

  /*
    Segurança:
    Se por algum motivo tudo ficou vazio, preserva fallback.
  */
  normalized.confidence = normalized.confidence || "baixa";

  return normalized;
}

/* =========================
   REGRA COMERCIAL — INDICAÇÃO NO PARCEIRO HOMOLOGADO
   Benefício oficial do Programa Parceiro Homologado IQG.
   Não confundir com Programa de Afiliados.
========================= */

function iqgNormalizeIndicationText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function iqgLeadMentionsIndicationNetwork(text = "") {
  const t = iqgNormalizeIndicationText(text);

  return Boolean(
    /\b(indicacao|indicacoes|indicar|indico|indiquei|indicando|indicado|indicados|ganhar por indicacao|ganhar indicando|comissao por indicacao|comissao vitalicia|renda vitalicia|indicar parceiros|indicar outros parceiros|trazer parceiros|trazer outros parceiros|rede de parceiros|colegas piscineiros|outros piscineiros)\b/i.test(t)
  );
}

function iqgLeadLooksLikePiscineiro(text = "", lead = {}) {
  const t = iqgNormalizeIndicationText(
    [
      text,
      lead?.profissao,
      lead?.segmento,
      lead?.ramo,
      lead?.atividade,
      lead?.observacoes,
      lead?.historicoResumo
    ].filter(Boolean).join(" ")
  );

  return Boolean(
    /\b(piscineiro|piscineira|limpeza de piscina|manutencao de piscina|manutenção de piscina|trabalho com piscina|trabalho com piscinas|atendo piscina|atendo piscinas|cliente de piscina|clientes de piscina|tratamento de piscina|piscinas)\b/i.test(t)
  );
}

function buildHomologadoIndicationBenefitGuidance({
  lead = {},
  text = "",
  forceMentionForPiscineiro = false
} = {}) {
  const leadIsPiscineiro = iqgLeadLooksLikePiscineiro(text, lead);
  const leadMentionsIndication = iqgLeadMentionsIndicationNetwork(text);

  const shouldGuide =
    leadMentionsIndication ||
    (forceMentionForPiscineiro && leadIsPiscineiro);

  if (!shouldGuide) {
    return null;
  }

  return {
    tipo: "beneficio_indicacao_parceiro_homologado",
    prioridade: leadIsPiscineiro ? "alta" : "media",
    motivo: leadIsPiscineiro
      ? "Lead parece ser piscineiro ou atuar com piscinas; a possibilidade de faturar indicando outros parceiros pode ser muito relevante."
      : "Lead mencionou indicação, rede, comissão por indicação ou interesse em indicar outros parceiros.",
    orientacaoParaPreSdr:
      [
        "REGRA COMERCIAL OFICIAL — BENEFÍCIO DE INDICAÇÃO DO PARCEIRO HOMOLOGADO IQG.",
        "",
        "O Programa Parceiro Homologado possui benefício de indicação de novos parceiros.",
        "O parceiro homologado pode indicar novos parceiros para o programa e receber 10% de comissão sobre tudo que o parceiro indicado vender.",
        "A comissão é vitalícia enquanto o parceiro indicado estiver ativo.",
        "A comissão é apenas sobre indicados diretos: 1 nível de indicação, simples e transparente.",
        "Condição: o parceiro indicado deve trabalhar respeitando o valor mínimo de venda sugerido pela IQG.",
        "Controle: relatórios semanais de liquidação enviados em PDF.",
        "",
        "IMPORTANTE:",
        "Não confundir este benefício com o Programa de Afiliados.",
        "Não dizer que é link de afiliado.",
        "Não chamar o lead de afiliado quando ele estiver falando do Homologado.",
        "Não transformar a conversa em Afiliados automaticamente.",
        "Tratar como benefício adicional do Parceiro Homologado.",
        "",
        leadIsPiscineiro
          ? "Como o lead parece ser piscineiro, apresentar isso como uma possibilidade forte: muitos piscineiros têm rede próxima de colegas, grande clientela e relações interpessoais no setor. Alguns se homologam, pagam a taxa e podem focar bastante em indicar outros parceiros para o sistema, faturando com a comissão de 10% sobre as vendas dos indicados."
          : "",
        "",
        "Como a SDR deve falar:",
        "Explicar de forma natural que, além da venda direta dos produtos, existe também a possibilidade de faturar indicando novos parceiros para o Programa Homologado.",
        "Se o lead perguntar sobre indicação, responder de forma direta.",
        "Se o lead for piscineiro, pode apresentar essa possibilidade como um benefício estratégico do programa.",
        "Depois de explicar, continuar o fluxo normal do Homologado, sem pular taxa, responsabilidades ou pré-cadastro."
      ].filter(Boolean).join("\n")
  };
}

async function runLeadSemanticIntentClassifier({
  lead = {},
  history = [],
  lastUserText = "",
  lastSdrText = "",
  auditTraceId = null
} = {}) {
   
  const fallback = {
    greetingOnly: false,
    asksQuestion: false,
    questionTopics: [],
     mentionsOtherProductLine: false,
otherProductLineTopics: [],
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

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — CRÍTICA DE CONTEXTO NÃO É OBJEÇÃO COMERCIAL
━━━━━━━━━━━━━━━━━━━━━━━

Quando o lead disser que a SDR pulou assunto, repetiu informação, ignorou histórico ou falou de algo que ainda não foi explicado, isso NÃO deve ser classificado como objeção de taxa, mesmo que a mensagem cite "taxa", "investimento", "adesão", "valor" ou "pagamento".

Exemplos:
- "não falamos sobre investimento ainda";
- "você ainda não explicou a taxa";
- "esse follow-up ficou fora de contexto";
- "você está pulando etapa";
- "você está se perdendo";
- "você está repetitiva";
- "já falei isso";
- "já respondi isso";
- "revisa o histórico";
- "#mensagem ao desenvolvedor: follow-up contaminado".

Classificação correta nesses casos:
- blockingObjection = false, salvo se houver rejeição comercial real;
- priceObjection = false, salvo se o lead reclamar do valor, disser que está caro, que não quer pagar ou que não tem dinheiro;
- delayOrAbandonment = false, salvo se o lead disser que quer parar;
- wantsAffiliate = false, salvo se pedir Afiliado diretamente;
- reason deve indicar: "lead corrigiu contexto/condução; não é objeção comercial".

A SDR deve corrigir a condução, pedir desculpa brevemente e retomar do ponto correto.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — RENDA EXTRA NÃO É AFILIADO AUTOMÁTICO
━━━━━━━━━━━━━━━━━━━━━━━

"Renda extra" NÃO significa Programa de Afiliados automaticamente.

Quando o lead disser algo como:
- "quero renda extra";
- "quero ganhar dinheiro";
- "quero uma oportunidade";
- "quero vender";
- "tenho clientes";
- "consigo vender";
- "acho que consigo vender para vários";
- "quero trabalhar com vocês";
- "quero representar";
- "quero ter uma renda a mais";

a classificação correta é:
interesse comercial genérico.

Não classifique automaticamente como:
- wantsAffiliate = true;
- perfil afiliado;
- intenção buscar_afiliado;
- rota Afiliado;
- cadastro de Afiliado;
- link de Afiliado.

Só classifique como Afiliado se houver sinal claro de Afiliado, como:
- "afiliado";
- "programa de afiliados";
- "link";
- "link de afiliado";
- "divulgar online";
- "redes sociais";
- "comissão por link";
- "cadastro de afiliado";
- "vender pela internet";
- "sem estoque físico";
- "sem taxa";
- "não quero estoque";
- "só divulgar".

Se esses sinais não estiverem claros, NÃO marque wantsAffiliate como true.

Sinais que podem apontar mais para Homologado:
- "homologado";
- "parceiro homologado";
- "quero me homologar";
- "programa homologado";
- "opção 2";
- "tenho clientes";
- "consigo vender para meus clientes";
- "revender";
- "produtos físicos";
- "kit";
- "estoque";
- "comodato";
- "pronta-entrega";
- "demonstração";
- "vender localmente".

Se o lead fala em clientes, vender para clientes, produto físico, kit, estoque ou homologação, isso aponta mais para Homologado do que para Afiliado.

Exemplo errado:
Lead: "quero uma renda extra"
Classificação errada:
wantsAffiliate = true

Exemplo correto:
Lead: "quero uma renda extra"
Classificação correta:
wantsAffiliate = false
wantsHomologado = false
asksQuestion ou positiveRealInterest podem depender do contexto
reason: "Interesse comercial genérico, sem escolha clara de rota."

Exemplo correto:
Lead: "tenho bastante clientes, acho que consigo vender para vários"
Classificação correta:
wantsAffiliate = false
wantsHomologado pode ser true se o histórico já estiver no Homologado
positiveRealInterest = true
reason: "Lead demonstra potencial de venda com base de clientes, mais compatível com Homologado quando o contexto é parceiro homologado."

Regra importante:
Não use "renda extra" como atalho para Afiliado.
Use o contexto inteiro.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — PREFERÊNCIA ATUAL POR HOMOLOGADO
━━━━━━━━━━━━━━━━━━━━━━━

A preferência atual e clara do lead vale mais do que sinais antigos.

Se antes apareceu Afiliado, mas agora o lead declarou preferência por Homologado, classifique a intenção atual como Homologado.

Considere preferência clara por Homologado quando o lead disser algo como:
- "quero Homologado";
- "quero me homologar";
- "quero parceiro homologado";
- "programa homologado";
- "a opção 2 é o programa homologado";
- "opção 2";
- "apenas Homologado";
- "só Homologado";
- "não quero Afiliado";
- "já falei que é Homologado";
- "já falei que apenas Homologados";
- "quero vender como parceiro";
- "quero revender";
- "tenho clientes e consigo vender";
- "quero vender para meus clientes";
- "quero trabalhar com produtos físicos";
- "kit inicial";
- "estoque em comodato";
- "produtos em comodato";
- "pronta-entrega";
- "demonstração".

Nesses casos, a classificação correta deve ser:
wantsHomologado = true
wantsAffiliate = false
wantsBoth = false, salvo se o lead pedir comparação explicitamente
requestedFile só deve ser preenchido se ele pedir material, catálogo, folder ou PDF
humanRequest = false, salvo se ele pedir pessoa/atendente/consultor

Não mantenha wantsAffiliate = true apenas porque Afiliado apareceu antes na conversa.

Não marque wantsBoth = true apenas porque os dois programas foram mencionados anteriormente.

Só marque wantsBoth = true se a mensagem atual do lead pedir comparação ou os dois caminhos, como:
- "qual a diferença entre os dois?";
- "quero entender os dois";
- "posso fazer os dois?";
- "homologado e afiliado";
- "comparar os programas".

Se o lead corrigir a SDR, por exemplo:
- "eu falei 2";
- "a opção 2 é o programa homologado";
- "já falei que apenas homologados";
- "não é afiliado";

então a classificação correta é:
wantsHomologado = true
wantsAffiliate = false
wantsBoth = false
positiveRealInterest pode ser true se ele demonstra continuidade no Homologado
reason deve mencionar que o lead corrigiu a rota para Homologado.

Exemplo errado:
Lead: "Mas quero me homologar nos parceiros homologados"
Classificação errada:
wantsAffiliate = true
wantsBoth = true

Exemplo correto:
Lead: "Mas quero me homologar nos parceiros homologados"
Classificação correta:
wantsHomologado = true
wantsAffiliate = false
wantsBoth = false
positiveRealInterest = true
reason: "Lead declarou preferência atual pelo Programa Parceiro Homologado."

Exemplo errado:
Lead: "Já falei que apenas homologados"
Classificação errada:
wantsBoth = true

Exemplo correto:
Lead: "Já falei que apenas homologados"
Classificação correta:
wantsHomologado = true
wantsAffiliate = false
wantsBoth = false
leadCriticouRepeticao não é campo deste JSON, mas a razão deve indicar correção de rota e irritação/repetição no histórico.

Regra importante:
A última preferência clara do lead vale mais do que sinal antigo salvo no funil.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — RECLAMAÇÃO DE REPETIÇÃO NÃO É COMPARAÇÃO
━━━━━━━━━━━━━━━━━━━━━━━

Quando o lead reclamar que a SDR está repetindo, se perdendo ou ignorando o histórico, isso NÃO deve ser classificado como pedido de comparação entre programas.

Considere reclamação de repetição, perda de contexto ou irritação leve quando o lead disser algo como:
- "você está repetitiva";
- "você está se repetindo";
- "já falou isso";
- "já respondi";
- "já falei";
- "revisa o histórico";
- "revisita o histórico";
- "você precisa revisitar o histórico";
- "você está se perdendo";
- "você não está entendendo";
- "você não leu a conversa";
- "parece que esqueceu";
- "de novo isso?";
- "já falei que quero Homologado";
- "já falei que é apenas Homologado";
- "deve estar se perdendo".

Nesses casos, NÃO classifique automaticamente como:
- wantsBoth = true;
- wantsAffiliate = true;
- pedido de comparação;
- interesse em Afiliado;
- pedido de link;
- pedido de novo resumo dos dois programas.

A classificação correta deve considerar:
- a reclamação é sobre a qualidade da condução;
- o lead está sinalizando que a SDR não respeitou o histórico;
- a preferência mais recente do lead deve prevalecer;
- se ele já escolheu Homologado, manter Homologado;
- se ele já escolheu Afiliado, manter Afiliado;
- se ele não escolheu nada, tratar como frustração/contexto ruim, não como escolha de rota.

Se o lead reclamar de repetição e também mencionar Homologado, como:
- "já falei que apenas Homologados";
- "eu falei 2";
- "quero Homologado";
- "não é Afiliado";

então a classificação correta é:
wantsHomologado = true
wantsAffiliate = false
wantsBoth = false
positiveRealInterest pode ser true se ele ainda demonstra continuidade
blockingObjection pode ser true se a irritação for forte
reason deve mencionar que o lead corrigiu a rota e reclamou da repetição.

Se o lead reclamar de repetição sem escolher programa, a classificação correta é:
wantsHomologado = false, salvo contexto recente claro de Homologado
wantsAffiliate = false, salvo contexto recente claro de Afiliado
wantsBoth = false
blockingObjection pode ser true se houver frustração forte
reason deve mencionar perda de contexto/repetição.

Exemplo errado:
Lead: "Vc está repetitiva... kkkk"
Classificação errada:
wantsBoth = true
wantsAffiliate = true

Exemplo correto:
Lead: "Vc está repetitiva... kkkk"
Classificação correta:
wantsBoth = false
wantsAffiliate = false
blockingObjection pode ser true se o contexto indicar incômodo
reason: "Lead criticou repetição da SDR; não pediu comparação nem Afiliado."

Exemplo errado:
Lead: "Já falei que apenas homologados"
Classificação errada:
wantsBoth = true

Exemplo correto:
Lead: "Já falei que apenas homologados"
Classificação correta:
wantsHomologado = true
wantsAffiliate = false
wantsBoth = false
reason: "Lead reforçou preferência por Homologado e criticou a repetição/erro de rota."

Regra importante:
Crítica de repetição é sinal de problema na condução, não sinal de interesse em Afiliado.

━━━━━━━━━━━━━━━━━━━━━━━
REGRA CENTRAL — ABANDONO DO HOMOLOGADO E SAÍDA PARA AFILIADO
━━━━━━━━━━━━━━━━━━━━━━━

Quando o lead não quer continuar no Programa Parceiro Homologado antes de finalizar o pré-cadastro, isso NÃO deve ser tratado apenas como encerramento seco.

Regra comercial obrigatória da IQG:

Se o lead NÃO finalizou o pré-cadastro do Programa Parceiro Homologado, ele deve receber a alternativa do Programa de Afiliados.

A classificação correta deve diferenciar três situações:

1. Lead pediu Afiliado diretamente.
2. Lead quer continuar no Homologado.
3. Lead desistiu do Homologado antes do pré-cadastro.

Situação 1 — Lead pediu Afiliado diretamente:
Se o lead pedir link, Afiliado, comissão por link, cadastro de Afiliado, divulgação online ou venda sem estoque físico:
wantsAffiliate = true
wantsHomologado = false, salvo se também pedir os dois
delayOrAbandonment = false, salvo se também houver desistência clara

Situação 2 — Lead quer continuar no Homologado:
Se o lead disser que quer Homologado, quer se homologar, quer parceiro homologado, quer vender produtos físicos ou quer seguir com o Homologado:
wantsHomologado = true
wantsAffiliate = false
delayOrAbandonment = false

Situação 3 — Lead desistiu do Homologado antes do pré-cadastro:
Se o lead disser algo como:
- "não quero nada";
- "não quero mais";
- "não quero continuar";
- "deixamos quieto";
- "deixa quieto";
- "deixa pra lá";
- "deixa para lá";
- "tchau";
- "pode encerrar";
- "encerra";
- "não tenho interesse";
- "não é pra mim";
- "vou deixar";
- "não vou seguir";
- "não quero esse programa";
- "paremos por aqui";
- "desisti";
- "vou desistir";

e o lead ainda NÃO finalizou o pré-cadastro, então a classificação correta é:
wantsHomologado = false
positiveRealInterest = false
positiveCommitment = false
delayOrAbandonment = true
blockingObjection pode ser true se houver frustração, irritação ou rejeição clara
wantsAffiliate = false, salvo se o lead também pediu Afiliado diretamente
reason deve mencionar que o lead abandonou o caminho Homologado antes de finalizar o pré-cadastro e que, pela regra comercial, a alternativa adequada é Afiliado.

Não classifique isso como:
- interesse real no Homologado;
- compromisso positivo;
- pronto para coleta;
- pedido de humano automático;
- apenas conversa perdida sem próxima saída.

Exemplo errado:
Lead: "não quero nada, tchau"
Classificação errada:
positiveRealInterest = true

Exemplo errado:
Lead: "deixamos quieto"
Classificação errada:
wantsHomologado = true

Exemplo correto:
Lead: "não quero nada, tchau"
Classificação correta:
wantsHomologado = false
wantsAffiliate = false
positiveRealInterest = false
positiveCommitment = false
delayOrAbandonment = true
blockingObjection = true ou false conforme o tom
reason: "Lead abandonou o caminho Homologado antes de finalizar o pré-cadastro. A saída comercial adequada é oferecer Afiliado como alternativa, sem insistir no Homologado."

Exemplo correto:
Lead: "deixamos quieto, não vou seguir"
Classificação correta:
delayOrAbandonment = true
positiveRealInterest = false
positiveCommitment = false
reason: "Lead não quer continuar no Homologado. Como o pré-cadastro não foi finalizado, a alternativa adequada é Afiliado."

Regra importante:
Não invente que o lead quer Afiliado se ele não pediu Afiliado.
Mas reconheça que, pela regra comercial da IQG, a saída correta quando o Homologado não finaliza é apresentar Afiliado como alternativa.

A classificação deve ajudar o backend e o Pré-SDR a não insistirem no Homologado, e também a não encerrarem seco sem alternativa.

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
    "mentionsOtherProductLine": false,
  "otherProductLineTopics": [],
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

   const semanticIntentResultRaw = {
  ...fallback,
  ...parsed,
  questionTopics: Array.isArray(parsed?.questionTopics) ? parsed.questionTopics : [],
  otherProductLineTopics: Array.isArray(parsed?.otherProductLineTopics)
    ? parsed.otherProductLineTopics
    : [],
  requestedFile: parsed?.requestedFile || "",
  confidence: parsed?.confidence || "baixa",
  reason: parsed?.reason || ""
};

const semanticIntentResult = iqgNormalizeSemanticIntentAfterClassifier({
  semanticIntent: semanticIntentResultRaw,
  lastUserText,
  lastSdrText,
  lead
});

await recordAuditEvent({
  traceId: auditTraceId,
  component: AUDIT_COMPONENTS.GPT_SEMANTIC_INTENT,
  eventType: AUDIT_EVENT_TYPES.GPT_CALL_SUCCESS,
  payload: {
    model: process.env.OPENAI_SEMANTIC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    ultimaMensagemLead: lastUserText || "",
    confidence: semanticIntentResult?.confidence || "baixa",
    wantsAffiliate: semanticIntentResult?.wantsAffiliate === true,
    wantsHomologado: semanticIntentResult?.wantsHomologado === true,
    blockingObjection: semanticIntentResult?.blockingObjection === true,
    priceObjection: semanticIntentResult?.priceObjection === true,
    asksQuestion: semanticIntentResult?.asksQuestion === true,
    greetingOnly: semanticIntentResult?.greetingOnly === true,
    reason: semanticIntentResult?.reason || ""
  },
  requiredLevel: "STANDARD",
  userPhone: lead?.user || "",
  severity: "low"
});
     
auditLog("Resposta do Classificador Semantico", {
  ultimaMensagemLead: lastUserText || "",
  ultimaRespostaSdr: lastSdrText || "",
  lead: buildLeadAuditSnapshot(lead || {}),
  historicoRecente: recentHistory || [],
  semanticIntentResultRaw,
  semanticIntentResult
});

return semanticIntentResult;
     
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
  const abandonoOuDesistencia = semanticIntent?.delayOrAbandonment === true;

  const pediuHumano = semanticIntent?.humanRequest === true;

  const leadFinalizouPreCadastro =
    currentLead?.crmEnviado === true ||
    currentLead?.dadosConfirmadosPeloLead === true ||
    currentLead?.faseFunil === "crm" ||
    currentLead?.statusOperacional === "enviado_crm" ||
    currentLead?.status === "enviado_crm" ||
    currentLead?.faseQualificacao === "enviado_crm";
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
  const estaTravadoNoHomologado =
    temObjecaoBloqueante ||
    temObjecaoPreco ||
    temObjecaoEstoque ||
    semanticIntent?.riskObjection === true ||
    semanticIntent?.delayOrAbandonment === true;

  return {
    rota: "homologado",
    deveResponderAgora: false,
    deveCompararProgramas: false,
    deveManterHomologado: true,
    origemConversao: estaTravadoNoHomologado
      ? "homologado_com_objecao"
      : "homologado",
    motivo: estaTravadoNoHomologado
      ? "Lead está no caminho do Parceiro Homologado, mas trouxe objeção/dúvida/trava que precisa ser tratada antes de avançar."
      : "Lead demonstrou intenção clara pelo Parceiro Homologado."
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

  // Caso 7:
  // Lead desistiu ou abandonou o Homologado antes de finalizar pré-cadastro.
  //
  // Regra comercial IQG:
  // Se não finalizou Homologado, a saída correta é oferecer Afiliado.
  //
  // Importante:
  // Isso NÃO significa inventar que o lead quer Afiliado.
  // Significa apenas conduzir a alternativa comercial correta.
  if (
    abandonoOuDesistencia &&
    !leadFinalizouPreCadastro &&
    !querAfiliado &&
    !querHomologado &&
    !querAmbos
  ) {
    return {
      rota: "afiliado",
      deveResponderAgora: true,
      deveCompararProgramas: false,
      deveManterHomologado: false,
      origemConversao: "abandono_homologado_saida_afiliado",
      motivo: "Lead abandonou ou esfriou no Homologado antes de finalizar o pré-cadastro. Pela regra comercial, deve receber Afiliado como alternativa."
    };
  }

  return fallback;
}
function normalizeSemanticConfidence(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function hasUsableSemanticConfidence(value = "") {
  const confidence = normalizeSemanticConfidence(value);

  return confidence === "media" || confidence === "alta";
}

function semanticListIncludesAny(list = [], targets = []) {
  const normalizedList = Array.isArray(list)
    ? list.map(item =>
        String(item || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
      )
    : [];

  return targets.some(target =>
    normalizedList.some(item => item.includes(target))
  );
}

function hasActiveSemanticObjection(semanticIntent = {}) {
  return (
    semanticIntent?.blockingObjection === true ||
    semanticIntent?.priceObjection === true ||
    semanticIntent?.stockObjection === true ||
    semanticIntent?.riskObjection === true ||
    semanticIntent?.delayOrAbandonment === true ||
    semanticIntent?.humanRequest === true
  );
}

function normalizeTurnPolicyText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLeadInActiveCollectionForTurnPolicy(lead = {}) {
  const status = lead?.status || "";
  const faseQualificacao = lead?.faseQualificacao || "";
  const faseFunil = lead?.faseFunil || "";

  return Boolean(
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true ||
    lead?.campoEsperado ||
    lead?.campoPendente ||
    ["coleta_dados", "confirmacao_dados"].includes(faseFunil) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final"
    ].includes(status) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final"
    ].includes(faseQualificacao)
  );
}

function buildTurnPolicy({
  lead = {},
  text = "",
  semanticIntent = {},
  commercialRouteDecision = {}
} = {}) {
  /*
    ETAPA 16.3A — Política do Turno mínima.
    Define limites objetivos da rodada atual:
    - pode falar Afiliado?
    - pode mandar link?
    - pode falar taxa?
    - pode pedir dados?
    - pode salvar Homologado como oferta escolhida?
    - pode marcar benefícios/estoque?
    A estratégia comercial continua sendo do Pré-SDR.
  */

  /*
    PROTEÇÃO POS-CRM — não reabrir coleta para lead já cadastrado.
    Se o lead já foi enviado ao CRM, a política do turno NÃO pode
    pedir dados, falar de taxa, oferecer afiliado nem voltar para
    o funil comercial. Ele é um lead em atendimento pós-venda.
  */
  const leadEstaPosCrm =
    lead?.crmEnviado === true ||
    lead?.status === "enviado_crm" ||
    lead?.faseQualificacao === "enviado_crm" ||
    lead?.statusOperacional === "enviado_crm" ||
    lead?.faseFunil === "crm";

  if (leadEstaPosCrm) {
    return {
      modo: "pos_crm_atendimento",
      ofertaPermitida: "nenhuma_no_momento",
      podeFalarAfiliado: false,
      podeMandarLinkAfiliado: false,
      podeCompararProgramas: false,
      podeFalarTaxa: false,
      podePedirDados: false,
      podeMarcarBeneficiosEstoque: false,
      estrategiaObrigatoria: "atendimento_pos_crm",
      proximaMelhorAcao:
        "Responder de forma consultiva e curta a manifestação atual do lead. Não reiniciar o funil. Não pedir dados novamente. Se o lead perguntar sobre próximos passos, orientar que a equipe comercial fará contato.",
      cuidadoPrincipal:
        "Lead já está pós-CRM. NÃO pedir nome, CPF, telefone, cidade ou estado. NÃO repetir taxa, benefícios, estoque ou responsabilidades. NÃO oferecer afiliado. NÃO prometer aprovação, contrato ou pagamento.",
      motivo: "Lead já foi enviado ao CRM. Política do turno em modo atendimento pós-venda."
    };
  }
   
  const t = normalizeTurnPolicyText(text);

  const coletaAtiva = isLeadInActiveCollectionForTurnPolicy(lead || {});

  const preCadastroFinalizado =
    leadHasFinishedPreCadastro(lead || {}) === true ||
    lead?.crmEnviado === true ||
    lead?.dadosConfirmadosPeloLead === true ||
    lead?.faseFunil === "crm" ||
    lead?.statusOperacional === "enviado_crm";

  const pediuHomologado =
    semanticIntent?.wantsHomologado === true ||
    /\b(parceiro homologado|programa homologado|programa parceiro homologado|quero homologado|homologado faz mais sentido|me homologar|só homologado|so homologado|apenas homologado|produtos fisicos|produtos físicos|comodato|kit inicial|pronta entrega|pronta-entrega)\b/i.test(text || "");

  const pediuAfiliado =
    semanticIntent?.wantsAffiliate === true ||
    /\b(programa de afiliados|afiliado|afiliados|link de afiliado|comissao por link|comissão por link|divulgacao online|divulgação online|vender online|sem estoque fisico|sem estoque físico)\b/i.test(text || "");

  const pediuComparacaoOuOpcoes =
    semanticIntent?.wantsBoth === true ||
    /\b(os dois|ambos|comparar|comparacao|comparação|qual a diferenca|qual a diferença|duas opcoes|duas opções|opcoes da iqg|opções da iqg|caminhos comerciais|entender melhor as opcoes|entender melhor as opções)\b/i.test(text || "");

  const descobertaNeutra =
    !pediuHomologado &&
    !pediuAfiliado &&
    (
      /\b(renda extra|renda a mais|ganhar dinheiro|oportunidade|quero vender|trabalhar com voces|trabalhar com vocês|opcoes da iqg|opções da iqg|caminhos comerciais|entender melhor as opcoes|entender melhor as opções)\b/i.test(text || "") ||
      (
        semanticIntent?.asksQuestion === true &&
        Array.isArray(semanticIntent?.questionTopics) &&
        semanticIntent.questionTopics.some(topic => {
          const topicText = normalizeTurnPolicyText(topic);
          return topicText.includes("opcoes") || topicText.includes("opções");
        })
      )
    );

  const perguntouTaxaPagamentoContrato =
    semanticIntent?.priceObjection === true ||
    semanticIntent?.paymentIntent === true ||
    /\b(taxa|valor|preco|preço|investimento|pagar|pagamento|pix|cartao|cartão|boleto|parcelamento|parcelar|desconto|contrato|assinatura)\b/i.test(text || "");

  const pediuMaterial =
    Boolean(semanticIntent?.requestedFile) ||
    /\b(catalogo|catálogo|folder|pdf|material|kit|manual|curso|contrato)\b/i.test(text || "");

  const abandonoHomologado =
    semanticIntent?.delayOrAbandonment === true &&
    !preCadastroFinalizado &&
    !pediuAfiliado &&
    !pediuHomologado &&
    /\b(não quero|nao quero|não tenho interesse|nao tenho interesse|deixa quieto|deixamos quieto|deixa pra la|deixa pra lá|não vou seguir|nao vou seguir|não quero seguir|nao quero seguir|desisti|vou desistir|pode encerrar|encerra|tchau)\b/i.test(text || "");

  const base = {
    modo: "esclarecimento",
    ofertaPermitida: "nenhuma_no_momento",

    podeFalarAfiliado: false,
    podeMandarLinkAfiliado: false,
    podeCompararProgramas: false,
    podeFalarTaxa: false,
    podePedirDados: false,
    podeMarcarBeneficiosEstoque: true,

    estrategiaObrigatoria: "",
    proximaMelhorAcao: "",
    cuidadoPrincipal: "",
    motivo: "Política padrão de esclarecimento."
  };

  if (coletaAtiva) {
    return {
      ...base,
      modo: "coleta",
      ofertaPermitida: "nenhuma_no_momento",
      podeMarcarBeneficiosEstoque: false,
      podePedirDados: true,
      estrategiaObrigatoria: "manter_nutricao",
      proximaMelhorAcao:
        "Responder curto e retomar somente o dado pendente da coleta ou confirmação.",
      cuidadoPrincipal:
        "Não voltar para explicação comercial, não falar Afiliado e não falar taxa durante coleta.",
      motivo: "Lead está em coleta, confirmação ou correção de dados."
    };
  }

  if (semanticIntent?.greetingOnly === true) {
    return {
      ...base,
      modo: "saudacao",
      podeMarcarBeneficiosEstoque: false,
      estrategiaObrigatoria: "manter_nutricao",
      proximaMelhorAcao:
        "Cumprimentar e perguntar como pode ajudar, sem escolher rota.",
      cuidadoPrincipal:
        "Não falar taxa, não pedir dados, não enviar PDF e não escolher Homologado ou Afiliado.",
      motivo: "Lead apenas cumprimentou."
    };
  }

  if (abandonoHomologado) {
    return {
      ...base,
      modo: "abandono_homologado",
      ofertaPermitida: "afiliado",
      podeFalarAfiliado: true,
      podeMandarLinkAfiliado: true,
      podeMarcarBeneficiosEstoque: false,
      estrategiaObrigatoria: "oferecer_afiliado",
      proximaMelhorAcao:
        "Respeitar a desistência do Homologado e oferecer Afiliado como alternativa curta, sem insistir.",
      cuidadoPrincipal:
        "Não insistir no Homologado, não pedir CPF e não repetir benefícios.",
      motivo: "Lead desistiu do Homologado antes de finalizar o pré-cadastro."
    };
  }

  if (pediuAfiliado && !pediuHomologado) {
    return {
      ...base,
      modo: "afiliado_escolhido",
      ofertaPermitida: "afiliado",
      podeFalarAfiliado: true,
      podeMandarLinkAfiliado: true,
      podeMarcarBeneficiosEstoque: false,
      estrategiaObrigatoria: "oferecer_afiliado",
      proximaMelhorAcao:
        "Explicar Afiliado de forma curta e indicar o caminho de cadastro.",
      cuidadoPrincipal:
        "Não misturar com taxa, comodato, pré-análise ou coleta do Homologado.",
      motivo: "Lead pediu ou demonstrou intenção clara por Afiliado."
    };
  }

  if (perguntouTaxaPagamentoContrato) {
    return {
      ...base,
      modo: "taxa_pagamento_contrato",
      ofertaPermitida: "homologado",
      podeFalarTaxa: true,
      estrategiaObrigatoria: "tratar_objecao_taxa",
      proximaMelhorAcao:
        "Responder a dúvida de taxa, pagamento ou contrato dentro do Homologado, sem pedir dados.",
      cuidadoPrincipal:
        "Não oferecer Afiliado como fuga da taxa. Não oferecer boleto. Não pedir pagamento. Não prometer aprovação.",
      motivo: "Lead trouxe dúvida ou objeção sobre taxa, pagamento, boleto ou contrato."
    };
  }

  if (descobertaNeutra || (pediuComparacaoOuOpcoes && !pediuHomologado && !pediuAfiliado)) {
    return {
      ...base,
      modo: "descoberta_neutra",
      ofertaPermitida: "nenhuma_no_momento",
      podeFalarAfiliado: true,
      podeMandarLinkAfiliado: false,
      podeCompararProgramas: true,
      podeMarcarBeneficiosEstoque: false,
      estrategiaObrigatoria: "manter_nutricao",
      proximaMelhorAcao:
        "Explicar de forma curta que a IQG tem caminhos comerciais diferentes e perguntar se o lead prefere produto físico/pronta-entrega ou divulgação online.",
      cuidadoPrincipal:
        "Não tratar renda extra como Homologado escolhido. Não tratar renda extra como Afiliado automático. Não falar taxa, não pedir dados e não mandar link.",
      motivo: "Lead está descobrindo opções comerciais da IQG sem rota escolhida."
    };
  }

  if (pediuHomologado && !pediuAfiliado) {
    return {
      ...base,
      modo: "homologado_escolhido",
      ofertaPermitida: "homologado",
      podeFalarAfiliado: false,
      podeMandarLinkAfiliado: false,
      podeCompararProgramas: false,
      estrategiaObrigatoria: "reforcar_valor",
      proximaMelhorAcao:
        "Responder focando somente no Programa Parceiro Homologado e conduzir para a próxima etapa pendente.",
      cuidadoPrincipal:
        "Não comparar com Afiliado, não mandar link de Afiliado, não falar taxa cedo e não pedir dados.",
      motivo: "Lead escolheu ou reforçou preferência pelo Homologado."
    };
  }

  if (pediuMaterial) {
    return {
      ...base,
      modo: "pedido_material",
      ofertaPermitida:
        lead?.rotaComercial === "afiliado" ? "afiliado" : "homologado",
      estrategiaObrigatoria: "manter_nutricao",
      proximaMelhorAcao:
        "Responder ao pedido de material e enviar o arquivo correto se estiver disponível.",
      cuidadoPrincipal:
        "Não tratar pedido de catálogo, kit ou folder como nome do lead. Não pedir CPF.",
      motivo: "Lead pediu material, catálogo, folder, kit, manual ou contrato."
    };
  }

  return base;
}

function applyTurnPolicyToPreSdrAdvice({
  advice = {},
  turnPolicy = {},
  lead = {}
} = {}) {
  /*
    CORREÇÃO PRODUÇÃO — Política do Turno como proteção, não como comandante.

    Explicação simples:
    A Política do Turno continua existindo para impedir erro grave:
    - falar taxa cedo;
    - pedir CPF cedo;
    - mandar Afiliado indevido;
    - voltar etapa errada;
    - iniciar coleta fora de hora.

    Mas ela NÃO deve apagar uma boa orientação do Pré-SDR.

    Exemplo:
    Pré-SDR: "Responder a dúvida sobre estoque e comodato."
    Política: "Responder focando no Homologado e conduzir para próxima etapa."

    Antes:
    O sistema podia trocar a orientação específica por uma genérica.

    Agora:
    A orientação específica do Pré-SDR é preservada se for segura.
  */

  const safeAdvice = {
    ...buildDefaultConsultantAdvice(),
    ...(advice || {})
  };

  if (!turnPolicy?.modo) {
    return safeAdvice;
  }

  const modoPolitica = turnPolicy.modo || "";

  const normalizeLocalPolicyText = value =>
    normalizeTurnPolicyText(value || "");

  const isEmptyOrNotAnalyzed = value => {
    const t = normalizeLocalPolicyText(value);
    return !t || t === "nao analisado" || t === "nao_analisado";
  };

  const adviceActionText = normalizeLocalPolicyText(safeAdvice.proximaMelhorAcao || "");
  const policyActionText = normalizeLocalPolicyText(turnPolicy.proximaMelhorAcao || "");
  const adviceCareText = normalizeLocalPolicyText(safeAdvice.cuidadoPrincipal || "");
  const adviceStrategyText = normalizeLocalPolicyText(safeAdvice.estrategiaRecomendada || "");

  const adviceLooksSpecific =
    adviceActionText.length >= 35 &&
    (
      adviceActionText.includes("estoque") ||
      adviceActionText.includes("comodato") ||
      adviceActionText.includes("beneficio") ||
      adviceActionText.includes("benefícios") ||
      adviceActionText.includes("beneficios") ||
      adviceActionText.includes("programa") ||
      adviceActionText.includes("responsabilidade") ||
      adviceActionText.includes("responsabilidades") ||
      adviceActionText.includes("taxa") ||
      adviceActionText.includes("investimento") ||
      adviceActionText.includes("contrato") ||
      adviceActionText.includes("pagamento") ||
      adviceActionText.includes("catalogo") ||
      adviceActionText.includes("catálogo") ||
      adviceActionText.includes("folder") ||
      adviceActionText.includes("material") ||
      adviceActionText.includes("arquivo") ||
      adviceActionText.includes("duvida") ||
      adviceActionText.includes("dúvida") ||
      adviceActionText.includes("pergunta") ||
      adviceActionText.includes("responder")
    );

  const adviceLooksGeneric =
    !adviceActionText ||
    adviceActionText.includes("proxima etapa pendente") ||
    adviceActionText.includes("próxima etapa pendente") ||
    adviceActionText.includes("conduzir para a proxima etapa") ||
    adviceActionText.includes("conduzir para a próxima etapa") ||
    adviceActionText.includes("manter nutricao") ||
    adviceActionText.includes("manter nutrição") ||
    adviceActionText.includes("responder focando somente no programa") ||
    adviceActionText.includes("cumprimentar e perguntar como pode ajudar");

  const policyModeShouldCommand =
    [
      "saudacao",
      "abandono_homologado",
      "afiliado_escolhido",
      "descoberta_neutra"
    ].includes(modoPolitica);

  const policyModeCanPreserveSpecificAdvice =
    [
      "esclarecimento",
      "homologado_escolhido",
      "taxa_pagamento_contrato",
      "pedido_material"
    ].includes(modoPolitica);

  const adviceMentionsDataCollection =
    adviceActionText.includes("nome completo") ||
    adviceActionText.includes("cpf") ||
    adviceActionText.includes("telefone") ||
    adviceActionText.includes("cidade") ||
    adviceActionText.includes("estado") ||
    adviceActionText.includes("uf") ||
    adviceActionText.includes("pre cadastro") ||
    adviceActionText.includes("pré cadastro") ||
    adviceActionText.includes("pre-cadastro") ||
    adviceActionText.includes("pré-cadastro") ||
    adviceActionText.includes("pre analise") ||
    adviceActionText.includes("pré análise") ||
    adviceActionText.includes("coleta");

  const adviceMentionsTaxOrPayment =
    adviceActionText.includes("taxa") ||
    adviceActionText.includes("investimento") ||
    adviceActionText.includes("pagamento") ||
    adviceActionText.includes("pix") ||
    adviceActionText.includes("cartao") ||
    adviceActionText.includes("cartão") ||
    adviceCareText.includes("taxa") ||
    adviceCareText.includes("pagamento");

  const adviceMentionsAffiliate =
    adviceActionText.includes("afiliado") ||
    adviceActionText.includes("afiliados") ||
    adviceActionText.includes("link de afiliado") ||
    adviceActionText.includes("minhaiqg") ||
    adviceCareText.includes("afiliado") ||
    adviceCareText.includes("afiliados");

  const adviceViolatesPolicy =
    (
      turnPolicy.podePedirDados !== true &&
      adviceMentionsDataCollection
    ) ||
    (
      turnPolicy.podeFalarTaxa !== true &&
      adviceMentionsTaxOrPayment
    ) ||
    (
      turnPolicy.podeMandarLinkAfiliado !== true &&
      adviceMentionsAffiliate &&
      turnPolicy.ofertaPermitida !== "afiliado"
    );

  const leadEstaEmColetaOuConfirmacao =
    isLeadInActiveCollectionForTurnPolicy(lead || {}) ||
    modoPolitica === "coleta" ||
    modoPolitica === "confirmacao_dados" ||
    modoPolitica === "coleta_dados_liberada";

  /*
    BLOCO ESPECIAL — COLETA / CONFIRMAÇÃO

    Durante coleta, a Política do Turno não pode decidir "pedir nome".
    Ela só protege contra regressão comercial.
  */
  if (leadEstaEmColetaOuConfirmacao) {
    const retomadaColeta = buildDataFlowResumeMessage(lead || {});
    const missingFields = getMissingLeadFields(lead || {});

    const nomeJaExiste = Boolean(String(lead?.nome || "").trim());
    const cpfJaExiste = Boolean(String(lead?.cpf || "").trim());
    const telefoneJaExiste = Boolean(String(lead?.telefone || "").trim());
    const cidadeJaExiste = Boolean(String(lead?.cidade || "").trim());
    const estadoJaExiste = Boolean(String(lead?.estado || "").trim());

    const proximaAcaoOriginal = normalizeTurnPolicyText(safeAdvice.proximaMelhorAcao || "");

    const advicePareceForcarNome =
      proximaAcaoOriginal.includes("nome completo") ||
      proximaAcaoOriginal.includes("pedir nome") ||
      proximaAcaoOriginal.includes("peça o nome") ||
      proximaAcaoOriginal.includes("peca o nome") ||
      proximaAcaoOriginal.includes("iniciar coleta") ||
      proximaAcaoOriginal.includes("iniciar pre-cadastro") ||
      proximaAcaoOriginal.includes("iniciar pré-cadastro");

    const precisaCorrigirProximaAcao =
      !safeAdvice.proximaMelhorAcao ||
      advicePareceForcarNome ||
      safeAdvice.estrategiaRecomendada === "iniciar_coleta";

    return {
      ...safeAdvice,

      politicaTurnoAplicada: true,
      modoPoliticaTurno: modoPolitica,
      politicaTurnoModoProtecaoColeta: true,

      estrategiaRecomendada:
        safeAdvice.estrategiaRecomendada === "iniciar_coleta"
          ? "avancar_pre_analise"
          : (safeAdvice.estrategiaRecomendada || "avancar_pre_analise"),

      ofertaMaisAdequada: "nenhuma_no_momento",

      proximaMelhorAcao: precisaCorrigirProximaAcao
        ? [
            "Retomar a coleta pelo próximo dado realmente faltante no cadastro.",
            "Não pedir nome se o nome já estiver preenchido.",
            `Orientação operacional do backend: ${retomadaColeta}`
          ].join("\n")
        : safeAdvice.proximaMelhorAcao,

      cuidadoPrincipal: [
        "Política do Turno em modo proteção durante coleta:",
        "NÃO escolher manualmente o campo da coleta.",
        "NÃO mandar pedir nome completo se o nome já estiver preenchido.",
        "NÃO reiniciar pré-cadastro.",
        "NÃO voltar para taxa, benefícios, estoque ou responsabilidades.",
        "NÃO oferecer Afiliados durante coleta do Homologado, salvo pedido explícito do lead.",
        "Usar sempre o próximo campo real faltante calculado pelo backend.",
        `Campos atuais: nome=${nomeJaExiste ? "preenchido" : "faltando"}, cpf=${cpfJaExiste ? "preenchido" : "faltando"}, telefone=${telefoneJaExiste ? "preenchido" : "faltando"}, cidade=${cidadeJaExiste ? "preenchido" : "faltando"}, estado=${estadoJaExiste ? "preenchido" : "faltando"}.`,
        missingFields.length > 0
          ? `Campos faltantes: ${missingFields.join(", ")}.`
          : "Nenhum campo obrigatório faltante; seguir para confirmação dos dados.",
        safeAdvice.cuidadoPrincipal || ""
      ].filter(Boolean).join("\n"),

      resumoConsultivo: [
        safeAdvice.resumoConsultivo || "",
        `Política do turno: ${modoPolitica}.`,
        "Correção aplicada: durante coleta, a política virou proteção e não pode mais forçar pedido de nome.",
        `Retomada correta: ${retomadaColeta}`
      ].filter(Boolean).join("\n")
    };
  }

  /*
    FORA DA COLETA

    Aqui a Política do Turno protege.
    Mas, quando o Pré-SDR trouxe uma ação específica e segura,
    nós preservamos essa ação.
  */
  const shouldPreserveSpecificPreSdrAction =
    policyModeCanPreserveSpecificAdvice &&
    adviceLooksSpecific &&
    !adviceLooksGeneric &&
    !adviceViolatesPolicy;

  let result = {
    ...safeAdvice,
    politicaTurnoAplicada: true,
    modoPoliticaTurno: modoPolitica,
    politicaTurnoPreservouAcaoPreSdr: shouldPreserveSpecificPreSdrAction,
    resumoConsultivo: [
      safeAdvice.resumoConsultivo || "",
      `Política do turno: ${modoPolitica}. ${turnPolicy.motivo || ""}`,
      shouldPreserveSpecificPreSdrAction
        ? "Correção aplicada: a Política do Turno preservou a ação específica e segura do Pré-SDR."
        : ""
    ].filter(Boolean).join("\n")
  };

  /*
    Estratégia:
    - em modos críticos, a política pode comandar;
    - em modos normais, preserva a estratégia do Pré-SDR se ela já for útil;
    - se o Pré-SDR veio vazio/nao_analisado, usa a estratégia da política.
  */
  if (turnPolicy.estrategiaObrigatoria) {
    if (
      policyModeShouldCommand ||
      isEmptyOrNotAnalyzed(result.estrategiaRecomendada) ||
      adviceViolatesPolicy
    ) {
      result.estrategiaRecomendada =
        turnPolicy.estrategiaObrigatoria === "iniciar_coleta"
          ? "avancar_pre_analise"
          : turnPolicy.estrategiaObrigatoria;
    }
  }

  /*
    Próxima melhor ação:
    Este é o ponto principal da correção.

    Antes:
    A política sempre sobrescrevia a ação do Pré-SDR.

    Agora:
    - se o Pré-SDR tem ação específica e segura, preserva;
    - se a política está em modo comandante, usa política;
    - se o Pré-SDR veio vazio/genérico/arriscado, usa política.
  */
  if (turnPolicy.proximaMelhorAcao) {
    if (
      policyModeShouldCommand ||
      !shouldPreserveSpecificPreSdrAction ||
      adviceLooksGeneric ||
      adviceViolatesPolicy
    ) {
      result.proximaMelhorAcao = turnPolicy.proximaMelhorAcao;
    } else {
      result.proximaMelhorAcao = safeAdvice.proximaMelhorAcao;
    }
  }

  /*
    Cuidado principal:
    Aqui a política sempre pode acrescentar proteção,
    mas sem apagar o cuidado específico do Pré-SDR.
  */
  if (turnPolicy.cuidadoPrincipal) {
    result.cuidadoPrincipal = [
      turnPolicy.cuidadoPrincipal,
      safeAdvice.cuidadoPrincipal || ""
    ].filter(Boolean).join("\n");
  }

  if (turnPolicy.ofertaPermitida) {
    result.ofertaMaisAdequada = turnPolicy.ofertaPermitida;
  }

  /*
    Travas finais de segurança.
    Mesmo preservando o Pré-SDR, se a orientação violar a política,
    corrigimos.
  */
  const textoProximaAcao = normalizeTurnPolicyText(result.proximaMelhorAcao);
  const textoCuidado = normalizeTurnPolicyText(result.cuidadoPrincipal);

  const tentouAvancarParaColeta =
    result.estrategiaRecomendada === "avancar_pre_analise" ||
    textoProximaAcao.includes("coleta") ||
    textoProximaAcao.includes("pre-cadastro") ||
    textoProximaAcao.includes("pré-cadastro") ||
    textoProximaAcao.includes("pre cadastro") ||
    textoProximaAcao.includes("pré cadastro") ||
    textoProximaAcao.includes("pre-analise") ||
    textoProximaAcao.includes("pre analise") ||
    textoProximaAcao.includes("pré-analise") ||
    textoProximaAcao.includes("pré análise") ||
    textoProximaAcao.includes("cpf") ||
    textoProximaAcao.includes("nome completo") ||
    textoProximaAcao.includes("telefone") ||
    textoProximaAcao.includes("cidade") ||
    textoProximaAcao.includes("estado");

  if (turnPolicy.podePedirDados !== true && tentouAvancarParaColeta) {
    result = {
      ...result,
      estrategiaRecomendada: turnPolicy.estrategiaObrigatoria || "manter_nutricao",
      proximaMelhorAcao:
        turnPolicy.proximaMelhorAcao ||
        "Responder a mensagem atual do lead sem iniciar coleta de dados.",
      cuidadoPrincipal: [
        "Política do turno bloqueou avanço para coleta ou pré-análise nesta resposta.",
        result.cuidadoPrincipal || ""
      ].filter(Boolean).join("\n"),
      politicaTurnoCorrigiuViolacao: "bloqueou_coleta_ou_dados"
    };
  }

  if (
    turnPolicy.podeFalarTaxa !== true &&
    (
      result.estrategiaRecomendada === "tratar_objecao_taxa" ||
      textoProximaAcao.includes("taxa") ||
      textoProximaAcao.includes("pagamento") ||
      textoProximaAcao.includes("pix") ||
      textoProximaAcao.includes("cartao") ||
      textoProximaAcao.includes("cartão") ||
      textoCuidado.includes("pagamento")
    )
  ) {
    result = {
      ...result,
      estrategiaRecomendada: turnPolicy.estrategiaObrigatoria || "manter_nutricao",
      proximaMelhorAcao:
        turnPolicy.proximaMelhorAcao ||
        "Responder sem falar de taxa ou pagamento nesta etapa.",
      cuidadoPrincipal: [
        "Política do turno bloqueou taxa/pagamento nesta resposta.",
        result.cuidadoPrincipal || ""
      ].filter(Boolean).join("\n"),
      politicaTurnoCorrigiuViolacao: "bloqueou_taxa_ou_pagamento"
    };
  }

  if (
    turnPolicy.podeMandarLinkAfiliado !== true &&
    result.ofertaMaisAdequada === "afiliado" &&
    turnPolicy.ofertaPermitida !== "afiliado"
  ) {
    result = {
      ...result,
      ofertaMaisAdequada: turnPolicy.ofertaPermitida || "nenhuma_no_momento",
      estrategiaRecomendada: turnPolicy.estrategiaObrigatoria || "manter_nutricao",
      cuidadoPrincipal: [
        "Política do turno bloqueou oferta/link de Afiliado nesta resposta.",
        result.cuidadoPrincipal || ""
      ].filter(Boolean).join("\n"),
      politicaTurnoCorrigiuViolacao: "bloqueou_afiliado"
    };
  }

  return result;
}

function buildSemanticQualificationPatch({
  lead = {},
  semanticIntent = null,
  semanticContinuity = null,
  history = [],
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  /*
    ETAPA 13.1 PRODUÇÃO — consolidação semântica com coerência real.

    Explicação simples:
    Esta função ajuda o backend a marcar:
    - taxa alinhada;
    - compromisso validado;
    - interesse real.

    Mas ela NÃO pode fazer isso quando o lead ainda está perguntando algo.

    Exemplo:
    Lead perguntou:
    "e se eu precisar de mais produtos depois?"

    Isso é pergunta comercial aberta.
    Não é aceite de taxa.
    Não é compromisso.
    Não é autorização para pedir CPF.
  */

  const patch = {};
  const reasons = [];

  const currentEtapas = {
    programa: false,
    beneficios: false,
    estoque: false,
    responsabilidades: false,
    investimento: false,
    taxaPerguntada: false,
    compromissoPerguntado: false,
    compromisso: false,
    ...(lead?.etapas || {})
  };

  const updatedEtapas = {
    ...currentEtapas
  };

  const normalizeLocal = value =>
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const userText = normalizeLocal(lastUserText);
  const sdrText = normalizeLocal(lastSdrText);

  const recentHistoryText = Array.isArray(history)
    ? normalizeLocal(
        history
          .slice(-12)
          .map(message => `${message.role || ""}: ${message.content || ""}`)
          .join("\n")
      )
    : "";

  const semanticConfidenceOk =
    hasUsableSemanticConfidence(semanticIntent?.confidence || "");

  const continuityConfidenceOk =
    hasUsableSemanticConfidence(semanticContinuity?.confidence || "");

  const hasObjection = hasActiveSemanticObjection(semanticIntent || {});

  const currentLeadTopics = Array.isArray(semanticIntent?.questionTopics)
    ? semanticIntent.questionTopics
    : [];

  const semanticSaysCurrentMessageIsQuestion =
    semanticIntent?.asksQuestion === true &&
    semanticIntent?.positiveRealInterest !== true &&
    semanticIntent?.positiveCommitment !== true;

  const leadRequestedFileNow =
    Boolean(semanticIntent?.requestedFile) ||
    /\b(catalogo|catálogo|folder|pdf|material|kit|manual|contrato|curso)\b/i.test(lastUserText || "");

  const currentTextIsContextCorrection =
  isDeveloperOrContextCorrectionMessage(lastUserText || "");

const currentTextLooksCommercialQuestion =
  currentTextIsContextCorrection !== true &&
  (
    semanticSaysCurrentMessageIsQuestion ||
    leadRequestedFileNow ||
    /\b(catalogo|catálogo|produto|produtos|iqg|nano|kit|folder|material|manual|estoque|comodato|reposicao|reposição|repor|mais produtos|taxa|valor|preco|preço|investimento|contrato|pagamento|boleto|pix|cartao|cartão)\b/i.test(lastUserText || "")
  );
  const currentMessageIsOpenCommercialQuestion =
    currentTextLooksCommercialQuestion &&
    semanticIntent?.positiveRealInterest !== true &&
    semanticIntent?.positiveCommitment !== true &&
    semanticIntent?.dataCorrectionIntent !== true;

  /*
    Se existe pergunta comercial aberta, marcamos isso no lead.
    Assim o backend avisa os agentes:
    "responda a dúvida antes de coletar dados".
  */
  if (currentMessageIsOpenCommercialQuestion) {
    patch.pendenciaPerguntaComercialAberta = true;
    patch.pendenciaPerguntaComercialAbertaEm = new Date();
    patch.motivoPendenciaPerguntaComercialAberta =
      "lead_fez_pergunta_comercial_antes_da_coleta";
    reasons.push("pergunta_comercial_aberta_impede_consolidacao_e_coleta");
  }

  /*
    Se antes havia uma pergunta aberta, mas agora o lead demonstra continuidade real,
    limpamos a pendência.
  */
  const leadAgoraDemonstrouContinuidadeReal =
    !currentMessageIsOpenCommercialQuestion &&
    !hasObjection &&
    semanticConfidenceOk &&
    (
      semanticIntent?.positiveRealInterest === true ||
      semanticIntent?.positiveCommitment === true ||
      semanticContinuity?.leadQuerAvancar === true
    );

  if (
    lead?.pendenciaPerguntaComercialAberta === true &&
    leadAgoraDemonstrouContinuidadeReal
  ) {
    patch.pendenciaPerguntaComercialAberta = false;
    patch.pendenciaPerguntaComercialResolvidaEm = new Date();
    reasons.push("pergunta_comercial_aberta_resolvida_por_continuidade_real");
  }

  /*
    A partir daqui, se a mensagem atual ainda é pergunta comercial aberta,
    NÃO consolidamos taxa, compromisso nem interesse real.
  */
  if (currentMessageIsOpenCommercialQuestion) {
    patch.ultimaConsolidacaoSemantica = {
      reasons,
      bloqueouConsolidacao: true,
      motivo:
        "A última mensagem do lead é pergunta comercial aberta. Responder primeiro antes de avançar para coleta.",
      semanticIntent: {
        asksQuestion: semanticIntent?.asksQuestion === true,
        questionTopics: semanticIntent?.questionTopics || [],
        requestedFile: semanticIntent?.requestedFile || "",
        positiveRealInterest: semanticIntent?.positiveRealInterest === true,
        positiveCommitment: semanticIntent?.positiveCommitment === true,
        confidence: semanticIntent?.confidence || "",
        reason: semanticIntent?.reason || ""
      },
      semanticContinuity: {
        leadEntendeuUltimaExplicacao: semanticContinuity?.leadEntendeuUltimaExplicacao === true,
        leadQuerAvancar: semanticContinuity?.leadQuerAvancar === true,
        naoRepetirUltimoTema: semanticContinuity?.naoRepetirUltimoTema === true,
        proximaAcaoSemantica: semanticContinuity?.proximaAcaoSemantica || "",
        confidence: semanticContinuity?.confidence || "",
        reason: semanticContinuity?.reason || ""
      },
      registradoEm: new Date()
    };

    return {
      shouldSave: true,
      patch,
      reasons
    };
  }

  const lastSdrTopics = semanticContinuity?.temaUltimaRespostaSdr || [];
  const currentConversationTopics = semanticContinuity?.temaMensagemAtualLead || [];

  /*
    Agora a regra fica mais inteligente:
    Para confirmar investimento/taxa, a SDR precisa ter falado de investimento/taxa
    na resposta anterior ou no histórico recente.

    Não basta lead perguntar sobre estoque, kit, catálogo ou reposição.
  */
  const lastReplyActuallyExplainedInvestment =
  /\b(taxa|adesao|adesão|investimento|r\$|1990|1\.990|10x|parcelado|cartao|cartão|pix|pagamento)\b/i.test(lastSdrText || "") &&
  /\b(r\$\s*1[\.,]?990|taxa de ades[aã]o|taxa de implanta[cç][aã]o|nao e compra de mercadoria|não é compra de mercadoria|nao e caucao|não é caução|lote inicial.*r\$\s*5)\b/i.test(lastSdrText || "");

const canEvaluateInvestmentUnderstanding = lastReplyActuallyExplainedInvestment;

  /*
    Para confirmar compromisso, precisa ter contexto real de compromisso,
    responsabilidades ou atuação.
  */
  const lastReplyActuallyExplainedCommitment =
    /\b(compromisso|responsabilidade|responsabilidades|atuacao|atuação|vendas|conservar|conservacao|conservação|comunicar vendas|resultado depende|dedicacao|dedicação)\b/i.test(lastSdrText || "") ||
    semanticListIncludesAny(lastSdrTopics, [
      "compromisso",
      "responsabilidade",
      "responsabilidades",
      "atuacao",
      "atuação",
      "vendas",
      "resultado"
    ]);

  const historyHasCommitmentContext =
    /\b(compromisso|responsabilidades|responsabilidade|atuar nas vendas|atuacao comercial|atuação comercial|resultado depende|dedicacao|dedicação|conservar produtos|comunicar vendas)\b/i.test(recentHistoryText);

  const canEvaluateCommitment =
    lastReplyActuallyExplainedCommitment || historyHasCommitmentContext;

  const leadShowedUnderstanding =
    semanticContinuity?.leadEntendeuUltimaExplicacao === true &&
    semanticContinuity?.naoRepetirUltimoTema === true &&
    continuityConfidenceOk &&
    !hasObjection;

  const leadShowedProgress =
    semanticContinuity?.leadQuerAvancar === true &&
    continuityConfidenceOk &&
    !hasObjection;

  const classifierSawRealInterest =
    semanticIntent?.positiveRealInterest === true &&
    semanticConfidenceOk &&
    !hasObjection;

  const classifierSawCommitment =
    semanticIntent?.positiveCommitment === true &&
    semanticConfidenceOk &&
    !hasObjection;

  /*
    1. Consolidar investimento/taxa.
    Só consolida se houve contexto real de taxa/investimento.
  */
  const shouldConfirmInvestment =
    canEvaluateInvestmentUnderstanding &&
    (
      leadShowedUnderstanding ||
      leadShowedProgress ||
      classifierSawRealInterest
    );

  if (shouldConfirmInvestment && updatedEtapas.investimento !== true) {
    updatedEtapas.investimento = true;
    reasons.push("investimento_confirmado_por_contexto_real_de_taxa");
  }

  if (shouldConfirmInvestment && lead?.taxaAlinhada !== true) {
    patch.taxaAlinhada = true;
    patch.taxaModoConversao = false;
    patch.sinalObjecaoTaxa = false;
    reasons.push("taxa_alinhada_por_contexto_real_de_investimento");
  }

  /*
    2. Consolidar compromisso.
    Só consolida se houve contexto real de responsabilidades/compromisso.
  */
  const shouldConfirmCommitment =
    canEvaluateCommitment &&
    (
      classifierSawCommitment ||
      leadShowedUnderstanding ||
      leadShowedProgress
    );

  if (shouldConfirmCommitment && updatedEtapas.compromisso !== true) {
    updatedEtapas.compromisso = true;
    updatedEtapas.compromissoPerguntado = true;
    patch.compromissoConfirmadoEm = new Date();
    reasons.push("compromisso_confirmado_por_contexto_real_de_responsabilidades");
  }

  /*
    3. Consolidar interesse real.
    Só consolida se tudo já está coerente E não há pergunta aberta.
  */
  const allCoreStepsReady =
    updatedEtapas.programa === true &&
    updatedEtapas.beneficios === true &&
    updatedEtapas.estoque === true &&
    updatedEtapas.responsabilidades === true &&
    updatedEtapas.investimento === true &&
    updatedEtapas.compromisso === true;

  const taxaEstaAlinhada =
    patch.taxaAlinhada === true ||
    lead?.taxaAlinhada === true;

  const shouldConfirmRealInterest =
    allCoreStepsReady &&
    taxaEstaAlinhada &&
    !hasObjection &&
    !currentMessageIsOpenCommercialQuestion &&
    (
      classifierSawRealInterest ||
      (
        leadShowedProgress &&
        canEvaluateInvestmentUnderstanding &&
        canEvaluateCommitment
      )
    );

  if (shouldConfirmRealInterest && lead?.interesseReal !== true) {
    patch.interesseReal = true;
    patch.status = "qualificando";
    patch.faseQualificacao = "qualificando";
    reasons.push("interesse_real_confirmado_com_todas_as_etapas_coerentes");
  }

  const etapasChanged =
    JSON.stringify(currentEtapas) !== JSON.stringify(updatedEtapas);

  if (etapasChanged) {
    patch.etapas = updatedEtapas;
  }

  if (reasons.length === 0) {
    return {
      shouldSave: false,
      patch: {},
      reasons: []
    };
  }

  patch.ultimaConsolidacaoSemantica = {
    reasons,
    bloqueouConsolidacao: false,
    semanticIntent: {
      asksQuestion: semanticIntent?.asksQuestion === true,
      questionTopics: semanticIntent?.questionTopics || [],
      requestedFile: semanticIntent?.requestedFile || "",
      positiveRealInterest: semanticIntent?.positiveRealInterest === true,
      positiveCommitment: semanticIntent?.positiveCommitment === true,
      softUnderstandingOnly: semanticIntent?.softUnderstandingOnly === true,
      blockingObjection: semanticIntent?.blockingObjection === true,
      priceObjection: semanticIntent?.priceObjection === true,
      stockObjection: semanticIntent?.stockObjection === true,
      riskObjection: semanticIntent?.riskObjection === true,
      delayOrAbandonment: semanticIntent?.delayOrAbandonment === true,
      humanRequest: semanticIntent?.humanRequest === true,
      confidence: semanticIntent?.confidence || "",
      reason: semanticIntent?.reason || ""
    },
    semanticContinuity: {
      leadEntendeuUltimaExplicacao: semanticContinuity?.leadEntendeuUltimaExplicacao === true,
      leadQuerAvancar: semanticContinuity?.leadQuerAvancar === true,
      leadCriticouRepeticao: semanticContinuity?.leadCriticouRepeticao === true,
      naoRepetirUltimoTema: semanticContinuity?.naoRepetirUltimoTema === true,
      temaUltimaRespostaSdr: semanticContinuity?.temaUltimaRespostaSdr || [],
      temaMensagemAtualLead: semanticContinuity?.temaMensagemAtualLead || [],
      proximaAcaoSemantica: semanticContinuity?.proximaAcaoSemantica || "",
      confidence: semanticContinuity?.confidence || "",
      reason: semanticContinuity?.reason || ""
    },
    registradoEm: new Date()
  };

  return {
    shouldSave: true,
    patch,
    reasons
  };
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
  /*
    ETAPA 16.2 — Consultor pós-SDR em modo passivo.

    O pós-SDR não pilota mais conversa.
    Ele não salva estratégia.
    Ele não muda rota.
    Ele não muda funil.
    Ele não decide próxima resposta.

    Esta função fica apenas como proteção caso algum ponto antigo
    do código ainda tente chamá-la.
  */

  try {
    if (!user) {
      return;
    }

    console.log("ℹ️ runConsultantAfterClassifier chamado, mas está desativado como piloto:", {
      user,
      motivo: "ETAPA 16.2 — Consultor pós-SDR não salva mais consultoria operacional.",
      ultimaMensagemLead: lastUserText || "",
      ultimaRespostaSdrPreview: String(lastSdrText || "").slice(0, 180),
      temperaturaComercial: classification?.temperaturaComercial || "nao_analisado",
      intencaoPrincipal: classification?.intencaoPrincipal || "nao_analisado"
    });

    auditLog("Consultor pos-SDR desativado como piloto", {
      user: maskPhone(user),
      motivo: "Pós-SDR não deve mandar no funil, rota ou próxima resposta.",
      lead: buildLeadAuditSnapshot(lead || {}),
      classificacaoPosSdr: classification || {},
      supervisorPosSdr: supervisorAnalysis || {}
    });

    return;
  } catch (error) {
    console.error("⚠️ Consultor pós-SDR passivo falhou, mas atendimento continua:", error.message);
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

TEMA ADICIONAL CONHECIDO — RENDA VITALÍCIA POR INDICAÇÃO:
O Programa Parceiro Homologado oferece 10% de comissão vitalícia sobre vendas
dos parceiros indicados (1 nível, condição: indicado respeitar valor mínimo
de venda sugerido). Esse benefício NÃO existe no Programa de Afiliados.
Se o lead perguntar sobre indicação, comissão por indicação, renda vitalícia,
ou indicar colegas, o tema é VÁLIDO e dentro do escopo do Homologado.
NÃO classificar como "fora de escopo". NÃO confundir com Programa de Afiliados.

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
Use somente quando o histórico mostrar que o lead já entendeu o programa, benefícios, estoque, responsabilidades, investimento/taxa, validou compromisso de atuação e demonstrou intenção real de avançar.

Não use "qualificado_pronto" apenas porque o lead disse "ok", "entendi", "faz sentido", "sim", "podemos seguir" ou resposta curta semelhante.

Se o backend ainda não permitir coleta de dados, prefira "curioso_morno", "analitico", "direto_objetivo" ou "inseguro", conforme o contexto.

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
Demonstra intenção clara de avançar, sem objeção ativa, e o histórico indica que já entendeu os pontos principais do modelo.

Não classifique como quente apenas por curiosidade, resposta curta, educação ou concordância genérica.

Se o lead quer seguir, mas ainda falta confirmar taxa, compromisso ou etapas obrigatórias, use "morno" ou "travado", conforme o caso.

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

5. Se o lead demonstrar vontade de avançar, avalie o contexto inteiro antes de classificar.

Não dependa de frases exatas.

A intenção de avanço pode aparecer de várias formas naturais, mas só deve virar "quente" ou "qualificado_pronto" se o histórico mostrar que:
- o programa foi explicado;
- benefícios foram explicados;
- estoque/comodato foi explicado;
- responsabilidades foram explicadas;
- investimento/taxa foi explicado;
- não existe objeção ativa;
- o lead demonstra continuidade real.

Se ainda faltar alguma etapa obrigatória, classifique como "morno", "analitico", "curioso_morno" ou "direto_objetivo", conforme o comportamento.

6. Se o lead perguntar "qual a pegadinha?", "é golpe?", "tem contrato?", considere perfil desconfiado.

7. Se o lead quiser renda garantida ou dinheiro fácil, considere oportunista ou inseguro, conforme o tom.

8. Se houver pouca informação, use "nao_analisado" ou "sem_intencao_clara" em vez de inventar.

9. A classificação deve se basear em sinais observáveis no histórico.

10. Não use dados pessoais sensíveis para inferir perfil comportamental.

11. Não marque objecaoPrincipal como "preco_taxa_adesao" se o lead não reclamou, não questionou, não resistiu e não demonstrou incômodo com preço, taxa, valor, investimento ou pagamento.

Perguntar "qual é o investimento?", "como paga?", "tem parcelamento?" ou "quando paga?" não é objeção de preço por si só. Pode ser apenas avaliação normal.

12. Não classifique como "travado" se o lead está dizendo que entendeu, que faz sentido ou que quer continuar, sem apresentar objeção nova.

13. Se houver dúvida entre "lead avaliando" e "lead com objeção", prefira:
- temperaturaComercial: "morno"
- objecaoPrincipal: "sem_objecao_detectada"
- intencaoPrincipal: "avaliar_investimento" ou "tirar_duvida"

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

/*
  ETAPA 16.2 — Consultor pós-SDR não pilota mais o funil.

  Explicação simples:
  Antes, depois da SDR responder, o Classificador chamava outro Consultor.
  Esse Consultor salvava "consultoria" no Mongo e podia contaminar
  a próxima mensagem, puxando Homologado ou Afiliado antes da hora.

  Agora:
  - Supervisor pós-SDR continua auditando.
  - Classificador pós-SDR continua classificando para dashboard/análise.
  - Consultor pós-SDR NÃO é mais chamado como piloto.
  - A próxima resposta será guiada pelo Pré-SDR atual e, depois, pelo Orquestrador de Turno.
*/
console.log("ℹ️ Consultor pós-SDR não acionado como piloto:", {
  user,
  motivo: "ETAPA 16.2 — pós-SDR não deve salvar estratégia que mande na próxima resposta.",
  temperaturaComercial: classification?.temperaturaComercial || "nao_analisado",
  intencaoPrincipal: classification?.intencaoPrincipal || "nao_analisado"
});

console.log("✅ Classificador analisou lead:", {
  user,
  temperaturaComercial: classification?.temperaturaComercial || "nao_analisado",
  perfil: classification?.perfilComportamentalPrincipal || "nao_analisado",
  intencaoPrincipal: classification?.intencaoPrincipal || "nao_analisado",
  objecaoPrincipal: classification?.objecaoPrincipal || "sem_objecao_detectada",
  confianca: classification?.confiancaClassificacao || "nao_analisado",
  consultorAcionado: false,
  consultorPosSdrModo: "desativado_como_piloto"
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

TEMA ADICIONAL CONHECIDO — RENDA VITALÍCIA POR INDICAÇÃO:
O Programa Parceiro Homologado oferece 10% de comissão vitalícia sobre vendas
dos parceiros indicados (1 nível, condição: indicado respeitar valor mínimo
de venda sugerido). Esse benefício NÃO existe no Programa de Afiliados.
Se o lead perguntar sobre indicação, comissão por indicação, renda vitalícia,
ou indicar colegas, o tema é VÁLIDO e dentro do escopo do Homologado.
NÃO classificar como "fora de escopo". NÃO confundir com Programa de Afiliados.

━━━━━━━━━━━━━━━━━━━━━━━
REGRAS DE AUDITORIA
━━━━━━━━━━━━━━━━━━━━━━━

REGRA PRIORITÁRIA — HISTÓRICO REAL ACIMA DO STATUS

Antes de apontar erro da SDR, analise o histórico real da conversa.

O status, faseQualificacao, faseFunil e temperatura são sinais auxiliares, mas podem estar atrasados ou inconsistentes com a conversa.

Se houver conflito entre:
- status/fase antigo;
- e o conteúdo real conversado;

priorize o conteúdo real do histórico.

Se o histórico mostrar que a SDR já explicou um tema, não marque como "não explicou" apenas porque o status ainda parece anterior.

Se houver inconsistência entre status e histórico, registre em observacoesTecnicas:
"inconsistencia_status_historico"

Mas NÃO acuse a SDR automaticamente.

REGRA PRIORITÁRIA — TAXA NÃO É ERRO SE O LEAD PERGUNTOU

Não marque "falou_taxa_cedo" quando o lead perguntou diretamente sobre:
- taxa;
- valor;
- preço;
- investimento;
- isenção;
- desconto;
- pagamento;
- parcelamento;
- custo para entrar.

Nesses casos, a SDR deve responder a objeção atual do lead, mesmo que o funil ainda esteja antes da etapa formal de investimento.

Avalie a qualidade da resposta, não o simples fato de ter falado da taxa.

REGRA PRIORITÁRIA — ANCORAGEM DE VALOR

Não marque "nao_ancorou_valor" se a resposta da SDR citou pelo menos dois destes elementos:
- suporte;
- treinamento;
- estrutura da IQG;
- ativação no programa;
- lote inicial em comodato;
- produtos acima de R$ 5.000 em preço de venda;
- margem ou comissão;
- contrato/análise interna;
- pagamento somente depois da análise;
- parcelamento.

Se a resposta citou taxa + comodato + suporte/treinamento ou taxa + lote acima de R$ 5.000, considere que houve ancoragem mínima.

Você pode sugerir melhora, mas não classifique como erro grave.

REGRA PRIORITÁRIA — RESPONSABILIDADES

Não marque "nao_explicou_responsabilidades" se:
- a SDR já explicou responsabilidades no histórico recente;
- ou a pergunta atual do lead era especificamente sobre taxa, isenção, preço ou pagamento;
- ou a SDR indicou que explicaria responsabilidades como próximo passo.

Responsabilidades incluem, entre outros:
- guarda do estoque;
- conservação dos produtos;
- comunicar vendas;
- solicitar reposição;
- atuar comercialmente;
- atender clientes;
- resultado depender da atuação do parceiro.

Não exija que todas as responsabilidades sejam repetidas em toda resposta.

REGRA PRIORITÁRIA — PRÓXIMO PASSO

Não marque "sem_proximo_passo" se a SDR terminou com uma pergunta clara de continuidade, por exemplo:
- "Faz sentido pra você?"
- "Quer que eu explique as responsabilidades?"
- "Podemos seguir?"
- "Quer entender melhor essa parte?"
- "Posso te explicar o próximo ponto?"

A pergunta pode ser melhorada, mas isso não é ausência de próximo passo.

REGRA PRIORITÁRIA — OBJEÇÃO DE TAXA

Quando o lead demonstrar objeção de taxa, preço ou isenção:
- não classifique automaticamente como erro da SDR;
- não classifique automaticamente como risco alto;
- primeiro avalie se a SDR acolheu, explicou o motivo da taxa e trouxe algum valor percebido.

Use risco "alto" apenas se:
- a SDR ignorou a objeção;
- pressionou o lead;
- prometeu ganho;
- pediu pagamento;
- ofereceu Afiliado indevidamente como fuga;
- ou deixou a conversa sem resposta útil.

Se a SDR respondeu parcialmente bem, use no máximo risco "medio" e descreva como oportunidade de melhoria, não como erro grave.

REGRA PRIORITÁRIA — TOM DO RELATÓRIO

O Supervisor deve ser justo, calibrado e proporcional.

Diferencie:
- erro grave;
- pequena falha;
- oportunidade de melhoria;
- falso positivo por status desatualizado.

Não use linguagem acusatória quando a conversa estiver fluindo.

Se a resposta da SDR foi aceitável, mas poderia melhorar, registre:
"oportunidade_melhoria_argumentacao"

em observacoesTecnicas, e não marque múltiplos erros graves.

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

REGRA CRÍTICA:
Lead quente, lead pronto ou lead com alto potencial comercial NÃO é motivo automático para humano.

Também NÃO marque humano automaticamente apenas porque o lead perguntou sobre:
- contrato;
- pagamento;
- boleto;
- desconto;
- condição especial;
- aprovação;
- cobrança;
- assinatura;
- negociação;
- valores;
- parcelamento.

Esses assuntos são sensíveis, mas a SDR pode responder de forma segura e limitada, sem prometer nada e sem sair das regras comerciais.

A SDR deve responder assim:

1. Contrato:
Explicar que a assinatura e a versão oficial do contrato são tratadas após análise interna.

2. Pagamento:
Explicar que nenhum pagamento é feito agora. O pagamento só acontece após análise interna e assinatura do contrato.

3. Boleto:
Não oferecer boleto. Informar apenas PIX ou cartão, conforme disponibilidade.

4. Desconto ou condição especial:
Não prometer desconto. Explicar que qualquer condição fora do padrão depende de avaliação da equipe IQG em etapa posterior.

5. Aprovação:
Não prometer aprovação. Explicar que existe análise interna.

6. Cobrança:
Não pedir pagamento e não tratar como cobrança. Reforçar que é apenas explicação do programa.

Marque necessitaHumano = true SOMENTE quando existir necessidade real de ação humana comercial ou operacional.

Marque necessitaHumano = true apenas se pelo menos uma destas situações acontecer:

1. O lead pediu claramente humano, atendente, consultor, vendedor ou pessoa.

2. O lead demonstrou irritação forte, frustração forte, desconfiança forte, acusação de golpe, reclamação grave ou ameaça de denúncia.

3. Houve erro operacional real que precisa de pessoa:
- PDF prometido não chegou;
- arquivo falhou;
- CRM falhou;
- dados confirmados mas não enviados;
- humano já assumiu ou precisa assumir por bloqueio operacional.

4. A SDR pediu dados indevidamente, pediu pagamento indevidamente, prometeu aprovação, prometeu ganho ou gerou confusão grave que pode prejudicar o lead.

5. O lead está travado em objeção forte e a SDR não conseguiu responder ou entrou em loop repetido.

NÃO marque necessitaHumano como true apenas porque:
- o lead é quente;
- o lead quer seguir;
- o lead confirmou compromisso;
- o lead está pronto para coleta;
- o lead tem alto potencial comercial;
- o lead perguntou sobre contrato;
- o lead perguntou sobre pagamento;
- o lead perguntou sobre desconto;
- o lead perguntou sobre boleto;
- o lead perguntou sobre aprovação;
- o lead perguntou sobre assinatura;
- o Supervisor encontrou uma pequena oportunidade de melhoria;
- o backend parece com status atrasado;
- a SDR repetiu uma pergunta, mas a conversa ainda está saudável.

Se houver problema técnico de estado interno, use observacoesTecnicas, mas mantenha necessitaHumano=false, salvo se isso exigir ação imediata de uma pessoa.

Exemplos de falso humano que devem ser evitados:

Lead:
"sim, está claro. eu me comprometo a atuar nas vendas"

Resposta correta do Supervisor:
necessitaHumano=false
prioridadeHumana="nenhuma"
riscoPerda="baixo"

Lead:
"sim, faz sentido e quero seguir"

Resposta correta do Supervisor:
necessitaHumano=false
prioridadeHumana="nenhuma"
riscoPerda="baixo"

Lead:
"tem desconto?"

Resposta correta do Supervisor:
necessitaHumano=false
prioridadeHumana="nenhuma"
riscoPerda="baixo"
observacoesTecnicas pode indicar: "lead_perguntou_condicao_comercial"

Lead:
"posso pagar no boleto?"

Resposta correta do Supervisor:
necessitaHumano=false
prioridadeHumana="nenhuma"
riscoPerda="baixo"

Lead:
"quando assino o contrato?"

Resposta correta do Supervisor:
necessitaHumano=false
prioridadeHumana="nenhuma"
riscoPerda="baixo"

Lead:
"quero falar com uma pessoa"

Resposta correta do Supervisor:
necessitaHumano=true
prioridadeHumana="alta"

Lead:
"isso parece golpe"

Resposta correta do Supervisor:
necessitaHumano=true
prioridadeHumana="alta" ou "urgente"

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

           // ETAPA 3 PRODUÇÃO — alerta humano só quando existe motivo real.
    // Explicação simples:
    // Não basta o Supervisor dizer "risco alto".
    // Para chamar funcionário, precisa haver necessidade real de humano.
    //
    // Perguntas sobre contrato, pagamento, boleto, desconto, assinatura,
    // aprovação, cobrança ou condição especial NÃO enviam alerta humano sozinhas.
    const textoLeadAlertaSupervisor = String(lastUserText || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    const leadPediuHumanoAlertaSupervisor =
      /\b(humano|atendente|consultor|vendedor|pessoa|alguem|alguém|representante)\b/i.test(lastUserText || "") &&
      /\b(falar|chamar|quero|preciso|pode|passa|me coloca|me chama|atendimento)\b/i.test(lastUserText || "");

    const leadTemRiscoHumanoRealSupervisor =
      leadPediuHumanoAlertaSupervisor ||
      /\b(golpe|fraude|enganacao|enganação|suspeito|desconfiado|nao confio|não confio|palhacada|palhaçada|absurdo|ridiculo|ridículo|vou denunciar|denuncia|denúncia|pdf nao chegou|pdf não chegou|arquivo nao chegou|arquivo não chegou|nao recebi o pdf|não recebi o pdf|nao recebi o arquivo|não recebi o arquivo|material nao chegou|material não chegou|crm falhou|erro no crm|nao encaminhou|não encaminhou)\b/i.test(lastUserText || "");

    const deveEnviarAlertaSupervisor =
      supervisorAnalysis?.necessitaHumano === true &&
      (
        leadTemRiscoHumanoRealSupervisor ||
        ["critico"].includes(supervisorAnalysis?.riscoPerda)
      );

    if (deveEnviarAlertaSupervisor) {
      await sendSupervisorInternalAlert({
        lead: {
          ...(lead || {}),
          user
        },
        supervisorAnalysis
      });
    } else if (
      supervisorAnalysis?.necessitaHumano === true ||
      ["alto", "critico"].includes(supervisorAnalysis?.riscoPerda)
    ) {
      console.log("🔕 Alerta Supervisor bloqueado por trava de proporcionalidade:", {
        user,
        riscoPerda: supervisorAnalysis?.riscoPerda || "nao_analisado",
        necessitaHumano: supervisorAnalysis?.necessitaHumano === true,
        prioridadeHumana: supervisorAnalysis?.prioridadeHumana || "nao_analisado",
        motivo: "Sem pedido humano, sem risco humano real e sem erro operacional crítico."
      });
    }
    // DESATIVADO — Classificador pós-SDR não influencia próxima resposta.
    // Era ~$0.001/turno só para atualizar campo no dashboard.
    // Se quiser reativar, basta restaurar o bloco original.
    console.log("ℹ️ Classificador pós-SDR desativado para reduzir custo LLM:", {
      user,
      motivo: "nao_influencia_proxima_resposta"
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
  /*
    BLOCO 15B:
    Contexto estratégico antigo desativado para a SDR.

    Motivo:
    - Supervisor é auditor pós-SDR e pode gerar falso positivo.
    - Classificador/Consultoria salvos podem estar atrasados.
    - A SDR já recebe a orientação atual do Pré-SDR obrigatório.
    - A SDR também recebe memória conversacional atual.

    Portanto, para evitar contaminação e repetição,
    a SDR não deve receber Supervisor/Classificador/Consultoria antigos
    como system prompt.
  */
  return "";
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
    "consultor interno",
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
    "diagnostico interno",
    "backend",
    "trava",
    "auditoria",
    "revisao obrigatoria",
    "guardfindings",
    "problemas detectados",
    "resposta final",
    "primeira resposta",
    "reescrever",
    "json",
    "system prompt"
  ];

  const metaReviewPatterns = [
    /\bessa resposta\b/i,
    /\besta resposta\b/i,
    /\bessa mensagem\b/i,
    /\besta mensagem\b/i,
    /\bessa abordagem\b/i,
    /\besta abordagem\b/i,
    /\bmantem o foco\b/i,
    /\bmantém o foco\b/i,
    /\bconduz o lead\b/i,
    /\blead para a proxima etapa\b/i,
    /\blead para a próxima etapa\b/i,
    /\bsem pular fases\b/i,
    /\bsem pular etapas\b/i,
    /\brespeitando o funil\b/i,
    /\bfase atual do funil\b/i,
    /\bproxima etapa sem\b/i,
    /\bpróxima etapa sem\b/i,
    /\bprograma parceiro homologado e conduz\b/i,
    /\ba resposta acima\b/i,
    /\bo texto acima\b/i,
    /\bmensagem acima\b/i
  ];

  const hasForbiddenTerm = forbiddenTerms.some(term => normalized.includes(term));
  const hasMetaReviewPattern = metaReviewPatterns.some(pattern => pattern.test(text || ""));

  const hasSuspiciousSeparator =
    /\n\s*---+\s*\n/i.test(text || "") &&
    /\b(resposta|mensagem|abordagem|lead|funil|fase|etapa|foco|conduz|conduzir)\b/i.test(text || "");

  return Boolean(hasForbiddenTerm || hasMetaReviewPattern || hasSuspiciousSeparator);
}

function stripInternalReviewLeakFromReply(text = "") {
  let clean = String(text || "").trim();

  if (!clean) return clean;

  clean = clean.replace(
    /\n\s*---+\s*\n[\s\S]*?(essa resposta|esta resposta|essa mensagem|esta mensagem|essa abordagem|esta abordagem|mant[eé]m o foco|conduz o lead|sem pular fases|sem pular etapas|respeitando o funil)[\s\S]*$/i,
    ""
  ).trim();

  clean = clean.replace(
    /\n+[\s\S]*?(essa resposta|esta resposta|essa mensagem|esta mensagem|essa abordagem|esta abordagem)\s+[\s\S]*?(mant[eé]m|conduz|respeita|evita|garante)\s+[\s\S]*$/i,
    ""
  ).trim();

  const lines = clean.split("\n");

  const safeLines = lines.filter(line => {
    const l = String(line || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

    if (!l) return true;

    const metaLine =
      l.startsWith("essa resposta") ||
      l.startsWith("esta resposta") ||
      l.startsWith("essa mensagem") ||
      l.startsWith("esta mensagem") ||
      l.startsWith("essa abordagem") ||
      l.startsWith("esta abordagem") ||
      l.includes("mantem o foco") ||
      l.includes("conduz o lead") ||
      l.includes("sem pular fases") ||
      l.includes("sem pular etapas") ||
      l.includes("respeitando o funil") ||
      l.includes("fase atual do funil");

    return !metaLine;
  });

  return safeLines.join("\n").trim();
}

function enforceNoInternalLeakBeforeSend(text = "") {
  let clean = stripInternalReviewLeakFromReply(text);

  if (!containsInternalContextLeak(clean)) {
    return clean;
  }

  return "Perfeito 😊 Vou seguir de forma simples e objetiva.\n\nQuer que eu continue te explicando o próximo ponto do Programa Parceiro Homologado?";
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

function isSafeHomologadoComodatoReply({
  lead = {},
  leadText = "",
  respostaFinal = "",
  commercialRouteDecision = null
} = {}) {
  /*
    ETAPA 6 PRODUÇÃO — proteção contra falso positivo Homologado/Afiliado.

    Explicação simples:
    No Parceiro Homologado, é correto dizer:
    - o parceiro não compra o estoque;
    - o estoque é em comodato;
    - o lote é cedido pela IQG;
    - os produtos continuam sendo da IQG até a venda;
    - a reposição pode ser em comodato.

    Isso NÃO é Programa de Afiliados.

    Afiliado é outra coisa:
    - link;
    - comissão online;
    - cadastro em minhaiqg.com.br;
    - sem estoque físico.
  */

  const rota =
    commercialRouteDecision?.rota ||
    lead?.rotaComercial ||
    lead?.origemConversao ||
    "homologado";

  const resposta = String(respostaFinal || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const leadMsg = String(leadText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const estaEmHomologado =
    rota === "homologado" ||
    commercialRouteDecision?.deveManterHomologado === true ||
    lead?.interesseAfiliado !== true;

  const falaComodatoHomologado =
    resposta.includes("comodato") ||
    resposta.includes("lote inicial") ||
    resposta.includes("estoque inicial") ||
    resposta.includes("estoque em comodato") ||
    resposta.includes("cedido pela iqg") ||
    resposta.includes("cedido em comodato") ||
    resposta.includes("continua sendo da iqg") ||
    resposta.includes("produtos continuam sendo da iqg") ||
    resposta.includes("nao compra esse estoque") ||
    resposta.includes("não compra esse estoque") ||
    resposta.includes("nao precisa comprar o estoque") ||
    resposta.includes("não precisa comprar o estoque") ||
    resposta.includes("reposicao em comodato") ||
    resposta.includes("reposição em comodato");

  const misturaAfiliadoReal =
    resposta.includes("minhaiqg.com.br") ||
    resposta.includes("link de afiliado") ||
    resposta.includes("link exclusivo") ||
    resposta.includes("cadastro de afiliado") ||
    resposta.includes("programa de afiliados") ||
    resposta.includes("comissao online") ||
    resposta.includes("comissão online") ||
    resposta.includes("divulgar por link") ||
    resposta.includes("venda pelo seu link");

  const leadPediuAfiliadoOuComparacao =
    leadMsg.includes("afiliado") ||
    leadMsg.includes("afiliados") ||
    leadMsg.includes("link") ||
    leadMsg.includes("comissao") ||
    leadMsg.includes("comissão") ||
    leadMsg.includes("divulgar online") ||
    leadMsg.includes("sem estoque") ||
    leadMsg.includes("qual a diferenca") ||
    leadMsg.includes("qual a diferença") ||
    leadMsg.includes("os dois");

  return Boolean(
    estaEmHomologado &&
    falaComodatoHomologado &&
    !misturaAfiliadoReal &&
    !leadPediuAfiliadoOuComparacao
  );
}

function isClearlyHomologadoOnlyReply({
  lead = {},
  leadText = "",
  respostaFinal = "",
  commercialRouteDecision = null
} = {}) {
  /*
    ETAPA 14.5A — calibração da anti-mistura.

    Explicação simples:
    A anti-mistura estava chamando o GPT para revisar respostas boas
    e o GPT estava acusando mistura onde não existia mistura real.

    Aqui fazemos uma aprovação local simples:
    se a resposta fala apenas do caminho Homologado, sem elementos reais
    de Afiliado, não precisa chamar o GPT anti-mistura.
  */

  const resposta = String(respostaFinal || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const leadMsg = String(leadText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const rota =
    commercialRouteDecision?.rota ||
    lead?.rotaComercial ||
    lead?.origemConversao ||
    "homologado";

  const estaEmHomologado =
    rota === "homologado" ||
    commercialRouteDecision?.deveManterHomologado === true ||
    lead?.interesseAfiliado !== true;

  const leadPediuAfiliadoOuComparacao =
    leadMsg.includes("afiliado") ||
    leadMsg.includes("afiliados") ||
    leadMsg.includes("link") ||
    leadMsg.includes("comissao") ||
    leadMsg.includes("comissão") ||
    leadMsg.includes("divulgar online") ||
    leadMsg.includes("sem estoque") ||
    leadMsg.includes("qual a diferenca") ||
    leadMsg.includes("qual a diferença") ||
    leadMsg.includes("os dois") ||
    leadMsg.includes("duas opcoes") ||
    leadMsg.includes("duas opções");

  const respostaTemHomologadoOuPrograma =
    resposta.includes("parceria comercial") ||
    resposta.includes("parceiro homologado") ||
    resposta.includes("programa") ||
    resposta.includes("vender produtos") ||
    resposta.includes("produtos fisicos") ||
    resposta.includes("produtos físicos") ||
    resposta.includes("direto da industria") ||
    resposta.includes("direto da indústria") ||
    resposta.includes("suporte") ||
    resposta.includes("treinamento") ||
    resposta.includes("comodato") ||
    resposta.includes("lote inicial") ||
    resposta.includes("pronta-entrega") ||
    resposta.includes("demonstracao") ||
    resposta.includes("demonstração");

  const respostaTemAfiliadoReal =
    resposta.includes("minhaiqg.com.br") ||
    resposta.includes("link de afiliado") ||
    resposta.includes("link exclusivo") ||
    resposta.includes("cadastro de afiliado") ||
    resposta.includes("programa de afiliados") ||
    resposta.includes("comissao por link") ||
    resposta.includes("comissão por link") ||
    resposta.includes("comissao online") ||
    resposta.includes("comissão online") ||
    resposta.includes("divulgar por link") ||
    resposta.includes("venda pelo seu link") ||
    resposta.includes("gerar seus links") ||
    resposta.includes("sem estoque fisico") ||
    resposta.includes("sem estoque físico");

  const respostaPedeDados =
    replyAsksPersonalData(respostaFinal) ||
    /\b(cpf|nome completo|telefone|cidade|estado|uf)\b/i.test(respostaFinal || "");

  const respostaMencionaPreAnalise =
    /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal || "");

  const respostaMisturaTaxaComAfiliado =
    respostaTemAfiliadoReal &&
    (
      resposta.includes("1990") ||
      resposta.includes("1.990") ||
      resposta.includes("taxa") ||
      resposta.includes("adesao") ||
      resposta.includes("adesão") ||
      resposta.includes("pre-analise") ||
      resposta.includes("pré-analise") ||
      resposta.includes("pre analise") ||
      resposta.includes("pré análise")
    );

  return Boolean(
    estaEmHomologado &&
    respostaTemHomologadoOuPrograma &&
    !respostaTemAfiliadoReal &&
    !respostaPedeDados &&
    !respostaMencionaPreAnalise &&
    !respostaMisturaTaxaComAfiliado &&
    !leadPediuAfiliadoOuComparacao
  );
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

  // ETAPA 14.5A — aprovação local antes de chamar GPT anti-mistura.
  // Se a resposta é claramente Homologado e não tem elementos reais de Afiliado,
  // não chamamos o GPT revisor, porque ele vinha gerando falso positivo.
  if (
    isClearlyHomologadoOnlyReply({
      lead,
      leadText,
      respostaFinal,
      commercialRouteDecision
    })
  ) {
    return {
      changed: false,
      respostaFinal,
      motivo:
        "Resposta aprovada localmente: fala somente do Homologado e não contém elementos reais de Afiliado."
    };
  }

  // ETAPA 6 PRODUÇÃO — não chamar GPT anti-mistura quando a resposta
  // está claramente falando de comodato correto dentro do Homologado.
  if (
    isSafeHomologadoComodatoReply({
      lead,
      leadText,
      respostaFinal,
      commercialRouteDecision
    })
  ) {
    return {
      changed: false,
      respostaFinal,
      motivo:
        "Resposta aprovada localmente: comodato/estoque cedido é regra correta do Parceiro Homologado, não mistura com Afiliado."
    };
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

REGRA CRÍTICA — COMODATO NO HOMOLOGADO:
No Parceiro Homologado é CORRETO dizer que:
- o parceiro não compra o estoque;
- o parceiro não precisa investir em estoque;
- o lote inicial é cedido em comodato;
- o estoque continua sendo da IQG até a venda;
- a reposição pode ser feita em comodato;
- o parceiro atua com produto físico, pronta-entrega e demonstração.

Essas frases NÃO são mistura com Afiliado.
Não marque hasRouteMix apenas porque a resposta diz que o parceiro não compra estoque ou que o estoque é cedido em comodato.

Só marque mistura se a resposta de Homologado também trouxer elementos reais de Afiliado sem o lead pedir, como:
- link de afiliado;
- cadastro em minhaiqg.com.br;
- comissão por link;
- divulgação online como rota principal;
- venda sem estoque físico no sentido de Afiliado;
- Programa de Afiliados como alternativa sem contexto.

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
- Responda SOMENTE com a mensagem final que será enviada ao lead.
- Não coloque explicação depois da mensagem.
- Não coloque justificativa sobre por que a resposta está correta.
- Não use separador "---".
- Não escreva frases como "Essa resposta mantém...", "Esta mensagem conduz..." ou "A abordagem evita...".
- Não explique estratégia, funil, fase, foco, condução ou motivo da resposta.
- Tudo que você escrever será enviado diretamente no WhatsApp do lead.
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
💰 TABELA DE PREÇOS / E-COMMERCE IQG
━━━━━━━━━━━━━━━━━━━━━━━

Se o lead pedir:
- tabela de preços;
- tabela de valores;
- lista de preços;
- preço dos produtos;
- valores dos produtos;
- tabela do parceiro;
- tabela de revenda;
- preço para parceiro;
- quanto custa cada produto;

a SDR deve responder com transparência:

1. A tabela de preços oficial para parceiro é enviada após a fase contratual.

2. No pré-atendimento, a IQG evita enviar tabela de preços porque os preços podem oscilar, e a indústria também realiza promoções com frequência.

3. Se o lead quiser conhecer os preços antes, ele pode acessar o e-commerce oficial da IQG:
https://www.loja.industriaquimicagaucha.com.br/

4. A IQG busca padronizar os preços do e-commerce com outros marketplaces e também com a condição comercial do Parceiro Homologado, para evitar ruídos e manter todos com a mesma referência comercial.

5. A SDR deve tranquilizar o lead dizendo que os Parceiros Homologados podem ficar tranquilos, porque a IQG sempre busca ofertar ótimas condições de preço para que eles sejam competitivos comercialmente e cresçam junto com a indústria.

6. A SDR NÃO deve prometer preço fixo.

7. A SDR NÃO deve inventar tabela, desconto, valor por item ou condição especial.

8. A SDR NÃO deve enviar catálogo ou PDF como se fosse tabela de preços.

9. A SDR NÃO deve dizer que não existe tabela. Deve dizer que a tabela oficial é tratada após a fase contratual.

Resposta base quando o lead pedir tabela de preços:

"A tabela oficial de preços para parceiro é enviada após a fase contratual 😊

No pré-atendimento, a IQG evita enviar tabela porque os preços podem oscilar e frequentemente temos promoções.

Mas, se você quiser conhecer nossos preços antes, pode acessar nosso e-commerce oficial:
https://www.loja.industriaquimicagaucha.com.br/

A IQG procura manter os preços padronizados entre e-commerce, marketplaces e a condição comercial do Parceiro Homologado, justamente para evitar ruídos e manter uma referência justa para todos.

E pode ficar tranquilo: o objetivo é sempre oferecer boas condições para que o parceiro seja competitivo e consiga crescer junto com a indústria."

━━━━━━━━━━━━━━━━━━━━━━━
🏭 LINHAS DE PRODUTOS IQG — CONTEXTO INSTITUCIONAL
━━━━━━━━━━━━━━━━━━━━━━━

A IQG é uma indústria química com várias linhas de produtos.

Além da linha de piscinas, a IQG também trabalha com outras linhas, como:

- cosméticos veterinários para cães e gatos, como shampoos e condicionadores;
- produtos de desinfecção para equipamentos de ordenha;
- produtos desincrustantes e detergentes;
- produtos para pré e pós dipping;
- linha agro;
- adjuvantes agrícolas;
- oxidantes de matérias orgânicas;
- adubos foliares.

REGRA CRÍTICA:

O Programa Parceiro Homologado IQG, neste início, está sendo conduzido com foco principal na linha de piscinas.

A SDR deve deixar claro que:

- a IQG possui outras linhas;
- o escopo inicial do Parceiro Homologado é a linha de piscinas;
- com o passar do tempo, a IQG poderá disponibilizar outras linhas aos parceiros;
- a liberação de outras linhas depende de estratégia, disponibilidade, evolução comercial e orientação da equipe IQG.

A SDR NÃO deve dizer que a IQG trabalha somente com piscinas.

A SDR NÃO deve negar a existência de outras linhas.

A SDR NÃO deve prometer que todas as linhas estarão disponíveis imediatamente ao Parceiro Homologado.

A SDR NÃO deve prometer estoque, comodato, comissão, catálogo, preço ou liberação comercial de outras linhas sem confirmação.

Se o lead perguntar sobre outras linhas, responder de forma clara e segura:

"A IQG realmente trabalha com outras linhas além de piscinas, como pet, agro, ordenha e desinfecção. Mas o Programa Parceiro Homologado, neste início, está sendo estruturado principalmente com a linha de piscinas. Com o tempo, a IQG pode disponibilizar outras linhas aos parceiros conforme evolução e estratégia comercial."

Depois, conduzir de volta ao fluxo correto:

"Quer que eu te explique como funciona o modelo inicial com a linha de piscinas?"

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
- O lead pode encontrar diferentes linhas/produtos IQG no ambiente de afiliados ou e-commerce, conforme disponibilidade.
- A SDR não deve prometer que todas as linhas da IQG estarão disponíveis ao afiliado.
- A SDR não deve prometer comissão específica por linha sem confirmação.
- Se o lead perguntar sobre produtos específicos no Afiliados, orientar que ele consulte os produtos disponíveis no site/ambiente de cadastro.

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

━━━━━━━━━━━━━━━━━━━━━━━
🔥 REGRA CRÍTICA DE AVANÇO — VERSÃO ALIVIADA APÓS TAXA
━━━━━━━━━━━━━━━━━━━━━━━

A SDR deve conduzir o lead pelas etapas do funil:
programa → benefícios → estoque → responsabilidades → investimento → coleta.

Porém, a etapa crítica é o investimento/taxa.

Depois que TODAS as etapas anteriores foram conduzidas e a taxa de adesão foi explicada com clareza, qualquer sinal de continuidade pode permitir avanço para a pré-análise.

Isso não autoriza pular benefícios, estoque, responsabilidades ou investimento.

O alívio é apenas sobre o aceite formal do lead em cada etapa, não sobre a obrigação da SDR passar por cada etapa.
Sinais de continuidade podem ser simples, como:
"sim", "ok", "entendi", "beleza", "tranquilo", "pode seguir", "nenhuma dúvida", "vamos", "bora", "faz sentido".

Nesses casos, a SDR NÃO deve repetir taxa, responsabilidades ou benefícios.

Se o backend permitir coleta, a SDR deve avançar de forma objetiva:

"Perfeito 😊 Vamos seguir então.

Primeiro, pode me enviar seu nome completo?"

Se o lead trouxer objeção clara sobre taxa, risco, estoque ou decisão, aí sim a SDR deve responder a objeção antes de avançar.

Regra central:
Conduzir pelas etapas é obrigatório.
Exigir aceite formal do lead em cada etapa NÃO é obrigatório.

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

BENEFÍCIO DE INDICAÇÃO (RENDA VITALÍCIA) — EXCLUSIVO DO PARCEIRO HOMOLOGADO:
- O Parceiro Homologado pode indicar novos parceiros para o Programa Homologado.
- Recebe 10% de comissão vitalícia sobre tudo o que o indicado vender, enquanto o indicado estiver ativo.
- Apenas 1 nível de indicação (sem multinível, sem pirâmide).
- Condição: o parceiro indicado precisa respeitar o valor mínimo de venda sugerido pela IQG.
- Controle: relatórios semanais de liquidação enviados em PDF ao parceiro indicador.
- Em breve: acompanhamento em tempo real via aplicativo.

PERFIL QUE MAIS SE BENEFICIA:
Piscineiros e profissionais com forte rede no setor. Existem parceiros homologados
que pagam a taxa de adesão, optam por NÃO receber o lote em comodato, e faturam
exclusivamente indicando colegas para o programa. É um modelo legítimo e estratégico.
Quando o lead for piscineiro, apresentar essa possibilidade proativamente como
benefício estratégico do programa.

REGRA ANTI-MISTURA (CRÍTICA):
- Este benefício pertence APENAS ao Programa Parceiro Homologado.
- NUNCA chamar de "link de afiliado", "Programa de Afiliados" ou "indicar pelo link".
- NUNCA migrar o lead para Afiliados quando ele perguntar sobre indicação.
- Se o lead estiver na rota Afiliados e perguntar sobre essa renda, explicar
  que este benefício específico é do Programa Homologado.

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

REGRA CRÍTICA SOBRE PREÇO DE PRODUTOS INDIVIDUAIS (FASE DE ESTOQUE):

Quando o lead perguntar o preço, valor ou quanto custa cada produto do lote:
- NUNCA listar preço de produto individual.
- NUNCA usar placeholder como "R$ XX,XX", "R$ --" ou valores fictícios.
- NUNCA inventar tabela de preços na resposta.
- NUNCA dizer "os preços estão na faixa de" seguido de valores inventados.

A resposta correta é:
1. Explicar que os preços variam constantemente e são atualizados com frequência pela IQG.
2. As tabelas oficiais de preço serão sempre atualizadas e enviadas ao parceiro após a efetivação da parceria.
3. Para ter uma ideia dos preços atuais, indicar o e-commerce oficial: https://www.loja.industriaquimicagaucha.com.br/
4. Reforçar que a IQG tem compromisso com preços comercialmente competitivos e qualidade acima do mercado.
5. Tranquilizar o parceiro dizendo que a IQG busca sempre oferecer condições que permitam ao parceiro ser competitivo e crescer junto com a indústria.

Exemplo correto:
"Os preços dos produtos variam com frequência e a IQG trabalha com atualizações constantes. A tabela oficial de preços para parceiro é enviada após a efetivação da parceria 😊

Para ter uma boa ideia dos preços atuais, você pode consultar nosso e-commerce:
https://www.loja.industriaquimicagaucha.com.br/

E pode ficar tranquilo: a IQG tem compromisso com preços competitivos e qualidade acima do mercado, justamente para que o parceiro consiga atuar de forma forte comercialmente."

Exemplo ERRADO (nunca responder assim):
"IQG Clarificante 1L: R$ XX,XX"
"Os preços estão na faixa de R$ 15 a R$ 90"
"O valor sugerido do Clarificante é R$ 29,90"


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

REGRA OBRIGATÓRIA SOBRE FRETE E ENVIO:

O primeiro envio (lote/kit inicial) tem o frete custeado pela IQG.
O parceiro não paga frete para receber o kit inicial.

As reposições posteriores: os produtos continuam sendo cedidos em comodato (o parceiro não compra os produtos), mas o frete das reposições é custeado pelo parceiro.

A SDR deve explicar isso com clareza sempre que o lead perguntar sobre frete, envio, entrega, transporte ou custo de reposição.

Regras obrigatórias:
- NÃO dizer que o frete é sempre grátis.
- NÃO dizer que a IQG paga todos os fretes em todas as reposições.
- NÃO dizer que não existe custo de envio nas reposições.
- NÃO dizer que o parceiro paga pelos produtos das reposições (os produtos são sempre comodato).
- SEMPRE separar claramente: produto = comodato (sem compra); frete da reposição = por conta do parceiro.

Exemplo correto quando o lead perguntar sobre frete:
"O envio do lote inicial é por conta da IQG, então você não paga frete para receber o kit 😊 Nas reposições seguintes, os produtos continuam sendo cedidos em comodato, ou seja, você não compra o estoque. Mas o frete de envio das reposições fica por conta do parceiro."

Exemplo correto quando o lead perguntar se paga pelo envio da reposição:
"Os produtos das reposições continuam sendo em comodato, então você não compra o estoque. Mas o frete de envio das reposições é custeado pelo parceiro. Só o primeiro envio do kit inicial tem frete por conta da IQG."

Exemplo ERRADO (nunca responder assim):
"Você não paga pelo envio da reposição do estoque."
"A IQG se responsabiliza pelo envio das reposições."
"Você não precisará pagar o frete do envio das mercadorias, tanto no recebimento do lote inicial quanto na reposição."

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
- só no final da mensagem
- linha separada
- nunca explicar o comando ao lead
- nunca duplicar envio do mesmo arquivo na mesma conversa

━━━━━━━━━━━━━━━━━━━━━━━
📦 QUANDO ENVIAR CADA ARQUIVO
━━━━━━━━━━━━━━━━━━━━━━━

CATÁLOGO DE PRODUTOS:
Quando o lead pedir catálogo, lista de produtos, tabela de produtos, quiser ver os produtos, perguntar quais produtos a IQG tem, ou demonstrar curiosidade sobre os itens disponíveis:
- Responder que vai enviar o catálogo de produtos de piscina da IQG.
- Enviar: [ACTION:SEND_CATALOGO]
- Não recusar envio de catálogo.
- Não dizer que o catálogo só vem depois.
- O catálogo é material de apresentação, não é tabela de preços.

MODELO DE CONTRATO:
Quando o lead pedir contrato, modelo de contrato, quiser ler o contrato, perguntar sobre cláusulas, regras contratuais ou quiser entender o contrato antes de avançar:
- Responder que vai enviar o modelo de contrato para leitura prévia.
- Explicar que a versão oficial para assinatura é liberada após análise cadastral da equipe IQG.
- Enviar: [ACTION:SEND_CONTRATO]
- Não recusar envio do modelo.
- Não dizer que o contrato só vem após assinatura.
- O modelo serve para o lead ler e entender as regras antes de decidir.

KIT PARCEIRO / LISTA DO LOTE INICIAL:
Quando o lead perguntar o que vem no kit, quais produtos recebe, o que tem no lote, lista do estoque inicial:
- Enviar: [ACTION:SEND_KIT]

MANUAL PRÁTICO DO PISCINEIRO / CURSO / TREINAMENTO:
Quando o lead disser que:
- não entende de piscina;
- não sabe tratar água de piscina;
- nunca trabalhou com piscina;
- quer aprender sobre tratamento de piscina;
- perguntar se tem curso;
- perguntar se tem treinamento;
- perguntar se tem material de estudo;
- perguntar como usar os produtos;
- demonstrar insegurança sobre conhecimento técnico;

a SDR deve:
1. Explicar que a IQG oferece treinamento e suporte ao parceiro.
2. Dizer que vai enviar um manual prático de tratamento de piscina que ajuda a entender como usar os produtos e quando aplicar cada um.
3. Enviar: [ACTION:SEND_MANUAL]
4. NUNCA dizer que a IQG não oferece curso ou treinamento. A IQG OFERECE treinamento e suporte.
5. NUNCA dizer que o parceiro precisa já saber tratar piscina antes de entrar.

FOLDER DO PROGRAMA:
Envio obrigatório na fase de benefícios.
- Enviar: [ACTION:SEND_FOLDER]

━━━━━━━━━━━━━━━━━━━━━━━
⚠️ REGRA CRÍTICA SOBRE MATERIAIS
━━━━━━━━━━━━━━━━━━━━━━━

A SDR NUNCA deve:
- Recusar envio de catálogo quando o lead pedir.
- Recusar envio de modelo de contrato quando o lead pedir.
- Dizer que a IQG não oferece curso, treinamento ou capacitação.
- Dizer que o manual não existe.
- Dizer que o catálogo só vem depois do contrato.
- Dizer que o contrato só vem depois da assinatura.

A SDR SEMPRE deve:
- Enviar o material solicitado pelo lead.
- Contextualizar brevemente o material antes de enviar.
- Depois de enviar, continuar a condução do funil normalmente.

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

A SDR NÃO deve depender de frases exatas para entender interesse real.

Não faça:
- se o lead disser exatamente "quero entrar", então avançar;
- se o lead disser exatamente "vamos seguir", então avançar;
- se o lead disser exatamente "tenho interesse", então avançar.

O correto é interpretar o contexto da conversa.

Interesse real pode aparecer de várias formas naturais, como:
- o lead demonstra que entendeu a explicação;
- o lead responde de forma positiva depois da explicação da taxa;
- o lead demonstra disposição para continuar;
- o lead pergunta qual é o próximo passo;
- o lead aceita seguir com a análise;
- o lead confirma que está confortável com o modelo;
- o lead demonstra compromisso com atuação, vendas ou responsabilidades;
- o lead não apresenta objeção nova depois da explicação principal.

A SDR deve considerar:
1. qual foi a última explicação feita;
2. se o lead demonstrou entendimento;
3. se existe objeção ativa;
4. se o backend já permite avançar;
5. se o lead está apenas respondendo curto ou realmente dando continuidade.

Exemplos de respostas que podem indicar continuidade, dependendo do contexto:
- "certo, podemos continuar";
- "tá claro pra mim";
- "entendi, pode seguir";
- "me parece viável";
- "estou pronto";
- "pode prosseguir";
- "beleza, vamos adiante";
- "tranquilo";
- "sem problema";
- "faz sentido";
- "ok, pode continuar".

Essas respostas NÃO devem ser tratadas como palavras mágicas.
Elas só indicam avanço se o histórico e a fase atual confirmarem que o lead entendeu o ponto anterior e não trouxe objeção nova.

Se o backend permitir coleta, a SDR pode avançar de forma objetiva.

Se o backend não permitir coleta, a SDR deve validar apenas a menor pendência obrigatória com uma pergunta curta, sem repetir explicações longas.

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

A SDR NÃO deve encaminhar humano automaticamente só porque o lead perguntou sobre:
- contrato;
- jurídico;
- pagamento;
- boleto;
- desconto;
- condição especial;
- aprovação;
- cobrança;
- assinatura;
- avalista;
- parcelamento;
- valores.

Esses assuntos são sensíveis, mas a SDR deve responder de forma segura, limitada e sem prometer nada.

Como responder:

1. Contrato:
Explicar que a versão oficial e a assinatura do contrato são tratadas após análise interna.

2. Jurídico:
Não dar parecer jurídico. Responder de forma simples que os detalhes formais são tratados na etapa contratual, após análise interna.

3. Pagamento:
Explicar que nenhum pagamento é feito agora. O pagamento só acontece depois da análise interna e assinatura do contrato.

4. Boleto:
Não oferecer boleto. Informar apenas que, conforme disponibilidade, o pagamento pode ser via PIX ou cartão.

5. Desconto ou condição especial:
Não prometer desconto. Explicar que qualquer condição fora do padrão depende de avaliação posterior da equipe IQG.

6. Aprovação:
Não prometer aprovação. Explicar que existe análise interna.

7. Cobrança:
Não tratar como cobrança. Reforçar que neste momento é apenas explicação do programa.

8. Avalista:
Não pedir avalista. Se o lead perguntar, explicar que a SDR não solicita esse tipo de informação no pré-atendimento e que detalhes contratuais são tratados depois pela equipe IQG.

Encaminhar humano somente se:
- o lead pedir claramente para falar com uma pessoa, consultor, vendedor ou atendente;
- o lead demonstrar irritação forte, acusar golpe, ameaçar denúncia ou demonstrar desconfiança grave;
- houver erro operacional real, como PDF prometido e não enviado, falha de arquivo ou falha de CRM;
- a SDR tiver pedido pagamento indevidamente, prometido aprovação, prometido ganho ou criado confusão grave;
- houver loop repetido em objeção forte que a IA não conseguiu resolver.

Regra central:
Pergunta sensível não é humano automático.
Pedido claro de humano, risco grave ou erro operacional real é humano.

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

function sanitizeWhatsAppText(text = "") {
  let cleanText = String(text || "");

  // Corrige links em Markdown:
  // [https://minhaiqg.com.br/](https://minhaiqg.com.br/)
  // vira:
  // https://minhaiqg.com.br/
  cleanText = cleanText.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi,
    "$2"
  );

  // Corrige links Markdown com texto diferente:
  // [clique aqui](https://minhaiqg.com.br/)
  // também vira apenas:
  // https://minhaiqg.com.br/
  cleanText = cleanText.replace(
    /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi,
    "$1"
  );

  // Remove pontuação grudada logo após links.
  // Exemplo:
  // https://minhaiqg.com.br/.
  // vira:
  // https://minhaiqg.com.br/
  cleanText = cleanText.replace(
    /(https?:\/\/[^\s]+?)([.,;:!?]+)(?=\s|$)/gi,
    "$1"
  );

  // Limpa espaços excessivos sem destruir quebras de linha.
  cleanText = cleanText
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .trim();

  return cleanText;
}

async function sendWhatsAppMessage(to, body) {
  const cleanBody = sanitizeWhatsAppText(body);

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
      text: { body: cleanBody }
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

function buildConsultantCrmMessage(lead = {}) {
  const leadPhone = onlyDigits(lead.telefoneWhatsApp || lead.user || lead.telefone || "");
  const whatsappLink = leadPhone ? `https://wa.me/${leadPhone}` : "-";

  const nome = lead.nome || lead.nomeWhatsApp || "Não informado";
  const cpf = lead.cpf || "Não informado";
  const telefone = lead.telefone || lead.telefoneWhatsApp || lead.user || "Não informado";
  const cidade = lead.cidade || "Não informada";
  const estado = lead.estado || "Não informado";

  const rota =
    lead.rotaComercial ||
    lead.origemConversao ||
    "homologado";

  const etapas = lead.etapas || {};

  return `🔥 Novo pré-cadastro Parceiro Homologado IQG

Lead: ${nome}
WhatsApp: ${leadPhone || "-"}
Link: ${whatsappLink}

Dados confirmados:
Nome: ${nome}
CPF: ${cpf}
Telefone: ${telefone}
Cidade/UF: ${cidade}/${estado}

Status comercial:
Rota: ${rota}
Taxa alinhada: ${lead.taxaAlinhada === true ? "sim" : "não"}
Compromisso: ${etapas.compromisso === true ? "sim" : "não"}
Interesse real: ${lead.interesseReal === true ? "sim" : "não"}

Observação:
O lead confirmou os dados no WhatsApp. Validar informações, tirar dúvidas finais e orientar a finalização da adesão.`;
}

async function notifyConsultant(lead) {
  /*
    ETAPA 9 PRODUÇÃO — notificação real ao consultor.

    Explicação simples:
    Se não tiver CONSULTANT_PHONE configurado, não existe para onde enviar.
    Então isso precisa ser erro, não silêncio.
  */

  if (!process.env.CONSULTANT_PHONE) {
    throw new Error("CONSULTANT_PHONE não configurado. Não foi possível notificar o consultor.");
  }

  const message = buildConsultantCrmMessage(lead || {});

  await sendWhatsAppMessage(process.env.CONSULTANT_PHONE, message);

  console.log("📣 Consultor notificado com pré-cadastro confirmado:", {
    user: lead?.user || lead?.telefoneWhatsApp || "-",
    nome: lead?.nome || "-",
    telefone: lead?.telefone || lead?.telefoneWhatsApp || "-",
    rota: lead?.rotaComercial || lead?.origemConversao || "homologado"
  });

  return {
    ok: true,
    consultantPhone: process.env.CONSULTANT_PHONE
  };
}
async function sendWhatsAppDocument(to, file) {
  /*
    ETAPA 7 PRODUÇÃO — envio rastreável de documento.

    Explicação simples:
    Esta função baixa o PDF, sobe para o WhatsApp e envia ao lead.
    Se qualquer parte falhar, ela joga erro.
    Se der certo, ela devolve um comprovante com dados do upload/envio.
  */

  if (!file?.link || !file?.filename) {
    throw new Error("Arquivo inválido: link ou filename ausente.");
  }

  const fileResponse = await fetch(file.link);

  if (!fileResponse.ok) {
    throw new Error(`Erro ao baixar arquivo: ${fileResponse.status}`);
  }

  const contentType = fileResponse.headers?.get?.("content-type") || "";
  const arrayBuffer = await fileResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!buffer || buffer.length === 0) {
    throw new Error("Arquivo baixado vazio.");
  }

  console.log("📄 PDF baixado para envio:", {
    filename: file.filename,
    contentType,
    tamanhoBytes: buffer.length
  });

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

  if (!upload.ok || !uploadData?.id) {
    console.error("Erro ao subir documento para WhatsApp:", uploadData);
    throw new Error("Falha ao subir documento para WhatsApp");
  }

  console.log("📄 PDF subiu para WhatsApp:", {
    filename: file.filename,
    mediaId: uploadData.id
  });

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
          caption: file.caption || ""
        }
      })
    }
  );

  const sendDocumentData = await sendDocument.json();

  if (!sendDocument.ok) {
    console.error("Erro ao enviar documento WhatsApp:", sendDocumentData);
    throw new Error("Falha ao enviar documento WhatsApp");
  }

  console.log("📄 PDF enviado ao WhatsApp com sucesso:", {
    to,
    filename: file.filename,
    mediaId: uploadData.id,
    messageId: sendDocumentData?.messages?.[0]?.id || ""
  });

  return {
    ok: true,
    filename: file.filename,
    mediaId: uploadData.id,
    messageId: sendDocumentData?.messages?.[0]?.id || "",
    response: sendDocumentData
  };
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
  const normalizedText = text.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (normalizedText.includes("contrato")) return "contrato";
  if (normalizedText.includes("catalogo") || normalizedText.includes("catálogo")) return "catalogo";
  if (normalizedText.includes("lista de produtos")) return "catalogo";
  if (normalizedText.includes("quero ver os produtos")) return "catalogo";
  if (normalizedText.includes("produtos disponiveis")) return "catalogo";
  if (normalizedText.includes("kit")) return "kit";
  if (normalizedText.includes("manual")) return "manual";
  if (normalizedText.includes("curso")) return "manual";
  if (normalizedText.includes("treinamento")) return "manual";
  if (normalizedText.includes("nao entendo de piscina")) return "manual";
  if (normalizedText.includes("nao sei tratar")) return "manual";
  if (normalizedText.includes("como tratar piscina")) return "manual";
  if (normalizedText.includes("como tratar agua")) return "manual";
  if (normalizedText.includes("como usar os produtos")) return "manual";
  if (normalizedText.includes("nunca trabalhei com piscina")) return "manual";
  if (normalizedText.includes("aprender sobre piscina")) return "manual";
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

     // Pedido de tabela de preços NÃO é pedido de catálogo/material.
  // A SDR deve responder com orientação sobre e-commerce e fase contratual,
  // não enviar PDF automaticamente.
  if (
    t.includes("tabela de preco") ||
    t.includes("tabela de precos") ||
    t.includes("tabela de valor") ||
    t.includes("tabela de valores") ||
    t.includes("lista de preco") ||
    t.includes("lista de precos") ||
    t.includes("preco dos produtos") ||
    t.includes("precos dos produtos") ||
    t.includes("valor dos produtos") ||
    t.includes("valores dos produtos") ||
    t.includes("tabela do parceiro") ||
    t.includes("tabela de revenda") ||
    t.includes("preco para parceiro") ||
    t.includes("precos para parceiro")
  ) {
    return false;
  }

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

// pedidos de catálogo
    t.includes("catalogo") ||
    t.includes("catálogo") ||
    t.includes("catalogo de produtos") ||
    t.includes("catálogo de produtos") ||
    t.includes("lista de produtos") ||
    t.includes("quero ver os produtos") ||
    t.includes("quais produtos") ||
    t.includes("produtos disponiveis") ||
    t.includes("produtos disponíveis") ||

    // pedidos de contrato
    t.includes("modelo de contrato") ||
    t.includes("contrato") ||
    t.includes("quero ver o contrato") ||
    t.includes("me manda o contrato") ||
    t.includes("tem contrato") ||
    t.includes("clausulas") ||
    t.includes("cláusulas") ||

    // pedidos de manual/curso/treinamento
    t.includes("manual") ||
    t.includes("curso") ||
    t.includes("treinamento") ||
    t.includes("nao entendo de piscina") ||
    t.includes("não entendo de piscina") ||
    t.includes("nao sei tratar") ||
    t.includes("não sei tratar") ||
    t.includes("como usar os produtos") ||
    t.includes("como tratar piscina") ||
    t.includes("como tratar agua") ||
    t.includes("como tratar água") ||
    t.includes("nunca trabalhei com piscina") ||
    t.includes("nao tenho experiencia") ||
    t.includes("não tenho experiência") ||
    t.includes("aprender sobre piscina") ||
    t.includes("material de estudo") ||
     
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

function shouldForceFolderForBenefits({
  lead = {},
  respostaFinal = "",
  actions = [],
  leadText = ""
} = {}) {
  /*
    ETAPA 8 PRODUÇÃO — folder obrigatório em benefícios.

    Explicação simples:
    Se a SDR explicou benefícios do Parceiro Homologado,
    o folder precisa ser enviado.

    Não vamos depender só do GPT lembrar de escrever [ACTION:SEND_FOLDER].
    O backend confere a resposta final e adiciona o comando se faltar.

    Segurança:
    - não envia se já foi enviado;
    - não envia se o lead está em Afiliado;
    - não envia em coleta/CRM/humano;
    - não envia contrato;
    - só força folder do Homologado quando a resposta realmente fala de benefícios/suporte.
  */

  const resposta = String(respostaFinal || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const textoLead = String(leadText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const rotaAfiliado =
    lead?.rotaComercial === "afiliado" ||
    lead?.origemConversao === "afiliado" ||
    lead?.faseFunil === "afiliado" ||
    lead?.faseQualificacao === "afiliado" ||
    lead?.status === "afiliado" ||
    lead?.interesseAfiliado === true;

  if (rotaAfiliado) {
    return false;
  }

  const fluxoProtegido =
    lead?.crmEnviado === true ||
    lead?.botBloqueadoPorHumano === true ||
    lead?.humanoAssumiu === true ||
    lead?.atendimentoHumanoAtivo === true ||
    lead?.dadosConfirmadosPeloLead === true ||
    lead?.faseFunil === "coleta_dados" ||
    lead?.faseFunil === "confirmacao_dados" ||
    lead?.faseFunil === "pre_analise" ||
    lead?.faseFunil === "crm" ||
    lead?.statusOperacional === "em_atendimento" ||
    lead?.statusOperacional === "enviado_crm" ||
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true;

  if (fluxoProtegido) {
    return false;
  }

  const folderJaEnviado =
    lead?.sentFiles?.folder === true ||
    Boolean(lead?.sentFiles?.folder) ||
    Boolean(lead?.sentFileDetails?.folder);

  if (folderJaEnviado) {
    return false;
  }

  if (Array.isArray(actions) && actions.includes("folder")) {
    return false;
  }

  if (resposta.includes("[action:send_folder]")) {
    return false;
  }

    const falaDeBeneficiosHomologado =
    resposta.includes("beneficio") ||
    resposta.includes("beneficios") ||
    resposta.includes("suporte da industria") ||
    resposta.includes("suporte da iqg") ||
    resposta.includes("materiais") ||
    resposta.includes("material explicativo") ||
    resposta.includes("folder") ||
    resposta.includes("vou te enviar um material") ||
    resposta.includes("vou enviar um material") ||
    resposta.includes("te envio um material") ||
    resposta.includes("vou te mandar um material") ||
    resposta.includes("vou mandar um material") ||
    resposta.includes("treinamento") ||
    resposta.includes("treinamentos") ||
    resposta.includes("nao comeca sozinho") ||
    resposta.includes("não começa sozinho") ||
    resposta.includes("estrutura da iqg") ||
    resposta.includes("produtos em comodato") ||
    resposta.includes("pronta-entrega") ||
    resposta.includes("demonstracao") ||
    resposta.includes("demonstração");
  const contextoBeneficios =
    lead?.faseFunil === "beneficios" ||
    lead?.faseQualificacao === "morno" ||
    lead?.etapas?.beneficios === true ||
    lead?.etapasAguardandoEntendimento?.beneficios === true ||
    textoLead.includes("beneficio") ||
    textoLead.includes("beneficios") ||
    textoLead.includes("vantagem") ||
    textoLead.includes("vantagens") ||
    textoLead.includes("suporte") ||
    textoLead.includes("material") ||
    textoLead.includes("folder");

  const respostaMisturaAfiliado =
    resposta.includes("afiliado") ||
    resposta.includes("minhaiqg.com.br") ||
    resposta.includes("link exclusivo") ||
    resposta.includes("divulgar por link") ||
    resposta.includes("comissao por vendas") ||
    resposta.includes("comissão por vendas");

  const leadPediuFolderOuKitExplicitamente =
  hasExplicitFileRequest(leadText) &&
  (detectRequestedFile(leadText) === "folder" || detectRequestedFile(leadText) === "kit");

return Boolean(
  (falaDeBeneficiosHomologado && contextoBeneficios && !respostaMisturaAfiliado) ||
  (leadPediuFolderOuKitExplicitamente && !rotaAfiliado && !fluxoProtegido && !folderJaEnviado)
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
  "porque",
  "desenvolvedor",
  "ao desenvolvedor",
  "mensagem ao",
  "atencao ao",
  "atençao ao",
  "follow-up",
  "followup",
  "contaminado",
  "backend",
  "sistema",
  "nao vou pagar",
  "nao quero pagar",
  "nao tenho interesse",
  "nao e pra mim",
  "nao é pra mim",
  "desisto",
  "quero desistir",
  "tchau"
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

// Se o texto original contém dois pontos, é prefixo de mensagem (ex: "Ao desenvolvedor: ...")
if (raw.includes(":")) {
  return true;
}

// Se o texto original tem muito mais palavras do que o candidato a nome capturado,
// provavelmente é uma frase longa e não um nome
const palavrasTextoOriginal = raw.trim().split(/\s+/).filter(Boolean).length;
if (palavrasTextoOriginal > 6) {
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

// Se o sistema estava esperando nome e o lead enviou algo que parece nome válido,
// sempre sobrescrever o nome anterior (pode estar corrigindo nome errado)
if (
  currentLead?.campoEsperado === "nome" &&
  data.nome &&
  !isInvalidLooseNameCandidate(data.nome) &&
  data.nome.trim().split(/\s+/).length >= 2
) {
  return {
    ...safeCurrentLead,
    ...data,
    nome: data.nome  // força sobrescrita mesmo que já exista nome salvo
  };
}
   
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

   // Bloquear frases de objeção, rejeição ou desistência de virarem nome
  const textoPareceFraseDeObjecaoOuRecusa =
    /\b(nao vou|não vou|nao quero|não quero|nao consigo|não consigo|recuso|desisto|nao pago|não pago|nao aceito|não aceito|nao tenho|não tenho|nao e pra mim|não é pra mim|tchau|obrigado|encerra|pode encerrar)\b/i.test(fullText);

  if (textoPareceFraseDeObjecaoOuRecusa) {
    return {
      ...safeCurrentLead,
      ...data
    };
  }

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

/* =========================
   REGRA COMERCIAL — INDICAÇÃO NO PARCEIRO HOMOLOGADO
   Benefício oficial do Programa Parceiro Homologado IQG.
   Não confundir com Programa de Afiliados.
   ========================= */

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
  !canStartDataCollection(lead || {}) &&
  !hasTaxAcceptedDecisionToCollect(lead || {})
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

   // 4) ETAPA 4 PRODUÇÃO — Classificador não pode marcar lead pronto cedo demais.
  // Explicação simples:
  // O Classificador pode interpretar perfil, mas quem manda na liberação real é o backend.
  // Se o backend ainda não permite coleta, o lead não pode ser "qualificado_pronto".
  const backendPermiteColeta = canStartDataCollection(lead || {});

  const todasEtapasComerciaisConsolidadas =
    etapas.programa === true &&
    etapas.beneficios === true &&
    etapas.estoque === true &&
    etapas.responsabilidades === true &&
    etapas.investimento === true &&
    etapas.compromisso === true &&
    lead?.taxaAlinhada === true &&
    lead?.interesseReal === true;

  const classificadorMarcouProntoCedo =
    !backendPermiteColeta &&
    !todasEtapasComerciaisConsolidadas &&
    (
      safeClassification.perfilComportamentalPrincipal === "qualificado_pronto" ||
      safeClassification.intencaoPrincipal === "avancar_pre_analise" ||
      safeClassification.nivelConsciencia === "alto"
    );

  if (classificadorMarcouProntoCedo) {
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

      nivelConsciencia:
        safeClassification.nivelConsciencia === "alto"
          ? (
              etapas.investimento === true || lead?.taxaAlinhada === true
                ? "medio"
                : "baixo"
            )
          : safeClassification.nivelConsciencia,

      intencaoPrincipal:
        safeClassification.intencaoPrincipal === "avancar_pre_analise"
          ? (
              etapas.investimento === true || lead?.taxaAlinhada === true
                ? "avaliar_investimento"
                : "tirar_duvida"
            )
          : safeClassification.intencaoPrincipal,

      confiancaClassificacao:
        safeClassification.confiancaClassificacao === "alta"
          ? "media"
          : safeClassification.confiancaClassificacao,

      sinaisObservados: [
        ...(Array.isArray(safeClassification.sinaisObservados)
          ? safeClassification.sinaisObservados
          : []),
        "qualificado_pronto_bloqueado_por_backend"
      ],

      resumoPerfil:
        "O Classificador indicou prontidão acima do permitido, mas o backend corrigiu porque a coleta ainda não está liberada ou porque nem todos os requisitos comerciais foram consolidados.",

      classificadoEm: new Date()
    };
  }

  // 5) ETAPA 4 PRODUÇÃO — Classificador não pode inventar objeção de preço.
  // Explicação simples:
  // Se não existe sinal real de objeção de taxa/preço no backend e nem na mensagem atual,
  // não pode marcar objecaoPrincipal como preco_taxa_adesao.
  const classificadorInventouObjecaoPreco =
    safeClassification.objecaoPrincipal === "preco_taxa_adesao" &&
    lead?.sinalObjecaoTaxa !== true &&
    !mensagemTemObjeçãoDePreço;

  if (classificadorInventouObjecaoPreco) {
    return {
      ...safeClassification,

      temperaturaComercial:
        safeClassification.temperaturaComercial === "travado"
          ? (
              lead?.interesseReal === true || lead?.taxaAlinhada === true
                ? "quente"
                : "morno"
            )
          : safeClassification.temperaturaComercial,

      perfilComportamentalPrincipal:
        safeClassification.perfilComportamentalPrincipal === "sensivel_preco"
          ? (
              etapas.investimento === true || lead?.taxaAlinhada === true
                ? "analitico"
                : "curioso_morno"
            )
          : safeClassification.perfilComportamentalPrincipal,

      objecaoPrincipal: "sem_objecao_detectada",

      intencaoPrincipal:
        safeClassification.intencaoPrincipal === "avaliar_investimento" ||
        safeClassification.intencaoPrincipal === "avancar_pre_analise"
          ? safeClassification.intencaoPrincipal
          : "tirar_duvida",

      confiancaClassificacao:
        safeClassification.confiancaClassificacao === "alta"
          ? "media"
          : safeClassification.confiancaClassificacao,

      sinaisObservados: [
        ...(Array.isArray(safeClassification.sinaisObservados)
          ? safeClassification.sinaisObservados
          : []),
        "objecao_preco_removida_por_ausencia_de_sinal_real"
      ],

      resumoPerfil:
        "O Classificador havia marcado objeção de preço, mas o backend removeu porque não havia objeção real de taxa/preço na mensagem atual nem sinal ativo no lead.",

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

  /*
    ETAPA 14.6A — Consultor não deve salvar Homologado cedo demais.

    Explicação simples:
    Quando o lead ainda está apenas em descoberta comercial,
    como "quero renda extra", o Consultor pode orientar a SDR a explicar
    os caminhos, mas NÃO deve salvar Homologado como oferta mais adequada.

    Isso evita contaminar a próxima mensagem caso o lead escolha divulgação online.
  */
  const textoLeadNormalizado = String(lastUserText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const leadAindaNaoEscolheuRota =
    lead?.interesseReal !== true &&
    lead?.interesseAfiliado !== true &&
    lead?.sinalAfiliadoExplicito !== true &&
    lead?.sinalComparacaoProgramas !== true &&
    lead?.dadosConfirmadosPeloLead !== true &&
    lead?.crmEnviado !== true &&
    !lead?.origemConversao;

  const classificacaoSemEscolhaDeRota =
    [
      "sem_intencao_clara",
      "tirar_duvida",
      "nao_analisado",
      ""
    ].includes(classification?.intencaoPrincipal || "") &&
    classification?.perfilComportamentalPrincipal !== "afiliado_digital";

  const mensagemAtualNaoEscolheuRota =
    !/\b(homologado|homologar|parceiro homologado|afiliado|afiliados|link|comissao|comissão|divulgacao online|divulgação online|produto fisico|produto físico|produtos fisicos|produtos físicos|estoque|comodato|kit|pronta entrega|pronta-entrega|opcao 2|opção 2)\b/i.test(textoLeadNormalizado);

  const mensagemGenericaDeRendaOuOportunidade =
    /\b(renda extra|ganhar dinheiro|oportunidade|vender|trabalhar com voces|trabalhar com vocês|representar|renda a mais)\b/i.test(textoLeadNormalizado);

  const consultorPuxouHomologadoCedoDemais =
    safeAdvice.ofertaMaisAdequada === "homologado" &&
    leadAindaNaoEscolheuRota &&
    classificacaoSemEscolhaDeRota &&
    mensagemAtualNaoEscolheuRota &&
    mensagemGenericaDeRendaOuOportunidade;

  if (consultorPuxouHomologadoCedoDemais) {
    return {
      ...safeAdvice,
      estrategiaRecomendada:
        safeAdvice.estrategiaRecomendada === "oferecer_afiliado"
          ? "manter_nutricao"
          : safeAdvice.estrategiaRecomendada || "manter_nutricao",

      ofertaMaisAdequada: "nenhuma_no_momento",
      momentoIdealHumano: "nao_necessario_agora",
      prioridadeComercial:
        safeAdvice.prioridadeComercial === "alta" ||
        safeAdvice.prioridadeComercial === "urgente"
          ? "media"
          : safeAdvice.prioridadeComercial || "media",

      proximaMelhorAcao:
        "Manter descoberta comercial. A SDR deve entender se o lead prefere atuar com produto físico/pronta-entrega ou divulgação online, sem salvar Homologado como escolha ainda.",

      abordagemSugerida:
        "Tom consultivo e leve. Explicar os caminhos de forma curta, sem pressionar e sem pedir dados.",

      argumentoPrincipal:
        "A IQG possui caminhos comerciais diferentes para quem busca renda extra; o ideal é entender qual combina melhor com o perfil do lead.",

      cuidadoPrincipal:
        "Não tratar renda extra como Homologado escolhido. Não tratar renda extra como Afiliado automático. Não falar taxa e não pedir dados.",

      resumoConsultivo:
        "O lead demonstrou interesse comercial genérico, mas ainda não escolheu rota. A consultoria deve manter ofertaMaisAdequada como nenhuma_no_momento até o lead indicar Homologado, Afiliado ou ambos.",

      motivoTravaConsultor:
        "rota_nao_escolhida_bloqueou_homologado_automatico"
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

    // ETAPA 3 PRODUÇÃO — leitura segura de humano real.
  // Explicação simples:
  // Humano só é necessário quando existe pedido real de pessoa,
  // risco grave de confiança, irritação forte ou falha operacional.
  //
  // Perguntas sobre contrato, pagamento, boleto, desconto, assinatura,
  // aprovação ou condição especial NÃO chamam humano automaticamente.
  // A IA deve responder com segurança, sem prometer, sem negociar e sem inventar.
  const textoLeadNormalizadoSupervisor = String(lastUserText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const textoSdrNormalizadoSupervisor = String(lastSdrText || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const leadPediuHumanoSupervisor =
    /\b(humano|atendente|consultor|vendedor|pessoa|alguem|alguém|representante)\b/i.test(lastUserText || "") &&
    /\b(falar|chamar|quero|preciso|pode|passa|me coloca|me chama|atendimento)\b/i.test(lastUserText || "");

  const leadComDesconfiancaForteSupervisor =
    /\b(golpe|fraude|enganacao|enganação|suspeito|desconfiado|nao confio|não confio|medo de cair|picaretagem)\b/i.test(lastUserText || "");

  const leadComIrritacaoForteSupervisor =
    /\b(palhacada|palhaçada|absurdo|ridiculo|ridículo|raiva|irritado|irritada|chateado|chateada|nao gostei|não gostei|parem|para de mandar|me tira|vou denunciar|denuncia|denúncia)\b/i.test(lastUserText || "");

  const erroOperacionalSupervisor =
    /\b(pdf nao chegou|pdf não chegou|arquivo nao chegou|arquivo não chegou|nao recebi o pdf|não recebi o pdf|nao recebi o arquivo|não recebi o arquivo|material nao chegou|material não chegou|link quebrado|erro no crm|crm falhou|nao encaminhou|não encaminhou)\b/i.test(lastUserText || "");

  const assuntoSensivelRespondivelPelaIaSupervisor =
    /\b(contrato|juridico|jurídico|pagamento|boleto|desconto|condicao especial|condição especial|aprovacao|aprovação|cobranca|cobrança|assinatura|assinar|parcelamento|pix|cartao|cartão)\b/i.test(lastUserText || "");

  const leadPositivoSemPedidoHumanoSupervisor =
    (
      lead?.interesseReal === true ||
      lead?.taxaAlinhada === true ||
      lead?.etapas?.compromisso === true ||
      /\b(quero seguir|podemos seguir|pode seguir|estou pronto|estou pronta|faz sentido|ficou claro|me comprometo|vamos seguir|quero continuar)\b/i.test(lastUserText || "")
    ) &&
    !leadPediuHumanoSupervisor &&
    !leadComDesconfiancaForteSupervisor &&
    !leadComIrritacaoForteSupervisor &&
    !erroOperacionalSupervisor;

  const existeMotivoRealParaHumanoSupervisor =
    leadPediuHumanoSupervisor ||
    leadComDesconfiancaForteSupervisor ||
    leadComIrritacaoForteSupervisor ||
    erroOperacionalSupervisor;
   
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

  if (
    leadPositivoSemPedidoHumanoSupervisor &&
    safeSupervisor.necessitaHumano === true &&
    !existeMotivoRealParaHumanoSupervisor
  ) {
    return {
      ...safeSupervisor,
      necessitaHumano: false,
      prioridadeHumana: "nenhuma",
      riscoPerda:
        safeSupervisor.riscoPerda === "critico" || safeSupervisor.riscoPerda === "alto"
          ? "baixo"
          : safeSupervisor.riscoPerda || "baixo",
      pontoTrava:
        safeSupervisor.pontoTrava === "preco" || safeSupervisor.pontoTrava === "taxa_adesao"
          ? "sem_trava_detectada"
          : safeSupervisor.pontoTrava || "sem_trava_detectada",
      leadEsfriou: false,
      motivoEsfriamento: "",
      motivoRisco:
        "Supervisor tentou acionar humano, mas o lead está positivo e não pediu atendimento humano nem apresentou risco real.",
      descricaoErroPrincipal:
        safeSupervisor.descricaoErroPrincipal || "",
      errosDetectados: Array.isArray(safeSupervisor.errosDetectados) &&
        safeSupervisor.errosDetectados.length > 0 &&
        !safeSupervisor.errosDetectados.includes("nenhum_erro_detectado")
          ? safeSupervisor.errosDetectados.filter(erro =>
              ![
                "sem_proximo_passo",
                "falou_taxa_cedo",
                "nao_ancorou_valor"
              ].includes(erro)
            )
          : ["nenhum_erro_detectado"],
      resumoDiagnostico:
        "Correção de proporcionalidade: conversa positiva, sem pedido de humano e sem risco real. Não acionar funcionário interno.",
      observacoesTecnicas: [
        ...(Array.isArray(safeSupervisor.observacoesTecnicas)
          ? safeSupervisor.observacoesTecnicas
          : []),
        "supervisor_humano_falso_positivo_corrigido",
        "lead_positivo_nao_exige_humano"
      ],
      analisadoEm: new Date()
    };
  }

  if (
    ["alto", "critico"].includes(safeSupervisor.riscoPerda) &&
    !existeMotivoRealParaHumanoSupervisor &&
    leadPositivoSemPedidoHumanoSupervisor
  ) {
    return {
      ...safeSupervisor,
      riscoPerda: "baixo",
      necessitaHumano: false,
      prioridadeHumana: "nenhuma",
      pontoTrava: "sem_trava_detectada",
      motivoRisco:
        "Risco alto/crítico removido por trava dura: lead positivo, sem objeção forte, sem pedido humano e sem erro operacional.",
      resumoDiagnostico:
        "Conversa saudável. Se houver algum problema, tratar como observação técnica, não como acionamento humano.",
      observacoesTecnicas: [
        ...(Array.isArray(safeSupervisor.observacoesTecnicas)
          ? safeSupervisor.observacoesTecnicas
          : []),
        "risco_alto_falso_positivo_corrigido"
      ],
      analisadoEm: new Date()
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
    "não quero adesão",
    "quero desistir de tudo",
    "desisto de tudo",
    "obrigado tchau",
    "tchau obrigado",
    "quero sair",
    "pode encerrar tudo",
    "encerra tudo"
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
    // 🚫 Removido do bloqueio do funil (Onda 1):
    //   - "compromisso de atuação" — não é mais etapa obrigatória.
    //   - "interesse real explícito" — não é mais etapa obrigatória.
    // O funil agora libera coleta após: programa, benefícios, estoque,
    // responsabilidades, investimento e taxa alinhada.
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
  const updatedHistory = Array.isArray(history) ? [...history] : [];

  updatedHistory.push({
    role: "user",
    content: isAudio ? `[Áudio transcrito]: ${userText}` : userText,
    createdAt: new Date()
  });

  updatedHistory.push({
    role: "assistant",
    content: botText,
    createdAt: new Date()
  });

  await saveConversation(from, updatedHistory);
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

/* =========================
   MOTOR SEMÂNTICO DA TAXA — IQG
   Corrige bloqueio de coleta após aceite da taxa
========================= */

/* =========================
   PROTEÇÃO CONTRA CONTEXTO CONTAMINADO
   Evita que crítica de condução vire objeção comercial
========================= */

function normalizeContextGuardText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDeveloperOrContextCorrectionMessage(text = "") {
  const t = normalizeContextGuardText(text);

  if (!t) return false;

  /*
    Mensagens técnicas de teste/desenvolvedor.
    Exemplo real:
    "#mensagem ao desenvolvedor: Não falamos sobre investimento e taxa de adesão ainda! Follow-up contaminado!"
  */
  const developerSignal =
    t.includes("#mensagem ao desenvolvedor") ||
    t.includes("mensagem ao desenvolvedor") ||
    t.includes("desenvolvedor") ||
    t.includes("follow-up contaminado") ||
    t.includes("followup contaminado") ||
    t.includes("follow up contaminado") ||
    t.includes("contaminado");

  /*
    Crítica de histórico/contexto.
    Isso não é objeção comercial.
  */
  const contextCorrectionSignal =
    /\b(nao falamos|não falamos|ainda nao falamos|ainda não falamos|voce pulou|você pulou|pulou etapa|fora de contexto|sem contexto|nao foi explicado|não foi explicado|voce nao explicou|você não explicou|voce esta se perdendo|você está se perdendo|se perdeu|revisa o historico|revisa o histórico|revisita o historico|revisita o histórico|ja falei|já falei|ja respondi|já respondi|voce esta repetitiva|você está repetitiva|voce esta repetindo|você está repetindo|ja explicou|já explicou|de novo isso)\b/i.test(t);

  /*
    Só citar "taxa" não basta.
    A frase precisa ter sinal de correção de condução.
  */
  return Boolean(developerSignal || contextCorrectionSignal);
}

function buildContextCorrectionGuidance({
  text = "",
  motivo = "lead_corrigiu_contexto_ou_repeticao"
} = {}) {
  return {
    tipo: "corrigir_conducao_contexto",
    prioridade: "critica",
    motivo,
    orientacaoParaPreSdr:
      [
        "A última mensagem do lead é uma correção de contexto/condução, não uma objeção comercial.",
        "Não tratar como objeção de taxa.",
        "Não incrementar contagem de objeção.",
        "Não repetir taxa automaticamente.",
        "A SDR deve reconhecer brevemente a falha, pedir desculpa de forma simples e retomar do ponto correto.",
        "Se o lead disse que ainda não falamos de determinado assunto, a SDR deve corrigir a ordem e explicar apenas o ponto correto, sem textão desnecessário.",
        "Se o lead reclamou de repetição, a SDR deve parar de repetir e avançar de forma objetiva conforme o histórico."
      ].join("\n"),
    detalhes: {
      mensagemLead: text,
      naoRegistrarObjecaoTaxa: true,
      naoIncrementarTaxaObjectionCount: true,
      limparTaxaModoConversaoSeForErroDeContexto: true
    }
  };
}

function normalizeTaxDecisionText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s?!.áéíóúàâêôãõç-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRecentTaxDecisionContext(history = [], lastSdrText = "") {
  const historyText = Array.isArray(history)
    ? history
        .slice(-18)
        .map(message => `${message.role || ""}: ${message.content || ""}`)
        .join("\n")
    : "";

  return normalizeTaxDecisionText(`${historyText}\nassistant: ${lastSdrText || ""}`);
}

function hasTaxBeenExplainedForDecision({ lead = {}, contextText = "" } = {}) {
  const etapas = lead?.etapas || {};

  return Boolean(
    etapas.investimento === true ||
    lead?.taxaAlinhada === true ||
    lead?.taxaModoConversao === true ||
    /\b(1990|1\.990|r\$ ?1\.990|taxa|investimento|adesao|adesão|implantacao|implantação|10x|199)\b/i.test(contextText)
  );
}

function hasMandatoryValueAnchoringForDecision({ lead = {}, contextText = "" } = {}) {
  const etapas = lead?.etapas || {};

  const etapasMarcadas =
    etapas.programa === true &&
    etapas.beneficios === true &&
    etapas.estoque === true &&
    etapas.responsabilidades === true &&
    etapas.investimento === true;

  if (etapasMarcadas) {
    return true;
  }

  const falouPrograma =
    /\b(programa|parceiro homologado|homologado|parceria|iqg)\b/i.test(contextText);

  const falouBeneficios =
    /\b(beneficio|benefício|comissao|comissão|margem|suporte|treinamento|orientacao|orientação)\b/i.test(contextText);

  const falouEstoque =
    /\b(estoque|comodato|lote inicial|produtos em comodato|pronta entrega|pronta-entrega)\b/i.test(contextText);

  const falouResponsabilidade =
    /\b(responsabilidade|contrato|nome limpo|atuacao|atuação|resultado depende|depende da sua atuacao|depende da sua atuação|vendas)\b/i.test(contextText);

  const falouInvestimento =
    /\b(1990|1\.990|r\$ ?1\.990|taxa|investimento|adesao|adesão|implantacao|implantação|10x|199)\b/i.test(contextText);

  return Boolean(
    falouPrograma &&
    falouBeneficios &&
    falouEstoque &&
    falouResponsabilidade &&
    falouInvestimento
  );
}

function taxDecisionMessageIsShortPositive(text = "") {
  const t = normalizeTaxDecisionText(text);

  return /^(sim|ok|okay|blz|beleza|show|top|certo|ta bom|tá bom|tranquilo|fechado|pode|pode sim|pode ser|vamos|vamo|bora|manda|manda ai|manda aí|segue|seguir|pode seguir|pode continuar|continua|quero|aceito)$/i.test(t);
}

function taxDecisionMessageIsStrongAcceptance(text = "") {
  const t = normalizeTaxDecisionText(text);

  return /\b(pode seguir|pode continuar|vamos seguir|bora|me cadastra|quero cadastrar|quero me cadastrar|quero participar|quero ser parceiro|quero ser homologado|vou seguir|vou fazer|aceito|aceito a taxa|aceito o investimento|vou pagar|pode fazer minha analise|pode fazer minha análise|qual proximo passo|qual próximo passo|quais dados precisa|que dados precisa|manda o cadastro|seguir com cadastro|seguir com pre analise|seguir com pré análise|pode iniciar|pode mandar|tenho interesse|quero entrar|quero fazer parte)\b/i.test(t);
}

function taxDecisionMessageIsQuestionAboutTax(text = "") {
  const t = normalizeTaxDecisionText(text);

  return Boolean(
    t.includes("?") &&
    /\b(taxa|valor|preco|preço|investimento|pagar|pagamento|cartao|cartão|pix|parcelar|parcela|contrato|garantia)\b/i.test(t)
  );
}

function taxDecisionMessageIsPriceObjection(text = "") {
  const t = normalizeTaxDecisionText(text);

  return /\b(caro|achei caro|muito caro|nao tenho dinheiro|não tenho dinheiro|sem dinheiro|nao tenho agora|não tenho agora|nao consigo pagar|não consigo pagar|sem condicoes|sem condições|desconto|parcelar|parcela|baixar valor|valor alto|taxa alta|pesado pra mim|pesado para mim|vou pensar|pensar melhor|falar com minha esposa|falar com meu marido|falar com socio|falar com sócio)\b/i.test(t);
}

function taxDecisionMessageIsTrustObjection(text = "") {
  const t = normalizeTaxDecisionText(text);

  return /\b(golpe|confiar|confiança|confianca|garantia|garantem|contrato|prova|prova social|depoimento|seguro|segurança|seguranca|e se eu nao vender|e se eu não vender|retorno garantido|garante retorno)\b/i.test(t);
}

function taxDecisionMessageRequestsAlternative(text = "") {
  const t = normalizeTaxDecisionText(text);

  return /\b(sem taxa|opcao sem taxa|opção sem taxa|alternativa|outro modelo|afiliado|afiliados|link|só indicar|so indicar|somente indicar|quero indicar|vender por link|divulgar online|sem estoque|sem produto fisico|sem produto físico)\b/i.test(t);
}

function taxDecisionMessageIsMainProjectRefusal(text = "") {
  const t = normalizeTaxDecisionText(text);

  return /\b(nao quero pagar|não quero pagar|nao vou pagar|não vou pagar|nao quero taxa|não quero taxa|nao quero seguir|não quero seguir|nao vou seguir|não vou seguir|nao quero continuar|não quero continuar|deixa quieto|deixa pra la|deixa pra lá|nao e pra mim|não é pra mim|desisti|vou desistir|pode encerrar|encerra|nao tenho interesse|não tenho interesse)\b/i.test(t);
}

function isLeadAlreadyInCollectionOrAfter(lead = {}) {
  const fase = lead?.faseQualificacao || "";
  const faseFunil = lead?.faseFunil || "";
  const status = lead?.status || "";

  return Boolean(
    ["coletando_dados", "dados_parciais", "aguardando_dados", "aguardando_confirmacao_campo", "aguardando_confirmacao_dados", "corrigir_dado", "corrigir_dado_final", "aguardando_valor_correcao_final", "dados_confirmados", "enviado_crm"].includes(fase) ||
    ["coleta_dados", "confirmacao_dados", "pre_analise", "crm"].includes(faseFunil) ||
    ["coletando_dados", "dados_parciais", "aguardando_dados", "dados_confirmados", "enviado_crm"].includes(status)
  );
}

function classifyTaxPhaseDecision({
  lead = {},
  history = [],
  semanticIntent = {},
  semanticContinuity = {},
  lastUserText = "",
  lastSdrText = ""
} = {}) {
  const text = normalizeTaxDecisionText(lastUserText);
  const contextText = buildRecentTaxDecisionContext(history, lastSdrText);

  const taxExplained = hasTaxBeenExplainedForDecision({
    lead,
    contextText
  });

  const valueAnchored = hasMandatoryValueAnchoringForDecision({
    lead,
    contextText
  });

  const taxaObjectionCount = Number(lead?.taxaObjectionCount || 0);

  const inAffiliateRoute =
    lead?.rotaComercial === "afiliado" ||
    lead?.faseQualificacao === "afiliado" ||
    lead?.status === "afiliado" ||
    lead?.interesseAfiliado === true;

  if (!text || inAffiliateRoute || isLeadAlreadyInCollectionOrAfter(lead)) {
    return {
      categoria: "FORA_DA_FASE_TAXA",
      acao: "NENHUMA_ACAO",
      shouldSave: false,
      motivo: "Lead não está em fase útil para decisão de taxa."
    };
  }

  if (!taxExplained) {
    return {
      categoria: "INDEFINIDO",
      acao: "MANTER_FASE",
      shouldSave: false,
      motivo: "Taxa ainda não foi explicada no histórico/estado. Não liberar coleta."
    };
  }

  const asksTaxQuestion = taxDecisionMessageIsQuestionAboutTax(text);
  const priceObjection = taxDecisionMessageIsPriceObjection(text) || semanticIntent?.priceObjection === true;
  const trustObjection = taxDecisionMessageIsTrustObjection(text) || semanticIntent?.riskObjection === true;
  const asksAlternative = taxDecisionMessageRequestsAlternative(text) || semanticIntent?.wantsAffiliate === true;
  const mainProjectRefusal = taxDecisionMessageIsMainProjectRefusal(text);
  const strongAcceptance =
    taxDecisionMessageIsStrongAcceptance(text) ||
    semanticIntent?.positiveCommitment === true ||
    semanticIntent?.paymentIntent === true;

  const weakButContextualAcceptance =
    taxDecisionMessageIsShortPositive(text) &&
    !taxDecisionMessageIsQuestionAboutTax(text) &&
    !taxDecisionMessageIsPriceObjection(text) &&
    !/\?/.test(String(lastUserText || "").trim()) &&
    taxExplained &&
    valueAnchored &&
    (
      semanticContinuity?.leadQuerAvancar === true ||
      semanticContinuity?.leadEntendeuUltimaExplicacao === true ||
      /posso seguir|podemos seguir|pode seguir|quer que eu avance|pre analise|pré analise|pré-análise|cadastro|dados/i.test(contextText)
    );

  /*
    Ordem importante:
    - Pergunta real sobre taxa deve ser respondida.
    - Pedido explícito de alternativa pode ir para Afiliados.
    - Recusa na taxa exige até 3 tentativas antes de desistir do Homologado.
    - Aceite depois da objeção precisa limpar a objeção antiga.
  */

  if (asksTaxQuestion && !strongAcceptance) {
    return {
      categoria: "DUVIDA_SOBRE_TAXA",
      acao: "RESPONDER_DUVIDA",
      shouldSave: false,
      motivo: "Lead fez pergunta específica sobre taxa/investimento."
    };
  }

  if (asksAlternative) {
    return {
      categoria: "PEDIDO_ALTERNATIVA",
      acao: "OFERECER_AFILIADO",
      shouldSave: true,
      motivo: "Lead pediu alternativa sem taxa, link, indicação ou modelo de Afiliados."
    };
  }

  if (mainProjectRefusal && taxaObjectionCount >= 3) {
    return {
      categoria: "RECUSA_PROJETO_PRINCIPAL",
      acao: "OFERECER_AFILIADO",
      shouldSave: true,
      motivo: "Lead recusou o Homologado após pelo menos 3 tentativas/objeções de taxa."
    };
  }

  if (mainProjectRefusal && taxaObjectionCount < 3) {
    return {
      categoria: "RECUSA_PROJETO_PRINCIPAL",
      acao: "TRATAR_OBJETICA_TAXA",
      shouldSave: false,
      motivo: "Lead recusou, mas ainda não houve 3 tentativas consultivas na taxa. Não desistir ainda."
    };
  }

  if (priceObjection) {
    return {
      categoria: "OBJECÃO_PRECO",
      acao: taxaObjectionCount >= 3 ? "OFERECER_AFILIADO" : "TRATAR_OBJETICA_TAXA",
      shouldSave: taxaObjectionCount >= 3,
      motivo: taxaObjectionCount >= 3
        ? "Lead permaneceu travado em preço após tentativas suficientes. Preparar Afiliados."
        : "Lead apresentou objeção de preço. Tratar valor antes de oferecer Afiliados."
    };
  }

  if (trustObjection) {
    return {
      categoria: "OBJECÃO_CONFIANCA",
      acao: "TRATAR_OBJETICA_CONFIANCA",
      shouldSave: false,
      motivo: "Lead apresentou objeção de confiança, garantia, contrato ou segurança."
    };
  }

  if (strongAcceptance && valueAnchored) {
    return {
      categoria: "ACEITE_CLARO",
      acao: "LIBERAR_PRE_CADASTRO",
      shouldSave: true,
      motivo: "Lead aceitou seguir após taxa explicada e valor ancorado."
    };
  }

  if (weakButContextualAcceptance) {
    return {
      categoria: "ACEITE_FRACO_MAS_SUFFICIENTE",
      acao: "LIBERAR_PRE_CADASTRO",
      shouldSave: true,
      motivo: "Lead deu aceite curto, mas suficiente dentro do contexto de taxa já explicada."
    };
  }

  return {
    categoria: "INDEFINIDO",
    acao: "MANTER_FASE",
    shouldSave: false,
    motivo: "Mensagem não trouxe aceite, dúvida, objeção ou recusa suficiente."
  };
}

function buildTaxPhaseDecisionPatch({
  decision = {},
  lead = {},
  lastUserText = ""
} = {}) {
  const categoria = decision?.categoria || "";
  const acao = decision?.acao || "";
  const currentEtapas = {
    programa: false,
    beneficios: false,
    estoque: false,
    responsabilidades: false,
    investimento: false,
    taxaPerguntada: false,
    compromissoPerguntado: false,
    compromisso: false,
    ...(lead?.etapas || {})
  };

  if (acao === "LIBERAR_PRE_CADASTRO") {
    return {
      shouldSave: true,
      patch: {
        etapas: {
  ...currentEtapas,

  /*
    REGRA DE PRODUÇÃO IQG:
    Se a taxa já foi apresentada e o lead aceitou seguir,
    o sistema NÃO deve voltar para responsabilidades, estoque ou benefícios.

    Mesmo que alguma etapa tenha ficado false por falha anterior,
    o aceite pós-taxa consolida as etapas comerciais anteriores.
  */
  programa: true,
  beneficios: true,
  estoque: true,
  responsabilidades: true,
  investimento: true,
  taxaPerguntada: true,
  compromissoPerguntado: true,
  compromisso: true
},

        taxaAlinhada: true,
        taxaModoConversao: false,
        sinalObjecaoTaxa: false,
        sinalObjecaoEstoque: false,
        sinalObjecaoRisco: false,
        bloqueioComercialAtivo: false,

        pendenciaPerguntaComercialAberta: false,
        pendenciaPerguntaComercialAbertaResolvidaEm: new Date(),
        motivoPendenciaPerguntaComercialAberta: "",

        interesseReal: true,
        status: "qualificando",
        faseQualificacao: "qualificando",
        rotaComercial: "homologado",
        origemConversao: "homologado",

        taxaAceitaEm: new Date(),
        taxaAceitaAposObjecao: Number(lead?.taxaObjectionCount || 0) > 0,
        taxaObjectionResolved: true,
        ultimaObjecaoTaxaResolvidaEm: new Date(),
        taxaAceiteClassificacao: categoria,
        ultimaMensagem: lastUserText,

        ultimaDecisaoBackend: buildBackendDecision({
          tipo: "taxa_aceita_liberar_precadastro",
          motivo: decision?.motivo || "lead_aceitou_taxa_contextualmente",
          acao: "liberar_pre_cadastro",
          mensagemLead: lastUserText,
          detalhes: {
            categoria,
            taxaObjectionCount: Number(lead?.taxaObjectionCount || 0),
            limparObjecaoAntiga: true,
            compromissoValidadoPorContexto: true,
            interesseRealConfirmadoPorContexto: true
          }
        })
      }
    };
  }

  if (acao === "OFERECER_AFILIADO") {
    return {
      shouldSave: true,
      patch: {
        deveOferecerAfiliadoComoAlternativa: true,
        afiliadoOferecidoComoAlternativa: false,
        motivoOfertaAfiliado: decision?.motivo || "lead_nao_concluiu_homologado",
        ultimaMensagem: lastUserText,
        ultimaDecisaoBackend: buildBackendDecision({
          tipo: "oferecer_afiliado_como_alternativa",
          motivo: decision?.motivo || "lead_nao_concluiu_homologado",
          acao: "orientar_sdr_oferecer_afiliado",
          mensagemLead: lastUserText,
          detalhes: {
            categoria,
            taxaObjectionCount: Number(lead?.taxaObjectionCount || 0),
            regra: "Se não concluiu Homologado/coleta, apresentar Afiliados como alternativa."
          }
        })
      }
    };
  }

  return {
    shouldSave: false,
    patch: {}
  };
}

function hasTaxAcceptedDecisionToCollect(lead = {}) {
  const decision = lead?.ultimaDecisaoBackend || {};

  return Boolean(
    decision?.tipo === "taxa_aceita_liberar_precadastro" ||
    decision?.acao === "liberar_pre_cadastro" ||
    lead?.taxaAceitaEm ||
    lead?.taxaAceitaAposObjecao === true ||
    lead?.taxaObjectionResolved === true
  );
}

function canStartDataCollection(lead = {}) {
  const etapas = lead?.etapas || {};

  const estaEmFluxoAfiliado =
    lead?.rotaComercial === "afiliado" ||
    lead?.faseQualificacao === "afiliado" ||
    lead?.status === "afiliado" ||
    lead?.interesseAfiliado === true;

  if (estaEmFluxoAfiliado) {
    return false;
  }

  if (
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true ||
    lead?.faseQualificacao === "aguardando_confirmacao_campo" ||
    lead?.faseQualificacao === "aguardando_confirmacao_dados" ||
    lead?.faseQualificacao === "corrigir_dado" ||
    lead?.faseQualificacao === "corrigir_dado_final" ||
    lead?.faseQualificacao === "aguardando_valor_correcao_final"
  ) {
    return false;
  }

  if (
    lead?.faseQualificacao === "coletando_dados" ||
    lead?.faseQualificacao === "dados_parciais" ||
    lead?.faseQualificacao === "aguardando_dados"
  ) {
    return true;
  }

  const taxaAceitaParaColeta = hasTaxAcceptedDecisionToCollect(lead);

  /*
    REGRA DE PRODUÇÃO:
    Se a taxa foi aceita, não deixamos etapa comercial anterior travar a coleta.
    Isso corrige o caso real:
    - taxa aceita
    - compromisso true
    - interesseReal true
    - mas responsabilidades false por inconsistência antiga
  */
  if (
    taxaAceitaParaColeta &&
    lead?.taxaAlinhada === true &&
    lead?.interesseReal === true &&
    etapas.compromisso === true &&
    lead?.sinalObjecaoTaxa !== true &&
    lead?.bloqueioComercialAtivo !== true
  ) {
    return true;
  }

  if (lead?.pendenciaPerguntaComercialAberta === true) {
    return false;
  }

  /*
       Onda 2 — coleta libera com base no funil real (6 etapas),
       sem exigir compromisso ou interesseReal.
    */
    const etapasObrigatoriasConduzidas =
        etapas.programa === true &&
        etapas.beneficios === true &&
        etapas.estoque === true &&
        etapas.responsabilidades === true &&
        etapas.investimento === true;
    const taxaAlinhada =
        lead?.taxaAlinhada === true;
    const objecaoTaxaResolvida =
        lead?.taxaObjectionResolved === true ||
        lead?.taxaAceitaAposObjecao === true ||
        Boolean(lead?.taxaAceitaEm) ||
        hasTaxAcceptedDecisionToCollect(lead) ||
        lead?.taxaAlinhada === true;
    const semObjecaoTaxaAtiva =
        lead?.sinalObjecaoTaxa !== true ||
        objecaoTaxaResolvida === true;
    const contagemObjecaoNaoBloqueia =
        Number(lead?.taxaObjectionCount || 0) <= 1 ||
        objecaoTaxaResolvida === true;
    const semObjecaoAtiva =
        semObjecaoTaxaAtiva &&
        lead?.sinalObjecaoEstoque !== true &&
        lead?.sinalObjecaoRisco !== true &&
        lead?.bloqueioComercialAtivo !== true &&
        contagemObjecaoNaoBloqueia;
    return Boolean(
        etapasObrigatoriasConduzidas &&
        taxaAlinhada &&
        semObjecaoAtiva
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

  const etapas = lead?.etapas || {};

  const faltaInvestimento =
    etapas.investimento !== true ||
    lead?.taxaAlinhada !== true;

  const faltaCompromisso =
    etapas.compromisso !== true;

  const faltaInteresseReal =
    lead?.interesseReal !== true;

  /*
    Se o lead já pediu cadastro ou demonstrou vontade de avançar,
    não devolvemos um textão repetindo tudo.
    Validamos só a menor pendência real.
  */
  if (faltaInvestimento) {
    return `${namePart}perfeito, eu te ajudo com isso 😊

Antes do pré-cadastro, preciso só alinhar a parte do investimento para você seguir consciente.

${getNextFunnelStepMessage(lead)}`;
  }

  if (faltaCompromisso) {
    return `${namePart}perfeito 😊

Antes de abrir a pré-análise, só preciso confirmar um ponto importante: você entende que o resultado como Parceiro Homologado depende da sua atuação nas vendas, prospecção e relacionamento com os clientes?

Se estiver de acordo, eu sigo para o pré-cadastro.`;
  }

  if (faltaInteresseReal) {
    return `${namePart}perfeito 😊

Como a taxa e as responsabilidades já foram explicadas, me confirma só uma coisa: você quer mesmo seguir para a pré-análise do Parceiro Homologado IQG?`;
  }

  return `${namePart}perfeito, eu te ajudo com isso 😊

Antes do pré-cadastro ainda falta alinhar: ${missingSteps.join(", ")}.

Vou seguir pelo próximo ponto, sem repetir o que já foi tratado:

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
    /*
       Onda 2 — funil simplificado (6 etapas reais + coleta).
       Removidos do cálculo: compromisso e interesseReal,
       porque não são mais bloqueadores do funil (Onda 1).
       Etapas:
         1 = programa pendente
         2 = benefícios pendente
         3 = estoque/comodato pendente
         4 = responsabilidades pendente
         5 = investimento pendente
         6 = alinhamento da taxa pendente
         7 = coleta liberada (todas as 5 + taxaAlinhada=true)
    */
    if (!e.programa) return 1;
    if (!e.beneficios) return 2;
    if (!e.estoque) return 3;
    if (!e.responsabilidades) return 4;
    if (!e.investimento) return 5;
    if (lead?.taxaAlinhada !== true) return 6;
    return 7; // coleta liberada
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

/* =========================
   TRAVAS FINAIS — LEITURA SEMÂNTICA LEVE
   Evita revisão desnecessária quando a SDR respondeu corretamente.
========================= */

function iqgNormalizeGuardText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function iqgLeadAskedToUnderstandHomologado(leadText = "") {
  const t = iqgNormalizeGuardText(leadText);

  return Boolean(
    /\b(tenho interesse|quero saber mais|quero entender|quero entender melhor|me explica|me conte|como funciona|programa|programa homologado|parceiro homologado|homologado|quero ser parceiro|quero participar|como me cadastro|como faco cadastro|como faço cadastro)\b/i.test(t)
  );
}

function iqgReplyIsSafeHomologadoOverview(respostaFinal = "") {
  const r = iqgNormalizeGuardText(respostaFinal);

  const falaHomologado =
    /\b(programa|parceiro homologado|homologado|parceria comercial|vender produtos|vender produtos da industria|vender produtos diretamente da industria)\b/i.test(r);

  const falaValorInicial =
    /\b(suporte|treinamento|materiais|material|comodato|estoque em comodato|lote inicial|pronta entrega|demonstração|demonstracao|beneficios|benefícios)\b/i.test(r);

  const falaTaxa =
    /\b(taxa|investimento|valor de adesao|valor de adesão|r 1 990|1990|pagamento|pix|cartao|cartão|parcelado|10x)\b/i.test(r);

  const pedeDados =
    /\b(nome completo|cpf|telefone|cidade|estado|uf|dados|pre cadastro|pré cadastro|pre analise|pré analise|pre analise|pré análise)\b/i.test(r);

  const falaAfiliado =
    /\b(afiliado|afiliados|link de afiliado|minhaiqg|comissao por link|comissão por link)\b/i.test(r);

  return Boolean(
    falaHomologado &&
    falaValorInicial &&
    !falaTaxa &&
    !pedeDados &&
    !falaAfiliado
  );
}

function iqgLeadSaidThemeAlreadyUnderstood(leadText = "", theme = "") {
  const t = iqgNormalizeGuardText(leadText);

  const saidUnderstood =
    /\b(ja entendi|já entendi|entendi bem|entendi|ficou claro|ta claro|tá claro|compreendi|li no folder|pelo folder|ja li|já li|ja vi|já vi|vi no folder)\b/i.test(t);

  if (!saidUnderstood) return false;

  if (theme === "beneficios" || theme === "benefícios") {
    return /\b(beneficio|beneficios|benefício|benefícios|vantagem|vantagens|folder)\b/i.test(t);
  }

  if (theme === "programa") {
    return /\b(programa|homologado|parceiro homologado|modelo)\b/i.test(t);
  }

  if (theme === "estoque") {
    return /\b(estoque|comodato|lote|kit|produtos|produto)\b/i.test(t);
  }

  if (theme === "responsabilidades") {
    return /\b(responsabilidade|responsabilidades|minha parte|obrigacao|obrigação|obrigacoes|obrigações)\b/i.test(t);
  }

  return false;
}

function iqgFilterMissingThemesAlreadyUnderstood({
  leadText = "",
  missingThemes = []
} = {}) {
  const safeThemes = Array.isArray(missingThemes) ? missingThemes : [];

  return safeThemes.filter(theme => {
    const cleanTheme = iqgNormalizeGuardText(theme);

    if (cleanTheme.includes("beneficio") && iqgLeadSaidThemeAlreadyUnderstood(leadText, "beneficios")) {
      return false;
    }

    if (cleanTheme.includes("programa") && iqgLeadSaidThemeAlreadyUnderstood(leadText, "programa")) {
      return false;
    }

    if (cleanTheme.includes("estoque") && iqgLeadSaidThemeAlreadyUnderstood(leadText, "estoque")) {
      return false;
    }

    if (cleanTheme.includes("responsabilidade") && iqgLeadSaidThemeAlreadyUnderstood(leadText, "responsabilidades")) {
      return false;
    }

    return true;
  });
}

function isSafeInitialHomologadoOverviewReply({
  respostaFinal = "",
  leadText = "",
  currentLead = {}
} = {}) {
  /*
    Esta função evita revisão desnecessária.

    Quando o lead está no começo e pede para entender o Programa Homologado,
    a SDR pode dar uma visão geral curta com:
    - parceria comercial;
    - suporte;
    - treinamento;
    - material;
    - lote/estoque em comodato.

    Isso NÃO é pular fase, desde que ela NÃO fale taxa, NÃO peça dados,
    NÃO prometa pré-análise e NÃO misture Afiliados.
  */

  const etapaAtual = getCurrentFunnelStage(currentLead);

  const leadPediuHomologado =
    iqgLeadAskedToUnderstandHomologado(leadText);

  const respostaSegura =
    iqgReplyIsSafeHomologadoOverview(respostaFinal);

  return Boolean(
    etapaAtual <= 2 &&
    leadPediuHomologado &&
    respostaSegura
  );
}

function enforceFunnelDiscipline({
  respostaFinal = "",
  currentLead = {},
  leadText = ""
} = {}) {
  /*
    Trava de disciplina do funil.

    O objetivo desta trava NÃO é engessar a SDR.
    Ela deve bloquear somente riscos reais:
    - falar taxa cedo;
    - falar pagamento cedo;
    - pedir dados cedo;
    - mandar para pré-análise antes da hora.

    Ela NÃO deve bloquear uma explicação útil quando o lead fez uma pergunta real.
    Exemplo permitido:
    Lead: "Quero entender melhor o programa"
    SDR: explica parceria, suporte, treinamento e comodato, sem taxa e sem dados.

    Exemplo permitido:
    Lead: "Tenho dúvida sobre estoque"
    SDR: explica estoque/comodato, sem taxa e sem dados.
  */

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
    (!podeColetarDados || leadTemPerguntaOuObjecao);
   
  const visaoGeralInicialHomologadoSegura =
    isSafeInitialHomologadoOverviewReply({
      respostaFinal,
      leadText,
      currentLead
    });

  /*
    CASO 1 — Visão geral segura do Homologado.

    Se o lead pediu para entender o Programa Parceiro Homologado,
    a SDR pode citar parceria, suporte, treinamento, materiais,
    benefícios e estoque em comodato.

    Isso NÃO é pulo de fase, desde que ela não fale taxa,
    não peça dados e não jogue para pré-análise.
  */
  if (
    tentouPularFase &&
    visaoGeralInicialHomologadoSegura &&
    !falouTaxaCedo &&
    !falouTaxaSemControle &&
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
        leadTemPerguntaOuObjecao,
        preservadoPorqueVisaoGeralHomologado: true
      }
    };
  }

  /*
    CASO 2 — Lead fez pergunta real.

    Se o lead perguntou sobre estoque, benefícios, programa,
    responsabilidades ou outro ponto comercial,
    a SDR deve responder primeiro a pergunta real.

    A trava não deve mandar revisar só porque a resposta mencionou
    um tema de uma etapa diferente.

    Continuamos bloqueando taxa cedo e dados cedo.
  */
  if (
    tentouPularFase &&
    leadTemPerguntaOuObjecao &&
    !pediuDadosCedo &&
    !falouTaxaCedo &&
    !falouTaxaSemControle
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
        leadTemPerguntaOuObjecao,
        preservadoPorqueRespondePerguntaAtual: true
      }
    };
  }

  /*
    CASO 3 — Bloqueios realmente críticos.

    Estes continuam sendo problema:
    - taxa cedo;
    - taxa sem controle;
    - pedido de dados antes da coleta estar liberada.
  */
  if (
    falouTaxaCedo ||
    falouTaxaSemControle ||
    pediuDadosCedo
  ) {
    return {
      changed: true,
      respostaFinal,
      reason: {
        etapaAtual,
        etapaDetectadaNaResposta,
        tentouPularFase,
        falouTaxaCedo,
        falouTaxaSemControle,
        pediuDadosCedo,
        leadTemPerguntaOuObjecao
      }
    };
  }

  /*
    CASO 4 — Pulo de fase real.

    Se não era resposta a pergunta do lead,
    não era visão geral segura,
    e mesmo assim a resposta pulou etapa,
    aí sim a revisão deve acontecer.
  */
  if (tentouPularFase) {
    return {
      changed: true,
      respostaFinal,
      reason: {
        etapaAtual,
        etapaDetectadaNaResposta,
        tentouPularFase,
        falouTaxaCedo,
        falouTaxaSemControle,
        pediuDadosCedo,
        leadTemPerguntaOuObjecao
      }
    };
  }

  /*
    Sem problema detectado.
  */
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
      leadTemPerguntaOuObjecao
    }
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
  /*
    CORREÇÃO PRODUÇÃO — entendimento explícito vence dúvida em outro tema.

    Exemplo real:
    Lead: "Dos benefícios já entendi bem pelo folder... tenho dúvidas sobre estoque."

    Antes:
    - O backend via "dúvida sobre estoque"
    - retornava changed:false
    - não consolidava beneficios:true

    Agora:
    - Consolida beneficios:true
    - Mantém estoque pendente, porque a dúvida atual é sobre estoque
    - Não libera coleta cedo
    - Não pula taxa
    - Não remove a obrigatoriedade das etapas
  */

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

  const explicitUnderstoodSteps =
    Array.isArray(semanticIntent?.understoodStepsFromLeadText)
      ? semanticIntent.understoodStepsFromLeadText
      : iqgGetExplicitUnderstoodFunnelStepsFromLead(leadText);

  const etapasUpdate = {
    ...currentEtapas
  };

  const understoodSteps = [];

  const evidence = {
    leadText,
    lastAssistantText,
    criterio: "",
    explainedPreviously,
    movedToNextTopic,
    explicitUnderstoodSteps
  };

  function markStep(step, reason) {
    if (etapasUpdate[step] !== true) {
      etapasUpdate[step] = true;
      understoodSteps.push(step);
    }

    evidence.criterio = evidence.criterio || reason;
  }

  /*
    1. Primeiro consolidamos o que o lead declarou explicitamente que entendeu.
    Isso é diferente de avançar coleta.
    É apenas registrar entendimento real do conteúdo.
  */
  for (const step of explicitUnderstoodSteps) {
    if (
      [
        "programa",
        "beneficios",
        "estoque",
        "responsabilidades",
        "investimento"
      ].includes(step)
    ) {
      markStep(step, `lead_declarou_entendimento_explicito_${step}`);
    }
  }

  /*
    2. Se existe dúvida/objeção atual, não marcamos novas etapas por inferência.
    Mas preservamos as etapas explicitamente entendidas acima.
  */
  if (hasBlockingDoubtOrObjection) {
    return {
      changed: understoodSteps.length > 0,
      etapas: etapasUpdate,
      understoodSteps,
      evidence: {
        ...evidence,
        criterio: evidence.criterio || "lead_trouxe_duvida_ou_objecao_sem_entendimento_explicito"
      }
    };
  }

  /*
    3. Sem dúvida bloqueante, mantemos a lógica anterior:
    se a SDR explicou e o lead demonstrou entendimento ou avançou para o próximo tema,
    consolidamos a etapa.
  */
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

function iqgIsInitialRouteComparisonReply(text = "", currentLead = {}) {
  /*
    ETAPA 14.5B — comparação inicial não conclui etapas do Homologado.

    Explicação simples:
    Quando a SDR apresenta os dois caminhos:
    - Parceiro Homologado;
    - Afiliados;

    isso serve para ajudar o lead a escolher a rota.

    Mas ainda NÃO significa que benefícios e estoque do Homologado
    foram explicados de verdade.

    Sem esta proteção, uma frase curta como:
    "Homologado tem suporte e lote em comodato"
    acaba marcando benefícios e estoque cedo demais.
  */

  const t = iqgNormalizeFunnelText(text);

  const leadJaEscolheuRota =
    currentLead?.rotaComercial === "homologado" ||
    currentLead?.rotaComercial === "afiliado" ||
    currentLead?.rotaComercial === "ambos" ||
    currentLead?.interesseReal === true ||
    currentLead?.interesseAfiliado === true ||
    currentLead?.sinalAfiliadoExplicito === true ||
    currentLead?.sinalComparacaoProgramas === true;

  const mencionaHomologado =
    t.includes("parceiro homologado") ||
    t.includes("programa parceiro homologado") ||
    t.includes("homologado");

  const mencionaAfiliado =
    t.includes("programa de afiliados") ||
    t.includes("afiliados") ||
    t.includes("afiliado") ||
    t.includes("divulgacao online") ||
    t.includes("divulgação online") ||
    t.includes("link");

  const formatoComparacao =
    t.includes("duas rotas") ||
    t.includes("dois caminhos") ||
    t.includes("duas opcoes") ||
    t.includes("duas opções") ||
    t.includes("qual dessas opcoes") ||
    t.includes("qual dessas opções") ||
    t.includes("mais alinhada") ||
    t.includes("produto fisico ou divulgacao online") ||
    t.includes("produto físico ou divulgação online");

  const perguntaEscolha =
    t.includes("qual dessas") ||
    t.includes("qual delas") ||
    t.includes("qual caminho") ||
    t.includes("parece mais alinhada") ||
    t.includes("voce prefere") ||
    t.includes("você prefere");

  return Boolean(
    !leadJaEscolheuRota &&
    mencionaHomologado &&
    mencionaAfiliado &&
    (formatoComparacao || perguntaEscolha)
  );
}

function shouldIgnoreResponsibilitiesPendingFromCurrentReply(text = "") {
  /*
    ETAPA 14.7A — não marcar responsabilidades cedo demais.

    Explicação simples:
    A SDR pode mencionar que existem responsabilidades ou perguntar
    se o lead quer entender responsabilidades.

    Isso NÃO significa que as responsabilidades já foram explicadas.

    Só consideramos responsabilidades explicadas quando a resposta realmente
    fala de deveres do parceiro, atuação comercial e cuidados necessários.
  */

  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return false;

  const mencionouResponsabilidades =
    t.includes("responsabilidade") ||
    t.includes("responsabilidades") ||
    t.includes("guarda") ||
    t.includes("conservacao") ||
    t.includes("conservação");

  if (!mencionouResponsabilidades) {
    return false;
  }

  const apenasChamouParaExplicar =
    t.includes("quer que eu te explique") && t.includes("respons") ||
    t.includes("quer que eu explique") && t.includes("respons") ||
    t.includes("posso te explicar") && t.includes("respons") ||
    t.includes("vou te explicar") && t.includes("respons") ||
    t.includes("importante entender as responsabilidades") ||
    t.includes("entender as responsabilidades");

  const sinaisFortesDeResponsabilidade = [
    t.includes("resultado depende") || t.includes("depende da sua atuacao") || t.includes("depende da sua atuação"),
    t.includes("comunicar vendas") || t.includes("informar vendas") || t.includes("registrar vendas"),
    t.includes("conservar os produtos") || t.includes("conservacao dos produtos") || t.includes("conservação dos produtos"),
    t.includes("guardar os produtos") || t.includes("guarda dos produtos"),
    t.includes("seguir o preco sugerido") || t.includes("seguir o preço sugerido"),
    t.includes("atuar nas vendas") || t.includes("atuacao comercial") || t.includes("atuação comercial"),
    t.includes("prospectar") || t.includes("buscar clientes") || t.includes("vender para clientes")
  ].filter(Boolean).length;

  /*
    Se só chamou para explicar, não marca.
    Se teve menos de 2 sinais fortes, também não marca.
  */
  return Boolean(
    apenasChamouParaExplicar ||
    sinaisFortesDeResponsabilidade < 2
  );
}

function iqgBuildPendingFunnelFlagsFromCurrentSdrReply({
  respostaFinal = "",
  currentLead = {}
} = {}) {
  const currentEtapas = {
    ...(currentLead?.etapas || {})
  };

  const detectedExplainedNow =
    iqgDetectFunnelStepsExplainedInText(respostaFinal);

  const isInitialRouteComparison = iqgIsInitialRouteComparisonReply(
    respostaFinal,
    currentLead
  );

  /*
    ETAPA 14.5B:
    Se foi apenas comparação inicial entre Homologado e Afiliado,
    não considerar benefícios/estoque/responsabilidades/investimento
    como etapas apresentadas do Homologado.

    Neste caso, no máximo consideramos "programa", porque a SDR
    apresentou a existência dos caminhos comerciais.
  */
  const baseExplainedNow = isInitialRouteComparison
    ? {
        ...detectedExplainedNow,
        beneficios: false,
        estoque: false,
        responsabilidades: false,
        investimento: false,
        compromisso: false
      }
    : detectedExplainedNow;

  /*
    ETAPA 14.7A:
    Não marcar responsabilidades como apresentadas apenas porque a SDR
    citou a palavra ou perguntou se o lead quer entender responsabilidades.
  */
  const explainedNow = shouldIgnoreResponsibilitiesPendingFromCurrentReply(
    respostaFinal
  )
    ? {
        ...baseExplainedNow,
        responsabilidades: false
      }
    : baseExplainedNow;

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

  if (
    explainedNow.responsabilidades &&
    currentEtapas.responsabilidades !== true
  ) {
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

/* =========================
   COLETA — MERGE DO MONGO + MENSAGEM ATUAL
   Calcula campos faltantes usando o que já está salvo no lead
   junto com o que foi extraído da mensagem atual.
========================= */

function iqgPickFilledLeadFields(data = {}) {
  const result = {};

  for (const field of REQUIRED_LEAD_FIELDS) {
    const value = data?.[field];

    if (value !== undefined && value !== null && String(value).trim()) {
      result[field] = value;
    }
  }

  return result;
}

function iqgNormalizeLeadFieldsForStorage(data = {}) {
  const picked = iqgPickFilledLeadFields(data);
  const result = { ...picked };

  if (result.cpf) {
    result.cpf = formatCPF(result.cpf);
  }

  if (result.telefone) {
    result.telefone = formatPhone(result.telefone);
  }

  if (result.estado) {
    result.estado = normalizeUF(result.estado);
  }

  if (result.cidade && result.estado) {
    result.cidadeEstado = `${result.cidade}/${normalizeUF(result.estado)}`;
  }

  return result;
}

function iqgBuildMergedLeadDataForCollection({
  currentLead = {},
  extractedData = {}
} = {}) {
  const normalizedExtractedData =
    iqgNormalizeLeadFieldsForStorage(extractedData || {});

  const mergedLeadData = {
    ...(currentLead || {}),
    ...normalizedExtractedData
  };

  if (mergedLeadData.cidade && mergedLeadData.estado) {
    mergedLeadData.cidadeEstado =
      `${mergedLeadData.cidade}/${normalizeUF(mergedLeadData.estado)}`;
  }

  const missingFieldsAfterMerge = getMissingLeadFields(mergedLeadData);

  return {
    normalizedExtractedData,
    mergedLeadData,
    missingFieldsAfterMerge,
    nextMissingField: missingFieldsAfterMerge[0] || null,
    hasNewRequiredLeadData: Object.keys(normalizedExtractedData).some(key =>
      REQUIRED_LEAD_FIELDS.includes(key)
    )
  };
}

function iqgBuildCollectionStatePatch({
  currentLead = {},
  extractedData = {}
} = {}) {
  const {
    normalizedExtractedData,
    mergedLeadData,
    missingFieldsAfterMerge,
    nextMissingField,
    hasNewRequiredLeadData
  } = iqgBuildMergedLeadDataForCollection({
    currentLead,
    extractedData
  });

  const patch = {
    ...normalizedExtractedData,
    dadosConfirmadosPeloLead: false,
    aguardandoConfirmacao: false,
    faseQualificacao: "dados_parciais",
    status: "dados_parciais",
    campoEsperado: nextMissingField,
    campoPendente: null,
    valorPendente: null
  };

  if (mergedLeadData.cidade && mergedLeadData.estado) {
    patch.cidadeEstado =
      `${mergedLeadData.cidade}/${normalizeUF(mergedLeadData.estado)}`;
  }

  return {
    patch,
    normalizedExtractedData,
    mergedLeadData,
    missingFieldsAfterMerge,
    nextMissingField,
    hasNewRequiredLeadData
  };
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

/* =========================
   REGRA COMERCIAL — CNPJ E PONTO FÍSICO
   Parceiro Homologado IQG não exige CNPJ nem loja física para iniciar.
========================= */

function normalizeSimpleText(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function leadPerguntouSobreCnpjEmpresaOuPontoFisico(text = "") {
  const t = normalizeSimpleText(text);

  if (!t) return false;

  const citouCnpjOuEmpresa =
    /\b(cnpj|empresa|mei|mei aberto|abrir empresa|tenho que ter empresa|preciso ter empresa|nao tenho empresa|não tenho empresa)\b/i.test(t);

  const citouPontoFisico =
    /\b(ponto fisico|ponto físico|loja fisica|loja física|loja|endereco comercial|endereço comercial|sala comercial|comercio|comércio)\b/i.test(t);

  return citouCnpjOuEmpresa || citouPontoFisico;
}

function buildOrientacaoCnpjPontoFisicoHomologado() {
  return [
    "REGRA COMERCIAL OBRIGATÓRIA SOBRE CNPJ/PONTO FÍSICO:",
    "Para iniciar no Programa Parceiro Homologado IQG, o lead NÃO precisa ter CNPJ próprio.",
    "Também NÃO precisa ter ponto físico, loja física, sala comercial ou empresa aberta.",
    "Esse é um benefício do modelo: o parceiro pode começar sem estrutura formal própria.",
    "O faturamento, emissão e custos tributários/impostos da operação ficam pela IQG, conforme o processo interno da empresa.",
    "A SDR deve explicar isso como vantagem e redução de barreira de entrada.",
    "Não dizer que CNPJ é obrigatório.",
    "Não dizer que ponto físico é obrigatório.",
    "Não usar a frase 'CNPJ é necessário para formalizar a parceria'.",
    "Se o lead disse que não tem empresa, responder com tranquilidade que isso não impede a pré-análise.",
    "Depois de esclarecer, só retomar a coleta se o lead parecer tranquilo. Se o lead estiver confuso, perguntar se ficou claro antes de pedir dados."
  ].join("\n");
}

/* =========================
   COLETA — DADO CADASTRAL FORTE
   Evita bloquear CPF, telefone, cidade/UF quando o roteador semântico
   chamar a mensagem de "misto", mas a extração já encontrou dado válido.
========================= */

function iqgIsStrongCpfValue(value = "") {
  const digits = onlyDigits(value);

  if (digits.length !== 11) return false;

  // Evita CPF obviamente falso tipo 00000000000, 11111111111 etc.
  if (/^(\d)\1{10}$/.test(digits)) return false;

  return true;
}

function iqgIsStrongPhoneValue(value = "") {
  const digits = onlyDigits(value);

  // Brasil normalmente fica entre 10 e 13 dígitos dependendo de DDI/DDDs.
  return digits.length >= 10 && digits.length <= 13;
}

function iqgIsStrongUfValue(value = "") {
  const uf = normalizeUF(value);

  return /^[A-Z]{2}$/.test(uf);
}

function iqgHasStrongCadastroDataForCollection({
  extractedData = {},
  currentLead = {},
  text = ""
} = {}) {
  /*
    Regra simples:
    Nome sozinho NÃO libera a trava, porque já vimos frase comercial virar nome.
    Esta liberação é somente para CPF, telefone, cidade+UF ou combinações fortes.
  */

  const data = extractedData || {};

  const hasCpfForte =
    data.cpf &&
    iqgIsStrongCpfValue(data.cpf);

  const hasTelefoneForte =
    data.telefone &&
    iqgIsStrongPhoneValue(data.telefone);

  const hasCidadeEstadoForte =
    data.cidade &&
    String(data.cidade || "").trim().length >= 2 &&
    data.estado &&
    iqgIsStrongUfValue(data.estado);

  const hasUfForteQuandoEsperada =
    currentLead?.campoEsperado === "estado" &&
    data.estado &&
    iqgIsStrongUfValue(data.estado);

  const hasTextoComCpfQuandoEsperado =
    currentLead?.campoEsperado === "cpf" &&
    iqgIsStrongCpfValue(text);

  const hasTextoComTelefoneQuandoEsperado =
    currentLead?.campoEsperado === "telefone" &&
    iqgIsStrongPhoneValue(text);

  return Boolean(
    hasCpfForte ||
    hasTelefoneForte ||
    hasCidadeEstadoForte ||
    hasUfForteQuandoEsperada ||
    hasTextoComCpfQuandoEsperado ||
    hasTextoComTelefoneQuandoEsperado
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

  /*
    ETAPA 13.1 PRODUÇÃO — frase comercial não pode virar dado cadastral.

    Explicação simples:
    Se o sistema está esperando "nome", mas o lead escreve:
    "tem catálogo desses produtos?"
    "não conheço os produtos da IQG"
    "me manda o kit"
    "e a taxa?"

    Isso NÃO é nome.
    É conversa comercial.
  */
 const looksLikeCommercialConversation =
    /\b(catalogo|catálogo|produto|produtos|iqg|nano|kit|folder|pdf|material|manual|estoque|comodato|reposicao|reposição|taxa|valor|preco|preço|contrato|pagamento|boleto|pix|cartao|cartão|adesao|adesão|cnpj|empresa|mei|ponto fisico|ponto físico|loja|loja fisica|loja física|endereco comercial|endereço comercial|nao tenho empresa|não tenho empresa|nao tenho cnpj|não tenho cnpj)\b/i.test(cleanText) ||
    cleanText.length > 80;
   
   
  if (
    currentLead?.campoEsperado === "nome" &&
    looksLikeCommercialConversation
  ) {
    return false;
  }

   // Segurança extra: frases de negação/explicação nunca podem virar nome.
if (
  currentLead?.campoEsperado === "nome" &&
  /\b(eu nao tenho|eu não tenho|nao tenho|não tenho|preciso entender|nao entendi|não entendi|duvida|dúvida|cnpj|empresa|ponto fisico|ponto físico|loja)\b/i.test(cleanText)
) {
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
  /*
    ETAPA 9 PRODUÇÃO — regra segura para envio ao CRM/consultor.

    Explicação simples:
    Para enviar ao consultor, não basta ter nome, CPF e telefone.
    O lead precisa:
    - ter confirmado os dados;
    - estar no caminho Homologado;
    - ter entendido investimento/taxa;
    - ter compromisso validado;
    - ter interesse real;
    - ter todos os dados obrigatórios.
  */

  const etapas = lead.etapas || {};

  const dadosConfirmados = lead.dadosConfirmadosPeloLead === true;

  const temDadosObrigatorios =
    Boolean(lead.nome) &&
    Boolean(lead.cpf) &&
    Boolean(lead.telefone) &&
    Boolean(lead.cidade) &&
    Boolean(lead.estado);

  const rotaAfiliado =
    lead.rotaComercial === "afiliado" ||
    lead.origemConversao === "afiliado" ||
    lead.interesseAfiliado === true ||
    lead.status === "afiliado" ||
    lead.faseQualificacao === "afiliado" ||
    lead.faseFunil === "afiliado";

  if (rotaAfiliado) {
    return false;
  }

  const faseAntigaValida = [
    "dados_confirmados",
    "qualificado"
  ].includes(lead.faseQualificacao);

  const statusAntigoValido =
    lead.status === "quente" ||
    lead.status === "dados_confirmados";

  const faseNovaValida = [
    "confirmacao_dados",
    "pre_analise"
  ].includes(lead.faseFunil);

  const temperaturaNovaValida =
    lead.temperaturaComercial === "quente";

  const statusOperacionalPermiteEnvio =
    ![
      "em_atendimento",
      "enviado_crm",
      "fechado",
      "perdido",
      "erro_envio_crm"
    ].includes(lead.statusOperacional);

  const qualificacaoComercialOk =
    lead.interesseReal === true &&
    lead.taxaAlinhada === true &&
    etapas.investimento === true &&
    etapas.compromisso === true;

  const caminhoAntigoValido = faseAntigaValida && statusAntigoValido;
  const caminhoNovoValido = faseNovaValida && temperaturaNovaValida;

  return Boolean(
    dadosConfirmados &&
    lead.crmEnviado !== true &&
    statusOperacionalPermiteEnvio &&
    temDadosObrigatorios &&
    qualificacaoComercialOk &&
    (caminhoAntigoValido || caminhoNovoValido)
  );
}

async function sendLeadToCrmOnce({
  from,
  lead = {},
  ultimaMensagem = ""
} = {}) {
  /*
    ETAPA 9 PRODUÇÃO — envio único e rastreável ao consultor/CRM.

    Explicação simples:
    Antes, o sistema podia marcar crmEnviado antes de notificar o consultor.
    Agora ele só marca crmEnviado depois que notifyConsultant() dá certo.
  */

  await connectMongo();

  const leadAtual = await loadLeadProfile(from);
  const leadParaEnviar = {
    ...(leadAtual || {}),
    ...(lead || {}),
    user: from,
    telefoneWhatsApp: from,
    ultimaMensagem: ultimaMensagem || lead?.ultimaMensagem || leadAtual?.ultimaMensagem || ""
  };

  if (!canSendLeadToCRM(leadParaEnviar)) {
    await db.collection("crm_send_logs").insertOne({
      user: from,
      status: "skipped_not_allowed",
      reason: "canSendLeadToCRM_false",
      snapshot: buildLeadAuditSnapshot(leadParaEnviar || {}),
      createdAt: new Date()
    });

    console.log("🚫 CRM não enviado: requisitos ainda não permitem envio.", {
      user: from,
      canSendLeadToCRM: false,
      snapshot: buildLeadAuditSnapshot(leadParaEnviar || {})
    });

    return {
      ok: false,
      skipped: true,
      reason: "canSendLeadToCRM_false"
    };
  }

  const lockResult = await db.collection("leads").findOneAndUpdate(
    {
      user: from,
      crmEnviado: { $ne: true },
      crmSendInProgress: { $ne: true }
    },
    {
      $set: {
        crmSendInProgress: true,
        crmSendStartedAt: new Date(),
        crmSendStatus: "in_progress",
        crmLastAttemptAt: new Date(),
        updatedAt: new Date()
      }
    },
    {
      returnDocument: "after"
    }
  );

  const lockedLead = lockResult?.value || lockResult;

  if (!lockedLead) {
    const existingLead = await loadLeadProfile(from);

    await db.collection("crm_send_logs").insertOne({
      user: from,
      status: existingLead?.crmEnviado === true ? "skipped_already_sent" : "skipped_locked",
      reason: existingLead?.crmEnviado === true
        ? "crm_already_sent"
        : "crm_send_in_progress_or_lock_failed",
      snapshot: buildLeadAuditSnapshot(existingLead || {}),
      createdAt: new Date()
    });

    console.log("🔒 CRM não enviado: já enviado ou envio em andamento.", {
      user: from,
      crmEnviado: existingLead?.crmEnviado === true,
      crmSendInProgress: existingLead?.crmSendInProgress === true
    });

    return {
      ok: existingLead?.crmEnviado === true,
      alreadySent: existingLead?.crmEnviado === true,
      skipped: true,
      reason: existingLead?.crmEnviado === true
        ? "crm_already_sent"
        : "crm_send_in_progress_or_lock_failed"
    };
  }

  try {
    const notificationResult = await notifyConsultant({
      ...lockedLead,
      user: from,
      telefoneWhatsApp: from,
      ultimaMensagem: ultimaMensagem || lockedLead?.ultimaMensagem || ""
    });

    await db.collection("leads").updateOne(
      { user: from },
      {
        $set: {
          crmEnviado: true,
          crmEnviadoEm: new Date(),
          crmSendInProgress: false,
          crmSendStatus: "success",
          crmSendError: "",
          crmNotificationResult: notificationResult || {},
          faseQualificacao: "enviado_crm",
          status: "enviado_crm",
          statusOperacional: "enviado_crm",
          faseFunil: "crm",
          temperaturaComercial: "quente",
          rotaComercial:
            lockedLead?.rotaComercial ||
            lockedLead?.origemConversao ||
            "homologado",
          updatedAt: new Date()
        }
      }
    );

    const sentLead = await loadLeadProfile(from);

    await db.collection("crm_send_logs").insertOne({
      user: from,
      status: "success",
      consultantPhone: process.env.CONSULTANT_PHONE || "",
      snapshot: buildLeadAuditSnapshot(sentLead || {}),
      createdAt: new Date()
    });

    console.log("🚀 Lead enviado ao consultor/CRM com sucesso:", {
      user: from,
      crmEnviado: true,
      statusOperacional: "enviado_crm"
    });

    return {
      ok: true,
      alreadySent: false,
      lead: sentLead
    };
  } catch (error) {
    await db.collection("leads").updateOne(
      { user: from },
      {
        $set: {
          crmEnviado: false,
          crmSendInProgress: false,
          crmSendStatus: "failed",
          crmSendError: error.message,
          statusOperacional: "erro_envio_crm",
          ultimoErroEnvioCrmEm: new Date(),
          updatedAt: new Date()
        }
      }
    );

    await db.collection("crm_send_logs").insertOne({
      user: from,
      status: "failed",
      errorMessage: error.message,
      snapshot: buildLeadAuditSnapshot(lockedLead || {}),
      createdAt: new Date()
    });

    console.error("❌ Falha ao enviar lead ao consultor/CRM:", {
      user: from,
      erro: error.message
    });

    return {
      ok: false,
      skipped: false,
      reason: "notify_consultant_failed",
      errorMessage: error.message
    };
  }
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

/* =========================
   AFILIADOS — GATILHO CAUTELOSO PÓS-TAXA
   Não usar "trava" genérica.
   Só oferecer Afiliados quando houver pedido claro de alternativa,
   desistência explícita ou recusa persistente após tentativas.
========================= */

function normalizeAffiliateFallbackIntent(text = "") {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isClearAlternativeRequestWithoutFee(text = "") {
  const t = normalizeAffiliateFallbackIntent(text);

  if (!t) return false;

  return /\b(outra opcao|outra forma|outra alternativa|alguma alternativa|alternativa sem taxa|opcao sem taxa|modelo sem taxa|sem essa taxa|sem taxa|sem pagar taxa|sem pagar|sem investimento|modelo mais simples|opcao mais simples|tem outra opcao|tem alguma outra forma|nao tem outra opcao|nenhuma outra opcao|voce nao tem nenhuma outra opcao|voces nao tem nenhuma outra opcao)\b/i.test(t);
}

function isPersistentFeeRefusal(text = "") {
  const t = normalizeAffiliateFallbackIntent(text);

  if (!t) return false;

  return /\b(ja disse que nao tenho como pagar|ja falei que nao tenho como pagar|nao tenho como pagar|nao consigo pagar|nao tenho dinheiro|sem condicoes|e inviavel|inviavel|nao cabe pra mim|nao cabe para mim|nao da pra mim|nao da para mim|nao consigo seguir com essa taxa|nao consigo continuar com essa taxa)\b/i.test(t);
}

function isExplicitMainProjectGiveUpBecauseFee(text = "") {
  const t = normalizeAffiliateFallbackIntent(text);

  if (!t) return false;

  return /\b(entao nao vou ter como trabalhar|entao nao vou conseguir trabalhar|nao vou ter como trabalhar com voces|nao vou conseguir trabalhar com voces|entao nao da|entao nao vai dar|vou deixar pra la|vou desistir|desisto|nao vou seguir|nao consigo participar|nao tenho como participar|nesse formato nao consigo|com essa taxa nao consigo)\b/i.test(t);
}

function isTemporaryTaxHesitationOnly(text = "") {
  const t = normalizeAffiliateFallbackIntent(text);

  if (!t) return false;

  /*
    Estes casos NÃO devem puxar Afiliados automaticamente.
    São dúvidas ou travas recuperáveis.
  */
  return /\b(achei caro|vou pensar|preciso pensar|preciso falar com|vou ver com|tem contrato|tem garantia|qual garantia|e se eu nao vender|tem como parcelar|parcela|boleto|cartao|pix|nao entendi|me explica melhor)\b/i.test(t);
}

function shouldOfferAffiliateByQualifiedFallback({
  lead = {},
  text = "",
  semanticIntent = {}
} = {}) {
  const taxaObjectionCount = Number(lead?.taxaObjectionCount || 0);

  const alreadyInTaxConversation =
    taxaObjectionCount > 0 ||
    lead?.taxaModoConversao === true ||
    lead?.sinalObjecaoTaxa === true ||
    lead?.etapas?.taxaPerguntada === true ||
    lead?.etapas?.investimento === true;

  const askedAlternative = isClearAlternativeRequestWithoutFee(text);
  const persistentFeeRefusal = isPersistentFeeRefusal(text);
  const explicitGiveUp = isExplicitMainProjectGiveUpBecauseFee(text);
  const temporaryOnly = isTemporaryTaxHesitationOnly(text);

  /*
    Segurança:
    Se é só uma dúvida/trava temporária, não oferecer Afiliados por esta regra.
  */
  if (temporaryOnly && !askedAlternative && !persistentFeeRefusal && !explicitGiveUp) {
    return {
      shouldOffer: false,
      reason: "apenas_duvida_ou_trava_temporaria"
    };
  }

  /*
    Segurança:
    Se nem começou conversa real de taxa, não puxa Afiliados.
    Isso evita oferecer Afiliados cedo demais.
  */
  if (!alreadyInTaxConversation) {
    return {
      shouldOffer: false,
      reason: "taxa_ainda_nao_foi_tratada_suficientemente"
    };
  }

  /*
    Cenário A:
    Lead pediu outra opção/forma sem taxa.
    Só oferecemos se já houve pelo menos 2 sinais/tentativas de taxa.
    Assim não estragamos a primeira recuperação do Homologado.
  */
  if (askedAlternative && taxaObjectionCount >= 2) {
    return {
      shouldOffer: true,
      reason: "lead_pediu_alternativa_sem_taxa_apos_tentativas"
    };
  }

  /*
    Cenário B:
    Lead desistiu explicitamente de trabalhar/participar por causa da taxa.
    Com 2 tentativas, já é melhor recuperar via Afiliados do que despedir.
  */
  if (explicitGiveUp && taxaObjectionCount >= 2) {
    return {
      shouldOffer: true,
      reason: "lead_desistiu_do_homologado_por_taxa_apos_tentativas"
    };
  }

  /*
    Cenário C:
    Recusa persistente da taxa.
    Aqui esperamos 3 tentativas/sinais para preservar o fluxo bom do Homologado.
  */
  if (persistentFeeRefusal && taxaObjectionCount >= 3) {
    return {
      shouldOffer: true,
      reason: "recusa_persistente_taxa_apos_tres_tentativas"
    };
  }

  /*
    Cenário D:
    O classificador marcou objeção de preço e o contador já passou de 3.
    Só usamos isso se também houver texto forte de recusa ou alternativa.
  */
  if (
    semanticIntent?.priceObjection === true &&
    taxaObjectionCount >= 3 &&
    (askedAlternative || persistentFeeRefusal || explicitGiveUp)
  ) {
    return {
      shouldOffer: true,
      reason: "objecao_preco_persistente_com_sinal_qualificado"
    };
  }

  return {
    shouldOffer: false,
    reason: "sem_gatilho_qualificado_para_afiliado"
  };
}

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

function shouldSendAffiliateInstructionsNow({
  text = "",
  lead = {},
  semanticIntent = null,
  commercialRouteDecision = null,
  awaitingConfirmation = false
} = {}) {
  /*
    ETAPA 10 PRODUÇÃO — saída segura para Afiliados.

    Explicação simples:
    Esta função decide quando o sistema deve parar de insistir no Homologado
    e enviar as instruções do Programa de Afiliados.

    Importante:
    - Não joga para Afiliado só porque o lead achou caro.
    - Não joga para Afiliado só porque o lead disse "vou pensar".
    - Envia Afiliado quando o lead pede claramente link, afiliado, sem estoque,
      sem taxa, ou quando rejeita claramente continuar no Homologado.
  */

  const rawText = String(text || "").trim();

  const t = normalizeTextForIntent(rawText);

  const leadFinalizouHomologado =
    leadHasFinishedPreCadastro(lead || {}) === true ||
    lead?.crmEnviado === true ||
    lead?.statusOperacional === "enviado_crm" ||
    lead?.faseFunil === "crm" ||
    lead?.status === "enviado_crm" ||
    lead?.faseQualificacao === "enviado_crm";

  if (leadFinalizouHomologado) {
    return {
      shouldSend: false,
      reason: "homologado_ja_finalizado"
    };
  }

  const fluxoDeDadosProtegido =
    awaitingConfirmation === true ||
    isDataFlowState(lead || {}) ||
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final",
      "aguardando_confirmacao_dados"
    ].includes(lead?.faseQualificacao) ||
    [
      "coleta_dados",
      "confirmacao_dados",
      "pre_analise"
    ].includes(lead?.faseFunil);

  if (fluxoDeDadosProtegido) {
    return {
      shouldSend: false,
      reason: "fluxo_de_dados_protegido"
    };
  }

  // 🧭 REGRA CAUTELOSA — Afiliados como alternativa após recusa qualificada da taxa
  const qualifiedAffiliateFallback = shouldOfferAffiliateByQualifiedFallback({
    lead,
    text: rawText,
    semanticIntent
  });

  if (qualifiedAffiliateFallback.shouldOffer === true) {
    return {
      shouldSend: true,
      reason: qualifiedAffiliateFallback.reason,
      responseMode: "recovery_affiliate"
    };
  }
   
  if (lead?.afiliadoInstrucoesEnviadas === true) {
    return {
      shouldSend: false,
      reason: "afiliado_ja_enviado"
    };
  }

  const confidenceOk = hasUsableSemanticConfidence(semanticIntent?.confidence);

  const routeAfiliadoClara =
    commercialRouteDecision?.rota === "afiliado" &&
    commercialRouteDecision?.deveResponderAgora === true;

  const semanticAfiliadoClaro =
    confidenceOk &&
    semanticIntent?.wantsAffiliate === true &&
    semanticIntent?.wantsHomologado !== true;

  const fallbackAfiliadoTextoClaro =
    isClearAffiliateFallbackIntent(rawText) ||
    isAffiliateIntent(rawText) ||
    t.includes("quero ser afiliado") ||
    t.includes("quero afiliado") ||
    t.includes("programa de afiliados") ||
    t.includes("link de afiliado") ||
    t.includes("cadastro de afiliado") ||
    t.includes("vender por link") ||
    t.includes("divulgar por link") ||
    t.includes("so divulgar") ||
    t.includes("só divulgar") ||
    t.includes("sem estoque") ||
    t.includes("sem taxa") ||
    t.includes("sem adesao") ||
    t.includes("sem adesão");

  const rejeicaoClaraHomologado =
    t.includes("nao quero mais seguir") ||
    t.includes("não quero mais seguir") ||
    t.includes("nao quero continuar") ||
    t.includes("não quero continuar") ||
    t.includes("nao vou continuar") ||
    t.includes("não vou continuar") ||
    t.includes("nao quero homologado") ||
    t.includes("não quero homologado") ||
    t.includes("nao quero esse programa") ||
    t.includes("não quero esse programa") ||
    t.includes("nao e pra mim") ||
    t.includes("não é pra mim") ||
    t.includes("desisti") ||
    t.includes("vou desistir") ||
    t.includes("quero desistir") ||
    t.includes("deixa pra la") ||
    t.includes("deixa pra lá") ||
    t.includes("encerra") ||
    t.includes("pode encerrar");

  const objecaoPrecoSozinha =
    confidenceOk &&
    semanticIntent?.priceObjection === true &&
    semanticIntent?.wantsAffiliate !== true &&
    semanticIntent?.stockObjection !== true &&
    fallbackAfiliadoTextoClaro !== true &&
    rejeicaoClaraHomologado !== true;

  if (objecaoPrecoSozinha) {
    return {
      shouldSend: false,
      reason: "objecao_preco_sozinha_nao_vira_afiliado"
    };
  }

  if (routeAfiliadoClara || semanticAfiliadoClaro || fallbackAfiliadoTextoClaro) {
    return {
      shouldSend: true,
      responseMode: "direct_affiliate",
      reason: "lead_pediu_afiliado_ou_modelo_sem_estoque"
    };
  }

  const abandonoSemantico =
    confidenceOk &&
    (
      semanticIntent?.delayOrAbandonment === true ||
      semanticIntent?.blockingObjection === true
    ) &&
    semanticIntent?.wantsHomologado !== true &&
    (
      semanticIntent?.stockObjection === true ||
      rejeicaoClaraHomologado === true
    );

  const repetiuTravaDepoisDeRecuperacao =
    Number(lead?.recoveryAttempts || 0) >= 1 &&
    (
      rejeicaoClaraHomologado === true ||
      abandonoSemantico === true
    );

  if (rejeicaoClaraHomologado || abandonoSemantico || repetiuTravaDepoisDeRecuperacao) {
    return {
      shouldSend: true,
      responseMode: "fallback_after_homologado",
      reason: "lead_rejeitou_ou_nao_quis_continuar_homologado"
    };
  }

 // Se o lead rejeitou explicitamente múltiplas vezes e já houve tentativa de recovery,
  // oferecer Afiliado mesmo sem taxaObjectionCount acumulado
  const mensagemERejeicaoExplicita =
    /\b(desisto|quero desistir|não vou pagar|nao vou pagar|não quero|nao quero|não é pra mim|nao e pra mim|tchau|pode encerrar|encerra|deixa quieto|deixa pra la|deixa pra lá|nao tenho interesse|não tenho interesse)\b/i.test(t);

  const recoveryEsgotado =
    Number(currentLead?.recoveryAttempts || 0) >= 1 &&
    mensagemERejeicaoExplicita &&
    !leadFinalizouHomologado &&
    !fluxoDeDadosProtegido;

  if (recoveryEsgotado) {
    return {
      shouldSend: true,
      responseMode: "fallback_after_homologado",
      reason: "lead_rejeitou_multiplas_vezes_e_recovery_esgotado"
    };
  }

  return {
    shouldSend: false,
    reason: "sem_sinal_suficiente_para_afiliado"
  };
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
  // Todos os arquivos podem ser enviados a qualquer momento.
  // O modelo de contrato é para leitura prévia.
  // A versão oficial para assinatura é liberada pela equipe IQG após análise.
  return true;
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
  /*
    ETAPA 7 PRODUÇÃO — arquivo só é marcado como enviado depois do sucesso real.

    Explicação simples:
    Antes, o sistema marcava "enviado" antes de enviar.
    Se o WhatsApp falhasse, o Mongo ficava dizendo que enviou, mas o lead não recebia.

    Agora:
    1. tenta enviar primeiro;
    2. se der certo, marca sentFiles;
    3. se falhar, NÃO marca sentFiles;
    4. grava log do erro para auditoria.
  */

  if (!FILES[key]) {
    console.error("❌ Arquivo solicitado não existe em FILES:", {
      user: from,
      arquivo: key
    });

    await connectMongo();

    await db.collection("file_send_logs").insertOne({
      user: from,
      fileKey: key,
      status: "failed",
      reason: "file_key_not_found",
      createdAt: new Date()
    });

    return false;
  }

  await connectMongo();

  const sentField = `sentFiles.${key}`;

  const lead = await db.collection("leads").findOne({ user: from });

  if (lead?.sentFiles?.[key]) {
    console.log("📎 Arquivo não reenviado porque já foi enviado:", {
      user: from,
      arquivo: key,
      enviadoEm: lead.sentFiles[key]
    });

    await db.collection("file_send_logs").insertOne({
      user: from,
      fileKey: key,
      filename: FILES[key]?.filename || "",
      status: "skipped_already_sent",
      alreadySentAt: lead.sentFiles[key],
      createdAt: new Date()
    });

    return false;
  }

  try {
    await db.collection("file_send_logs").insertOne({
      user: from,
      fileKey: key,
      filename: FILES[key]?.filename || "",
      status: "started",
      createdAt: new Date()
    });

    await delay(2000);

    const sendResult = await sendWhatsAppDocument(from, FILES[key]);

    await db.collection("leads").updateOne(
      { user: from },
      {
        $set: {
          [sentField]: new Date(),
          [`sentFileDetails.${key}`]: {
            filename: FILES[key]?.filename || "",
            mediaId: sendResult?.mediaId || "",
            messageId: sendResult?.messageId || "",
            sentAt: new Date()
          },
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    await db.collection("file_send_logs").insertOne({
      user: from,
      fileKey: key,
      filename: FILES[key]?.filename || "",
      status: "success",
      mediaId: sendResult?.mediaId || "",
      messageId: sendResult?.messageId || "",
      createdAt: new Date()
    });

    console.log("✅ Arquivo marcado como enviado após sucesso real:", {
      user: from,
      arquivo: key,
      filename: FILES[key]?.filename || "",
      mediaId: sendResult?.mediaId || "",
      messageId: sendResult?.messageId || ""
    });

    return true;
  } catch (error) {
    console.error("❌ Falha ao enviar arquivo. NÃO será marcado como enviado:", {
      user: from,
      arquivo: key,
      filename: FILES[key]?.filename || "",
      erro: error.message
    });

    await db.collection("file_send_logs").insertOne({
      user: from,
      fileKey: key,
      filename: FILES[key]?.filename || "",
      status: "failed",
      errorMessage: error.message,
      createdAt: new Date()
    });

    return false;
  }
}

function getBrazilNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + BUSINESS_TIMEZONE_OFFSET * 60 * 60 * 1000);
}

function getGreetingByBrazilTime() {
  const now = getBrazilNow();
  const hour = now.getHours();

  if (hour >= 5 && hour < 12) {
    return "bom dia";
  }

  if (hour >= 12 && hour < 18) {
    return "boa tarde";
  }

  return "boa noite";
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

Se surgir alguma dúvida depois, é só me chamar por aqui.`;
  }

  if (jaEstaEmAfiliado) {
    return `${prefixo}vou encerrar por aqui 😊

O caminho mais indicado pra você neste momento é o Programa de Afiliados IQG.

Você pode se cadastrar e começar divulgando por link, sem estoque físico e sem taxa de adesão do Parceiro Homologado.

O cadastro é por aqui:
https://minhaiqg.com.br/

Se depois quiser entender também o Parceiro Homologado, é só me chamar por aqui.`;
  }

  if (jaEstaEmAmbos) {
    return `${prefixo}vou encerrar por aqui 😊

Só reforçando a diferença:

No Programa de Afiliados, você divulga por link, não precisa ter estoque físico e não tem a taxa de adesão do Parceiro Homologado.

No Parceiro Homologado, o modelo é mais estruturado, com produtos físicos, lote em comodato, suporte, treinamento, contrato e taxa de adesão.

Se quiser seguir por um caminho mais leve agora, pode começar pelo Afiliados:
https://minhaiqg.com.br/

E se depois quiser retomar o Parceiro Homologado, é só me chamar por aqui.`;
  }

  return `${prefixo}vou encerrar por aqui por enquanto 😊

Fico à disposição caso queira retomar depois ou tirar alguma dúvida sobre o Programa Parceiro Homologado IQG.

E se neste momento você preferir começar de uma forma mais simples, sem estoque físico e divulgando por link, também existe o Programa de Afiliados IQG.

O cadastro de afiliado é por aqui:
https://minhaiqg.com.br/

Se quiser retomar a conversa, é só me chamar por aqui.`;
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
   
function isLeadInProtectedFollowupState(lead = {}) {
  const status = lead?.status || "";
  const faseQualificacao = lead?.faseQualificacao || "";
  const statusOperacional = lead?.statusOperacional || "";
  const faseFunil = lead?.faseFunil || "";

  const isHumanOrFinal =
    lead?.botBloqueadoPorHumano === true ||
    lead?.humanoAssumiu === true ||
    lead?.atendimentoHumanoAtivo === true ||
    lead?.crmEnviado === true ||
    lead?.dadosConfirmadosPeloLead === true ||
    ["em_atendimento", "enviado_crm", "fechado", "perdido", "erro_envio_crm"].includes(statusOperacional) ||
    ["enviado_crm", "em_atendimento", "fechado", "perdido", "dados_confirmados"].includes(status) ||
    ["enviado_crm", "em_atendimento", "fechado", "perdido", "dados_confirmados"].includes(faseQualificacao) ||
    ["pre_analise", "crm", "encerrado"].includes(faseFunil);

  const isDataFlow =
    lead?.aguardandoConfirmacaoCampo === true ||
    lead?.aguardandoConfirmacao === true ||
    ["coleta_dados", "confirmacao_dados"].includes(faseFunil) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final"
    ].includes(status) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "corrigir_dado",
      "corrigir_dado_final",
      "aguardando_valor_correcao_final"
    ].includes(faseQualificacao);

  return isHumanOrFinal || isDataFlow;
}

function historyOrLeadIndicatesTaxExplained(lead = {}, historyText = "") {
  const etapas = lead?.etapas || {};

  return Boolean(
    etapas.investimento === true ||
    lead?.taxaAlinhada === true ||
    /\b(taxa de ades[aã]o|taxa|investimento|r\$ ?1\.990|1990|1\.990|10x de r\$ ?199|10x de 199)\b/i.test(historyText || "")
  );
}

function historyOrLeadIndicatesResponsibilitiesExplained(lead = {}, historyText = "") {
  const etapas = lead?.etapas || {};

  return Boolean(
    etapas.responsabilidades === true ||
    etapas.compromisso === true ||
    /\b(respons[aá]vel|responsabilidades|guarda|conserva[cç][aã]o|vendas ativamente|relacionamento ativo|comunica[cç][aã]o correta|depende da sua atua[cç][aã]o)\b/i.test(historyText || "")
  );
}

function getSafeStageFollowupMessage(lead = {}, step = 1, history = []) {
  const nome = getFirstName(lead.nomeWhatsApp || lead.nome || "");
  const prefixo = nome ? `${nome}, ` : "";

  const rotaComercial = lead.rotaComercial || lead.origemConversao || "";
  const faseFunil = lead.faseFunil || "";
  const faseQualificacao = lead.faseQualificacao || "";
  const status = lead.status || "";
  const fase = faseFunil || faseQualificacao || status;
  const etapas = lead?.etapas || {};

  const historyText = Array.isArray(history)
    ? history
        .slice(-25)
        .map(m => `${m.role || ""}: ${m.content || ""}`)
        .join("\n")
    : "";

  const isAfiliado =
    rotaComercial === "afiliado" ||
    fase === "afiliado" ||
    lead.interesseAfiliado === true;

  if (isAfiliado) {
    if (step <= 1) {
      return `${prefixo}conseguiu acessar o cadastro de afiliado? 😊 O link é: https://minhaiqg.com.br/`;
    }

    return `${prefixo}se quiser começar sem estoque físico e sem a taxa de adesão do Homologado, o Programa de Afiliados pode ser um bom primeiro passo. O cadastro é aqui: https://minhaiqg.com.br/`;
  }

  const isAmbos =
    rotaComercial === "ambos" ||
    fase === "ambos";

  if (isAmbos) {
    if (step <= 1) {
      return `${prefixo}ficou clara a diferença entre o Programa de Afiliados e o Parceiro Homologado? 😊`;
    }

    return `${prefixo}se quiser, posso te ajudar a escolher o caminho mais adequado: Afiliado, Homologado ou os dois.`;
  }

  const taxaFoiExplicada = historyOrLeadIndicatesTaxExplained(lead, historyText);
  const responsabilidadesForamExplicadas = historyOrLeadIndicatesResponsibilitiesExplained(lead, historyText);

  /*
    Regra 1:
    Se já pode iniciar coleta, o follow-up não volta para taxa,
    estoque, benefícios ou responsabilidades.
  */
  if (canStartDataCollection(lead)) {
    return `${prefixo}podemos seguir com seu pré-cadastro como Parceiro Homologado IQG. Para começar, me envie seu nome completo.`;
  }

  /*
    Regra 2:
    Nunca falar de taxa se a taxa ainda não foi realmente explicada.
    Isso corrige o follow-up contaminado.
  */
  if (!taxaFoiExplicada) {
    if (faseFunil === "estoque" || etapas.estoque === true) {
      return `${prefixo}ficou alguma dúvida sobre o lote inicial em comodato ou sobre como você começa sem precisar comprar estoque?`;
    }

    if (etapas.beneficios === true) {
      return `${prefixo}ficou alguma dúvida sobre os benefícios, suporte ou treinamento do Programa Parceiro Homologado IQG?`;
    }

    if (etapas.programa === true) {
      return `${prefixo}ficou alguma dúvida sobre como funciona o Programa Parceiro Homologado IQG?`;
    }

    return `${prefixo}vi que você demonstrou interesse no Programa Parceiro Homologado IQG. Quer que eu te explique de forma simples como funciona?`;
  }

  /*
    Regra 3:
    Se a taxa foi explicada, mas ainda não foi aceita,
    retomar de forma consultiva, sem repetir o texto inteiro.
  */
  if (taxaFoiExplicada && lead?.taxaAlinhada !== true) {
    return `${prefixo}pensando no que conversamos sobre o investimento, faz sentido eu te ajudar a avaliar se o modelo de Parceiro Homologado se encaixa para você agora?`;
  }

  /*
    Regra 4:
    Se taxa e responsabilidades já foram explicadas,
    chamar para pré-análise, sem repetir tudo.
  */
  if (taxaFoiExplicada && responsabilidadesForamExplicadas && lead?.interesseReal !== true) {
    return `${prefixo}pelo que conversamos, você já entendeu a estrutura do projeto. Quer seguir para a pré-análise do Parceiro Homologado?`;
  }

  /*
    Regra 5:
    Se ainda faltar responsabilidade de verdade, perguntar curto.
    Mas sem textão.
  */
  if (!responsabilidadesForamExplicadas) {
    return `${prefixo}ficou alguma dúvida sobre as responsabilidades de atuação como Parceiro Homologado?`;
  }

  return `${prefixo}quer seguir com o próximo passo para avaliarmos seu pré-cadastro como Parceiro Homologado IQG?`;
}

async function saveAutomaticFollowupToHistory(from, messageToSend = "", meta = {}) {
  const cleanMessage = sanitizeWhatsAppText(messageToSend || "");

  if (!cleanMessage) return;

  try {
    const history = await loadConversation(from);

    const updatedHistory = [
  ...(Array.isArray(history) ? history : []),
  {
    role: "assistant",
    content: cleanMessage,
    origem: "followup_automatico",
    followupStep: meta.step || null,
    createdAt: new Date()
  }
];

    await saveConversation(from, updatedHistory);

    await saveLeadProfile(from, {
      ultimoFollowupAutomatico: {
        mensagem: cleanMessage,
        step: meta.step || null,
        faseFunil: meta.faseFunil || "",
        faseQualificacao: meta.faseQualificacao || "",
        enviadoEm: new Date()
      }
    });

    auditLog("Follow-up automatico salvo no historico", {
      user: maskPhone(from),
      mensagem: cleanMessage,
      step: meta.step || null,
      faseFunil: meta.faseFunil || "",
      faseQualificacao: meta.faseQualificacao || ""
    });
  } catch (error) {
    console.error("⚠️ Follow-up enviado, mas falhou ao salvar no histórico:", {
      user: from,
      erro: error.message
    });
  }
}

async function sendAutomaticFollowupIfStillValid({
  from,
  followup,
  scheduleVersion
} = {}) {
  const currentState = getState(from);

  if (currentState.closed) return false;

  if (Number(currentState.followupVersion || 0) !== Number(scheduleVersion || 0)) {
    console.log("🔕 Follow-up cancelado: versão antiga do timer.", {
      user: from,
      scheduleVersion,
      currentVersion: currentState.followupVersion
    });

    return false;
  }

  const latestLead = await loadLeadProfile(from);

  if (shouldStopBotByLifecycle(latestLead) || isLeadInProtectedFollowupState(latestLead)) {
    currentState.closed = shouldStopBotByLifecycle(latestLead) ? true : currentState.closed;
    clearTimers(from);

    console.log("🔕 Follow-up cancelado: lead em estado protegido/finalizado/coleta/humano.", {
      user: from,
      status: latestLead?.status || "-",
      faseQualificacao: latestLead?.faseQualificacao || "-",
      statusOperacional: latestLead?.statusOperacional || "-",
      faseFunil: latestLead?.faseFunil || "-"
    });

    return false;
  }

  const latestHistory = await loadConversation(from);

  const messageToSend = followup.getMessage
    ? followup.getMessage(latestLead, latestHistory)
    : getSafeStageFollowupMessage(latestLead, followup.step || 1, latestHistory);

  if (!messageToSend || !String(messageToSend).trim()) {
    console.log("🔕 Follow-up cancelado: mensagem vazia.", {
      user: from,
      step: followup.step || null
    });

    return false;
  }

  await sendWhatsAppMessage(from, messageToSend);

  await saveAutomaticFollowupToHistory(from, messageToSend, {
    step: followup.step || null,
    faseFunil: latestLead?.faseFunil || "",
    faseQualificacao: latestLead?.faseQualificacao || ""
  });

  console.log("⏰ Follow-up automático enviado:", {
    user: from,
    step: followup.step || null,
    faseFunil: latestLead?.faseFunil || "-",
    faseQualificacao: latestLead?.faseQualificacao || "-"
  });

  if (followup.closeAfter) {
    currentState.closed = true;
    clearTimers(from);
  }

  return true;
}

function scheduleLeadFollowups(from) {
  const state = getState(from);

  if (state.closed) return;

  clearTimers(from);

  const scheduleVersion = Number(state.followupVersion || 0);

  state.inactivityFollowupCount = 0;
  state.followupTimers = [];
  state.followupScheduledAtMs = Date.now();

  const followups = [
    /*
      PRODUÇÃO IQG:
      - Follow-up de 6 minutos removido.
      - Follow-up de 6 horas removido.
      - Retomada começa em 30 minutos.
      - Todos os follow-ups recebem histórico real.
    */
    {
      step: 1,
      delay: 30 * 60 * 1000,
      getMessage: (lead, history) => getSafeStageFollowupMessage(lead, 1, history)
    },
    {
      step: 2,
      delay: 12 * 60 * 60 * 1000,
      getMessage: (lead, history) => getSafeStageFollowupMessage(lead, 2, history),
      businessOnly: true
    },
    {
      step: 3,
      delay: 18 * 60 * 60 * 1000,
      getMessage: (lead, history) => getSafeStageFollowupMessage(lead, 3, history),
      businessOnly: true
    },
    {
      step: 4,
      delay: 24 * 60 * 60 * 1000,
      getMessage: (lead, history) => getSafeStageFollowupMessage(lead, 4, history),
      businessOnly: true
    },
    {
      step: 5,
      delay: 30 * 60 * 60 * 1000,
      getMessage: (lead, history) => getFinalFollowupMessage(lead, history),
      businessOnly: true,
      closeAfter: true
    }
  ];

  for (const followup of followups) {
    const timer = setTimeout(async () => {
      try {
        const currentState = getState(from);

        if (currentState.closed) return;

        if (Number(currentState.followupVersion || 0) !== Number(scheduleVersion || 0)) {
          console.log("🔕 Follow-up ignorado antes de rodar: timer antigo.", {
            user: from,
            step: followup.step,
            scheduleVersion,
            currentVersion: currentState.followupVersion
          });

          return;
        }

        if (followup.businessOnly && !isBusinessTime()) {
          const nextBusinessDelay = getDelayUntilNextBusinessTime();

          const businessTimer = setTimeout(async () => {
            try {
              await sendAutomaticFollowupIfStillValid({
                from,
                followup,
                scheduleVersion
              });
            } catch (error) {
              console.error("Erro no follow-up em horário comercial:", error);
            }
          }, nextBusinessDelay);

          currentState.followupTimers.push(businessTimer);
          return;
        }

        await sendAutomaticFollowupIfStillValid({
          from,
          followup,
          scheduleVersion
        });
      } catch (error) {
        console.error("Erro no follow-up:", error);
      }
    }, followup.delay);

    state.followupTimers.push(timer);
  }

  console.log("⏱️ Follow-ups agendados com versão segura:", {
    user: from,
    scheduleVersion,
    totalTimers: followups.length
  });
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

// 🔎 AUDITORIA — trace_id para agrupar todos os eventos desta mensagem
const auditTraceId = generateTraceId();

await recordAuditEvent({
  traceId: auditTraceId,
  component: AUDIT_COMPONENTS.WEBHOOK,
  eventType: AUDIT_EVENT_TYPES.REQUEST_RECEIVED,
  payload: {
    messageId: message.id || null,
    messageType: message.type || "unknown",
    hasText: Boolean(message.text?.body),
    hasAudio: Boolean(message.audio?.id),
    textPreview: message.text?.body ? String(message.text.body).slice(0, 100) : null
  },
  requiredLevel: "BASIC",
  userPhone: from,
  severity: "low"
});

let leadBeforeProcessing = await loadLeadProfile(from);

     console.log("🔎 Lead antes do processamento:", {
  from,
  status: leadBeforeProcessing?.status || null,
  faseQualificacao: leadBeforeProcessing?.faseQualificacao || null,
  stateClosed: state.closed
});

// 🔕 ETAPA 1 PRODUÇÃO — nova mensagem do lead cancela follow-ups antigos.
// Explicação simples:
// Neste ponto do webhook a variável "text" ainda NÃO foi criada.
// Por isso usamos apenas uma prévia segura da mensagem recebida.
// A limpeza real de memória com "text" acontece mais abaixo, depois que texto/áudio/buffer são processados.
clearTimers(from);

const mensagemPreviewAntesTexto =
  message.text?.body ||
  (message.audio?.id ? "[audio]" : `[${message.type || "mensagem"}]`);

console.log("🔕 Follow-ups antigos cancelados por nova mensagem do lead:", {
  user: from,
  ultimaMensagemLeadPreview: mensagemPreviewAntesTexto,
  novaFollowupVersion: getState(from).followupVersion
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

// ✅ currentLead precisa nascer com "let".
// Sem isso, o Node quebra com:
// ReferenceError: currentLead is not defined
let currentLead = await loadLeadProfile(from);

currentLead = await cleanupStaleOperationalMemory({
  user: from,
  lead: currentLead || {},
  text
});

auditLog("currentLead ANTES do processamento da mensagem", {
  user: maskPhone(from),
  mensagemLead: text,
  currentLead: buildLeadAuditSnapshot(currentLead || {})
});
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

     const homologadoIndicationBenefitGuidance =
  buildHomologadoIndicationBenefitGuidance({
    lead: currentLead || {},
    text,
    forceMentionForPiscineiro: true
  });

if (homologadoIndicationBenefitGuidance) {
  backendStrategicGuidance.push(homologadoIndicationBenefitGuidance);

  console.log("🤝 Benefício de indicação do Parceiro Homologado aplicado ao contexto:", {
    user: from,
    leadIsPiscineiro: iqgLeadLooksLikePiscineiro(text, currentLead || {}),
    leadMentionsIndication: iqgLeadMentionsIndicationNetwork(text),
    tipo: homologadoIndicationBenefitGuidance.tipo
  });
}

     // 🧭 REGRA COMERCIAL PRIORITÁRIA — CNPJ / empresa / ponto físico
if (leadPerguntouSobreCnpjEmpresaOuPontoFisico(text)) {
  backendStrategicGuidance.push({
    tipo: "regra_comercial_cnpj_ponto_fisico",
    prioridade: "critica",
    motivo: "Lead perguntou ou demonstrou dúvida sobre CNPJ, empresa, loja ou ponto físico.",
    orientacaoParaPreSdr: buildOrientacaoCnpjPontoFisicoHomologado()
  });

  console.log("🏢 Regra CNPJ/Ponto físico enviada ao Pré-SDR:", {
    user: from,
    ultimaMensagemLead: text
  });
}

     // 🧠 NÃO REPETIR ETAPAS JÁ ENTENDIDAS — proteção anti-loop conversacional.
// Lê do histórico quais etapas (programa, beneficios, estoque, responsabilidades,
// investimento, compromisso) o lead já disse explicitamente ter entendido.
// Empurra essa lista para o backendStrategicGuidance, para o Pré-SDR orientar
// a SDR a NÃO repetir explicação dessas etapas.
try {
  const etapasJaEntendidasPeloLead = iqgGetExplicitUnderstoodFunnelStepsFromLead({
    lead: currentLead || {},
    history
  });
  if (Array.isArray(etapasJaEntendidasPeloLead) && etapasJaEntendidasPeloLead.length > 0) {
    backendStrategicGuidance.push({
      tipo: "etapas_ja_entendidas_pelo_lead",
      prioridade: "alta",
      motivo: "Lead já confirmou explicitamente entendimento das etapas listadas.",
      orientacaoParaPreSdr:
        [
          `Etapas que o lead JÁ confirmou ter entendido: ${etapasJaEntendidasPeloLead.join(", ")}.`,
          "A SDR NÃO deve repetir explicação dessas etapas.",
          "A SDR NÃO deve perguntar 'quer que eu explique sobre X?' para essas etapas.",
          "Se a SDR achar que precisa avançar, deve ir DIRETO para a próxima etapa pendente, sem reintroduzir tema antigo.",
          "Se TODAS as etapas comerciais já foram entendidas e o lead pediu para seguir, conduzir naturalmente para o próximo passo objetivo (pré-análise, taxa, ou coleta), respeitando a Política do Turno.",
          "Se o lead falar 'podemos seguir', 'pode prosseguir', 'manda ver', tratar como sinal de avanço — NÃO repetir explicação anterior só para 'fechar' etapa."
        ].join("\n"),
      detalhes: {
        etapasEntendidas: etapasJaEntendidasPeloLead
      }
    });
    console.log("🧠 Etapas já entendidas pelo lead enviadas ao Pré-SDR:", {
      user: from,
      ultimaMensagemLead: text,
      etapasEntendidas: etapasJaEntendidasPeloLead
    });
  }
} catch (errorEtapasEntendidas) {
  console.error("⚠️ Falha ao calcular etapas já entendidas, mas atendimento continua:", errorEtapasEntendidas.message);
}
     
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

 const leadMostrouConfusaoForteNaColeta =
  /\b(nao vou passar nenhum dado|não vou passar nenhum dado|nao vou passar dados|não vou passar dados|nao entendi|não entendi|ue|ué|preciso entender melhor|minha duvida era|minha dúvida era|preciso ou nao|preciso ou não|preciso ter cnpj|preciso ter um cnpj|nao tenho empresa|não tenho empresa|nao tenho cnpj|não tenho cnpj)\b/i.test(text || "");

await saveLeadProfile(from, {
  fluxoPausadoPorPergunta: true,
  ultimaPerguntaDuranteColeta: text,
  campoRetomadaColeta,
  ultimaMensagem: text,

  ...(leadMostrouConfusaoForteNaColeta
    ? {
        necessitaAtencaoHumanaDashboard: true,
        motivoAtencaoHumanaDashboard:
          "Lead demonstrou confusão forte durante coleta e recusou/adiou envio de dados até entender melhor.",
        prioridadeAtencaoHumanaDashboard: "alta",
        atencaoHumanaDashboardEm: new Date()
      }
    : {}),

  ultimaDecisaoBackend: buildBackendDecision({
    tipo: "pergunta_durante_coleta",
    motivo: dataFlowRouter?.motivo || "Lead fez pergunta, objeção ou pedido durante coleta/confirmação de dados.",
    acao: "orientar_pre_sdr_sem_responder_direto",
    mensagemLead: text,
    detalhes: {
      faseAtual: currentLead?.faseQualificacao || "",
      faseFunil: currentLead?.faseFunil || "",
      campoEsperado: currentLead?.campoEsperado || "",
      campoPendente: currentLead?.campoPendente || "",
      tipoMensagem: dataFlowRouter?.tipoMensagem || "indefinido",
      deveResponderAntesDeColetar: true,
      deveRetomarColetaDepois: true,
      leadMostrouConfusaoForteNaColeta
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
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: msg,
    currentLead: currentLead || {},
    extras: { tipoSaida: "correcao_explicita_campo", campoParaCorrigir: explicitCorrection.campoParaCorrigir }
  });
   
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
await recordRequestCompleted({
        traceId: auditTraceId,
        userPhone: from,
        mensagemLead: text,
        respostaFinal: msg,
        currentLead: currentLead || {},
        extras: { tipoSaida: "valor_correcao_invalido_nome" }
      });
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
await recordRequestCompleted({
        traceId: auditTraceId,
        userPhone: from,
        mensagemLead: text,
        respostaFinal: msg,
        currentLead: currentLead || {},
        extras: { tipoSaida: "valor_correcao_invalido_cidade_estado", campo }
      });
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
await recordRequestCompleted({
        traceId: auditTraceId,
        userPhone: from,
        mensagemLead: text,
        respostaFinal: msg,
        currentLead: currentLead || {},
        extras: { tipoSaida: "valor_correcao_invalido_uf" }
      });
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
await recordRequestCompleted({
      traceId: auditTraceId,
      userPhone: from,
      mensagemLead: text,
      respostaFinal: msg,
      currentLead: dadosAtualizados || {},
      extras: { tipoSaida: "dado_corrigido_confirmacao_final", campoCorrigido: campo }
    });
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

 const leadMostrouConfusaoForteNaColetaFallback =
  /\b(nao vou passar nenhum dado|não vou passar nenhum dado|nao vou passar dados|não vou passar dados|nao entendi|não entendi|ue|ué|preciso entender melhor|minha duvida era|minha dúvida era|preciso ou nao|preciso ou não|preciso ter cnpj|preciso ter um cnpj|nao tenho empresa|não tenho empresa|nao tenho cnpj|não tenho cnpj)\b/i.test(text || "");

await saveLeadProfile(from, {
  fluxoPausadoPorPergunta: true,
  ultimaPerguntaDuranteColeta: text,
  campoRetomadaColeta,
  ultimaMensagem: text,

  ...(leadMostrouConfusaoForteNaColetaFallback
    ? {
        necessitaAtencaoHumanaDashboard: true,
        motivoAtencaoHumanaDashboard:
          "Lead demonstrou confusão forte durante coleta e recusou/adiou envio de dados até entender melhor.",
        prioridadeAtencaoHumanaDashboard: "alta",
        atencaoHumanaDashboardEm: new Date()
      }
    : {}),

  ultimaDecisaoBackend: buildBackendDecision({
    tipo: "pergunta_real_durante_coleta",
    motivo: "lead_fez_pergunta_real_durante_coleta",
    acao: "orientar_pre_sdr_sem_responder_direto",
    mensagemLead: text,
    detalhes: {
      campoEsperado: currentLead?.campoEsperado || "",
      campoPendente: currentLead?.campoPendente || "",
      deveRetomarColetaDepois: true,
      leadMostrouConfusaoForteNaColeta: leadMostrouConfusaoForteNaColetaFallback
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
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: msg,
    currentLead: currentLead || {},
    extras: { tipoSaida: "confirmacao_campo_pendente", campo: field, valor: value }
  });
  return;
}
     
if (currentLead?.aguardandoConfirmacaoCampo) {
  const campo = currentLead.campoPendente;
  const valor = currentLead.valorPendente;
  let respostaConfirmacaoCampo = "";

  // TRAVA FURADA: se o lead mandou algo que NÃO é confirmação nem dado,
  // verificar se é interrupção comercial e deixar os GPTs responderem
  const mensagemNaoEConfirmacao =
    !isPositiveConfirmation(text) &&
    !isNegativeConfirmation(text) &&
    !isLikelyPureDataAnswer(text, currentLead);

  const mensagemEInterrupcaoComercial =
    mensagemNaoEConfirmacao &&
    (
      isLeadQuestionObjectionOrCorrection(text) ||
      isDeveloperOrContextCorrectionMessage(text) ||
      isLeadRejectingOrCooling(text) ||
      /\b(taxa|valor|preco|preço|investimento|pagar|pagamento|contrato|afiliado|link|desisto|quero desistir|não quero|nao quero|pulou|pulando|esqueceu|se esqueceu|repetindo|repetitiva|nao entendi|não entendi)\b/i.test(text)
    );

  if (mensagemEInterrupcaoComercial) {
    // Lead trouxe pergunta, objeção ou reclamação durante confirmação de campo.
    // NÃO prender no muro de reconfirmação — deixar os GPTs responderem.
    dataFlowQuestionAlreadyGuided = true;

    backendStrategicGuidance.push({
      tipo: "interrupcao_comercial_durante_confirmacao_campo",
      prioridade: "alta",
      motivo: "Lead fez pergunta, objeção ou reclamação durante confirmação de campo.",
      orientacaoParaPreSdr: [
        "O lead estava confirmando um dado cadastral mas trouxe pergunta, objeção ou reclamação.",
        "Responder primeiro a manifestação do lead de forma curta e consultiva.",
        campo && valor
          ? `Depois retomar: confirmar se o ${campo} "${valor}" está correto.`
          : "Depois retomar a confirmação do dado pendente.",
        "Não salvar o texto atual como dado cadastral.",
        "Não reiniciar o cadastro."
      ].filter(Boolean).join("\n")
    });

    await saveLeadProfile(from, {
      fluxoPausadoPorPergunta: true,
      ultimaPerguntaDuranteColeta: text,
      campoRetomadaColeta: campo,
      ultimaMensagem: text
    });

    currentLead = await loadLeadProfile(from);

    console.log("\n\nInterrupção comercial durante confirmação de campo — GPTs vão responder:", {
      user: from,
      ultimaMensagemLead: text,
      campoPendente: campo,
      valorPendente: valor
    });

    // NÃO fazer return — o fluxo segue para os GPTs
  } else if (isPositiveConfirmation(text)) {
     
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
   
  const freshLead = await loadLeadProfile(from);

  const updatedLead = {
    ...(freshLead || {}),
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
await recordRequestCompleted({
      traceId: auditTraceId,
      userPhone: from,
      mensagemLead: text,
      respostaFinal: respostaConfirmacaoCampo,
      currentLead: currentLead || {},
      extras: { tipoSaida: "confirmacao_campo_positiva", campo }
    });
 return;
  } else if (isNegativeConfirmation(text)) {
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
await recordRequestCompleted({
      traceId: auditTraceId,
      userPhone: from,
      mensagemLead: text,
      respostaFinal: msg,
      currentLead: currentLead || {},
      extras: { tipoSaida: "confirmacao_campo_negativa", campo }
    });
   return;
  } else {
    const labels = {
      nome: "nome",
      cpf: "CPF",
      telefone: "telefone",
      cidade: "cidade",
      estado: "estado"
    };
    const respostaReconfirmacao = `Só para confirmar: o ${labels[campo] || campo} "${valor}" está correto?\n\nPode responder sim ou não.`;

    await sendWhatsAppMessage(from, respostaReconfirmacao);
    await saveHistoryStep(from, history, text, respostaReconfirmacao, !!message.audio?.id);

    if (messageId) {
      markMessageAsProcessed(messageId);
    }
    await recordRequestCompleted({
      traceId: auditTraceId,
      userPhone: from,
      mensagemLead: text,
      respostaFinal: respostaReconfirmacao,
      currentLead: currentLead || {},
      extras: { tipoSaida: "reconfirmacao_campo", campo }
    });
    return;
  } // fecha o else (reconfirmação genérica)
} // fecha o if aguardandoConfirmacaoCampo
   
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
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: confirmationMsg,
    currentLead: extractedData || {},
    extras: { tipoSaida: "dados_mudaram_reconfirmacao" }
  });
  return;
}

const leadStatus = classifyLead(text, extractedData, history);
     let leadStatusSeguro = leadStatus;
const strongIntent = isStrongBuyIntent(text);
const leadDeuApenasConfirmacaoFraca = isSoftUnderstandingConfirmation(text);
const leadDeuIntencaoExplicitaPreAnalise = isExplicitPreAnalysisIntent(text);
const collectionMergeState = iqgBuildMergedLeadDataForCollection({
  currentLead: currentLead || {},
  extractedData
});

const normalizedExtractedLeadData = collectionMergeState.normalizedExtractedData;
const mergedLeadDataAfterExtraction = collectionMergeState.mergedLeadData;
const missingFields = collectionMergeState.missingFieldsAfterMerge;
const nextMissingField = collectionMergeState.nextMissingField;
const hasNewRequiredLeadData = collectionMergeState.hasNewRequiredLeadData;
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

     // 🧭 AUTO-CORREÇÃO DA COLETA:
// Se o lead está em dados parciais, mas campoEsperado ficou vazio,
// o backend recalcula o próximo campo faltante real.
// Isso evita a SDR voltar para nome/CPF errado ou ficar perdida.
if (
  estaEmColetaOuConfirmacao &&
  !currentLead?.campoEsperado &&
  !currentLead?.campoPendente &&
  currentLead?.aguardandoConfirmacaoCampo !== true &&
  currentLead?.aguardandoConfirmacao !== true
) {
  const missingFieldsCurrentLead = getMissingLeadFields(currentLead || {});
  const nextCampoEsperadoCurrentLead = missingFieldsCurrentLead[0] || null;

  if (nextCampoEsperadoCurrentLead) {
    await saveLeadProfile(from, {
      campoEsperado: nextCampoEsperadoCurrentLead,
      faseQualificacao: currentLead?.faseQualificacao || "dados_parciais",
      status: currentLead?.status || "dados_parciais",
      ultimaDecisaoBackend: buildBackendDecision({
        tipo: "auto_correcao_campo_esperado_vazio",
        motivo: "Lead estava em coleta/dados parciais sem campoEsperado. Backend recalculou próximo campo faltante real.",
        acao: "retomar_coleta_no_proximo_campo",
        mensagemLead: text,
        detalhes: {
          camposFaltantes: missingFieldsCurrentLead,
          proximoCampoEsperado: nextCampoEsperadoCurrentLead
        }
      })
    });

    currentLead = await loadLeadProfile(from);

    console.log("🧭 Campo esperado da coleta recalculado automaticamente:", {
      user: from,
      proximoCampoEsperado: nextCampoEsperadoCurrentLead,
      camposFaltantes: missingFieldsCurrentLead
    });
  }
}

let semanticIntent = null;

if (estaEmColetaOuConfirmacao && !dataFlowQuestionAlreadyGuided) {
  console.log("🧠 Classificador semântico ignorado durante coleta/confirmação (sem interrupção comercial):", {
    user: from,
    ultimaMensagemLead: text,
    statusAtual: currentLead?.status || "-",
    faseAtual: currentLead?.faseQualificacao || "-",
    faseFunilAtual: currentLead?.faseFunil || "-",
    motivo: "mensagem tratada como dado cadastral, não como intenção comercial"
  });
} else {
  const lastSdrTextForClassifiers = [...history].reverse().find(m => m.role === "assistant")?.content || "";

  const [classifierResult, continuityResult] = await Promise.all([
    runLeadSemanticIntentClassifier({
      lead: currentLead || {},
      history,
      lastUserText: text,
      lastSdrText: lastSdrTextForClassifiers,
      auditTraceId
    }),
    runConversationContinuityAnalyzer({
      lead: currentLead || {},
      history,
      lastUserText: text,
      lastSdrText: lastSdrTextForClassifiers
    })
  ]);

  semanticIntent = classifierResult;
  var earlySemanticContinuity = continuityResult;

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
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: msg,
    currentLead: currentLead || {},
    extras: { tipoSaida: "interesse_real_confirmado_inicio_coleta" }
  });
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

auditLog("Decisao de rota comercial", {
  user: maskPhone(from),
  ultimaMensagemLead: text,
  currentLead: buildLeadAuditSnapshot(currentLead || {}),
  semanticIntent: semanticIntent || {},
  commercialRouteDecision
});

const podeUsarSinalDeRotaAgora =
  !isCriticalCommercialBlockedState({
    lead: currentLead || {},
    awaitingConfirmation
  });

const affiliateInstructionDecision = shouldSendAffiliateInstructionsNow({
  text,
  lead: currentLead || {},
  semanticIntent,
  commercialRouteDecision,
  awaitingConfirmation
});

if (
  podeUsarSinalDeRotaAgora &&
  affiliateInstructionDecision.shouldSend === true
) {
  /*
    ETAPA 10 PRODUÇÃO — envio obrigatório de instruções de Afiliado.

    Explicação simples:
    Quando o lead deixa claro que não quer seguir no Homologado,
    ou pede Afiliado/link/sem estoque, o backend garante a orientação
    de Afiliado e cancela follow-ups antigos do Homologado.
  */

  clearTimers(from);

  const affiliateMsg =
    affiliateInstructionDecision.responseMode === "direct_affiliate"
      ? buildAffiliateResponse(false)
      : buildAffiliateRecoveryResponse();

  await saveLeadProfile(from, {
    status: "afiliado",
    faseQualificacao: "afiliado",
    statusOperacional: "ativo",
    faseFunil: "afiliado",
    rotaComercial: "afiliado",
    origemConversao:
      affiliateInstructionDecision.responseMode === "direct_affiliate"
        ? "interesse_direto_afiliado"
        : "recuperado_para_afiliado",

    interesseAfiliado: true,
    sinalAfiliadoExplicito:
      affiliateInstructionDecision.responseMode === "direct_affiliate",
    afiliadoOferecidoComoAlternativa:
      affiliateInstructionDecision.responseMode !== "direct_affiliate",

    afiliadoInstrucoesEnviadas: true,
    afiliadoInstrucoesEnviadasEm: new Date(),

    // Ao migrar para Afiliados, a objeção de taxa do Homologado vira histórico,
    // mas não deve continuar como trava ativa da conversa.
    taxaModoConversao: false,
    sinalObjecaoTaxa: false,
    bloqueioComercialAtivo: false,
    pendenciaPerguntaComercialAberta: false,
    motivoPendenciaPerguntaComercialAberta: "",
    deveOferecerAfiliadoComoAlternativa: false,
     
    homologadoFollowupsCanceladosEm: new Date(),
    botBloqueadoPorHumano: false,
    atendimentoHumanoAtivo: false,

    aguardandoConfirmacaoCampo: false,
    aguardandoConfirmacao: false,
    campoEsperado: "",
    campoPendente: "",

    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "afiliado_instrucoes_enviadas",
      motivo: affiliateInstructionDecision.reason,
      acao: "enviar_instrucoes_afiliado_e_cancelar_followups_homologado",
      mensagemLead: text,
      detalhes: {
        responseMode: affiliateInstructionDecision.responseMode,
        rotaComercial: "afiliado",
        afiliadoInstrucoesEnviadas: true,
        homologadoFollowupsCancelados: true,
        naoMarcarComoPerdido: true
      }
    })
  });

  currentLead = await loadLeadProfile(from);

  await sendWhatsAppMessage(from, affiliateMsg);

  await saveHistoryStep(from, history, text, affiliateMsg, !!message.audio?.id);

  console.log("🔗 Instruções de Afiliado enviadas e follow-ups do Homologado cancelados:", {
    user: from,
    reason: affiliateInstructionDecision.reason,
    responseMode: affiliateInstructionDecision.responseMode,
    rotaComercial: "afiliado"
  });

  auditLog("Afiliado obrigatorio enviado", {
    user: maskPhone(from),
    ultimaMensagemLead: text,
    affiliateInstructionDecision,
    lead: buildLeadAuditSnapshot(currentLead || {})
  });

  if (messageId) {
    markMessageAsProcessed(messageId);
  }
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: affiliateMsg,
    currentLead: currentLead || {},
    extras: { tipoSaida: "afiliado_instrucoes_enviadas", responseMode: affiliateInstructionDecision.responseMode }
  });
  return;
}
     
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
   
// Se o lead já rejeitou mais de uma vez, limpar flags comerciais
  // para evitar estado zumbi onde o lead parece qualificado mas está desistindo
  const deveLimparFlagsComerciais = novoRecoveryAttempts >= 2;
   
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
        "Não oferecer Afiliados automaticamente apenas porque o lead achou caro ou trouxe uma dúvida de taxa. Primeiro tratar objeção do Homologado.",
"Se o lead pedir claramente link, online, venda sem estoque físico, redes sociais, e-commerce, alternativa sem taxa do Homologado, ou rejeitar explicitamente continuar no Homologado, o backend da Etapa 10 deve enviar as instruções de Afiliado.",
"Não encerrar como perdido. Se ainda não for caso claro de Afiliado, fazer uma pergunta simples para entender a trava e manter o lead em movimento."
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
    recoveryAttempts: novoRecoveryAttempts,
    sinalRecuperacaoComercial: true,
    ultimaRejeicaoOuEsfriamento: text,
    ultimaMensagem: text,

    // Limpar flags comerciais após múltiplas rejeições para evitar estado inconsistente
    ...(deveLimparFlagsComerciais ? {    // ← NOVO
      interesseReal: false,              // ← NOVO
      taxaAlinhada: false,               // ← NOVO
      taxaModoConversao: false,          // ← NOVO
      sinalObjecaoTaxa: false,           // ← NOVO
      bloqueioComercialAtivo: false,     // ← NOVO
    } : {}),                             // ← NOVO

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
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: msg,
    currentLead: currentLead || {},
    extras: { tipoSaida: "confirmacao_final_negativa" }
  });
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
    qualificadoEm: new Date(),

    // Limpeza de campos temporários da coleta.
    cidadePendente: null,
    estadoPendente: null,
    campoPendente: null,
    valorPendente: null,
    campoEsperado: null,
    aguardandoConfirmacaoCampo: false,

    ultimaMensagem: text,
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "dados_confirmados_pelo_lead",
      motivo: "lead_confirmou_resumo_final_dados",
      acao: "enviar_crm_se_requisitos_ok",
      mensagemLead: text,
      detalhes: {
        dadosConfirmadosPeloLead: true
      }
    })
  });

  const confirmedLead = await loadLeadProfile(from);

  const crmResult = await sendLeadToCrmOnce({
    from,
    lead: confirmedLead || {},
    ultimaMensagem: text
  });

  let confirmedMsg = "";

  if (crmResult.ok || crmResult.alreadySent) {
    confirmedMsg = `Perfeito, suas informações foram confirmadas ✅

Encaminhei seus dados para a equipe comercial de consultores da IQG.

Eles vão entrar em contato em breve para validar os dados, tirar qualquer dúvida final e orientar a finalização da adesão ao Programa Parceiro Homologado.

Só reforçando: essa etapa ainda é um pré-cadastro, não é aprovação automática e também não é cobrança. O próximo passo acontece com o consultor IQG.`;
  } else {
    confirmedMsg = `Perfeito, suas informações foram confirmadas ✅

Tive uma instabilidade para encaminhar automaticamente seus dados para a equipe agora.

Vou deixar isso registrado no sistema da IQG para verificação interna. Essa etapa ainda é um pré-cadastro, não é aprovação automática e também não é cobrança.`;
  }

  await sendWhatsAppMessage(from, confirmedMsg);

  state.closed = true;
  clearTimers(from);

  await saveHistoryStep(from, history, text, confirmedMsg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: confirmedMsg,
    currentLead: confirmedLead || currentLead || {},
    extras: { tipoSaida: "confirmacao_final_positiva_crm", crmOk: crmResult?.ok === true }
  });
  return;
}

// 🛡️ COLETA — proteção leve contra pergunta comercial virar dado.
// Não é uma trava nova do funil.
// É só impedir que o mesmo turno seja tratado como "dado cadastral"
// quando o roteador já identificou pergunta/objeção comercial.
     
const mensagemTemDadoCadastralForte =
  iqgHasStrongCadastroDataForCollection({
    extractedData,
    currentLead: currentLead || {},
    text
  });

const deveBloquearExtracaoDeDadosNesteTurno =
  !mensagemTemDadoCadastralForte &&
  (
    dataFlowQuestionAlreadyGuided === true ||
    (
      isDataFlowState(currentLead || {}) &&
      !isLikelyPureDataAnswer(text, currentLead || {})
    )
  );

if (mensagemTemDadoCadastralForte && dataFlowQuestionAlreadyGuided === true) {
  console.log("✅ Extração cadastral liberada apesar do roteador semântico ter marcado pergunta/misto, pois há dado forte:", {
    user: from,
    ultimaMensagemLead: text,
    extractedData,
    campoEsperado: currentLead?.campoEsperado || "",
    faseAtual: currentLead?.faseQualificacao || "",
    faseFunil: currentLead?.faseFunil || ""
  });
}

if (deveBloquearExtracaoDeDadosNesteTurno) {
  console.log("🛡️ Extração cadastral bloqueada neste turno por pergunta comercial/mensagem mista:", {
    user: from,
    ultimaMensagemLead: text,
    faseAtual: currentLead?.faseQualificacao || "-",
    campoEsperado: currentLead?.campoEsperado || "-",
    dataFlowQuestionAlreadyGuided
  });

  // Se por algum erro anterior o nome ficou com frase claramente inválida,
  // limpamos só o nome. Não mexe em CPF, telefone, cidade, estado ou CRM.
  if (
    currentLead?.campoEsperado === "nome" &&
    currentLead?.nome &&
    !isLikelyPureDataAnswer(currentLead.nome, { campoEsperado: "nome" })
  ) {
    await saveLeadProfile(from, {
      nome: "",
      campoEsperado: "nome",
      faseQualificacao: currentLead?.faseQualificacao || "dados_parciais",
      status: currentLead?.status || "dados_parciais",
      ultimaLimpezaNomeInvalidoEm: new Date(),
      ultimaLimpezaNomeInvalidoMotivo: "nome_parecia_frase_comercial_ou_duvida"
    });
  }
}
     
if (
  !deveBloquearExtracaoDeDadosNesteTurno &&
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
await recordRequestCompleted({
    traceId: auditTraceId,
    userPhone: from,
    mensagemLead: text,
    respostaFinal: confirmationMsg,
    currentLead: extractedData || {},
    extras: { tipoSaida: "dados_completos_confirmacao" }
  });
  return;
}
   
     const shouldAskMissingFields =
  currentLead?.faseQualificacao === "coletando_dados" ||
  currentLead?.faseQualificacao === "dados_parciais" ||
  currentLead?.faseQualificacao === "aguardando_dados";

     // ✅ Confirmação específica do nome antes de salvar definitivo.
// Isso evita que frases como "eu não tenho empresa" virem nome.
const shouldConfirmNameBeforeSaving =
  !deveBloquearExtracaoDeDadosNesteTurno &&
  shouldAskMissingFields &&
  currentLead?.campoEsperado === "nome" &&
  extractedData?.nome &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !currentLead?.aguardandoConfirmacao &&
  isLikelyPureDataAnswer(extractedData.nome, { campoEsperado: "nome" });

if (shouldConfirmNameBeforeSaving) {
  const nomePendente = String(extractedData.nome || "").trim();

  await saveLeadProfile(from, {
    campoPendente: "nome",
    valorPendente: nomePendente,
    campoEsperado: "nome",
    aguardandoConfirmacaoCampo: true,
    aguardandoConfirmacao: false,
    dadosConfirmadosPeloLead: false,
    faseQualificacao: "aguardando_confirmacao_campo",
    status: "aguardando_confirmacao_campo",
    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "confirmacao_campo",
      motivo: "nome_detectado_precisa_confirmacao_antes_de_salvar",
      acao: "confirmar_nome",
      mensagemLead: text,
      detalhes: {
        campoPendente: "nome",
        valorPendente: nomePendente
      }
    })
  });

  const msg = `Entendi seu nome como: ${nomePendente}\n\nEstá correto?`;

  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

if (
  !deveBloquearExtracaoDeDadosNesteTurno &&
  hasNewRequiredLeadData &&
  hasAllRequiredLeadFields(mergedLeadDataAfterExtraction) &&
  !currentLead?.dadosConfirmadosPeloLead &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !currentLead?.aguardandoConfirmacao
) {
  await saveLeadProfile(from, {
    ...normalizedExtractedLeadData,

    cidadeEstado:
      mergedLeadDataAfterExtraction.cidade && mergedLeadDataAfterExtraction.estado
        ? `${mergedLeadDataAfterExtraction.cidade}/${normalizeUF(mergedLeadDataAfterExtraction.estado)}`
        : currentLead?.cidadeEstado || null,

    // Limpeza de campos temporários da coleta.
    cidadePendente: null,
    estadoPendente: null,
    campoPendente: null,
    valorPendente: null,
    campoEsperado: null,
    aguardandoConfirmacaoCampo: false,

    dadosConfirmadosPeloLead: false,
    aguardandoConfirmacao: true,
    faseQualificacao: "aguardando_confirmacao_dados",
    status: "aguardando_confirmacao_dados",

    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "dados_completos_aguardando_confirmacao",
      motivo: "Todos os campos obrigatórios foram preenchidos considerando dados já salvos no lead e dados extraídos da mensagem atual.",
      acao: "confirmar_dados_completos",
      mensagemLead: text,
      detalhes: {
        camposExtraidosAgora: Object.keys(normalizedExtractedLeadData),
        camposFaltantesDepoisDoMerge: [],
        origem: "merge_currentLead_extractedData"
      }
    })
  });

  const confirmationMsg = buildLeadConfirmationMessage(mergedLeadDataAfterExtraction);

  await sendWhatsAppMessage(from, confirmationMsg);
  await saveHistoryStep(from, history, text, confirmationMsg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}
    // 🔥 MONGO HISTÓRICO
// Salva a mensagem atual do lead no histórico completo.
// NÃO cortar aqui com slice(-20), senão o botão "Mensagem" continua mostrando só o final da conversa.
// O limite seguro agora fica dentro de saveConversation(), com até 1000 mensagens.

history.push({
  role: "user",
  content: message.audio?.id ? `[Áudio transcrito]: ${text}` : text,
  createdAt: new Date()
});

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

if (semanticIntent?.mentionsOtherProductLine === true) {
  backendStrategicGuidance.push({
    tipo: "pergunta_sobre_outra_linha_iqg",
    prioridade: "alta",
    motivo: "Lead mencionou linha IQG fora do escopo inicial de piscinas.",
    orientacaoParaPreSdr:
      [
        "O lead mencionou outra linha de produtos da IQG.",
        `Temas citados: ${Array.isArray(semanticIntent.otherProductLineTopics) ? semanticIntent.otherProductLineTopics.join(", ") : "não especificado"}.`,
        "Orientar a SDR a responder que a IQG possui outras linhas além de piscinas.",
        "Explicar que o Programa Parceiro Homologado, neste início, está sendo trabalhado principalmente com a linha de piscinas.",
        "Dizer que outras linhas poderão ser disponibilizadas aos parceiros com o tempo, conforme estratégia, disponibilidade e evolução comercial.",
        "Não negar a existência das outras linhas.",
        "Não prometer estoque, comodato, preço, catálogo ou liberação imediata dessas outras linhas.",
        "Não transformar essa pergunta em Afiliado automaticamente.",
        "Depois de responder, conduzir de volta ao próximo passo adequado do funil."
      ].join("\n")
  });

  console.log("🧪 Lead perguntou sobre outra linha IQG:", {
    user: from,
    otherProductLineTopics: semanticIntent.otherProductLineTopics || []
  });
}
   
    let semanticContinuity = earlySemanticContinuity || await runConversationContinuityAnalyzer({
  lead: currentLead || {},
  history,
  lastUserText: text,
  lastSdrText: lastAssistantText
});

semanticContinuity = enforceSemanticContinuityHardLimits({
  semanticContinuity,
  lead: currentLead || {},
  lastUserText: text,
  lastSdrText: lastAssistantText
});

auditLog("Historiador Semantico apos travas duras", {
  user: maskPhone(from),
  ultimaMensagemLead: text,
  ultimaRespostaSdr: lastAssistantText,
  lead: buildLeadAuditSnapshot(currentLead || {}),
  semanticContinuity
});

if (
  semanticContinuity?.leadCriticouRepeticao === true ||
  semanticContinuity?.naoRepetirUltimoTema === true ||
  semanticContinuity?.leadQuerAvancar === true
) {
  backendStrategicGuidance.push({
    tipo: "continuidade_semantica_historico",
    prioridade: semanticContinuity?.leadCriticouRepeticao === true ? "critica" : "alta",
    motivo: semanticContinuity?.reason || "Historiador semântico detectou continuidade relevante.",
    orientacaoParaPreSdr:
      [
        semanticContinuity?.orientacaoParaPreSdr || "",
        semanticContinuity?.leadCriticouRepeticao === true
          ? "O lead criticou repetição. A SDR deve reconhecer curto e NÃO repetir taxa, responsabilidades, estoque ou benefícios já explicados."
          : "",
        semanticContinuity?.naoRepetirUltimoTema === true
          ? `Não repetir o último tema explicado pela SDR: ${Array.isArray(semanticContinuity.temaUltimaRespostaSdr) ? semanticContinuity.temaUltimaRespostaSdr.join(", ") : "ver histórico"}.`
          : "",
        semanticContinuity?.leadQuerAvancar === true
          ? "O lead demonstrou vontade de avançar. Se a coleta estiver liberada, conduzir para o primeiro dado pendente. Se não estiver, validar somente a menor pendência obrigatória."
          : "",
        "Não responder com textão já explicado. Não reancorar taxa se a crítica for repetição."
      ].filter(Boolean).join("\n"),
    semanticContinuity
  });

    console.log("🧠 Historiador Semântico orientou continuidade antes do Pré-SDR:", {
    user: from,
    leadEntendeuUltimaExplicacao: semanticContinuity?.leadEntendeuUltimaExplicacao === true,
    leadQuerAvancar: semanticContinuity?.leadQuerAvancar === true,
    leadCriticouRepeticao: semanticContinuity?.leadCriticouRepeticao === true,
    naoRepetirUltimoTema: semanticContinuity?.naoRepetirUltimoTema === true,
    proximaAcaoSemantica: semanticContinuity?.proximaAcaoSemantica || "nao_analisado"
  });
}

// 🧠 ETAPA 2 PRODUÇÃO — consolidação semântica de taxa, compromisso e interesse real.
// Este bloco NÃO usa palavras mágicas.
// Ele usa a interpretação do Classificador Semântico + Historiador Semântico.
   
const semanticQualificationPatch = buildSemanticQualificationPatch({
  lead: currentLead || {},
  semanticIntent,
  semanticContinuity,
  history,
  lastUserText: text,
  lastSdrText: lastAssistantText
});
   
if (semanticQualificationPatch.shouldSave) {
  await saveLeadProfile(from, {
    ...semanticQualificationPatch.patch,
    ultimaMensagem: text
  });

  currentLead = await loadLeadProfile(from);

  backendStrategicGuidance.push({
    tipo: "consolidacao_semantica_qualificacao",
    prioridade: "alta",
    motivo: "Backend consolidou taxa, compromisso ou interesse real com base em interpretação semântica contextual.",
    orientacaoParaPreSdr:
      [
        "O backend consolidou sinais comerciais usando Classificador Semântico e Historiador Semântico.",
        "Não repetir explicações já entendidas.",
        currentLead?.taxaAlinhada === true
          ? "Taxa/investimento já estão alinhados no contexto."
          : "",
        currentLead?.etapas?.compromisso === true
          ? "Compromisso de atuação já está validado no contexto."
          : "",
        currentLead?.interesseReal === true
          ? "Interesse real já está confirmado. Se a coleta estiver liberada, conduzir para o primeiro dado pendente."
          : "",
        "Se ainda faltar alguma pendência, validar apenas a menor pendência obrigatória com pergunta curta."
      ].filter(Boolean).join("\n"),
    detalhes: {
      reasons: semanticQualificationPatch.reasons || [],
      taxaAlinhada: currentLead?.taxaAlinhada === true,
      investimento: currentLead?.etapas?.investimento === true,
      compromisso: currentLead?.etapas?.compromisso === true,
      interesseReal: currentLead?.interesseReal === true,
      podeIniciarColeta: canStartDataCollection(currentLead || {})
    }
  });

  console.log("🧠 Consolidação semântica aplicada ao lead:", {
    user: from,
    reasons: semanticQualificationPatch.reasons || [],
    taxaAlinhada: currentLead?.taxaAlinhada === true,
    investimento: currentLead?.etapas?.investimento === true,
    compromisso: currentLead?.etapas?.compromisso === true,
    interesseReal: currentLead?.interesseReal === true,
    podeIniciarColeta: canStartDataCollection(currentLead || {})
  });

  auditLog("Consolidacao semantica aplicada", {
    user: maskPhone(from),
    ultimaMensagemLead: text,
    reasons: semanticQualificationPatch.reasons || [],
    currentLead: buildLeadAuditSnapshot(currentLead || {})
  });
}

   // 🧠 DECISÃO SEMÂNTICA CENTRAL DA TAXA — libera coleta após aceite contextual
var taxPhaseDecision = classifyTaxPhaseDecision({
  lead: currentLead || {},
  history,
  semanticIntent,
  semanticContinuity,
  lastUserText: text,
  lastSdrText: lastAssistantText
});

if (taxPhaseDecision?.acao && taxPhaseDecision.acao !== "NENHUMA_ACAO") {
  backendStrategicGuidance.push({
    tipo: "decisao_semantica_taxa",
    prioridade: taxPhaseDecision.acao === "LIBERAR_PRE_CADASTRO" ? "critica" : "alta",
    categoria: taxPhaseDecision.categoria,
    acao: taxPhaseDecision.acao,
    motivo: taxPhaseDecision.motivo,
    orientacaoParaPreSdr:
      [
        taxPhaseDecision.acao === "LIBERAR_PRE_CADASTRO"
          ? "O lead aceitou seguir após a taxa. Parar de vender, não repetir taxa e conduzir para pré-cadastro/coleta."
          : "",
        taxPhaseDecision.acao === "RESPONDER_DUVIDA"
          ? "O lead fez dúvida sobre taxa. Responder somente a dúvida, sem reiniciar o funil."
          : "",
        taxPhaseDecision.acao === "TRATAR_OBJETICA_TAXA"
          ? "O lead ainda está em objeção de taxa. Argumentar de forma consultiva. Não oferecer Afiliados antes de completar pelo menos 3 tentativas, salvo pedido claro de alternativa."
          : "",
        taxPhaseDecision.acao === "TRATAR_OBJETICA_CONFIANCA"
          ? "O lead está inseguro. Reforçar contrato, análise interna, segurança e que pagamento só ocorre após análise/contrato. Não prometer resultado."
          : "",
        taxPhaseDecision.acao === "OFERECER_AFILIADO"
          ? "O lead pediu alternativa ou não concluiu Homologado após tentativas suficientes. Apresentar Programa de Afiliados como alternativa simples, sem pressão."
          : "",
        "Não exigir frase exata como 'me comprometo', 'aceito' ou 'faz sentido'. Usar o contexto e a última intenção do lead."
      ].filter(Boolean).join("\n"),
    detalhes: {
      taxaObjectionCount: Number(currentLead?.taxaObjectionCount || 0),
      taxaAlinhada: currentLead?.taxaAlinhada === true,
      compromisso: currentLead?.etapas?.compromisso === true,
      interesseReal: currentLead?.interesseReal === true,
      sinalObjecaoTaxa: currentLead?.sinalObjecaoTaxa === true
    }
  });

  const taxPatch = buildTaxPhaseDecisionPatch({
    decision: taxPhaseDecision,
    lead: currentLead || {},
    lastUserText: text
  });

  if (taxPatch.shouldSave) {
    await saveLeadProfile(from, {
      ...taxPatch.patch,
      ultimaMensagem: text
    });

    currentLead = await loadLeadProfile(from);

    console.log("🧠 Decisão semântica da taxa aplicada:", {
      user: from,
      categoria: taxPhaseDecision.categoria,
      acao: taxPhaseDecision.acao,
      motivo: taxPhaseDecision.motivo,
      podeIniciarColeta: canStartDataCollection(currentLead || {}),
      taxaAlinhada: currentLead?.taxaAlinhada === true,
      compromisso: currentLead?.etapas?.compromisso === true,
      interesseReal: currentLead?.interesseReal === true,
      sinalObjecaoTaxa: currentLead?.sinalObjecaoTaxa === true,
      taxaObjectionCount: Number(currentLead?.taxaObjectionCount || 0)
    });

    auditLog("Decisao semantica taxa aplicada", {
      user: maskPhone(from),
      ultimaMensagemLead: text,
      taxPhaseDecision,
      currentLead: buildLeadAuditSnapshot(currentLead || {})
    });
  }
}

var turnPolicy = buildTurnPolicy({
  lead: currentLead || {},
  text,
  semanticIntent,
  commercialRouteDecision
});

const leadEstaPosCrmParaTaxa =
  currentLead?.crmEnviado === true ||
  currentLead?.status === "enviado_crm" ||
  currentLead?.faseQualificacao === "enviado_crm" ||
  currentLead?.statusOperacional === "enviado_crm" ||
  currentLead?.faseFunil === "crm";

if (
  !leadEstaPosCrmParaTaxa &&
  hasTaxAcceptedDecisionToCollect(currentLead || {}) &&
  canStartDataCollection(currentLead || {})
) {
  turnPolicy = {
    ...(turnPolicy || {}),
    modo: "coleta_dados_liberada",
    ofertaPermitida: "homologado",
    podeFalarAfiliado: false,
    podeMandarLinkAfiliado: false,
    podeCompararProgramas: false,
    podeFalarTaxa: false,
    podePedirDados: true,
    podeMarcarBeneficiosEstoque: false,
    estrategiaObrigatoria: "iniciar_coleta",
    proximaMelhorAcao: "Iniciar pré-cadastro/coleta agora, pedindo somente o nome completo.",
    cuidadoPrincipal: "Não repetir taxa, benefícios, estoque ou responsabilidades. Não pedir confirmação intermediária. Pedir apenas o nome completo.",
    motivo: "Lead aceitou seguir após taxa explicada. Coleta liberada pelo backend."
  };

  backendStrategicGuidance.push({
    tipo: "coleta_liberada_pos_taxa",
    prioridade: "critica",
    orientacaoParaPreSdr:
      [
        "A coleta está liberada pelo backend.",
        "A SDR deve parar de vender.",
        "Não repetir taxa.",
        "Não repetir responsabilidades.",
        "Não fazer pergunta intermediária como 'você está pronto?'.",
        "Próxima resposta obrigatória: pedir somente o nome completo."
      ].join("\n")
  });

  console.log("✅ Política do turno sobrescrita para coleta pós-taxa:", {
    user: from,
    podeIniciarColeta: canStartDataCollection(currentLead || {}),
    ultimaDecisaoBackend: currentLead?.ultimaDecisaoBackend?.tipo || "",
    faseFunil: currentLead?.faseFunil || "",
    etapas: currentLead?.etapas || {}
  });
} else if (leadEstaPosCrmParaTaxa) {
  console.log("🛡️ Sobrescrita pós-taxa bloqueada: lead já está pós-CRM.", {
    user: from,
    faseFunil: currentLead?.faseFunil || "",
    crmEnviado: currentLead?.crmEnviado === true
  });
}
   
console.log("🧭 Política do Turno definida:", {
  user: from,
  modo: turnPolicy?.modo || "nao_definido",
  ofertaPermitida: turnPolicy?.ofertaPermitida || "nenhuma_no_momento",
  podeFalarAfiliado: turnPolicy?.podeFalarAfiliado === true,
  podeMandarLinkAfiliado: turnPolicy?.podeMandarLinkAfiliado === true,
  podeFalarTaxa: turnPolicy?.podeFalarTaxa === true,
  podePedirDados: turnPolicy?.podePedirDados === true,
  podeMarcarBeneficiosEstoque: turnPolicy?.podeMarcarBeneficiosEstoque === true,
  motivo: turnPolicy?.motivo || ""
});

auditLog("Politica do Turno", {
  user: maskPhone(from),
  ultimaMensagemLead: text,
  turnPolicy,
  semanticIntent,
  commercialRouteDecision
});

if (Array.isArray(backendStrategicGuidance)) {
  backendStrategicGuidance.push({
    tipo: "politica_turno_minima",
    prioridade: "critica",
    orientacaoParaPreSdr: [
      `Política do turno: ${turnPolicy?.modo || "nao_definido"}.`,
      turnPolicy?.proximaMelhorAcao || "",
      turnPolicy?.cuidadoPrincipal || ""
    ].filter(Boolean).join("\n"),
    detalhes: turnPolicy
  });
}
   
preSdrConsultantAdvice = await runConsultantAssistant({
  lead: currentLead || {},
  history,
  lastUserText: text,
  lastSdrText: lastAssistantText,

  // BLOCO 14 — SUPERVISOR NÃO MANDA NA PRÓXIMA RESPOSTA
  // O Supervisor é auditor pós-SDR e pode gerar falso positivo.
  // Para a resposta atual, o Pré-SDR deve priorizar histórico real,
  // última mensagem do lead, memória conversacional e orientações do backend.
  supervisorAnalysis: {},

  classification: currentLead?.classificacao || {},
  semanticIntent,
  commercialRouteDecision,
  backendStrategicGuidance,
   auditTraceId
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

/*
  ETAPA 16.3A — Política do Turno aplicada ao Consultor Pré-SDR.

  Explicação simples:
  A trava dura corrigiu riscos comerciais.
  Agora a Política do Turno define os limites desta rodada:
  se pode falar Afiliado, taxa, pedir dados ou salvar oferta.
*/
const preSdrAdviceBeforeTurnPolicy = {
  ...(preSdrConsultantAdvice || {})
};

preSdrConsultantAdvice = applyTurnPolicyToPreSdrAdvice({
  advice: preSdrConsultantAdvice,
  turnPolicy,
  lead: currentLead || {}
});
   
if (
  preSdrAdviceBeforeTurnPolicy?.estrategiaRecomendada !== preSdrConsultantAdvice?.estrategiaRecomendada ||
  preSdrAdviceBeforeTurnPolicy?.proximaMelhorAcao !== preSdrConsultantAdvice?.proximaMelhorAcao ||
  preSdrAdviceBeforeTurnPolicy?.cuidadoPrincipal !== preSdrConsultantAdvice?.cuidadoPrincipal ||
  preSdrAdviceBeforeTurnPolicy?.ofertaMaisAdequada !== preSdrConsultantAdvice?.ofertaMaisAdequada
) {
  console.log("🧭 Consultor PRÉ-SDR ajustado pela Política do Turno:", {
    user: from,
    modoPoliticaTurno: turnPolicy?.modo || "nao_definido",
    ofertaPermitida: turnPolicy?.ofertaPermitida || "nenhuma_no_momento",
    estrategiaAntes: preSdrAdviceBeforeTurnPolicy?.estrategiaRecomendada || "nao_analisado",
    estrategiaDepois: preSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
    ofertaAntes: preSdrAdviceBeforeTurnPolicy?.ofertaMaisAdequada || "nao_analisado",
    ofertaDepois: preSdrConsultantAdvice?.ofertaMaisAdequada || "nao_analisado",
    podeFalarAfiliado: turnPolicy?.podeFalarAfiliado === true,
    podeMandarLinkAfiliado: turnPolicy?.podeMandarLinkAfiliado === true,
    podeFalarTaxa: turnPolicy?.podeFalarTaxa === true,
    podePedirDados: turnPolicy?.podePedirDados === true
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

/*
  ETAPA 16.3A — Política do Turno também aplicada ao fallback.

  Explicação simples:
  Mesmo se o GPT Consultor Pré-SDR falhar,
  a Política do Turno continua mandando nos limites da rodada.
*/
const fallbackAdviceBeforeTurnPolicy = {
  ...(preSdrConsultantAdvice || {})
};

preSdrConsultantAdvice = applyTurnPolicyToPreSdrAdvice({
  advice: preSdrConsultantAdvice,
  turnPolicy,
  lead: currentLead || {}
});
   
if (
  fallbackAdviceBeforeTurnPolicy?.estrategiaRecomendada !== preSdrConsultantAdvice?.estrategiaRecomendada ||
  fallbackAdviceBeforeTurnPolicy?.proximaMelhorAcao !== preSdrConsultantAdvice?.proximaMelhorAcao ||
  fallbackAdviceBeforeTurnPolicy?.cuidadoPrincipal !== preSdrConsultantAdvice?.cuidadoPrincipal ||
  fallbackAdviceBeforeTurnPolicy?.ofertaMaisAdequada !== preSdrConsultantAdvice?.ofertaMaisAdequada
) {
  console.log("🧭 Fallback Pré-SDR ajustado pela Política do Turno:", {
    user: from,
    modoPoliticaTurno: turnPolicy?.modo || "nao_definido",
    ofertaPermitida: turnPolicy?.ofertaPermitida || "nenhuma_no_momento",
    estrategiaAntes: fallbackAdviceBeforeTurnPolicy?.estrategiaRecomendada || "nao_analisado",
    estrategiaDepois: preSdrConsultantAdvice?.estrategiaRecomendada || "nao_analisado",
    ofertaAntes: fallbackAdviceBeforeTurnPolicy?.ofertaMaisAdequada || "nao_analisado",
    ofertaDepois: preSdrConsultantAdvice?.ofertaMaisAdequada || "nao_analisado"
  });
}

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

POLÍTICA DO TURNO — LIMITES OBRIGATÓRIOS:

Modo:
${turnPolicy?.modo || "nao_definido"}

Oferta permitida neste turno:
${turnPolicy?.ofertaPermitida || "nenhuma_no_momento"}

Pode falar Afiliado?
${turnPolicy?.podeFalarAfiliado === true ? "sim" : "não"}

Pode mandar link de Afiliado?
${turnPolicy?.podeMandarLinkAfiliado === true ? "sim" : "não"}

Pode comparar programas?
${turnPolicy?.podeCompararProgramas === true ? "sim" : "não"}

Pode falar taxa/pagamento?
${turnPolicy?.podeFalarTaxa === true ? "sim" : "não"}

Pode pedir dados?
${turnPolicy?.podePedirDados === true ? "sim" : "não"}

Pode marcar benefícios/estoque como explicados?
${turnPolicy?.podeMarcarBeneficiosEstoque === true ? "sim" : "não"}

Próxima melhor ação da Política do Turno:
${turnPolicy?.proximaMelhorAcao || "-"}

Cuidado principal da Política do Turno:
${turnPolicy?.cuidadoPrincipal || "-"}

Regra obrigatória:
Se houver conflito entre a Política do Turno e qualquer outra orientação, siga a Política do Turno.

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

     const saudacaoHorario = getGreetingByBrazilTime();
     
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
  content: `SAUDAÇÃO POR HORÁRIO — REGRA OBRIGATÓRIA

Horário atual considerado pelo sistema: ${saudacaoHorario}.

A SDR deve usar a saudação conforme o horário real do sistema, e NÃO conforme a saudação escrita pelo lead.

Regra principal:
- Se o lead disser "bom dia", mas o horário do sistema for tarde, responder com "boa tarde".
- Se o lead disser "boa tarde", mas o horário do sistema for noite, responder com "boa noite".
- Se o lead disser "boa noite", mas o horário do sistema for manhã, responder com "bom dia".

Não corrigir o lead.
Não dizer "na verdade é boa tarde".
Apenas responder naturalmente com a saudação correta.

Use:
- "bom dia" pela manhã;
- "boa tarde" à tarde;
- "boa noite" à noite.

Exemplos:
Lead: "bom dia"
Horário do sistema: boa tarde
Resposta: "Boa tarde, Edson! 😊"

Lead: "boa tarde"
Horário do sistema: boa noite
Resposta: "Boa noite, Edson! 😊"

Lead: "oi"
Horário do sistema: bom dia
Resposta: "Bom dia, Edson! 😊"

Se a conversa já estiver no meio de uma sequência e a resposta não precisar de saudação, não force saudação.
Não cumprimente de novo em toda mensagem.`
},
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

// GUARDRAIL POS-CRM — última proteção antes do envio.
// Se o lead já está no CRM e a SDR tentou pedir dado pessoal,
// bloqueia e substitui por resposta consultiva curta.
const leadEstaPosCrmGuard =
  currentLead?.crmEnviado === true ||
  currentLead?.status === "enviado_crm" ||
  currentLead?.faseQualificacao === "enviado_crm" ||
  currentLead?.statusOperacional === "enviado_crm" ||
  currentLead?.faseFunil === "crm";
const respostaTentouPedirDado =
  /\b(seu nome completo|me envie seu nome|me passa o cpf|seu cpf|seu telefone|sua cidade|qual seu estado|pode me enviar seu nome)\b/i
    .test(resposta || "");
if (leadEstaPosCrmGuard && respostaTentouPedirDado) {
  console.log("🛡️ GUARDRAIL POS-CRM bloqueou pedido de dados:", {
    user: from,
    ultimaMensagemLead: text,
    respostaBloqueada: String(resposta || "").slice(0, 200)
  });
  const nomePrimeiro = getFirstName(currentLead?.nomeWhatsApp || currentLead?.nome || "");
  const prefixoNome = nomePrimeiro ? `${nomePrimeiro}, ` : "";
  resposta = `${prefixoNome}seus dados já estão com a equipe comercial da IQG. Se precisar de qualquer informação ou tiver alguma dúvida, me conta aqui que te ajudo no que for possível.`;
}
     
    const respostaLower = String(resposta || "").toLowerCase();

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

/*
  ETAPA 13.1 PRODUÇÃO — início de coleta sem salto automático.

  Explicação simples:
  Antes, se o backend achava que podia coletar, ele forçava a coleta
  mesmo que a resposta da SDR ainda estivesse respondendo uma dúvida.

  Agora:
  - não existe mais início forçado;
  - só inicia coleta se a resposta realmente pedir o nome completo;
  - se a última mensagem do lead era pergunta comercial, não inicia coleta;
  - pergunta sobre produto, kit, catálogo, reposição, taxa ou contrato vem antes de CPF.
*/
const leadAceitouTaxaNaMensagemAtual =
  typeof taxPhaseDecision !== "undefined" &&
  ["ACEITE_CLARO", "ACEITE_FRACO_MAS_SUFFICIENTE"].includes(taxPhaseDecision?.categoria) &&
  taxPhaseDecision?.acao === "LIBERAR_PRE_CADASTRO";

const leadFezPerguntaSobreValorOuPagamento =
  semanticIntent?.asksQuestion === true &&
  /\b(valor|quanto|preco|preço|taxa|qual.*valor|qual.*taxa|quanto.*pago|quando.*pago|e qual|qual e|quanto custa|quanto e a taxa|qual o valor|qual a taxa)\b/i.test(text || "");

const leadTemPerguntaComercialAbertaAntesDaColeta =
  leadAceitouTaxaNaMensagemAtual !== true &&
  (
    currentLead?.pendenciaPerguntaComercialAberta === true ||
    leadFezPerguntaSobreValorOuPagamento ||
    (
      semanticIntent?.asksQuestion === true &&
      semanticIntent?.positiveRealInterest !== true &&
      semanticIntent?.positiveCommitment !== true
    ) ||
    Boolean(semanticIntent?.requestedFile) ||
    /\b(catalogo|catálogo|folder|pdf|material|kit|manual|produto|produtos|iqg|nano|estoque|comodato|reposicao|reposição|taxa|valor|preco|preço|contrato|pagamento|boleto)\b/i.test(text || "")
  );
     
const podeIniciarColeta =
  canStartDataCollection(currentLead || {}) &&
  currentLead?.interesseReal === true &&
  leadTemPerguntaComercialAbertaAntesDaColeta !== true;

const startedDataCollection =
  respostaLower.includes("primeiro, pode me enviar seu nome completo") ||
  respostaLower.includes("pode me enviar seu nome completo") ||
  respostaLower.includes("me envie seu nome completo") ||
  respostaLower.includes("qual seu nome completo") ||
  respostaLower.includes("me passa seu nome completo") ||
  respostaLower.includes("enviar seu nome completo") ||
  respostaLower.includes("me manda seu nome completo");

/*
  Importante:
  O backend não deve transformar uma resposta genérica em coleta.
  A coleta só começa quando a resposta final realmente pede o nome completo
  e quando não existe pergunta comercial aberta do lead.
*/

// 🛡️ TRAVA FINAL OBRIGATÓRIA — impede coleta se investimento não foi explicado
if (
  startedDataCollection &&
  !podeIniciarColeta &&
  !coletaLiberadaPorTaxaAceita
) {
  const etapasPendentesParaColeta = getMissingFunnelStepLabels(currentLead || {});

  console.log("🛑 TRAVA FINAL: SDR tentou pedir dados mas coleta não está liberada. Substituindo resposta:", {
    user: from,
    ultimaMensagemLead: text,
    etapasPendentes: etapasPendentesParaColeta,
    respostaOriginal: respostaFinal
  });

  const safeResponse = getSafeCurrentPhaseResponse(currentLead || {});
  respostaFinal = safeResponse.message;

  if (safeResponse.fileKey) {
    actions.push(safeResponse.fileKey);
  }

  // Re-sincroniza actions após substituir a resposta
  const syncAfterBlock = syncActionsFromFinalReply({
    respostaFinal,
    actions
  });
  respostaFinal = syncAfterBlock.respostaFinal;
}
     
if (
  startedDataCollection &&
  podeIniciarColeta &&
  !leadFezPerguntaSobreValorOuPagamento &&    // ← NOVO
  currentLead?.faseQualificacao !== "coletando_dados"
){
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
    status: "coletando_dados",
    faseFunil: "coleta_dados",

    ultimaDecisaoBackend: buildBackendDecision({
      tipo: "inicio_coleta_dados",
      motivo: "resposta_final_pediu_nome_completo_e_backend_permitiu_coleta",
      acao: "iniciar_coleta_pelo_nome",
      mensagemLead: text,
      detalhes: {
        campoEsperado: "nome",
        perguntaComercialAberta: false
      }
    })
  });

  resposta = "Perfeito 😊 Vamos seguir então.\n\nPrimeiro, pode me enviar seu nome completo?";
} else if (
  currentLead?.faseQualificacao !== "coletando_dados" &&
  canStartDataCollection(currentLead || {}) === true &&
  leadTemPerguntaComercialAbertaAntesDaColeta === true
) {
  console.log("🧭 Coleta não iniciada porque existe pergunta comercial aberta:", {
    user: from,
    ultimaMensagemLead: text,
    requestedFile: semanticIntent?.requestedFile || "",
    questionTopics: semanticIntent?.questionTopics || [],
    pendenciaPerguntaComercialAberta: currentLead?.pendenciaPerguntaComercialAberta === true
  });

  auditLog("Coleta nao iniciada por pergunta comercial aberta", {
    user: maskPhone(from),
    ultimaMensagemLead: text,
    currentLead: buildLeadAuditSnapshot(currentLead || {}),
    semanticIntent: semanticIntent || {}
  });
}
     
let respostaFinal = resposta;

auditLog("Primeira resposta gerada pela SDR antes das travas", {
  user: maskPhone(from),
  ultimaMensagemLead: text,
  respostaInicialSdr: respostaFinal,
  currentLead: buildLeadAuditSnapshot(currentLead || {})
});

// BLOCO 11B:
// Lista única de problemas encontrados antes do envio.
// Qualquer trava comercial deve adicionar orientação aqui,
// e não substituir respostaFinal com texto fixo.
let sdrReviewFindings = [];

     // 🚫 BLOQUEIO DE REPETIÇÃO APÓS ACEITE DA TAXA
if (
  typeof taxPhaseDecision !== "undefined" &&
  taxPhaseDecision?.acao === "LIBERAR_PRE_CADASTRO" &&
  canStartDataCollection(currentLead || {}) === true
) {
  const respostaNormalizadaDepoisAceite = normalizeTaxDecisionText(respostaFinal || "");

  const respostaRepetiuTaxa =
    /\b(taxa|1990|1\.990|r\$ ?1\.990|investimento|adesao|adesão|implantacao|implantação)\b/i.test(respostaNormalizadaDepoisAceite);

  const respostaPediuNome =
    respostaNormalizadaDepoisAceite.includes("nome completo") ||
    respostaNormalizadaDepoisAceite.includes("me envie seu nome") ||
    respostaNormalizadaDepoisAceite.includes("pode me enviar seu nome");

  if (respostaRepetiuTaxa || !respostaPediuNome) {
    sdrReviewFindings.push({
      tipo: "taxa_aceita_nao_repetir_iniciar_coleta",
      prioridade: "critica",
      orientacao:
        [
          "O backend classificou que o lead aceitou seguir após a taxa.",
          "Não repetir a taxa.",
          "Não repetir benefícios, estoque, responsabilidades ou explicações antigas.",
          "Não pedir nova confirmação.",
          "Parar de vender e iniciar a coleta.",
          "A próxima resposta deve ser curta e pedir somente o nome completo.",
          "Modelo permitido: 'Perfeito 😊 Vamos seguir então. Primeiro, pode me enviar seu nome completo?'"
        ].join("\n")
    });

    console.log("🛑 Revisão solicitada: lead aceitou taxa, mas SDR repetiu ou não iniciou coleta:", {
      user: from,
      categoriaTaxa: taxPhaseDecision?.categoria,
      acaoTaxa: taxPhaseDecision?.acao,
      podeIniciarColeta: canStartDataCollection(currentLead || {}),
      respostaFinal
    });
  }
}
     
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

  // muito curta, sem valor
  if (t.length < 15) return true;

  // sem pergunta e muito curta, sem condução
  if (!t.includes("?") && t.length < 80) return true;

  return false;
}

// 🔥 BLOCO FINAL 13 — RESPOSTA RUIM VIRA REVISÃO DA SDR
// O backend não substitui mais a resposta por texto fixo.
// Ele apenas aponta o problema para a própria SDR revisar antes do envio.
if (isBadResponse(respostaFinal)) {
  sdrReviewFindings.push({
    tipo: "resposta_generica_ou_fraca",
    prioridade: "alta",
    orientacao:
      [
        "A resposta da SDR ficou genérica, curta demais ou sem condução clara.",
        "A SDR deve reescrever de forma natural, útil e conectada à última mensagem real do lead.",
        "Não usar frases genéricas como 'como posso ajudar', 'fico à disposição' ou 'qualquer dúvida me avise'.",
        currentLead?.faseQualificacao === "coletando_dados"
          ? "Se estiver em coleta liberada, retomar o campo correto da coleta, sem pedir vários dados de uma vez."
          : "",
        podeIniciarColeta
          ? "Se a coleta estiver realmente liberada, conduzir para o primeiro dado pendente, começando pelo nome completo."
          : "Se a coleta ainda não estiver liberada, não pedir nome, CPF, telefone, cidade ou estado; conduzir para a etapa pendente do funil."
      ].filter(Boolean).join("\n")
  });

  console.log("🧭 Revisão solicitada: resposta genérica ou fraca da SDR:", {
    user: from,
    ultimaMensagemLead: text,
    respostaFinal
  });
}
     
// 🚫 BLOQUEIO SEGURO: só falar "material já enviado" se o LEAD pediu material de novo
const leadPediuMaterialAgora = hasExplicitFileRequest(text);

if (
  leadPediuMaterialAgora &&
  currentLead?.sentFiles?.folder &&
  /material|folder|pdf|catalogo|catálogo|kit|manual|contrato|lista/i.test(respostaFinal)
) {
  sdrReviewFindings.push({
    tipo: "material_ja_enviado",
    prioridade: "media",
    orientacao:
      [
        "O lead pediu material, mas esse material já foi enviado anteriormente.",
        "A SDR deve responder naturalmente que o material já está acima na conversa.",
        "Oferecer um resumo curto dos principais pontos, em vez de reenviar ou repetir o comando de arquivo.",
        "Não incluir [ACTION:SEND_FOLDER] se o folder já foi enviado."
      ].join("\n")
  });

  removeFileAction(actions, "folder");

  console.log("📎 Revisão solicitada: lead pediu material já enviado:", {
    user: from,
    ultimaMensagemLead: text
  });
}

     const coletaLiberadaPorTaxaAceita =
  hasTaxAcceptedDecisionToCollect(currentLead || {}) &&
  canStartDataCollection(currentLead || {}) === true;
     
const mencionouPreAnalise =
  /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal);

if (mencionouPreAnalise && !podeIniciarColeta && !coletaLiberadaPorTaxaAceita) {
  sdrReviewFindings.push({
    tipo: "pre_analise_prematura",
    prioridade: "critica",
    orientacao:
      [
        "A SDR mencionou pré-análise ou tentou conduzir para pré-cadastro antes do backend liberar a coleta.",
        "Reescrever sem pedir dados e sem prometer pré-análise agora.",
        "Responder primeiro a última mensagem do lead.",
        "Se o investimento/taxa já foi explicado e o lead sinalizou continuidade sem objeção nova, não voltar para etapas antigas; orientar avanço para pré-cadastro se o backend permitir. Só conduzir para etapa pendente se ainda não houve explicação de taxa/investimento.",
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
if (startedDataCollection && !podeIniciarColeta && !coletaLiberadaPorTaxaAceita) {
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

// BLOCO 15C — HISTORIADOR SEMÂNTICO TAMBÉM ENTRA COMO TRAVA FINAL
// Se o Historiador detectou que o lead já entendeu, quer avançar,
// ou criticou repetição, a resposta da SDR precisa respeitar isso.
// Caso contrário, a própria SDR deve revisar antes do envio.
if (
  typeof semanticContinuity !== "undefined" &&
  (
    semanticContinuity?.leadCriticouRepeticao === true ||
    semanticContinuity?.naoRepetirUltimoTema === true ||
    semanticContinuity?.leadQuerAvancar === true
  )
) {
  sdrReviewFindings.push({
    tipo: "continuidade_semantica_deve_ser_respeitada",
    prioridade: semanticContinuity?.leadCriticouRepeticao === true ? "critica" : "alta",
    orientacao:
      [
        "O Historiador Semântico analisou o histórico e a última mensagem do lead.",
        semanticContinuity?.leadCriticouRepeticao === true
          ? "O lead criticou repetição. A SDR deve reconhecer isso de forma curta e NÃO repetir taxa, responsabilidades, benefícios ou estoque já explicados."
          : "",
        semanticContinuity?.naoRepetirUltimoTema === true
          ? `Não repetir o último tema já explicado: ${Array.isArray(semanticContinuity.temaUltimaRespostaSdr) ? semanticContinuity.temaUltimaRespostaSdr.join(", ") : "ver histórico"}.`
          : "",
        semanticContinuity?.leadQuerAvancar === true
          ? "O lead demonstrou vontade de avançar. Se a coleta estiver liberada, pedir somente o primeiro dado pendente. Se ainda faltar algo obrigatório, validar apenas a menor pendência com uma pergunta curta."
          : "",
        semanticContinuity?.orientacaoParaPreSdr || "",
        "Não responder com textão já explicado.",
        "Não reancorar taxa se a crítica do lead for repetição.",
        "Não repetir responsabilidades se o lead já sinalizou entendimento."
      ].filter(Boolean).join("\n"),
    semanticContinuity
  });

  console.log("🧠 Revisão final exigida pelo Historiador Semântico:", {
    user: from,
    leadEntendeuUltimaExplicacao: semanticContinuity?.leadEntendeuUltimaExplicacao === true,
    leadQuerAvancar: semanticContinuity?.leadQuerAvancar === true,
    leadCriticouRepeticao: semanticContinuity?.leadCriticouRepeticao === true,
    naoRepetirUltimoTema: semanticContinuity?.naoRepetirUltimoTema === true,
    proximaAcaoSemantica: semanticContinuity?.proximaAcaoSemantica || "nao_analisado"
  });
}
     
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
  const originalMissingThemes =
    Array.isArray(unansweredQuestionGuard.reason?.missingThemes)
      ? unansweredQuestionGuard.reason.missingThemes
      : [];

  const filteredMissingThemes = iqgFilterMissingThemesAlreadyUnderstood({
    leadText: text,
    missingThemes: originalMissingThemes
  });

  const deveIgnorarPerguntaNaoRespondida =
    originalMissingThemes.length > 0 &&
    filteredMissingThemes.length === 0;

  if (deveIgnorarPerguntaNaoRespondida) {
    console.log("🧠 Trava pergunta_ou_objecao_nao_respondida ignorada: tema citado como já entendido pelo lead.", {
      user: from,
      ultimaMensagemLead: text,
      originalMissingThemes,
      filteredMissingThemes
    });
  } else {
    sdrReviewFindings.push({
      tipo: "pergunta_ou_objecao_nao_respondida",
      prioridade: "critica",
      reason: {
        ...(unansweredQuestionGuard.reason || {}),
        originalMissingThemes,
        missingThemes: filteredMissingThemes
      },
      orientacao:
        "A resposta não cobriu a pergunta ou objeção atual do lead. Reescrever respondendo primeiro a mensagem real do lead."
    });
  }
}

     const disciplinaFunil = enforceFunnelDiscipline({
  respostaFinal,
  currentLead,
  leadText: text
});

if (disciplinaFunil.changed) {
  const motivoDisciplina = disciplinaFunil.reason || {};

  sdrReviewFindings.push({
    tipo: "disciplina_funil",
    prioridade: "critica",
    reason: motivoDisciplina,
    orientacao:
      [
        "A resposta realmente tentou quebrar uma regra importante do funil.",

        motivoDisciplina.pediuDadosCedo
          ? "Remover qualquer pedido de nome, CPF, telefone, cidade, estado ou dados pessoais, porque a coleta ainda não está liberada."
          : "",

        motivoDisciplina.falouTaxaCedo
          ? "Remover qualquer menção à taxa, investimento, valor, pagamento, PIX, cartão ou parcelamento, porque ainda é cedo para falar disso."
          : "",

        motivoDisciplina.falouTaxaSemControle
          ? "Não falar da taxa de forma solta. Só falar de investimento quando a etapa estiver corretamente contextualizada e autorizada pelo backend."
          : "",

        motivoDisciplina.tentouPularFase &&
        !motivoDisciplina.pediuDadosCedo &&
        !motivoDisciplina.falouTaxaCedo &&
        !motivoDisciplina.falouTaxaSemControle
          ? "Ajustar a resposta para respeitar a etapa atual, mas sem apagar uma explicação útil que responda a última mensagem do lead."
          : "",

        "Se o lead fez uma pergunta específica, responder primeiro essa pergunta de forma objetiva e consultiva.",
        "Não transformar a resposta em pré-cadastro, taxa ou coleta de dados se isso ainda não estiver liberado.",
        "Não voltar para uma mensagem genérica como 'como posso ajudar?', se o lead já deixou claro o que quer entender.",
        "Reescrever mantendo naturalidade, contexto e fluidez comercial."
      ].filter(Boolean).join("\n")
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

auditLog("Problemas encontrados pelas travas antes do envio", {
  user: maskPhone(from),
  ultimaMensagemLead: text,
  quantidadeProblemas: sdrReviewFindings.length,
  problemas: sdrReviewFindings,
  respostaAntesDaRevisao: respostaFinal
});

if (sdrReviewFindings.length > 0) {
  const primeiraRespostaSdr = respostaFinal;

  /*
    🛡️ CORREÇÃO FALHA 3:
    Passa os dados que o backend ACABOU de extrair da mensagem atual
    para que o GPT regenerador NÃO peça de novo um dado que o lead
    acabou de enviar (ex: nome, CPF, telefone, cidade, estado).
  */
  const dadosExtraidosNesteTurno = {
    nome: extractedData?.nome || currentLead?.nome || null,
    cpf: extractedData?.cpf || currentLead?.cpf || null,
    telefone: extractedData?.telefone || currentLead?.telefone || null,
    cidade: extractedData?.cidade || currentLead?.cidade || null,
    estado: extractedData?.estado || currentLead?.estado || null
  };

  const dadosJaPreenchidos = Object.entries(dadosExtraidosNesteTurno)
    .filter(([_, v]) => v)
    .map(([k, _]) => k);

  const guardFindingsComDados = [
    ...sdrReviewFindings,
    ...(dadosJaPreenchidos.length > 0
      ? [{
          tipo: "dados_ja_recebidos_neste_turno",
          prioridade: "critica",
          orientacao: [
            `O lead já informou ou já possui estes dados preenchidos: ${dadosJaPreenchidos.join(", ")}.`,
            dadosExtraidosNesteTurno.nome ? `Nome já recebido: "${dadosExtraidosNesteTurno.nome}". NÃO pedir nome de novo.` : "",
            dadosExtraidosNesteTurno.cpf ? `CPF já recebido. NÃO pedir CPF de novo.` : "",
            dadosExtraidosNesteTurno.telefone ? `Telefone já recebido. NÃO pedir telefone de novo.` : "",
            dadosExtraidosNesteTurno.cidade ? `Cidade já recebida. NÃO pedir cidade de novo.` : "",
            dadosExtraidosNesteTurno.estado ? `Estado já recebido. NÃO pedir estado de novo.` : "",
            "Se a coleta estiver liberada, pedir apenas o PRÓXIMO campo que ainda está faltando.",
            "Se todos os campos já estiverem preenchidos, seguir para confirmação dos dados."
          ].filter(Boolean).join("\n")
        }]
      : [])
  ];

  respostaFinal = await regenerateSdrReplyWithGuardGuidance({
  currentLead: {
    ...(currentLead || {}),
    semanticContinuity: typeof semanticContinuity !== "undefined" ? semanticContinuity : null
  },
  history,
  userText: text,
  primeiraRespostaSdr,
  preSdrConsultantAdvice: preSdrConsultantAdvice || {},
  preSdrConsultantContext,
  guardFindings: guardFindingsComDados
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

    // 📄 ETAPA 8 PRODUÇÃO — folder obrigatório quando benefícios forem explicados.
// Explicação simples:
// Se a SDR explicou benefícios e esqueceu o comando do folder,
// o backend adiciona [ACTION:SEND_FOLDER] antes de sincronizar actions.
if (
  shouldForceFolderForBenefits({
    lead: currentLead || {},
    respostaFinal,
    actions,
    leadText: text
  })
) {
  respostaFinal = `${String(respostaFinal || "").trim()}

[ACTION:SEND_FOLDER]`;

  console.log("📄 Folder obrigatório adicionado pelo backend na fase de benefícios:", {
    user: from,
    faseFunil: currentLead?.faseFunil || "-",
    faseQualificacao: currentLead?.faseQualificacao || "-",
    folderJaEnviado: Boolean(currentLead?.sentFiles?.folder)
  });

  auditLog("Folder obrigatorio adicionado pelo backend", {
    user: maskPhone(from),
    ultimaMensagemLead: text,
    faseFunil: currentLead?.faseFunil || "",
    faseQualificacao: currentLead?.faseQualificacao || "",
    respostaFinalComAction: respostaFinal
  });
}

// 📎 BLOCO 8B — SINCRONIZA ACTIONS DA RESPOSTA FINAL
// Como a SDR pode ter revisado a resposta, os comandos de arquivo precisam
// ser extraídos novamente da resposta final real que será enviada ao lead.
// 📎 BLOCO 8B — SINCRONIZA ACTIONS DA RESPOSTA FINAL
// Como a SDR pode ter revisado a resposta, os comandos de arquivo precisam
// ser extraídos novamente da resposta final real que será enviada ao lead.
const syncedFinalReply = syncActionsFromFinalReply({
  respostaFinal,
  actions
});

respostaFinal = sanitizeWhatsAppText(syncedFinalReply.respostaFinal);

/*
  🛡️ BARREIRA FINAL ANTI-VAZAMENTO
  Última proteção antes de enviar a mensagem ao WhatsApp.
*/
const respostaAntesDaBarreiraFinalLeak = respostaFinal;

respostaFinal = enforceNoInternalLeakBeforeSend(respostaFinal);

/*
  🛡️ BARREIRA FINAL ANTI-PLACEHOLDER DE PREÇO
  Detecta "R$ XX", "XX,XX", valores fictícios ou listas de preço inventadas.
  Se encontrar, substitui por resposta segura sobre o e-commerce.
*/
const placeholderPrecoDetectado =
  /R\$\s*XX/i.test(respostaFinal) ||
  /R\$\s*--/i.test(respostaFinal) ||
  /:\s*R\$\s*XX/i.test(respostaFinal) ||
  /XX[,.]XX/i.test(respostaFinal) ||
  /valor\s+a\s+definir/i.test(respostaFinal) ||
  /preco\s+a\s+definir/i.test(respostaFinal) ||
  /preço\s+a\s+definir/i.test(respostaFinal);

/*
  🛡️ BARREIRA FINAL ANTI-REPETIÇÃO DE DADO JÁ COLETADO
  Se o lead já informou nome (ou CPF, telefone, cidade, estado)
  e a resposta final ainda está pedindo esse dado de novo,
  o backend substitui por pedido do próximo campo faltante.
*/
const camposJaPreenchidosDoLead = {
  nome: Boolean(String(currentLead?.nome || extractedData?.nome || "").trim()),
  cpf: Boolean(String(currentLead?.cpf || extractedData?.cpf || "").trim()),
  telefone: Boolean(String(currentLead?.telefone || extractedData?.telefone || "").trim()),
  cidade: Boolean(String(currentLead?.cidade || extractedData?.cidade || "").trim()),
  estado: Boolean(String(currentLead?.estado || extractedData?.estado || "").trim())
};

const respostaLowerBarreira = String(respostaFinal || "").toLowerCase();

const respostaPedeNomeMasJaTem =
  camposJaPreenchidosDoLead.nome &&
  (
    respostaLowerBarreira.includes("nome completo") ||
    respostaLowerBarreira.includes("me envie seu nome") ||
    respostaLowerBarreira.includes("me passa seu nome") ||
    respostaLowerBarreira.includes("me manda seu nome") ||
    respostaLowerBarreira.includes("qual seu nome")
  );

const respostaPedeCpfMasJaTem =
  camposJaPreenchidosDoLead.cpf &&
  (
    respostaLowerBarreira.includes("seu cpf") ||
    respostaLowerBarreira.includes("me envie seu cpf") ||
    respostaLowerBarreira.includes("me passa seu cpf") ||
    respostaLowerBarreira.includes("me manda seu cpf")
  );

const respostaPedeTelefoneMasJaTem =
  camposJaPreenchidosDoLead.telefone &&
  (
    respostaLowerBarreira.includes("telefone com ddd") ||
    respostaLowerBarreira.includes("seu telefone") ||
    respostaLowerBarreira.includes("número com ddd")
  );

const respostaPedeCidadeMasJaTem =
  camposJaPreenchidosDoLead.cidade &&
  (
    respostaLowerBarreira.includes("qual sua cidade") ||
    respostaLowerBarreira.includes("sua cidade")
  );

const respostaPedeEstadoMasJaTem =
  camposJaPreenchidosDoLead.estado &&
  (
    respostaLowerBarreira.includes("qual seu estado") ||
    respostaLowerBarreira.includes("seu estado")
  );

const algumDadoRepetidoNaResposta =
  respostaPedeNomeMasJaTem ||
  respostaPedeCpfMasJaTem ||
  respostaPedeTelefoneMasJaTem ||
  respostaPedeCidadeMasJaTem ||
  respostaPedeEstadoMasJaTem;

if (algumDadoRepetidoNaResposta) {
  const dadoRepetido =
    respostaPedeNomeMasJaTem ? "nome" :
    respostaPedeCpfMasJaTem ? "cpf" :
    respostaPedeTelefoneMasJaTem ? "telefone" :
    respostaPedeCidadeMasJaTem ? "cidade" :
    "estado";

  console.warn("🛡️ BARREIRA ANTI-REPETIÇÃO DE DADO: resposta pedia dado que o lead já informou. Corrigida antes do envio:", {
    user: from,
    dadoRepetido,
    nomePreenchido: camposJaPreenchidosDoLead.nome,
    cpfPreenchido: camposJaPreenchidosDoLead.cpf,
    telefonePreenchido: camposJaPreenchidosDoLead.telefone,
    cidadePreenchida: camposJaPreenchidosDoLead.cidade,
    estadoPreenchido: camposJaPreenchidosDoLead.estado,
    respostaBloqueada: String(respostaFinal).slice(0, 200)
  });

  const mergedParaBarreira = {
    ...(currentLead || {}),
    ...(extractedData || {})
  };

  const camposFaltantesBarreira = getMissingLeadFields(mergedParaBarreira);

  if (camposFaltantesBarreira.length > 0) {
    const proximoCampoReal = camposFaltantesBarreira[0];
    respostaFinal = `Perfeito 😊\n\n${getMissingFieldQuestion(proximoCampoReal)}`;
  } else if (!mergedParaBarreira.dadosConfirmadosPeloLead) {
    respostaFinal = buildLeadConfirmationMessage(mergedParaBarreira);
  } else {
    respostaFinal = "Perfeito 😊 Seus dados já estão completos. Vamos seguir com a análise!";
  }
}

if (respostaFinal !== respostaAntesDaBarreiraFinalLeak) {
  console.warn("🛡️ Barreira final removeu possível vazamento interno antes do WhatsApp:", {
    user: from,
    antes: respostaAntesDaBarreiraFinalLeak,
    depois: respostaFinal
  });
}

console.log("📎 Actions sincronizados com a resposta final:", {
  user: from,
  actions: syncedFinalReply.actions || actions || []
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

auditLog("Resposta FINAL que sera enviada ao WhatsApp", {
  user: maskPhone(from),
  ultimaMensagemLead: text,
  respostaFinal,
  currentLead: buildLeadAuditSnapshot(currentLead || {}),
  etapaAtualCalculada: getCurrentFunnelStage(currentLead),
  mencionouPreAnalise: /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal),
  mencionouInvestimento: replyMentionsInvestment(respostaFinal),
  pediuDados: replyAsksPersonalData(respostaFinal),
  actions
});

// 🔎 AUDITORIA — Grava resposta final da SDR + estado do lead + decisões
await recordAuditEvent({
  traceId: auditTraceId,
  component: AUDIT_COMPONENTS.BACKEND_ORCHESTRATOR,
  eventType: AUDIT_EVENT_TYPES.REQUEST_COMPLETED,
  payload: {
    respostaFinalSdr: String(respostaFinal || "").slice(0, 1500),
    actions: syncedFinalReply.actions || actions || [],
    sdrReviewFindingsCount: sdrReviewFindings.length,
    sdrReviewFindings: sdrReviewFindings.slice(0, 5).map(f => ({
      tipo: f.tipo,
      prioridade: f.prioridade
    })),
    estadoLead: {
      status: currentLead?.status || "-",
      faseQualificacao: currentLead?.faseQualificacao || "-",
      faseFunil: currentLead?.faseFunil || "-",
      temperaturaComercial: currentLead?.temperaturaComercial || "-",
      rotaComercial: currentLead?.rotaComercial || "-",
      interesseReal: currentLead?.interesseReal === true,
      taxaAlinhada: currentLead?.taxaAlinhada === true,
      taxaObjectionCount: Number(currentLead?.taxaObjectionCount || 0),
      etapas: currentLead?.etapas || {}
    },
    turnPolicy: {
      modo: turnPolicy?.modo || "-",
      ofertaPermitida: turnPolicy?.ofertaPermitida || "-",
      podeFalarTaxa: turnPolicy?.podeFalarTaxa === true,
      podePedirDados: turnPolicy?.podePedirDados === true,
      podeFalarAfiliado: turnPolicy?.podeFalarAfiliado === true
    },
    podeIniciarColeta: podeIniciarColeta === true,
    startedDataCollection: startedDataCollection === true,
    coletaLiberadaPorTaxaAceita: coletaLiberadaPorTaxaAceita === true
  },
  requiredLevel: "STANDARD",
  userPhone: from,
  severity: sdrReviewFindings.length > 0 ? "medium" : "low"
});
     
// envia resposta
await sendWhatsAppMessage(from, respostaFinal);
     
history.push({
  role: "assistant",
  content: respostaFinal,
  createdAt: new Date()
});

const leadAtualizadoParaAgentes = await loadLeadProfile(from);
auditLog("currentLead DEPOIS da resposta da SDR", {
  user: maskPhone(from),
  ultimaMensagemLead: text,
  ultimaRespostaSdr: respostaFinal,
  leadAtualizadoParaAgentes: buildLeadAuditSnapshot(leadAtualizadoParaAgentes || {})
});

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

/* =========================
   DASHBOARD DE AUDITORIA — IQG
   Visualiza eventos agrupados por conversa (trace_id).
========================= */

app.get("/auditoria", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    await connectMongo();

    const senhaQuery = req.query.senha
      ? `?senha=${encodeURIComponent(req.query.senha)}`
      : "";

    const componentFilter = req.query.component || "";
    const severityFilter = req.query.severity || "";
    const traceFilter = req.query.trace || "";
    const modeFilter = req.query.mode || "grouped";
    const leadFilter = req.query.lead || "";
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const query = {};
    if (componentFilter) query.component = componentFilter;
    if (severityFilter) query.severity = severityFilter;
    if (traceFilter) query.traceId = { $regex: traceFilter, $options: "i" };
    if (leadFilter) {
      query.userMasked = { $regex: leadFilter, $options: "i" };
    } 

    const events = await db
      .collection("audit_events")
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    const totalEvents = await db.collection("audit_events").countDocuments({});

    const componentCounts = {};
    const severityCounts = {};
    for (const evt of events) {
      componentCounts[evt.component] = (componentCounts[evt.component] || 0) + 1;
      severityCounts[evt.severity] = (severityCounts[evt.severity] || 0) + 1;
    }

    const severityColors = {
      low: "#16a34a",
      medium: "#f59e0b",
      high: "#dc2626",
      critical: "#7c2d12"
    };

    const componentOptions = Object.keys(componentCounts)
      .sort()
      .map(c => '<option value="' + escapeHtml(c) + '" ' + (componentFilter === c ? "selected" : "") + '>' + escapeHtml(c) + ' (' + componentCounts[c] + ')</option>')
      .join("");

    let contentHtml = "";

    if (modeFilter === "flat") {
      const rows = events.map(evt => {
        const sevColor = severityColors[evt.severity] || "#6b7280";
        const payloadPreview = JSON.stringify(evt.payload || {}).slice(0, 300);
        const traceShort = evt.traceId ? evt.traceId.slice(0, 8) : "-";
        const timestamp = evt.timestamp
          ? new Date(evt.timestamp).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
          : "-";

        return '<tr>' +
          '<td style="font-family:monospace;font-size:11px;color:#6b7280;">' + escapeHtml(traceShort) + '</td>' +
          '<td>' + escapeHtml(timestamp) + '</td>' +
          '<td><strong>' + escapeHtml(evt.component || "-") + '</strong></td>' +
          '<td>' + escapeHtml(evt.eventType || "-") + '</td>' +
          '<td><span style="background:' + sevColor + ';color:white;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">' + escapeHtml(evt.severity || "low") + '</span></td>' +
          '<td>' + escapeHtml(evt.userMasked || "-") + '</td>' +
          '<td style="font-size:11px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(payloadPreview) + '">' + escapeHtml(payloadPreview) + '</td>' +
          '<td style="font-size:11px;color:#9ca3af;">' + escapeHtml(evt.auditLevel || "-") + '</td>' +
          '</tr>';
      }).join("");

      contentHtml = '<div class="table-card"><table>' +
        '<thead><tr><th>Trace</th><th>Timestamp</th><th>Componente</th><th>Evento</th><th>Severidade</th><th>Lead</th><th>Payload</th><th>Nível</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="8" class="empty">Nenhum evento encontrado.</td></tr>') + '</tbody>' +
        '</table></div>';
    } else if (modeFilter === "by_lead") {
      const byLead = {};
      for (const evt of events) {
        const key = evt.userMasked || "sem_lead";
        if (!byLead[key]) byLead[key] = [];
        byLead[key].push(evt);
      }

      for (const key of Object.keys(byLead)) {
        byLead[key].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      }

      const sortedLeads = Object.keys(byLead).sort((a, b) => {
        return new Date(byLead[b][0].timestamp) - new Date(byLead[a][0].timestamp);
      });

      const leadCards = sortedLeads.map(leadKey => {
        const leadEvents = byLead[leadKey];
        const totalEvts = leadEvents.length;

        const traceIds = [...new Set(leadEvents.map(e => e.traceId).filter(Boolean))];
        const totalConversas = traceIds.length;

        const maxSeverity = leadEvents.reduce((max, evt) => {
          const order = { low: 0, medium: 1, high: 2, critical: 3 };
          return (order[evt.severity] || 0) > (order[max] || 0) ? evt.severity : max;
        }, "low");

        const sevColor = severityColors[maxSeverity] || "#6b7280";

        const firstTime = leadEvents[leadEvents.length - 1].timestamp
          ? new Date(leadEvents[leadEvents.length - 1].timestamp).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
          : "-";
        const lastTime = leadEvents[0].timestamp
          ? new Date(leadEvents[0].timestamp).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
          : "-";

        const componentBreakdown = {};
        for (const evt of leadEvents) {
          componentBreakdown[evt.component] = (componentBreakdown[evt.component] || 0) + 1;
        }

        const componentBadges = Object.keys(componentBreakdown)
          .sort()
          .map(c => '<span style="background:#e5e7eb;color:#374151;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;margin:2px;">' + escapeHtml(c) + ' (' + componentBreakdown[c] + ')</span>')
          .join(" ");

        const recentTraces = traceIds.slice(0, 5).map(tid => {
          const traceEvts = leadEvents.filter(e => e.traceId === tid);
          const traceTime = traceEvts[0]?.timestamp
            ? new Date(traceEvts[0].timestamp).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
            : "-";
          const traceText = traceEvts[0]?.payload?.textPreview || traceEvts[0]?.payload?.ultimaMensagemLead || "-";
          const traceShort = tid.slice(0, 8);

          return '<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-bottom:1px solid #f1f5f9;">' +
            '<span style="font-family:monospace;font-size:11px;color:#6b7280;flex:0 0 70px;">' + escapeHtml(traceShort) + '</span>' +
            '<span style="font-size:12px;color:#6b7280;flex:0 0 140px;">' + escapeHtml(traceTime) + '</span>' +
            '<span style="font-size:12px;color:#374151;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(String(traceText).slice(0, 120)) + '</span>' +
            '<a style="font-size:11px;color:#2563eb;flex:0 0 auto;" href="/auditoria' + senhaQuery + (senhaQuery ? '&' : '?') + 'mode=grouped&trace=' + encodeURIComponent(tid) + '">ver</a>' +
          '</div>';
        }).join("");

        return '<div style="background:white;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">' +
            '<div>' +
              '<span style="font-size:16px;font-weight:700;">📱 ' + escapeHtml(leadKey) + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="background:' + sevColor + ';color:white;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">' + escapeHtml(maxSeverity) + '</span>' +
              '<span style="font-size:12px;color:#6b7280;">' + totalEvts + ' eventos</span>' +
              '<span style="font-size:12px;color:#6b7280;">' + totalConversas + ' conversas</span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap;">' +
            '<div style="font-size:12px;color:#6b7280;">Primeiro evento: ' + escapeHtml(firstTime) + '</div>' +
            '<div style="font-size:12px;color:#6b7280;">Último evento: ' + escapeHtml(lastTime) + '</div>' +
          '</div>' +
          '<div style="margin-bottom:12px;display:flex;flex-wrap:wrap;gap:4px;">' + componentBadges + '</div>' +
          '<div style="border-top:1px solid #e5e7eb;padding-top:10px;">' +
            '<div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;">Últimas conversas:</div>' +
            recentTraces +
          '</div>' +
        '</div>';
      }).join("");

      contentHtml = leadCards || '<p class="empty">Nenhum evento encontrado.</p>';
    } else {
      const grouped = {};
      for (const evt of events) {
        const key = evt.traceId || "sem_trace";
         
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(evt);
      }

      for (const key of Object.keys(grouped)) {
        grouped[key].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }

      const sortedTraces = Object.keys(grouped).sort((a, b) => {
        const lastA = grouped[a][grouped[a].length - 1];
        const lastB = grouped[b][grouped[b].length - 1];
        return new Date(lastB.timestamp) - new Date(lastA.timestamp);
      });

      const cards = sortedTraces.map(traceId => {
        const traceEvents = grouped[traceId];
        const first = traceEvents[0];
        const last = traceEvents[traceEvents.length - 1];
        const traceShort = traceId !== "sem_trace" ? traceId.slice(0, 12) : "sem trace";
        const leadMasked = first.userMasked || "-";
        const textPreview = first.payload?.textPreview || first.payload?.ultimaMensagemLead || "-";
        const startTime = first.timestamp
          ? new Date(first.timestamp).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })
          : "-";

        const maxSeverity = traceEvents.reduce((max, evt) => {
          const order = { low: 0, medium: 1, high: 2, critical: 3 };
          return (order[evt.severity] || 0) > (order[max] || 0) ? evt.severity : max;
        }, "low");

        const sevColor = severityColors[maxSeverity] || "#6b7280";

        const stepIcons = {
          webhook: "📩",
          gpt_semantic_intent: "🧠",
          gpt_semantic_continuity: "📜",
          gpt_pre_sdr_consultant: "🎯",
          gpt_sdr: "💬",
          gpt_supervisor: "👁️",
          gpt_classifier: "📊",
          gpt_data_flow_router: "🔀",
          gpt_route_mix_guard: "🛡️"
        };

        const timeline = traceEvents.map(evt => {
          const icon = stepIcons[evt.component] || "⚙️";
          const evtTime = evt.timestamp
            ? new Date(evt.timestamp).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })
            : "-";
          const evtSevColor = severityColors[evt.severity] || "#6b7280";
          const payloadStr = JSON.stringify(evt.payload || {}).slice(0, 250);

          return '<div style="display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f1f5f9;">' +
            '<div style="font-size:20px;flex:0 0 30px;text-align:center;">' + icon + '</div>' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
                '<strong style="font-size:13px;">' + escapeHtml(evt.component) + '</strong>' +
                '<span style="font-size:11px;color:#6b7280;">' + escapeHtml(evt.eventType) + '</span>' +
                '<span style="background:' + evtSevColor + ';color:white;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;">' + escapeHtml(evt.severity) + '</span>' +
                '<span style="font-size:11px;color:#9ca3af;">' + escapeHtml(evtTime) + '</span>' +
              '</div>' +
              '<div style="font-size:11px;color:#6b7280;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(payloadStr) + '">' + escapeHtml(payloadStr) + '</div>' +
            '</div>' +
          '</div>';
        }).join("");

        return '<div style="background:white;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">' +
            '<div>' +
              '<span style="font-family:monospace;font-size:12px;color:#6b7280;margin-right:10px;">trace:' + escapeHtml(traceShort) + '</span>' +
              '<span style="font-size:13px;font-weight:700;">' + escapeHtml(leadMasked) + '</span>' +
              '<span style="font-size:12px;color:#6b7280;margin-left:10px;">' + escapeHtml(startTime) + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="background:' + sevColor + ';color:white;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;">' + escapeHtml(maxSeverity) + '</span>' +
              '<span style="font-size:12px;color:#6b7280;">' + traceEvents.length + ' eventos</span>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:13px;color:#374151;margin-bottom:12px;padding:8px 12px;background:#f0fdf4;border-radius:8px;border-left:4px solid #16a34a;">' +
            '💬 ' + escapeHtml(String(textPreview).slice(0, 150)) +
          '</div>' +
          timeline +
        '</div>';
      }).join("");

      contentHtml = cards || '<p class="empty">Nenhum evento encontrado.</p>';
    }

    const modeLinks = [
      { mode: "grouped", label: "Por conversa" },
      { mode: "by_lead", label: "Por lead" },
      { mode: "flat", label: "Lista plana" }
    ];

    const modeToggle = modeLinks
      .filter(m => m.mode !== modeFilter)
      .map(m => '<a class="btn" href="/auditoria' + senhaQuery + (senhaQuery ? '&' : '?') + 'mode=' + m.mode + '">' + m.label + '</a>')
      .join(" ");

    res.send('<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Auditoria IQG</title><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>' +
      'body{margin:0;font-family:Arial,sans-serif;background:#f3f4f6;color:#111827;}' +
      'header{background:#0f172a;color:white;padding:20px 28px;}' +
      'header h1{margin:0;font-size:24px;}' +
      'header p{margin:6px 0 0;color:#94a3b8;font-size:14px;}' +
      '.container{max-width:1600px;margin:0 auto;padding:24px;}' +
      '.topbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;}' +
      '.btn{display:inline-block;padding:9px 12px;background:#374151;color:white;text-decoration:none;border-radius:8px;font-size:14px;}' +
      '.stats{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:18px;}' +
      '.stat-card{background:white;border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;min-width:160px;box-shadow:0 2px 8px rgba(0,0,0,0.04);}' +
      '.stat-card small{display:block;color:#6b7280;margin-bottom:4px;font-size:12px;}' +
      '.stat-card strong{font-size:22px;}' +
      '.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:white;border:1px solid #e5e7eb;padding:14px;border-radius:10px;margin-bottom:18px;box-shadow:0 2px 8px rgba(0,0,0,0.04);}' +
      '.toolbar select,.toolbar input{height:36px;border:1px solid #d1d5db;border-radius:8px;padding:0 10px;font-size:13px;}' +
      '.toolbar button{height:36px;padding:0 14px;border:none;border-radius:8px;background:#2563eb;color:white;cursor:pointer;font-size:13px;}' +
      '.table-card{background:white;border:1px solid #e5e7eb;border-radius:10px;overflow-x:auto;box-shadow:0 2px 8px rgba(0,0,0,0.04);}' +
      'table{width:100%;border-collapse:collapse;}' +
      'th{background:#f8fafc;color:#334155;font-size:12px;text-align:left;padding:10px 12px;border-bottom:1px solid #e5e7eb;white-space:nowrap;}' +
      'td{padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:middle;}' +
      'tr:hover td{background:#f8fafc;}' +
      '.empty{color:#6b7280;font-style:italic;padding:20px;text-align:center;}' +
      '</style></head><body>' +
      '<header><h1>Auditoria IQG</h1><p>Eventos estruturados — Nível atual: ' + escapeHtml(getCurrentAuditLevel()) + '</p></header>' +
      '<div class="container">' +
        '<div class="topbar">' +
          '<a class="btn" href="/dashboard' + senhaQuery + '">← Voltar ao Dashboard</a>' +
          modeToggle +
          '<a id="btnRelatorio24h" class="btn" style="background:#2563eb;" href="/auditoria/relatorio-tecnico' + senhaQuery + (senhaQuery ? '&' : '?') + 'horas=24" download>📥 Baixar Relatório 24h</a>' +
          '<a id="btnRelatorio7d" class="btn" style="background:#7c3aed;" href="/auditoria/relatorio-tecnico' + senhaQuery + (senhaQuery ? '&' : '?') + 'horas=168" download>📥 Relatório 7 dias</a>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;margin-bottom:18px;box-shadow:0 2px 8px rgba(0,0,0,0.04);">' +
          '<label style="font-size:13px;font-weight:700;color:#374151;white-space:nowrap;">🎯 Filtro de lead para relatórios:</label>' +
          '<input id="relatorioLeadFilter" type="text" style="flex:1;min-width:220px;height:34px;border:1px solid #d1d5db;border-radius:8px;padding:0 10px;font-size:13px;font-family:monospace;" placeholder="Ex: 5554*****75 — vazio = todos os leads">' +
          '<button type="button" onclick="document.getElementById(\'relatorioLeadFilter\').value=\'\';atualizarLinksRelatorio();" style="height:34px;padding:0 12px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;color:#374151;font-size:12px;font-weight:600;cursor:pointer;">Limpar</button>' +
          '<a id="btnRelatorioCompleto" class="btn" style="display:none;background:#dc2626;font-weight:800;font-size:12px;white-space:nowrap;" download>📥 Histórico COMPLETO deste lead</a>' +
          '<span id="relatorioFiltroStatus" style="font-size:12px;color:#6b7280;font-style:italic;">Relatórios baixarão todos os leads</span>' +
        '</div>' +
        '<script>' +
          'var relatorio24hBase = ' + JSON.stringify("/auditoria/relatorio-tecnico" + senhaQuery + (senhaQuery ? "&" : "?") + "horas=24") + ';' +
          'var relatorio7dBase = ' + JSON.stringify("/auditoria/relatorio-tecnico" + senhaQuery + (senhaQuery ? "&" : "?") + "horas=168") + ';' +
          'var relatorioCompletoBase = ' + JSON.stringify("/auditoria/relatorio-tecnico" + senhaQuery + (senhaQuery ? "&" : "?") + "horas=all") + ';' +
          'function atualizarLinksRelatorio() {' +
            'var input = document.getElementById("relatorioLeadFilter");' +
            'var lead = input ? String(input.value || "").trim() : "";' +
            'var b24 = document.getElementById("btnRelatorio24h");' +
            'var b7d = document.getElementById("btnRelatorio7d");' +
            'var bFull = document.getElementById("btnRelatorioCompleto");' +
            'var status = document.getElementById("relatorioFiltroStatus");' +
            'var suffix = lead ? ("&lead=" + encodeURIComponent(lead)) : "";' +
            'if (b24) b24.href = relatorio24hBase + suffix;' +
            'if (b7d) b7d.href = relatorio7dBase + suffix;' +
            'if (bFull) {' +
              'if (lead) {' +
                'bFull.href = relatorioCompletoBase + "&lead=" + encodeURIComponent(lead);' +
                'bFull.style.display = "inline-block";' +
              '} else {' +
                'bFull.style.display = "none";' +
              '}' +
            '}' +
            'if (status) {' +
              'status.textContent = lead ? ("Relatórios filtrarão apenas o lead: " + lead) : "Relatórios baixarão todos os leads";' +
              'status.style.color = lead ? "#dc2626" : "#6b7280";' +
              'status.style.fontWeight = lead ? "700" : "400";' +
            '}' +
          '}' +
          'document.addEventListener("DOMContentLoaded", function() {' +
            'var input = document.getElementById("relatorioLeadFilter");' +
            'if (input) {' +
              'input.addEventListener("input", atualizarLinksRelatorio);' +
              'input.addEventListener("change", atualizarLinksRelatorio);' +
            '}' +
          '});' +
        '</script>' +
        '<div class="stats">' +
          '<div class="stat-card"><small>Total de eventos</small><strong>' + totalEvents + '</strong></div>' +
          '<div class="stat-card"><small>Exibindo</small><strong>' + events.length + '</strong></div>' +
          '<div class="stat-card"><small>Nível ativo</small><strong>' + escapeHtml(getCurrentAuditLevel()) + '</strong></div>' +
          '<div class="stat-card"><small>Conversas</small><strong>' + (modeFilter !== "flat" ? Object.keys(events.reduce((acc, e) => { acc[e.traceId || "x"] = 1; return acc; }, {})).length : "-") + '</strong></div>' +
          '<div class="stat-card"><small>Severidade alta+</small><strong style="color:#dc2626;">' + ((severityCounts.high || 0) + (severityCounts.critical || 0)) + '</strong></div>' +
        '</div>' +
        '<form class="toolbar" method="GET" action="/auditoria">' +
          (req.query.senha ? '<input type="hidden" name="senha" value="' + escapeHtml(req.query.senha) + '">' : '') +
          '<input type="hidden" name="mode" value="' + escapeHtml(modeFilter) + '">' +
          '<select name="component"><option value="">Componente: todos</option>' + componentOptions + '</select>' +
          '<select name="severity"><option value="">Severidade: todas</option>' +
            '<option value="low"' + (severityFilter === "low" ? " selected" : "") + '>low</option>' +
            '<option value="medium"' + (severityFilter === "medium" ? " selected" : "") + '>medium</option>' +
            '<option value="high"' + (severityFilter === "high" ? " selected" : "") + '>high</option>' +
            '<option value="critical"' + (severityFilter === "critical" ? " selected" : "") + '>critical</option>' +
          '</select>' +
          '<input type="text" name="trace" placeholder="Buscar trace_id..." value="' + escapeHtml(traceFilter) + '">' +
          '<select name="limit">' +
            '<option value="50"' + (limit === 50 ? " selected" : "") + '>50</option>' +
            '<option value="100"' + (limit === 100 ? " selected" : "") + '>100</option>' +
            '<option value="200"' + (limit === 200 ? " selected" : "") + '>200</option>' +
            '<option value="500"' + (limit === 500 ? " selected" : "") + '>500</option>' +
          '</select>' +
          '<button type="submit">Filtrar</button>' +
          '<a class="btn" href="/auditoria' + senhaQuery + '">Limpar</a>' +
       '</form>' +
      '<div style="margin-bottom:18px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 55%,#172554 100%);border-radius:14px;padding:20px;color:#fff;box-shadow:0 12px 34px rgba(15,23,42,0.20);border:1px solid rgba(255,255,255,0.08);">' +
          '<div style="display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;background:rgba(59,130,246,0.18);color:#bfdbfe;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">C-Level Auditor GPT</div>' +
          '<h3 style="margin:0 0 8px;font-size:22px;font-weight:900;">Auditor IA — Análise dos Eventos</h3>' +
          '<p style="margin:0 0 18px;color:#cbd5e1;font-size:14px;">Analisa padrões, qualidade dos GPTs, gargalos e sugestões de melhoria com base nos eventos de auditoria.</p>' +
          '<div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:16px;">' +
            '<div style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:16px;">' +
              '<label style="display:block;font-size:13px;font-weight:800;margin-bottom:6px;color:#e2e8f0;">Filtrar por lead específico <span style="font-weight:500;color:#94a3b8;">(opcional — deixe vazio para análise geral)</span>:</label>' +
              '<input id="auditorLeadFilter" type="text" style="width:100%;border:1px solid rgba(255,255,255,0.16);background:rgba(15,23,42,0.72);color:#fff;border-radius:10px;padding:10px 12px;font-size:13px;outline:none;margin-bottom:12px;font-family:monospace;" placeholder="Ex: 5554*****75 — cole o telefone mascarado do lead que aparece na lista">' +
              '<label style="display:block;font-size:13px;font-weight:800;margin-bottom:9px;color:#e2e8f0;">Pergunte ao Auditor:</label>' +
              '<textarea id="auditorQuestion" style="width:100%;min-height:100px;resize:vertical;border:1px solid rgba(255,255,255,0.16);background:rgba(15,23,42,0.72);color:#fff;border-radius:10px;padding:12px;font-size:13px;line-height:1.45;outline:none;" placeholder="Ex: Quais GPTs estão gerando mais erros? Tem algum padrão de falha?"></textarea>' +
              '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">' +
                '<button type="button" id="askAuditorBtn" onclick="askAuditor()" style="border:0;border-radius:999px;height:36px;padding:0 13px;font-size:12px;font-weight:800;cursor:pointer;background:#60a5fa;color:#0f172a;">Perguntar ao Auditor</button>' +
                '<button type="button" onclick="document.getElementById(\'auditorLeadFilter\').value=\'\';document.getElementById(\'auditorLeadFilter\').focus();" style="border:1px solid rgba(255,255,255,0.16);border-radius:999px;height:36px;padding:0 13px;font-size:12px;font-weight:700;cursor:pointer;background:transparent;color:#cbd5e1;">Limpar filtro de lead</button>' +
                '<button type="button" onclick="askAuditor(\'Analise os eventos recentes. Quais GPTs estão funcionando bem, quais precisam de atenção e existe algum padrão de erro?\')" style="border:0;border-radius:999px;height:36px;padding:0 13px;font-size:12px;font-weight:800;cursor:pointer;background:rgba(255,255,255,0.12);color:#e2e8f0;">Diagnóstico geral</button>' +
                '<button type="button" onclick="askAuditor(\'Existem eventos de alta severidade? Se sim, o que causou e como corrigir?\')" style="border:0;border-radius:999px;height:36px;padding:0 13px;font-size:12px;font-weight:800;cursor:pointer;background:rgba(255,255,255,0.12);color:#e2e8f0;">Erros críticos</button>' +
                '<button type="button" onclick="askAuditor(\'Quais melhorias nos prompts ou travas do backend você sugere com base nos eventos?\')" style="border:0;border-radius:999px;height:36px;padding:0 13px;font-size:12px;font-weight:800;cursor:pointer;background:rgba(255,255,255,0.12);color:#e2e8f0;">Sugestões</button>' +
              '</div>' +
            '</div>' +
            '<div id="auditorResponse" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:16px;">' +
              '<div style="font-size:13px;font-weight:900;color:#bfdbfe;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">Resposta do Auditor</div>' +
              '<p style="color:#e2e8f0;font-size:13px;">Faça uma pergunta para receber uma análise técnica dos eventos de auditoria.</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<script>' +
        'var auditorSenha = ' + JSON.stringify(String(req.query.senha || "")) + ';' +
        'async function askAuditor(qOverride) {' +
          'var qBox = document.getElementById("auditorQuestion");' +
          'var leadBox = document.getElementById("auditorLeadFilter");' +
          'var rBox = document.getElementById("auditorResponse");' +
          'var btn = document.getElementById("askAuditorBtn");' +
          'var pergunta = String(qOverride || qBox.value || "").trim();' +
          'var leadFiltro = leadBox ? String(leadBox.value || "").trim() : "";' +
          'if (!pergunta || pergunta.length < 8) { rBox.innerHTML = "<p style=\\"color:#fca5a5;\\">Digite uma pergunta mais completa.</p>"; return; }' +
          'qBox.value = pergunta;' +
          'if (btn) { btn.disabled = true; btn.textContent = leadFiltro ? "Analisando lead..." : "Analisando..."; }' +
          'var loadingMsg = leadFiltro ? ("Analisando eventos do lead <strong>" + leadFiltro + "</strong>...") : "Analisando eventos de auditoria (todos os leads)...";' +
          'rBox.innerHTML = "<p style=\\"color:#e2e8f0;\\">" + loadingMsg + "</p>";' +
          'try {' +
            'var url = "/auditoria/c-level-auditor" + (auditorSenha ? "?senha=" + encodeURIComponent(auditorSenha) : "");' +
            'var body = { pergunta: pergunta };' +
            'if (leadFiltro) { body.lead = leadFiltro; }' +
            'var resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });' +
            'var data = await resp.json();' +
            'if (!resp.ok || !data.ok) throw new Error(data.error || "Falha na análise.");' +
            'var a = data.analysis || {};' +
            'var snap = data.auditSnapshot || {};' +
            'var modoBadge = "";' +
            'if (snap.modoAnalise === "lead_especifico") {' +
              'modoBadge = "<div style=\\"display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:rgba(245,158,11,0.18);color:#fde68a;font-size:12px;font-weight:800;margin-bottom:10px;border:1px solid rgba(245,158,11,0.35);\\">🎯 Análise de lead específico: " + (snap.leadAnalisado || leadFiltro) + " · " + (snap.eventosAnalisados || 0) + " eventos</div>";' +
            '} else {' +
              'modoBadge = "<div style=\\"display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:rgba(96,165,250,0.18);color:#dbeafe;font-size:12px;font-weight:800;margin-bottom:10px;border:1px solid rgba(96,165,250,0.35);\\">🌐 Análise geral do sistema · " + (snap.eventosAnalisados || 0) + " eventos</div>";' +
            '}' +
            'var html = modoBadge + "<h4 style=\\"margin:0 0 10px;font-size:18px;color:#fff;\\">" + (a.tituloDiagnostico || "Diagnóstico") + "</h4>";' +
            'if (a.qualidadeGpts) html += "<span style=\\"display:inline-flex;padding:5px 9px;border-radius:999px;background:rgba(96,165,250,0.16);color:#dbeafe;font-size:12px;font-weight:800;margin:4px 8px 8px 0;\\">GPTs: " + (a.qualidadeGpts.status || "-") + "</span>";' +
            'if (a.qualidadeBackend) html += "<span style=\\"display:inline-flex;padding:5px 9px;border-radius:999px;background:rgba(96,165,250,0.16);color:#dbeafe;font-size:12px;font-weight:800;margin:4px 8px 8px 0;\\">Backend: " + (a.qualidadeBackend.status || "-") + "</span>";' +
            'if (a.prioridadeExecutiva) html += "<div style=\\"display:inline-flex;padding:5px 9px;border-radius:999px;background:rgba(250,204,21,0.16);color:#fef3c7;font-size:12px;font-weight:800;margin-bottom:10px;\\">Prioridade: " + a.prioridadeExecutiva + "</div>";' +
            'html += "<p style=\\"color:#e2e8f0;font-size:13px;line-height:1.45;\\">" + (a.resumoExecutivo || "") + "</p>";' +
            'if (a.qualidadeGpts && a.qualidadeGpts.analise) html += "<h5 style=\\"margin:14px 0 7px;font-size:13px;color:#bfdbfe;\\">Qualidade GPTs</h5><p style=\\"color:#cbd5e1;font-size:13px;\\">" + a.qualidadeGpts.analise + "</p>";' +
            'if (a.qualidadeBackend && a.qualidadeBackend.analise) html += "<h5 style=\\"margin:14px 0 7px;font-size:13px;color:#bfdbfe;\\">Qualidade Backend</h5><p style=\\"color:#cbd5e1;font-size:13px;\\">" + a.qualidadeBackend.analise + "</p>";' +
            'if (Array.isArray(a.diagnosticosAcionaveis) && a.diagnosticosAcionaveis.length > 0) {' +
              'html += "<h5 style=\\"margin:14px 0 7px;font-size:13px;color:#bfdbfe;text-transform:uppercase;\\">Diagnósticos acionáveis</h5>";' +
              'a.diagnosticosAcionaveis.forEach(function(d, i) {' +
                'var pc = d.prioridade === "critica" ? "#ef4444" : d.prioridade === "alta" ? "#f59e0b" : d.prioridade === "media" ? "#3b82f6" : "#6b7280";' +
                'html += "<div style=\\"background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:12px;margin-bottom:10px;border-left:4px solid " + pc + ";\\">";' +
                'html += "<div style=\\"display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;\\"><strong style=\\"font-size:13px;color:#fff;\\">#" + (i+1) + " — " + (d.problema || "-") + "</strong><span style=\\"background:" + pc + ";color:white;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;\\">" + (d.prioridade || "-") + "</span></div>";' +
                'html += "<div style=\\"font-size:12px;color:#94a3b8;margin-bottom:4px;\\">📍 Onde: " + (d.onde || "-") + "</div>";' +
                'html += "<div style=\\"font-size:12px;color:#fca5a5;margin-bottom:4px;\\">⚠️ Por quê: " + (d.porqueEProblema || "-") + "</div>";' +
                'html += "<div style=\\"font-size:12px;color:#86efac;margin-bottom:4px;\\">✅ Correção: " + (d.comoCorrigir || "-") + "</div>";' +
                'html += "<div style=\\"font-size:11px;color:#6b7280;\\">🔧 Componente: " + (d.componente || "-") + "</div>";' +
                'html += "</div>";' +
              '});' +
            '}' +
            'function rl(t, items) { if (!Array.isArray(items) || !items.length) return ""; return "<h5 style=\\"margin:14px 0 7px;font-size:13px;color:#bfdbfe;\\">" + t + "</h5><ul style=\\"margin:0;padding-left:18px;color:#cbd5e1;font-size:13px;line-height:1.55;\\">" + items.map(function(x){return "<li>"+x+"</li>";}).join("") + "</ul>"; }' +
            'html += rl("Padrões observados", a.padroesObservados);' +
            'html += rl("Gargalos", a.gargalos);' +
            'html += rl("Oportunidades de melhoria", a.oportunidadesMelhoria);' +
            'html += rl("Plano de ação", a.planoAcao);' +
            'if (a.observacaoSobreAmostra) html += "<p style=\\"color:#94a3b8;font-size:12px;margin-top:12px;\\">" + a.observacaoSobreAmostra + "</p>";' +
            'rBox.innerHTML = html;' +
          '} catch (err) {' +
            'rBox.innerHTML = "<p style=\\"color:#fca5a5;\\">" + (err.message || "Erro ao gerar análise.") + "</p>";' +
          '} finally {' +
            'if (btn) { btn.disabled = false; btn.textContent = "Perguntar ao Auditor"; }' +
          '}' +
        '}' +
        '</script>' +
        contentHtml +
      '</div></body></html>'
    );
  } catch (error) {
    console.error("Erro no dashboard de auditoria:", error);
    res.status(500).send("Erro ao carregar auditoria.");
  }
});

/* =========================
   C-LEVEL AUDITOR GPT — ANÁLISE DOS EVENTOS DE AUDITORIA
========================= */

const CLEVEL_AUDITOR_SYSTEM_PROMPT = `
Você é o C-Level Auditor GPT da IQG.

Você analisa eventos de auditoria do sistema de SDR IA no WhatsApp e gera diagnósticos detalhados e acionáveis.

Seu papel é:
- Identificar padrões de erro nos GPTs (Classificador, Historiador, Pré-SDR, Supervisor, SDR).
- Detectar decisões incorretas dos agentes.
- Apontar gargalos de conversão, repetição ou perda de leads.
- Avaliar a qualidade geral do atendimento automatizado.
- Gerar recomendações PRÁTICAS e ESPECÍFICAS de correção.

Você NÃO altera leads, NÃO manda WhatsApp, NÃO envia CRM, NÃO gera código.

Contexto técnico da IQG:
- Backend Node.js + Express + MongoDB no Render.
- Arquivo principal: server.js (~7000 linhas).
- Múltiplos GPTs: SDR IA, Consultor Pré-SDR, Supervisor, Classificador Comercial, Classificador Semântico de Intenção, Historiador Semântico de Continuidade, Roteador de Coleta, Anti-Mistura, C-Level Dashboard.
- Travas determinísticas no backend protegem contra erros dos GPTs.
- Funil principal: Programa Parceiro Homologado IQG (taxa R$ 1.990, lote em comodato, suporte).
- Rota alternativa: Programa de Afiliados IQG (link, sem estoque, sem taxa).
- A taxa de adesão é o principal gargalo de conversão.
- Etapas do funil: programa → benefícios → estoque → responsabilidades → investimento → compromisso → coleta → confirmação → CRM.

REGRA PRINCIPAL — DIAGNÓSTICOS ACIONÁVEIS:

Para cada problema detectado, você DEVE informar:

1. O QUE aconteceu — descrição clara do problema.
2. ONDE no sistema — qual GPT, qual trava, qual parte do fluxo.
3. POR QUE é problema — impacto na conversão, experiência do lead ou custo.
4. COMO corrigir — descrição prática da correção necessária.
5. PRIORIDADE — baixa, média, alta ou crítica.
6. COMPONENTE — qual função/prompt/trava precisa ser ajustada.

CATEGORIAS DE PROBLEMAS A MONITORAR:

1. CLASSIFICAÇÃO INCORRETA — GPT interpretou errado a intenção do lead.
2. REPETIÇÃO — SDR repetiu explicação que o lead já entendeu.
3. COLETA PREMATURA — sistema tentou pedir dados antes da hora.
4. ROTA ERRADA — lead foi jogado para Afiliado ou Homologado sem motivo.
5. OBJEÇÃO MAL TRATADA — taxa/preço não foi respondida corretamente.
6. PERDA EVITÁVEL — lead esfriou por erro de condução.
7. TRAVA EXCESSIVA — backend bloqueou avanço legítimo do lead.
8. TRAVA INSUFICIENTE — backend permitiu avanço indevido.
9. CUSTO DESNECESSÁRIO — GPT chamado sem necessidade.
10. LATÊNCIA — processamento demorou demais.

Regras:
1. Base sua análise SOMENTE nos eventos recebidos.
2. Não invente dados.
3. Se a amostra for pequena, diga claramente.
4. Separe problemas dos GPTs de problemas do backend/travas.
5. Priorize ações práticas e específicas.
6. Para cada sugestão, indique o componente exato do sistema.
7. Use linguagem técnica quando necessário, mas explique o impacto comercial.

Responda SEMPRE em JSON válido:

{
  "tituloDiagnostico": "",
  "resumoExecutivo": "",
  "qualidadeGpts": {
    "status": "boa | atencao | critica | inconclusiva",
    "analise": ""
  },
  "qualidadeBackend": {
    "status": "boa | atencao | critica | inconclusiva",
    "analise": ""
  },
  "diagnosticosAcionaveis": [
    {
      "problema": "",
      "onde": "",
      "porqueEProblema": "",
      "comoCorrigir": "",
      "prioridade": "baixa | media | alta | critica",
      "componente": ""
    }
  ],
  "padroesObservados": [],
  "gargalos": [],
  "oportunidadesMelhoria": [],
  "planoAcao": [],
  "prioridadeExecutiva": "baixa | media | alta | critica",
  "observacaoSobreAmostra": ""
}
`;

app.post("/auditoria/c-level-auditor", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    const pergunta = String(req.body?.pergunta || "").trim();
    const leadFilter = String(req.body?.lead || "").trim();

    if (!pergunta || pergunta.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Digite uma pergunta mais completa para o C-Level Auditor."
      });
    }

    await connectMongo();

    /*
      Filtro opcional por lead específico.
      Se vier `lead` no body, restringe a análise apenas aos eventos
      daquele lead (busca por userMasked, case-insensitive).
      Útil para analisar 1 conversa específica sem desperdiçar tokens
      revisando leads onde a condução da SDR foi ok.
    */
    const eventQuery = {};
    if (leadFilter) {
      eventQuery.userMasked = { $regex: leadFilter, $options: "i" };
    }

    const recentEvents = await db
      .collection("audit_events")
      .find(eventQuery)
      .sort({ timestamp: -1 })
      .limit(leadFilter ? 500 : 200)
      .toArray();

    const totalEvents = await db
      .collection("audit_events")
      .countDocuments(eventQuery);

    const componentSummary = {};
    const severitySummary = {};
    const eventTypeSummary = {};

    for (const evt of recentEvents) {
      componentSummary[evt.component] = (componentSummary[evt.component] || 0) + 1;
      severitySummary[evt.severity] = (severitySummary[evt.severity] || 0) + 1;
      eventTypeSummary[evt.eventType] = (eventTypeSummary[evt.eventType] || 0) + 1;
    }

    const highSeverityEvents = recentEvents
      .filter(evt => evt.severity === "high" || evt.severity === "critical")
      .slice(0, 20)
      .map(evt => ({
        component: evt.component,
        eventType: evt.eventType,
        severity: evt.severity,
        timestamp: evt.timestamp,
        userMasked: evt.userMasked,
        payloadPreview: JSON.stringify(evt.payload || {}).slice(0, 500)
      }));

    const auditSnapshot = {
      modoAnalise: leadFilter ? "lead_especifico" : "sistema_geral",
      leadAnalisado: leadFilter || null,
      avisoParaOAuditor: leadFilter
        ? `IMPORTANTE: esta análise é de UM LEAD ESPECÍFICO (${leadFilter}). Os dados abaixo referem-se SOMENTE a este lead, não ao sistema inteiro. Foque em diagnosticar a condução desta conversa específica. Não tire conclusões sobre volume geral, gargalos do sistema ou performance global a partir destes dados.`
        : "Esta análise é GERAL do sistema (todos os leads recentes). Identifique padrões, gargalos e problemas recorrentes entre múltiplos leads.",
      totalEvents,
      eventosAnalisados: recentEvents.length,
      auditLevelAtivo: getCurrentAuditLevel(),
      resumoPorComponente: componentSummary,
      resumoPorSeveridade: severitySummary,
      resumoPorTipoEvento: eventTypeSummary,
      eventosAltaSeveridade: highSeverityEvents,
      amostraEventosRecentes: recentEvents.slice(0, leadFilter ? 80 : 30).map(evt => ({
        component: evt.component,
        eventType: evt.eventType,
        severity: evt.severity,
        timestamp: evt.timestamp,
        auditLevel: evt.auditLevel,
        userMasked: evt.userMasked,
        payloadPreview: JSON.stringify(evt.payload || {}).slice(0, leadFilter ? 600 : 300)
      }))
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_CLEVEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: CLEVEL_AUDITOR_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: JSON.stringify({
              perguntaDoGestor: pergunta,
              auditSnapshot
            })
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro ao chamar C-Level Auditor GPT:", data);
      return res.status(500).json({
        ok: false,
        error: "Falha ao gerar análise do C-Level Auditor."
      });
    }

    const rawText = data.choices?.[0]?.message?.content || "{}";

    let analysis;
    try {
      analysis = JSON.parse(rawText);
    } catch (e) {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");
      analysis = start !== -1 && end > start
        ? JSON.parse(rawText.slice(start, end + 1))
        : { resumoExecutivo: "Falha ao interpretar resposta do Auditor." };
    }

    return res.json({
      ok: true,
      analysis,
      auditSnapshot
    });
  } catch (error) {
    console.error("Erro na rota C-Level Auditor:", error);
    return res.status(500).json({
      ok: false,
      error: "Erro ao gerar análise do C-Level Auditor."
    });
  }
});

/* =========================
   RELATÓRIO TÉCNICO DE AUDITORIA — DOWNLOAD
   Gera arquivo JSON completo para análise externa.
========================= */

app.get("/auditoria/relatorio-tecnico", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    await connectMongo();

    const horasParam = String(req.query.horas || "").trim().toLowerCase();
    const traceFilter = req.query.trace || "";
    const leadFilter = req.query.lead || "";

    /*
      Suporte ao modo "histórico completo do lead":
      - Se horas=all (ou "tudo" / "completo") E houver leadFilter,
        ignora o filtro de tempo e busca TODOS os eventos do lead.
      - Caso contrário, comporta-se como antes (default 24h, máx 168h).
      O modo "all" só é permitido com leadFilter preenchido, para evitar
      relatórios gigantes do sistema inteiro.
    */
    const wantsFullHistory =
      ["all", "tudo", "completo", "full"].includes(horasParam) &&
      Boolean(leadFilter);

    const hoursBack = wantsFullHistory
      ? null
      : Math.min(Number(req.query.horas) || 24, 168);

    const cutoff = wantsFullHistory
      ? null
      : new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    const query = {};
    if (!wantsFullHistory) query.timestamp = { $gte: cutoff };
    if (traceFilter) query.traceId = { $regex: traceFilter, $options: "i" };
    if (leadFilter) query.userMasked = { $regex: leadFilter, $options: "i" };

    const events = await db
      .collection("audit_events")
      .find(query)
      .sort({ timestamp: 1 })
      .limit(wantsFullHistory ? 5000 : 2000)
      .toArray();

    const grouped = {};
    for (const evt of events) {
      const key = evt.traceId || "sem_trace_" + evt._id;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(evt);
    }

    const conversas = [];

    for (const [traceId, traceEvents] of Object.entries(grouped)) {
      traceEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const first = traceEvents[0];
      const last = traceEvents[traceEvents.length - 1];

      const webhookEvt = traceEvents.find(e => e.component === "webhook");
      const classifierEvt = traceEvents.find(e => e.component === "gpt_semantic_intent");
      const historianEvt = traceEvents.find(e => e.component === "gpt_semantic_continuity");
      const preSdrEvt = traceEvents.find(e => e.component === "gpt_pre_sdr_consultant");
       const orchestratorEvt = traceEvents.find(e => e.component === "backend_orchestrator");

      conversas.push({
        traceId,
        leadMasked: first.userMasked || "-",
        timestampInicio: first.timestamp,
        timestampFim: last.timestamp,
        totalEventos: traceEvents.length,
        severidadeMaxima: traceEvents.reduce((max, evt) => {
          const order = { low: 0, medium: 1, high: 2, critical: 3 };
          return (order[evt.severity] || 0) > (order[max] || 0) ? evt.severity : max;
        }, "low"),

        mensagemLead: webhookEvt?.payload?.textPreview
          || classifierEvt?.payload?.ultimaMensagemLead
          || "-",

        webhook: webhookEvt ? {
          messageType: webhookEvt.payload?.messageType || "-",
          hasText: webhookEvt.payload?.hasText,
          hasAudio: webhookEvt.payload?.hasAudio,
          textPreview: webhookEvt.payload?.textPreview || "-",
          timestamp: webhookEvt.timestamp
        } : null,

        classificadorSemantico: classifierEvt ? {
          modelo: classifierEvt.payload?.model || "-",
          ultimaMensagemLead: classifierEvt.payload?.ultimaMensagemLead || "-",
          confidence: classifierEvt.payload?.confidence || "-",
          wantsAffiliate: classifierEvt.payload?.wantsAffiliate,
          wantsHomologado: classifierEvt.payload?.wantsHomologado,
          blockingObjection: classifierEvt.payload?.blockingObjection,
          priceObjection: classifierEvt.payload?.priceObjection,
          asksQuestion: classifierEvt.payload?.asksQuestion,
          greetingOnly: classifierEvt.payload?.greetingOnly,
          reason: classifierEvt.payload?.reason || "-",
          payloadCompleto: classifierEvt.payload,
          timestamp: classifierEvt.timestamp
        } : null,
         respostaFinalSdr: orchestratorEvt?.payload?.respostaFinalSdr || null,
        estadoLead: orchestratorEvt?.payload?.estadoLead || null,
        turnPolicy: orchestratorEvt?.payload?.turnPolicy || null,
        decisoesBackend: orchestratorEvt ? {
          podeIniciarColeta: orchestratorEvt.payload?.podeIniciarColeta,
          startedDataCollection: orchestratorEvt.payload?.startedDataCollection,
          coletaLiberadaPorTaxaAceita: orchestratorEvt.payload?.coletaLiberadaPorTaxaAceita,
          sdrReviewFindingsCount: orchestratorEvt.payload?.sdrReviewFindingsCount || 0,
          sdrReviewFindings: orchestratorEvt.payload?.sdrReviewFindings || [],
          actions: orchestratorEvt.payload?.actions || []
        } : null,

        historiadorSemantico: historianEvt ? {
          modelo: historianEvt.payload?.model || "-",
          ultimaMensagemLead: historianEvt.payload?.ultimaMensagemLead || "-",
          leadEntendeuUltimaExplicacao: historianEvt.payload?.leadEntendeuUltimaExplicacao,
          leadQuerAvancar: historianEvt.payload?.leadQuerAvancar,
          leadCriticouRepeticao: historianEvt.payload?.leadCriticouRepeticao,
          naoRepetirUltimoTema: historianEvt.payload?.naoRepetirUltimoTema,
          proximaAcaoSemantica: historianEvt.payload?.proximaAcaoSemantica || "-",
          confidence: historianEvt.payload?.confidence || "-",
          reason: historianEvt.payload?.reason || "-",
          payloadCompleto: historianEvt.payload,
          timestamp: historianEvt.timestamp
        } : null,

        consultorPreSdr: preSdrEvt ? {
          modelo: preSdrEvt.payload?.model || "-",
          ultimaMensagemLead: preSdrEvt.payload?.ultimaMensagemLead || "-",
          estrategiaRecomendada: preSdrEvt.payload?.estrategiaRecomendada || "-",
          proximaMelhorAcao: preSdrEvt.payload?.proximaMelhorAcao || "-",
          ofertaMaisAdequada: preSdrEvt.payload?.ofertaMaisAdequada || "-",
          prioridadeComercial: preSdrEvt.payload?.prioridadeComercial || "-",
          momentoIdealHumano: preSdrEvt.payload?.momentoIdealHumano || "-",
          cuidadoPrincipal: preSdrEvt.payload?.cuidadoPrincipal || "-",
          payloadCompleto: preSdrEvt.payload,
          timestamp: preSdrEvt.timestamp
        } : null,

        todosEventos: traceEvents.map(evt => ({
          component: evt.component,
          eventType: evt.eventType,
          severity: evt.severity,
          auditLevel: evt.auditLevel,
          timestamp: evt.timestamp,
          payload: evt.payload
        }))
      });
    }

    const leadsUnicos = [...new Set(events.map(e => e.userMasked).filter(Boolean))];

    const relatorio = {
      metadados: {
        geradoEm: new Date().toISOString(),
        periodoAnalisado: wantsFullHistory
          ? `HISTÓRICO COMPLETO do lead ${leadFilter} (sem limite de tempo)`
          : `últimas ${hoursBack} horas`,
        dataInicio: wantsFullHistory
          ? (events[0]?.timestamp || null)
          : cutoff.toISOString(),
        dataFim: new Date().toISOString(),
        totalEventos: events.length,
        totalConversas: conversas.length,
        totalLeads: leadsUnicos.length,
        auditLevelAtivo: getCurrentAuditLevel(),
        appVersion: process.env.APP_VERSION || "iqg-sdr-v1.0.0",
        modoRelatorio: wantsFullHistory ? "historico_completo_lead" : "janela_temporal",
        filtrosAplicados: {
          horas: wantsFullHistory ? "all" : hoursBack,
          trace: traceFilter || null,
          lead: leadFilter || null
        }
      },

      resumoGeral: {
        eventosPorComponente: events.reduce((acc, e) => {
          acc[e.component] = (acc[e.component] || 0) + 1;
          return acc;
        }, {}),
        eventosPorSeveridade: events.reduce((acc, e) => {
          acc[e.severity] = (acc[e.severity] || 0) + 1;
          return acc;
        }, {}),
        eventosPorTipo: events.reduce((acc, e) => {
          acc[e.eventType] = (acc[e.eventType] || 0) + 1;
          return acc;
        }, {}),
        leadsAtendidos: leadsUnicos
      },

      conversas,

      instrucaoParaAnalise: [
        "Este relatório contém todos os eventos de auditoria agrupados por conversa (traceId).",
        "Cada conversa mostra: mensagem do lead, resposta de cada GPT com payload completo, e a sequência cronológica de todos os eventos.",
        "Use este arquivo para identificar: classificações incorretas, repetições, coletas prematuras, rotas erradas, objeções mal tratadas, travas excessivas ou insuficientes.",
        "Para cada problema encontrado, indique: o que aconteceu, onde no código (qual função/prompt), por que é problema, como corrigir e a prioridade.",
        "As funções principais do sistema são: runLeadSemanticIntentClassifier, runConversationContinuityAnalyzer, runConsultantAssistant, buildTurnPolicy, enforceFunnelDiscipline, classifyTaxPhaseDecision, runFinalRouteMixGuard."
      ]
    };

    const filename = `auditoria-tecnica-${new Date().toISOString().slice(0, 10)}.json`;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(relatorio, null, 2));
  } catch (error) {
    console.error("Erro ao gerar relatório técnico:", error);
    res.status(500).send("Erro ao gerar relatório técnico.");
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

/* =========================
   MULTI C-LEVEL GPT — DASHBOARD KPIS
   Consultor de Growth, Receita, KPIs e escala.
   Não mexe em lead, não manda WhatsApp, não envia CRM.
========================= */

function safePercentNumber(part, base) {
  const p = Number(part || 0);
  const b = Number(base || 0);

  if (!b || b <= 0) return 0;

  return Number(((p / b) * 100).toFixed(1));
}

function getLeadDateForKpi(lead = {}) {
  const value =
    lead.createdAt ||
    lead.created_at ||
    lead.dataEntrada ||
    lead.entradaEm ||
    lead.updatedAt ||
    lead.statusDashboardAtualizadoEm ||
    null;

  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function getLeadStatusForKpi(lead = {}) {
  return (
    lead.statusDashboard ||
    lead.statusVisualDashboard ||
    lead.status ||
    lead.faseQualificacao ||
    lead.faseFunil ||
    "indefinido"
  );
}

function leadIsQualifiedForKpi(lead = {}) {
  const status = getLeadStatusForKpi(lead);
  const faseFunil = lead.faseFunil || "";
  const faseQualificacao = lead.faseQualificacao || "";
  const temperatura = lead.temperaturaComercial || "";

  return Boolean(
    [
      "morno",
      "qualificando",
      "pre_analise",
      "quente",
      "em_atendimento",
      "fechado",
      "dados_confirmados",
      "enviado_crm"
    ].includes(status) ||
    [
      "beneficios",
      "estoque",
      "responsabilidades",
      "investimento",
      "compromisso",
      "coleta_dados",
      "confirmacao_dados",
      "pre_analise",
      "crm"
    ].includes(faseFunil) ||
    [
      "morno",
      "qualificando",
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "dados_confirmados",
      "em_atendimento",
      "enviado_crm"
    ].includes(faseQualificacao) ||
    ["morno", "quente"].includes(temperatura) ||
    lead.interesseReal === true
  );
}

function leadHadTaxPresentedForKpi(lead = {}) {
  const etapas = lead.etapas || {};

  return Boolean(
    etapas.investimento === true ||
    etapas.taxaPerguntada === true ||
    lead.taxaAlinhada === true ||
    lead.taxaApresentada === true ||
    lead.taxaApresentadaEm ||
    Number(lead.taxaObjectionCount || 0) > 0
  );
}

function leadHadTaxObjectionForKpi(lead = {}) {
  return Boolean(
    Number(lead.taxaObjectionCount || 0) > 0 ||
    lead.sinalObjecaoTaxa === true ||
    lead.taxaModoConversao === true
  );
}

function leadStartedPreAnalysisForKpi(lead = {}) {
  const faseFunil = lead.faseFunil || "";
  const faseQualificacao = lead.faseQualificacao || "";

  return Boolean(
    ["coleta_dados", "confirmacao_dados", "pre_analise", "crm"].includes(faseFunil) ||
    [
      "coletando_dados",
      "dados_parciais",
      "aguardando_dados",
      "aguardando_confirmacao_campo",
      "aguardando_confirmacao_dados",
      "dados_confirmados",
      "enviado_crm"
    ].includes(faseQualificacao) ||
    lead.campoEsperado ||
    lead.campoPendente ||
    lead.dadosConfirmadosPeloLead === true ||
    lead.crmEnviado === true
  );
}

function leadHasCompleteDataForKpi(lead = {}) {
  return Boolean(
    lead.dadosConfirmadosPeloLead === true ||
    (
      lead.nome &&
      lead.cpf &&
      (lead.telefone || lead.telefoneWhatsApp || lead.user) &&
      lead.cidade &&
      lead.estado
    )
  );
}

function leadRecoveredByAffiliateForKpi(lead = {}) {
  return Boolean(
    lead.rotaComercial === "afiliado" ||
    lead.faseFunil === "afiliado" ||
    lead.faseQualificacao === "afiliado" ||
    lead.status === "afiliado" ||
    lead.interesseAfiliado === true ||
    lead.afiliadoOferecidoComoAlternativa === true ||
    lead.afiliadoInstrucoesEnviadas === true
  );
}

function buildKpiMetricsForCLevel(leads = []) {
  const safeLeads = Array.isArray(leads) ? leads : [];

  const total = safeLeads.length;

  const qualificados = safeLeads.filter(leadIsQualifiedForKpi).length;
  const taxaApresentada = safeLeads.filter(leadHadTaxPresentedForKpi).length;
  const objecaoTaxa = safeLeads.filter(leadHadTaxObjectionForKpi).length;

  const recuperadosPosObjecao = safeLeads.filter(lead => {
    return leadHadTaxObjectionForKpi(lead) && (
      leadStartedPreAnalysisForKpi(lead) ||
      leadHasCompleteDataForKpi(lead) ||
      lead.status === "em_atendimento" ||
      lead.statusOperacional === "em_atendimento" ||
      lead.status === "fechado" ||
      lead.crmEnviado === true
    );
  }).length;

  const preAnaliseIniciada = safeLeads.filter(leadStartedPreAnalysisForKpi).length;
  const dadosCompletos = safeLeads.filter(leadHasCompleteDataForKpi).length;

  const baseRecuperacaoAfiliados = safeLeads.filter(lead => {
    return Boolean(
      leadHadTaxObjectionForKpi(lead) ||
      lead.status === "perdido" ||
      lead.faseFunil === "encerrado" ||
      lead.deveOferecerAfiliadoComoAlternativa === true ||
      lead.afiliadoOferecidoComoAlternativa === true ||
      lead.delayOrAbandonment === true
    );
  }).length;

  const recuperadosAfiliados = safeLeads.filter(leadRecoveredByAffiliateForKpi).length;

  const statusAtual = safeLeads.reduce((acc, lead) => {
    const status = getLeadStatusForKpi(lead);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  return {
    total,
    qualificados,
    taxaApresentada,
    objecaoTaxa,
    recuperadosPosObjecao,
    preAnaliseIniciada,
    dadosCompletos,
    recuperadosAfiliados,
    baseRecuperacaoAfiliados,
    percentuais: {
      qualificados: safePercentNumber(qualificados, total),
      taxaApresentada: safePercentNumber(taxaApresentada, total),
      objecaoTaxa: safePercentNumber(objecaoTaxa, taxaApresentada),
      recuperacaoPosObjecao: safePercentNumber(recuperadosPosObjecao, objecaoTaxa),
      preAnaliseIniciada: safePercentNumber(preAnaliseIniciada, total),
      dadosCompletos: safePercentNumber(dadosCompletos, total),
      recuperadosAfiliados: safePercentNumber(recuperadosAfiliados, baseRecuperacaoAfiliados)
    },
    statusAtual
  };
}

function buildCLevelDashboardSnapshot(allLeads = []) {
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const leadsHoje = allLeads.filter(lead => {
    const date = getLeadDateForKpi(lead);
    return date && date.getTime() >= startOfToday.getTime();
  });

  const leadsUltimos7Dias = allLeads.filter(lead => {
    const date = getLeadDateForKpi(lead);
    return date && date.getTime() >= sevenDaysAgo.getTime();
  });

  return {
    geradoEm: now.toISOString(),
    periodoPrincipal: "ultimos_7_dias",
    observacao:
      "KPIs calculados a partir dos leads existentes no Mongo. Para análise de tráfego, use principalmente a janela dos últimos 7 dias.",
    todosOsLeads: buildKpiMetricsForCLevel(allLeads),
    hoje: buildKpiMetricsForCLevel(leadsHoje),
    ultimos7Dias: buildKpiMetricsForCLevel(leadsUltimos7Dias)
  };
}

const MULTI_C_LEVEL_SYSTEM_PROMPT = `
Você é o Multi C-Level GPT da IQG.

Atue como um comitê consultivo formado por:
- CGO: Chief Growth Officer;
- CRO: Chief Revenue Officer;
- especialista em KPIs;
- especialista em Revenue Operations;
- especialista em Growth Analytics;
- especialista em tráfego pago;
- especialista em funil comercial com SDR IA no WhatsApp.

Você analisa KPIs reais do dashboard da IQG.

Contexto da IQG:
- O funil principal é o Programa Parceiro Homologado IQG.
- O lead vem de tráfego pago.
- A SDR IA conversa no WhatsApp.
- A fase da taxa é um gargalo importante.
- O Programa de Afiliados IQG é rota alternativa para recuperar leads que não seguem no Homologado.
- O objetivo do dashboard é avaliar qualidade do tráfego, qualidade da SDR IA, gargalos de conversão e oportunidade de escala.

Você NÃO pode:
- inventar números;
- alterar leads;
- mandar WhatsApp;
- enviar CRM;
- prometer resultados;
- dizer que uma campanha está boa ou ruim sem base nos KPIs recebidos;
- fingir certeza quando a amostra for pequena.

Se a amostra for pequena, diga claramente que a leitura ainda é inicial.

Responda SEMPRE em JSON válido, sem markdown e sem texto fora do JSON.

Formato obrigatório:

{
  "tituloDiagnostico": "",
  "resumoExecutivo": "",
  "qualidadeTrafego": {
    "status": "boa | atencao | critica | inconclusiva",
    "analise": ""
  },
  "saudeFunil": {
    "status": "boa | atencao | critica | inconclusiva",
    "analise": ""
  },
  "indicadoresBons": [],
  "indicadoresAtencao": [],
  "gargaloPrincipal": "",
  "possiveisCausas": [],
  "estrategiaMelhoria": [],
  "planoProximos7Dias": [],
  "prioridadeExecutiva": "baixa | media | alta | critica",
  "observacaoSobreAmostra": ""
}

Como responder:
- Seja consultivo, direto e executivo.
- Explique o que os indicadores significam.
- Separe tráfego ruim de problema de atendimento quando possível.
- Analise especialmente:
  1. leads dos últimos 7 dias;
  2. qualificados;
  3. taxa apresentada;
  4. objeção à taxa;
  5. recuperação pós-objeção;
  6. pré-análise iniciada;
  7. dados completos;
  8. recuperação por Afiliados.
- Se houver poucos leads, não conclua com certeza. Fale em tendência inicial.
- Sempre entregue estratégia prática.
`;

function buildDefaultCLevelAnalysis() {
  return {
    tituloDiagnostico: "Análise indisponível",
    resumoExecutivo:
      "Não foi possível gerar a análise neste momento. Tente novamente em instantes.",
    qualidadeTrafego: {
      status: "inconclusiva",
      analise: "Sem análise disponível."
    },
    saudeFunil: {
      status: "inconclusiva",
      analise: "Sem análise disponível."
    },
    indicadoresBons: [],
    indicadoresAtencao: [],
    gargaloPrincipal: "",
    possiveisCausas: [],
    estrategiaMelhoria: [],
    planoProximos7Dias: [],
    prioridadeExecutiva: "media",
    observacaoSobreAmostra: ""
  };
}

function parseCLevelAnalysisJson(rawText = "") {
  const fallback = buildDefaultCLevelAnalysis();

  try {
    const parsed = JSON.parse(rawText);

    return {
      ...fallback,
      ...parsed,
      qualidadeTrafego: {
        ...fallback.qualidadeTrafego,
        ...(parsed.qualidadeTrafego || {})
      },
      saudeFunil: {
        ...fallback.saudeFunil,
        ...(parsed.saudeFunil || {})
      },
      indicadoresBons: Array.isArray(parsed.indicadoresBons) ? parsed.indicadoresBons : [],
      indicadoresAtencao: Array.isArray(parsed.indicadoresAtencao) ? parsed.indicadoresAtencao : [],
      possiveisCausas: Array.isArray(parsed.possiveisCausas) ? parsed.possiveisCausas : [],
      estrategiaMelhoria: Array.isArray(parsed.estrategiaMelhoria) ? parsed.estrategiaMelhoria : [],
      planoProximos7Dias: Array.isArray(parsed.planoProximos7Dias) ? parsed.planoProximos7Dias : []
    };
  } catch (error) {
    try {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");

      if (start === -1 || end === -1 || end <= start) {
        return fallback;
      }

      const parsed = JSON.parse(rawText.slice(start, end + 1));

      return {
        ...fallback,
        ...parsed,
        qualidadeTrafego: {
          ...fallback.qualidadeTrafego,
          ...(parsed.qualidadeTrafego || {})
        },
        saudeFunil: {
          ...fallback.saudeFunil,
          ...(parsed.saudeFunil || {})
        },
        indicadoresBons: Array.isArray(parsed.indicadoresBons) ? parsed.indicadoresBons : [],
        indicadoresAtencao: Array.isArray(parsed.indicadoresAtencao) ? parsed.indicadoresAtencao : [],
        possiveisCausas: Array.isArray(parsed.possiveisCausas) ? parsed.possiveisCausas : [],
        estrategiaMelhoria: Array.isArray(parsed.estrategiaMelhoria) ? parsed.estrategiaMelhoria : [],
        planoProximos7Dias: Array.isArray(parsed.planoProximos7Dias) ? parsed.planoProximos7Dias : []
      };
    } catch (secondError) {
      return fallback;
    }
  }
}

async function runMultiCLevelDashboardAnalysis({
  pergunta = "",
  kpiSnapshot = {}
} = {}) {
  const payload = {
    perguntaDoGestor: pergunta,
    kpisDashboard: kpiSnapshot
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_CLEVEL_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: MULTI_C_LEVEL_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ]
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Erro ao chamar Multi C-Level GPT:", data);
    return {
      ...buildDefaultCLevelAnalysis(),
      resumoExecutivo:
        "Falha ao chamar o Multi C-Level GPT. Verifique a chave da OpenAI e tente novamente."
    };
  }

  const rawText = data.choices?.[0]?.message?.content || "{}";

  return parseCLevelAnalysisJson(rawText);
}

app.post("/dashboard/c-level-consultor", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    const pergunta = String(req.body?.pergunta || "").trim();

    if (!pergunta || pergunta.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "Digite uma pergunta um pouco mais completa para o Multi C-Level GPT."
      });
    }

    await connectMongo();

    const allLeads = await db.collection("leads").find({}).toArray();
    const kpiSnapshot = buildCLevelDashboardSnapshot(allLeads);

    const analysis = await runMultiCLevelDashboardAnalysis({
      pergunta,
      kpiSnapshot
    });

    return res.json({
      ok: true,
      analysis,
      kpiSnapshot
    });
  } catch (error) {
    console.error("Erro na rota Multi C-Level GPT:", error);

    return res.status(500).json({
      ok: false,
      error: "Erro ao gerar análise do Multi C-Level GPT."
    });
  }
});

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

    const user = decodeURIComponent(req.params.user || "");

    const conversation = await db.collection("conversations").findOne({ user });
    const lead = await db.collection("leads").findOne({ user });

    const messages = Array.isArray(conversation?.messages)
      ? conversation.messages
      : [];

    const senhaQuery = req.query.senha
      ? `?senha=${encodeURIComponent(req.query.senha)}`
      : "";

    const rows = messages.map((msg, index) => {
      const role =
        msg.role === "user"
          ? "Lead"
          : msg.role === "assistant"
            ? "SDR IA"
            : "Sistema";

      const cssClass =
        msg.role === "user"
          ? "user"
          : msg.role === "assistant"
            ? "assistant"
            : "system";

      const when = msg.createdAt || msg.timestamp || msg.date || "";

      return `
        <div class="message ${cssClass}">
          <div class="role">
            #${index + 1} — ${escapeHtml(role)}
            ${msg.origem === "followup_automatico" ? " · Follow-up automático" : ""}
          </div>
          ${when ? `<div class="date">${escapeHtml(formatDate(when))}</div>` : ""}
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
            max-width: 980px;
            margin: 0 auto;
            padding: 24px;
          }

          .topbar {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
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

          .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 10px;
          }

          .summary-item {
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            padding: 10px;
          }

          .summary-item small {
            display: block;
            color: #6b7280;
            margin-bottom: 4px;
          }

          .message {
            max-width: 78%;
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

          .message.system {
            background: #fef3c7;
            margin-right: auto;
          }

          .role {
            font-size: 12px;
            font-weight: bold;
            color: #374151;
            margin-bottom: 4px;
          }

          .date {
            font-size: 11px;
            color: #6b7280;
            margin-bottom: 6px;
          }

          .content {
            font-size: 15px;
            white-space: normal;
          }

          .empty {
            color: #6b7280;
            font-style: italic;
          }

          @media (max-width: 800px) {
            .summary-grid {
              grid-template-columns: repeat(2, minmax(0, 1fr));
            }

            .message {
              max-width: 95%;
            }
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
            <a class="btn" href="/lead/${encodeURIComponent(user)}/dados-adicionais${senhaQuery}">Dados Adicionais</a>
          </div>

          <div class="card">
            <div class="summary-grid">
              <div class="summary-item">
                <small>Total de mensagens salvas</small>
                <strong>${messages.length}</strong>
              </div>

              <div class="summary-item">
                <small>Telefone</small>
                <strong>${escapeHtml(lead?.telefone || lead?.telefoneWhatsApp || user || "-")}</strong>
              </div>

              <div class="summary-item">
                <small>CPF</small>
                <strong>${escapeHtml(lead?.cpf || "-")}</strong>
              </div>

              <div class="summary-item">
                <small>Cidade/Estado</small>
                <strong>${escapeHtml(lead?.cidade || "-")}/${escapeHtml(lead?.estado || "-")}</strong>
              </div>
            </div>
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

function getLastConversationMessageByRole(history = [], role = "") {
  if (!Array.isArray(history)) return null;

  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]?.role === role) {
      return history[index];
    }
  }

  return null;
}

function getConversationTextForBriefing(history = []) {
  const safeHistory = Array.isArray(history) ? history : [];

  /*
    Evita mandar conversa infinita para o GPT.
    Para o humano, o resumo considera até as últimas 180 mensagens salvas.
    O histórico bruto completo fica no botão "Mensagem".
  */
  return safeHistory
    .slice(-180)
    .map((message, index) => {
      const role =
        message.role === "user"
          ? "Lead"
          : message.role === "assistant"
            ? "SDR IA"
            : "Sistema";

      return `${index + 1}. ${role}: ${message.content || ""}`;
    })
    .join("\n");
}

function buildFallbackHumanBriefing({ lead = {}, history = [] } = {}) {
  const lastUser = getLastConversationMessageByRole(history, "user");
  const lastAssistant = getLastConversationMessageByRole(history, "assistant");

  return {
    resumoExecutivo:
      "Resumo automático local. Não foi possível gerar briefing completo pelo GPT neste momento.",
    situacaoAtual:
      `Status: ${lead?.status || "-"} | Funil: ${lead?.faseFunil || "-"} | Temperatura: ${lead?.temperaturaComercial || "-"}`,
    rotaComercial:
      lead?.rotaComercial || lead?.origemConversao || "-",
    etapaAtual:
      lead?.faseFunil || lead?.faseQualificacao || "-",
    oQueJaFoiFalado: [],
    objecoesIdentificadas: [],
    duvidasPendentes: [],
    pontosSensiveis: [],
    dadosColetados: {
      nome: lead?.nome || "",
      cpf: lead?.cpf || "",
      telefone: lead?.telefone || lead?.telefoneWhatsApp || "",
      cidade: lead?.cidade || "",
      estado: lead?.estado || ""
    },
    riscosParaHumano: [],
    proximaMelhorAcaoHumano:
      "Abrir a conversa completa se precisar de contexto detalhado antes de atender.",
    tomRecomendado:
      "Tom consultivo, objetivo e sem repetir assuntos já tratados.",
    ultimaMensagemLead: lastUser?.content || "",
    ultimaRespostaSdr: lastAssistant?.content || "",
    atualizadoEm: new Date()
  };
}

function parseHumanBriefingJson(rawText = "", fallback = {}) {
  try {
    const parsed = JSON.parse(rawText);

    return {
      ...fallback,
      ...parsed,
      atualizadoEm: new Date()
    };
  } catch (error) {
    try {
      const start = rawText.indexOf("{");
      const end = rawText.lastIndexOf("}");

      if (start === -1 || end === -1 || end <= start) {
        return fallback;
      }

      const jsonText = rawText.slice(start, end + 1);
      const parsed = JSON.parse(jsonText);

      return {
        ...fallback,
        ...parsed,
        atualizadoEm: new Date()
      };
    } catch (secondError) {
      return fallback;
    }
  }
}

async function generateHumanLeadBriefing({
  lead = {},
  history = []
} = {}) {
  const fallback = buildFallbackHumanBriefing({ lead, history });

  try {
    const historyText = getConversationTextForBriefing(history);

    const payload = {
      lead: {
        nome: lead?.nome || "",
        telefone: lead?.telefone || lead?.telefoneWhatsApp || lead?.user || "",
        cpf: lead?.cpf || "",
        cidade: lead?.cidade || "",
        estado: lead?.estado || "",
        status: lead?.status || "",
        faseQualificacao: lead?.faseQualificacao || "",
        statusOperacional: lead?.statusOperacional || "",
        faseFunil: lead?.faseFunil || "",
        temperaturaComercial: lead?.temperaturaComercial || "",
        rotaComercial: lead?.rotaComercial || lead?.origemConversao || "",
        interesseReal: lead?.interesseReal === true,
        interesseAfiliado: lead?.interesseAfiliado === true,
        taxaAlinhada: lead?.taxaAlinhada === true,
        taxaObjectionCount: Number(lead?.taxaObjectionCount || 0),
        dadosConfirmadosPeloLead: lead?.dadosConfirmadosPeloLead === true,
        crmEnviado: lead?.crmEnviado === true,
        humanoAssumiu: lead?.humanoAssumiu === true,
        atendimentoHumanoAtivo: lead?.atendimentoHumanoAtivo === true,
        etapas: lead?.etapas || {},
        ultimaMensagem: lead?.ultimaMensagem || ""
      },
      supervisor: lead?.supervisor || {},
      classificacao: lead?.classificacao || {},
      consultoria: lead?.consultoria || {},
      totalMensagensSalvas: Array.isArray(history) ? history.length : 0,
      historicoConsiderado: historyText
    };

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Você é o Analista de Briefing Comercial Humano da IQG.

Você NÃO conversa com o lead.
Você NÃO altera status.
Você NÃO envia CRM.
Você NÃO decide pagamento.
Você cria um resumo executivo para um SDR humano assumir o atendimento rapidamente.

Objetivo:
O humano deve bater o olho e entender:
- quem é o lead;
- o que ele quer;
- qual caminho comercial está mais provável;
- o que a SDR IA já explicou;
- quais objeções apareceram;
- quais dúvidas ficaram;
- quais riscos existem;
- qual o melhor próximo passo;
- qual tom usar na abordagem.

Regras:
1. Seja objetivo, mas completo.
2. Não invente fatos.
3. Diferencie objeção real de simples dúvida.
4. Diferencie Homologado, Afiliado e Ambos.
5. Destaque taxa, estoque, comodato, contrato, garantia, desconfiança e dados coletados quando aparecerem.
6. Informe se o lead aceitou seguir, recusou, esfriou, pediu humano ou está em coleta.
7. Se houver erro da SDR, repetição ou confusão, cite com cuidado como "atenção na condução".
8. Não exponha termos internos como "GPT", "prompt", "backend", "classificador" ou "historiador" no texto final.

Retorne somente JSON válido neste formato:

{
  "resumoExecutivo": "",
  "situacaoAtual": "",
  "rotaComercial": "",
  "etapaAtual": "",
  "oQueJaFoiFalado": [],
  "objecoesIdentificadas": [],
  "duvidasPendentes": [],
  "pontosSensiveis": [],
  "dadosColetados": {
    "nome": "",
    "cpf": "",
    "telefone": "",
    "cidade": "",
    "estado": ""
  },
  "riscosParaHumano": [],
  "proximaMelhorAcaoHumano": "",
  "tomRecomendado": "",
  "ultimaMensagemLead": "",
  "ultimaRespostaSdr": ""
}
`
          },
          {
            role: "user",
            content: JSON.stringify(payload)
          }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Erro ao gerar briefing humano:", data);
      return fallback;
    }

    const rawText = data.choices?.[0]?.message?.content || "{}";

    return parseHumanBriefingJson(rawText, fallback);
  } catch (error) {
    console.error("Falha ao gerar briefing humano:", error.message);
    return fallback;
  }
}

function shouldRefreshHumanBriefing(lead = {}, conversationDoc = {}) {
  const briefing = lead?.resumoAtendimentoHumano || null;

  if (!briefing) return true;

  const briefingAt = briefing?.atualizadoEm
    ? new Date(briefing.atualizadoEm).getTime()
    : 0;

  const conversationUpdatedAt = conversationDoc?.updatedAt
    ? new Date(conversationDoc.updatedAt).getTime()
    : 0;

  if (!briefingAt) return true;

  return conversationUpdatedAt > briefingAt;
}

function renderBriefingList(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="empty">Nenhum ponto registrado.</p>`;
  }

  return `
    <ul>
      ${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
  `;
}

app.get("/lead/:user/dados-adicionais", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    await connectMongo();

    const user = decodeURIComponent(req.params.user || "");
    const senhaQuery = req.query.senha
      ? `?senha=${encodeURIComponent(req.query.senha)}`
      : "";

    let lead = await db.collection("leads").findOne({ user });
    const conversationDoc = await db.collection("conversations").findOne({ user });

    const history = Array.isArray(conversationDoc?.messages)
      ? conversationDoc.messages
      : [];

    if (!lead) {
      return res.status(404).send("Lead não encontrado.");
    }

    let briefing = lead?.resumoAtendimentoHumano || null;

    if (shouldRefreshHumanBriefing(lead, conversationDoc)) {
      briefing = await generateHumanLeadBriefing({
        lead,
        history
      });

      await saveLeadProfile(user, {
        resumoAtendimentoHumano: briefing
      });

      lead = await loadLeadProfile(user);
    }

    const dados = briefing?.dadosColetados || {};

    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="refresh" content="10" />
        <title>Dados Adicionais — ${escapeHtml(lead?.nome || user)}</title>

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
            max-width: 1100px;
            margin: 0 auto;
            padding: 24px;
          }

          .topbar {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
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

          .btn.whatsapp {
            background: #16a34a;
          }

          .btn.info {
            background: #2563eb;
          }

          .card {
            background: white;
            border-radius: 12px;
            padding: 18px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06);
            margin-bottom: 18px;
          }

          .grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
          }

          .info {
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            padding: 12px;
          }

          .info small {
            display: block;
            color: #6b7280;
            font-size: 12px;
            margin-bottom: 4px;
          }

          .info strong {
            font-size: 15px;
          }

          .briefing-main {
            border-left: 5px solid #2563eb;
          }

          h2 {
            margin-top: 0;
          }

          h3 {
            margin-bottom: 8px;
          }

          ul {
            margin-top: 8px;
            padding-left: 20px;
          }

          li {
            margin-bottom: 6px;
          }

          .empty {
            color: #6b7280;
            font-style: italic;
          }

          .highlight {
            background: #eff6ff;
            border: 1px solid #bfdbfe;
            border-radius: 10px;
            padding: 14px;
            line-height: 1.5;
          }

          .warning {
            background: #fff7ed;
            border: 1px solid #fed7aa;
            border-radius: 10px;
            padding: 14px;
          }

          @media (max-width: 900px) {
            .grid {
              grid-template-columns: repeat(2, minmax(0, 1fr));
            }
          }
        </style>
      </head>

      <body>
        <header>
          <h1>Dados Adicionais</h1>
          <p>${escapeHtml(lead?.nome || "-")} — ${escapeHtml(user)}</p>
        </header>

        <div class="container">
          <div class="topbar">
            <a class="btn" href="/dashboard${senhaQuery}">← Voltar ao Dashboard</a>
            <a class="btn info" href="/conversation/${encodeURIComponent(user)}${senhaQuery}">Ver conversa completa</a>
            <a class="btn whatsapp" href="https://wa.me/${escapeHtml(lead?.telefoneWhatsApp || lead?.telefone || lead?.user || user)}" target="_blank">WhatsApp</a>
          </div>

          <div class="card">
            <div class="grid">
              <div class="info">
                <small>Status</small>
                <strong>${escapeHtml(lead?.statusDashboard || lead?.statusVisualDashboard || lead?.status || "-")}</strong>
              </div>

              <div class="info">
                <small>Funil</small>
                <strong>${escapeHtml(lead?.faseFunil || "-")}</strong>
              </div>

              <div class="info">
                <small>Temperatura</small>
                <strong>${escapeHtml(lead?.temperaturaComercial || "-")}</strong>
              </div>

              <div class="info">
                <small>Rota</small>
                <strong>${escapeHtml(lead?.rotaComercial || lead?.origemConversao || "-")}</strong>
              </div>

              <div class="info">
                <small>Total mensagens salvas</small>
                <strong>${history.length}</strong>
              </div>

              <div class="info">
                <small>Atualizado</small>
                <strong>${formatDate(lead?.updatedAt)}</strong>
              </div>

              <div class="info">
                <small>Resumo atualizado</small>
                <strong>${formatDate(briefing?.atualizadoEm)}</strong>
              </div>

              <div class="info">
                <small>Humano</small>
                <strong>${lead?.humanoAssumiu || lead?.atendimentoHumanoAtivo || lead?.botBloqueadoPorHumano ? "Sim" : "Não"}</strong>
              </div>
            </div>
          </div>

          <div class="card briefing-main">
            <h2>Resumo Executivo para SDR Humano</h2>
            <div class="highlight">
              ${escapeHtml(briefing?.resumoExecutivo || "Resumo ainda não gerado.")}
            </div>
          </div>

          <div class="card">
            <h2>Situação Atual</h2>
            <p><strong>Etapa atual:</strong> ${escapeHtml(briefing?.etapaAtual || "-")}</p>
            <p><strong>Rota comercial:</strong> ${escapeHtml(briefing?.rotaComercial || "-")}</p>
            <p><strong>Situação:</strong> ${escapeHtml(briefing?.situacaoAtual || "-")}</p>
          </div>

          <div class="card">
            <h2>O que já foi falado</h2>
            ${renderBriefingList(briefing?.oQueJaFoiFalado || [])}
          </div>

          <div class="card">
            <h2>Objeções identificadas</h2>
            ${renderBriefingList(briefing?.objecoesIdentificadas || [])}
          </div>

          <div class="card">
            <h2>Dúvidas pendentes</h2>
            ${renderBriefingList(briefing?.duvidasPendentes || [])}
          </div>

          <div class="card warning">
            <h2>Pontos sensíveis / cuidados</h2>
            ${renderBriefingList(briefing?.pontosSensiveis || [])}
          </div>

          <div class="card">
            <h2>Dados coletados</h2>
            <div class="grid">
              <div class="info">
                <small>Nome</small>
                <strong>${escapeHtml(dados?.nome || lead?.nome || "-")}</strong>
              </div>

              <div class="info">
                <small>CPF</small>
                <strong>${escapeHtml(dados?.cpf || lead?.cpf || "-")}</strong>
              </div>

              <div class="info">
                <small>Telefone</small>
                <strong>${escapeHtml(dados?.telefone || lead?.telefone || lead?.telefoneWhatsApp || user || "-")}</strong>
              </div>

              <div class="info">
                <small>Cidade/Estado</small>
                <strong>${escapeHtml(dados?.cidade || lead?.cidade || "-")}/${escapeHtml(dados?.estado || lead?.estado || "-")}</strong>
              </div>
            </div>
          </div>

          <div class="card">
            <h2>Riscos para o humano observar</h2>
            ${renderBriefingList(briefing?.riscosParaHumano || [])}
          </div>

          <div class="card">
            <h2>Próxima Melhor Ação</h2>
            <div class="highlight">
              ${escapeHtml(briefing?.proximaMelhorAcaoHumano || "-")}
            </div>
          </div>

          <div class="card">
            <h2>Tom recomendado</h2>
            <p>${escapeHtml(briefing?.tomRecomendado || "-")}</p>
          </div>

          <div class="card">
            <h2>Últimas mensagens</h2>
            <p><strong>Última mensagem do lead:</strong><br>${escapeHtml(briefing?.ultimaMensagemLead || "-")}</p>
            <p><strong>Última resposta da SDR IA:</strong><br>${escapeHtml(briefing?.ultimaRespostaSdr || "-")}</p>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Erro ao carregar dados adicionais:", error);
    res.status(500).send("Erro ao carregar dados adicionais.");
  }
});
   app.get("/dashboard", async (req, res) => {
  try {
    if (!requireDashboardAuth(req, res)) return;

    await connectMongo();

       const search = req.query.q || "";
const cidadeFilter = req.query.cidade || "";
const estadoFilter = req.query.estado || "";
const humanoFilter = req.query.humano || "";
const sort = req.query.sort || "updatedAt";
const dir = req.query.dir === "asc" ? 1 : -1;

   const queryConditions = [];

if (cidadeFilter) {
  queryConditions.push({
    $or: [
      { cidade: { $regex: cidadeFilter, $options: "i" } },
      { cidadeEstado: { $regex: cidadeFilter, $options: "i" } }
    ]
  });
}

if (estadoFilter) {
  queryConditions.push({
    estado: { $regex: `^${estadoFilter}$`, $options: "i" }
  });
}

if (humanoFilter === "sim") {
  queryConditions.push({
    $or: [
      { humanoAssumiu: true },
      { atendimentoHumanoAtivo: true },
      { botBloqueadoPorHumano: true },
      { statusOperacional: "em_atendimento" },
      { status: "em_atendimento" },
      { faseQualificacao: "em_atendimento" }
    ]
  });
}

if (humanoFilter === "nao") {
  queryConditions.push({
    $and: [
      { humanoAssumiu: { $ne: true } },
      { atendimentoHumanoAtivo: { $ne: true } },
      { botBloqueadoPorHumano: { $ne: true } },
      { statusOperacional: { $ne: "em_atendimento" } },
      { status: { $ne: "em_atendimento" } },
      { faseQualificacao: { $ne: "em_atendimento" } }
    ]
  });
}

if (search) {
  queryConditions.push({
    $or: [
      { user: { $regex: search, $options: "i" } },
      { telefoneWhatsApp: { $regex: search, $options: "i" } },
      { telefone: { $regex: search, $options: "i" } },
      { cpf: { $regex: search, $options: "i" } },
      { nome: { $regex: search, $options: "i" } },
      { cidade: { $regex: search, $options: "i" } },
      { estado: { $regex: search, $options: "i" } },
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
  nome: "nome",
  telefone: "telefoneWhatsApp",
  cpf: "cpf",
  cidade: "cidade",
  estado: "estado",
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

const novo = countByStatus("novo");
const morno = countByStatus("morno");
const qualificando = countByStatus("qualificando");
const preAnalise = countByStatus("pre_analise");
const quente = countByStatus("quente");
const atendimento = countByStatus("em_atendimento");
const fechado = countByStatus("fechado");
const perdido = countByStatus("perdido");

const now = new Date();

const startOfToday = new Date(now);
startOfToday.setHours(0, 0, 0, 0);

const sevenDaysAgo = new Date(now);
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

const toDateMs = value => {
  if (!value) return 0;

  const date = new Date(value);
  const ms = date.getTime();

  return Number.isFinite(ms) ? ms : 0;
};

const isAfterDate = (value, date) => {
  const ms = toDateMs(value);
  return ms && ms >= date.getTime();
};

const pct = (part, base) => {
  if (!base || base <= 0) return "0%";
  return `${((Number(part || 0) / Number(base || 0)) * 100).toFixed(1).replace(".", ",")}%`;
};

const numberBr = value => {
  return Number(value || 0).toLocaleString("pt-BR");
};

const leadCreatedAt = lead => lead.createdAt || lead.created_at || lead.dataEntrada || lead.updatedAt;

const leadsHoje = allLeads.filter(lead => isAfterDate(leadCreatedAt(lead), startOfToday)).length;
const leadsUltimos7Dias = allLeads.filter(lead => isAfterDate(leadCreatedAt(lead), sevenDaysAgo)).length;

const isQualifiedLead = lead => {
  const status = getVisualStatus(lead);
  const faseFunil = lead?.faseFunil || "";
  const faseQualificacao = lead?.faseQualificacao || "";
  const temperatura = lead?.temperaturaComercial || "";

  return Boolean(
    ["morno", "qualificando", "pre_analise", "quente", "em_atendimento", "fechado"].includes(status) ||
    ["beneficios", "estoque", "responsabilidades", "investimento", "compromisso", "coleta_dados", "pre_analise", "crm"].includes(faseFunil) ||
    ["morno", "qualificando", "coletando_dados", "dados_parciais", "dados_confirmados", "em_atendimento", "enviado_crm"].includes(faseQualificacao) ||
    ["morno", "quente"].includes(temperatura) ||
    lead?.interesseReal === true
  );
};

const hasTaxPresented = lead => {
  const etapas = lead?.etapas || {};

  return Boolean(
    etapas.investimento === true ||
    etapas.taxaPerguntada === true ||
    lead?.taxaAlinhada === true ||
    lead?.taxaApresentada === true ||
    lead?.taxaApresentadaEm ||
    Number(lead?.taxaObjectionCount || 0) > 0
  );
};

const hasTaxObjection = lead => {
  return Boolean(
    Number(lead?.taxaObjectionCount || 0) > 0 ||
    lead?.sinalObjecaoTaxa === true ||
    lead?.taxaModoConversao === true
  );
};

const startedPreAnalysis = lead => {
  const faseFunil = lead?.faseFunil || "";
  const faseQualificacao = lead?.faseQualificacao || "";

  return Boolean(
    ["coleta_dados", "confirmacao_dados", "pre_analise", "crm"].includes(faseFunil) ||
    ["coletando_dados", "dados_parciais", "aguardando_dados", "aguardando_confirmacao_campo", "aguardando_confirmacao_dados", "dados_confirmados", "enviado_crm"].includes(faseQualificacao) ||
    lead?.campoEsperado ||
    lead?.dadosConfirmadosPeloLead === true ||
    lead?.crmEnviado === true
  );
};

const hasCompleteLeadData = lead => {
  return Boolean(
    lead?.dadosConfirmadosPeloLead === true ||
    (
      lead?.nome &&
      lead?.cpf &&
      (lead?.telefone || lead?.telefoneWhatsApp || lead?.user) &&
      lead?.cidade &&
      lead?.estado
    )
  );
};

const recoveredByAffiliate = lead => {
  return Boolean(
    lead?.rotaComercial === "afiliado" ||
    lead?.faseFunil === "afiliado" ||
    lead?.faseQualificacao === "afiliado" ||
    lead?.status === "afiliado" ||
    lead?.interesseAfiliado === true ||
    lead?.afiliadoOferecidoComoAlternativa === true ||
    lead?.afiliadoInstrucoesEnviadas === true
  );
};

const qualifiedCount = allLeads.filter(isQualifiedLead).length;
const taxPresentedCount = allLeads.filter(hasTaxPresented).length;
const taxObjectionCount = allLeads.filter(hasTaxObjection).length;

const recoveredAfterObjectionCount = allLeads.filter(lead => {
  return hasTaxObjection(lead) && (
    startedPreAnalysis(lead) ||
    hasCompleteLeadData(lead) ||
    lead?.status === "em_atendimento" ||
    lead?.statusOperacional === "em_atendimento" ||
    lead?.status === "fechado" ||
    lead?.crmEnviado === true
  );
}).length;

const preAnalysisStartedCount = allLeads.filter(startedPreAnalysis).length;
const completeDataCount = allLeads.filter(hasCompleteLeadData).length;

const homologadoNotCompletedCount = allLeads.filter(lead => {
  return Boolean(
    hasTaxObjection(lead) ||
    lead?.status === "perdido" ||
    lead?.faseFunil === "encerrado" ||
    lead?.deveOferecerAfiliadoComoAlternativa === true ||
    lead?.afiliadoOferecidoComoAlternativa === true
  );
}).length;

const affiliateRecoveredCount = allLeads.filter(recoveredByAffiliate).length;

const kpiQualificados = pct(qualifiedCount, total);
const kpiTaxaApresentada = pct(taxPresentedCount, total);
const kpiObjecaoTaxa = pct(taxObjectionCount, taxPresentedCount);
const kpiRecuperacaoPosObjecao = pct(recoveredAfterObjectionCount, taxObjectionCount);
const kpiRecuperadosAfiliados = pct(affiliateRecoveredCount, homologadoNotCompletedCount);

    const senhaParam = req.query.senha ? `&senha=${encodeURIComponent(req.query.senha)}` : "";
    const senhaQuery = req.query.senha ? `?senha=${encodeURIComponent(req.query.senha)}` : "";

       const makeSortLink = (field, label) => {
      const nextDir = sort === field && req.query.dir !== "asc" ? "asc" : "desc";

     const filtrosNovos =
  `${cidadeFilter ? `&cidade=${encodeURIComponent(cidadeFilter)}` : ""}` +
  `${estadoFilter ? `&estado=${encodeURIComponent(estadoFilter)}` : ""}` +
  `${humanoFilter ? `&humano=${encodeURIComponent(humanoFilter)}` : ""}` +
  `${search ? `&q=${encodeURIComponent(search)}` : ""}` +
  `${senhaParam}`;

      return `/dashboard?sort=${field}&dir=${nextDir}${filtrosNovos}`;
    };

     const funnelCardsHtml = [
  {
    title: "Total",
    value: numberBr(total),
    subtitle: "100% do total",
    icon: "👥",
    color: "blue"
  },
  {
    title: "Novo",
    value: numberBr(novo),
    subtitle: `${pct(novo, total)} do total`,
    icon: "➕",
    color: "green"
  },
  {
    title: "Morno",
    value: numberBr(morno),
    subtitle: `${pct(morno, total)} do total`,
    icon: "🔥",
    color: "orange"
  },
  {
    title: "Qualificando",
    value: numberBr(qualificando),
    subtitle: `${pct(qualificando, total)} do total`,
    icon: "💬",
    color: "purple"
  },
  {
    title: "Pré-análise",
    value: numberBr(preAnalise),
    subtitle: `${pct(preAnalise, total)} do total`,
    icon: "📋",
    color: "cyan"
  },
  {
    title: "Quente",
    value: numberBr(quente),
    subtitle: `${pct(quente, total)} do total`,
    icon: "🎯",
    color: "red"
  },
  {
    title: "Atendimento",
    value: numberBr(atendimento),
    subtitle: `${pct(atendimento, total)} do total`,
    icon: "🎧",
    color: "blue"
  },
  {
    title: "Fechado",
    value: numberBr(fechado),
    subtitle: `${pct(fechado, total)} do total`,
    icon: "✓",
    color: "green"
  },
  {
    title: "Perdido",
    value: numberBr(perdido),
    subtitle: `${pct(perdido, total)} do total`,
    icon: "×",
    color: "gray"
  }
].map(card => `
  <div class="metric-card ${card.color}">
    <div class="metric-top">
      <span class="metric-icon">${card.icon}</span>
      <span class="metric-title">${card.title}</span>
    </div>
    <div class="metric-value">${card.value}</div>
    <div class="metric-subtitle">${card.subtitle}</div>
  </div>
`).join("");

const kpiCardsHtml = [
  {
    title: "Leads Hoje",
    value: numberBr(leadsHoje),
    description: "Novos leads recebidos hoje no sistema.",
    icon: "👥",
    color: "blue"
  },
  {
    title: "Leads 7 dias",
    value: numberBr(leadsUltimos7Dias),
    description: "Total de leads recebidos nos últimos 7 dias.",
    icon: "🗓️",
    color: "green"
  },
  {
    title: "Qualificados",
    value: kpiQualificados,
    description: "Leads que avançaram além do estágio inicial e demonstraram interesse real.",
    icon: "⭐",
    color: "orange"
  },
  {
    title: "Taxa apresentada",
    value: kpiTaxaApresentada,
    description: "Leads que chegaram até a etapa em que a taxa/investimento foi apresentada.",
    icon: "💰",
    color: "purple"
  },
  {
    title: "Objeção à taxa",
    value: kpiObjecaoTaxa,
    description: "Leads que apresentaram objeção à taxa entre os que ouviram a proposta.",
    icon: "⚠️",
    color: "red"
  },
  {
    title: "Recuperação da taxa",
    value: kpiRecuperacaoPosObjecao,
    description: "Leads que objetaram a taxa, mas avançaram depois no funil.",
    icon: "↗️",
    color: "green"
  },
  {
    title: "Pré-análise iniciada",
    value: numberBr(preAnalysisStartedCount),
    description: "Quantidade de leads que chegaram à pré-análise ou início da coleta de dados.",
    icon: "📄",
    color: "blue"
  },
  {
    title: "Dados completos",
    value: numberBr(completeDataCount),
    description: "Quantidade de leads que concluíram os dados necessários para análise.",
    icon: "📋",
    color: "cyan"
  },
  {
    title: "Recuperação Afiliados",
    value: kpiRecuperadosAfiliados,
    description: "Leads que não seguiram no Homologado, mas foram reaproveitados pelo Afiliados.",
    icon: "👥",
    color: "pink"
  }
].map(card => `
  <div class="kpi-card ${card.color}">
    <div class="kpi-header">
      <span class="kpi-icon">${card.icon}</span>
      <span class="kpi-info" title="${escapeHtml(card.description)}">ⓘ</span>
    </div>
    <div class="kpi-title">${card.title}</div>
    <div class="kpi-value">${card.value}</div>
    <div class="kpi-description">${card.description}</div>
  </div>
`).join("");

    const rows = leads.map(lead => {
  const phone = lead.telefoneWhatsApp || lead.telefone || lead.user || "";
  const waLink = phone ? `https://wa.me/${phone}` : "#";
  const { cidade, estado } = splitCidadeEstado(lead.cidadeEstado);

  const user = encodeURIComponent(lead.user || phone);
  const baseStatusLink = `/lead/${user}/status`;

  const humanoAtivo =
    lead.humanoAssumiu === true ||
    lead.atendimentoHumanoAtivo === true ||
    lead.botBloqueadoPorHumano === true ||
    lead.statusOperacional === "em_atendimento" ||
    lead.status === "em_atendimento" ||
    lead.faseQualificacao === "em_atendimento";

       const supervisorRiscoPerda =
  lead?.supervisor?.riscoPerda ||
  lead?.supervisorResumo?.riscoPerda ||
  "";

const supervisorPrioridadeHumana =
  lead?.supervisor?.prioridadeHumana ||
  lead?.supervisorResumo?.prioridadeHumana ||
  "";

const supervisorNecessitaHumano =
  lead?.supervisor?.necessitaHumano === true ||
  lead?.supervisorResumo?.necessitaHumano === true;

const precisaAtencaoHumana =
  humanoAtivo ||
  lead.necessitaAtencaoHumanaDashboard === true ||
  supervisorNecessitaHumano ||
  ["alto", "critico", "crítico"].includes(String(supervisorRiscoPerda || "").toLowerCase()) ||
  ["alta", "critica", "crítica"].includes(String(supervisorPrioridadeHumana || "").toLowerCase());

const humanoHtml = humanoAtivo
  ? `<span class="badge em_atendimento">em atendimento</span>`
  : precisaAtencaoHumana
    ? `<span class="badge danger" title="${escapeHtml(lead.motivoAtencaoHumanaDashboard || "Atenção humana recomendada")}">atenção</span>`
    : `<span class="badge ativo">não</span>`;

  return `
    <tr>
      <td>${escapeHtml(lead.nome || "-")}</td>
      <td>${escapeHtml(phone || "-")}</td>
      <td>${escapeHtml(lead.cpf || "-")}</td>
      <td>${escapeHtml(lead.cidade || cidade || "-")}</td>
      <td>${escapeHtml(lead.estado || estado || "-")}</td>
      <td>${formatDate(lead.updatedAt)}</td>
            <td>${humanoHtml}</td>
      <td class="actions">
        <a class="btn info" href="/lead/${user}/dados-adicionais${senhaQuery}">Dados Adicionais</a>
        <span class="action-divider"></span>
        <a class="btn whatsapp" href="${waLink}" target="_blank">WhatsApp</a>
        <a class="btn" href="/conversation/${user}${senhaQuery}">Mensagem</a>
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

<link rel="manifest" href="/manifest.webmanifest?senha=${encodeURIComponent(String(req.query.senha || ""))}">
<link rel="icon" href="/iqg-icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/iqg-icon.svg">

<meta name="theme-color" content="#0f172a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="CRM IQG">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">

        <style>
/* =========================================================
   DASHBOARD IQG — VISUAL MODERNO COM KPIS
   Bloco principal de estilos do dashboard.
========================================================= */

:root {
  --iqg-bg: #f6f8fb;
  --iqg-card: #ffffff;
  --iqg-border: #e6eaf0;
  --iqg-text: #12213a;
  --iqg-muted: #64748b;
  --iqg-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
  --iqg-shadow-soft: 0 4px 14px rgba(15, 23, 42, 0.06);
  --iqg-blue: #2563eb;
  --iqg-green: #16a34a;
  --iqg-orange: #f59e0b;
  --iqg-purple: #8b5cf6;
  --iqg-cyan: #0891b2;
  --iqg-red: #dc2626;
  --iqg-pink: #db2777;
  --iqg-gray: #4b5563;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Inter, Arial, sans-serif;
  background: var(--iqg-bg);
  color: var(--iqg-text);
}

/* Página principal nova */
.dashboard-page {
  max-width: 1920px;
  margin: 0 auto;
  padding: 28px 28px 40px;
}

/* Cabeçalho igual ao modelo da imagem */
.dashboard-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 28px;
}

.dashboard-title h1 {
  margin: 0;
  font-size: 34px;
  line-height: 1.1;
  font-weight: 800;
  color: #102033;
  letter-spacing: -0.03em;
}

.dashboard-title p {
  margin: 10px 0 0;
  font-size: 15px;
  color: var(--iqg-muted);
}

.dashboard-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  color: var(--iqg-muted);
  font-size: 14px;
}

.date-pill {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 11px 16px;
  background: #fff;
  border: 1px solid #dbe3ee;
  border-radius: 8px;
  box-shadow: var(--iqg-shadow-soft);
  color: #334155;
  min-width: 250px;
  justify-content: center;
}

.refresh-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #64748b;
  white-space: nowrap;
}

/* Blocos das seções */
.section-panel {
  background: rgba(255,255,255,0.72);
  border: 1px solid var(--iqg-border);
  border-radius: 10px;
  padding: 18px 16px 16px;
  margin-bottom: 16px;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.03);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 0 0 18px;
  font-size: 20px;
  font-weight: 800;
  color: #111827;
}

.section-title .section-icon {
  font-size: 22px;
  color: var(--iqg-blue);
}

/* Linha superior: status do funil */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(9, minmax(145px, 1fr));
  gap: 14px;
}

/* Linha inferior: KPIs */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(9, minmax(145px, 1fr));
  gap: 14px;
}

/* Cards principais */
.metric-card,
.kpi-card {
  background: var(--iqg-card);
  border: 1px solid var(--iqg-border);
  border-radius: 10px;
  padding: 14px 15px;
  min-height: 126px;
  box-shadow: var(--iqg-shadow-soft);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

/* Ajuste fino: cards superiores mais compactos */
.metric-card {
  min-height: 112px;
  padding: 12px 14px;
}

.metric-card .metric-top {
  gap: 8px;
  min-height: 32px;
}

.metric-card .metric-icon {
  width: 36px;
  height: 36px;
  font-size: 16px;
}

.metric-card .metric-title {
  font-size: 13px;
  line-height: 1.18;
}

.metric-card .metric-value {
  font-size: 28px;
  margin: 14px 0 8px;
}

.metric-card .metric-subtitle {
  font-size: 11.5px;
}

/* Ajuste solicitado: remover figurinhas dos cards superiores e aumentar fonte em ~10% */
.metric-card .metric-icon {
  display: none !important;
}

.metric-card .metric-top {
  gap: 0;
  min-height: 28px;
}

.metric-card .metric-title {
  font-size: 14.3px;
  line-height: 1.18;
}

.metric-card .metric-value {
  font-size: 31px;
  margin: 15px 0 9px;
}

.metric-card .metric-subtitle {
  font-size: 12.7px;
}

.metric-card:hover,
.kpi-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--iqg-shadow);
}

.metric-top {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}

.metric-icon,
.kpi-icon {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 19px;
  flex: 0 0 auto;
  background: #eff6ff;
}

.metric-title,
.kpi-title {
  font-size: 14px;
  font-weight: 800;
  color: #111827;
  line-height: 1.25;
}

.kpi-title {
  font-size: 13.5px;
  line-height: 1.2;
}

.kpi-description {
  font-size: 12.5px;
  line-height: 1.38;
}

.metric-value {
  font-size: 30px;
  line-height: 1;
  font-weight: 900;
  margin: 18px 0 10px;
  letter-spacing: -0.02em;
}

.metric-subtitle {
  color: var(--iqg-muted);
  font-size: 12px;
}

/* Cards de KPI com descrição */
.kpi-card {
  min-height: 235px;
  display: flex;
  flex-direction: column;
}

.kpi-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.kpi-info {
  color: #94a3b8;
  font-size: 17px;
  cursor: help;
}

.kpi-value {
  font-size: 31px;
  line-height: 1;
  font-weight: 900;
  margin: 16px 0 12px;
  letter-spacing: -0.03em;
}

.kpi-description {
  font-size: 13px;
  color: #475569;
  line-height: 1.45;
}

/* Cores dos valores */
.blue .metric-value,
.blue .kpi-value {
  color: var(--iqg-blue);
}

.green .metric-value,
.green .kpi-value {
  color: var(--iqg-green);
}

.orange .metric-value,
.orange .kpi-value {
  color: var(--iqg-orange);
}

.purple .metric-value,
.purple .kpi-value {
  color: var(--iqg-purple);
}

.cyan .metric-value,
.cyan .kpi-value {
  color: var(--iqg-cyan);
}

.red .metric-value,
.red .kpi-value {
  color: var(--iqg-red);
}

.pink .metric-value,
.pink .kpi-value {
  color: var(--iqg-pink);
}

.gray .metric-value,
.gray .kpi-value {
  color: var(--iqg-gray);
}

/* Cores dos ícones */
.blue .metric-icon,
.blue .kpi-icon {
  background: #dbeafe;
  color: var(--iqg-blue);
}

.green .metric-icon,
.green .kpi-icon {
  background: #dcfce7;
  color: var(--iqg-green);
}

.orange .metric-icon,
.orange .kpi-icon {
  background: #ffedd5;
  color: var(--iqg-orange);
}

.purple .metric-icon,
.purple .kpi-icon {
  background: #f3e8ff;
  color: var(--iqg-purple);
}

.cyan .metric-icon,
.cyan .kpi-icon {
  background: #cffafe;
  color: var(--iqg-cyan);
}

.red .metric-icon,
.red .kpi-icon {
  background: #fee2e2;
  color: var(--iqg-red);
}

.pink .metric-icon,
.pink .kpi-icon {
  background: #fce7f3;
  color: var(--iqg-pink);
}

.gray .metric-icon,
.gray .kpi-icon {
  background: #f3f4f6;
  color: var(--iqg-gray);
}

/* Caixa explicativa abaixo dos KPIs */
.kpi-help {
  display: flex;
  gap: 14px;
  background: #eef6ff;
  border: 1px solid #dbeafe;
  border-radius: 10px;
  padding: 14px 16px;
  margin-top: 14px;
  color: #334155;
}

.kpi-help-icon {
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: #3b82f6;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 800;
  flex: 0 0 auto;
}

.kpi-help strong {
  display: block;
  margin-bottom: 4px;
  color: #1e293b;
}

.kpi-help p {
  margin: 0;
  color: #475569;
  line-height: 1.45;
  font-size: 14px;
}

/* Multi C-Level GPT */
.c-level-panel {
  margin-top: 16px;
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 55%, #172554 100%);
  border-radius: 14px;
  padding: 20px;
  color: #ffffff;
  box-shadow: 0 12px 34px rgba(15, 23, 42, 0.20);
  border: 1px solid rgba(255,255,255,0.08);
}

.c-level-header {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: flex-start;
  margin-bottom: 18px;
}

.c-level-eyebrow {
  display: inline-flex;
  align-items: center;
  padding: 5px 9px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.18);
  color: #bfdbfe;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 10px;
}

.c-level-header h3 {
  margin: 0;
  font-size: 22px;
  line-height: 1.15;
  font-weight: 900;
  letter-spacing: -0.02em;
}

.c-level-header p {
  margin: 9px 0 0;
  color: #cbd5e1;
  font-size: 14px;
  line-height: 1.45;
  max-width: 860px;
}

.c-level-badge {
  white-space: nowrap;
  padding: 9px 12px;
  border-radius: 999px;
  background: rgba(255,255,255,0.10);
  color: #e0f2fe;
  font-size: 12px;
  font-weight: 800;
  border: 1px solid rgba(255,255,255,0.12);
}

.c-level-body {
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  gap: 16px;
}

.c-level-input-area,
.c-level-response {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  padding: 16px;
}

.c-level-input-area label {
  display: block;
  font-size: 13px;
  font-weight: 800;
  margin-bottom: 9px;
  color: #e2e8f0;
}

.c-level-input-area textarea {
  width: 100%;
  min-height: 116px;
  resize: vertical;
  border: 1px solid rgba(255,255,255,0.16);
  background: rgba(15, 23, 42, 0.72);
  color: #ffffff;
  border-radius: 10px;
  padding: 12px;
  font-family: Inter, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  outline: none;
}

.c-level-input-area textarea::placeholder {
  color: #94a3b8;
}

.c-level-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.c-level-primary,
.c-level-chip {
  border: 0;
  border-radius: 999px;
  height: 36px;
  padding: 0 13px;
  font-size: 12px;
  font-weight: 800;
  cursor: not-allowed;
}

.c-level-primary {
  background: #60a5fa;
  color: #0f172a;
}

.c-level-chip {
  background: rgba(255,255,255,0.12);
  color: #e2e8f0;
}

.c-level-input-area small {
  display: block;
  margin-top: 10px;
  color: #94a3b8;
  font-size: 12px;
}

.c-level-response-title {
  font-size: 13px;
  font-weight: 900;
  color: #bfdbfe;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.c-level-response p {
  margin: 0 0 10px;
  color: #e2e8f0;
  font-size: 13px;
  line-height: 1.45;
}

.c-level-response ul {
  margin: 0;
  padding-left: 18px;
  color: #cbd5e1;
  font-size: 13px;
  line-height: 1.55;
}

@media (max-width: 1100px) {
  .c-level-body {
    grid-template-columns: 1fr;
  }

  .c-level-header {
    flex-direction: column;
  }

  .c-level-badge {
    white-space: normal;
  }
}

/* Multi C-Level GPT ativo */
.c-level-primary,
.c-level-chip {
  cursor: pointer;
}

.c-level-primary:hover {
  filter: brightness(1.05);
}

.c-level-chip:hover {
  background: rgba(255,255,255,0.18);
}

.c-level-primary:disabled,
.c-level-chip:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.c-level-response.loading {
  border-color: rgba(96, 165, 250, 0.50);
}

.c-level-response.error {
  border-color: rgba(248, 113, 113, 0.55);
  background: rgba(127, 29, 29, 0.25);
}

.c-level-response h4 {
  margin: 0 0 10px;
  font-size: 18px;
  color: #ffffff;
}

.c-level-response h5 {
  margin: 14px 0 7px;
  font-size: 13px;
  color: #bfdbfe;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.c-level-response .c-level-status-pill {
  display: inline-flex;
  align-items: center;
  padding: 5px 9px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.16);
  color: #dbeafe;
  font-size: 12px;
  font-weight: 800;
  margin: 4px 8px 8px 0;
}

.c-level-response .c-level-priority {
  display: inline-flex;
  align-items: center;
  padding: 5px 9px;
  border-radius: 999px;
  background: rgba(250, 204, 21, 0.16);
  color: #fef3c7;
  font-size: 12px;
  font-weight: 800;
  margin-bottom: 10px;
}

/* Toolbar/filtros */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  background: #fff;
  border: 1px solid var(--iqg-border);
  padding: 14px;
  border-radius: 10px;
  margin: 18px 0;
  box-shadow: var(--iqg-shadow-soft);
}

.toolbar input,
.toolbar select {
  height: 38px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  padding: 0 10px;
  background: #fff;
  color: #111827;
  font-size: 13px;
}

.toolbar input {
  min-width: 280px;
}

.toolbar button,
.toolbar .btn {
  height: 38px;
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: #2563eb;
  color: white;
  text-decoration: none;
  cursor: pointer;
  font-size: 13px;
}

/* Tabela */
/* Tabela */
.leads-table-card {
  background: #fff;
  border: 1px solid var(--iqg-border);
  border-radius: 10px;
  box-shadow: var(--iqg-shadow-soft);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

table {
  width: 100%;
  min-width: 1100px;
  border-collapse: collapse;
  background: #fff;
}

th {
  background: #f8fafc;
  color: #334155;
  font-size: 12px;
  text-align: left;
  padding: 12px;
  border-bottom: 1px solid #e5e7eb;
  white-space: nowrap;
}

th a {
  color: #334155;
  text-decoration: none;
}

td {
  padding: 11px 12px;
  border-bottom: 1px solid #f1f5f9;
  color: #111827;
  font-size: 13px;
  vertical-align: middle;
}

tr:hover td {
  background: #f8fafc;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  background: #f3f4f6;
  color: #374151;
}

.badge.ativo {
  background: #dcfce7;
  color: #166534;
}

.badge.em_atendimento {
  background: #ffedd5;
  color: #c2410c;
}

.badge.danger {
  background: #fee2e2;
  color: #991b1b;
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 7px 9px;
  border-radius: 7px;
  background: #374151;
  color: white;
  text-decoration: none;
  font-size: 12px;
  border: 0;
}

.btn.whatsapp {
  background: #16a34a;
}

.btn.info {
  background: #2563eb;
}

.btn.success {
  background: #15803d;
}

.btn.danger {
  background: #dc2626;
}

.action-divider {
  width: 1px;
  min-height: 28px;
  background: #d1d5db;
  display: inline-block;
  margin: 0 4px;
}

.print-info {
  font-size: 12px;
  color: var(--iqg-muted);
  margin-bottom: 12px;
}

/* Impressão */
@media print {
  .toolbar,
  .actions,
  button,
  .dashboard-actions {
    display: none !important;
  }

  body {
    background: white;
  }
}

/* Em telas menores, não quebrar feio: vira rolagem horizontal */
@media (max-width: 1500px) {
  .metrics-grid,
  .kpi-grid {
    overflow-x: auto;
    display: flex;
    padding-bottom: 6px;
  }

  .metric-card,
  .kpi-card {
    min-width: 170px;
  }

  .kpi-card {
    min-width: 190px;
  }
}

@media (max-width: 900px) {
  .dashboard-page {
    padding: 14px;
  }

  .dashboard-header {
    flex-direction: column;
  }

  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .toolbar input {
    min-width: 100%;
  }

  .toolbar select {
    width: 100%;
  }

  .leads-table-card {
    margin-left: -14px;
    margin-right: -14px;
    border-radius: 0;
    border-left: none;
    border-right: none;
  }

  table {
    font-size: 12px;
    min-width: 900px;
  }

  th,
  td {
    padding: 8px 10px;
    white-space: nowrap;
  }

  td.actions {
    white-space: normal;
    min-width: 280px;
  }

  .print-info {
    padding: 0 4px;
  }
}

</style>

<script>
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(error => {
        console.log("PWA Service Worker não registrado:", error);
      });
    });
  }
  window.cLevelWorking = false;

  const dashboardSenha = ${JSON.stringify(String(req.query.senha || ""))};

  setInterval(() => {
    const questionBox = document.getElementById("cLevelQuestion");
    const hasQuestionText = questionBox && questionBox.value.trim().length > 0;
    const isQuestionFocused = questionBox && document.activeElement === questionBox;

    if (window.cLevelWorking || hasQuestionText || isQuestionFocused) {
      return;
    }

    window.location.reload();
  }, 10000);

  function printCRM() {
    window.print();
  }

  function escapeHtmlClient(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderCLevelList(title, items) {
    const safeItems = Array.isArray(items) ? items : [];

    if (!safeItems.length) {
      return "";
    }

    return [
      "<h5>" + escapeHtmlClient(title) + "</h5>",
      "<ul>",
      safeItems.map(item => "<li>" + escapeHtmlClient(item) + "</li>").join(""),
      "</ul>"
    ].join("");
  }

  function renderCLevelAnalysis(analysis) {
    if (!analysis) {
      return "<p>Não foi possível montar a análise.</p>";
    }

    const qualidadeTrafego = analysis.qualidadeTrafego || {};
    const saudeFunil = analysis.saudeFunil || {};

    return [
      "<div class='c-level-response-title'>Resposta estratégica</div>",
      "<h4>" + escapeHtmlClient(analysis.tituloDiagnostico || "Diagnóstico executivo") + "</h4>",
      "<div>",
        "<span class='c-level-status-pill'>Tráfego: " + escapeHtmlClient(qualidadeTrafego.status || "inconclusiva") + "</span>",
        "<span class='c-level-status-pill'>Funil: " + escapeHtmlClient(saudeFunil.status || "inconclusiva") + "</span>",
      "</div>",
      "<div class='c-level-priority'>Prioridade executiva: " + escapeHtmlClient(analysis.prioridadeExecutiva || "media") + "</div>",
      "<p>" + escapeHtmlClient(analysis.resumoExecutivo || "") + "</p>",
      qualidadeTrafego.analise ? "<h5>Qualidade do tráfego</h5><p>" + escapeHtmlClient(qualidadeTrafego.analise) + "</p>" : "",
      saudeFunil.analise ? "<h5>Saúde do funil</h5><p>" + escapeHtmlClient(saudeFunil.analise) + "</p>" : "",
      renderCLevelList("Indicadores bons", analysis.indicadoresBons),
      renderCLevelList("Indicadores de atenção", analysis.indicadoresAtencao),
      analysis.gargaloPrincipal ? "<h5>Gargalo principal</h5><p>" + escapeHtmlClient(analysis.gargaloPrincipal) + "</p>" : "",
      renderCLevelList("Possíveis causas", analysis.possiveisCausas),
      renderCLevelList("Estratégia de melhoria", analysis.estrategiaMelhoria),
      renderCLevelList("Plano dos próximos 7 dias", analysis.planoProximos7Dias),
      analysis.observacaoSobreAmostra ? "<h5>Observação sobre a amostra</h5><p>" + escapeHtmlClient(analysis.observacaoSobreAmostra) + "</p>" : ""
    ].join("");
  }

  async function askCLevel(questionOverride) {
    const questionBox = document.getElementById("cLevelQuestion");
    const responseBox = document.getElementById("cLevelResponse");
    const askButton = document.getElementById("askCLevelButton");

    if (!questionBox || !responseBox) {
      return;
    }

    const pergunta = String(questionOverride || questionBox.value || "").trim();

    if (!pergunta || pergunta.length < 8) {
      responseBox.classList.add("error");
      responseBox.innerHTML = [
        "<div class='c-level-response-title'>Atenção</div>",
        "<p>Digite uma pergunta um pouco mais completa para o Multi C-Level GPT.</p>"
      ].join("");
      return;
    }

    questionBox.value = pergunta;

    try {
      window.cLevelWorking = true;

      if (askButton) {
        askButton.disabled = true;
        askButton.textContent = "Analisando KPIs...";
      }

      responseBox.classList.remove("error");
      responseBox.classList.add("loading");
      responseBox.innerHTML = [
        "<div class='c-level-response-title'>Analisando cenário</div>",
        "<p>O Multi C-Level GPT está lendo os KPIs do dashboard e montando uma análise executiva...</p>"
      ].join("");

      const url = "/dashboard/c-level-consultor" + (
        dashboardSenha ? "?senha=" + encodeURIComponent(dashboardSenha) : ""
      );

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          pergunta
        })
      });

      const data = await response.json();

      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Falha ao gerar análise.");
      }

      responseBox.classList.remove("loading");
      responseBox.innerHTML = renderCLevelAnalysis(data.analysis);
    } catch (error) {
      responseBox.classList.remove("loading");
      responseBox.classList.add("error");
      responseBox.innerHTML = [
        "<div class='c-level-response-title'>Erro</div>",
        "<p>" + escapeHtmlClient(error.message || "Não foi possível gerar a análise agora.") + "</p>"
      ].join("");
    } finally {
      window.cLevelWorking = false;

      if (askButton) {
        askButton.disabled = false;
        askButton.textContent = "Perguntar ao Multi C-Level GPT";
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const askButton = document.getElementById("askCLevelButton");

    if (askButton) {
      askButton.addEventListener("click", () => askCLevel());
    }

    document.querySelectorAll("[data-clevel-question]").forEach(button => {
      button.addEventListener("click", () => {
        const question = button.getAttribute("data-clevel-question") || "";
        askCLevel(question);
      });
    });
  });
</script>
        
      </head>

      <body>
      <div style="background:#0f172a;padding:10px 28px;display:flex;gap:10px;align-items:center;">
          <a style="display:inline-block;padding:9px 12px;background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-size:14px;" href="/auditoria${senhaQuery}">🔍 Auditoria</a>
        </div>
  <div class="dashboard-page">
    <div class="dashboard-header">
      <div class="dashboard-title">
        <h1>Dashboard</h1>
        <p>Visão geral do funil de leads e desempenho</p>
      </div>

      <div class="dashboard-actions">
        <div class="date-pill">📅 ${startOfToday.toLocaleDateString("pt-BR")} - ${now.toLocaleDateString("pt-BR")}⌄</div>
        <div class="refresh-pill">↻ Atualizado agora há pouco</div>
      </div>
    </div>
    
          <div class="section-panel">
  <h2 class="section-title">
    <span class="section-icon">⌁</span>
    Funil de Leads - Status Atual
  </h2>

  <div class="metrics-grid">
    ${funnelCardsHtml}
  </div>
</div>

<div class="section-panel">
  <h2 class="section-title">
    <span class="section-icon">▥</span>
    Indicadores de Desempenho e Conversão
  </h2>

  <div class="kpi-grid">
    ${kpiCardsHtml}
  </div>

  <div class="c-level-panel">
  <div class="c-level-header">
    <div>
      <div class="c-level-eyebrow">Multi C-Level GPT</div>
      <h3>CGO/CRO IA — Crescimento, Receita e KPIs</h3>
      <p>
        Consultor estratégico para analisar qualidade do tráfego, funil comercial,
        gargalos da SDR IA, recuperação por Afiliados e oportunidades de escala.
      </p>
    </div>

    <span class="c-level-badge">Growth • Receita • KPIs</span>
  </div>

  <div class="c-level-body">
    <div class="c-level-input-area">
      <label for="cLevelQuestion">Pergunte ao seu diretor IA:</label>
      <textarea
        id="cLevelQuestion"
        placeholder="Exemplo: Bom dia, com base nos KPIs dos últimos 7 dias, me diga como está a qualidade do meu tráfego, quais indicadores estão bons, quais precisam de atenção e qual estratégia devo seguir para melhorar a conversão."
      ></textarea>

      <div class="c-level-actions">
        <button type="button" class="c-level-primary" id="askCLevelButton">
          Perguntar ao Multi C-Level GPT
        </button>

        <button
          type="button"
          class="c-level-chip"
          data-clevel-question="Analise os KPIs dos últimos 7 dias. Quero um diagnóstico da qualidade do tráfego, principais indicadores bons, pontos de atenção, gargalos e estratégia prática para melhorar a conversão."
        >
          Analisar 7 dias
        </button>

        <button
          type="button"
          class="c-level-chip"
          data-clevel-question="Com base nos KPIs atuais, onde está o principal gargalo do meu funil? Separe se o problema parece estar no tráfego, na SDR IA, na taxa, na pré-análise, nos dados completos ou na recuperação por Afiliados."
        >
          Onde está o gargalo?
        </button>

        <button
          type="button"
          class="c-level-chip"
          data-clevel-question="Com base nos KPIs atuais, monte uma estratégia executiva para os próximos 7 dias para melhorar conversão, qualidade do tráfego, recuperação pós-objeção e recuperação por Afiliados."
        >
          Estratégia da semana
        </button>
      </div>

      <small>
        O Multi C-Level GPT analisa os KPIs do dashboard. Ele não altera leads, não manda WhatsApp e não envia CRM.
      </small>
    </div>

    <div class="c-level-response" id="cLevelResponse">
      <div class="c-level-response-title">Resposta estratégica</div>
      <p>
        Faça uma pergunta ao Multi C-Level GPT para receber uma leitura consultiva dos seus KPIs,
        qualidade do tráfego, gargalos e estratégia de crescimento.
      </p>

      <ul>
        <li>Diagnóstico da qualidade do tráfego.</li>
        <li>Resumo dos principais indicadores.</li>
        <li>Alertas sobre gargalos de conversão.</li>
        <li>Estratégia prática para melhorar os resultados.</li>
      </ul>
    </div>
  </div>
</div>

          <form class="toolbar" method="GET" action="/dashboard">
  ${req.query.senha ? `<input type="hidden" name="senha" value="${escapeHtml(req.query.senha)}">` : ""}

  <input
    type="text"
    name="q"
    placeholder="Buscar nome, telefone, CPF, cidade, UF..."
    value="${escapeHtml(search)}"
  />

  <input
    type="text"
    name="cidade"
    placeholder="Cidade"
    value="${escapeHtml(cidadeFilter)}"
  />

  <select name="estado">
    <option value="">Estado: todos</option>
    ${[
      "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS",
      "MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC",
      "SP","SE","TO"
    ].map(uf => `
      <option value="${uf}" ${estadoFilter === uf ? "selected" : ""}>${uf}</option>
    `).join("")}
  </select>

  <select name="humano">
    <option value="">Humano: todos</option>
    <option value="sim" ${humanoFilter === "sim" ? "selected" : ""}>Sim</option>
    <option value="nao" ${humanoFilter === "nao" ? "selected" : ""}>Não</option>
  </select>

  <button type="submit">Filtrar</button>
  <a class="btn" href="/dashboard${senhaQuery}">Limpar</a>
  <button type="button" onclick="printCRM()">Imprimir</button>
</form>
          <div class="print-info">
            Exibindo ${leads.length} lead(s). Clique nos títulos das colunas para ordenar.
          </div>

          <div class="leads-table-card">
<table>

           <thead>
  <tr>
    <th><a href="${makeSortLink("nome", "Nome")}">Nome</a></th>
    <th><a href="${makeSortLink("telefone", "Telefone")}">Telefone</a></th>
    <th><a href="${makeSortLink("cpf", "CPF")}">CPF</a></th>
    <th><a href="${makeSortLink("cidade", "Cidade")}">Cidade</a></th>
    <th><a href="${makeSortLink("estado", "Estado")}">Estado</a></th>
    <th><a href="${makeSortLink("updatedAt", "Atualizado")}">Atualizado</a></th>
    <th>Humano</th>
    <th>Ação</th>
  </tr>
</thead>
            <tbody>
                       ${rows || `<tr><td colspan="8">Nenhum lead encontrado.</td></tr>`}
            </tbody>
          </table>
</div>
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
