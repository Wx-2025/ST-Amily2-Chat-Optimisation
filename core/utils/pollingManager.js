export async function intelligentPoll(promiseFactory, options = {}) {
  // 解析配置选项
  const {
    maxAttempts = 8,
    baseDelay = 1000,
    shouldStop = res => !!res.complete,
    onAttempt = (attempt, delay) => {/* 默认不执行操作 */},
    onError = error => console.error('[轮询错误]', error.message)
  } = options;
  
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 计算当前延迟时间（指数退避）
    const delay = baseDelay * Math.pow(2, attempt - 1);
    
    try {
      // 调用回调通知尝试开始
      onAttempt(attempt, delay);
      
      // 如果首次尝试不需延迟
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // 执行真实的任务
      const result = await promiseFactory();
      
      // 检查是否满足停止条件
      if (shouldStop(result)) {
        const successMsg = `轮询任务成功 (${
          maxAttempts > 1 
            ? `${attempt}/${maxAttempts}次尝试`
            : '一次性尝试'
        })`;
        console.log(`[轮询管理器] ${successMsg}`);
        return result;
      }
    } catch (error) {
      lastError = error;
      onError(error, attempt);
      
      // 如果是最后一次尝试，保留错误抛出
      if (attempt === maxAttempts) break;
    }
  }
  
  // 所有尝试失败后抛出聚合错误
  const attemptsStr = maxAttempts > 1 ? `(${maxAttempts}次尝试)` : '';
  const message = lastError
    ? `${lastError.message} ${attemptsStr}`
    : `达到最大尝试次数但未完成 ${attemptsStr}`;
  
  throw new Error(`[轮询超时] ${message}`);
}
 
export function createGooglePollingTask(operationId, statusUrl, headers) {
  return async () => {
    // 在真实URL中插入操作ID
    const taskUrl = `${statusUrl}/operations/${operationId}`;
    
    const response = await fetch(taskUrl, {
      method: 'GET',
      headers: headers,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API请求失败 (${response.status}): ${errorText || '无错误详情'}`);
    }
    
    return response.json();
  };
}
export function progressTracker(operationId, maxAttempts) {
  const startTime = Date.now();
  let percentComplete = 0;
  
  const container = document.createElement('div');
  container.id = `polling-progress-${operationId}`;
  container.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 15px;
    background: rgba(0,0,0,0.8);
    color: white;
    border-radius: 10px;
    z-index: 10000;
    max-width: 300px;
  `;
  
  const title = document.createElement('h3');
  title.textContent = 'AI任务处理中...';
  title.style.margin = '0 0 10px 0';
  
  const progress = document.createElement('progress');
  progress.id = `progress-bar-${operationId}`;
  progress.max = maxAttempts;
  progress.value = 0;
  progress.style.width = '100%';
  
  const info = document.createElement('div');
  info.id = `progress-info-${operationId}`;
  info.style.fontSize = '0.8em';
  info.textContent = '初始连接...';
  
  container.appendChild(title);
  container.appendChild(progress);
  container.appendChild(info);
  document.body.appendChild(container);
  
  return {
    start: () => {
      container.style.display = 'block';
    },
    
    onAttempt: (attempt, delay) => {
      progress.value = attempt;
      percentComplete = Math.min(100, Math.round((attempt / maxAttempts) * 100));
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      info.innerHTML = `
        进度: ${percentComplete}% <br>
        尝试: ${attempt}/${maxAttempts} <br>
        延迟: ${Math.round(delay / 1000)}秒 <br>
        用时: ${elapsed}秒
      `;
    },
    
    complete: () => {
      container.remove();
    },
    
    error: errorMsg => {
      title.textContent = '任务处理失败';
      title.style.color = 'red';
      container.style.backgroundColor = 'rgba(80,0,0,0.9)';
      progress.style.display = 'none';
      info.style.whiteSpace = 'pre-wrap';
      info.innerHTML = '';
      const label = document.createElement('span');
      label.style.color = '#ff9494';
      label.textContent = '错误详情:';
      info.appendChild(label);
      info.appendChild(document.createTextNode('\n' + String(errorMsg ?? '')));
    }
  };
}