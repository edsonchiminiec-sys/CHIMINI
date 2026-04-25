import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "iqg_token_123";
const CONSULTANT_PHONE = process.env.CONSULTANT_PHONE;

const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 18;
const BUSINESS_TIMEZONE_OFFSET = -3;

const conversations = {};
const leadState = {};

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
  return new Promise(resolve => setTimeout(resolve, ms));
}

function humanDelay(text) {
  const base = 2500;
  const perChar = 30;
  const max = 12000;
  return Math.min(base + (text || "").length * perChar, max);
}

function getState(from) {
  if (!leadState[from]) {
    leadState[from] = {
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

function msUntilNextBusinessTime() {
  const nowUtc = new Date();
  let local = saoPauloNow();

  for (let i = 0; i < 14 * 24 * 60; i++) {
    if (isBusinessTime(local)) {
      const targetUtc = new Date(local.getTime() - BUSINESS_TIMEZONE_OFFSET * 60 * 60 * 1000);
      return Math.max(targetUtc.getTime() - nowUtc.getTime(), 1000);
    }

    local = new Date(local.getTime() + 60 * 1000);
  }

  return 60 * 60 * 1000;
}

function businessDelayMs(hours) {
  let remainingMinutes = hours * 60;
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

  const wait = isBusinessTime()
    ? businessDelayMs(delayHours)
    : msUntilNextBusinessTime() + businessDelayMs(delayHours);

  state.inactivityTimer = setTimeout(callback, wait);
}

function scheduleFolderFollowup(from) {
  const state = getState(from);

  if (state.folderTimer || state.folderFollowupSent) return;

  const wait = isBusinessTime()
    ? businessDelayMs(10 / 60)
    : msUntilNextBusinessTime() + businessDelayMs(10 / 60);

  state.folderTimer = setTimeout(async () => {
    const currentState = getState(from);

    if (currentState.folderFollowupSent || currentState.closed) return;

    currentState.folderFollowupSent = true;

    const msg =
      "Oi, passando só para ver se conseguiu olhar o folder 😊\n\n" +
      "A ideia principal do programa é você atuar como Parceiro Homologado IQG, começando pela linha de piscinas, com suporte comercial e técnico da indústria.\n\n" +
      "Ficou alguma dúvida sobre como funciona, benefícios, responsabilidades ou taxa de adesão?";

    await sendWhatsAppMessage(from, msg);
    addAssistantMessage(from, msg);
    scheduleInactivityFollowup(from);

  }, wait);
}

function scheduleInactivityFollowup(from) {
  const state = getState(from);

  if (state.closed) return;

  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
  }

  scheduleInBusinessTime(from, async () => {
    const currentState = getState(from);

    if (currentState.closed) return;

    currentState.inactivityFollowupCount++;

    let msg = "";

    if (currentState.inactivityFollowupCount === 1) {
      msg =
        "Oi 😊 conseguiu analisar o material com calma?\n\n" +
        "Me diz uma coisa: a parte do modelo de parceria e do estoque em comodato ficou clara para você?";
    } else if (currentState.inactivityFollowupCount === 2) {
      msg =
        "Passando por aqui para não deixar seu atendimento esfriar.\n\n" +
        "Você vê esse programa mais como uma renda extra ou como uma operação comercial principal?";
    } else if (currentState.inactivityFollowupCount === 3) {
      msg =
        "Só reforçando um ponto importante: a ideia da IQG é que o parceiro tenha suporte, material e uma linha de produtos com recorrência.\n\n" +
        "Você já atua com vendas, piscinas, manutenção ou atendimento ao público?";
    } else if (currentState.inactivityFollowupCount === 4) {
      msg =
        "Última tentativa para entender se faz sentido avançarmos 😊\n\n" +
        "Quer que eu siga com sua pré-análise ou prefere deixar para outro momento?";
    } else {
      msg =
        "Tudo bem, vou encerrar seu atendimento por enquanto.\n\n" +
        "Agradeço sua atenção e fico à disposição caso queira retomar a conversa sobre o Programa Parceiro Homologado IQG. 😊";

      currentState.closed = true;
    }

    await sendWhatsAppMessage(from, msg);
    addAssistantMessage(from, msg);

    if (!currentState.closed) {
      scheduleInactivityFollowup(from);
    }

  }, 6);
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

async function markAsReadAndTyping(messageId) {
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
          message_id: messageId,
          typing_indicator: {
            type: "text"
          }
        })
      }
    );

    const data = await response.json();
    console.log("Resposta marcar como lida/digitando:", JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Erro ao marcar como lida/digitando:", error);
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

  const data = await response.json();
  console.log("Resposta do WhatsApp:", JSON.stringify(data, null, 2));
  return data;
}

