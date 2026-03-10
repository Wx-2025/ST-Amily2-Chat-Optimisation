/**
 * crypto-utils.js — Web Crypto API 封装
 *
 * 使用混合加密方案（Hybrid Encryption）：
 *   - RSA-OAEP 2048 负责密钥交换（加密 AES 密钥）
 *   - AES-256-GCM 负责实际数据加密
 *
 * 优势：
 *   - RSA 部分无明文长度限制（AES 密钥固定 32 字节，远小于 RSA 上限）
 *   - AES-GCM 提供认证加密（AEAD），防止密文篡改
 *   - 全程使用 Web Crypto API，密钥操作不经过 JS 内存（SubtleCrypto 内部实现）
 */

// ── 密钥对生成与导入导出 ────────────────────────────────────────────────────

/**
 * 生成 RSA-OAEP 2048 密钥对。
 * 返回 { publicKey, privateKey }（均为 CryptoKey 对象）
 */
export async function generateKeyPair() {
    return crypto.subtle.generateKey(
        {
            name: 'RSA-OAEP',
            modulusLength: 2048,
            publicExponent: new Uint8Array([0x01, 0x00, 0x01]), // 65537
            hash: 'SHA-256',
        },
        true,               // extractable = true，以便序列化存储
        ['encrypt', 'decrypt']
    );
}

/**
 * 将密钥对序列化为 JWK 字符串，以便存储。
 * @param {CryptoKeyPair} keyPair
 * @returns {Promise<{ publicJwk: string, privateJwk: string }>}
 */
export async function serializeKeyPair(keyPair) {
    const [publicJwk, privateJwk] = await Promise.all([
        crypto.subtle.exportKey('jwk', keyPair.publicKey),
        crypto.subtle.exportKey('jwk', keyPair.privateKey),
    ]);
    return {
        publicJwk: JSON.stringify(publicJwk),
        privateJwk: JSON.stringify(privateJwk),
    };
}

/**
 * 从 JWK 字符串恢复公钥（用于加密）。
 * @param {string} jwkString
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(jwkString) {
    return crypto.subtle.importKey(
        'jwk',
        JSON.parse(jwkString),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,              // 不需要再次导出
        ['encrypt']
    );
}

/**
 * 从 JWK 字符串恢复私钥（用于解密）。
 * @param {string} jwkString
 * @returns {Promise<CryptoKey>}
 */
export async function importPrivateKey(jwkString) {
    return crypto.subtle.importKey(
        'jwk',
        JSON.parse(jwkString),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        false,
        ['decrypt']
    );
}

// ── 混合加密 / 解密 ──────────────────────────────────────────────────────────

/**
 * 混合加密：RSA-OAEP 包装 AES-256-GCM 密钥，AES-GCM 加密明文。
 *
 * 返回的密文包 JSON 结构：
 * {
 *   wrappedKey: "<base64>",   // RSA 加密的 AES 密钥
 *   iv:         "<base64>",   // AES-GCM 随机 IV（12 字节）
 *   ciphertext: "<base64>",   // AES-GCM 密文（含 GCM tag）
 * }
 *
 * @param {CryptoKey} publicKey  RSA 公钥
 * @param {string}    plaintext  明文字符串
 * @returns {Promise<string>}   序列化的密文包（JSON 字符串）
 */
export async function encrypt(publicKey, plaintext) {
    // 1. 生成一次性 AES-256-GCM 密钥
    const aesKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt']
    );

    // 2. 生成随机 IV（12 字节是 GCM 的推荐长度）
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // 3. 用 AES-GCM 加密明文
    const plainBytes = new TextEncoder().encode(plaintext);
    const ciphertextBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        plainBytes
    );

    // 4. 导出 AES 原始密钥字节，用 RSA 公钥包装
    const rawAesKey = await crypto.subtle.exportKey('raw', aesKey);
    const wrappedKeyBuffer = await crypto.subtle.encrypt(
        { name: 'RSA-OAEP' },
        publicKey,
        rawAesKey
    );

    // 5. 序列化为 base64 JSON 包
    return JSON.stringify({
        wrappedKey: bufToBase64(wrappedKeyBuffer),
        iv:         bufToBase64(iv),
        ciphertext: bufToBase64(ciphertextBuffer),
    });
}

/**
 * 混合解密：用 RSA 私钥解出 AES 密钥，再用 AES-GCM 解密密文。
 *
 * @param {CryptoKey} privateKey RSA 私钥
 * @param {string}    payload    encrypt() 返回的 JSON 字符串
 * @returns {Promise<string>}   原始明文字符串
 */
export async function decrypt(privateKey, payload) {
    const { wrappedKey, iv, ciphertext } = JSON.parse(payload);

    // 1. RSA 解出 AES 密钥字节
    const rawAesKey = await crypto.subtle.decrypt(
        { name: 'RSA-OAEP' },
        privateKey,
        base64ToBuf(wrappedKey)
    );

    // 2. 恢复 AES 密钥对象（只用于解密）
    const aesKey = await crypto.subtle.importKey(
        'raw',
        rawAesKey,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
    );

    // 3. AES-GCM 解密
    const plainBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBuf(iv) },
        aesKey,
        base64ToBuf(ciphertext)
    );

    return new TextDecoder().decode(plainBuffer);
}

// ── 工具函数 ─────────────────────────────────────────────────────────────────

function bufToBase64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuf(base64) {
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}
