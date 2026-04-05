// 所有Google专用域名后缀 - 检测是否需要激活适配器
const GOOGLE_DOMAINS = [
  "generativelanguage.googleapis.com",
  "ai.google.dev",
  "us-central1-aiplatform.googleapis.com"  // 添加Vertex AI专用域名
];

// 工具函数：检测URL是否是Google API端点
export function isGoogleEndpoint(url) {
  try {
    if (!url || typeof url !== 'string') return false;
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.toLowerCase();

    // 如果是OpenAI兼容层，则不视为Google原生API
    if (pathname.includes('/openai')) {
      return false;
    }

    return GOOGLE_DOMAINS.some(domain => hostname.includes(domain));
  } catch (error) {
    console.error('[GoogleAdapter] URL解析错误:', url, error);
    return false;
  }
}

// 转换OpenAI格式请求为Google API所需格式
export function convertToGoogleRequest(openaiRequest) {
  const { model: _, ...rest } = openaiRequest; // 忽略model参数(Google放在URL中)

  // 将messages数组转换为Google的内容结构
  const contents = openaiRequest.messages.map(message => {
    let role;
    // Google API只支持 'user' 和 'model' 角色
    if (message.role === 'assistant') {
      role = 'model';
    } else {
      // 'system' 和 'user' 都转换为 'user'
      role = 'user';
    }

    return {
      role: role,
      parts: [{ text: message.content }]
    };
  });

  return {
    contents,
    generationConfig: {
      maxOutputTokens: openaiRequest.max_tokens,
      temperature: openaiRequest.temperature || 0.7,
      topP: 0.95,
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_NONE"
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE"
      }
    ]
  };
}

// 将Google API响应转换为标准OpenAI格式
export function parseGoogleResponse(googleResponse) {
  try {
    // 处理Google的错误响应格式
    if (googleResponse.error) {
      throw new Error(
        `Google API错误: ${googleResponse.error.message || '未知错误'}\n代码: ${googleResponse.error.code}`
      );
    }

    // 处理候选数据
    const candidate = googleResponse.candidates?.[0];
    if (!candidate || !candidate.content) {
      throw new Error('无效的Google API响应: 未找到候选内容');
    }

    // 合并多部分内容
    const content = candidate.content.parts
      .map(part => part.text || '')
      .join('\n')
      .trim();

    // 转换为OpenAI兼容格式
    return {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: candidate.finishReason || 'stop'
        }
      ]
    };
  } catch (error) {
    console.error('[GoogleAdapter] 响应解析错误:', error);
    console.log('原始Google响应:', googleResponse);
    throw error;
  }
}

// 构建GoogleAPI的完整端点URL
export function buildGoogleApiUrl(baseUrl, modelName) {
  try {
    const url = new URL(baseUrl);
    const pathname = url.pathname.replace(/\/$/, ''); // 移除末尾的斜杠

    // 检查是否为v1或v1beta的基础路径
    if (pathname.endsWith('/v1beta') || pathname.endsWith('/v1')) {
      if (!modelName) {
        throw new Error('Google API需要模型名称');
      }

      const apiVersion = pathname.endsWith('/v1beta') ? 'v1beta' : 'v1';

      // 构建完整的模型调用URL
      url.pathname = `/${apiVersion}/models/${modelName}:generateContent`;
      return url.href;
    }

    // 如果已经是完整API路径或自定义路径，则直接返回
    return url.href;
  } catch (error) {
    console.error('[GoogleAdapter] URL构建错误:', baseUrl, modelName, error);
    throw new Error(`无效的API地址: ${baseUrl}`);
  }
}

export function buildGoogleEmbeddingRequest(texts, modelName) {
    const requests = texts.map(text => ({
        model: `models/${modelName}`,
        content: {
            parts: [{ text: text }]
        }
    }));

    return { requests };
}

export function parseGoogleEmbeddingResponse(googleResponse, originalTexts) {
    if (!googleResponse || !Array.isArray(googleResponse.embeddings)) {
        console.error('[GoogleAdapter] Google向量API响应格式无效，缺少 "embeddings" 数组:', googleResponse);
        throw new Error('Google API返回的向量数据格式不正确。');
    }

    // Google API 返回的字段名是 "values" 而不是 "value"
    return googleResponse.embeddings.map(emb => emb.values);
}

export function buildGoogleEmbeddingApiUrl(baseUrl, modelName) {
    const url = new URL(baseUrl);
    const apiVersion = modelName.includes('gemini') ? 'v1beta' : 'v1';
    url.pathname = `/${apiVersion}/models/${modelName}:batchEmbedContents`;
    return url.href;
}

function convertOaiToGoogleForPlotOptimization(messages) {
    const contents = [];
    let system_instruction = null;
    let lastRole = '';

    for (const message of messages) {
        if (message.role === 'user' && lastRole === 'user') {
            const lastContent = contents[contents.length - 1];
            lastContent.parts.push({ text: `\n\n${message.content}` });
            continue;
        }
        
        if (message.role === 'assistant') {
            contents.push({
                role: 'model',
                parts: [{ text: message.content }],
            });
            lastRole = 'model';
        } else {
            contents.push({
                role: 'user',
                parts: [{ text: message.content }],
            });
            lastRole = 'user';
        }
    }

    return { contents, system_instruction };
}

export function buildPlotOptimizationGoogleRequest(messages, apiSettings) {
    const { contents } = convertOaiToGoogleForPlotOptimization(messages);

    const generationConfig = {
        temperature: apiSettings.temperature,
        topP: apiSettings.top_p,
        topK: apiSettings.top_k,
        maxOutputTokens: apiSettings.max_tokens,
    };
    
    if(generationConfig.topK) generationConfig.topK = Math.round(generationConfig.topK);

    Object.keys(generationConfig).forEach(key => {
        if (generationConfig[key] === undefined || generationConfig[key] === null) {
            delete generationConfig[key];
        }
    });

    if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: 'Hi' }] });
    }

    const safetySettings = [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ];

    const payload = {
        contents,
        generationConfig,
        safetySettings,
    };

    return payload;
}

export function parsePlotOptimizationGoogleResponse(googleResponse) {
    try {
        const candidates = googleResponse?.candidates;
        if (!candidates || candidates.length === 0) {
            let message = `Google API returned no candidates.`;
            if (googleResponse?.promptFeedback?.blockReason) {
                message += `\nPrompt was blocked due to: ${googleResponse.promptFeedback.blockReason}`;
                console.error(message, googleResponse.promptFeedback.safetyRatings);
            }
            return { choices: [{ message: { content: `Error: ${message}` } }] };
        }

        const responseContent = candidates[0].content;
        const responseText = responseContent?.parts?.map(part => part.text).join('') || '';
        
        if (!responseText) {
            let message = `Google API response text is empty.`;
            console.warn(message, googleResponse);
            return { choices: [{ message: { content: 'Error: Received an empty response from the API.' } }] };
        }

        return {
            choices: [{
                message: {
                    content: responseText
                }
            }]
        };
    } catch (error) {
        console.error(`Error parsing Google response:`, error, googleResponse);
        return { choices: [{ message: { content: `Error: Failed to parse Google API response. Details: ${error.message}` } }] };
    }
}
