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
                    calendarFeedback = `\n❌ 行事曆失敗：${e.message}`;
                }
            }
        }
        await pendingRef.delete();
        return client.replyMessage(event.replyToken, { type: 'text', text: `✨ 任務已同步到系統。${calendarFeedback}` });
    }

    // --- 🎯 這裡換上了 5.0 高智商大腦指令 ---
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    // 喚醒記憶：如果資料庫裡有暫存，提醒 AI 這是上下文
    const context = pending.exists && pending.data().tasks.length > 0 
        ? `(背景提醒：Cony 正在針對稍早的任務「${pending.data().tasks[0].title}」進行修改，請保留這個任務名稱，並根據她的新指令調整時間。)` 
        : "";

    const prompt = `你是一位專業且精明的 Cony 專屬特助。目前年份是 2026 年。嚴禁使用 Markdown 符號。
    請分析最新訊息：『${userMessage}』 ${context}

    【排程規則 - 極度重要】：
    1. 若 Cony 明確指定了「時間」（例如下午2點、15:00），請「絕對遵照」她指定的時間排程，不准擅自改成 10 點。
    2. 只有當 Cony「只給日期，沒給時間」時，才主動提議排在該日期的「早上 10 點」。

    【回覆語氣】：俐落、像真人對話。
    若她有指定時間：『Cony，沒問題，已經幫妳把[任務]改排在[日期]的[時間]了，這樣可以嗎？』
    若沒指定時間：『Cony，關於[任務]，預計幫妳排在[日期]的早上 10 點，這樣可以嗎？』

    最後附上 JSON 格式：[{"title": "任務名稱", "start": "2026-MM-DDT時:分:00", "end": "2026-MM-DDT時:分:00"}]`;

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
        return client.replyMessage(event.replyToken, { type: 'text', text: "特助大腦短暫斷線，請再說一次。" });
    }
}

async function createCalendarEvent(taskData) {
    const rawKey = process.env.CALENDAR_PRIVATE_KEY || "";
    const rawEmail = process.env.CALENDAR_EMAIL || "";
    const rawCalId = process.env.MY_CALENDAR_ID || "";

    if (!rawKey || rawKey.length < 10) throw new Error("私鑰變數為空或太短");
    if (!rawEmail) throw new Error("Email 變數為空");

    const cleanKey = rawKey.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const cleanEmail = rawEmail.trim().replace(/^["']|["']$/g, '');
    const cleanCalId = rawCalId.trim().replace(/^["']|["']$/g, '');

    const auth = new google.auth.JWT({
        email: cleanEmail,
        key: cleanKey,
        scopes: ['https://www.googleapis.com/auth/calendar']
    });

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