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
                    console.error("Calendar Error:", e.message);
                    calendarFeedback = `\n❌ 行事曆失敗：${e.message}`;
                }
            }
        }
        await pendingRef.delete();
        return client.replyMessage(event.replyToken, { type: 'text', text: `✨ 任務已存入系統。${calendarFeedback}` });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `你是一位 Cony 的特助。目前的年份是 2026 年。嚴禁使用 Markdown 符號。分析訊息：『${userMessage}』。提議在該日期的早上 10 點預約。最後附上 JSON：[{"title": "任務名稱", "start": "2026-MM-DDT10:00:00", "end": "2026-MM-DDT11:00:00"}]`;

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
    // 🔍 這裡就是「地毯式檢查」
    if (!process.env.CALENDAR_PRIVATE_KEY) throw new Error("找不到變數 CALENDAR_PRIVATE_KEY");
    if (!process.env.CALENDAR_EMAIL) throw new Error("找不到變數 CALENDAR_EMAIL");
    if (!process.env.MY_CALENDAR_ID) throw new Error("找不到變數 MY_CALENDAR_ID");

    const key = process.env.CALENDAR_PRIVATE_KEY.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const email = process.env.CALENDAR_EMAIL.trim().replace(/^["']|["']$/g, '');
    const calId = process.env.MY_CALENDAR_ID.trim().replace(/^["']|["']$/g, '');

    const auth = new google.auth.JWT(
        email,
        null,
        key,
        ['https://www.googleapis.com/auth/calendar']
    );

    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.insert({
        calendarId: calId,
        resource: {
            summary: taskData.title,
            start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
            end: { dateTime: taskData.end, timeZone: 'Asia/Taipei' },
        }
    });
}

app.listen(8080);