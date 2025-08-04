function extractContentByTag(xmlString, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`);
  const match = xmlString.match(regex);
  return match ? match[1] : null;
}

function extractFullTagBlock(xmlString, tagName) {
  const regex = new RegExp(`(<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>)`);
  const match = xmlString.match(regex);
  return match ? match[0] : null;
}

function replaceContentByTag(xmlString, tagName, newContent) {
  const regex = new RegExp(`(<${tagName}[^>]*>)[\\s\\S]*?(<\\/${tagName}>)`);
  if (regex.test(xmlString)) {
    return xmlString.replace(regex, `$1${newContent}$2`);
  }
  return xmlString;
}

export { extractContentByTag, replaceContentByTag, extractFullTagBlock };
