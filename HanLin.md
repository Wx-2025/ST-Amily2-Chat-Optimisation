---

## 翰林院篇：忆识核心与RAG系统

翰林院，是Amily2号的忆识核心，是真正的记忆中枢。它基于RAG（检索增强生成）技术，能让角色拥有可随时查阅、永不遗忘的知识库。

<div style="padding: 10px; background-color: #d1ecf1; border: 1px solid #bee5eb; border-radius: 5px; color: #0c5460;"> 
注意：本篇所有功能，均围绕着一个核心——将你的知识（无论是聊天记录、手动输入的文本，还是世界书条目）转化为向量数据，存入一个特殊的“忆识宝库”中。当你和角色对话时，系统会自动检索宝库中最相关的内容，注入到提示词中，让角色“记起”相关信息。
</div>

---

### 1. 总览与核心开关

这里是翰林院的仪表面板，展示了核心状态并提供了最高权限的操作。

![总览界面](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/main_controls.png)
*<center>上图：翰林院总览区域</center>*

| 配置项 | 说明 |
|---|---|
| **开启忆识检索之权** | **翰林院的总开关**。关闭后，所有检索和注入功能都将暂停，但不会影响向量化的录入。 |
| **忆识总数** | 显示当前角色忆识宝库中存储的向量总数。旁边的**刷新**按钮可以手动更新这个数字。 |
| **清空宝库** | **（危险操作）** 一键删除当前角色**所有**的忆识。此操作不可逆，三思而后行。 |
| **存档封印** | 保存你在翰林院界面所做的所有设置。虽然大多数设置是即时生效的，但点击一下总没错。<br />Ps：其实`1.1.7`版本后基本没卵用了。 |

> **附加说明**：忘记给刷新按钮增加自动刷新了，最好选择角色之后手动刷新一下。

---

### 2. 忆识检索 (Retrieval)

这里负责配置连接外部“神力之源”（Embedding API）的通道，它是将文字转化为向量的根本。

![忆识检索界面](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/retrieval_main.png)
*<center>上图：忆识检索配置区域</center>*

| 配置项 | 说明 |
|---|---|
| **API设定** | 选择你的Embedding服务商。如果你有自己的中转或特殊服务……也得`自定义`，毕竟其他的东西没完善。 |
| **自定义路径** | 当`API设定`为`自定义`时，在此处填写你的完整API地址。 |
| **通行令牌 (API Key)** | 你的Embedding API密钥。 |
| **嵌入模型** | 你想使用的Embedding模型。点击`获取模型`按钮可以自动从API拉取可用模型列表。 |
| **测试神力** | 点击后会尝试用你填写的配置连接API，检查是否能成功“沟通”。 |
| **重置为初** | 将此页面的所有设置恢复到最初的默认状态。 |

> <div style="padding: 10px; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 5px; color: #721c24;"> 重要提示：此处的API与主殿的API是**完全独立**的。主殿API负责聊天，翰林院API负责将知识向量化。两者可以相同，也可以不同。</div>

---

### 3. 书库编纂 (Historiography)

这里是向忆识宝库中“录入”向量的地方，提供了多种方式。

#### 凝识法则
这是最常用的功能，可以将你们的聊天记录转化为忆识（向量）。

![凝识法则界面](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/Shukubianzhuan.png)
*<center>上图：凝识法则配置区域</center>*

| 配置项 | 说明 |
|---|---|
| **准许凝识** | 此功能的总开关（我一直开着的，不知道关了它之后录入还好不好使。） |
| **凝识范围** | 设定要转换的聊天记录楼层范围。例如，1-10就是转换最早的10条消息。 |
| **消息来源** | 选择要转换谁说的话，是你，还是AI，还是两者都要。 |
| **标签提取** | 一个高级功能，可以让你只提取消息中特定XML标签里的内容进行转换，可单可多，可预览编辑，但标签顺序要一致。 |
| **开始凝识** | 点击后，立刻根据以上设定，将聊天记录录入忆识宝库。 |
| **预览内容** | 在不实际录入的情况下，查看根据当前设定会生成哪些文本内容。 |

#### 手动录入 & 按条目编纂



