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
}

async function updateLeadStatus(user, status) {
  await connectMongo();

  const currentLead = await db.collection("leads").findOne({ user });

  const lifecycleData = getLeadLifecycleFields({
    ...(currentLead || {}),
    status,
    faseQualificacao: status
  });

  if (status === "em_atendimento") {
    lifecycleData.statusOperacional = "em_atendimento";
    lifecycleData.faseFunil = "crm";
    lifecycleData.temperaturaComercial = currentLead?.temperaturaComercial || "indefinida";
    lifecycleData.rotaComercial = currentLead?.rotaComercial || currentLead?.origemConversao || "homologado";
  }

  if (status === "fechado") {
    lifecycleData.statusOperacional = "fechado";
    lifecycleData.faseFunil = "encerrado";
    lifecycleData.temperaturaComercial = "quente";
    lifecycleData.rotaComercial = currentLead?.rotaComercial || currentLead?.origemConversao || "homologado";
  }

  if (status === "perdido") {
    lifecycleData.statusOperacional = "perdido";
    lifecycleData.faseFunil = "encerrado";
    lifecycleData.temperaturaComercial = "frio";
    lifecycleData.rotaComercial = currentLead?.rotaComercial || currentLead?.origemConversao || "homologado";
  }

  await db.collection("leads").updateOne(
    { user },
    {
      $set: {
        status,
        faseQualificacao: status,
        ...lifecycleData,
        updatedAt: new Date()
      }
    }
  );
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

  // 🔥 REMOVE CAMPOS QUE NÃO DEVEM SER ATUALIZADOS
  const {
  _id,
  createdAt,
  crmEnviado,
  crmEnviadoEm,
  ...safeData
} = data || {};

  // 🔥 DADOS QUE SÓ DEVEM EXISTIR NA CRIAÇÃO
   
  const insertData = {
  createdAt: new Date()
};

  // DEFINE STATUS INICIAL SE NÃO EXISTIR
  if (!safeData.status) {
    insertData.status = "novo";
    insertData.statusOperacional = "ativo";
    insertData.faseFunil = "inicio";
    insertData.temperaturaComercial = "indefinida";
    insertData.rotaComercial = "homologado";
  }

   if (!safeData.etapas) {
  insertData.etapas = {
    programa: false,
    beneficios: false,
    estoque: false,
    responsabilidades: false,
    investimento: false,
    compromisso: false
  };
}
   
 const lifecycleData = getLeadLifecycleFields({
  ...safeData,
  ...insertData
});

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

  if (
    status === "afiliado" ||
    fase === "afiliado" ||
    data.interesseAfiliado === true ||
    data.origemConversao === "afiliado" ||
    data.origemConversao === "recuperado_objecao" ||
    data.origemConversao === "interesse_direto"
  ) {
    result.rotaComercial = "afiliado";
  } else if (status || fase || data.origemConversao) {
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
    } else if (etapas?.investimento || statusOuFase === "qualificando") {
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

// 🔥 BUFFER PARA AGUARDAR O LEAD TERMINAR DE DIGITAR
const incomingMessageBuffers = new Map();

const TYPING_DEBOUNCE_MS = 7000; // espera 7s após a última mensagem
const MAX_TYPING_WAIT_MS = 15000; // limite máximo de espera

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
  const now = Date.now();

  let buffer = incomingMessageBuffers.get(from);

  if (!buffer) {
    buffer = {
      active: true,
      processing: false,
      messages: [],
      messageIds: [],
      startedAt: now,
      lastAt: now
    };

    incomingMessageBuffers.set(from, buffer);
  }

  buffer.messages.push(text);
  buffer.lastAt = now;

  if (messageId) {
    buffer.messageIds.push(messageId);
  }

  // Se outra requisição já está aguardando o lead terminar de digitar,
  // esta aqui só adiciona a mensagem ao buffer e para.
  if (buffer.processing) {
    return {
      shouldContinue: false,
      text: ""
    };
  }

  buffer.processing = true;

  // Aguarda o lead parar de mandar mensagens por alguns segundos.
  while (Date.now() - buffer.startedAt < MAX_TYPING_WAIT_MS) {
    const quietFor = Date.now() - buffer.lastAt;

    if (quietFor >= TYPING_DEBOUNCE_MS) {
      break;
    }

    await delay(500);
  }

  const finalBuffer = incomingMessageBuffers.get(from);

  if (!finalBuffer) {
    return {
      shouldContinue: false,
      text: ""
    };
  }

  incomingMessageBuffers.delete(from);

  const finalText = finalBuffer.messages
    .map(msg => String(msg || "").trim())
    .filter(Boolean)
    .join("\n");

  return {
    shouldContinue: true,
    text: finalText,
    messageIds: finalBuffer.messageIds
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
- Envolve venda com produtos físicos, lote inicial em comodato, suporte, treinamento, responsabilidades, análise interna, contrato e investimento de adesão.
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

"ok"
"sim"
"entendi"
"legal"
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
"Quer entender como funciona na prática ou os ganhos?"

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

Isso facilita muito porque você pode focar mais na venda e no relacionamento com clientes, sem precisar investir em estoque logo no início."

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

"Antes de avançarmos, quero te explicar um ponto importante com total transparência 😊

Existe um investimento de adesão e implantação de R$ 1.990.

Mas é importante entender: esse valor não é compra de mercadoria, não é caução e não é garantia.

Ele é para ativação no programa, acesso à estrutura, suporte, treinamentos e liberação do lote inicial em comodato para você começar a operar."

Agora entra a PARTE MAIS IMPORTANTE (ancoragem de valor):

"Pra você ter uma referência prática: só o lote inicial de produtos representa mais de R$ 5.000 em preço de venda ao consumidor final.

Ou seja, você entra com acesso a produtos, estrutura e suporte sem precisar investir esse valor em estoque."

Agora entra o PARCELAMENTO (obrigatório):

"Esse investimento pode ser feito via PIX ou parcelado em até 10x de R$ 199 no cartão, dependendo da disponibilidade no momento."

Agora reforço de segurança:

"E o pagamento só acontece depois da análise interna e da assinatura do contrato, tá?"

Agora validação (obrigatória):

"Faz sentido pra você nesse formato?"

━━━━━━━━━━━━━━━━━━━━━━━
⚠️ REGRAS IMPORTANTES DA TAXA
━━━━━━━━━━━━━━━━━━━━━━━

- SEMPRE mencionar o valor: R$ 1.990
- SEMPRE mencionar que NÃO é compra de mercadoria
- SEMPRE mencionar o estoque > R$ 5.000
- SEMPRE mencionar parcelamento
- SEMPRE validar entendimento

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

"Te explico isso com calma justamente pra você entrar com segurança e clareza.

O modelo faz mais sentido pra quem quer estruturar uma operação de vendas com suporte e produto em mãos."

Depois:

"Você quer avaliar melhor algum ponto ou faz sentido seguir?"

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
"Faz sentido pra você essa parte do comodato?"

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

━━━━━━━━━━━━━━━━━━━━━━━
❄️ LEAD FRIO
━━━━━━━━━━━━━━━━━━━━━━━

Sinais:
- rejeita tudo
- quer dinheiro fácil

Ação:
→ não insistir

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
🧠 EXECUÇÃO FINAL (SEMPRE)
━━━━━━━━━━━━━━━━━━━━━━━

Antes de responder:

1. Ler histórico
2. Identificar fase
3. Identificar intenção
4. Ver dados existentes
5. Ver se há bloqueios
6. Responder
7. Conduzir próximo passo

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
QUALIFICAR MELHOR  
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
  const lower = fullText.toLowerCase();

  const correction = {};

  const estadoMatch = fullText.match(/\b(?:estado|uf)\s*(?:é|e|:|-)?\s*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/i);

  if (estadoMatch) {
    correction.estado = normalizeUF(estadoMatch[1]);
    return correction;
  }

  const cidadeMatch = fullText.match(/\bcidade\s*(?:é|e|:|-)?\s*([A-Za-zÀ-ÿ\s]{3,})$/i);

  if (cidadeMatch) {
    correction.cidade = cidadeMatch[1].trim();
    return correction;
  }

  const nomeMatch = fullText.match(/\bnome\s*(?:é|e|:|-)?\s*([A-Za-zÀ-ÿ\s]{3,})$/i);

  if (nomeMatch) {
    correction.nome = nomeMatch[1].trim();
    return correction;
  }

  const cpfMatch = fullText.match(/\bcpf\s*(?:é|e|:|-)?\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})\b/i);

  if (cpfMatch) {
    correction.cpf = formatCPF(cpfMatch[1]);
    return correction;
  }

  const telefoneMatch = fullText.match(/\b(?:telefone|celular|whatsapp)\s*(?:é|e|:|-)?\s*((?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?(?:9\s*)?\d{4}[\s.-]?\d{4})\b/i);

  if (telefoneMatch) {
    correction.telefone = formatPhone(telefoneMatch[1]);
    return correction;
  }

  if (lower.includes("cidade") && lower.includes("errada")) {
    correction.campoParaCorrigir = "cidade";
    return correction;
  }

  if (lower.includes("estado") && lower.includes("errado")) {
    correction.campoParaCorrigir = "estado";
    return correction;
  }

  if (lower.includes("nome") && lower.includes("errado")) {
    correction.campoParaCorrigir = "nome";
    return correction;
  }

  if (lower.includes("cpf") && lower.includes("errado")) {
    correction.campoParaCorrigir = "cpf";
    return correction;
  }

  if (
    (lower.includes("telefone") || lower.includes("celular") || lower.includes("whatsapp")) &&
    lower.includes("errado")
  ) {
    correction.campoParaCorrigir = "telefone";
    return correction;
  }

  return correction;
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
    !isInvalidName
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
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const positivePatterns = [
  /^sim$/,
  /^s$/,
  /^isso$/,
  /^correto$/,
  /^certo$/,
  /^ta certo$/,
  /^esta certo$/,
  /^pode seguir$/,
  /^pode$/,
  /^pode continuar$/,
  /^confirmo$/,
  /^confirmado$/,
  /^perfeito$/,
  /^ok$/,
  /^exato$/,
  /^tudo certo$/,
  /^esta tudo correto$/,

  // confirmações naturais
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


const VALID_UFS = [
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO"
];

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

function canStartDataCollection(lead = {}) {
  const e = lead.etapas || {};

  return Boolean(
    e.programa &&
    e.beneficios &&
    e.estoque &&
    e.responsabilidades &&
    e.investimento &&
    e.compromisso &&
    lead.interesseReal === true
  );
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
    return "Vamos falar do estoque inicial.\n\nVocê começa com um lote estratégico de produtos em comodato, ou seja, ele fica com você para operação e demonstração, mas continua sendo da IQG.";
  }

  if (!e.responsabilidades) {
    return "Agora preciso alinhar as responsabilidades.\n\nComo parceiro, você fica responsável pela guarda, conservação dos produtos e pela comunicação correta das vendas.";
  }

  if (!e.investimento) {
    return "Show! Agora falta explicar o investimento com transparência.\n\nExiste uma adesão de R$ 1.990 para ativação no programa, suporte, treinamento e liberação do lote inicial em comodato. Pode ser parcelado em até 10x de R$ 199 no cartão.";
  }

  if (!e.compromisso) {
    return "Antes de avançarmos, só preciso confirmar um ponto importante 😊\n\nVocê está de acordo que o resultado depende da sua atuação nas vendas?";
  }

  if (lead.interesseReal !== true) {
    return "Faz sentido pra você seguir para a pré-análise agora?";
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

function canSendLeadToCRM(lead = {}) {
  return (
  lead.dadosConfirmadosPeloLead === true &&
  ["dados_confirmados", "qualificado"].includes(lead.faseQualificacao) &&
  lead.status === "quente" &&
  lead.crmEnviado !== true &&
  lead.nome &&
  lead.cpf &&
  lead.telefone &&
  lead.cidade &&
  lead.estado
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

// 🔥 PRIORIDADE MÁXIMA — intenção de afiliado
if (isAffiliateIntent(text)) {
  return "afiliado";
}

// 🔥 OPORTUNIDADE — alternativa ao homologado
if (isAffiliateAlternativeOpportunity(text)) {
  return "afiliado";
}

  const hasInterest =
    t.includes("quero começar") ||
    t.includes("quero entrar") ||
    t.includes("tenho interesse") ||
    t.includes("vamos") ||
    t.includes("pode iniciar") ||
    t.includes("seguir") ||
    t.includes("pré-análise") ||
    t.includes("pre-analise") ||
    t.includes("pre análise");

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

  if (hasInterest) {
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
async function sendFileOnce(from, key) {
  if (!FILES[key]) return;

  await connectMongo();

  const sentField = `sentFiles.${key}`;

  const lead = await db.collection("leads").findOne({ user: from });

  if (lead?.sentFiles?.[key]) {
    await sendWhatsAppMessage(
      from,
      "Esse material já te enviei logo acima 😊 Dá uma olhada e me diz se fez sentido pra você."
    );
    return;
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

  const fase = lead.faseQualificacao || lead.status || "";

if (fase === "afiliado") {
  if (step === 1) {
    return `${prefixo}conseguiu acessar o cadastro de afiliado? 😊 O link é: https://minhaiqg.com.br/`;
  }

  return `${prefixo}se quiser começar sem estoque e sem taxa de adesão do Homologado, o afiliado pode ser um bom primeiro passo. As informações e cadastro estão aqui: https://minhaiqg.com.br/`;
}

  if (fase === "morno") {
    if (step === 1) {
      return `${prefixo}ficou alguma dúvida sobre os benefícios ou sobre o estoque em comodato? 😊`;
    }

    if (step === 2) {
      return `${prefixo}quer que eu te explique de forma mais direta como funciona o estoque inicial?`;
    }
  }

  if (fase === "qualificando") {
    if (step === 1) {
      return `${prefixo}ficou alguma dúvida sobre o investimento ou sobre o que está incluso? 😊`;
    }

    if (step === 2) {
      return `${prefixo}faz sentido pra você seguir nesse formato ou quer avaliar algum ponto antes?`;
    }
  }

  if (
    fase === "coletando_dados" ||
    fase === "dados_parciais" ||
    fase === "aguardando_dados"
  ) {
    if (step === 1) {
      return `${prefixo}só falta continuarmos com seus dados para a pré-análise 😊`;
    }

    if (step === 2) {
      return `${prefixo}quer seguir com a pré-análise agora? É bem rápido.`;
    }
  }

  if (
    fase === "aguardando_confirmacao_campo" ||
    fase === "aguardando_confirmacao_dados"
  ) {
    if (step === 1) {
      return `${prefixo}só preciso da sua confirmação para continuar 😊`;
    }

    if (step === 2) {
      return `${prefixo}pode me confirmar se os dados estão corretos?`;
    }
  }

  if (step === 1) {
    return `${prefixo}ficou alguma dúvida sobre o programa? 😊`;
  }

  return `${prefixo}quer que eu te explique de forma mais direta?`;
}

   function shouldStopBotByLifecycle(lead = {}) {
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
      message: "Vou encerrar por aqui 😊 Qualquer dúvida, fico à disposição!",
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

await sendWhatsAppMessage(from, followup.message);
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

if (
  leadBeforeProcessing?.status === "enviado_crm" ||
  leadBeforeProcessing?.faseQualificacao === "enviado_crm" ||
  leadBeforeProcessing?.status === "em_atendimento" ||
  leadBeforeProcessing?.faseQualificacao === "em_atendimento" ||
  leadBeforeProcessing?.status === "fechado" ||
  leadBeforeProcessing?.faseQualificacao === "fechado" ||
  leadBeforeProcessing?.status === "perdido" ||
  leadBeforeProcessing?.faseQualificacao === "perdido"
) {
  console.log("⛔ Lead bloqueado por status/fase:", {
    status: leadBeforeProcessing?.status,
    faseQualificacao: leadBeforeProcessing?.faseQualificacao
  });
  return;
}

if (state.closed) {
  console.log("⛔ Lead bloqueado por state.closed em memória");
  return;
}
     
// Atendimento humano deve ser marcado pelo botão "Atender" no dashboard.
// Evita tentativa insegura de identificar lead por message.to no webhook.

     
     // BLOQUEIO DESATIVADO PARA TESTE.
// Se o número que está testando for igual ao CONSULTANT_PHONE,
// o bot recebia a mensagem e parava aqui sem responder.
// if (from === process.env.CONSULTANT_PHONE) {
//   console.log("⛔ Mensagem ignorada: número é CONSULTANT_PHONE");
//   return;
// }

     
clearTimers(from);

if (
  !["enviado_crm", "em_atendimento", "fechado", "perdido"].includes(leadBeforeProcessing?.status) &&
  !["enviado_crm", "em_atendimento", "fechado", "perdido"].includes(leadBeforeProcessing?.faseQualificacao)
) {
  state.closed = false;
}

  let text = "";

if (message.text?.body) {
  text = message.text.body.trim();

  // 🔥 Aguarda alguns segundos para ver se o lead vai mandar mais mensagens
  const buffered = await collectBufferedText(from, text, messageId);

  // Se esta mensagem foi apenas adicionada ao buffer,
  // encerra este webhook sem chamar a IA.
  if (!buffered.shouldContinue) {
    return;
  }

  // A primeira requisição continua com todas as mensagens juntas
  text = buffered.text;

} else if (message.audio?.id) {
  await sendWhatsAppMessage(from, "Vou ouvir seu áudio rapidinho e já te respondo 😊");

  const mediaUrl = await getWhatsAppMediaUrl(message.audio.id);
  const audioBuffer = await downloadWhatsAppMedia(mediaUrl);

  text = await transcribeAudioBuffer(audioBuffer, "audio.ogg");

  if (!text) {
    await sendWhatsAppMessage(
      from,
      "Não consegui entender bem o áudio. Pode me enviar novamente ou escrever sua dúvida?"
    );

    return;
  }
} else {
  await sendWhatsAppMessage(
    from,
    "No momento consigo te atender melhor por texto ou áudio 😊 Pode me enviar sua dúvida?"
  );

  return;
}

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
const explicitCorrection =
  currentLead?.faseQualificacao === "corrigir_dado_final"
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

const rawExtracted =
  Object.keys(explicitCorrection).length > 0
    ? {
        ...(currentLead || {}),
        ...explicitCorrection
      }
    : podeTentarExtrairDados
      ? extractLeadData(textForExtraction, currentLead || {})
      : {};
     
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

 function isNegativeConfirmation(value = "") {
  const t = String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  return [
    "nao",
    "não",
    "errado",
    "incorreto",
    "nao esta",
    "não está",
    "não esta",
    "ta errado",
    "esta errado",
    "está errado"
  ].includes(t);
}

     const pendingFields = Object.keys(pendingExtractedData);
if (
  currentLead?.faseQualificacao === "corrigir_dado_final" &&
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
    nome: "nome completo",
    cpf: "CPF",
    telefone: "telefone com DDD",
    cidade: "cidade",
    estado: "estado"
  };

  const msg = `Sem problema 😊 Qual é o ${labels[explicitCorrection.campoParaCorrigir]} correto?`;

  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

     if (
  currentLead?.faseQualificacao === "aguardando_valor_correcao_final" &&
  currentLead?.campoPendente
) {
  const campo = currentLead.campoPendente;

  let valorCorrigido = text.trim();

  if (campo === "cpf") {
    valorCorrigido = formatCPF(valorCorrigido);
  }

  if (campo === "telefone") {
    valorCorrigido = formatPhone(valorCorrigido);
  }

  if (campo === "estado") {
    valorCorrigido = normalizeUF(valorCorrigido);
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
    campoPendente: null,
    valorPendente: null,
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

 respostaConfirmacaoCampo = `Perfeito, ${labels[campo] || campo} confirmado ✅`;

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
    dadosConfirmadosPeloLead: false,
    aguardandoConfirmacao: true,
    crmPendenteAtualizacao: true,
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
     const strongIntent = isStrongBuyIntent(text);
const missingFields = getMissingLeadFields(extractedData);
const awaitingConfirmation = currentLead?.faseQualificacao === "aguardando_confirmacao_dados";

if (leadStatus === "afiliado") {
  const isAlternative = isAffiliateAlternativeOpportunity(text);

await saveLeadProfile(from, {
  status: "afiliado",
  faseQualificacao: "afiliado",
  interesseAfiliado: true,
  origemConversao: isAffiliateAlternativeOpportunity(text) ? "recuperado_objecao" : "interesse_direto",
  ultimaMensagem: text
});

  const affiliateMsg = buildAffiliateResponse(isAlternative);

  await sendWhatsAppMessage(from, affiliateMsg);
  await saveHistoryStep(from, history, text, affiliateMsg, !!message.audio?.id);

  scheduleLeadFollowups(from);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return;
}

// 🔥 ATUALIZA STATUS / FASE DO CRM COM BASE NA CLASSIFICAÇÃO
// Antes o sistema classificava, mas não salvava no Mongo.
// Por isso o dashboard não mudava de status.

     // 🔥 PRIORIDADE: LEAD QUENTE (INTENÇÃO FORTE)
if (
  strongIntent &&
  currentLead?.faseQualificacao !== "coletando_dados" &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !awaitingConfirmation
) {
  await saveLeadProfile(from, {
    interesseReal: true,
    faseQualificacao: "qualificando",
    status: "qualificando"
  });
}
     
if (
  leadStatus &&
  !currentLead?.aguardandoConfirmacaoCampo &&
  !awaitingConfirmation &&
  !["enviado_crm", "em_atendimento", "fechado", "perdido"].includes(currentLead?.status)
) {
  
const statusMap = {
  frio: "perdido",
  morno: "morno",
  qualificando: "qualificando",
  pre_analise: "pre_analise",
  afiliado: "afiliado"
};

const faseMap = {
  frio: "perdido",
  morno: "morno",
  qualificando: "qualificando",
  pre_analise: "pre_analise",
  afiliado: "afiliado"
};

 await saveLeadProfile(from, {
  status: statusMap[leadStatus] || leadStatus,
  faseQualificacao: faseMap[leadStatus] || leadStatus,
  origemConversao: leadStatus === "afiliado" ? "afiliado" : "homologado"
});

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
  !currentLead?.aguardandoConfirmacaoCampo
) {
  await saveLeadProfile(from, {
    ...extractedData,
    cpf: formatCPF(extractedData.cpf),
    telefone: formatPhone(extractedData.telefone),
    estado: normalizeUF(extractedData.estado),
    cidadeEstado: `${extractedData.cidade}/${normalizeUF(extractedData.estado)}`,
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
    content: `DADOS DE CONTEXTO DO LEAD:
Nome informal do WhatsApp: ${currentLead?.nomeWhatsApp || "-"}
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

const podeIniciarColeta = canStartDataCollection(currentLead);

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

     // 🚫 BLOQUEIO DE REGRESSÃO DE FASE
const etapaAtual = getCurrentFunnelStage(currentLead);
const respostaLowerCheck = respostaFinal.toLowerCase();

let etapaDetectadaNaResposta = etapaAtual;

if (respostaLowerCheck.includes("parceria") || respostaLowerCheck.includes("programa")) {
  etapaDetectadaNaResposta = 1;
}

if (respostaLowerCheck.includes("benef")) {
  etapaDetectadaNaResposta = 2;
}

if (respostaLowerCheck.includes("estoque") || respostaLowerCheck.includes("comodato")) {
  etapaDetectadaNaResposta = 3;
}

if (respostaLowerCheck.includes("respons")) {
  etapaDetectadaNaResposta = 4;
}

if (respostaLowerCheck.includes("1.990") || respostaLowerCheck.includes("1990") || respostaLowerCheck.includes("investimento")) {
  etapaDetectadaNaResposta = 5;
}

if (respostaLowerCheck.includes("resultado depende")) {
  etapaDetectadaNaResposta = 6;
}

if (etapaDetectadaNaResposta < etapaAtual) {
  respostaFinal = getNextFunnelStepMessage(currentLead);
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
     
     // 🚫 BLOQUEIO: se o folder já foi enviado, não oferecer material de novo
if (
  currentLead?.sentFiles?.folder &&
  /material|folder|te mandar|mandar o material|enviar o material|te enviar/i.test(respostaFinal)
) {
  respostaFinal = "Esse material já te enviei logo acima 😊\n\nConseguiu dar uma olhada? Fez sentido pra você ou quer que eu te explique os pontos principais?";
}
     
     const mencionouPreAnalise =
  /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal);

if (mencionouPreAnalise && !podeIniciarColeta) {
  if (jaFalouInvestimento && isCommercialProgressConfirmation(text)) {
    respostaFinal = "Perfeito 😊 Antes de seguir com a pré-análise, só preciso alinhar um último ponto: você está de acordo que o resultado depende da sua atuação nas vendas?";
  } else {
    respostaFinal = state.sentFiles.folder
      ? "Antes de avançarmos, deixa eu te explicar melhor como funciona o programa 😊\n\nComo o material já está logo acima, posso te resumir os pontos principais por aqui. Quer que eu resuma?"
      : "Antes de avançarmos, deixa eu te explicar melhor como funciona o programa 😊\n\nSe fizer sentido, posso te explicar os principais pontos ou te mandar um material. O que você prefere?";
  }
}
// 🚨 BLOQUEIO DE COLETA PREMATURA — COM AVANÇO CONTROLADO E SEM LOOP
if (startedDataCollection && !podeIniciarColeta) {
  const jaEnviouFolder = Boolean(currentLead?.sentFiles?.folder);

  const ultimaRespostaBot = [...history]
    .reverse()
    .find(m => m.role === "assistant")?.content || "";

  const jaPerguntouDuvida =
    ultimaRespostaBot.includes("ficou alguma dúvida específica") ||
    ultimaRespostaBot.includes("ficou alguma dúvida");

    if (jaFalouInvestimento && isCommercialProgressConfirmation(text)) {
    respostaFinal =
      "Perfeito 😊 Antes de seguirmos com a pré-análise, só preciso confirmar um ponto importante:\n\nVocê está de acordo que o resultado depende da sua atuação nas vendas?";
  } else if (jaFalouBeneficios && jaEnviouFolder && !jaFalouInvestimento) {
    respostaFinal =
      "Perfeito 😊 Agora o próximo ponto é o investimento de adesão.\n\nPosso te explicar esse valor com transparência?";
  } else if (jaFalouBeneficios && !jaFalouInvestimento) {
    respostaFinal =
      "Top! Antes de avançarmos, preciso te explicar a parte do investimento com transparência.\n\nPosso te passar esse ponto agora?";
    } else if (jaPerguntouDuvida && isCommercialProgressConfirmation(text)) {
    respostaFinal =
      "Ótimo! Então vamos avançar.\n\nO próximo ponto é entender melhor os benefícios e o funcionamento do programa. Posso te explicar de forma direta?";
  } else if (jaEnviouFolder) {
    respostaFinal =
      "Perfeito! Como o material já está acima, vou seguir de forma objetiva.\n\nO próximo passo é te explicar os principais pontos do programa antes da pré-análise.";
  } else {
    respostaFinal =
      "Antes de seguirmos, preciso te explicar melhor como funciona o programa 😊\n\nPosso te enviar um material explicativo bem direto?";
  }
}
     

// 🔥 BLOQUEIO: impedir pedido de múltiplos dados
const multiDataRequestPattern =
  /nome.*cpf.*telefone.*cidade|cpf.*nome.*telefone|telefone.*cpf.*cidade/i;

if (multiDataRequestPattern.test(respostaFinal)) {
  respostaFinal = "Show! Vamos fazer passo a passo.\n\nPrimeiro, pode me enviar seu nome completo?";
}

// 🚫 ANTI-LOOP FINAL — impede repetir a última resposta do bot
if (isRepeatedBotReply(respostaFinal, history)) {
  respostaFinal = getNextFunnelStepMessage(currentLead);
}
     
     // 🔥 ATUALIZA ETAPAS DO FUNIL
const etapasUpdate = { ...(currentLead?.etapas || {}) };

const respostaEtapaLower = respostaFinal.toLowerCase();

if (respostaEtapaLower.includes("parceria") || respostaEtapaLower.includes("programa")) {
  etapasUpdate.programa = true;
}

if (respostaEtapaLower.includes("benef")) {
  etapasUpdate.beneficios = true;
}

if (respostaEtapaLower.includes("comodato") || respostaEtapaLower.includes("estoque")) {
  etapasUpdate.estoque = true;
}

if (respostaEtapaLower.includes("respons")) {
  etapasUpdate.responsabilidades = true;
}

if (
  respostaEtapaLower.includes("1.990") ||
  respostaEtapaLower.includes("1990") ||
  respostaEtapaLower.includes("investimento")
) {
  etapasUpdate.investimento = true;
}

if (
  respostaEtapaLower.includes("resultado depende") ||
  respostaEtapaLower.includes("depende da sua atuação") ||
  respostaEtapaLower.includes("depende da sua atuacao")
) {
  etapasUpdate.compromisso = true;
}

await saveLeadProfile(from, {
  etapas: etapasUpdate
});
     
// 🔥 Mostra "digitando..." real no WhatsApp
await sendTypingIndicator(messageId);

const typingTime = humanDelay(respostaFinal);

// pausa curta de leitura
await delay(800);

// tempo proporcional ao tamanho da resposta
await delay(typingTime);

// envia resposta
await sendWhatsAppMessage(from, respostaFinal);
history.push({ role: "assistant", content: respostaFinal });
     
await saveConversation(from, history);

// 🔥 Envio de arquivos por decisão da IA
const fileKeys = new Set();

const requestedFile = detectRequestedFile(text);
if (requestedFile) {
  fileKeys.add(requestedFile);
}

for (const action of actions) {
  fileKeys.add(action);
}

for (const key of fileKeys) {
  await sendFileOnce(from, key);
}

// 🔥 follow-up sempre ativo após resposta da IA
scheduleLeadFollowups(from);

    if (messageId) {
      processingMessages.delete(messageId);
      processedMessages.set(messageId, Date.now());
    }

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

    const query = {};

        if (statusFilter) {
      query.status = statusFilter;
    }

    if (statusOperacionalFilter) {
      query.statusOperacional = statusOperacionalFilter;
    }

    if (faseFunilFilter) {
      query.faseFunil = faseFunilFilter;
    }

    if (temperaturaComercialFilter) {
      query.temperaturaComercial = temperaturaComercialFilter;
    }

    if (rotaComercialFilter) {
      query.rotaComercial = rotaComercialFilter;
    }
     
    if (search) {
      query.$or = [
        { user: { $regex: search, $options: "i" } },
        { telefoneWhatsApp: { $regex: search, $options: "i" } },
        { nome: { $regex: search, $options: "i" } },
        { cidadeEstado: { $regex: search, $options: "i" } },
        { ultimaMensagem: { $regex: search, $options: "i" } }
      ];
    }

    const sortMap = {
      status: "status",
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

    const countByStatus = status => allLeads.filter(l => l.status === status).length;

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

           const status = lead.status || "novo";
      const faseAntiga = lead.faseQualificacao || "-";
      const statusOperacional = lead.statusOperacional || "-";
      const faseFunil = lead.faseFunil || "-";
      const temperaturaComercial = lead.temperaturaComercial || "-";
      const rotaComercial = lead.rotaComercial || lead.origemConversao || "-";

      const user = encodeURIComponent(lead.user || phone);

      const baseStatusLink = `/lead/${user}/status`;
      return `
                <tr>
  <td><span class="badge ${status}">${escapeHtml(status)}</span></td>
  <td>${escapeHtml(faseAntiga)}</td>
  <td>${escapeHtml(statusOperacional)}</td>
  <td>${escapeHtml(faseFunil)}</td>
  <td>${escapeHtml(temperaturaComercial)}</td>
  <td>${escapeHtml(rotaComercial)}</td>
  <td>${escapeHtml(lead.origemConversao || "-")}</td>
<td>${escapeHtml(lead.nome || "-")}</td>
<td>${escapeHtml(phone)}</td>
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
                         ${rows || `<tr><td colspan="14">Nenhum lead encontrado.</td></tr>`}
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
