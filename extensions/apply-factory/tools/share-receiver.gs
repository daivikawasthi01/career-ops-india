// Receives the daily anonymous report from the Apply extension, appends one row per report to the "Sheet1" tab of the Sheet this script is
// attached to, and builds a Dashboard tab from those rows.
// Set up once: create a Google Sheet, Extensions > Apps Script, paste this file, Deploy > New deployment > type Web app,
// Execute as: Me, Who has access: Anyone. Copy the web app URL into share.url in extensions/apply-factory/config.yaml and push.
// Dashboard: pick buildDashboard in the editor and press Run once (or use the Apply menu in the Sheet). It is formulas and charts, so it stays live.
// After editing this file, Deploy > Manage deployments > edit > Version: New version, so the web app runs the new code.
/** @OnlyCurrentDoc */
const COLUMNS = ["received", "install", "version", "os", "setup_done", "setup_steps_done",
  "week_forms", "week_fills", "week_drafts", "month_forms", "month_fills", "month_drafts",
  "total_forms", "total_fills", "total_drafts", "days_active_30"];

function doPost(e) {
  const r = JSON.parse(e.postData.contents);
  const sheet = SpreadsheetApp.getActive().getSheetByName("Sheet1");
  if (sheet.getLastRow() === 0) sheet.appendRow(COLUMNS);
  const n = (x) => Number(x) || 0;
  sheet.appendRow([new Date(), String(r.install || "").slice(0, 32), String(r.version || "").slice(0, 16), String(r.os || "").slice(0, 16),
    !!r.setup_done, n(r.setup_steps_done),
    n(r.week && r.week.forms), n(r.week && r.week.fills), n(r.week && r.week.drafts),
    n(r.month && r.month.forms), n(r.month && r.month.fills), n(r.month && r.month.drafts),
    n(r.total && r.total.forms), n(r.total && r.total.fills), n(r.total && r.total.drafts), n(r.days_active_30)]);
  return ContentService.createTextOutput("ok");
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu("Apply").addItem("Rebuild dashboard", "buildDashboard").addToUi();
}

// Each install reports its running totals once a day, so "Latest" keeps the newest row per install and every figure reads from it.
function buildDashboard() {
  const ss = SpreadsheetApp.getActive();
  const reports = ss.getSheetByName("Sheet1");
  if (reports.getLastRow() === 0) reports.appendRow(COLUMNS);
  const fresh = (name) => {
    const old = ss.getSheetByName(name);
    if (old) ss.deleteSheet(old);
    return ss.insertSheet(name);
  };

  const latest = fresh("Latest");
  latest.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
  latest.getRange("A2").setFormula("=IFERROR(SORTN(SORT(Sheet1!A2:P,1,FALSE),9^9,2,2,TRUE),\"\")");

  const calc = fresh("Calc");
  calc.getRange("A1").setFormula("=IFERROR(QUERY({ARRAYFORMULA(TEXT(INT(FILTER(Sheet1!A2:A,Sheet1!B2:B<>\"\")),\"yyyy-mm-dd\")),FILTER(Sheet1!B2:B,Sheet1!B2:B<>\"\")},\"select Col1, count(Col2) group by Col1 order by Col1 label Col1 'Day', count(Col2) 'Reports'\",0),\"\")");
  calc.getRange("D1").setFormula("=IFERROR(QUERY(Latest!A2:P,\"select C, count(B) where C is not null group by C label C 'Version', count(B) 'Installs'\",0),\"\")");
  calc.getRange("G1").setFormula("=IFERROR(QUERY(Latest!A2:P,\"select D, count(B) where D is not null group by D label D 'System', count(B) 'Installs'\",0),\"\")");
  calc.getRange("J1").setFormula("=IFERROR(QUERY(Latest!A2:P,\"select F, count(B) where B is not null group by F order by F label F 'Setup steps done', count(B) 'Installs'\",0),\"\")");

  const d = fresh("Dashboard");
  d.setHiddenGridlines(true);
  d.setColumnWidths(1, 8, 118);
  d.getRange("A1").setValue("Apply usage").setFontSize(20).setFontWeight("bold");
  d.getRange("A2").setValue("Live from the daily reports. Delete test rows in Sheet1 and the numbers follow.").setFontColor("#5f6368");

  const kpis = [
    ["Installs", "=COUNTA(Latest!B2:B)"],
    ["Setup finished", "=COUNTIF(Latest!E2:E,TRUE)"],
    ["Reported in 7 days", "=COUNTIFS(Latest!A2:A,\">=\"&(NOW()-7))"],
    ["Forms", "=SUM(Latest!M2:M)"],
    ["Answers filled", "=SUM(Latest!N2:N)"],
    ["Drafts", "=SUM(Latest!O2:O)"],
    ["Minutes saved", "=ROUND((SUM(Latest!N2:N)*10+SUM(Latest!O2:O)*90)/60)"]
  ];
  kpis.forEach((k, i) => {
    d.getRange(4, i + 1).setValue(k[0]).setFontColor("#5f6368");
    d.getRange(5, i + 1).setFormula(k[1]).setFontSize(22).setFontWeight("bold").setHorizontalAlignment("left");
  });
  d.getRange("A6").setValue("Setup finished is the share who got through all five steps. Minutes saved is an estimate: 10 seconds per answer, 90 per draft.").setFontColor("#80868b").setFontSize(9);

  const chart = (type, range, title, col, row, w, h) => d.insertChart(d.newChart().setChartType(type).addRange(range)
    .setNumHeaders(1).setPosition(row, col, 0, 0).setOption("title", title).setOption("legend", { position: "none" }).setOption("width", w).setOption("height", h)
    .setOption("colors", ["#1a73e8"]).build());
  chart(Charts.ChartType.COLUMN, calc.getRange("A:B"), "Reports per day", 1, 8, 470, 240);
  chart(Charts.ChartType.COLUMN, calc.getRange("J:K"), "Setup steps done, per install", 5, 8, 470, 240);
  chart(Charts.ChartType.BAR, calc.getRange("D:E"), "Installs by version", 1, 21, 470, 240);
  chart(Charts.ChartType.PIE, calc.getRange("G:H"), "Installs by system", 5, 21, 470, 240);

  d.getRange("A35").setValue("Installs, newest report first").setFontWeight("bold");
  d.getRange("A36").setFormula("=IFERROR(QUERY(Latest!A2:P,\"select B, C, D, F, K, L, P, A order by A desc label B 'Install', C 'Version', D 'System', F 'Setup steps', K 'Fills, 30 days', L 'Drafts, 30 days', P 'Days used, 30', A 'Last report'\",0),\"No reports yet\")");
  d.getRange("H37:H").setNumberFormat("d mmm yyyy hh:mm");

  ss.setActiveSheet(reports);
  ss.moveActiveSheet(2);
  ss.setActiveSheet(d);
  ss.moveActiveSheet(1);
  latest.hideSheet();
  calc.hideSheet();
}
