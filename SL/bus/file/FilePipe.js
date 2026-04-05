/**
 * FilePipe — 插件独立文件存储管道
 *
 * 解决的问题：
 *   SillyTavern 的 settings.json 被所有插件共享，大型内容（prompt 模板、摘要、
 *   优化结果、缓存）写入后导致文件膨胀，且功能迭代残留的废弃 key 永久堆积。
 *
 * 方案：
 *   以 IndexedDB 为后端，每个插件在独立命名空间下进行读写。
 *   与 settings.json 完全隔离，不参与云同步，无体积上限约束。
 *
 * 存储结构：
 *   DB  : 'Amily2_FilePipe'
 *   Store: 'files'
 *   Key  : 复合键 [plugin, path]（无需为新插件升级 DB 版本）
 *   Entry: { plugin, path, data, updatedAt }
 *
 * 安全：
 *   - 路径禁止包含 '..'（防目录穿越）
 *   - 每个插件只能读写自己命名空间下的路径
 *
 * 使用方式（通过 Amily2Bus capability token）：
 *   const file = ctx.file;          // Amily2Bus 注入
 *   await file.write('config.json', { key: 'value' });
 *   const data = await file.read('config.json');
 *   await file.delete('config.json');
 *   const list = await file.list();
 */

const DB_NAME    = 'Amily2_FilePipe';
const DB_VERSION = 1;
const STORE_NAME = 'files';

// ── IndexedDB 工具 ────────────────────────────────────────────────────────────

let _dbPromise = null;

function _openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, {
                    keyPath: ['plugin', 'path'],
                });
                // 按插件名索引，方便 list() 查询
                store.createIndex('by_plugin', 'plugin', { unique: false });
            }
        };

        req.onsuccess  = (e) => resolve(e.target.result);
        req.onerror    = (e) => {
            _dbPromise = null;
            reject(new Error(`[FilePipe] IndexedDB 打开失败: ${e.target.error}`));
        };
    });
    return _dbPromise;
}

function _tx(db, mode) {
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function _idbRequest(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

// ── FilePipe ──────────────────────────────────────────────────────────────────

class FilePipe {
    constructor() {
        this.name = 'FilePipe';
    }

    // ── 安全路径校验 ─────────────────────────────────────────────────────────

    _safePath(plugin, path) {
        if (!plugin || typeof plugin !== 'string') {
            console.error('[FilePipe] 无效的插件标识。');
            return null;
        }
        if (!path || typeof path !== 'string') {
            console.error('[FilePipe] 无效的路径。');
            return null;
        }
        if (path.includes('..')) {
            console.error(`[FilePipe] 安全拦截：插件 "${plugin}" 尝试目录穿越，路径: ${path}`);
            return null;
        }
        // 规范化：去掉开头的斜杠
        return path.replace(/^\/+/, '');
    }

    // ── 公开 API ─────────────────────────────────────────────────────────────

    /**
     * 读取文件。
     * @param {string} plugin  插件名（命名空间）
     * @param {string} path    文件路径（相对于插件根目录）
     * @returns {Promise<any>} 存储的数据，不存在时返回 null
     */
    async read(plugin, path) {
        const safePath = this._safePath(plugin, path);
        if (!safePath) return null;

        try {
            const db     = await _openDB();
            const result = await _idbRequest(_tx(db, 'readonly').get([plugin, safePath]));
            return result?.data ?? null;
        } catch (e) {
            console.error(`[FilePipe] read 失败 (${plugin}/${path}):`, e);
            return null;
        }
    }

    /**
     * 写入文件。
     * @param {string} plugin  插件名
     * @param {string} path    文件路径
     * @param {any}    data    任意可序列化数据（对象、字符串、ArrayBuffer 等）
     * @returns {Promise<boolean>}
     */
    async write(plugin, path, data) {
        const safePath = this._safePath(plugin, path);
        if (!safePath) return false;

        try {
            const db = await _openDB();
            await _idbRequest(_tx(db, 'readwrite').put({
                plugin,
                path:      safePath,
                data,
                updatedAt: new Date().toISOString(),
            }));
            return true;
        } catch (e) {
            console.error(`[FilePipe] write 失败 (${plugin}/${path}):`, e);
            return false;
        }
    }

    /**
     * 删除文件。
     * @param {string} plugin
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async delete(plugin, path) {
        const safePath = this._safePath(plugin, path);
        if (!safePath) return false;

        try {
            const db = await _openDB();
            await _idbRequest(_tx(db, 'readwrite').delete([plugin, safePath]));
            return true;
        } catch (e) {
            console.error(`[FilePipe] delete 失败 (${plugin}/${path}):`, e);
            return false;
        }
    }

    /**
     * 列出插件下所有文件的路径（可按前缀过滤）。
     * @param {string}  plugin
     * @param {string}  [prefix='']  路径前缀过滤
     * @returns {Promise<string[]>}
     */
    async list(plugin, prefix = '') {
        if (!plugin) return [];

        try {
            const db    = await _openDB();
            const store = _tx(db, 'readonly');
            const index = store.index('by_plugin');
            const range = IDBKeyRange.only(plugin);

            return new Promise((resolve, reject) => {
                const paths = [];
                const req   = index.openCursor(range);
                req.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (!cursor) { resolve(paths); return; }
                    if (!prefix || cursor.value.path.startsWith(prefix)) {
                        paths.push(cursor.value.path);
                    }
                    cursor.continue();
                };
                req.onerror = (e) => reject(e.target.error);
            });
        } catch (e) {
            console.error(`[FilePipe] list 失败 (${plugin}):`, e);
            return [];
        }
    }

    /**
     * 清空插件下的所有文件（插件卸载/重置时调用）。
     * @param {string} plugin
     * @returns {Promise<number>} 删除的文件数量
     */
    async clearAll(plugin) {
        const paths = await this.list(plugin);
        let count   = 0;
        for (const path of paths) {
            if (await this.delete(plugin, path)) count++;
        }
        console.info(`[FilePipe] 已清除插件 "${plugin}" 的 ${count} 个文件。`);
        return count;
    }

    /**
     * 读取文件元数据（不含 data 本身）。
     * @param {string} plugin
     * @param {string} path
     * @returns {Promise<{path, updatedAt}|null>}
     */
    async stat(plugin, path) {
        const safePath = this._safePath(plugin, path);
        if (!safePath) return null;

        try {
            const db     = await _openDB();
            const result = await _idbRequest(_tx(db, 'readonly').get([plugin, safePath]));
            if (!result) return null;
            return { path: result.path, updatedAt: result.updatedAt };
        } catch (e) {
            return null;
        }
    }

    /**
     * 生成绑定了插件名的快捷访问对象（供 Amily2Bus capability token 注入用）。
     * 使用方不需要每次传 plugin 参数。
     *
     * 示例：
     *   const file = filePipe.forPlugin('TableSystem');
     *   await file.write('presets.json', data);
     *
     * @param {string} plugin
     * @returns {{ read, write, delete, list, clearAll, stat }}
     */
    forPlugin(plugin) {
        return {
            read:     (path)        => this.read(plugin, path),
            write:    (path, data)  => this.write(plugin, path, data),
            delete:   (path)        => this.delete(plugin, path),
            list:     (prefix)      => this.list(plugin, prefix),
            clearAll: ()            => this.clearAll(plugin),
            stat:     (path)        => this.stat(plugin, path),
        };
    }
}

export default FilePipe;
