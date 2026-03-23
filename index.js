const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { google } = require('googleapis');

if (!admin.apps.length) {
    admin.initializeApp({ projectId: "moan-adtech-bot" });
}
const db = admin.firestore();

const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const client = new line.Client(config);
const app = express();

app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r)).catch(e => console.error("Webhook Error:", e));
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去"];
    if (pending.exists && confirmWords.includes(userMessage.toLowerCase())) {
        const data = pending.data();
        try {
            const batch = db.batch();
            data.tasks.forEach(t => {
                const ref = db.collection("chat_logs").doc();
                batch.set(ref, { text: t.title, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: "active" });
            });
            await batch.commit();
        } catch (e) { console.error("DB Error", e); }

        let calendarFeedback = "";
        for (const t of data.tasks) {
            if (t.start) {
                try {
                    await createCalendarEvent(t);
                    calendarFeedback = "\n📅 行事曆也預約成功囉！";
                } catch (e) {
                    console.error("行事曆詳細錯誤:", e);
                    // 把錯誤直接噴在 LINE 上，我們直接看原因
                    calendarFeedback = `\n❌ 行事曆失敗：${e.message}`;
                }
            }
        }
        await pendingRef.delete();
        return client.replyMessage(event.replyToken, { type: 'text', text: `✨ 任務已存入系統。${calendarFeedback}` });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `你是一位 Cony 的特助。目前的年份是 2026 年。嚴禁使用 Markdown 符號。分析訊息：『${userMessage}』。提議在該日期的早上 10 點預約。格式：『Cony，關於[任務]，我預計排在[日期]的早上 10 點，這樣可以嗎？』最後附上 JSON：[{"title": "任務名稱", "start": "2026-MM-DDT10:00:00", "end": "2026-MM-DDT11:00:00"}]`;

    try {
        const response = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });
        const aiResponseText = response.data.candidates[0].content.parts[0].text;
        const jsonMatch = aiResponseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
            await pendingRef.set({ tasks: JSON.parse(jsonMatch[0]), timestamp: admin.firestore.FieldValue.serverTimestamp() });
        }
        const cleanMessage = aiResponseText.replace(/\[\s*\{[\s\S]*\}\s*\]/g, '').trim();
        return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });
    } catch (e) {
        return client.replyMessage(event.replyToken, { type: 'text', text: "大腦斷線中..." });
    }
}

async function createCalendarEvent(taskData) {
    // 🛡️ 超強格式修復器
    let key = process.env.CALENDAR_PRIVATE_KEY || "";
    let email = process.env.CALENDAR_EMAIL || "";
    let calId = process.env.MY_CALENDAR_ID || "";

    // 排除常見的貼上錯誤 (引號、空格、字面上的 \n)
    const cleanKey = key.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const cleanEmail = email.trim().replace(/^["']|["']$/g, '');
    const cleanCalId = calId.trim().replace(/^["']|["']$/g, '');

    // 在日誌留下線索 (安全版)
    console.log(`正在嘗試登入。Email開頭: ${cleanEmail.substring(0, 5)}...`);
    console.log(`金鑰長度: ${cleanKey.length}`);

    if (!cleanKey.includes("BEGIN PRIVATE KEY")) {
        throw new Error("私鑰內容似乎不正確，沒看到 BEGIN PRIVATE KEY 字樣");
    }

    const auth = new google.auth.JWT(
        cleanEmail,
        null,
        cleanKey,
        ['https://www.googleapis.com/auth/calendar']
    );

    // 強制進行一次認證，提早抓出錯誤
    await auth.authorize();

    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.insert({
        calendarId: cleanCalId,
        resource: {
            summary: taskData.title,
            start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
            end: { dateTime: taskData.end, timeZone: 'Asia/Taipei' },
        }
    });
}

app.listen(8080);