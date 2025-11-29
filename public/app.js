/* Frontend app.js for PowerDrill UI
   Features:
   - Drag & drop + file selection (PapaParse)
   - Calls local backend /analyze or falls back to client-side analysis
   - Renders histogram and chart with Chart.js
   - Column type guessing, outlier display, statistics
   - Save results as JSON or PDF (html2canvas + jsPDF)
*/

const uploadArea = document.getElementById('uploadArea');
const csvFile = document.getElementById('csvFile');
const analyzeBtn = document.getElementById('analyzeBtn');
const downloadJson = document.getElementById('downloadJson');
const downloadPdf = document.getElementById('downloadPdf');
const summaryDiv = document.getElementById('summary');
const typesDiv = document.getElementById('types');
const columnSelect = document.getElementById('columnSelect');
const showHist = document.getElementById('showHist');
const insightsDiv = document.getElementById('insights');
const statsDiv = document.getElementById('stats');
const outliersDiv = document.getElementById('outliers');
const histCtx = document.getElementById('histChart').getContext('2d');

let parsedData = null;
let lastResult = null;
let histChart = null;

// drag & drop handlers
uploadArea.addEventListener('click', ()=> csvFile.click());
uploadArea.addEventListener('dragover', (e)=>{ e.preventDefault(); uploadArea.classList.add('drag'); });
uploadArea.addEventListener('dragleave', ()=> uploadArea.classList.remove('drag'));
uploadArea.addEventListener('drop', (e)=>{ e.preventDefault(); uploadArea.classList.remove('drag'); const f = e.dataTransfer.files[0]; handleFile(f); });

csvFile.addEventListener('change', (e)=> handleFile(e.target.files[0]));

function handleFile(file){
  if (!file) return;
  Papa.parse(file, { header:true, dynamicTyping:true, skipEmptyLines:true, complete: function(res){ parsedData = res.data; analyzeBtn.disabled = false; populateColumnSelect(); }, error: function(err){ alert('CSV parse error: '+err.message); } });
}

function populateColumnSelect(){
  columnSelect.innerHTML = '';
  if (!parsedData || !parsedData.length) return;
  Object.keys(parsedData[0]).forEach(k=>{
    const opt = document.createElement('option');
    opt.value = k; opt.textContent = k;
    columnSelect.appendChild(opt);
  });
}

// client-side analysis fallback (in case backend not running)
function clientAnalyze(rows){
  // infer types
  const cols = Object.keys(rows[0]);
  const types = {};
  cols.forEach(c=>{
    const vals = rows.map(r=>r[c]).filter(v=>v!==null && v!==undefined && v!=='');
    const numCount = vals.filter(v=>typeof v==='number' && !isNaN(v)).length;
    const dateCount = vals.filter(v=>!isNaN(Date.parse(v))).length;
    if (numCount===vals.length) types[c]='numeric';
    else if (dateCount===vals.length) types[c]='date';
    else if (numCount>vals.length*0.8) types[c]='numeric';
    else types[c]='categorical';
  });
  // statistics & outliers
  const statistics = {};
  const insights = [];
  const outliers = {};
  cols.forEach(c=>{
    const raw = rows.map(r=>r[c]);
    const values = raw.filter(v=>v!==null && v!==undefined && v!=='');
    const numeric = values.map(v=>Number(v)).filter(v=>!isNaN(v));
    const missing = rows.length - values.length;
    statistics[c]={count:rows.length, missing, unique: Array.from(new Set(values)).length};
    if (numeric.length){
      const sum = numeric.reduce((a,b)=>a+b,0);
      const mean = sum/numeric.length;
      const sorted = numeric.slice().sort((a,b)=>a-b);
      const q1 = sorted[Math.floor(sorted.length/4)] || sorted[0];
      const q3 = sorted[Math.floor(sorted.length*3/4)] || sorted[sorted.length-1];
      const iqr = q3 - q1 || 0;
      const lower = q1 - 1.5*iqr;
      const upper = q3 + 1.5*iqr;
      const sd = Math.sqrt(numeric.map(v=>Math.pow(v-mean,2)).reduce((a,b)=>a+b,0)/numeric.length) || 0;
      const out_iqr = numeric.filter(v=>v<lower || v>upper);
      const out_z = sd? numeric.filter(v=>Math.abs((v-mean)/sd)>3): [];
      statistics[c].isNumeric=true; statistics[c].mean=mean; statistics[c].min=sorted[0]; statistics[c].max=sorted[sorted.length-1]; statistics[c].median=sorted[Math.floor(sorted.length/2)];
      statistics[c].q1=q1; statistics[c].q3=q3; statistics[c].iqr=iqr;
      statistics[c].outliers_iqr = out_iqr; statistics[c].outliers_z = out_z;
      if (missing>0) insights.push(`${missing} missing values in ${c}`);
      if (out_iqr.length) insights.push(`${c} has ${out_iqr.length} outliers (IQR)`);
      outliers[c] = { iqr: out_iqr, z: out_z };
    } else {
      statistics[c].isNumeric=false;
    }
  });
  return { types, statistics, insights, outliers, chartData: buildHistogramFromClient(rows) };
}

