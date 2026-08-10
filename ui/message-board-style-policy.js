// Curated announcement style policy. Resource loading, page positioning,
// animation, interaction and unbounded sizing are intentionally unsupported.

export const MESSAGE_BOARD_ALLOWED_TAGS = Object.freeze([
    'a',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'dd',
    'del',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'ins',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    's',
    'samp',
    'small',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
]);

export const MESSAGE_BOARD_ALLOWED_ATTRS = Object.freeze([
    'href',
    'target',
    'title',
    'rel',
    'style',
]);

const TEXT_STYLE_PROPERTIES = Object.freeze([
    'color',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'text-align',
    'text-transform',
    'text-decoration',
    'text-decoration-color',
    'text-decoration-style',
    'text-underline-offset',
    'vertical-align',
    'overflow-wrap',
    'word-break',
]);
const BLOCK_STYLE_PROPERTIES = Object.freeze([
    'background-color',
    'border-color',
    'border-width',
    'border-style',
    'border-radius',
    'margin-top',
    'margin-bottom',
    'padding',
    'padding-top',
    'padding-bottom',
    'padding-left',
    'padding-right',
]);
const INLINE_STYLE_PROPERTIES = Object.freeze([
    'background-color',
    'border-color',
    'border-width',
    'border-style',
    'border-radius',
    'padding-left',
    'padding-right',
]);
const LIST_STYLE_PROPERTIES = Object.freeze([
    'list-style-type',
    'list-style-position',
    'padding-left',
    'margin-top',
    'margin-bottom',
]);
const CODE_STYLE_PROPERTIES = Object.freeze([
    'font-family',
    'white-space',
    'tab-size',
    'background-color',
    'border-color',
    'border-width',
    'border-style',
    'border-radius',
    'padding',
]);
const TABLE_STYLE_PROPERTIES = Object.freeze([
    'border-collapse',
    'border-spacing',
    'caption-side',
    'empty-cells',
    'table-layout',
]);
const BLOCKQUOTE_STYLE_PROPERTIES = Object.freeze([
    'border-left-color',
    'border-left-width',
    'border-left-style',
]);
const HR_STYLE_PROPERTIES = Object.freeze([
    'border-top-color',
    'border-top-width',
    'border-top-style',
    'margin-top',
    'margin-bottom',
]);

export const MESSAGE_BOARD_ALLOWED_STYLE_PROPERTIES = Object.freeze([
    ...new Set([
        ...TEXT_STYLE_PROPERTIES,
        ...BLOCK_STYLE_PROPERTIES,
        ...INLINE_STYLE_PROPERTIES,
        ...LIST_STYLE_PROPERTIES,
        ...CODE_STYLE_PROPERTIES,
        ...TABLE_STYLE_PROPERTIES,
        ...BLOCKQUOTE_STYLE_PROPERTIES,
        ...HR_STYLE_PROPERTIES,
    ]),
]);