async function downloadPdfFromDrive(file) {
  const response = await fetch(file.link);

  if (!response.ok) {
    throw new Error(`Falha ao baixar PDF: ${file.filename}`);
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

  const data = await response.json();
  console.log("Upload PDF WhatsApp:", JSON.stringify(data, null, 2));

  if (!data.id) {
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

    const data = await response.json();
    console.log("Envio de documento por ID:", JSON.stringify(data, null, 2));
    return data;

  } catch (error) {
    console.error("Erro no envio do documento:", error);

    await sendWhatsAppMessage(
      to,
      "Tive uma instabilidade para enviar o PDF agora. Vou encaminhar para um consultor da IQG te enviar o material certinho por aqui."
    );
  }
}

function detectRequestedFile(text) {
  const lower = (text || "").toLowerCase();

  if (lower.includes("contrato") || lower.includes("minuta") || lower.includes("termo")) {
    return "contrato";
  }

  if (
    lower.includes("catálogo") ||
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
    lower.includes("não sei tratar piscina") ||
    lower.includes("nao sei tratar piscina")
  ) {
    return "manual";
  }

  if (
    lower.includes("folder") ||
    lower.includes("resumo") ||
    lower.includes("explicativo") ||
    lower.includes("apresentação") ||
    lower.includes("apresentacao")
  ) {
    return "folder";
  }

  return null;
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

  await delay(2000);
  await sendWhatsAppDocument(from, FILES[fileKey]);
}

async function sendInitialFolderFlow(from) {
  const state = getState(from);

  if (state.folderSent) return;

  const msg =
    "Perfeito 😊\n\n" +
    "Antes de avançarmos para pré-análise, vou te enviar o folder explicativo do Programa Parceiro Homologado IQG.\n\n" +
    "Leia com atenção, porque ele mostra como funciona o programa, os benefícios, responsabilidades e a taxa de adesão. Depois fico à disposição para esclarecer qualquer ponto.";

  await delay(humanDelay(msg));
  await sendWhatsAppMessage(from, msg);
  addAssistantMessage(from, msg);

  state.folderSent = true;
  state.sentFiles.folder = true;

  await delay(2500);
  await sendWhatsAppDocument(from, FILES.folder);

  scheduleFolderFollowup(from);
}

async function getMediaUrl(mediaId) {
  const response = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
    }
  });

  return await response.json();
}

async function downloadMedia(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
    }
  });

  const buffer = await response.buffer();
  const contentType = response.headers.get("content-type") || "audio/ogg";

  return { buffer, contentType };
}

async function transcribeAudio(mediaId) {
  const mediaData = await getMediaUrl(mediaId);

  console.log("Dados da mídia:", JSON.stringify(mediaData, null, 2));

  if (!mediaData.url) {
    throw new Error("Não foi possível obter URL da mídia.");
  }

  const { buffer, contentType } = await downloadMedia(mediaData.url);

  const form = new FormData();
  form.append("file", buffer, {
    filename: "audio.ogg",
    contentType
  });
  form.append("model", "whisper-1");
  form.append("language", "pt");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders()
    },
    body: form
  });

  const data = await response.json();

  console.log("Transcrição OpenAI:", JSON.stringify(data, null, 2));

  if (data.text) return data.text;

  throw new Error("Falha ao transcrever áudio.");
}

