const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { google } = require('googleapis');

// --- 1. 初始化 Firebase (後端專用寫法) ---
// 在 Google Cloud 環境下，admin 會自動讀取專案權限
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: "moan-adtech-bot" // 這是妳的專案 ID
    });
}
const db = admin.firestore();

// --- 2. LINE 機器人基本設定 ---
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
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    // --- 🎯 動作一：處理「確認入庫」指令 ---
    const confirmWords = ["好", "確認", "ok", "yes", "加進去", "執行", "確認入庫"];
    if (confirmWords.includes(userMessage.toLowerCase())) {
        const pendingRef = db.collection("pending_proposals").doc(userId);
        const pending = await pendingRef.get();
        
        if (pending.exists) {
            const data = pending.data();
            const batch = db.batch();
            
            // 1. 寫入 Firestore 待辦 (chat_logs)
            data.tasks.forEach(t => {
                const ref = db.collection("chat_logs").doc();
                batch.set(ref, { 
                    text: t.title, 
                    timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                    status: "active" 
                });
            });
            await batch.commit();

            // 2. 寫入 Google 行事曆 (如果有日期)
            let calendarCount = 0;
            for (const t of data.tasks) {
                if (t.start) {
                    try { 
                        await createCalendarEvent(t); 
                        calendarCount++;
                    } catch (e) { console.error("行事曆同步失敗", e); }
                }
            }

            // 3. 清除暫存
            await pendingRef.delete();
            
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `✨ 遵命！已同步 ${data.tasks.length} 筆任務至儀表板${calendarCount > 0 ? `，並完成 ${calendarCount} 筆行事曆預約` : ''}。` 
            });
        } else {
            return client.replyMessage(event.replyToken, { type: 'text', text: "Cony，目前沒有等待確認的提案喔！請直接告訴我妳想記錄什麼。" });
        }
    }

    // --- 🎯 動作二：AI 幕僚分析與提案 ---
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const prompt = `你是一位精明伶俐、有條不紊的特別助理，專門協助 Cony 處理廣告委刊與專案管理。
    現在是 2026 年。請針對以下訊息進行深度分析，過慮掉寒暄或雜訊，只留下重要資訊。
    
    訊息內容：『${userMessage}』
    
    回覆要求：
    1. 【精華摘要】：用一句話點出重點。
    2. 【幕僚建議】：根據任務性質，列出具體的下一步建議。
    3. 【時限規劃】：如果訊息中有日期，請標註出來；若無，請根據常理推算建議時限。
    4. 語氣要專業、俐落，像個資深特助。
    
    ⚠️ 必須在回覆的最後加上一段 JSON 格式（這段會隱藏處理）：
    [{"title": "任務名稱", "start": "ISO格式日期", "end": "一小時後ISO日期"}]
    
    最後請詢問：『Cony，以上整理是否正確？確認請回覆「確認」為您排入系統。』`;

    try {
        const response = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });
        const aiResponseText = response.data.candidates[0].content.parts[0].text;

        // 從 AI 回覆中提取 JSON 任務資料
        const jsonMatch = aiResponseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        let tasksToSave = [];
        if (jsonMatch) {
            try {
                tasksToSave = JSON.parse(jsonMatch[0]);
            } catch (e) { console.log("JSON 提取失敗"); }
        }

        // 如果有抓到任務，先存入暫存區 (pending)
        if (tasksToSave.length > 0) {
            await db.collection("pending_proposals").doc(userId).set({ 
                tasks: tasksToSave, 
                timestamp: admin.firestore.FieldValue.serverTimestamp() 
            });
        }

        return client.replyMessage(event.replyToken, { type: 'text', text: aiResponseText });
    } catch (error) {
        console.error("Gemini API 錯誤", error);
        return client.replyMessage(event.replyToken, { type: 'text', text: "抱歉 Cony，幕僚大腦稍微斷線了，請稍後再試。" });
    }
}

// --- 🛠 Google Calendar API 核心函數 ---
async function createCalendarEvent(taskData) {
    const auth = new google.auth.JWT(
        process.env.CALENDAR_EMAIL,
        null,
        process.env.CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n'),
        ['https://www.googleapis.com/auth/calendar']
    );

    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
        summary: taskData.title,
        description: '由墨案特助 AI 自動建立',
        start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
        end: { dateTime: taskData.end || taskData.start, timeZone: 'Asia/Taipei' },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 60 },   // 1小時前
                { method: 'popup', minutes: 1440 }, // 1天前
            ],
        },
    };

    await calendar.events.insert({
        calendarId: process.env.MY_CALENDAR_ID,
        resource: event,
    });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`伺服器在 ${PORT} 啟動...`));