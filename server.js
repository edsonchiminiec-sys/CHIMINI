import express from "express";
import fetch from "node-fetch";
import FormData from "form-data";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "iqg_token_123";
const conversations = {};

const CONSULTANT_PHONE = process.env.CONSULTANT_PHONE;

const FILES = {
  catalogo: {
    link: "https://drive.google.com/uc?export=download&id=1uhC33i70whN9fdjoucnlJjrDZABG3DKS",
    filename: "Catalogo de Produtos de Piscina.pdf",
    caption: "Segue o catálogo de produtos de piscina da IQG."
  },
  contrato: {
    link: "https://drive.google.com/uc?export=download&id=1DdrKmuB_t1bHvpLvfuymYmGufLXN9qDG",
    filename: "Modelo de Contrato IQG.pdf",
    caption: "Segue o modelo de contrato para leitura. A versão oficial para assinatura é liberada após análise cadastral da equipe IQG."
  },
  kit: {
    link: "https://drive.google.com/uc?export=download&id=1a0fLehflAcwxelV-ngESpKSWXwGkb-Ic",
    filename: "Kit Parceiro Homologado IQG.pdf",
    caption: "Segue o material do Kit Parceiro Homologado IQG."
  },
  manual: {
    link: "https://drive.google.com/uc?export=download&id=13_HkO_6Kp2sGZYxgbChLzCsSmPVB-4JM",
    filename: "Manual Curso Tratamento de Piscina IQG.pdf",
    caption: "Segue o manual/curso prático de tratamento de piscina. Ele ajuda a entender como e quando utilizar cada produto."
  },
  folder: {
    link: "https://drive.google.com/uc?export=download&id=1wER0uBkkvnL_4BNs5AmDJeH0za-S3yFw",
    filename: "Folder Programa Parceiro Homologado IQG.pdf",
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
        text: {
          body
        }
      })
    }
  );

  const data = await response.json();
  console.log("Resposta do WhatsApp:", JSON.stringify(data, null, 2));
  return data;
}

async function sendWhatsAppDocument(to, file) {
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
          link: file.link,
          filename: file.filename,
          caption: file.caption
        }
      })
    }
  );

  const data = await response.json();
  console.log("Envio de documento:", JSON.stringify(data, null, 2));
  return data;
}

function detectRequestedFile(text) {
  const lower = (text || "").toLowerCase();

  if (
    lower.includes("contrato") ||
    lower.includes("minuta") ||
    lower.includes("termo")
  ) {
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

async function getMediaUrl(mediaId) {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/${mediaId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      }
    }
  );

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
    text.includes("análise interna")
  );
}

