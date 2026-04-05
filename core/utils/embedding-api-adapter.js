function getSanitizedBaseUrl(rawApiUrl) {
    let baseUrl = rawApiUrl.trim();
    if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
    }
    if (baseUrl.endsWith('/v1')) {
        baseUrl = baseUrl.slice(0, -3);
    }
    return baseUrl;
}

export async function fetchEmbeddingModels(rawApiUrl, apiKey) {
    if (!rawApiUrl || !apiKey) {
        throw new Error("API URL or Key is not provided.");
    }
    const baseUrl = getSanitizedBaseUrl(rawApiUrl);
    const modelsUrl = `${baseUrl}/v1/models`;

    console.log(`[Embedding Adapter] Fetching models from: ${modelsUrl}`);

    const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Failed to fetch models (${response.status}): ${errorBody}`);
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) {
        throw new Error("Invalid response format from models API: 'data' array not found.");
    }

    // Return all models, sorted alphabetically. The user can choose.
    return data.data.sort((a, b) => a.id.localeCompare(b.id));
}

export async function testEmbeddingConnection(rawApiUrl, apiKey) {
    try {
        await fetchEmbeddingModels(rawApiUrl, apiKey);
        return { success: true, message: "Connection successful! API endpoint is valid." };
    } catch (error) {
        console.error('[Embedding Adapter] Connection test failed:', error);
        return { success: false, message: `Connection failed: ${error.message}` };
    }
}