![手动与按条目编纂](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/condensation_manual_ingest.png)


![手动与按条目编纂](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/condensation_by_entry.png)
*<center>上图：手动录入与按条目编纂区域</center>*

| 功能区 | 说明 |
|---|---|
| **手动录入** | 在文本框里粘贴任何你想要角色记住的文字（比如角色设定、背景故事），然后点击`开始录入`，即可存入宝库。 |
| **按条目编纂** | 可以直接选择一个**世界书**及其中的**条目**，将其内容整个录入忆识宝库。对于已经整理好的知识非常方便。 |

> **附加说明**：没事不要加太多东西，酒馆向量库炸了你不炸了吗。

---

### 4. 忆识精炼 (Rerank)

当检索到的忆识过多时，Rerank功能可以对初步检索结果进行二次排序，选出与当前对话**最最相关**的几条，大大提高知识注入的精准度。

![忆识精炼界面](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/rerank_main.png)
*<center>上图：Rerank配置区域</center>*

| 配置项 | 说明 |
|---|---|
| **启用 Rerank** | 此功能的总开关。 |
| **Rerank API 地址/Key/模型** | 和Embedding API一样，你需要一个专门的Rerank模型服务。配置方法完全相同。 |
| **返回结果数 (top_n)** | Rerank之后，最终返回多少条最相关的忆识。 |
| **混合分数权重 (Alpha)** | 一个高级参数，用于平衡原始相似度分数和Rerank分数。保持默认的0.7通常效果最好。 |
| **Rerank 时上奏** | 开启后，每次成功执行Rerank都会在聊天框里发一条通知。 |

> **附加说明**：听说这东西的提示词挺重要，但是我还没加。而且LLM的实现方式有点复杂，我慢慢整吧还是。

---

### 5. 高级设定

这里提供了一些微调参数，让你对翰林院的行为有更精细的控制。

![高级设定界面](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/advanced_settings_1.png)
*<center>上图：检索微调区域</center>*

| 配置项 | 说明 |
|---|---|
| **书卷尺寸 (Chunk Size)** | 在录入知识时，将长文本切分成的小块的大小。这会影响检索的粒度。 |
| **上下文关联度 (Overlap)** | 每个小块之间重叠的字符数，以确保上下文的连续性。 |
| **忆识匹配度 (Threshold)** | 只有相似度高于这个阈值的忆识才会被检索出来。 |
| **检索参考的消息数量** | 系统会拿最近几条消息作为“问题”去检索忆识宝库。 |
| **单次检索最大结果数** | 在Rerank之前，初步从向量库中捞出多少条相关的忆识。 |

> **附加说明**：没有附加说明，就单纯不想写。

---

#### 圣言注入
这里决定了检索到的忆识，将以何种方式“告诉”给角色。

![圣言注入界面](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/advanced_settings_injection.png)
*<center>上图：圣言注入配置区域</center>*

| 配置项 | 说明 |
|---|---|
| **圣言模板** | 注入内容的格式。`{{text}}`是占位符，会被实际的忆识内容替换，占位符不要乱改。<br />但是上面的提示词可以随意改，例如：“这里是已发生过事情中的相关记忆片段，请以以下内容作为参考：{{text}}。”像是这样。 |
| **注入位置** | 决定了这段“圣言”放在提示词的哪个位置。`聊天内 @ 深度`是最常用的，可以模拟一条特定角色的历史消息。 |

---

### 6. 起居注

这里是翰林院的运行日志，记录了每一次知识录入、检索、注入的详细过程。如果遇到问题，来这里看看，通常能找到原因。

![起居注界面](https://cdn.jsdelivr.net/gh/Wx-2025/ST-Amily2-images@main/images/log_view.png)
*<center>上图：起居注区域</center>*

> **附加说明**：翰林院的教程就到这里了。这玩意很强大，但也需要耐心调教。多试试不同的设置，找到最适合你和你的角色的用法吧。
>
> <div style="padding: 10px; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 5px; color: #721c24;"> 重要提示：但要是有关翰林院的报错，你还给我截图红色框框，你看我把不把你头打爆。</div>

---
