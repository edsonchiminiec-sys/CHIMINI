const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// 🔐 Variáveis de ambiente (Render)
const VERIFY_TOKEN = "iqg_token_123";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 🔹 Verificação do webhook (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado!");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// 🔹 Receber mensagens
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    console.log("Webhook recebido:", JSON.stringify(body, null, 2));

    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (msg) {
      const from = msg.from;
      const text = msg.text?.body;

      console.log("Mensagem recebida:", text);

      // 🔥 Chamada para OpenAI
      const gptResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "Você é um SDR especializado no programa de parceiros homologados da IQG. Seja direto, profissional e conduza o lead para qualificação."
            },
            {
              role: "user",
              content: text || "Olá"
            }
          ]
        })
      });

      const gptData = await gptResponse.json();

      console.log("Resposta da OpenAI:", JSON.stringify(gptData, null, 2));

      // 🔥 Tratamento seguro (evita erro que você teve)
      let reply = "Olá! Sou o assistente da IQG. Como posso te ajudar sobre o programa de parceiros homologados?";

      if (gptData.choices && gptData.choices[0] && gptData.choices[0].message) {
        reply = gptData.choices[0].message.content;
      } else if (gptData.error) {
        console.error("Erro da OpenAI:", gptData.error);
        reply = "No momento estou com uma instabilidade no atendimento automático. Já já um consultor continua seu atendimento.";
      }

      // 🔥 Enviar resposta para WhatsApp
      await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          text: { body: reply }
        })
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro geral:", error);
    res.sendStatus(500);
  }
});

// 🔹 Start servidor
app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando...");
});
