const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { google } = require('googleapis');

// --- 1. 初始化 Firebase ---
if (!admin.apps.length) {
    admin.initializeApp({ projectId: "moan-adtech-bot" });
}
const db = admin.firestore();

// --- 2. 基本設定 ---
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const client = new line.Client(config);
const app = express();

// --- 3. Webhook 入口 ---
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(r => res.json(r))
        .catch(e => console.error("Webhook Error:", e));
});

// --- 4. 核心邏輯 ---
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    // 🎯 邏輯 A：確認與執行
    const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去", "執行"];
    if (pending.exists && confirmWords.includes(userMessage.toLowerCase())) {
        const data = pending.data();
        
        // 寫入資料庫
        try {
            const batch = db.batch();
            data.tasks.forEach(t => {
                const ref = db.collection("chat_logs").doc();
                batch.set(ref, { text: t.title, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: "active" });
            });
            await batch.commit();
        } catch (e) { console.error("DB Error", e); }

        // 寫入行事曆
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

    // 🎯 邏輯 B：AI 幕僚高智商大腦
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    // 取得現在時間，讓 AI 有時間觀念
    const now = new Date();
    const todayStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    // 取得前情提要，讓 AI 知道是在改時間
    const context = pending.exists && pending.data().tasks && pending.data().tasks.length > 0 
        ? `【重要背景】：Cony 正在修改先前的任務「${pending.data().tasks[0].title}」。請根據她的新指令更新時間或內容。` 
        : "";

    const prompt = `你是一位精明俐落的 Cony 專屬特助。嚴禁使用 Markdown 符號。
    現在的真實台灣時間是：${todayStr}。
    請分析 Cony 的最新訊息：『${userMessage}』
    ${context}

    【行動準則】：
    1. 擷取真正的任務名稱，絕對不要像機器人一樣回覆「關於任務名稱...」。
    2. 如果 Cony 有明確指定時間（例如下午2點、11點），請「絕對」遵照該時間排程。
    3. 如果只說了日期沒說時間，預設提議在該日的早上 10 點。
    4. 用一句自然的話回覆，例如：『Cony，沒問題，已經幫妳把[真實任務名稱]排在[日期]的[時間]了，這樣可以嗎？』

    【系統要求 - 必填】：
    請在回覆的最下方，附上這段系統需要的 JSON（必須隱藏在最後，並把中文替換成真正的資料）：
    [{"title": "真正的任務名稱", "start": "2026-MM-DDTHH:mm:00", "end": "2026-MM-DDTHH:mm:00"}]`;

    try {
        const response = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });
        const aiResponseText = response.data.candidates[0].content.parts[0].text;
        
        // 抓出 JSON 存入暫存
        const jsonMatch = aiResponseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
            await pendingRef.set({ tasks: JSON.parse(jsonMatch[0]), timestamp: admin.firestore.FieldValue.serverTimestamp() });
        }
        
        // 隱藏 JSON，只回覆乾淨的人話給 Cony
        const cleanMessage = aiResponseText.replace(/\[\s*\{[\s\S]*\}\s*\]/g, '').trim();
        return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });
    } catch (e) {
        console.error("Gemini Error:", e);
        return client.replyMessage(event.replyToken, { type: 'text', text: "特助大腦短暫當機，請稍後再試。" });
    }
}

// --- 5. Google Calendar 寫入 ---
async function createCalendarEvent(taskData) {
    const rawKey = process.env.CALENDAR_PRIVATE_KEY || "";
    const rawEmail = process.env.CALENDAR_EMAIL || "";
    const rawCalId = process.env.MY_CALENDAR_ID || "";

    if (!rawKey || rawKey.length < 10) throw new Error("私鑰變數為空或太短");
    if (!rawEmail) throw new Error("Email 變數為空");

    // 完美格式處理，確保 Google 看得懂
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`伺服器在 ${PORT} 啟動...`));