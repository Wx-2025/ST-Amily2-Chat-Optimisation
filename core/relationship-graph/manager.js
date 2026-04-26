import { getContext, extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
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

    graphData = { nodes: [], edges: [] };

    const context = getContext();
    const userName = context.name1 || '用户';
    addNode('user', userName, 'user');

    // 1. 处理角色表 (Character Table)
    const charTable = tables.find(t => t.name.includes('角色') || t.name === 'Character');
    if (charTable) {
        const nameIdx = charTable.headers.findIndex(h => h.includes('角色名') || h.includes('Name'));
        const relationIdx = charTable.headers.findIndex(h => h.includes('关系') || h.includes('Relation'));
        const infoIdx = charTable.headers.findIndex(h => h.includes('重要信息') || h.includes('Info'));
        const targetIdx = charTable.headers.findIndex(h => /(对象|指向|Target|To|Object)/i.test(h));

        if (nameIdx !== -1) {
            charTable.rows.forEach(row => {
                const name = row[nameIdx];
                if (!name) return;

                const metadata = {};
                if (infoIdx !== -1) metadata.info = row[infoIdx];
                addNode(name, name, 'character', metadata);

                if (relationIdx !== -1 && row[relationIdx]) {
                    const relation = row[relationIdx];
                    let targetId = 'user';

                    // Check if there is an explicit target for the relationship
                    if (targetIdx !== -1 && row[targetIdx]) {
                        targetId = row[targetIdx].trim();
                        addNode(targetId, targetId, targetId === 'user' || targetId === userName ? 'user' : 'entity');
                    }

                    addEdge(name, targetId, relation);
                }
            });
        }
    }

    // 2. 处理关系表 (Relationship Table)
    const relTable = tables.find(t => t.name.includes('关系') || t.name === 'Relationship');
    if (relTable) {
        const sourceIdx = relTable.headers.findIndex(h => /(主动方|Source|Subject|From)/i.test(h));
        const targetIdx = relTable.headers.findIndex(h => /(被动方|对象|Target|Object|To)/i.test(h));
        const relationIdx = relTable.headers.findIndex(h => /(关系|Relation)/i.test(h));
        const detailIdx = relTable.headers.findIndex(h => /(详情|Detail|Info)/i.test(h));

        if (sourceIdx !== -1 && targetIdx !== -1 && relationIdx !== -1) {
            relTable.rows.forEach(row => {
                const source = row[sourceIdx];
                const target = row[targetIdx];
                const relation = row[relationIdx];
                
                if (!source || !target || !relation) return;

                // 确保节点存在
                addNode(source, source, source === userName ? 'user' : 'entity');
                addNode(target, target, target === userName ? 'user' : 'entity');

                addEdge(source, target, relation);
            });
        }
    }

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

function getGraphStore(create = false) {
    if (!extension_settings[extensionName]) {
        if (!create) return null;
        extension_settings[extensionName] = {};
    }
    const root = extension_settings[extensionName];
    if (!root.relationship_graphs) {
        if (!create) return null;
        root.relationship_graphs = {};
    }
    return root.relationship_graphs;
}

function migrateLegacyRelationshipGraphs() {
    const legacy = extension_settings.relationship_graphs;
    if (!legacy || typeof legacy !== 'object') return;

    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const root = extension_settings[extensionName];

    if (!root.relationship_graphs) {
        root.relationship_graphs = legacy;
        console.log(`[关系图谱] 已迁移旧版 'relationship_graphs' 到 extension_settings['${extensionName}']。`);
    } else {
        console.log(`[关系图谱] 发现遗留顶层 'relationship_graphs'，但新位置已存在；合并遗留数据并清理顶层。`);
        for (const [cid, data] of Object.entries(legacy)) {
            if (!root.relationship_graphs[cid]) {
                root.relationship_graphs[cid] = data;
            }
        }
    }

    delete extension_settings.relationship_graphs;
    saveSettingsDebounced();
}

export async function saveGraph() {
    const charId = getCharacterStableId();
    if (!charId) return;

    const store = getGraphStore(true);
    if (!store) return;

    store[charId] = graphData;
    saveSettingsDebounced();
}

export async function loadGraph() {
    const charId = getCharacterStableId();
    if (!charId) return;

    const store = getGraphStore(false);
    if (store && store[charId]) {
        graphData = store[charId];
        console.log(`[关系图谱] 已加载角色 ${charId} 的图谱: ${graphData.nodes.length} 个节点, ${graphData.edges.length} 条边。`);
    } else {
        graphData = { nodes: [], edges: [] };
    }
}

const context = getContext();
if (context) {
    migrateLegacyRelationshipGraphs();
    loadGraph();
    document.addEventListener('AMILY2_TABLE_UPDATED', (e) => {
        const { tableName } = e.detail;
        if (tableName.includes('角色') || tableName === 'Character' || tableName.includes('关系') || tableName === 'Relationship') {
            console.log('[关系图谱] 检测到相关表格更新，正在同步图谱...');
            syncGraphFromTables();
        }
    });
}
