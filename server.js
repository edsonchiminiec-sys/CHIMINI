import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";

const app = express();
app.use(express.json({ limit: "10mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "iqg_token_123";
const CONSULTANT_PHONE = process.env.CONSULTANT_PHONE;

const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 18;
const BUSINESS_TIMEZONE_OFFSET = -3;

const conversations = {};
const leadState = {};
const processedMessages = new Map();

const REQUIRED_ENV_VARS = [
  "PHONE_NUMBER_ID",
  "WHATSAPP_TOKEN",
  "OPENAI_API_KEY"
];

function validateEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length) {
    console.error(
      `Variáveis de ambiente ausentes: ${missing.join(", ")}. Configure antes de iniciar o bot.`
    );
  }
}

validateEnvironment();

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelay(text) {
  const base = 2500;
  const perChar = 30;
  const max = 12000;
  return Math.min(base + (text || "").length * perChar, max);
}

function pruneProcessedMessages() {
  const now = Date.now();
  const ttl = 24 * 60 * 60 * 1000;

  for (const [messageId, timestamp] of processedMessages.entries()) {
    if (now - timestamp > ttl) {
      processedMessages.delete(messageId);
    }
  }
}

function alreadyProcessed(messageId) {
  if (!messageId) return false;

  pruneProcessedMessages();

  if (processedMessages.has(messageId)) {
    return true;
  }

  processedMessages.set(messageId, Date.now());
  return false;
}

function getState(from) {
  if (!leadState[from]) {
    leadState[from] = {
      greeted: false,
      folderOffered: false,
      sentFiles: {},
      folderSent: false,
      folderFollowupSent: false,
      inactivityFollowupCount: 0,
      inactivityTimer: null,
      folderTimer: null,
      lastUserMessageAt: Date.now(),
      lastAssistantQuestionAt: null,
      closed: false
    };
  }

  return leadState[from];
}

function clearTimers(from) {
  const state = getState(from);

  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
  }

  if (state.folderTimer) {
    clearTimeout(state.folderTimer);
    state.folderTimer = null;
  }
}

function saoPauloNow() {
  const now = new Date();
  return new Date(now.getTime() + BUSINESS_TIMEZONE_OFFSET * 60 * 60 * 1000);
}

function isBusinessTime(date = saoPauloNow()) {
  const day = date.getUTCDay();
  const hour = date.getUTCHours();

  const isWeekday = day >= 1 && day <= 5;
  const isWithinHours = hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;

  return isWeekday && isWithinHours;
}

function businessDelayMs(hours) {
  let remainingMinutes = Math.max(1, Math.ceil(hours * 60));
  let local = saoPauloNow();

  while (remainingMinutes > 0) {
    local = new Date(local.getTime() + 60 * 1000);

    if (isBusinessTime(local)) {
      remainingMinutes--;
    }
  }

  const targetUtc = new Date(local.getTime() - BUSINESS_TIMEZONE_OFFSET * 60 * 60 * 1000);
  return Math.max(targetUtc.getTime() - Date.now(), 1000);
}

function scheduleInBusinessTime(from, callback, delayHours) {
  const state = getState(from);
  const wait = businessDelayMs(delayHours);

  state.inactivityTimer = setTimeout(callback, wait);
}

function addAssistantMessage(from, content) {
  if (!conversations[from]) conversations[from] = [];

  conversations[from].push({
    role: "assistant",
    content
  });

  if (conversations[from].length > 30) {
    conversations[from] = conversations[from].slice(-30);
  }
}

