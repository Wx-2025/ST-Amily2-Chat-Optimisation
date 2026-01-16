/**
 * 通用责任链/中间件管理器
 * 用于规范操作顺序，支持异步流程控制
 */
export class Chain {
    constructor() {
        this.middlewares = [];
    }

    /**
     * 注册中间件
     * @param {Function} fn (context, next) => Promise<void> | void
     */
    use(fn) {
        if (typeof fn !== 'function') {
            throw new Error('[Chain] Middleware must be a function');
        }
        this.middlewares.push(fn);
        return this;
    }

    /**
     * 执行责任链
     * @param {Object} context 传递给中间件的上下文对象
     */
    async execute(context = {}) {
        let index = -1;
        
        const dispatch = async (i) => {
            if (i <= index) {
                throw new Error('[Chain] next() called multiple times in one middleware');
            }
            index = i;
            
            const fn = this.middlewares[i];
            if (!fn) return; // 链结束

            try {
                // 执行中间件，传入 context 和 next 函数
                await fn(context, () => dispatch(i + 1));
            } catch (err) {
                console.error('[Chain] Middleware execution error:', err);
                throw err;
            }
        };

        await dispatch(0);
    }

    /**
     * 清空链
     */
    clear() {
        this.middlewares = [];
    }
}
