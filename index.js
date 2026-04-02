// ========== 修改任務（已修正：關鍵字優先於上下文 + AI 智慧匹配） ==========
async function handleModifyTask(event, msg, userId, userEmail) {
    try {
        console.log('=== 修改任務開始 ===');
        console.log('訊息:', msg);

        // 第一步：取得所有 active 任務
        const snap = await db.collection('chat_logs')
            .where('ownerId', '==', userId)
            .where('status', '==', 'active').get();

        if (snap.empty) return reply(event, '你目前沒有任何待辦事項可以修改。');

        let targetDoc = null;
        let targetData = null;

        // 第二步：從訊息中提取任務名稱關鍵字
        const msgClean = msg
            .replace(/改到|改成|延後|提前|改時間|換到|調整到|移到|移至|搬到|時間改|修改|變更/g, '')
            .replace(/上午|下午|早上|中午|晚上|今天|明天|後天|大後天/g, '')
            .replace(/下週|下周|週一|週二|週三|週四|週五|週六|週日/g, '')
            .replace(/星期一|星期二|星期三|星期四|星期五|星期六|星期日/g, '')
            .replace(/\d{1,2}\s*[:.：]\s*\d{0,2}/g, '')
            .replace(/\d{1,2}\s*點\s*(\d{1,2}\s*分)?/g, '')
            .replace(/\d{1,4}\s*[/\-\.]\s*\d{1,2}(\s*[/\-\.]\s*\d{1,4})?/g, '')
            .replace(/的|把|將|幫我|請|那個|這個|那筆|那件|這筆|這件|時間/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        console.log('清理後關鍵字:', msgClean, '(長度:', msgClean.length, ')');

        // 第三步：建立任務清單供匹配
        const taskList = [];
        snap.forEach(doc => {
            taskList.push({ id: doc.id, doc: doc, text: doc.data().text || '' });
        });

        // 第四步：如果有關鍵字（>=2字），用 AI 精準匹配
        if (msgClean.length >= 2) {
            // 先試簡單的「完整包含」匹配
            const exactMatch = taskList.find(t => t.text.includes(msgClean) || msgClean.includes(t.text));
            if (exactMatch) {
                targetDoc = exactMatch.doc;
                targetData = exactMatch.doc.data();
                console.log('✅ 完整包含匹配成功:', targetData.text);
            }

            // 沒有完整包含，用 AI 判斷
            if (!targetDoc) {
                let taskListStr = '';
                taskList.forEach((t, idx) => {
                    taskListStr += `${idx + 1}. ID:${t.id} 標題:${t.text}\n`;
                });

                const matchPrompt = `使用者說：「${msg}」

以下是他的待辦清單：
${taskListStr}
使用者想修改哪個任務的時間？請根據使用者訊息中提到的任務名稱來判斷。
只回覆該任務的 ID（例如：abc123def456）。
如果無法判斷，回覆 UNCLEAR。
只回覆 ID 或 UNCLEAR，不要回覆其他文字。`;

                try {
                    const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: matchPrompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
                    const aiResult = r.data.candidates[0].content.parts[0].text.trim();
                    console.log('AI 任務匹配結果:', aiResult);

                    const matched = taskList.find(t => t.id === aiResult);
                    if (aiResult !== 'UNCLEAR' && matched) {
                        targetDoc = matched.doc;
                        targetData = matched.doc.data();
                        console.log('✅ AI 匹配成功:', targetData.text);
                    }
                } catch (aiErr) {
                    console.error('AI 任務匹配失敗:', aiErr.message);
                }
            }

            // AI 也失敗，用改良版逐字匹配（以「連續匹配」加分）
            if (!targetDoc) {
                let bestMatch = null;
                let bestScore = 0;

                taskList.forEach(t => {
                    let score = 0;
                    // 連續子字串匹配（權重更高）
                    for (let len = msgClean.length; len >= 2; len--) {
                        for (let start = 0; start <= msgClean.length - len; start++) {
                            const sub = msgClean.substring(start, start + len);
                            if (t.text.includes(sub)) {
                                score = Math.max(score, len * 15);
                            }
                        }
                    }
                    console.log(`  匹配: "${t.text}" → 分數: ${score}`);
                    if (score > bestScore) { bestScore = score; bestMatch = t; }
                });

                if (bestMatch && bestScore >= 30) {
                    targetDoc = bestMatch.doc;
                    targetData = bestMatch.doc.data();
                    console.log('✅ 子字串匹配成功:', targetData.text, '分數:', bestScore);
                }
            }
        }

        // 第五步：訊息很短（沒指定任務名）→ 用上下文
        if (!targetDoc && msgClean.length < 2) {
            const ctx = getContext(userId);
            if (ctx) {
                console.log('用上下文任務:', ctx.taskTitle);
                const docSnap = await db.collection('chat_logs').doc(ctx.taskId).get();
                if (docSnap.exists && docSnap.data().status === 'active') {
                    targetDoc = docSnap;
                    targetData = docSnap.data();
                    console.log('✅ 上下文匹配成功:', targetData.text);
                }
            }
        }

        // 第六步：只有一筆任務 → 直接用
        if (!targetDoc && snap.size === 1) {
            targetDoc = snap.docs[0];
            targetData = targetDoc.data();
            console.log('✅ 唯一任務:', targetData.text);
        }

        // 第七步：都找不到 → 列出清單
        if (!targetDoc) {
            let listText = '你有多個待辦，請說清楚要改哪一個：\n';
            let i = 1;
            snap.forEach(doc => { listText += `${i}. ${doc.data().text}\n`; i++; });
            listText += '\n例如：「交辦JJ製作荷卡素材 改到下午3點」';
            return reply(event, listText);
        }

        // 第八步：用 AI 解析新的時間
        const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const prompt = `現在台灣時間是 ${now}。
使用者想修改一個任務的時間。任務標題是「${targetData.text}」。
原本排程：${targetData.scheduledStart || '無'}
使用者說：「${msg}」

請判斷新的開始時間和結束時間（結束 = 開始 + 1小時）。
只回覆一行 JSON，格式：{"start":"2026-04-02T14:00:00+08:00","end":"2026-04-02T15:00:00+08:00"}
不要回覆任何其他文字。`;

        const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
        const aiText = r.data.candidates[0].content.parts[0].text.trim();
        console.log('AI 回傳時間:', aiText);

        let newTime;
        try {
            const jsonMatch = aiText.match(/\{.*\}/s);
            newTime = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
            console.error('時間解析失敗:', parseErr.message);
            return reply(event, '我沒聽懂你要改到什麼時間，可以說清楚一點嗎？例如「改到明天下午3點」');
        }

        // 更新 Firestore
        const updateData = {
            scheduledStart: newTime.start,
            scheduledEnd: newTime.end,
            lastModified: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('chat_logs').doc(targetDoc.id).update(updateData);

        // 更新 Google Calendar
        if (targetData.calendarEventId) {
            try {
                await updateCalendarEvent(targetData.calendarEventId, {
                    title: targetData.text,
                    start: newTime.start,
                    end: newTime.end
                });
                console.log('行事曆事件已更新');
            } catch (calErr) {
                console.error('行事曆更新失敗:', calErr.message);
            }
        }

        // 更新上下文
        setContext(userId, targetDoc.id, targetData.text);

        const st = new Date(newTime.start);
        const timeStr = st.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return reply(event, `「${targetData.text}」已改到 ${timeStr}，行事曆也同步更新了！`);

    } catch (e) {
        console.error('修改任務錯誤:', e.message, e.stack);
        return reply(event, '修改任務時遇到問題，請稍後再試。');
    }
}