const STYLEABLE_TAGS = new Set(MESSAGE_BOARD_ALLOWED_TAGS.filter(tag => !['br', 'hr'].includes(tag)));
const INLINE_TAGS = new Set([
    'a', 'b', 'code', 'del', 'em', 'i', 'ins', 'kbd', 'mark', 's', 'samp', 'small',
    'span', 'strong', 'sub', 'sup', 'u',
]);
const BLOCK_TAGS = new Set([
    'blockquote', 'caption', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'li', 'ol', 'p', 'pre', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'tr', 'ul',
]);
const LIST_TAGS = new Set(['li', 'ol', 'ul']);
const CODE_TAGS = new Set(['code', 'kbd', 'pre', 'samp']);
const TABLE_TAGS = new Set(['caption', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr']);
const BORDER_STYLES = new Set(['none', 'solid', 'dashed', 'dotted', 'double']);
const TEXT_STYLE_PROPERTY_SET = new Set(TEXT_STYLE_PROPERTIES);
const BLOCK_STYLE_PROPERTY_SET = new Set(BLOCK_STYLE_PROPERTIES);
const INLINE_STYLE_PROPERTY_SET = new Set(INLINE_STYLE_PROPERTIES);
const LIST_STYLE_PROPERTY_SET = new Set(LIST_STYLE_PROPERTIES);
const CODE_STYLE_PROPERTY_SET = new Set(CODE_STYLE_PROPERTIES);
const TABLE_STYLE_PROPERTY_SET = new Set(TABLE_STYLE_PROPERTIES);
const BLOCKQUOTE_STYLE_PROPERTY_SET = new Set(BLOCKQUOTE_STYLE_PROPERTIES);
const HR_STYLE_PROPERTY_SET = new Set(HR_STYLE_PROPERTIES);

function isNumericRange(value, min, max) {
    if (!/^\d+(?:\.\d+)?$/u.test(value)) return false;
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max;
}

function isPxLength(value, min, max) {
    if (value === '0') return min <= 0;
    const match = value.match(/^(\d+(?:\.\d+)?)px$/u);
    return Boolean(match) && isNumericRange(match[1], min, max);
}

function isPxList(value, min, max, maxTokens = 4) {
    const tokens = value.split(/\s+/u).filter(Boolean);
    return tokens.length >= 1
        && tokens.length <= maxTokens
        && tokens.every(token => isPxLength(token, min, max));
}

function isColorChannel(value) {
    if (/^\d{1,3}$/u.test(value)) return Number(value) <= 255;
    const percent = value.match(/^(\d+(?:\.\d+)?)%$/u);
    return Boolean(percent) && Number(percent[1]) <= 100;
}

function isAlphaChannel(value) {
    if (isNumericRange(value, 0, 1)) return true;
    const percent = value.match(/^(\d+(?:\.\d+)?)%$/u);
    return Boolean(percent) && Number(percent[1]) <= 100;
}

function isSafeColor(value) {
    if (/^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/u.test(value)) {
        return true;
    }
    if (/^(?:transparent|currentcolor)$/u.test(value)) return true;

    const functionalColor = value.match(/^(rgb|rgba)\(([^()]*)\)$/u);
    if (!functionalColor) return false;

    const channels = functionalColor[2].split(',').map(part => part.trim());
    const expectedLength = functionalColor[1] === 'rgba' ? 4 : 3;
    return channels.length === expectedLength
        && channels.slice(0, 3).every(isColorChannel)
        && (expectedLength === 3 || isAlphaChannel(channels[3]));
}

function isSafeTextDecoration(value) {
    if (value === 'none') return true;
    const tokens = value.split(/\s+/u).filter(Boolean);
    const allowed = new Set(['underline', 'overline', 'line-through']);
    return tokens.length >= 1
        && tokens.length <= 3
        && new Set(tokens).size === tokens.length
        && tokens.every(token => allowed.has(token));
}

function isPropertyAllowedForTag(tagName, property) {
    if (tagName === 'hr') return HR_STYLE_PROPERTY_SET.has(property);
    if (!STYLEABLE_TAGS.has(tagName)) return false;
    if (TEXT_STYLE_PROPERTY_SET.has(property)) return true;
    if (BLOCK_TAGS.has(tagName) && BLOCK_STYLE_PROPERTY_SET.has(property)) return true;
    if (INLINE_TAGS.has(tagName) && INLINE_STYLE_PROPERTY_SET.has(property)) return true;
    if (LIST_TAGS.has(tagName) && LIST_STYLE_PROPERTY_SET.has(property)) return true;
    if (CODE_TAGS.has(tagName) && CODE_STYLE_PROPERTY_SET.has(property)) return true;
    if (TABLE_TAGS.has(tagName) && TABLE_STYLE_PROPERTY_SET.has(property)) return true;
    if (tagName === 'blockquote' && BLOCKQUOTE_STYLE_PROPERTY_SET.has(property)) return true;
    return false;
}

const STYLE_VALIDATORS = Object.freeze({
    'background-color': value => isSafeColor(value),
    'border-color': value => isSafeColor(value),
    'border-width': value => isPxLength(value, 0, 3),
    'border-style': value => BORDER_STYLES.has(value),
    'border-radius': value => isPxList(value, 0, 16),
    'border-left-color': value => isSafeColor(value),
    'border-left-width': value => isPxLength(value, 0, 3),
    'border-left-style': value => BORDER_STYLES.has(value),
    'border-top-color': value => isSafeColor(value),
    'border-top-width': value => isPxLength(value, 0, 3),
    'border-top-style': value => BORDER_STYLES.has(value),
    'border-collapse': value => /^(?:collapse|separate)$/u.test(value),
    'border-spacing': value => isPxList(value, 0, 16, 2),
    'caption-side': value => /^(?:top|bottom)$/u.test(value),
    color: value => isSafeColor(value),
    'empty-cells': value => /^(?:show|hide)$/u.test(value),
    'font-family': value => /^(?:serif|sans-serif|monospace|system-ui)$/u.test(value),
    'font-size': value => isPxLength(value, 10, 28),
    'font-style': value => /^(?:normal|italic)$/u.test(value),
    'font-weight': value => /^(?:normal|bold|[1-9]00)$/u.test(value),
    'letter-spacing': value => isPxLength(value, 0, 3),
    'line-height': value => isNumericRange(value, 1, 2.4),
    'list-style-position': value => /^(?:inside|outside)$/u.test(value),
    'list-style-type': value => /^(?:none|disc|circle|square|decimal|decimal-leading-zero|lower-alpha|upper-alpha|lower-roman|upper-roman)$/u.test(value),
    'margin-bottom': value => isPxLength(value, 0, 24),
    'margin-top': value => isPxLength(value, 0, 24),
    'overflow-wrap': value => /^(?:normal|break-word|anywhere)$/u.test(value),
    padding: (value, tagName) => isPxList(value, 0, INLINE_TAGS.has(tagName) ? 8 : 16),
    'padding-bottom': value => isPxLength(value, 0, 16),
    'padding-left': (value, tagName) => isPxLength(value, 0, LIST_TAGS.has(tagName) ? 32 : (INLINE_TAGS.has(tagName) ? 8 : 16)),
    'padding-right': (value, tagName) => isPxLength(value, 0, INLINE_TAGS.has(tagName) ? 8 : 16),
    'padding-top': value => isPxLength(value, 0, 16),
    'tab-size': value => /^\d+$/u.test(value) && Number(value) >= 2 && Number(value) <= 8,
    'table-layout': value => /^(?:auto|fixed)$/u.test(value),
    'text-align': value => /^(?:left|right|center|justify|start|end)$/u.test(value),
    'text-decoration': value => isSafeTextDecoration(value),
    'text-decoration-color': value => isSafeColor(value),
    'text-decoration-style': value => /^(?:solid|double|dotted|dashed|wavy)$/u.test(value),
    'text-transform': value => /^(?:none|capitalize|uppercase|lowercase)$/u.test(value),
    'text-underline-offset': value => isPxLength(value, 0, 6),
    'vertical-align': value => /^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/u.test(value),
    'white-space': value => /^(?:normal|pre|pre-wrap|pre-line|break-spaces)$/u.test(value),
    'word-break': value => /^(?:normal|break-all|keep-all|break-word)$/u.test(value),
});

export function filterMessageBoardStyleDeclarations(tagName, rawStyle) {
    const normalizedTag = String(tagName ?? '').trim().toLowerCase();
    const styleText = String(rawStyle ?? '');
    if (styleText.length > 4096) return [];

    const declarations = styleText.split(';');
    if (declarations.length > 64) return [];

    const safeDeclarations = [];

    for (const declaration of declarations) {
        const separatorIndex = declaration.indexOf(':');
        if (separatorIndex <= 0) continue;

        const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
        const value = declaration.slice(separatorIndex + 1).trim().toLowerCase();
        const validate = STYLE_VALIDATORS[property];

        if (isPropertyAllowedForTag(normalizedTag, property) && validate?.(value, normalizedTag)) {
            safeDeclarations.push([property, value]);
        }
    }

    return safeDeclarations;
}