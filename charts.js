// VARIÁVEIS GLOBAIS

let charts = {};
let map;
let routePolylines = [];
let pointMarker = null;     
let startMarker, endMarker;
let currentRouteId = null;
let coordenadasGlobal = [];
let currentImpactThreshold = 8.0;
let inCompareMode = false;

// Elementos do DOM 

const loader = document.getElementById('loader');
const welcomeScreen = document.getElementById('welcome-screen');
const analysisContent = document.getElementById('analysis-content');
const mainTitle = document.getElementById('main-title');
const compareBtn = document.getElementById('compare-btn');
const cancelCompareBtn = document.getElementById('cancel-compare-btn');
const kpiContainer = document.getElementById('kpi-container');
const kpiComparisonContainer = document.getElementById('kpi-comparison-container');
const ensaioDetailsContainer = document.getElementById('ensaio-details');

// FUNÇÕES DE UI E FEEDBACK VISUAL

function showLoader() { loader.style.display = 'flex'; }
function hideLoader() { loader.style.display = 'none'; }

function showAnalysisContent() {
    welcomeScreen.style.display = 'none';
    analysisContent.style.display = 'block';
    if (map) { setTimeout(() => map.invalidateSize(), 400); }
}

function showWelcomeScreen() {
    welcomeScreen.style.display = 'block';
    analysisContent.style.display = 'none';
    mainTitle.innerText = 'Análise de Sensores';
    clearAllVisuals(true);
}

// PLUGIN DO CHART.JS (PARA SINCRONIZAÇÃO)

const crosshairPlugin = {
    id: 'crosshair',
    afterInit: (chart) => { chart.crosshair = { x: 0 }; },
    afterEvent: (chart, args) => {
        const { event } = args;
        const { chartArea } = chart;
        if (event.type === 'mousemove' && event.x >= chartArea.left && event.x <= chartArea.right) {
            const pos = { x: event.x };
            const elements = chart.getElementsAtEventForMode(event, 'index', { intersect: false });
            const dataIndex = elements.length ? elements[0].index : undefined;
            Object.values(charts).forEach(c => {
                if (c) {
                    c.crosshair.x = pos.x;
                    c.draw();
                    if (dataIndex !== undefined) {
                        c.tooltip.setActiveElements([{ datasetIndex: 0, index: dataIndex }], { x: pos.x, y: event.y });
                    }
                }
            });
        }
        if (event.type === 'mouseout') {
             Object.values(charts).forEach(c => {
                 if (c) {
                    c.crosshair.x = 0;
                    c.tooltip.setActiveElements([]);
                    c.draw();
                 }
             });
        }
    },
    afterDraw: (chart, args, options) => {
        const { ctx, chartArea: { top, bottom, left, right } } = chart;
        const { x } = chart.crosshair;
        if (x > 0 && x >= left && x <= right) {
            ctx.save(); ctx.beginPath(); ctx.lineWidth = 1; ctx.strokeStyle = '#999';
            ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
        }
    }
};
Chart.register(crosshairPlugin);

// FUNÇÕES DE MAPA E GRÁFICOS

