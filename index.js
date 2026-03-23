const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();
const db = admin.firestore();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const client = new line.Client(config);
const app = express();

app.post('/callback', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r));
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;
  let userMessage = event.message.text.trim();

  // 🎯 功能一：自動結案偵測 (例如輸入：出龍息已完成)
  if (userMessage.endsWith("已完成") || userMessage.endsWith("完成") || userMessage.endsWith("結案")) {
    const taskName = userMessage.replace(/已完成|完成|結案/g, "").trim();
    
    // 去資料庫找關鍵字匹配的 active 項目
    const snapshot = await db.collection("chat_logs")
                           .where("status", "==", "active")
                           .get();
    
    let count = 0;
    const batch = db.batch();
    snapshot.forEach(doc => {
      if (doc.data().text.includes(taskName)) {
        batch.update(doc.ref, { status: "archived", completedAt: admin.firestore.FieldValue.serverTimestamp() });
        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
      return client.replyMessage(event.replyToken, { type: 'text', text: `✅ 已幫妳把包含「${taskName}」的 ${count} 項任務標記為完成了！` });
    }
  }

  // 🎯 功能二：模糊比對總結指令
  const commandKeywords = ["待辦", "整理", "進度", "報告"];
  if (commandKeywords.some(k => userMessage.includes(k))) {
    const snapshot = await db.collection("chat_logs").where("status", "==", "active").orderBy("timestamp", "desc").limit(20).get();
    if (snapshot.empty) return client.replyMessage(event.replyToken, { type: 'text', text: "目前沒有待處理任務喔！" });
    const context = snapshot.docs.map(doc => doc.data().text).join("\n");
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `你是一位專業助手，請極簡摘要以下待辦，不准腦補：\n\n${context}`;
    const response = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });
    const aiText = response.data.candidates[0].content.parts[0].text.replace(/[*#]/g, '');
    return client.replyMessage(event.replyToken, { type: 'text', text: `📊 墨案極簡報：\n\n${aiText}` });
  }

  // 🎯 功能三：自動拆分項目 (針對 、 , \n 進行拆解)
  const tasks = userMessage.split(/[、，\n,]/).filter(t => t.trim().length > 0);
  
  const batch = db.batch();
  tasks.forEach(taskText => {
    const docRef = db.collection("chat_logs").doc();
    batch.set(docRef, {
      userId: event.source.userId,
      text: taskText.trim(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: "active"
    });
  });
  await batch.commit();

  return null;
}

app.listen(8080);