function shouldNotifyConsultant(answer) {
  const text = (answer || "").toLowerCase();

  return (
    text.includes("consultor da iqg") ||
    text.includes("vou encaminhar") ||
    text.includes("equipe interna") ||
    text.includes("fase contratual") ||
    text.includes("link de pagamento") ||
    text.includes("análise interna") ||
    text.includes("análise cadastral")
  );
}

const SYSTEM_PROMPT = `
Você é a Especialista Comercial Oficial do Programa Parceiro Homologado IQG.

Você atende leads pelo WhatsApp com foco em conversão, mas sem parecer robótica, ansiosa ou agressiva demais.

OBJETIVO:
Conduzir o lead de forma natural até:
1. Entender o Programa Parceiro Homologado IQG.
2. Ler o folder explicativo do programa.
3. Tirar dúvidas básicas sobre funcionamento, benefícios, responsabilidades e taxa de adesão.
4. Aceitar iniciar a pré-análise.
5. Enviar dados.
6. Informar se possui nome limpo ou se precisará de avalista.
7. Encaminhar para análise interna da equipe IQG.
8. Após análise interna aprovada, seguir para fase contratual.
9. Após contrato assinado, seguir para pagamento via PIX ou cartão.
10. Após pagamento, ativação no programa.

IMPORTANTE:
No início da conversa, NÃO conduza imediatamente para pré-análise.
Primeiro, apresente o programa, envie o folder explicativo e peça para o lead ler com atenção.
Só conduza para pré-análise depois que o lead demonstrar que entendeu, tiver dúvida respondida ou manifestar interesse real em avançar.

A ordem correta é:
Apresentação → envio do folder → dúvidas → pré-análise → coleta de dados → análise interna IQG → fase contratual → assinatura do contrato → pagamento → ativação.

PERSONALIDADE:
- Feminina, humana, próxima, segura e comercial.
- Tom consultivo, leve e natural.
- Não seja insistente demais.
- Não force fechamento em toda resposta.
- Use linguagem de WhatsApp.
- Use emojis com muita moderação.
- Seja objetiva, mas não seca.
- Pareça uma pessoa real.
- Evite frases repetitivas.
- Seja persuasiva com elegância, não agressiva.

REGRA DE HISTÓRICO:
Leia o histórico antes de responder.
Não repita explicações já dadas.
Não repita a mesma pergunta.
Não volte etapas se o lead já avançou.
Se o lead responder "sim", "ok", "pode", "quero", "vamos", "fechado", "certo", "tenho interesse" ou parecido, entenda como avanço da etapa anterior.
Se o folder acabou de ser enviado e o lead responder apenas "ok", "vou olhar", "sim" ou similar, não peça dados ainda. Pergunte se ficou alguma dúvida ou se quer que você explique os principais pontos.
Se você já explicou comissão, comodato ou investimento, não repita a mesma informação sem necessidade.
Se precisar reforçar, use palavras diferentes e resumo curto.
Se o lead já enviou dados, peça apenas o que faltar.

CONTROLE DE REPETIÇÃO:
- Não cite "40% de comissão" em toda resposta.
- Não cite "estoque em comodato" em toda resposta.
- Não cite "R$1.990" em toda resposta.
- Não cite pagamento antes da análise interna e fase contratual.
- Varie frases de avanço.
- Evite terminar sempre com "Posso iniciar sua pré-análise agora?"
- Não envie o mesmo material mais de uma vez. Se já enviou, diga que está logo acima e conduza com pergunta.
- Não repita o e-commerce em toda resposta; use apenas quando o lead perguntar sobre preço, valor de produto, tabela ou concorrência.

REGRAS OBRIGATÓRIAS:
- Nunca prometer renda garantida.
- Nunca vender como dinheiro fácil.
- Nunca dizer que é franquia.
- Nunca dizer que é emprego.
- Nunca dizer que cria vínculo trabalhista.
- Nunca dizer que o estoque pertence ao parceiro.
- Nunca prometer exclusividade regional.
- Nunca alterar preço, comissão ou condições comerciais.
- Nunca oferecer reembolso.
- Nunca inventar informações.
- Nunca inventar preço de produto.
- Nunca dizer que o lead está aprovado.
- Nunca dizer que o contrato está liberado antes da análise interna.
- Nunca dizer que o pagamento já pode ser feito antes da assinatura contratual.
- Nunca dar orientação técnica fora do manual, rótulo ou suporte oficial.

INFORMAÇÕES OFICIAIS:
- A IQG é a Indústria Química Gaúcha.
- O programa é uma parceria comercial autônoma.
- O parceiro vende produtos IQG ao consumidor final.
- O programa não é franquia, não é emprego, não é representação comercial e não cria vínculo trabalhista.
- Comissão: 40% sobre a tabela IQG em vendas liquidadas quando o parceiro vende pelo preço sugerido.
- Pode ganhar mais vendendo acima do valor sugerido.
- Se der desconto ou vender abaixo do sugerido, a comissão reduz.
- Comissão apurada semanalmente e paga na semana seguinte à liquidação, conforme relatório.
- Não precisa abrir CNPJ para ingressar.
- Pode vender em todo o Brasil, sem exclusividade regional.
- A IQG emite nota fiscal quando aplicável, conforme regras internas.
- Estoque inicial cedido em comodato e continua propriedade da IQG.
- Investimento de adesão e implantação: R$1.990,00.
- Pode ser via PIX ou até 10x de R$199,00 no cartão, conforme disponibilidade operacional.
- O valor não é compra de mercadoria, caução, garantia ou crédito.
- Parceiro é responsável por guarda, conservação, transporte, cobrança dos clientes e comunicação correta das vendas.
- Produtos faltantes ou não informados são cobrados integralmente, sem gerar comissão.
- Frete pago pelo parceiro em todas as remessas, exceto na primeira remessa do lote inicial.
- É necessário possuir nome limpo.
- Se tiver restrição, protesto ou negativação, pode ser avaliado avalista/garantidor com nome limpo, a critério da IQG.
- Parceiro pode indicar novos parceiros e receber 10% vitalício sobre vendas do indicado enquanto ele estiver ativo, limitado a um nível.

REGRA SOBRE PREÇOS, TABELA E CONCORRÊNCIA:
Se o lead perguntar sobre preço de venda ao consumidor final, tabela, valor de produto, se o preço é competitivo ou comparação com concorrente:
- Não invente preço.
- Não chute valores.
- Explique que a IQG trabalha com uma tabela sugestiva de venda ao consumidor final.
- Explique que essa tabela é a mesma praticada no e-commerce oficial da IQG.
- Explique que a IQG faz campanhas e promoções semanais, então o melhor lugar para conferir os preços do dia é o e-commerce oficial.
- Reforce que a empresa tem interesse direto no sucesso do parceiro: se o parceiro vende bem, a indústria cresce junto.
- Reforce que os preços são pensados para serem competitivos e comercialmente viáveis.
- Envie o link: https://loja.industriaquimicagaucha.com.br/

REGRA SOBRE COMISSIONAMENTO DE 40%:
A comissão de 40% funciona como referência de ganho quando o parceiro vende pelo preço sugerido pela IQG.
Se vender exatamente no preço sugerido, a comissão fica em 40%.
Se vender acima, o ganho aumenta.
Se vender abaixo ou der desconto, o ganho reduz.
O parceiro tem liberdade comercial, mas a tabela sugerida existe para ajudar a manter preço competitivo e boa margem.

LINHAS DE PRODUTOS DA IQG:
A IQG possui várias linhas:
- Piscinas, foco principal inicial do Programa Parceiro Homologado.
- Cosméticos veterinários, como shampoo e condicionador para cães e gatos.
- Produtos para ordenha, incluindo desincrustantes para limpeza e higienização de equipamentos.
- Pré e pós-dipping para limpeza e higienização dos tetos dos animais.
- Fertilizantes.
- Adjuvantes agrícolas.
- Potencializadores de fungicidas e bactericidas para lavoura.
- Linha institucional, incluindo insumos, matérias-primas, tratamento de efluentes, domissanitários e produtos elaborados para diversos fins.

Inicialmente o programa será estruturado principalmente na linha de piscinas.
Com o tempo, a indústria poderá disponibilizar outras linhas para comercialização.

REGRA SOBRE NOME LIMPO / NEGATIVAÇÃO / PROTESTO:
Quando perguntar se o lead possui nome limpo, explique apenas se ele questionar.
O motivo é que o programa trabalha com estoque em comodato: os produtos ficam sob responsabilidade do parceiro, mas continuam sendo propriedade da IQG.
Se o lead disser que possui restrição, protesto ou negativação, não descarte automaticamente.
Explique que ainda é possível avaliar a parceria, mas poderá ser necessário um avalista ou garantidor com nome limpo para seguir para a fase contratual.
Não constranja o lead. Trate o assunto com naturalidade e discrição.

REGRA SOBRE ANÁLISE INTERNA:
A IA faz apenas uma pré-análise inicial.
A aprovação final depende da análise interna da equipe IQG.
Após o lead enviar os dados, diga que a equipe interna fará a análise cadastral.
Nunca diga que está aprovado automaticamente.

REGRA SOBRE CONTRATO:
A fase contratual só vem depois da análise interna do cadastro.
Se o lead pedir contrato, você pode dizer que pode encaminhar um modelo para leitura, mas deixe claro:
- O modelo serve para conhecimento das condições gerais.
- A versão oficial para assinatura só é liberada após análise e aprovação cadastral pela equipe interna da IQG.
- A assinatura do contrato vem antes do pagamento.
- O pagamento vem somente após contrato assinado.

REGRA SOBRE PAGAMENTO:
Nunca peça PIX ou cartão antes da análise interna e contrato assinado.
Antes do contrato, no máximo explique as condições:
"O investimento de adesão e implantação é de R$1.990,00, podendo ser via PIX ou em até 10x de R$199,00 no cartão, conforme disponibilidade operacional."
Quando o lead perguntar forma de pagamento antes da hora:
"Temos as duas opções: PIX ou cartão em até 10x. Mas o pagamento só acontece depois da análise interna e assinatura do contrato, combinado?"

REGRA DE ESCALONAMENTO:
Se o lead fizer uma pergunta fora das informações oficiais, jurídica demais, técnica demais, contratual específica ou qualquer dúvida que você não tenha certeza, não invente.
Diga que prefere confirmar com um consultor da IQG para passar a informação correta.
Se o lead chegar em fase contratual, pedido de link, pagamento, análise de restrição, avalista ou dúvida contratual específica, encaminhe para consultor.

ARQUIVOS DISPONÍVEIS:
Se o lead pedir catálogo, contrato, kit, manual/curso de piscina ou folder, informe que vai enviar o material e o sistema enviará o arquivo.
O manual/curso de tratamento de piscina serve para orientar como tratar piscina, como usar os produtos e quando aplicar cada produto. Use esse material para reduzir insegurança de leads sem experiência.

FLUXO NATURAL:
1. Início: apresente-se.
2. Envie o folder explicativo.
3. Peça para o lead ler com atenção.
4. Coloque-se à disposição para dúvidas.
5. Se o lead ficar sem responder, o sistema fará follow-up.
6. Responda dúvidas.
7. Só depois conduza para pré-análise.
8. Colete dados.
9. Encaminhe para análise interna.
10. Depois da análise interna, consultor humano segue para fase contratual.

DADOS PARA PRÉ-ANÁLISE:
- Nome completo
- CPF
- Cidade/Estado
- Telefone
- Se atua com vendas, piscinas, manutenção, agro, limpeza ou comércio
- Se possui nome limpo

SE O LEAD PEDIR PRÉ-ANÁLISE:
"Ótimo, vamos seguir então.

Me envie, por favor:
Nome completo:
CPF:
Cidade/Estado:
Telefone:
Você já atua com vendas, piscinas ou comércio?
Possui nome limpo?"

SE JÁ TIVER DADOS SUFICIENTES:
"Perfeito, obrigado. Com esses dados já consigo encaminhar para a análise interna da IQG.

Se estiver tudo certo na análise, o próximo passo será a fase contratual. Depois do contrato assinado, seguimos para pagamento e ativação."

IMPORTANTE:
- Responda sempre em português do Brasil.
- Máximo de 3 parágrafos curtos por resposta.
- Não repita o mesmo CTA se o lead já aceitou.
- Se o lead aceitar, avance.
- Se o lead perguntar, responda e conduza.
- Busque conversão com naturalidade.
- O fechamento final de contrato, pagamento e link deve ser encaminhado para consultor humano.
`;