function initMap() {
    if (map) return;
    map = L.map('map').setView([-15.78, -47.92], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
}

async function updateMapMarker(index) {
    if (coordenadasGlobal && coordenadasGlobal[index]) {
        const [lat, lon] = coordenadasGlobal[index];
        if (pointMarker) {
            map.removeLayer(pointMarker);
        }
        pointMarker = L.marker([lat, lon]).addTo(map);
        pointMarker.bindPopup("<i>Buscando endereço...</i>").openPopup();
        try {
            const response = await fetch(`/reverse_geocode?lat=${lat}&lon=${lon}`);
            const data = await response.json();
            const address = data.address || 'Endereço não encontrado';
            pointMarker.getPopup().setContent(address);
        } catch (err) {
            pointMarker.getPopup().setContent("Erro ao buscar endereço.");
        }
    }
}


function updateMap(allCoords, datasets) {
    if (!map) return;
    map.invalidateSize();
    routePolylines.forEach(p => map.removeLayer(p));
    routePolylines = [];
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    if (endMarker) { map.removeLayer(endMarker); endMarker = null; }

    const colors = ['#0f0b60', '#d90429', '#064832', '#ffc300'];
    let allBounds = [];

    allCoords.forEach((coords, index) => {
        if (coords.length > 0) {
            const polyline = L.polyline(coords, { color: colors[index % colors.length], weight: 5 }).addTo(map);
            routePolylines.push(polyline);
            allBounds.push(polyline.getBounds());
            polyline.bindPopup(`<b>Ensaio:</b> ${datasets[index].name}`);
        }
    });

    if (allBounds.length > 0) {
        map.fitBounds(L.latLngBounds(allBounds).pad(0.1));
    }
}

function initCharts() {
    charts.tempChart = createChart('tempChart', 'Temperatura (°C)');
    charts.vibChart = createChart('vibChart', 'Vibração (m/s²)');
    charts.umidChart = createChart('umidChart', 'Umidade Relativa (%)');
}

function createChart(ctxId, title) {
    const canvas = document.getElementById(ctxId);
    if (!canvas) return null;
    return new Chart(canvas, {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: {
                mode: 'index', // Procura por pontos no mesmo índice (verticalmente)
                intersect: false, // Não precisa estar exatamente sobre o ponto
            },
            onClick: (e) => {
                const chartInstance = Chart.getChart(e.native.target.id);
                if (!inCompareMode) {
                    // Usa o modo de interação para encontrar o ponto mais próximo
                    const activePoints = chartInstance.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
                    if (activePoints.length > 0) {
                        updateMapMarker(activePoints[0].index);
                    }
                }
            },
            plugins: { 
                legend: { display: true, position: 'top' }, 
                tooltip: { mode: 'index', intersect: false },
                title: {
                    display: true,
                    text: title,
                    font: {
                        size: 16
                    }
                }
            },
            scales: { y: { beginAtZero: false, grace: '5%' } }
        }
    });
}

function updateChartsForComparison(data) {
    const chartColors = ['#0f0b60', '#d90429', '#064832', '#ffc300'];
    Object.values(charts).forEach(c => { if(c) c.data.datasets = []; });

    data.datasets.forEach((dataset, index) => {
        const color = chartColors[index % chartColors.length];
        const datasetOptions = {
            label: dataset.name,
            borderColor: color,
            tension: 0.2,
            pointRadius: 0,           // Pontos continuam invisíveis
            pointHoverRadius: 5,      // Ponto aparece ao passar o mouse
            pointHitRadius: 15        // Área de clique aumentada
        };

        charts.tempChart.data.datasets.push({ ...datasetOptions, data: dataset.temperatura });
        charts.vibChart.data.datasets.push({ ...datasetOptions, data: dataset.vibracao });
        charts.umidChart.data.datasets.push({ ...datasetOptions, data: dataset.umidade });
    });

    Object.values(charts).forEach(c => {
        if(c) { c.data.labels = data.labels; c.update(); }
    });
}

// FUNÇÕES DE ATUALIZAÇÃO DE UI E DADOS

function updateEnsaioDetails(details) {
    if (!details || Object.keys(details).length === 0) {
        ensaioDetailsContainer.style.display = 'none';
        return;
    }
    ensaioDetailsContainer.innerHTML = `
        <p><strong>Fornecedor:</strong> ${details.supplier || 'N/A'}</p>
        <p><strong>Produto:</strong> ${details.product || 'N/A'}</p>
        <p><strong>Rota:</strong> ${details.route_info || 'N/A'}</p>
    `;
    ensaioDetailsContainer.style.display = 'block';
}


function updateKPIs(kpis) {
    document.getElementById('kpi-distance').textContent = kpis.distance ?? '--';
    document.getElementById('kpi-impacts').textContent = kpis.impacts ?? '--';
    document.getElementById('kpi-max-vibration').textContent = kpis.max_vibration ?? '--';
}

