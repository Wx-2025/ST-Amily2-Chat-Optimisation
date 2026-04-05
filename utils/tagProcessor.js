
function findLastTagIndices(xmlString, tagName) {
    const closeTag = `</${tagName}>`;
    const lastCloseIndex = xmlString.lastIndexOf(closeTag);
    if (lastCloseIndex === -1) {
        return null;
    }

    const openTagPattern = `<${tagName}`;
    const lastOpenIndex = xmlString.lastIndexOf(openTagPattern, lastCloseIndex);
    if (lastOpenIndex === -1) {
        return null;
    }

    const openTagEndIndex = xmlString.indexOf('>', lastOpenIndex);
    if (openTagEndIndex === -1 || openTagEndIndex > lastCloseIndex) {
        return null;
    }

    return {
        blockStart: lastOpenIndex,
        contentStart: openTagEndIndex + 1,
        contentEnd: lastCloseIndex,
        blockEnd: lastCloseIndex + closeTag.length
    };
}

function extractContentByTag(xmlString, tagName) {
    const indices = findLastTagIndices(xmlString, tagName);
    if (!indices) {
        return null;
    }
    return xmlString.substring(indices.contentStart, indices.contentEnd);
}


function extractFullTagBlock(xmlString, tagName) {
    const indices = findLastTagIndices(xmlString, tagName);
    if (!indices) {
        return null;
    }
    return xmlString.substring(indices.blockStart, indices.blockEnd);
}


function replaceContentByTag(xmlString, tagName, newContent) {
    const indices = findLastTagIndices(xmlString, tagName);
    if (!indices) {
        return xmlString;
    }

    const before = xmlString.substring(0, indices.contentStart);
    const after = xmlString.substring(indices.contentEnd);

    return `${before}${newContent}${after}`;
}

export { extractContentByTag, replaceContentByTag, extractFullTagBlock, opt_extractContentByTag, opt_replaceContentByTag, opt_extractFullTagBlock };


function opt_extractContentByTag(text, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`);
    const match = text.match(regex);
    return match ? match[1] : null;
}

function opt_extractFullTagBlock(text, tagName) {
    const regex = new RegExp(`(<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>)`);
    const match = text.match(regex);
    return match ? match[0] : null;
}


function opt_replaceContentByTag(originalText, tagName, newContent) {
    const regex = new RegExp(`(<${tagName}[^>]*>)([\\s\\S]*?)(<\\/${tagName}>)`);
    const match = originalText.match(regex);

    if (match) {
        const openingTag = match[1];
        const closingTag = match[3];
        return originalText.replace(regex, `${openingTag}${newContent}${closingTag}`);
    }

    return originalText;
}
