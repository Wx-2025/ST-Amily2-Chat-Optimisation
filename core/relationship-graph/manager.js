import { getContext, extension_settings } from "/scripts/extensions.js";
import { getCharacterStableId } from "../utils/context-utils.js";
import { getMemoryState } from "../table-system/manager.js";
import { extensionName } from "../../utils/settings.js";

const GRAPH_KEY = 'Amily2_Relationship_Graph';

let graphData = {
    nodes: [],
    edges: []
};

export function getGraph() {
    return graphData;
}

export function clearGraph() {
    graphData = { nodes: [], edges: [] };
    saveGraph();
}


export function syncGraphFromTables() {
    const tables = getMemoryState();
    if (!tables) return;

    const charTable = tables.find(t => t.name.includes('角色') || t.name === 'Character');
    if (!charTable) return;

    graphData = { nodes: [], edges: [] };

    const context = getContext();
    const userName = context.name1 || '用户';
    addNode('user', userName, 'user');

    const nameIdx = charTable.headers.findIndex(h => h.includes('角色名') || h.includes('Name'));
    const relationIdx = charTable.headers.findIndex(h => h.includes('关系') || h.includes('Relation'));
    const infoIdx = charTable.headers.findIndex(h => h.includes('重要信息') || h.includes('Info'));

    if (nameIdx === -1) return;

    charTable.rows.forEach(row => {
        const name = row[nameIdx];
        if (!name) return;

        const metadata = {};
        if (infoIdx !== -1) metadata.info = row[infoIdx];
        addNode(name, name, 'character', metadata);

        if (relationIdx !== -1 && row[relationIdx]) {
            const relation = row[relationIdx];
            addEdge(name, 'user', relation);
        }
    });

    console.log(`[关系图谱] 已从表格同步 ${graphData.nodes.length} 个节点和 ${graphData.edges.length} 条边。`);
    saveGraph();
}

export function addNode(id, label, type = 'entity', metadata = {}) {
    const safeId = id.trim();
    if (!graphData.nodes.find(n => n.id === safeId)) {
        graphData.nodes.push({ id: safeId, label, type, metadata });
        return true;
    }
    return false;
}

export function addEdge(source, target, relation, weight = 1.0) {
    const safeSource = source.trim();
    const safeTarget = target.trim();

    const sourceNode = graphData.nodes.find(n => n.id === safeSource);
    const targetNode = graphData.nodes.find(n => n.id === safeTarget);
    
    if (!sourceNode || !targetNode) {
        return false;
    }

    const existingEdge = graphData.edges.find(e => 
        e.source === safeSource && e.target === safeTarget && e.relation === relation
    );

    if (!existingEdge) {
        graphData.edges.push({ source: safeSource, target: safeTarget, relation, weight });
        return true;
    }
    return false;
}

export function getRelatedNodes(nodeId, maxDepth = 1) {
    const related = [];
    const queue = [{ id: nodeId, depth: 0 }];
    const visited = new Set([nodeId]);

    while (queue.length > 0) {
        const { id, depth } = queue.shift();
        if (depth >= maxDepth) continue;

        const outgoing = graphData.edges.filter(e => e.source === id);
        for (const edge of outgoing) {
            if (!visited.has(edge.target)) {
                visited.add(edge.target);
                const node = graphData.nodes.find(n => n.id === edge.target);
                if (node) {
                    related.push({ node, relation: edge.relation, direction: 'out', depth: depth + 1 });
                    queue.push({ id: edge.target, depth: depth + 1 });
                }
            }
        }

        const incoming = graphData.edges.filter(e => e.target === id);
        for (const edge of incoming) {
            if (!visited.has(edge.source)) {
                visited.add(edge.source);
                const node = graphData.nodes.find(n => n.id === edge.source);
                if (node) {
                    related.push({ node, relation: edge.relation, direction: 'in', depth: depth + 1 });
                    queue.push({ id: edge.source, depth: depth + 1 });
                }
            }
        }
    }

    return related;
}

export async function saveGraph() {
    const context = getContext();
    const charId = getCharacterStableId();
    if (!charId) return;

    if (!context.extensionSettings.relationship_graphs) {
        context.extensionSettings.relationship_graphs = {};
    }
    
    context.extensionSettings.relationship_graphs[charId] = graphData;
    context.saveSettingsDebounced();
}

export async function loadGraph() {
    const context = getContext();
    const charId = getCharacterStableId();
    if (!charId) return;

    if (context.extensionSettings.relationship_graphs && context.extensionSettings.relationship_graphs[charId]) {
        graphData = context.extensionSettings.relationship_graphs[charId];
        console.log(`[关系图谱] 已加载角色 ${charId} 的图谱: ${graphData.nodes.length} 个节点, ${graphData.edges.length} 条边。`);
    } else {
        graphData = { nodes: [], edges: [] };
    }
}

const context = getContext();
if (context) {
    loadGraph();
    document.addEventListener('AMILY2_TABLE_UPDATED', (e) => {
        const { tableName } = e.detail;
        if (tableName.includes('角色') || tableName === 'Character') {
            console.log('[关系图谱] 检测到角色表格更新，正在同步图谱...');
            syncGraphFromTables();
        }
    });
}
