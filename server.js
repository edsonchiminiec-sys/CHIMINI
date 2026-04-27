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
async function updateLeadStatus(user, status) {
  await connectMongo();

  await db.collection("leads").updateOne(
    { user },
    {
      $set: {
        status,
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
    ...safeData
  } = data || {};

  // 🔥 DADOS QUE SÓ DEVEM EXISTIR NA CRIAÇÃO
  const insertData = {
    createdAt: new Date()
  };

  // 🔥 DEFINE STATUS INICIAL SE NÃO EXISTIR
  if (!safeData.status) {
    insertData.status = "novo";
  }

 await db.collection("leads").updateOne(
  { user },
  {
    $set: {
      user,
      ...safeData,
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

const TYPING_DEBOUNCE_MS = 4500; // espera 4,5s após a última mensagem
const MAX_TYPING_WAIT_MS = 9000; // nunca espera mais de 9s no total

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

async function collectBufferedText(from, text, messageId) {
  const now = Date.now();

  const existingBuffer = incomingMessageBuffers.get(from);

  // Se já existe uma mensagem aguardando resposta,
  // apenas junta esta nova mensagem ao mesmo bloco.
  if (existingBuffer?.active) {
    existingBuffer.messages.push(text);
    existingBuffer.lastAt = now;

    // Marca esta mensagem como processada para o WhatsApp não reenviar
    if (messageId) {
      markMessageAsProcessed(messageId);
    }

    return {
      shouldContinue: false,
      text: ""
    };
  }

  // Primeira mensagem: cria o buffer
  const buffer = {
    active: true,
    messages: [text],
    startedAt: now,
    lastAt: now
  };

  incomingMessageBuffers.set(from, buffer);

  // Espera até o lead parar de mandar mensagens por alguns segundos
  while (Date.now() - buffer.startedAt < MAX_TYPING_WAIT_MS) {
    const timeSinceLastMessage = Date.now() - buffer.lastAt;
    const remainingQuietTime = TYPING_DEBOUNCE_MS - timeSinceLastMessage;

    if (remainingQuietTime <= 0) {
      break;
    }

    await delay(Math.min(remainingQuietTime, 1000));
  }

  const finalBuffer = incomingMessageBuffers.get(from) || buffer;
  incomingMessageBuffers.delete(from);

  return {
    shouldContinue: true,
    text: finalBuffer.messages.join("\n")
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
    /^confirmo$/,
    /^confirmado$/,
    /^perfeito$/,
    /^ok$/,
    /^exato$/,
    /^tudo certo$/,
    /^esta tudo correto$/,
    /^pode continuar$/
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

function getMissingFieldQuestion(field) {
  const variations = {
    nome: [
      "Perfeito. Para continuar, preciso do seu nome completo.",
      "Pode me enviar seu nome completo, por favor?",
      "Só preciso do seu nome completo para seguir."
    ],
    cpf: [
      "Agora preciso do seu CPF, pode me enviar?",
      "Pode me passar seu CPF, por favor?",
      "Só falta seu CPF para avançarmos."
    ],
    telefone: [
      "Pode me enviar seu telefone com DDD?",
      "Qual é o melhor telefone para contato?",
      "Me passa seu número com DDD, por favor."
    ],
    cidade: [
  "Qual sua cidade e estado? Pode mandar assim: Duartina SP.",
  "Pode me informar sua cidade e estado? Exemplo: Bauru SP.",
  "Só falta sua cidade e estado para continuar."
],
estado: [
  "Qual sua cidade e estado? Pode mandar assim: Duartina SP.",
  "Pode me informar sua cidade e estado? Exemplo: Bauru SP.",
  "Só falta sua cidade e estado para continuar."
]
  };

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
  lead.estado &&
  lead.nomeLimpo
);
}

function classifyLead(text = "", data = {}, history = []) {
  const t = text.toLowerCase();

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
  const state = getState(from);

  if (!FILES[key]) return;

  // 🚫 Se já enviou, não envia de novo
  if (state.sentFiles[key]) {
    await sendWhatsAppMessage(
      from,
      "Esse material já te enviei logo acima 😊 Dá uma olhada e me diz se fez sentido pra você."
    );
    return;
  }

  // ✅ Marca ANTES de enviar
  state.sentFiles[key] = true;

  await delay(2000);
  await sendWhatsAppDocument(from, FILES[key]);
}
function scheduleInactivityFollowup(from) {
  const state = getState(from);

  if (state.closed) return;

  if (state.inactivityTimer) clearTimeout(state.inactivityTimer);

  state.inactivityTimer = setTimeout(async () => {
    try {
      state.inactivityFollowupCount++;

      let msg = "";

      if (state.inactivityFollowupCount === 1) {
        msg = "Passando só para saber se ficou alguma dúvida sobre o programa 😊";
      } else if (state.inactivityFollowupCount === 2) {
        msg = "Você vê isso como renda extra ou negócio principal?";
      } else if (state.inactivityFollowupCount === 3) {
        msg = "Você já trabalha com vendas ou atendimento?";
      } else if (state.inactivityFollowupCount === 4) {
        msg = "Quer que eu siga com sua pré-análise?";
      } else {
        msg = "Vou encerrar por aqui 😊 Qualquer dúvida, fico à disposição!";
        state.closed = true;
      }

      await sendWhatsAppMessage(from, msg);

      if (!state.closed) {
        scheduleInactivityFollowup(from);
      }
    } catch (error) {
      console.error("Erro no follow-up de inatividade:", error);
    }
  }, 6 * 60 * 60 * 1000);
}

function scheduleShortFollowupAfterFile(from) {
  const state = getState(from);

  if (state.shortTimer) {
    clearTimeout(state.shortTimer);
  }

  state.shortTimer = setTimeout(async () => {
    try {
      if (state.closed) return;

      await sendWhatsAppMessage(
        from,
        "Conseguiu dar uma olhada no material? 😊"
      );

      state.shortTimer = null;
    } catch (error) {
      console.error("Erro no follow-up curto após arquivo:", error);
    }
  }, 6 * 60 * 1000);
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
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    messageId = message.id || null;

    if (messageId) {
      cleanupProcessedMessages();

      if (processedMessages.has(messageId) || processingMessages.has(messageId)) {
        return res.sendStatus(200);
      }

      processingMessages.add(messageId);
    }

    const from = message.from;
const state = getState(from);
if (state.closed) {
  return res.sendStatus(200);
}
     
if (from === process.env.CONSULTANT_PHONE) {
  const toLead = message.to;

  if (toLead) {
    await updateLeadStatus(toLead, "em_atendimento");
  }
}

clearTimers(from);
    state.closed = false;

  let text = "";

if (message.text?.body) {
  text = message.text.body.trim();

  // 🔥 Aguarda alguns segundos para ver se o lead vai mandar mais mensagens
  const buffered = await collectBufferedText(from, text, messageId);

  // Se esta mensagem foi apenas adicionada ao buffer,
  // encerra este webhook sem chamar a IA.
  if (!buffered.shouldContinue) {
    return res.sendStatus(200);
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

    return res.sendStatus(200);
  }
} else {
  await sendWhatsAppMessage(
    from,
    "No momento consigo te atender melhor por texto ou áudio 😊 Pode me enviar sua dúvida?"
  );

  return res.sendStatus(200);
}

// 🔥 carrega histórico antes de classificar
let history = await loadConversation(from);

let currentLead = await loadLeadProfile(from);

if (!currentLead) {
  await saveLeadProfile(from, {
    user: from,
    telefoneWhatsApp: from,
    ultimaMensagem: text,
    faseQualificacao: "inicio",
    status: "novo"
  });

  currentLead = await loadLeadProfile(from);
} else {
  await saveLeadProfile(from, {
    ultimaMensagem: text,
    telefoneWhatsApp: from
  });
}
     
const historyText = history
  .filter(m => m.role === "user")
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

const podeTentarExtrairDados =
  fasesQuePermitemExtracao.includes(currentLead?.faseQualificacao) ||
  mensagemPareceConterDados;

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

  return res.sendStatus(200);
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

  return res.sendStatus(200);
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

const msg = `Identifiquei seu ${labelParaMostrar} como: ${valorParaMostrar}

Está correto?`;
   
  await sendWhatsAppMessage(from, msg);
  await saveHistoryStep(from, history, text, msg, !!message.audio?.id);

  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return res.sendStatus(200);
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

      return res.sendStatus(200);
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
  aguardandoConfirmacao: true,
  dadosConfirmadosPeloLead: false,
  faseQualificacao: "aguardando_confirmacao_dados",
  status: "aguardando_confirmacao_dados"
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

    return res.sendStatus(200);
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

    return res.sendStatus(200);
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

  return res.sendStatus(200);
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

  return res.sendStatus(200);
}

const leadStatus = classifyLead(text, extractedData, history);
const missingFields = getMissingLeadFields(extractedData);
const awaitingConfirmation = currentLead?.faseQualificacao === "aguardando_confirmacao_dados";

// 🔥 ATUALIZA STATUS / FASE DO CRM COM BASE NA CLASSIFICAÇÃO
// Antes o sistema classificava, mas não salvava no Mongo.
// Por isso o dashboard não mudava de status.
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
    pre_analise: "pre_analise"
  };

  const faseMap = {
    frio: "perdido",
    morno: "morno",
    qualificando: "qualificando",
    pre_analise: "pre_analise"
  };

  await saveLeadProfile(from, {
    status: statusMap[leadStatus] || leadStatus,
    faseQualificacao: faseMap[leadStatus] || leadStatus
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

  return res.sendStatus(200);
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
  }

  await notifyConsultant({
    user: from,
    telefoneWhatsApp: from,
    ultimaMensagem: text,
    status: "quente"
  });

  const confirmedMsg = "Perfeito, dados confirmados ✅ Vou encaminhar sua pré-análise para a equipe interna da IQG. Se estiver tudo certo, o próximo passo será a fase contratual.";

  await sendWhatsAppMessage(from, confirmedMsg);
   state.closed = true;
clearTimers(from);
   await saveHistoryStep(from, history, text, confirmedMsg, !!message.audio?.id);
   
  if (messageId) {
    markMessageAsProcessed(messageId);
  }

  return res.sendStatus(200);
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

  return res.sendStatus(200);
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

  return res.sendStatus(200);
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
          ...history
        ]
      })
    });

    const data = await openaiResponse.json();

    if (!openaiResponse.ok) {
      console.error("Erro OpenAI:", data);
      throw new Error("Falha ao chamar OpenAI");
    }

   const rawResposta = data.choices?.[0]?.message?.content || "Olá 😊";

const { cleanReply, actions } = extractActions(rawResposta);
const resposta = cleanReply || "Olá 😊";
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
  isPositiveConfirmation(text) &&
  (
    historyText.includes("ficou claro") ||
    historyText.includes("posso seguir") ||
    historyText.includes("podemos seguir")
  );

const podeIniciarColeta =
  jaExplicouPrograma &&
  jaFalouBeneficios &&
  jaFalouRegras &&
  jaFalouInvestimento &&
  leadConfirmouCiencia;

const startedDataCollection =
  respostaLower.includes("primeiro, pode me enviar seu nome completo") ||
  respostaLower.includes("pode me enviar seu nome completo") ||
  respostaLower.includes("vamos seguir com a pré-análise") ||
  respostaLower.includes("seguir com a pré-análise aos poucos");

if (
  startedDataCollection &&
  currentLead?.faseQualificacao !== "coletando_dados"
) {
  await saveLeadProfile(from, {
    faseQualificacao: "coletando_dados",
    status: "coletando_dados",
    campoEsperado: "nome"
  });
}

let respostaFinal = resposta;
     
     // 🚫 BLOQUEIO: se o folder já foi enviado, não oferecer material de novo
if (
  state.sentFiles.folder &&
  /material|folder|te mandar|mandar o material|enviar o material|te enviar/i.test(respostaFinal)
) {
  respostaFinal = "Esse material já te enviei logo acima 😊\n\nConseguiu dar uma olhada? Fez sentido pra você ou quer que eu te explique os pontos principais?";
}
     
     const mencionouPreAnalise =
  /pre[-\s]?analise|pré[-\s]?análise/i.test(respostaFinal);

if (mencionouPreAnalise && !podeIniciarColeta) {
  respostaFinal = state.sentFiles.folder
    ? "Antes de avançarmos, deixa eu te explicar melhor como funciona o programa 😊\n\nEle é uma parceria onde você vende direto da indústria, com suporte, materiais e possibilidade de margem interessante.\n\nMas também tem algumas responsabilidades, como cuidar do estoque, atender clientes e manter uma boa comunicação com a equipe.\n\nComo o material já está logo acima, posso te explicar os principais pontos por aqui. Quer que eu resuma?"
    : "Antes de avançarmos, deixa eu te explicar melhor como funciona o programa 😊\n\nEle é uma parceria onde você vende direto da indústria, com suporte, materiais e possibilidade de margem interessante.\n\nMas também tem algumas responsabilidades, como cuidar do estoque, atender clientes e manter uma boa comunicação com a equipe.\n\nSe fizer sentido, posso te explicar os principais pontos ou te mandar um material. O que você prefere?";
}

// 🚨 BLOQUEIO DE COLETA PREMATURA
if (startedDataCollection && !podeIniciarColeta) {
  const jaEnviouFolder = state.sentFiles?.folder === true;

  respostaFinal = jaEnviouFolder
    ? "Antes de seguirmos, só quero alinhar melhor como funciona o programa 😊\n\nEle é uma parceria onde você vende direto da indústria, com suporte, materiais e possibilidade de margem interessante.\n\nMas também tem algumas responsabilidades, como cuidar do estoque, atender clientes e manter uma boa comunicação com a equipe.\n\nComo o material já está logo acima na conversa, posso te explicar os principais pontos por aqui. Quer que eu resuma de forma bem objetiva?"
    : "Antes de seguirmos, só quero te explicar melhor como funciona o programa 😊\n\nEle é uma parceria onde você vende direto da indústria, com suporte, materiais e possibilidade de margem interessante.\n\nMas também tem algumas responsabilidades, como cuidar do estoque, atender clientes e manter uma boa comunicação com a equipe.\n\nSe fizer sentido, posso te enviar um material explicando melhor. Quer dar uma olhada?";
}
     

// 🔥 BLOQUEIO: impedir pedido de múltiplos dados
const multiDataRequestPattern =
  /nome.*cpf.*telefone.*cidade|cpf.*nome.*telefone|telefone.*cpf.*cidade/i;

if (multiDataRequestPattern.test(respostaFinal)) {
  respostaFinal = "Perfeito 😊 Vamos fazer passo a passo.\n\nPrimeiro, pode me enviar seu nome completo?";
}

// 🔥 Simulação avançada de digitação humana

const typingTime = humanDelay(respostaFinal);

// pausa de leitura da mensagem do cliente
await delay(1000);

// simula "pensando"
await delay(800);

// simula digitação proporcional ao tamanho
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

// 🔥 follow-up só após alguma interação maior
if (history.length > 3) {
  scheduleInactivityFollowup(from);
}

    if (messageId) {
      processingMessages.delete(messageId);
      processedMessages.set(messageId, Date.now());
    }

    return res.sendStatus(200);

  } catch (error) {
    if (messageId) {
      processingMessages.delete(messageId);
    }

    console.error("Erro no webhook:", error);
    return res.sendStatus(500);
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
    const search = req.query.q || "";
    const sort = req.query.sort || "updatedAt";
    const dir = req.query.dir === "asc" ? 1 : -1;

    const query = {};

    if (statusFilter) {
      query.status = statusFilter;
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
      return `/dashboard?sort=${field}&dir=${nextDir}${statusFilter ? `&status=${statusFilter}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}${senhaParam}`;
    };

    const rows = leads.map(lead => {
      const phone = lead.telefoneWhatsApp || lead.user || "";
      const waLink = phone ? `https://wa.me/${phone}` : "#";
      const { cidade, estado } = splitCidadeEstado(lead.cidadeEstado);

      const status = lead.status || "novo";
      const user = encodeURIComponent(lead.user || phone);

      const baseStatusLink = `/lead/${user}/status`;

      return `
        <tr>
          <td><span class="badge ${status}">${escapeHtml(status)}</span></td>
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

            <button type="submit">Filtrar</button>
            <button type="button" onclick="printCRM()">Imprimir</button>
          </form>

          <div class="print-info">
            Exibindo ${leads.length} lead(s). Clique nos títulos das colunas para ordenar.
          </div>

          <table>
            <thead>
              <tr>
                <th><a href="${makeSortLink("status", "Status")}">Status</a></th>
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
              ${rows || `<tr><td colspan="8">Nenhum lead encontrado.</td></tr>`}
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
   
app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando...");
});
