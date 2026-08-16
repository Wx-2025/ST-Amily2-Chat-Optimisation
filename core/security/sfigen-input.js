const MAX_IMAGE_URL_LENGTH = 8192;
const LOCAL_HOST_SUFFIXES = [
    '.localhost',
    '.local',
    '.internal',
    '.lan',
    '.home',
    '.home.arpa',
];

function isIpLiteral(hostname) {
    return hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

function isLocalHostname(hostname) {
    if (!hostname.includes('.') || hostname === 'localhost') {
        return true;
    }
    return LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Accept only public-looking HTTPS image URLs. This deliberately rejects IP
 * literals and local DNS suffixes so chat content cannot directly target a
 * loopback or private-network service. Server-side allowlisting remains the
 * only complete protection against DNS rebinding.
 */
export function normalizePublicHttpsImageUrl(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const input = value.trim();
    if (!input || input.length > MAX_IMAGE_URL_LENGTH) {
        return null;
    }

    let parsed;
    try {
        parsed = new URL(input);
    } catch {
        return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
        parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || parsed.port
        || isIpLiteral(hostname)
        || isLocalHostname(hostname)
    ) {
        return null;
    }

    parsed.hash = '';
    return parsed.href;
}

export function parsePublicHttpsImageUrlList(value) {
    if (typeof value !== 'string') {
        return [];
    }

    const urls = value
        .split(/,(?=\s*[A-Za-z][A-Za-z0-9+.-]*:)/)
        .map((item) => normalizePublicHttpsImageUrl(item))
        .filter(Boolean);

    return [...new Set(urls)];
}

export function normalizeSfiGenTag(value) {
    const tag = typeof value === 'string' ? value.trim() : '';
    return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(tag) ? tag : 'sfigen';
}
