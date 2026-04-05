import { getGraph, syncGraphFromTables } from './manager.js';
import { showHtmlModal } from '../../ui/page-window.js';

let echartsLoaded = false;

async function loadECharts() {
    if (echartsLoaded) return;
    if (window.echarts) {
        echartsLoaded = true;
        return;
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js';
        script.onload = () => {
            echartsLoaded = true;
            resolve();
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

export async function showGraphVisualization() {
    // 确保数据是最新的
    syncGraphFromTables();

    const modalHtml = `
        <div id="amily2-graph-container" style="width: 100%; height: 600px; background: rgba(0,0,0,0.2); border-radius: 8px; overflow: hidden;">
            <div style="display: flex; justify-content: center; align-items: center; height: 100%; color: #aaa;">
                <i class="fas fa-spinner fa-spin"></i> 正在加载图谱可视化引擎...
            </div>
        </div>
        <div style="margin-top: 10px; display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 0.9em; color: #888;">
                <i class="fas fa-mouse"></i> 滚轮缩放 / 拖拽平移 / 点击节点查看详情
            </div>
            <div style="display: flex; gap: 10px;">
                <button id="amily2-reorganize-graph-btn" class="menu_button secondary small_button" title="重新布局">
                    <i class="fas fa-random"></i> 抖动布局
                </button>
                <button id="amily2-refresh-graph-btn" class="menu_button menu_button_primary small_button">
                    <i class="fas fa-sync"></i> 刷新数据
                </button>
            </div>
        </div>
    `;

    // Open Modal
    showHtmlModal('人物关系图谱', modalHtml, {
        wide: true,
        large: true,
        onShow: async (dialogElement) => {
             try {
                await loadECharts();
                const container = dialogElement.find('#amily2-graph-container')[0];
                container.innerHTML = ''; // Clear loading
                
                // Initialize Chart
                const chart = echarts.init(container);
                renderChart(chart);

                // Bind Buttons
                dialogElement.find('#amily2-refresh-graph-btn').on('click', () => {
                    syncGraphFromTables();
                    renderChart(chart);
                    toastr.success('图谱数据已刷新');
                });
                
                dialogElement.find('#amily2-reorganize-graph-btn').on('click', () => {
                    chart.setOption({
                         series: [{
                            layout: 'force',
                            force: {
                                initLayout: null,
                                repulsion: 300 + Math.random() * 50 // Slight change to trigger re-layout
                            }
                        }]
                    });
                });

                // Handle resize
                new ResizeObserver(() => chart.resize()).observe(container);

             } catch (e) {
                 console.error('ECharts loading failed', e);
                 dialogElement.find('#amily2-graph-container').html('<p style="color:red; text-align:center; padding-top:200px;">图谱引擎加载失败，请检查网络连接。</p>');
             }
        }
    });
}

function renderChart(chart) {
    const graphData = getGraph();

    if (!graphData.nodes || graphData.nodes.length === 0) {
        chart.clear();
        chart.setOption({
            title: {
                text: '暂无数据',
                subtext: '请确保已启用“角色”相关表格，并且表格中有数据。',
                left: 'center',
                top: 'center',
                textStyle: { color: '#888' }
            }
        });
        return;
    }

    // Transform data for ECharts
    const nodes = graphData.nodes.map(n => ({
        id: n.id,
        name: n.label,
        symbolSize: n.type === 'user' ? 40 : 25,
        itemStyle: {
            color: n.type === 'user' ? '#9e8aff' : '#4caf50',
            shadowBlur: 10,
            shadowColor: 'rgba(0,0,0,0.3)'
        },
        label: {
            show: true,
            position: 'right',
            color: '#eee',
            formatter: '{b}'
        },
        // Store original metadata
        data: n
    }));

    const links = graphData.edges.map(e => ({
        source: e.source,
        target: e.target,
        value: e.relation,
        label: {
            show: true,
            formatter: '{c}',
            color: '#aaa',
            fontSize: 10
        },
        lineStyle: {
            curveness: 0.2,
            color: 'rgba(255,255,255,0.4)'
        }
    }));

    const option = {
        backgroundColor: 'transparent',
        tooltip: {
            trigger: 'item',
            backgroundColor: 'rgba(50,50,50,0.9)',
            borderColor: '#777',
            textStyle: { color: '#fff' },
            formatter: function (params) {
                if (params.dataType === 'node') {
                    const meta = params.data.data.metadata || {};
                    let info = meta.info || '暂无信息';
                    // Truncate long info
                    if (info.length > 100) info = info.substring(0, 100) + '...';
                    
                    return `
                        <div style="font-weight:bold; border-bottom:1px solid #aaa; padding-bottom:5px; margin-bottom:5px;">${params.name}</div>
                        <div style="font-size:0.9em;">类型: ${params.data.data.type}</div>
                        <div style="font-size:0.9em; margin-top:5px; color:#ccc;">${info}</div>
                    `;
                } else {
                    return `${params.data.source} -> ${params.data.target}<br/>关系: ${params.data.value}`;
                }
            }
        },
        legend: {
            show: false
        },
        animationDurationUpdate: 1500,
        animationEasingUpdate: 'quinticInOut',
        series: [
            {
                type: 'graph',
                layout: 'force',
                data: nodes,
                links: links,
                roam: true,
                draggable: true,
                label: {
                    position: 'right',
                    formatter: '{b}'
                },
                lineStyle: {
                    color: 'source',
                    curveness: 0.3
                },
                force: {
                    repulsion: 400,
                    edgeLength: 120,
                    gravity: 0.1
                },
                emphasis: {
                    focus: 'adjacency',
                    itemStyle: {
                        shadowBlur: 20,
                        shadowColor: '#fff'
                    },
                    lineStyle: {
                        width: 4,
                        color: '#fff'
                    }
                }
            }
        ]
    };

    chart.setOption(option);
}