function buildHistogramFromClient(rows, col=null, buckets=12){
  col = col || Object.keys(rows[0]).find(c=> typeof rows[0][c]==='number');
  if (!col) return null;
  const numeric = rows.map(r=>Number(r[col])).filter(v=>!isNaN(v));
  const sorted=numeric.slice().sort((a,b)=>a-b);
  const min=sorted[0], max=sorted[sorted.length-1];
  const range = (max - min) || 1;
  const size = range/buckets;
  const labels=[]; const counts=new Array(buckets).fill(0);
  for (let i=0;i<buckets;i++){ const s=min+i*size; const e=(i===buckets-1)?max:(min+(i+1)*size); labels.push(`${s.toFixed(2)}-${e.toFixed(2)}`); }
  numeric.forEach(v=>{ let idx=Math.floor((v-min)/size); if (idx<0) idx=0; if (idx>=buckets) idx=buckets-1; counts[idx]++; });
  return { column: col, labels, datasets: [{ label: col, data: counts }] };
}

// call backend or fallback to clientAnalyze
async function analyzeRows(rows){
  try {
    const resp = await fetch('http://localhost:3000/analyze', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ rows }) });
    if (!resp.ok) throw new Error('Backend not available');
    const json = await resp.json();
    return json;
  } catch (e) {
    // fallback
    return clientAnalyze(rows);
  }
}

analyzeBtn.addEventListener('click', async ()=>{
  if (!parsedData) return alert('Upload CSV first');
  analyzeBtn.disabled = true;
  const result = await analyzeRows(parsedData);
  lastResult = result;
  renderResult(result);
  analyzeBtn.disabled = false;
});

function renderResult(result){
  summaryDiv.textContent = result.summary || '';
  // types may be in result.types or in result.types property from client
  const types = result.types || result.types;
  typesDiv.textContent = Object.entries(types || {}).map(([k,v])=>`${k}: ${v}`).join('; ');
  // populate column select
  populateColumnSelect();
  insightsDiv.textContent = (result.insights && result.insights.length)? result.insights.join('\n') : 'No insights';
  statsDiv.textContent = JSON.stringify(result.statistics || {}, null, 2);
  outliersDiv.textContent = JSON.stringify(result.outliers || computeOutliersObject(result.statistics || {}), null, 2);
  // draw chart if chartData available
  if (result.chartData && result.chartData.labels){
    drawHistChart(result.chartData);
  } else {
    const fallback = buildHistogramFromClient(parsedData);
    if (fallback) drawHistChart(fallback);
  }
}

function computeOutliersObject(statistics){
  const o={};
  for (const [k,v] of Object.entries(statistics||{})) o[k] = { outliers_iqr: v.outliers_iqr||[], outliers_z: v.outliers_z||[] };
  return o;
}

function drawHistChart(chartData){
  if (histChart) histChart.destroy();
  histChart = new Chart(histCtx, { type: 'bar', data: { labels: chartData.labels, datasets: chartData.datasets }, options: { responsive:true } });
}

// show selected column histogram
showHist.addEventListener('click', ()=>{
  const col = columnSelect.value;
  if (!col) return alert('Pick a column');
  // build histogram for that column client-side
  const hist = buildHistogramFromClient(parsedData, col, 12);
  if (hist) drawHistChart(hist);
});

// downloads
downloadJson.addEventListener('click', ()=>{
  if (!lastResult) return alert('No analysis to save');
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'analysis.json'; a.click(); URL.revokeObjectURL(url);
});

downloadPdf.addEventListener('click', async ()=>{
  if (!lastResult) return alert('No analysis to save');
  const el = document.querySelector('.container');
  // use html2canvas to render and jspdf to export
  const canvas = await html2canvas(el, { scale: 2 });
  const imgData = canvas.toDataURL('image/png');
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'px', format: [canvas.width, canvas.height] });
  pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
  pdf.save('analysis.pdf');
});

// initialize
function init(){ populateColumnSelect(); }
init();
app.get("/", (req, res) => {
  res.send("CSV Analyzer Backend is Running");
});