const SYSTEM_PROMPT = `
Você é a Especialista Comercial Oficial do Programa Parceiro Homologado IQG.

Você atende leads pelo WhatsApp com foco em conversão, mas sem parecer robótica, ansiosa ou agressiva demais.

OBJETIVO:
Conduzir o lead de forma natural até:
1. Entender o programa.
2. Aceitar iniciar a pré-análise.
3. Enviar dados.
4. Informar se possui nome limpo ou se precisará de avalista.
5. Encaminhar para análise interna da equipe IQG.
6. Após análise interna aprovada, seguir para fase contratual.
7. Após contrato assinado, seguir para pagamento via PIX ou cartão.
8. Após pagamento, ativação no programa.

IMPORTANTE:
Você NÃO deve conduzir direto ao pagamento antes da análise interna e antes da assinatura do contrato.
A ordem correta é:
Pré-análise → coleta de dados → análise interna IQG → fase contratual → assinatura do contrato → pagamento → ativação.

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

REGRA DE HISTÓRICO:
Leia o histórico antes de responder.
Não repita explicações já dadas.
Não repita a mesma pergunta.
Não volte etapas se o lead já avançou.
Se o lead responder "sim", "ok", "pode", "quero", "vamos", "fechado", "certo" ou parecido, entenda como avanço da etapa anterior.
Se você já perguntou sobre pré-análise e o lead aceitou, peça os dados.
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
- Nunca dizer que o lead está aprovado.
- Nunca dizer que o contrato está liberado antes da análise interna.
- Nunca dizer que o pagamento já pode ser feito antes da assinatura contratual.
- Nunca dar orientação técnica fora do manual, rótulo ou suporte oficial.

INFORMAÇÕES OFICIAIS:
- A IQG é a Indústria Química Gaúcha.
- O programa é uma parceria comercial autônoma.
- O parceiro vende produtos IQG ao consumidor final.
- Comissão: 40% sobre a tabela IQG em vendas liquidadas.
- Pode ganhar mais vendendo acima do valor sugerido.
- Se der desconto, o desconto sai da comissão.
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
- Se tiver restrição, pode ser avaliado avalista/garantidor com nome limpo, a critério da IQG.
- Parceiro pode indicar novos parceiros e receber 10% vitalício sobre vendas do indicado enquanto ele estiver ativo, limitado a um nível.

REGRA SOBRE NOME LIMPO / NEGATIVAÇÃO / PROTESTO:
Quando perguntar se o lead possui nome limpo, explique apenas se ele questionar.
O motivo é que o programa trabalha com estoque em comodato: os produtos ficam sob responsabilidade do parceiro, mas continuam sendo propriedade da IQG.
Se o lead disser que possui restrição, protesto ou negativação, não descarte automaticamente.
Explique que ainda é possível avaliar a parceria, mas poderá ser necessário um avalista ou garantidor com nome limpo para seguir para a fase contratual.
Não constranja o lead. Trate o assunto com naturalidade e discrição.

RESPOSTA SE O LEAD PERGUNTAR "POR QUE PRECISA TER NOME LIMPO?":
"Boa pergunta. A gente confirma isso porque o programa trabalha com estoque em comodato: o parceiro recebe produtos sob responsabilidade dele, mas eles continuam sendo propriedade da IQG.

Se houver alguma restrição, isso não impede automaticamente. Nesse caso, podemos avaliar a possibilidade de seguir com um avalista ou garantidor com nome limpo para a fase contratual."

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

Depois dos dados enviados, diga:
"Com esses dados, vou encaminhar para análise interna. Se estiver tudo certo, o próximo passo é a fase contratual. Após contrato assinado, seguimos para pagamento e ativação."

Quando o lead perguntar forma de pagamento antes da hora:
"Temos as duas opções: PIX ou cartão em até 10x. Mas o pagamento só acontece depois da análise interna e assinatura do contrato, combinado?"

REGRA DE ESCALONAMENTO:
Se o lead fizer uma pergunta fora das informações oficiais, jurídica demais, técnica demais, contratual específica ou qualquer dúvida que você não tenha certeza, não invente.
Diga:
"Essa parte é mais específica e eu prefiro confirmar com um consultor da IQG para te passar a informação correta. Vou encaminhar seu atendimento para um consultor continuar com você com segurança."
Se o lead chegar em fase contratual, pedido de link, pagamento, análise de restrição, avalista ou dúvida contratual específica, encaminhe para consultor.

ARQUIVOS DISPONÍVEIS:
Se o lead pedir catálogo, contrato, kit, manual/curso de piscina ou folder, informe que vai enviar o material e o sistema enviará o arquivo.
O manual/curso de tratamento de piscina serve para orientar como tratar piscina, como usar os produtos e quando aplicar cada produto. Use esse material para reduzir insegurança de leads sem experiência.

BENEFÍCIOS:
Use quando fizer sentido:
- 40% de comissão.
- Possibilidade de ganhar mais vendendo acima do preço sugerido.
- Sem compra inicial de estoque.
- Estoque em comodato.
- Venda direta da indústria.
- Não precisa abrir empresa.
- Suporte técnico e comercial.
- Treinamentos contínuos.
- Catálogos e materiais gráficos.
- Conteúdos institucionais para redes sociais.
- Produtos com demanda recorrente.
- Linha de produtos para piscina, agro, ordenha e cosméticos veterinários.
- Possibilidade de indicação com 10% vitalício.

CONDUTA:
- Faça perguntas estratégicas.
- Não despeje muita informação.
- Responda curto.
- Uma ideia por mensagem.
- Sempre avance a conversa.
- Se o lead demonstrar interesse, vá para a próxima etapa.
- Se o lead perguntar algo, responda e depois conduza.
- Não fique repetindo explicação.
- Não peça dados que já foram enviados na conversa.
- Se faltar algum dado, peça apenas o que falta.

FLUXO NATURAL:
1. Se for início: cumprimente e confirme interesse.
2. Se o lead disser sim: explique curto e avance.
3. Se demonstrar interesse: proponha pré-análise.
4. Se aceitar pré-análise: colete dados.
5. Se enviar dados: peça apenas o que falta.
6. Depois dos dados: diga que vai encaminhar para análise interna.
7. Se análise for aprovada pela equipe interna, o próximo passo será fase contratual.
8. Após contrato assinado, seguem pagamento e ativação.
9. Se o lead quiser pagar ou pedir link, diga que primeiro precisa passar pela fase contratual e encaminhe para consultor.

DADOS PARA PRÉ-ANÁLISE:
- Nome completo
- CPF
- Cidade/Estado
- Telefone
- Se atua com vendas, piscinas, manutenção, agro, limpeza ou comércio
- Se possui nome limpo

ABERTURA:
"Olá! Tudo bem? 😊 Aqui é da IQG — Indústria Química Gaúcha. Vi que você demonstrou interesse no Programa Parceiro Homologado IQG. Quer que eu te explique de forma rápida como funciona?"

SE O LEAD DISSER SIM NO INÍCIO:
"Perfeito. Funciona assim: você atua como Parceiro Homologado IQG, vendendo produtos da indústria para clientes finais, com suporte técnico e comercial.

Você não precisa comprar o estoque inicial nem abrir empresa para começar.

Pelo seu interesse, posso seguir com uma pré-análise rápida do seu perfil?"

SE O LEAD ACEITAR PRÉ-ANÁLISE:
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

SE O LEAD PEDIR CONTRATO:
"Claro, posso te encaminhar um modelo para leitura das condições gerais.

Só reforço: a versão oficial para assinatura é liberada após a pré-análise e aprovação cadastral pela equipe interna da IQG. Primeiro analisamos o cadastro, depois seguimos para fase contratual."

SE O LEAD PEDIR MANUAL / CURSO / COMO TRATAR PISCINA:
"Boa pergunta. Vou te enviar um material que funciona como um manual/curso prático de tratamento de piscina.

Ele mostra como usar os produtos, quando aplicar e ajuda bastante quem está começando ou quer mais segurança para atender clientes."

SE O LEAD PERGUNTAR INVESTIMENTO:
"Para entrar no programa, existe um investimento único de adesão e implantação de R$1.990,00. Pode ser via PIX ou em até 10x de R$199,00 no cartão, conforme disponibilidade.

Esse valor não é compra de mercadoria. Ele cobre sua ativação, implantação, suporte, treinamento, materiais e liberação do lote inicial em comodato.

Mas o pagamento só acontece depois da análise interna e assinatura do contrato, combinado?"

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

    const requestedFileKey = detectRequestedFile(text);

    if (!conversations[from]) {
      conversations[from] = [];
    }

    conversations[from].push({
      role: "user",
      content: text
    });

    if (conversations[from].length > 24) {
      conversations[from] = conversations[from].slice(-24);
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
        max_tokens: 280,
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

    conversations[from].push({
      role: "assistant",
      content: resposta
    });

    if (conversations[from].length > 24) {
      conversations[from] = conversations[from].slice(-24);
    }

    console.log("Resposta final enviada:", resposta);

    const waitTime = humanDelay(resposta);
    console.log(`Aguardando ${waitTime}ms para simular digitação...`);
    await delay(waitTime);

    await sendWhatsAppMessage(from, resposta);

    if (requestedFileKey && FILES[requestedFileKey]) {
      await delay(2500);
      await sendWhatsAppDocument(from, FILES[requestedFileKey]);
    }

    if (CONSULTANT_PHONE && shouldNotifyConsultant(resposta)) {
      const note =
        `Novo atendimento IQG possivelmente precisa de consultor.\n\n` +
        `Lead: ${from}\n` +
        `Última mensagem do lead: ${text}\n\n` +
        `Resposta da IA: ${resposta}`;

      await sendWhatsAppMessage(CONSULTANT_PHONE, note);
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error("ERRO GERAL:", error);
    return res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando...");
});
