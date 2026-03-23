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
                    console.error("行事曆失敗詳情:", e);
                    // 這裡我簡化了報錯，讓妳更容易看懂
                    calendarFeedback = `\n❌ 行事曆失敗：憑證格式不對，請檢查 Cloud Run 變數貼法。`;
                }
            }
        }
        await pendingRef.delete();
        return client.replyMessage(event.replyToken, { type: 'text', text: `✨ 任務已同步到儀表板。${calendarFeedback}` });
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
    // 🛡️ 最強大的格式修正器
    let key = (process.env.CALENDAR_PRIVATE_KEY || "").trim();
    let email = (process.env.CALENDAR_EMAIL || "").trim();
    
    if (!key || !email) throw new Error("環境變數讀取不到，請檢查 Cloud Run 名稱是否有錯");

    // 1. 去掉可能的頭尾引號
    key = key.replace(/^["']|["']$/g, '');
    email = email.replace(/^["']|["']$/g, '');

    // 2. 修復換行符號
    const cleanKey = key.replace(/\\n/g, '\n');

    const auth = new google.auth.JWT(
        email,
        null,
        cleanKey,
        ['https://www.googleapis.com/auth/calendar']
    );

    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.insert({
        calendarId: process.env.MY_CALENDAR_ID.trim().replace(/^["']|["']$/g, ''),
        resource: {
            summary: taskData.title,
            start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
            end: { dateTime: taskData.end, timeZone: 'Asia/Taipei' },
        }
    });
}

app.listen(8080);