function updateKpiComparisonTable(datasets) {
    let tableHTML = `
        <table>
            <thead>
                <tr>
                    <th>Indicador</th>
                    ${datasets.map(d => `<th>${d.name}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>Distância (km)</td>
                    ${datasets.map(d => `<td>${d.kpis.distance}</td>`).join('')}
                </tr>
                <tr>
                    <td>Impactos Severos</td>
                    ${datasets.map(d => `<td>${d.kpis.impacts}</td>`).join('')}
                </tr>
                <tr>
                    <td>Vibração Máxima (m/s²)</td>
                    ${datasets.map(d => `<td>${d.kpis.max_vibration}</td>`).join('')}
                </tr>
            </tbody>
        </table>`;
    kpiComparisonContainer.innerHTML = tableHTML;
}

function clearAllVisuals(uiOnly = false) {
    Object.values(charts).forEach(chart => { if (chart) { chart.data.labels = []; chart.data.datasets = []; chart.update('none'); }});
    if (map) { 
        routePolylines.forEach(p => map.removeLayer(p)); 
        routePolylines = []; 
        if (startMarker) map.removeLayer(startMarker); 
        if (endMarker) map.removeLayer(endMarker);
        if (pointMarker) map.removeLayer(pointMarker);
    }
    currentRouteId = null;
    updateKPIs({});
    updateEnsaioDetails({});
    kpiComparisonContainer.innerHTML = '';
    if (!uiOnly) {
        loadRoutes();
    }
}

// LÓGICA DO MODO DE COMPARAÇÃO

function enterCompareMode() {
    inCompareMode = true;
    document.body.classList.add('compare-mode');
    compareBtn.textContent = 'Gerar Comparação';
    cancelCompareBtn.style.display = 'block';
    clearAllVisuals(true);
    mainTitle.innerText = "Modo de Comparação: Selecione os Ensaios";
    showWelcomeScreen();
}

function exitCompareMode() {
    inCompareMode = false;
    document.body.classList.remove('compare-mode');
    document.querySelectorAll('.route-compare-checkbox').forEach(cb => cb.checked = false);
    compareBtn.textContent = 'Comparar Ensaios';
    cancelCompareBtn.style.display = 'none';
    showWelcomeScreen();
}

function getSelectedRouteIds() {
    return Array.from(document.querySelectorAll('.route-compare-checkbox:checked')).map(cb => cb.dataset.id);
}

// FUNÇÕES DE API (FETCH)

async function loadRoutes() {
    try {
        const response = await fetch('/routes');
        const routes = await response.json();
        const routesList = document.getElementById('routesList');
        routesList.innerHTML = routes.map(route => `
            <div class="route-card ${route.id === currentRouteId ? 'active' : ''}" data-id="${route.id}" data-name="${route.name}">
                <input type="checkbox" class="route-compare-checkbox" data-id="${route.id}">
                <div class="route-details">
                    <h4>${route.name}</h4>
                    <small>Produto: ${route.product || 'N/A'}</small><br>
                    <small>Data: ${new Date(route.created_at).toLocaleDateString()}</small>
                </div>
                <button class="btn-delete" data-id="${route.id}">×</button>
            </div>`).join('');
    } catch (error) { console.error("Erro ao carregar ensaios:", error); }
}


async function loadSingleRoute(routeId, routeName) {
    if (inCompareMode) exitCompareMode();
    showLoader();
    try {
        const response = await fetch(`/route/${routeId}?threshold=${currentImpactThreshold}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        coordenadasGlobal = data.datasets.coordenadas;
        const singleDataset = [{ name: routeName, temperatura: data.datasets.temperatura, vibracao: data.datasets.vibracao, umidade: data.datasets.umidade }];
        
        showAnalysisContent();
        updateChartsForComparison({ labels: data.labels, datasets: singleDataset });
        updateMap([data.datasets.coordenadas], singleDataset);
        updateKPIs(data.kpis);
        updateEnsaioDetails(data.details);
        kpiContainer.style.display = 'grid';
        kpiComparisonContainer.style.display = 'none';
        mainTitle.innerText = `Análise do Ensaio: ${routeName}`;
        currentRouteId = routeId;
        await loadRoutes();
    } catch (error) {
        alert(`Erro: ${error.message}`);
        clearAllVisuals();
    } finally {
        hideLoader();
    }
}

