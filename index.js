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
    Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r));
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    // --- 🎯 邏輯 A：處理確認或修改時間 ---
    if (pending.exists) {
        const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去"];
        
        if (confirmWords.includes(userMessage.toLowerCase())) {
            const data = pending.data();
            const batch = db.batch();
            data.tasks.forEach(t => {
                const ref = db.collection("chat_logs").doc();
                batch.set(ref, { text: t.title, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: "active" });
            });
            await batch.commit();

            for (const t of data.tasks) {
                if (t.start) await createCalendarEvent(t);
            }
            await pendingRef.delete();
            return client.replyMessage(event.replyToken, { type: 'text', text: "✨ 沒問題！已經幫妳在行事曆排好了，提醒也設定好囉。" });
        }
        // 如果不是確認，代表 Cony 可能要改時間，交給 AI 重新判斷 (轉到邏輯 B)
    }

    // --- 🎯 邏輯 B：AI 幕僚分析 (極簡人類口吻) ---
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    // 如果有舊的 pending，AI 會知道是要「改時間」
    const context = pending.exists ? `使用者想修改之前的任務：${pending.data().tasks[0].title}` : "";

    const prompt = `你是一位 Cony 的貼心特助。目前的年份是 2026 年。
    請分析訊息：『${userMessage}』 ${context}
    
    要求：
    1. 嚴禁使用任何 Markdown 符號 (如 ###, **)。
    2. 用自然的人類語言說話，不要寫報告。
    3. 針對任務，主動提議在當日的早上 10 點進行預約。
    4. 語句參考範例：『Cony，關於[任務]，我預計幫妳排在[日期]的早上 10 點，並設定 1 小時跟 1 天前提醒，這樣可以嗎？如果不滿意時間，請直接告訴我妳要改幾點。』
    
    ※ 必須在最後附上 JSON：[{"title": "任務名稱", "start": "2026-MM-DDT10:00:00", "end": "2026-MM-DDT11:00:00"}]`;

    try {
        const response = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });
        const aiResponseText = response.data.candidates[0].content.parts[0].text;

        const jsonMatch = aiResponseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
            const tasksToSave = JSON.parse(jsonMatch[0]);
            await pendingRef.set({ tasks: tasksToSave });
        }

        // 去除 AI 回覆中的 JSON 部分，只留給 Cony 看的人類語言
        const cleanMessage = aiResponseText.replace(/\[\s*\{[\s\S]*\}\s*\]/g, '').trim();
        return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });
    } catch (e) {
        return client.replyMessage(event.replyToken, { type: 'text', text: "腦袋有點打結，可以再說一次嗎？" });
    }
}

async function createCalendarEvent(taskData) {
    const auth = new google.auth.JWT(
        process.env.CALENDAR_EMAIL,
        null,
        process.env.CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n'),
        ['https://www.googleapis.com/auth/calendar']
    );
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.insert({
        calendarId: process.env.MY_CALENDAR_ID,
        resource: {
            summary: taskData.title,
            start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
            end: { dateTime: taskData.end, timeZone: 'Asia/Taipei' },
            reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 1440 }] }
        }
    });
}

app.listen(8080);