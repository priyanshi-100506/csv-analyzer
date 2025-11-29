const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

function isNumber(n) { return typeof n === "number" && !isNaN(n); }

function inferColumnTypes(rows) {
  const cols = Object.keys(rows[0]);
  const types = {};
  cols.forEach(col => {
    const vals = rows.map(r => r[col]).filter(v => v !== null && v !== undefined && v !== "");
    const numCount = vals.filter(v => isNumber(Number(v))).length;
    const dateCount = vals.filter(v => !isNaN(Date.parse(v))).length;
    if (numCount === vals.length) types[col] = "numeric";
    else if (dateCount === vals.length) types[col] = "date";
    else if (numCount > vals.length * 0.8) types[col] = "numeric";
    else types[col] = "categorical";
  });
  return types;
}

function computeStatistics(rows) {
  if (!rows || !rows.length) return {};
  const cols = Object.keys(rows[0]);
  const stats = {};
  cols.forEach(col => {
    const raw = rows.map(r => r[col]);
    const values = raw.filter(v => v !== null && v !== undefined && v !== "" );
    const numeric = values.map(v => Number(v)).filter(v => isNumber(v));
    const missing = rows.length - values.length;
    stats[col] = { count: rows.length, missing, unique: Array.from(new Set(values)).length };
    if (numeric.length) {
      const sum = numeric.reduce((a,b)=>a+b,0);
      const mean = sum / numeric.length;
      const sorted = numeric.slice().sort((a,b)=>a-b);
      const min = sorted[0], max = sorted[sorted.length-1];
      const median = sorted[Math.floor(sorted.length/2)];
      stats[col].isNumeric = true;
      stats[col].mean = mean;
      stats[col].min = min;
      stats[col].max = max;
      stats[col].median = median;
      // quartiles & iqr
      const q1 = sorted[Math.floor((sorted.length/4))];
      const q3 = sorted[Math.floor((sorted.length*3/4))];
      const iqr = (q3 - q1) || 0;
      stats[col].q1 = q1;
      stats[col].q3 = q3;
      stats[col].iqr = iqr;
      // detect outliers via IQR method
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      stats[col].outliers_iqr = numeric.filter(v => v < lower || v > upper);
      // z-score outliers
      const sd = Math.sqrt(numeric.map(v=>Math.pow(v-mean,2)).reduce((a,b)=>a+b,0)/numeric.length) || 0;
      stats[col].outliers_z = sd ? numeric.filter(v => Math.abs((v-mean)/sd) > 3) : [];
    } else {
      stats[col].isNumeric = false;
    }
  });
  return stats;
}

function buildHistogram(numericValues, buckets=10) {
  if (!numericValues || !numericValues.length) return null;
  const sorted = numericValues.slice().sort((a,b)=>a-b);
  const min = sorted[0], max = sorted[sorted.length-1];
  const range = max - min || 1;
  const bucketSize = range / buckets;
  const labels = [];
  const counts = new Array(buckets).fill(0);
  for (let i=0;i<buckets;i++) {
    const start = min + i*bucketSize;
    const end = (i===buckets-1) ? max : (min + (i+1)*bucketSize);
    labels.push(`${start.toFixed(2)}-${end.toFixed(2)}`);
  }
  numericValues.forEach(v => {
    let idx = Math.floor((v - min) / bucketSize);
    if (idx<0) idx=0;
    if (idx>=buckets) idx=buckets-1;
    counts[idx]++;
  });
  return { labels, counts };
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

app.post("/analyze", (req, res) => {
  try {
    const { rows } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: "Invalid rows" });
    }
    const types = inferColumnTypes(rows);
    const statistics = computeStatistics(rows);
    // build histogram for first numeric column if exists
    const numericCols = Object.keys(statistics).filter(c=>statistics[c].isNumeric);
    let chartData = null;
    if (numericCols.length) {
      const col = numericCols[0];
      const numericValues = rows.map(r => Number(r[col])).filter(v => isNumber(v));
      const hist = buildHistogram(numericValues, 12);
      chartData = { column: col, labels: hist.labels, datasets: [{ label: col, data: hist.counts }] };
    }
    const summary = `Dataset: ${rows.length} rows, ${Object.keys(rows[0]).length} columns`;
    const insights = [];
    for (const [col, s] of Object.entries(statistics)) {
      if (s.missing > 0) insights.push(`${s.missing} missing in ${col}`);
      if (s.isNumeric && (s.outliers_iqr.length || s.outliers_z.length)) insights.push(`${col} has ${s.outliers_iqr.length} IQR outliers`);
    }
    const recommendations = "Review missing values, validate data types, inspect outliers and visualize distributions.";
    return res.json({ summary, types, statistics, insights, recommendations, chartData });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Analysis failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`CSV Analyzer backend running on http://localhost:${PORT}`));
