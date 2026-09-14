export function embeddingEndpointForProvider(provider) {
    if (provider === 'sillytavern_backend') return 'st_backend';
    if (provider === 'google') return 'google_direct';
    if (provider === 'sillytavern_preset') {
        throw new Error('Embedding does not support chat preset forwarding.');
    }
    return 'custom';
}

export function embeddingRequestUrl(endpoint, url) {
    if (endpoint !== 'st_backend') return url;
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        throw new Error('Invalid embedding proxy URL.');
    }
    return `/proxy/${target.href}`;
}