function addUserMessage(from, content) {
  if (!conversations[from]) conversations[from] = [];

  conversations[from].push({
    role: "user",
    content
  });

  if (conversations[from].length > 30) {
    conversations[from] = conversations[from].slice(-30);
  }
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function isPositiveShortReply(text) {
  const lower = normalizeText(text);

  return [
    "sim",
    "ok",
    "okay",
    "pode",
    "pode sim",
    "quero",
    "quero sim",
    "manda",
    "manda sim",
    "envia",
    "envia sim",
    "me manda",
    "me envie",
    "vamos",
    "bora",
    "certo",
    "fechado",
    "tenho interesse",
    "tenho interesse sim"
  ].includes(lower);
}

function wantsProgramInfo(text) {
  const lower = normalizeText(text);

  return (
    isPositiveShortReply(text) ||
    lower.includes("tenho interesse") ||
    lower.includes("quero saber") ||
    lower.includes("quero conhecer") ||
    lower.includes("como funciona") ||
    lower.includes("me explica") ||
    lower.includes("explica") ||
    lower.includes("programa") ||
    lower.includes("parceiro") ||
    lower.includes("homologado") ||
    lower.includes("parceria") ||
    lower.includes("revender") ||
    lower.includes("vender")
  );
}

function detectRequestedFile(text) {
  const lower = normalizeText(text);

  if (lower.includes("contrato") || lower.includes("minuta") || lower.includes("termo")) {
    return "contrato";
  }

  if (
    lower.includes("catalogo") ||
    lower.includes("produtos") ||
    lower.includes("linha de produtos")
  ) {
    return "catalogo";
  }

  if (
    lower.includes("kit") ||
    lower.includes("lote") ||
    lower.includes("estoque inicial") ||
    lower.includes("vem no kit")
  ) {
    return "kit";
  }

  if (
    lower.includes("manual") ||
    lower.includes("curso") ||
    lower.includes("treinamento") ||
    lower.includes("tratar piscina") ||
    lower.includes("tratamento de piscina") ||
    lower.includes("como usar") ||
    lower.includes("quando usar") ||
    lower.includes("aplicar produto") ||
    lower.includes("nao sei tratar piscina")
  ) {
    return "manual";
  }

  if (
    lower.includes("folder") ||
    lower.includes("resumo") ||
    lower.includes("explicativo") ||
    lower.includes("apresentacao")
  ) {
    return "folder";
  }

  return null;
}

async function safeJson(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { raw: text };
  }
}

async function sendWhatsAppMessage(to, body) {
  const response = await fetch(
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
        type: "text",
        text: { body }
      })
    }
  );

  const data = await safeJson(response);
  console.log("Resposta do WhatsApp:", JSON.stringify(data, null, 2));

  if (!response.ok) {
    throw new Error(`Erro ao enviar mensagem WhatsApp: ${JSON.stringify(data)}`);
  }

  return data;
}

async function markAsRead(messageId) {
  if (!messageId) return;

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId
        })
      }
    );

    const data = await safeJson(response);
    console.log("Resposta marcar como lida:", JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Erro ao marcar como lida:", error);
  }
}

async function downloadPdfFromDrive(file) {
  const response = await fetch(file.link);

  if (!response.ok) {
    throw new Error(`Falha ao baixar PDF: ${file.filename}. Status: ${response.status}`);
  }

  const buffer = await response.buffer();

  return {
    buffer,
    filename: file.filename.endsWith(".pdf") ? file.filename : `${file.filename}.pdf`
  };
}

async function uploadPdfToWhatsApp(file) {
  const { buffer, filename } = await downloadPdfFromDrive(file);

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", buffer, {
    filename,
    contentType: "application/pdf"
  });

  const response = await fetch(
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

  const data = await safeJson(response);
  console.log("Upload PDF WhatsApp:", JSON.stringify(data, null, 2));

  if (!response.ok || !data.id) {
    throw new Error(`Falha no upload do PDF: ${JSON.stringify(data)}`);
  }

  return data.id;
}

async function sendWhatsAppDocument(to, file) {
  try {
    const mediaId = await uploadPdfToWhatsApp(file);

    const response = await fetch(
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
            id: mediaId,
            filename: file.filename,
            caption: file.caption
          }
        })
      }
    );

    const data = await safeJson(response);
    console.log("Envio de documento por ID:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      throw new Error(`Falha ao enviar documento: ${JSON.stringify(data)}`);
    }

    return data;
  } catch (error) {
    console.error("Erro no envio do documento:", error);

    await sendWhatsAppMessage(
      to,
      "Tive uma instabilidade para enviar o PDF agora. Vou encaminhar para um consultor da IQG te enviar o material certinho por aqui."
    );

    return null;
  }
}

async function sendFileOnce(from, fileKey) {
  const state = getState(from);

  if (state.sentFiles[fileKey]) {
    const msg =
      "Esse material eu já te enviei logo acima 😊\n\n" +
      "Dá uma olhada com calma e me diz: ficou alguma dúvida sobre essa parte?";
    await sendWhatsAppMessage(from, msg);
    addAssistantMessage(from, msg);
    return;
  }

  state.sentFiles[fileKey] = true;

  if (fileKey === "folder") {
    state.folderSent = true;
  }

  await delay(2000);
  await sendWhatsAppDocument(from, FILES[fileKey]);
}

async function sendInitialGreeting(from) {
  const state = getState(from);

  if (state.greeted) return;

  const msg =
    "Oi! Tudo bem? 😊\n\n" +
    "Sou a especialista comercial da IQG e vou te explicar o Programa Parceiro Homologado, que começa pela linha de produtos para piscinas.\n\n" +
    "Antes de qualquer pré-análise, posso te enviar um folder explicativo com o funcionamento, benefícios, responsabilidades e taxa de adesão?";

  await delay(humanDelay(msg));
  await sendWhatsAppMessage(from, msg);