async function loadComparison() {
    const selectedIds = getSelectedRouteIds();
    if (selectedIds.length < 2) {
        alert("Selecione pelo menos dois ensaios para comparar.");
        return;
    }
    showLoader();
    try {
        const response = await fetch(`/compare?ids=${selectedIds.join(',')}&threshold=${currentImpactThreshold}`);
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        coordenadasGlobal = [];
        showAnalysisContent();
        updateChartsForComparison(data);
        updateMap(data.all_coords, data.datasets);
        updateKpiComparisonTable(data.datasets);
        updateEnsaioDetails({});
        kpiContainer.style.display = 'none';
        kpiComparisonContainer.style.display = 'block';
        mainTitle.innerText = "Comparação de Ensaios";
    } catch (error) {
        alert(`Erro ao comparar: ${error.message}`);
    } finally {
        hideLoader();
    }
}

async function deleteRoute(routeId) {
    if (!confirm('Tem certeza que deseja excluir este ensaio?')) return;
    showLoader();
    try {
        await fetch(`/route/${routeId}`, { method: 'DELETE' });
        if (routeId === currentRouteId) clearAllVisuals();
        await loadRoutes();
    } catch (error) {
        alert('Erro ao excluir o ensaio.');
    } finally {
        hideLoader();
    }
}

async function createRoute(formData) {
    const feedback = document.getElementById('modalFeedback');
    feedback.textContent = "";
    showLoader();
    try {
        const response = await fetch('/route', { method: 'POST', body: formData });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Erro desconhecido');
        document.getElementById('newRouteModal').style.display = 'none';
        document.getElementById('routeForm').reset();
        document.getElementById('file-chosen').textContent = "Nenhum arquivo selecionado";
        await loadRoutes();
    } catch (error) {
        feedback.textContent = `Erro: ${error.message}`;
    } finally {
        hideLoader();
    }
}

// EVENT LISTENERS (CONFIGURAÇÃO INICIAL)

document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    initMap();
    loadRoutes();
    setupEventListeners();
    showWelcomeScreen();
});