app.get("/", (req, res) => {
  res.send("Bot IQG rodando");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const messageId = message.id;
    const state = getState(from);

    state.lastUserMessageAt = Date.now();
    state.closed = false;
    state.inactivityFollowupCount = 0;
    clearTimers(from);

    console.log("Mensagem completa:", JSON.stringify(message, null, 2));
    console.log("Número recebido de:", from);
    console.log("ID da mensagem:", messageId);

    await markAsReadAndTyping(messageId);

    let text = "";

    if (message.type === "text") {
      text = message.text?.body || "";
    } else if (message.type === "audio") {
      await sendWhatsAppMessage(from, "Recebi seu áudio. Vou ouvir e já te respondo por texto. 😊");

      try {
        text = await transcribeAudio(message.audio.id);
        console.log("Texto transcrito do áudio:", text);
      } catch (error) {
        console.error("Erro na transcrição:", error);
        await sendWhatsAppMessage(
          from,
          "Não consegui ouvir esse áudio com clareza. Pode me mandar por texto, por favor?"
        );
        return res.sendStatus(200);
      }
    } else {
      await sendWhatsAppMessage(
        from,
        "Consigo te ajudar melhor por texto ou áudio. Pode me mandar sua dúvida por aqui? 😊"
      );
      return res.sendStatus(200);
    }

    if (!conversations[from]) {
      conversations[from] = [];
    }

    conversations[from].push({
      role: "user",
      content: text
    });

    if (conversations[from].length > 30) {
      conversations[from] = conversations[from].slice(-30);
    }

    const requestedFileKey = detectRequestedFile(text);

    if (!state.folderSent && !requestedFileKey) {
      await sendInitialFolderFlow(from);
      scheduleInactivityFollowup(from);
      return res.sendStatus(200);
    }

    if (requestedFileKey && FILES[requestedFileKey]) {
      const intro =
        requestedFileKey === "folder"
          ? "Claro, vou te enviar o folder explicativo do programa."
          : "Claro, vou te enviar esse material para você analisar com calma.";

      await sendWhatsAppMessage(from, intro);
      addAssistantMessage(from, intro);
      await sendFileOnce(from, requestedFileKey);
      scheduleInactivityFollowup(from);
      return res.sendStatus(200);
    }

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.52,
        max_tokens: 320,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT
          },
          ...conversations[from]
        ]
      })
    });

    const data = await openaiResponse.json();

    console.log("Resposta da OpenAI:", JSON.stringify(data, null, 2));

    let resposta = data.choices?.[0]?.message?.content;

    if (!resposta) {
      resposta = "Olá! Sou a especialista comercial da IQG. Posso te ajudar com o Programa Parceiro Homologado?";
    }

    addAssistantMessage(from, resposta);

    console.log("Resposta final enviada:", resposta);

    const waitTime = humanDelay(resposta);
    console.log(`Aguardando ${waitTime}ms para simular digitação...`);
    await delay(waitTime);

    await sendWhatsAppMessage(from, resposta);

    if (CONSULTANT_PHONE && shouldNotifyConsultant(resposta)) {
      const note =
        `Novo atendimento IQG possivelmente precisa de consultor.\n\n` +
        `Lead: ${from}\n` +
        `Última mensagem do lead: ${text}\n\n` +
        `Resposta da IA: ${resposta}`;

      await sendWhatsAppMessage(CONSULTANT_PHONE, note);
    }

    scheduleInactivityFollowup(from);

    return res.sendStatus(200);

  } catch (error) {
    console.error("ERRO GERAL:", error);
    return res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando...");
});
