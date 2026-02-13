import { getGraph, getRelatedNodes } from "./manager.js";


export async function executeGraphRetrieval(queryText) {
    if (!queryText) return '';

    const graph = getGraph();
    if (!graph.nodes || graph.nodes.length === 0) return '';


    const foundNodes = graph.nodes.filter(node => {
        return queryText.toLowerCase().includes(node.label.toLowerCase());
    });

    if (foundNodes.length === 0) return '';

    console.log(`[关系图谱] 在查询中发现 ${foundNodes.length} 个实体: ${foundNodes.map(n => n.label).join(', ')}`);

    const contextNodes = new Map();

    for (const node of foundNodes) {
        contextNodes.set(node.id, { node, reason: '直接匹配' });

        const related = getRelatedNodes(node.id, 1);
        for (const rel of related) {
            if (!contextNodes.has(rel.node.id)) {
                contextNodes.set(rel.node.id, { 
                    node: rel.node, 
                    reason: `关联至 ${node.label} (${rel.relation})` 
                });
            }
        }
    }

    let output = '';
    const nodesArray = Array.from(contextNodes.values());
    
    if (nodesArray.length > 0) {
        output += '<GraphContext>\n';
        output += '<!-- 以下信息源自关系图谱，基于上下文中的实体自动联想生成。 -->\n';
        
        for (const item of nodesArray) {
            const { node, reason } = item;
            output += `[实体: ${node.label}]\n`;
            output += `  - 来源: ${reason}\n`;
            if (node.metadata && node.metadata.info) {
                output += `  - 信息: ${node.metadata.info}\n`;
            }
            const edges = graph.edges.filter(e => 
                (e.source === node.id && contextNodes.has(e.target)) || 
                (e.target === node.id && contextNodes.has(e.source))
            );
            
            if (edges.length > 0) {
                output += `  - 连接:\n`;
                for (const edge of edges) {
                    const otherId = edge.source === node.id ? edge.target : edge.source;
                    const otherNode = contextNodes.get(otherId).node;
                    const direction = edge.source === node.id ? '->' : '<-';
                    output += `    * ${direction} ${otherNode.label} (${edge.relation})\n`;
                }
            }
            output += '\n';
        }
        output += '</GraphContext>';
    }

    console.log(`[关系图谱] 生成了包含 ${nodesArray.length} 个节点的上下文。`);
    return output;
}