function setupEventListeners() {
    const routesList = document.getElementById('routesList');
    
    routesList.addEventListener('click', (e) => {
        const card = e.target.closest('.route-card');
        if (!card) return;

        if (e.target.classList.contains('btn-delete')) {
            e.preventDefault();
            deleteRoute(parseInt(e.target.dataset.id));
            return;
        }

        if (inCompareMode) {
            const checkbox = card.querySelector('.route-compare-checkbox');
            if (checkbox && e.target !== checkbox) {
                checkbox.checked = !checkbox.checked;
            }
        } else {
            loadSingleRoute(parseInt(card.dataset.id), card.dataset.name);
        }
    });

    compareBtn.addEventListener('click', () => {
        if (!inCompareMode) {
            enterCompareMode();
        } else {
            loadComparison();
        }
    });
    cancelCompareBtn.addEventListener('click', exitCompareMode);

    const sidebar = document.querySelector('.sidebar');
    const toggleBtn = sidebar.querySelector('.btn-toggle-sidebar');
    if (toggleBtn) toggleBtn.addEventListener('click', () => sidebar.classList.toggle('minimized'));
    
    const newRouteBtn = sidebar.querySelector('.btn-new-route');
    if (newRouteBtn) newRouteBtn.addEventListener('click', () => { document.getElementById('newRouteModal').style.display = 'flex'; });

    const routeForm = document.getElementById('routeForm');
    if (routeForm) {
        routeForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const formData = new FormData(this);
            createRoute(formData);
        });
    }

    const fileInput = document.getElementById('routeFile');
    if (fileInput) {
        const fileChosen = document.getElementById('file-chosen');
        fileInput.addEventListener('change', () => { fileChosen.textContent = fileInput.files.length ? fileInput.files[0].name : "Nenhum arquivo selecionado"; });
    }

    document.querySelectorAll('.modal .close').forEach(btn => {
        btn.addEventListener('click', function() { this.closest('.modal').style.display = 'none'; });
    });
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) e.target.style.display = 'none';
    });

    const editThresholdBtn = document.getElementById('edit-threshold-btn');
    const saveThresholdBtn = document.getElementById('save-threshold-btn');
    const kpiDisplay = document.querySelector('.kpi-display');
    const kpiEditForm = document.querySelector('.kpi-edit-form');
    const thresholdInput = document.getElementById('threshold-input');

    if (editThresholdBtn) {
        editThresholdBtn.addEventListener('click', () => {
            kpiDisplay.style.display = 'none';
            kpiEditForm.style.display = 'flex';
            thresholdInput.value = currentImpactThreshold;
            thresholdInput.focus();
        });
    }
    if (saveThresholdBtn) {
        saveThresholdBtn.addEventListener('click', () => {
            const newThreshold = parseFloat(thresholdInput.value);
            if (!isNaN(newThreshold) && newThreshold > 0) {
                currentImpactThreshold = newThreshold;
                const activeRouteCard = document.querySelector('.route-card.active');
                if (activeRouteCard) {
                    loadSingleRoute(parseInt(activeRouteCard.dataset.id), activeRouteCard.dataset.name);
                }
                kpiDisplay.style.display = 'block';
                kpiEditForm.style.display = 'none';
            } else {
                alert('Por favor, insira um valor numérico válido.');
            }
        });
    }
}

// FUNÇÕES AUXILIARES (MODAL DE COORDENADAS E EXPORTAÇÃO)

async function exportPDF() {
    if (!currentRouteId && !inCompareMode) {
        alert("Selecione um ensaio ou uma comparação para gerar o relatório.");
        return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const routeName = inCompareMode ? "Comparacao_de_Ensaios" : document.querySelector('.route-card.active')?.dataset.name || "Relatorio";
    
    doc.setFontSize(22);
    doc.text(`Relatório de Análise: ${routeName.replace(/_/g, ' ')}`, 40, 50);
    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text('Gerado em: ' + new Date().toLocaleString('pt-BR'), 40, 70);
    
    let y = 100;

    const kpiTableElement = inCompareMode ? document.querySelector('#kpi-comparison-container table') : null;
    if (kpiTableElement) {
        doc.setFontSize(16);
        doc.text("Resumo dos Indicadores", 40, y);
        y += 20;
        doc.autoTable({ html: kpiTableElement, startY: y });
        y = doc.autoTable.previous.finalY + 20;
    }


    const addChartToPDF = async (chartId, titulo) => {
        const canvas = document.getElementById(chartId);
        if (!canvas) return;
        const imgData = canvas.toDataURL('image/png', 1.0);
        if (y + 180 + 40 > doc.internal.pageSize.getHeight()) { doc.addPage(); y = 40; }
        doc.setFontSize(16);
        doc.setTextColor(40);
        doc.text(titulo, 40, y);
        doc.addImage(imgData, 'PNG', 40, y + 15, doc.internal.pageSize.getWidth() - 80, 180, undefined, 'FAST');
        y += 180 + 40;
    };

    await addChartToPDF('tempChart', 'Temperatura (°C)');
    await addChartToPDF('vibChart', 'Vibração (m/s²)');
    await addChartToPDF('umidChart', 'Umidade Relativa (%)');

    doc.save(`relatorio_${routeName.replace(/\s/g, '_')}.pdf`);
}