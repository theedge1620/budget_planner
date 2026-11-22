(function(){
  const FREQ = [["weekly","Weekly",52],["biweekly","Every 2 weeks",26],["semimonthly","Twice a month",24],["monthly","Monthly",12],["quarterly","Quarterly",4],["annual","Annually",1]];
  const PER = Object.fromEntries(FREQ.map(f=>[f[0],f[2]]));
  const CATS = ["Housing","Utilities","Insurance","Food","Travel","Transportation","Other"];
  const RTYPES = ["Checking","Savings","Investment","Retirement","Other"];
  // Reserve accounts of these types earn an annual return in scenarios (r.ret, percent; unset = DEFAULT_RET).
  const INV_TYPES = ["Investment"];
  const DEFAULT_RET = 6;
  const isInv = r => INV_TYPES.includes(r.type);
  const toRet = v => { if (v === "" || v == null) return null; const n = Number(String(v).replace(/[%\s]/g, "")); return isFinite(n) ? Math.min(100, Math.max(-100, n)) : null; };
  const retOf = r => typeof r.ret === "number" && isFinite(r.ret) ? r.ret : DEFAULT_RET;
  const EMP_LEVELS = [0,25,50,75,100];
  const SCEN_CATS = [...CATS, "Education", "Discretionary"];
  const empOf = r => EMP_LEVELS.includes(r.emp) ? r.emp : 100;
  const CAT_COLOR = {Housing:"--c1",Utilities:"--c2",Insurance:"--c3",Food:"--c6",Education:"--c4",Travel:"--c5",Transportation:"--c7",Other:"--c7",Discretionary:"--accent"};
  const KEY = "household-budget-v1";
  let uid = 1; const id = () => "r" + (uid++) + Date.now().toString(36);

  const defaults = () => ({
    income: [{id:id(), name:"Example paycheck — replace with yours", amount:4500, freq:"biweekly", example:true}],
    fixed: [
      {id:id(), name:"Property taxes", amount:7000, freq:"annual", cat:"Housing"},
      {id:id(), name:"Auto insurance", amount:4000, freq:"annual", cat:"Insurance"},
      {id:id(), name:"Other insurance", amount:3000, freq:"annual", cat:"Insurance"},
      {id:id(), name:"Groceries & food", amount:450, freq:"weekly", cat:"Food"},
      {id:id(), name:"Vacations", amount:10000, freq:"annual", cat:"Travel"},
      {id:id(), name:"Cell phones", amount:60, freq:"monthly", cat:"Utilities"},
      {id:id(), name:"Internet", amount:50, freq:"monthly", cat:"Utilities"},
      {id:id(), name:"Electricity", amount:450, freq:"monthly", cat:"Utilities"},
      {id:id(), name:"Natural gas", amount:150, freq:"monthly", cat:"Utilities"}
    ],
    edu: [{id:id(), name:"Private school tuition", amount:20000, freq:"annual"}],
    disc: [],
    reserves: [],
    ptBen: [],
    ptCost: [],
    adj: {}
  });

  // ---- data shape & validation (shared by load, import) ----
  const FREQ_BY_LABEL = {};
  FREQ.forEach(f => { FREQ_BY_LABEL[f[0]] = f[0]; FREQ_BY_LABEL[f[1].toLowerCase()] = f[0]; });
  Object.assign(FREQ_BY_LABEL, {"bi-weekly":"biweekly","every two weeks":"biweekly","semi-monthly":"semimonthly","yearly":"annual","annual":"annual","per year":"annual","per month":"monthly"});
  const toFreq = v => FREQ_BY_LABEL[String(v ?? "").trim().toLowerCase()] || "monthly";
  const toAmt = v => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return isFinite(n) && n >= 0 ? n : 0; };
  const toActive = v => { if (v === false || v === 0) return false; const s = String(v ?? "").trim().toLowerCase(); return !["false","no","n","0","off","inactive"].includes(s); };
  const isOn = r => r.active !== false;
  const toFlag = v => v === true || v === 1 || ["yes","y","true","1","x"].includes(String(v ?? "").trim().toLowerCase());
  const toCat = v => { const s = String(v ?? "").trim().toLowerCase(); return CATS.find(c => c.toLowerCase() === s) || "Other"; };
  function cleanRows(rows, withCat, isCost){
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => r && typeof r === "object").map(r => {
      const o = {id:id(), name:String(r.name ?? "").slice(0,120), amount:toAmt(r.amount), freq:toFreq(r.freq), active:toActive(r.active)};
      if (withCat) o.cat = toCat(r.cat);
      if (isCost && toFlag(r.skipIfPartTime ?? r.pt)) o.pt = true;
      if (isCost && (r.overviewSkip50 !== undefined || r.overviewSkip0 !== undefined)) o.ovSk = {"50":toFlag(r.overviewSkip50), "0":toFlag(r.overviewSkip0)};
      const emp = Number(r.scenarioPct ?? r.emp);
      if (EMP_LEVELS.includes(emp) && emp !== 100) o.emp = emp;
      return o;
    }).filter(r => r.name || r.amount);
  }
  // Older budgets kept education as a category inside fixed costs; those rows move to the Education list.
  const toRType = v => { const s = String(v ?? "").trim().toLowerCase(); return RTYPES.find(t => t.toLowerCase() === s) || "Other"; };
  function cleanReserves(rows){
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => r && typeof r === "object").map(r => {
      const o = {id:id(), name:String(r.name ?? "").slice(0,120), type:toRType(r.type), amount:toAmt(r.amount ?? r.balance), active:toActive(r.active)};
      const ret = toRet(r.returnPct ?? r.ret);
      if (ret !== null && ret !== DEFAULT_RET) o.ret = ret;
      return o;
    }).filter(r => r.name || r.amount);
  }
  // Non-monetary costs and benefits of less-than-full-time work: {id, name, weight:"1"|"2"|"3", added:"YYYY-MM-DD"}
  const WEIGHTS = {"1":"Low", "2":"Medium", "3":"High"};
  const toWeight = v => { const s = String(v ?? "").trim().toLowerCase(); return WEIGHTS[s] ? s : ({low:"1", medium:"2", med:"2", high:"3"})[s] || "2"; };
  const toDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "").trim()) ? String(v).trim() : "";
  function cleanNotes(rows){
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => r && typeof r === "object")
      .map(r => ({id:id(), name:String(r.text ?? r.name ?? "").slice(0,200), weight:toWeight(r.importance ?? r.weight), added:toDay(r.added)}))
      .filter(r => r.name.trim());
  }
  // Scenario category adjustments: {Housing:{mode:"pct"|"amt", v:Number}, ...}
  function cleanAdj(a){
    const out = {};
    if (!a || typeof a !== "object") return out;
    for (const c of SCEN_CATS) {
      const x = a[c]; if (!x || typeof x !== "object") continue;
      const mode = x.mode === "amt" ? "amt" : "pct", v = toAmt(x.v);
      if (mode === "pct" && v === 100) continue;
      out[c] = {mode, v};
    }
    return out;
  }
  const isEdu = r => r && String(r.cat ?? "").trim().toLowerCase() === "education";
  function sanitize(d){
    if (!d || typeof d !== "object") throw new Error("That file doesn't contain a budget.");
    const fixedRaw = Array.isArray(d.fixed) ? d.fixed : [];
    const eduRaw = (Array.isArray(d.edu ?? d.education) ? (d.edu ?? d.education) : []).concat(fixedRaw.filter(isEdu));
    const s = {income:cleanRows(d.income), fixed:cleanRows(fixedRaw.filter(r => !isEdu(r)), true, true), edu:cleanRows(eduRaw, false, true), disc:cleanRows(d.disc ?? d.discretionary, false, true),
      // null = the file predates reserve funds; the importer keeps the reserves already entered here.
      reserves: Array.isArray(d.reserves) ? cleanReserves(d.reserves) : null,
      adj: cleanAdj(d.scenarioAdjust)};
    if (d.includeInvestmentReturns === true) s.invInc = true;
    // Overview settings; absent = the importer keeps the ones already set here.
    if (d.overview && typeof d.overview === "object") {
      s.ov = {};
      if (Array.isArray(d.overview.items)) s.ov.items = d.overview.items.filter(k => OV_ITEMS.some(x => x[0] === k));
      const pi = Number(d.overview.person);
      if (Number.isInteger(pi) && s.income[pi]) s.ov.whoIds = [s.income[pi].id];
      if (Array.isArray(d.overview.persons)) {
        const ids = d.overview.persons.map(Number).filter(i => Number.isInteger(i) && s.income[i]).map(i => s.income[i].id);
        if (ids.length) s.ov.whoIds = [...new Set(ids)];
      }
    }
    // Rebuild the overview's line-item picks from the per-row flags.
    const costRows = [...s.fixed, ...s.edu, ...s.disc];
    if (costRows.some(r => r.ovSk)) {
      s.ov = s.ov || {};
      s.ov.skip = {"50":costRows.filter(r => r.ovSk && r.ovSk["50"]).map(r => r.id), "0":costRows.filter(r => r.ovSk && r.ovSk["0"]).map(r => r.id)};
    }
    costRows.forEach(r => delete r.ovSk);
    // null = the file has no non-monetary notes; the importer keeps the ones already logged here.
    const nm = d.nonMonetary && typeof d.nonMonetary === "object" ? d.nonMonetary : null;
    s.ptBen = nm ? cleanNotes(nm.benefits) : null;
    s.ptCost = nm ? cleanNotes(nm.costs) : null;
    if (!s.income.length && !s.fixed.length && !s.edu.length && !s.disc.length && !(s.reserves && s.reserves.length)) throw new Error("No income or cost rows were found in that file.");
    return s;
  }
  // Overview line-item picks travel with each cost row (only once the person has made their own).
  const ovSkipFlags = r => ovCustom() ? {overviewSkip50:ovSkipIds("50").has(r.id), overviewSkip0:ovSkipIds("0").has(r.id)} : {};
  const portable = () => ({
    format:"household-budget", version:6, exportedAt:new Date().toISOString(),
    // person: index into income, since row ids don't survive an export.
    // persons: indexes into income, since row ids don't survive a file. person: the first, for older copies of this app.
    overview: {items: ovItems(), persons: ovPeople().map(r => state.income.indexOf(r)), person: Math.max(0, state.income.indexOf(ovPeople()[0]))},
    income: state.income.map(r => ({name:r.name, amount:r.amount, freq:r.freq, active:isOn(r), scenarioPct:empOf(r)})),
    fixed: state.fixed.map(r => ({name:r.name, amount:r.amount, freq:r.freq, cat:r.cat, active:isOn(r), skipIfPartTime:!!r.pt, ...ovSkipFlags(r)})),
    edu: state.edu.map(r => ({name:r.name, amount:r.amount, freq:r.freq, active:isOn(r), skipIfPartTime:!!r.pt, ...ovSkipFlags(r)})),
    disc: state.disc.map(r => ({name:r.name, amount:r.amount, freq:r.freq, active:isOn(r), skipIfPartTime:!!r.pt, ...ovSkipFlags(r)})),
    reserves: state.reserves.map(r => ({name:r.name, type:r.type, amount:r.amount, active:isOn(r), returnPct:retOf(r)})),
    scenarioAdjust: state.adj,
    includeInvestmentReturns: !!state.invInc,
    nonMonetary: {
      benefits: state.ptBen.map(r => ({text:r.name, importance:WEIGHTS[r.weight] || "Medium", added:r.added || ""})),
      costs: state.ptCost.map(r => ({text:r.name, importance:WEIGHTS[r.weight] || "Medium", added:r.added || ""}))
    }
  });

  // ---- local draft (this browser) ----
  let state, localAt = 0;
  // Fill in lists that older saved budgets don't have.
  function upgrade(s){
    if (!Array.isArray(s.edu)) {
      s.edu = s.fixed.filter(isEdu).map(({id,name,amount,freq,active,pt}) => ({id,name,amount,freq,active,pt}));
      s.fixed = s.fixed.filter(r => !isEdu(r));
    }
    ["disc","income","reserves","ptBen","ptCost"].forEach(k => { if (!Array.isArray(s[k])) s[k] = []; });
    if (!s.adj || typeof s.adj !== "object") s.adj = {};
    return s;
  }
  try { const raw = JSON.parse(localStorage.getItem(KEY)); if (raw && Array.isArray(raw.fixed)) { state = raw; localAt = raw.updatedAt || 0; } } catch(e) {}
  state = upgrade(state || defaults());
  const save = () => {
    state.updatedAt = Date.now();
    let ok = true;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch(e){ ok = false; }
    const ss = document.getElementById("saveState");
    if (ss) ss.textContent = ok ? "Saved in this browser " + new Date().toLocaleTimeString([], {hour:"numeric", minute:"2-digit"}) : "Couldn't save in this browser — export a file to keep your edits";
  };

  const fmt = n => (n<0?"−$":"$") + Math.abs(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const fmt0 = n => (n<0?"−$":"$") + Math.abs(Math.round(n)).toLocaleString("en-US");
  const monthly = r => (Number(r.amount)||0) * (PER[r.freq]||12) / 12;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const freqSel = (r) => `<select data-k="freq" aria-label="Frequency">${FREQ.map(f=>`<option value="${f[0]}"${f[0]===r.freq?" selected":""}>${f[1]}</option>`).join("")}</select>`;
  const catSel = (r) => `<select data-k="cat" aria-label="Category">${CATS.map(c=>`<option${c===r.cat?" selected":""}>${c}</option>`).join("")}</select>`;
  const amtIn = (r) => `<div class="money-in"><input class="amt" data-k="amount" type="number" inputmode="decimal" min="0" step="any" value="${r.amount}" aria-label="Amount"></div>`;
  const nameIn = (r, ph) => `<input data-k="name" value="${esc(r.name)}" placeholder="${ph}" aria-label="Name">`;

  const grip = `<td class="drag"><button class="grip" type="button" data-grip aria-label="Reorder row: drag, or press the up and down arrow keys" title="Drag to reorder"><svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg></button></td>`;
  function rowHTML(list, r){
    const cat = list === "fixed" ? `<td>${catSel(r)}</td>` : "";
    const pt = list === "income" ? "" : `<td class="on"><input class="tog" type="checkbox" data-k="pt"${r.pt?" checked":""} aria-label="Skip this cost when someone works part-time" title="Leave out whenever someone works part-time in a scenario"></td>`;
    return `<tr data-list="${list}" data-id="${r.id}"${isOn(r)?"":' class="off"'}>${grip}
      <td class="on"><input class="tog" type="checkbox" data-k="active"${isOn(r)?" checked":""} aria-label="Active — include in totals" title="Include in totals"></td>${pt}
      <td>${nameIn(r, list==="income"?"Source":"Item")}</td><td>${amtIn(r)}</td><td>${freqSel(r)}</td>${cat}
      <td class="r num" data-m>${fmt(monthly(r))}</td><td class="r num" data-y>${fmt(monthly(r)*12)}</td>
      <td class="r"><button class="x" type="button" data-del aria-label="Remove row">×</button></td></tr>`;
  }
  const typeSel = (r) => `<select data-k="type" aria-label="Account type">${RTYPES.map(t=>`<option${t===r.type?" selected":""}>${t}</option>`).join("")}</select>`;
  function resRowHTML(r){
    return `<tr data-list="reserves" data-id="${r.id}"${isOn(r)?"":' class="off"'}>${grip}
      <td class="on"><input class="tog" type="checkbox" data-k="active"${isOn(r)?" checked":""} aria-label="Active — include in reserves total" title="Include in reserves total"></td>
      <td>${nameIn(r, "Account")}</td><td>${typeSel(r)}</td><td>${amtIn(r)}</td>
      <td class="r"><button class="x" type="button" data-del aria-label="Remove account">×</button></td></tr>`;
  }
  const fmtDay = d => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"}) : "—";
  function noteRowHTML(list, r){
    const ph = list === "ptBen" ? "What you'd gain" : "What you'd give up";
    return `<tr data-list="${list}" data-id="${r.id}">${grip}
      <td><input data-k="name" value="${esc(r.name)}" placeholder="${ph}" aria-label="Description" maxlength="200"></td>
      <td><select data-k="weight" aria-label="Importance">${Object.entries(WEIGHTS).map(([v,l]) => `<option value="${v}"${v === r.weight ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="note nowrap">${fmtDay(r.added)}</td>
      <td class="r"><button class="x" type="button" data-del aria-label="Remove entry">×</button></td></tr>`;
  }
  const BODY = {income:"incBody", fixed:"fixBody", edu:"eduBody", disc:"discBody", reserves:"resBody", ptBen:"ptBenBody", ptCost:"ptCostBody"};
  const rowFor = (k, r) => k === "reserves" ? resRowHTML(r) : k === "ptBen" || k === "ptCost" ? noteRowHTML(k, r) : rowHTML(k, r);
  function renderTables(){
    for (const k in BODY) document.getElementById(BODY[k]).innerHTML = state[k].map(r => rowFor(k, r)).join("");
    renderTotals();
  }

  // Budget totals from the active rows; shared by the screen and the printed report.
  function budgetCalc(){
    const sum = l => state[l].reduce((a,r)=>a+(isOn(r)?monthly(r):0),0);
    const inc = sum("income"), fix = sum("fixed"), edu = sum("edu"), disc = sum("disc"), exp = fix + edu + disc;
    const by = {};
    state.fixed.filter(isOn).forEach(r => by[r.cat||"Other"] = (by[r.cat||"Other"]||0) + monthly(r));
    by.Education = edu;
    by.Discretionary = disc;
    const cats = Object.entries(by).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
    const res = state.reserves.filter(isOn), resT = res.reduce((a,r)=>a+(Number(r.amount)||0),0);
    return {inc, fix, edu, disc, exp, net:inc-exp, cats, res, resT};
  }

  function renderTotals(){
    const {inc, fix, edu, disc, exp, net, cats:rows, res, resT} = budgetCalc();
    const set = (i,v) => document.getElementById(i).textContent = v;
    [["income","incOff"],["fixed","fixOff"],["edu","eduOff"],["disc","discOff"],["reserves","resOff"]].forEach(([l,el]) => {
      const off = state[l].filter(r => !isOn(r)).length;
      const pt = state[l].filter(r => isOn(r) && r.pt);
      const ptNote = pt.length ? `· ${pt.length} skipped if part-time (${fmt0(pt.reduce((a,r)=>a+monthly(r),0))}/mo)` : "";
      set(el, [off ? `· ${off} inactive` : "", ptNote].filter(Boolean).join(" "));
    });
    set("incM", fmt(inc)); set("incY", fmt(inc*12));
    set("fixM", fmt(fix)); set("fixY", fmt(fix*12));
    set("eduM", fmt(edu)); set("eduY", fmt(edu*12));
    set("discM", fmt(disc)); set("discY", fmt(disc*12));
    set("sInc", fmt0(inc)); set("sIncY", fmt0(inc*12) + " / yr");
    set("sExp", fmt0(exp)); set("sExpY", fmt0(exp*12) + " / yr");
    const sn = document.getElementById("sNet");
    sn.textContent = fmt0(net); sn.className = "big " + (net >= 0 ? "pos" : "neg");
    document.querySelector("#sNet").previousElementSibling.textContent = net >= 0 ? "Monthly surplus" : "Monthly shortfall";
    set("sNetY", fmt0(net*12) + " / yr");
    if (inc > 0) { const p = exp/inc*100; set("sPct", p.toFixed(0) + "%"); set("sPctNote", p > 100 ? "Costs exceed income" : `${(100-p).toFixed(0)}% left to save or invest`); }
    else { set("sPct", "—"); set("sPctNote", "Add income to see this"); }

    // rollup
    document.getElementById("rollBody").innerHTML = rows.map(([c,v]) =>
      `<tr><td><span class="sw" style="background:var(${CAT_COLOR[c]||"--c7"})"></span>${c}</td><td class="r num">${fmt(v)}</td><td class="r num">${fmt(v*12)}</td><td class="r num">${exp?(v/exp*100).toFixed(1):"0.0"}%</td></tr>`).join("");
    set("rollM", fmt(exp)); set("rollY", fmt(exp*12));
    const pct = v => exp ? v/exp*100 : 0;
    // Label inside the segment only when it's wide enough to read; the legend below always names every category.
    document.getElementById("bar").innerHTML = rows.map(([c,v]) => {
      const p = pct(v);
      return `<span title="${c} · ${p.toFixed(1)}%" style="width:${p}%;background:var(${CAT_COLOR[c]||"--c7"})">${p >= 9 ? `<b>${c}</b>` : ""}</span>`;
    }).join("");
    document.getElementById("legend").innerHTML = rows.map(([c,v]) =>
      `<span><span class="sw" style="background:var(${CAT_COLOR[c]||"--c7"})"></span>${c}<span class="num">${pct(v).toFixed(0)}%</span></span>`).join("");

    const has = state.disc.length > 0;
    document.getElementById("discEmpty").hidden = has;
    document.getElementById("discWrap").hidden = !has;
    const hasEdu = state.edu.length > 0;
    document.getElementById("eduEmpty").hidden = hasEdu;
    document.getElementById("eduWrap").hidden = !hasEdu;

    // reserves: balances, not flows — they don't touch the monthly totals above
    set("resT", fmt(resT)); set("rTot", fmt0(resT));
    const byType = RTYPES.map(t => [t, res.filter(r => r.type === t).reduce((a,r)=>a+(Number(r.amount)||0),0)]).filter(([,v]) => v > 0);
    set("rTotNote", byType.length ? byType.map(([t,v]) => t + " " + fmt0(v)).join(" · ") : "Add accounts to see this");
    if (resT > 0 && exp > 0) {
      const mo = resT / exp;
      set("rRun", mo >= 120 ? "10+ years" : mo.toFixed(1) + " months");
      set("rRunNote", net < 0 ? `At the current shortfall, reserves last ${(resT / -net).toFixed(1)} months` : "If income stopped, at current monthly costs");
    } else { set("rRun", "—"); set("rRunNote", resT > 0 ? "Add costs to see this" : "Add accounts to see this"); }
    // Lean scenario: same reserves, but every active discretionary item is cut to zero.
    const lean = exp - disc, leanNet = inc - lean;
    const months = m => m >= 120 ? "10+ years" : m.toFixed(1) + " months";
    if (resT > 0 && lean > 0) {
      set("rLean", months(resT / lean));
      const cut = disc > 0 ? `Costs drop ${fmt0(disc)}/mo to ${fmt0(lean)}/mo` : "No active discretionary spending to cut";
      set("rLeanNote", leanNet < 0 ? `${cut}; at that shortfall, reserves last ${months(resT / -leanNet)}` : `${cut}, if income stopped`);
    } else { set("rLean", "—"); set("rLeanNote", resT > 0 ? "Add fixed or education costs to see this" : "Add accounts to see this"); }
    // Bare-bones scenario: discretionary and education both cut to zero; only fixed costs remain.
    const coreNet = inc - fix;
    if (resT > 0 && fix > 0) {
      set("rCore", months(resT / fix));
      const cut = (disc + edu) > 0 ? `No discretionary or education: costs drop ${fmt0(disc + edu)}/mo to ${fmt0(fix)}/mo` : "No active discretionary or education costs to cut";
      set("rCoreNote", coreNet < 0 ? `${cut}; at that shortfall, reserves last ${months(resT / -coreNet)}` : `${cut}, if income stopped`);
    } else { set("rCore", "—"); set("rCoreNote", resT > 0 ? "Add fixed costs to see this" : "Add accounts to see this"); }
    const hasRes = state.reserves.length > 0;
    document.getElementById("resEmpty").hidden = hasRes;
    document.getElementById("resWrap").hidden = !hasRes;

    // Budget edits change the scenario's starting point (rows can appear or vanish), so rebuild it.
    buildScenario();
    renderNotesSummary();
  }

  // Non-monetary tally: each entry counts its importance (Low 1, Medium 2, High 3) toward its side.
  function notesBalance(){
    const wsum = l => l.reduce((a,r)=>a+(Number(r.weight)||2),0);
    const ben = state.ptBen.filter(r => r.name.trim()), cost = state.ptCost.filter(r => r.name.trim());
    const b = wsum(ben), c = wsum(cost), gap = b - c, close = Math.abs(gap) <= Math.max(1, (b + c) * 0.1);
    return {ben, cost, b, c, lean: close ? "Roughly balanced" : gap > 0 ? "Leans toward the benefits" : "Leans toward the costs", tone: close ? "" : gap > 0 ? "pos" : "neg"};
  }
  function renderNotesSummary(){
    const {ben, cost, b, c, lean, tone} = notesBalance();
    document.getElementById("ptBenEmpty").hidden = state.ptBen.length > 0;
    document.getElementById("ptBenWrap").hidden = !state.ptBen.length;
    document.getElementById("ptCostEmpty").hidden = state.ptCost.length > 0;
    document.getElementById("ptCostWrap").hidden = !state.ptCost.length;
    noteChipDraws.forEach(f => f());
    const box = document.getElementById("ptBalance"), lead = document.getElementById("ptLean");
    box.hidden = !(b + c);
    if (!(b + c)) return;
    document.getElementById("ptBarB").style.width = (b / (b + c) * 100) + "%";
    document.getElementById("ptBarC").style.width = (c / (b + c) * 100) + "%";
    const items = n => n === 1 ? "1 entry" : n + " entries";
    document.getElementById("ptBenSum").textContent = `Benefits: ${items(ben.length)}, weight ${b}`;
    document.getElementById("ptCostSum").textContent = `Costs: ${items(cost.length)}, weight ${c}`;
    lead.textContent = lean;
    lead.className = "lean " + tone;
  }

  document.addEventListener("input", e => {
    const tr = e.target.closest("tr[data-id]"); if (!tr) return;
    const r = state[tr.dataset.list].find(x => x.id === tr.dataset.id); if (!r) return;
    const k = e.target.dataset.k;
    if (k === "active") { r.active = e.target.checked; tr.classList.toggle("off", !r.active); renderTotals(); save(); return; }
    if (k === "pt") { if (e.target.checked) r.pt = true; else delete r.pt; renderTotals(); save(); return; }
    r[k] = k === "amount" ? (e.target.value === "" ? 0 : Number(e.target.value)) : e.target.value;
    if (k === "name") delete r.example;
    const mCell = tr.querySelector("[data-m]");
    if (mCell) { mCell.textContent = fmt(monthly(r)); tr.querySelector("[data-y]").textContent = fmt(monthly(r)*12); }
    renderTotals(); save();
  });
  document.addEventListener("change", e => { if (e.target.tagName === "SELECT") e.target.dispatchEvent(new Event("input",{bubbles:true})); });
  document.addEventListener("click", e => {
    if (e.target.matches("[data-del]")) {
      const tr = e.target.closest("tr"); const l = tr.dataset.list;
      state[l] = state[l].filter(x => x.id !== tr.dataset.id); tr.remove(); renderTotals(); save();
    }
  });

  // ---- reorder rows: drag the grip (mouse, pen or touch), or focus it and press ↑ / ↓ ----
  // Rows move within their own table only. The DOM row is moved in place (no re-render) so focus and edits survive.
  const live = document.createElement("div");
  live.className = "vh"; live.setAttribute("aria-live", "polite"); document.body.appendChild(live);
  const announce = tr => {
    const rows = [...tr.parentNode.children], name = tr.querySelector('[data-k="name"]')?.value.trim() || "Row";
    live.textContent = `${name} moved to position ${rows.indexOf(tr) + 1} of ${rows.length}`;
  };
  // Make state[list] follow the order of the table's rows.
  const commitOrder = tbody => {
    const l = tbody.firstElementChild?.dataset.list; if (!l) return;
    const byId = new Map(state[l].map(r => [r.id, r]));
    state[l] = [...tbody.children].map(tr => byId.get(tr.dataset.id)).filter(Boolean);
    renderTotals(); save();
  };
  let drag = null;
  function placeDragged(){
    const {tr, tbody, y} = drag;
    const before = [...tbody.children].find(r => { if (r === tr) return false; const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
    if (before ? tr.nextElementSibling !== before : tbody.lastElementChild !== tr) tbody.insertBefore(tr, before || null);
  }
  // Scroll the page while the pointer is held near the top or bottom edge.
  function dragTick(){
    if (!drag) return;
    const edge = 56, y = drag.y, h = window.innerHeight;
    const v = y < edge ? -(edge - y) / 3 : y > h - edge ? (y - (h - edge)) / 3 : 0;
    if (v) { window.scrollBy(0, v); placeDragged(); }
    drag.raf = requestAnimationFrame(dragTick);
  }
  document.addEventListener("pointerdown", e => {
    const g = e.target.closest("[data-grip]"); if (!g || e.button !== 0 || drag) return;
    e.preventDefault(); g.focus({preventScroll:true});
    const tr = g.closest("tr");
    try { g.setPointerCapture(e.pointerId); } catch(_) {}
    drag = {tr, tbody:tr.parentNode, id:e.pointerId, y:e.clientY, start:[...tr.parentNode.children].indexOf(tr)};
    tr.classList.add("dragging"); document.body.classList.add("reordering");
    drag.raf = requestAnimationFrame(dragTick);
  });
  document.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.y = e.clientY; placeDragged();
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const {tr, tbody, start, raf} = drag; drag = null; cancelAnimationFrame(raf);
    tr.classList.remove("dragging"); document.body.classList.remove("reordering");
    if ([...tbody.children].indexOf(tr) !== start) { commitOrder(tbody); announce(tr); }
  };
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.addEventListener("keydown", e => {
    const g = e.target.closest && e.target.closest("[data-grip]");
    if (!g || drag || !["ArrowUp","ArrowDown","Home","End"].includes(e.key)) return;
    e.preventDefault();
    const tr = g.closest("tr"), tbody = tr.parentNode;
    const to = {ArrowUp:tr.previousElementSibling, ArrowDown:tr.nextElementSibling?.nextElementSibling ?? null, Home:tbody.firstElementChild, End:null}[e.key];
    if ((e.key === "ArrowUp" && !to) || (e.key === "ArrowDown" && !tr.nextElementSibling) || to === tr) return;
    if (e.key === "End" && tbody.lastElementChild === tr) return;
    tbody.insertBefore(tr, to); g.focus({preventScroll:true});
    g.scrollIntoView({block:"nearest"});
    commitOrder(tbody); announce(tr);
  });
  function add(list, row){
    state[list].push(Object.assign({id:id(), active:true}, row));
    renderTables(); save();
    const inputs = document.querySelectorAll(`#${BODY[list]} tr:last-child input[data-k="name"]`);
    if (inputs[0] && !row.name) inputs[0].focus();
  }
  document.getElementById("addInc").onclick = () => add("income", {name:"", amount:0, freq:"monthly"});
  document.getElementById("addFix").onclick = () => add("fixed", {name:"", amount:0, freq:"monthly", cat:"Other"});
  document.getElementById("addDisc").onclick = () => add("disc", {name:"", amount:0, freq:"monthly"});
  document.getElementById("addEdu").onclick = () => add("edu", {name:"", amount:0, freq:"monthly"});
  document.getElementById("addRes").onclick = () => add("reserves", {name:"", type:"Savings", amount:0});
  const resChips = document.getElementById("resChips");
  [["Checking","Checking"],["Savings","Savings"],["Emergency fund","Savings"],["Brokerage","Investment"],["401(k) / IRA","Retirement"],["HSA","Investment"]].forEach(([n,t]) => {
    const b = document.createElement("button"); b.className = "chip"; b.type = "button"; b.textContent = "+ " + n;
    b.onclick = () => add("reserves", {name:n, type:t, amount:0}); resChips.appendChild(b);
  });
  const eduChips = document.getElementById("eduChips");
  [["Tuition","annual"],["Tutoring","monthly"],["Books & supplies","annual"],["School lunches","monthly"],["Uniforms","annual"],["College savings","monthly"]].forEach(([n,f]) => {
    const b = document.createElement("button"); b.className = "chip"; b.type = "button"; b.textContent = "+ " + n;
    b.onclick = () => add("edu", {name:n, amount:0, freq:f}); eduChips.appendChild(b);
  });
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
  // Suggestions disappear once that entry is logged, so the chips stay a list of ideas not yet considered.
  // Redrawn from renderNotesSummary, so adds, deletes, renames, imports and resets all keep the chips current.
  const noteChipDraws = [];
  function noteChips(list, wrapId, ideas){
    const wrap = document.getElementById(wrapId);
    const draw = () => {
      wrap.querySelectorAll(".chip").forEach(c => c.remove());
      const have = new Set(state[list].map(r => r.name.trim().toLowerCase()));
      ideas.filter(n => !have.has(n.toLowerCase())).forEach(n => {
        const b = document.createElement("button"); b.className = "chip"; b.type = "button"; b.textContent = "+ " + n;
        b.onclick = () => add(list, {name:n, weight:"2", added:today()});
        wrap.appendChild(b);
      });
    };
    noteChipDraws.push(draw);
  }
  noteChips("ptBen", "ptBenChips", ["More time with family","Lower stress","Better health & sleep","Time for caregiving","Less commuting","Room for hobbies or study","Flexibility for appointments"]);
  noteChips("ptCost", "ptCostChips", ["Slower career progression","Less visibility at work","Smaller professional network","Loss of work identity or purpose","Harder to return to full time","Same workload in fewer hours"]);
  document.getElementById("addPtBen").onclick = () => add("ptBen", {name:"", weight:"2", added:today()});
  document.getElementById("addPtCost").onclick = () => add("ptCost", {name:"", weight:"2", added:today()});
  const chips = document.getElementById("chips");
  ["Dining out","Streaming & subscriptions","Kids' activities","Gifts","Clothing","Hobbies"].forEach(n => {
    const b = document.createElement("button"); b.className = "chip"; b.type = "button"; b.textContent = "+ " + n;
    b.onclick = () => add("disc", {name:n, amount:0, freq:"monthly"}); chips.appendChild(b);
  });

  // ---- scenarios ----
  // Reads the active budget rows. The only scenario state is r.emp on income rows and state.adj per category.
  const round2 = n => Math.round(n * 100) / 100;
  const signed = n => (Math.round(n) > 0 ? "+" : "") + fmt0(n);
  const vsBudget = n => Math.round(n) === 0 ? "Same as budget" : signed(n) + " vs budget";
  const fmtMonths = m => m >= 120 ? "10+ years" : m.toFixed(1) + " months";
  // skipPT: leave out cost rows marked "Skip if part-time".
  // skipOf: which rows count as "left out when part-time" (default: the Budget tab's flag).
  function baseCats(skipPT, skipOf = r => !!r.pt){
    const by = {}, use = r => isOn(r) && !(skipPT && skipOf(r));
    state.fixed.filter(use).forEach(r => by[r.cat||"Other"] = (by[r.cat||"Other"]||0) + monthly(r));
    by.Education = state.edu.filter(use).reduce((a,r)=>a+monthly(r),0);
    by.Discretionary = state.disc.filter(use).reduce((a,r)=>a+monthly(r),0);
    return by;
  }
  const scenAmt = (c, base) => { const a = state.adj[c]; return !a ? base : a.mode === "amt" ? a.v : base * a.v / 100; };
  const setAdj = (c, a) => { if (a.mode === "pct" && a.v === 100) delete state.adj[c]; else state.adj[c] = a; };
  // Part-time = anything less than full time, including not working at all (0%).
  const isPartTime = pct => pct < 100;
  // pctOf: employment level for each income row; skipOf: which cost rows drop out below full time.
  // The Overview tab passes its own of both to model fixed levels with its own line-item selection.
  function scenCalc(pctOf = empOf, skipOf = r => !!r.pt){
    const people = state.income.filter(isOn).map(r => ({r, base:monthly(r), pct:pctOf(r)}));
    const pt = people.some(p => isPartTime(p.pct));
    const full = baseCats(false), lean = baseCats(true, skipOf);
    const cats = SCEN_CATS.filter(c => (full[c]||0) > 0 || (state.adj[c] && state.adj[c].mode === "amt"))
      .map(c => ({c, base:full[c]||0, eff:(pt ? lean : full)[c]||0, val:scenAmt(c, (pt ? lean : full)[c]||0)}));
    // Scenario costs with and without part-time work, so the income grid can price each level correctly.
    const expFull = SCEN_CATS.reduce((a,c)=>a+scenAmt(c, full[c]||0),0), expPT = SCEN_CATS.reduce((a,c)=>a+scenAmt(c, lean[c]||0),0);
    const ptRows = ["fixed","edu","disc"].flatMap(l => state[l].filter(r => isOn(r) && skipOf(r)));
    const incB = people.reduce((a,p)=>a+p.base,0), inc = people.reduce((a,p)=>a+p.base*p.pct/100,0);
    const expB = cats.reduce((a,x)=>a+x.base,0), exp = pt ? expPT : expFull;
    const res = state.reserves.filter(isOn), resT = res.reduce((a,r)=>a+(Number(r.amount)||0),0);
    // Investment returns: estimated monthly = balance × annual rate ÷ 12. Counted as scenario income only when opted in.
    const invs = res.filter(isInv).map(r => { const bal = Number(r.amount)||0, rate = retOf(r); return {r, bal, rate, ret:bal * rate / 1200}; });
    const invRet = invs.reduce((a,x)=>a+x.ret,0), invT = invs.reduce((a,x)=>a+x.bal,0);
    const invOn = !!state.invInc && invs.length > 0;
    const incAll = inc + (invOn ? invRet : 0);
    return {people, cats, pt, expFull, expPT, ptRows, incB, inc:incAll, incWork:inc, expB, exp, net:incAll-exp, netCore:inc-exp, netB:incB-expB,
      resT, invs, invRet, invT, invOn, cashT:resT-invT};
  }
  // Month-by-month reserve path for the scenario. Investment accounts earn their rate, compounded monthly.
  // Returns stay invested unless they count as scenario income; then they're paid out each month as part of the cash flow.
  // A shortfall draws on non-investment accounts first, then on investment accounts in proportion to their balances.
  // Each entry: total balance after that many months, and the estimated return for the following month.
  function project(s, months){
    let cash = s.cashT;
    const inv = s.invs.map(x => ({b:x.bal, m:x.rate / 1200}));
    const invSum = () => inv.reduce((a,x)=>a+x.b,0);
    const nextRet = () => inv.reduce((a,x)=>a+x.b*x.m,0);
    const path = [{total:cash + invSum(), ret:nextRet()}];
    for (let k = 1; k <= months; k++) {
      let ret = 0;
      inv.forEach(x => { const g = x.b * x.m; ret += g; if (!s.invOn) x.b += g; });
      let need = -(s.netCore + (s.invOn ? ret : 0));
      if (need <= 0) cash -= need;
      else {
        const fromCash = Math.min(Math.max(cash, 0), need); cash -= fromCash; need -= fromCash;
        const it = invSum();
        if (need > 0 && it > 0) { const take = Math.min(need, it), f = take / it; inv.forEach(x => x.b -= x.b * f); need -= take; }
        cash -= need;
      }
      path.push({total:cash + invSum(), ret:nextRet()});
    }
    return path;
  }
  // Household net if this person moved to level l, everything else as set in the scenario.
  function levelNet(s, p, l){
    const othersInc = s.inc - p.base * p.pct / 100;
    const othersPT = s.people.some(q => q !== p && isPartTime(q.pct));
    return othersInc + p.base * l / 100 - ((othersPT || isPartTime(l)) ? s.expPT : s.expFull);
  }
  function ptNote(s){
    const nPT = s.ptRows.length, costs = nPT === 1 ? "1 cost" : nPT + " costs";
    return !nPT ? 'Tick "Skip if part-time" on a cost in the Budget tab to drop it automatically whenever anyone is set below 100% (including 0%).'
      : s.pt ? `Someone is below full time in this scenario: ${costs} marked "Skip if part-time" left out, saving ${fmt0(s.expFull - s.expPT)}/mo.`
      : `${costs} marked "Skip if part-time" (${fmt0(s.ptRows.reduce((a,r)=>a+monthly(r),0))}/mo) ${nPT === 1 ? "drops" : "drop"} out when anyone is set below 100% (including 0%).`;
  }
  // How long reserves last under the scenario: {v: headline, note, tone}.
  function scenReserves(s){
    if (s.resT <= 0) return {v:"—", note:"Add reserve accounts on the Budget tab", tone:""};
    if (s.net < 0) {
      // Investment balances change as reserves are drawn down (and grow when returns stay invested), so walk the path.
      const path = project(s, 120), k = path.findIndex(p => p.total < 0);
      const mo = k < 0 ? 120 : k - 1 + path[k-1].total / (path[k-1].total - path[k].total);
      return {v:fmtMonths(mo), tone:"neg",
        note:`${fmt0(s.resT)} drawn down ${fmt0(-s.net)}/mo` + (k < 0 ? "" : " until empty") + (s.invs.length && !s.invOn ? "; investment growth slows the drawdown" : "")};
    }
    return {v:"No drawdown", tone:"pos", note:`Surplus adds ${fmt0(s.net)}/mo to ${fmt0(s.resT)}` + (s.exp > 0 ? `; covers ${fmtMonths(s.resT / s.exp)} of costs with no income` : "")};
  }
  const PROJ_POINTS = [["Today",0],["3 months",3],["6 months",6],["1 year",12],["2 years",24],["5 years",60]];
  const adjText = a => a.mode === "amt" ? `Set to ${fmt0(a.v)}/mo` : `${a.v}% of budget`;
  const adjInput = (c, a) => a.mode === "amt"
    ? `<div class="money-in"><input class="amt" data-sk="v" type="number" inputmode="decimal" min="0" step="any" value="${round2(a.v)}" aria-label="${c} scenario monthly amount"></div>`
    : `<div class="pct-in"><input class="amt" data-sk="v" type="number" inputmode="decimal" min="0" step="5" list="pctLevels" value="${a.v}" aria-label="${c} percent of budget"></div>`;

  function buildScenario(){
    const s = scenCalc();
    document.getElementById("scIncBody").innerHTML = s.people.map(p => `<tr data-pid="${p.r.id}">
      <td>${esc(p.r.name || "Unnamed income")}</td><td class="r num">${fmt0(p.base)}</td>
      ${EMP_LEVELS.map(l => `<td><button class="lvl" type="button" data-lvl="${l}" aria-pressed="false"></button></td>`).join("")}
      <td class="r num" data-sm></td></tr>`).join("")
      + (s.invOn ? `<tr class="inv-row"><td>Investment returns<span class="tag">Reserves</span></td><td class="r num">—</td>
      <td colspan="5" class="note">Estimated from your investment accounts; set rates under Reserves below</td><td class="r num" id="scIncInv"></td></tr>` : "");
    document.getElementById("scInvBody").innerHTML = s.invs.map(x => `<tr data-rid="${x.r.id}">
      <td>${esc(x.r.name || "Unnamed account")}</td><td class="r num">${fmt0(x.bal)}</td>
      <td><div class="pct-in rate-in"><input class="amt" data-ret type="number" inputmode="decimal" step="0.5" min="-100" max="100" value="${x.rate}" aria-label="${esc(x.r.name || "Account")} annual return percent"></div></td>
      <td class="r num" data-ir></td></tr>`).join("");
    document.getElementById("scInvInc").checked = !!state.invInc;
    document.getElementById("scCatBody").innerHTML = s.cats.map(x => {
      const a = state.adj[x.c] || {mode:"pct", v:100};
      return `<tr data-cat="${x.c}"><td><span class="sw" style="background:var(${CAT_COLOR[x.c]||"--c7"})"></span>${x.c}</td><td class="r num">${fmt0(x.base)}</td>
        <td><div class="adj"><select data-sk="mode" aria-label="${x.c} adjustment type"><option value="pct"${a.mode==="pct"?" selected":""}>Percent</option><option value="amt"${a.mode==="amt"?" selected":""}>Amount</option></select>${adjInput(x.c, a)}</div></td>
        <td class="r num" data-sm></td><td class="r num" data-sd></td></tr>`;
    }).join("");
    fillScenario(s);
  }

  function fillScenario(s = scenCalc()){
    const set = (i,v) => document.getElementById(i).textContent = v;
    const tone = (el, n) => { el.classList.toggle("neg", n < 0); el.classList.toggle("pos", n >= 0); };

    // income matrix: each cell = household net if this person moved to that level, all else as set
    s.people.forEach(p => {
      const tr = document.querySelector(`#scIncBody tr[data-pid="${p.r.id}"]`); if (!tr) return;
      tr.querySelectorAll(".lvl").forEach(b => {
        const l = Number(b.dataset.lvl), n = levelNet(s, p, l);
        b.textContent = fmt0(n); tone(b, n);
        b.setAttribute("aria-pressed", String(l === p.pct));
        b.setAttribute("aria-label", `${p.r.name || "This income"} at ${l}%: household ${n < 0 ? "shortfall" : "surplus"} of ${fmt0(Math.abs(n))} a month`);
      });
      tr.querySelector("[data-sm]").textContent = fmt0(p.base * p.pct / 100);
    });
    const incInv = document.getElementById("scIncInv"); if (incInv) incInv.textContent = fmt0(s.invRet);
    set("scIncB", fmt0(s.incB)); set("scIncT", fmt0(s.inc));
    document.getElementById("scIncEmpty").hidden = s.people.length > 0;
    document.getElementById("scIncWrap").hidden = !s.people.length;

    // categories
    s.cats.forEach(x => {
      const tr = document.querySelector(`#scCatBody tr[data-cat="${x.c}"]`); if (!tr) return;
      tr.querySelector("[data-sm]").textContent = fmt0(x.val);
      const d = tr.querySelector("[data-sd]"); d.textContent = signed(x.val - x.base);
      d.className = "r num " + (Math.round(x.val - x.base) < 0 ? "pos" : Math.round(x.val - x.base) > 0 ? "neg" : "");
    });
    set("scCatB", fmt0(s.expB)); set("scCatT", fmt0(s.exp)); set("scCatD", signed(s.exp - s.expB));
    set("scPtNote", ptNote(s));
    document.getElementById("scCatEmpty").hidden = s.cats.length > 0;
    document.getElementById("scCatWrap").hidden = !s.cats.length;

    // summary strip
    set("scInc", fmt0(s.inc)); set("scIncD", vsBudget(s.inc - s.incB) + (s.invOn ? ` · incl. ${fmt0(s.invRet)} investment returns` : ""));
    set("scExp", fmt0(s.exp)); set("scExpD", vsBudget(s.exp - s.expB));
    const sn = document.getElementById("scNet"); sn.textContent = fmt0(s.net); sn.className = "big " + (s.net >= 0 ? "pos" : "neg");
    set("scNetL", s.net >= 0 ? "Monthly surplus" : "Monthly shortfall");
    set("scNetD", vsBudget(s.net - s.netB));
    const sr = document.getElementById("scRes"), rv = scenReserves(s);
    sr.textContent = rv.v; sr.className = "big " + rv.tone; set("scResN", rv.note);

    // investment accounts and their estimated returns
    s.invs.forEach(x => {
      const tr = document.querySelector(`#scInvBody tr[data-rid="${x.r.id}"]`); if (!tr) return;
      const c = tr.querySelector("[data-ir]"); c.textContent = fmt(x.ret); tone(c, x.ret);
    });
    set("scInvT", fmt0(s.invT)); set("scInvR", fmt(s.invRet));
    document.getElementById("scInvBox").hidden = !s.invs.length;
    document.getElementById("scInvNone").hidden = s.invs.length > 0 || s.resT <= 0;
    set("scInvNote", s.invOn
      ? `Counted as income: ${fmt0(s.invRet)}/mo is added to scenario income, the surplus and the income grid above, and is paid out each month rather than reinvested.`
      : `Not counted as income: returns stay in the accounts and compound in the projection below, but the scenario income, surplus and income grid leave them out.`);

    // reserve projection: cash flow from the scenario surplus or shortfall, plus investment growth
    document.getElementById("scProjEmpty").hidden = s.resT > 0;
    document.getElementById("scProjWrap").hidden = s.resT <= 0;
    const path = project(s, 60);
    document.getElementById("scProjBody").innerHTML = PROJ_POINTS.map(([lbl,m]) => {
      const {total:b, ret} = path[m], gone = b < 0;
      return `<tr><td>${lbl}</td><td class="r num ${gone ? "neg" : ""}">${gone ? "Depleted" : fmt0(b)}</td><td class="r num">${m ? signed(Math.max(b, 0) - s.resT) : "—"}</td>`
        + `<td class="r num">${!s.invs.length || gone ? "—" : fmt(ret)}</td></tr>`;
    }).join("");
    renderOverview();
  }

  document.getElementById("scIncBody").addEventListener("click", e => {
    const b = e.target.closest(".lvl"); if (!b) return;
    const r = state.income.find(x => x.id === b.closest("tr").dataset.pid); if (!r) return;
    const l = Number(b.dataset.lvl);
    if (l === 100) delete r.emp; else r.emp = l;
    // Crossing into or out of part-time can add or remove whole categories, so rebuild rather than refill.
    save(); buildScenario();
  });
  document.getElementById("scCatBody").addEventListener("input", e => {
    const tr = e.target.closest("tr[data-cat]"); if (!tr) return;
    const c = tr.dataset.cat, base = baseCats(scenCalc().pt)[c] || 0, cur = state.adj[c] || {mode:"pct", v:100};
    if (e.target.dataset.sk === "mode") {
      const mode = e.target.value; if (mode === cur.mode) return;
      // Switching keeps the same scenario figure, just expressed the other way.
      const val = scenAmt(c, base);
      const next = mode === "amt" ? {mode, v:round2(val)} : {mode, v:base ? Math.round(val / base * 100) : 100};
      setAdj(c, next);
      tr.querySelector(".adj > div").outerHTML = adjInput(c, next);
    } else if (e.target.dataset.sk === "v") {
      setAdj(c, {mode:cur.mode, v:e.target.value === "" ? 0 : Math.max(0, Number(e.target.value) || 0)});
    } else return;
    save(); fillScenario();
  });
  document.getElementById("scenReset").onclick = () => {
    state.income.forEach(r => delete r.emp); state.adj = {}; delete state.invInc;
    save(); buildScenario();
  };
  document.getElementById("scInvBody").addEventListener("input", e => {
    if (!e.target.matches("[data-ret]")) return;
    const r = state.reserves.find(x => x.id === e.target.closest("tr").dataset.rid); if (!r) return;
    const v = toRet(e.target.value);
    if (v === null || v === DEFAULT_RET) delete r.ret; else r.ret = v;
    save(); fillScenario();
  });
  // Leaving the field empty or out of range snaps it back to the rate actually in use.
  document.getElementById("scInvBody").addEventListener("focusout", e => {
    if (!e.target.matches("[data-ret]")) return;
    const r = state.reserves.find(x => x.id === e.target.closest("tr").dataset.rid);
    if (r && Number(e.target.value) !== retOf(r)) e.target.value = retOf(r);
  });
  document.getElementById("scInvInc").addEventListener("change", e => {
    if (e.target.checked) state.invInc = true; else delete state.invInc;
    // The income grid gains or loses its investment-returns row, so rebuild.
    save(); buildScenario();
  });

  // ---- overview: one person at full time, 50% and not working; every other income stays full time ----
  // Uses the Scenario tab's spending adjustments and investment setting, but not its employment levels.
  // Settings live in state.ov = {items:[keys shown], whoIds:[income row ids changing hours], skip:{...}}.
  const OV_LEVELS = [[100,"Full time"],[50,"50% employment"],[0,"Not working"]];
  const OV_ITEMS = [
    ["chart","Surplus comparison chart",true], ["inc","Monthly income",true], ["exp","Monthly costs",true],
    ["net","Monthly surplus or shortfall",true], ["annual","Annual surplus or shortfall",true], ["spent","Share of income spent",false],
    ["ptSave","Savings from line items left out",true], ["inv","Investment returns",false], ["runway","How long reserves last",true],
    ["bal1","Reserves after 1 year",true], ["bal5","Reserves after 5 years",false], ["cats","Spending by category",false],
    ["nm","Life beyond the numbers",false]];
  const ovDefaults = () => OV_ITEMS.filter(x => x[2]).map(x => x[0]);
  const ovItems = () => state.ov && Array.isArray(state.ov.items) ? state.ov.items : ovDefaults();
  // The incomes whose hours change together; everyone else stays full time. Defaults to the first active income.
  // (state.ov.who is the single-person setting from before several could be picked.)
  const ovPeople = () => {
    const ppl = state.income.filter(isOn), o = state.ov || {};
    const ids = new Set(Array.isArray(o.whoIds) ? o.whoIds : o.who ? [o.who] : []);
    const picked = ppl.filter(r => ids.has(r.id));
    return picked.length ? picked : ppl.slice(0, 1);
  };
  const nameList = names => names.length < 2 ? names.join("") : names.slice(0, -1).join(", ") + " & " + names[names.length - 1];
  const ovSet = patch => { state.ov = Object.assign({}, state.ov, patch); save(); renderOverview(); };
  // Line items left out at 50% and at 0%: state.ov.skip = {"50":[row ids], "0":[row ids]}.
  // Until the person edits it, the selection follows the Budget tab's "Skip if part-time" ticks.
  const OV_SKIP_LEVELS = ["50","0"];
  const COST_LISTS = [["fixed","Fixed"],["edu","Education"],["disc","Discretionary"]];
  const ovCustom = () => !!(state.ov && state.ov.skip && typeof state.ov.skip === "object");
  const ovSkipIds = lvl => new Set(ovCustom() ? (Array.isArray(state.ov.skip[lvl]) ? state.ov.skip[lvl] : [])
    : COST_LISTS.flatMap(([l]) => state[l].filter(r => r.pt).map(r => r.id)));
  const ovSkipOf = l => { if (l === 100) return () => false; const ids = ovSkipIds(String(l)); return r => ids.has(r.id); };
  // Always store both levels together so the first edit fixes the other column's current picks too.
  const ovSkipSet = (lvl, ids) => { const skip = {}; OV_SKIP_LEVELS.forEach(k => skip[k] = [...(k === lvl ? ids : ovSkipIds(k))]); ovSet({skip}); };
  // Table rows. num: a dollar figure, compared against full time (better: +1 if higher is better, −1 if lower).
  // text: shown as is. floor0: a balance that can run out, shown as "Depleted" below zero.
  const ovBal = m => r => r.s.resT > 0 ? r.path[m].total : null;
  const OV_ROWS = {
    inc:{label:"Monthly income", num:r => r.s.inc, better:1},
    exp:{label:"Monthly costs", num:r => r.s.exp, better:-1},
    net:{label:"Monthly surplus / shortfall", num:r => r.s.net, better:1, tone:true},
    annual:{label:"Annual surplus / shortfall", num:r => r.s.net * 12, better:1, tone:true},
    spent:{label:"Share of income spent", text:r => r.s.inc > 0 ? Math.round(r.s.exp / r.s.inc * 100) + "%" : "—", toneOf:r => r.s.inc > 0 && r.s.exp > r.s.inc ? "neg" : ""},
    ptSave:{label:"Line items left out", text:r => r.l === 100 ? "All paid" : !r.s.ptRows.length ? "None selected" : "Saves " + fmt0(r.s.expFull - r.s.expPT),
      toneOf:r => r.l !== 100 && r.s.ptRows.length ? "pos" : "", sub:r => r.l === 100 || !r.s.ptRows.length ? "" : r.s.ptRows.length === 1 ? "1 item" : r.s.ptRows.length + " items"},
    inv:{label:"Investment returns", text:r => r.s.invs.length ? fmt0(r.s.invRet) : "—", sub:r => r.s.invs.length ? (r.s.invOn ? "Counted as income" : "Reinvested") : "No investment accounts"},
    runway:{label:"How long reserves last", text:r => r.rv.v, toneOf:r => r.rv.tone, sub:r => r.s.resT > 0 && r.s.net < 0 ? `Drawing ${fmt0(-r.s.net)}/mo` : ""},
    bal1:{label:"Reserves after 1 year", num:ovBal(12), better:1, floor0:true},
    bal5:{label:"Reserves after 5 years", num:ovBal(60), better:1, floor0:true}
  };
  function ovCell(def, r, base){
    let text, tone = "", sub = def.sub ? def.sub(r) : "", subTone = "";
    if (def.num) {
      const v = def.num(r);
      if (v === null) text = "—";
      else {
        text = def.floor0 && v < 0 ? "Depleted" : fmt0(v);
        tone = def.tone || def.floor0 ? (v < 0 ? "neg" : def.tone ? "pos" : "") : "";
        const b = def.num(base);
        if (r !== base && b !== null) {
          const diff = def.floor0 ? Math.max(v, 0) - Math.max(b, 0) : v - b;
          sub = Math.round(diff) === 0 ? "Same as full time" : signed(diff) + " vs full time";
          subTone = Math.round(diff) === 0 ? "" : diff * def.better > 0 ? "pos" : "neg";
        }
      }
    } else { text = def.text(r); tone = def.toneOf ? def.toneOf(r) : ""; }
    return `<td class="r num ${tone}">${text}${sub ? `<span class="ov-d ${subTone}">${sub}</span>` : ""}</td>`;
  }
  // Shared by the Overview tab and the printed report.
  function ovCalc(){
    const ppl = state.income.filter(isOn), group = ovPeople(), who = group.length ? group : null;
    if (!who) return {ppl, who};
    const inGroup = new Set(group);
    const runs = OV_LEVELS.map(([l, lbl]) => {
      const s = scenCalc(r => inGroup.has(r) ? l : 100, ovSkipOf(l));
      return {l, lbl, s, path:project(s, 60), rv:scenReserves(s)};
    });
    const base = runs[0], nAdj = Object.keys(state.adj).length;
    const left = r => r.s.ptRows.length ? r.s.ptRows.map(x => x.name || "Unnamed").join(", ") : "nothing";
    const skipText = runs.slice(1).map(r => `Left out at ${r.l}%: ${left(r)}.`).join(" ");
    const plain = nameList(group.map(r => r.name || "Unnamed income")), rest = ppl.length - group.length;
    const note = `${plain} at each level${group.length > 1 ? ", changing hours together" : ""}; `
      + (rest ? `${rest === 1 ? "the other income stays" : "the other " + rest + " incomes stay"} full time. ` : ppl.length > 1 ? "that's every active income. " : "the only active income. ")
      + (nAdj ? `${nAdj} spending ${nAdj === 1 ? "adjustment" : "adjustments"} from the Scenarios tab applied. ` : "Spending as budgeted. ")
      + skipText;
    return {ppl, who, runs, base, note, skipText, name:esc(plain)};
  }
  const ovHead = (o, first) => `<tr><th>${first}</th>${o.runs.map(r => `<th class="r">${r.lbl}<small>${o.name} at ${r.l}%</small></th>`).join("")}</tr>`;
  function ovChartHTML(o){
    const vals = o.runs.map(r => r.s.net), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = (hi - lo) || 1, zero = -lo / span * 100;
    return o.runs.map(r => {
      const v = r.s.net, w = Math.abs(v) / span * 100, left = v >= 0 ? zero : zero - w, t = v >= 0 ? "pos" : "neg";
      return `<span class="ov-lbl">${r.lbl}</span><div class="ov-track" role="img" aria-label="${r.lbl}: monthly ${v >= 0 ? "surplus" : "shortfall"} of ${fmt0(Math.abs(v))}">`
        + `<span class="ov-fill ${t}" style="left:${left}%;width:${w}%"></span><span class="ov-zero" style="left:${zero}%"></span></div><span class="num ov-val ${t}">${fmt0(v)}</span>`;
    }).join("");
  }
  const ovMetricRows = (o, metrics) => metrics.map(k => `<tr><td>${OV_ROWS[k].label}</td>${o.runs.map(r => ovCell(OV_ROWS[k], r, o.base)).join("")}</tr>`).join("");
  function ovCatRows(o){
    const valOf = (r, c) => (r.s.cats.find(x => x.c === c) || {val:0}).val;
    const cats = SCEN_CATS.filter(c => o.runs.some(r => r.s.cats.some(x => x.c === c)));
    return cats.length ? cats.map(c => `<tr><td><span class="sw" style="background:var(${CAT_COLOR[c]||"--c7"})"></span>${c}</td>${o.runs.map(r => {
        const v = valOf(r, c), d = v - valOf(o.base, c);
        return `<td class="r num">${fmt0(v)}${r !== o.base && Math.round(d) ? `<span class="ov-d ${d < 0 ? "pos" : "neg"}">${signed(d)}</span>` : ""}</td>`;
      }).join("")}</tr>`).join("") : `<tr><td colspan="4" class="note">No active costs yet.</td></tr>`;
  }
  const ovCatFoot = o => `<tr><td>Total costs</td>${o.runs.map(r => `<td class="r num">${fmt0(r.s.exp)}</td>`).join("")}</tr>`;
  function ovNmHTML(){
    const nb = notesBalance(), tot = nb.b + nb.c;
    if (!tot) return "";
    const list = (title, rows) => `<div class="nm-col"><h3>${title}</h3>${rows.length
      ? `<ul class="ov-list">${rows.slice().sort((a, b) => b.weight - a.weight).map(r => `<li>${esc(r.name)} <span class="tag">${WEIGHTS[r.weight] || "Medium"}</span></li>`).join("")}</ul>`
      : '<p class="note">None logged.</p>'}</div>`;
    return `<div class="nm-balance"><div class="nm-bar" aria-hidden="true"><span class="b" style="width:${nb.b / tot * 100}%"></span><span class="c" style="width:${nb.c / tot * 100}%"></span></div>`
      + `<div class="nm-legend"><span>Benefits: weight ${nb.b}</span><span class="lean ${nb.tone}">${nb.lean}</span><span>Costs: weight ${nb.c}</span></div></div>`
      + `<div class="nm-cols">${list("Benefits", nb.ben)}${list("Costs", nb.cost)}</div>`;
  }
  // Checklist of active cost rows. Markup is rebuilt only when the rows change, so ticking a box keeps focus.
  let ovSkipSig = "";
  function renderOvSkip(){
    const rows = COST_LISTS.flatMap(([l, lbl]) => state[l].filter(isOn).map(r => ({r, lbl})));
    const html = rows.map(({r, lbl}) => `<tr data-sid="${r.id}"><td>${esc(r.name || "Unnamed")}${r.pt ? '<span class="tag" title="Ticked Skip if part-time on the Budget tab">Skip if PT</span>' : ""}</td><td class="note">${lbl}</td><td class="r num">${fmt0(monthly(r))}</td>`
      + OV_SKIP_LEVELS.map(k => `<td class="c"><input class="tog" type="checkbox" data-sk="${k}" aria-label="Leave out ${esc(r.name || "this item")} at ${k}%"></td>`).join("") + "</tr>").join("");
    const body = document.getElementById("ovSkipBody");
    if (html !== ovSkipSig) { body.innerHTML = html; ovSkipSig = html; }
    document.getElementById("ovSkipEmpty").hidden = rows.length > 0;
    document.getElementById("ovSkipWrap").hidden = !rows.length;
    OV_SKIP_LEVELS.forEach(k => {
      const ids = ovSkipIds(k), picked = rows.filter(x => ids.has(x.r.id));
      body.querySelectorAll(`input[data-sk="${k}"]`).forEach(c => { c.checked = ids.has(c.closest("tr").dataset.sid); });
      const all = document.querySelector(`[data-skall="${k}"]`);
      all.checked = rows.length > 0 && picked.length === rows.length; all.indeterminate = picked.length > 0 && picked.length < rows.length;
      document.getElementById("ovSkipT" + k).textContent = fmt0(picked.reduce((a, x) => a + monthly(x.r), 0));
    });
    document.getElementById("ovSkipNote").textContent = ovCustom()
      ? 'Your own picks for the Overview. Changing "Skip if part-time" on the Budget tab no longer changes them; use the first button below to go back to matching it.'
      : 'Tick the costs that would go away at 50% employment and when not working. Starts from the "Skip if part-time" ticks on the Budget tab; your picks only affect the Overview.';
  }
  function renderOverview(){
    const show = (i, v) => { document.getElementById(i).hidden = !v; };
    renderOvSkip();
    const items = ovItems(), on = k => items.includes(k);
    document.querySelectorAll("#ovPick input").forEach(c => { c.checked = on(c.value); });
    const o = ovCalc(), {ppl, who} = o;
    // Rebuilt only when the incomes change, so ticking a box keeps focus.
    const box = document.getElementById("ovWho");
    const whoHtml = ppl.length ? ppl.map(r => `<label class="check"><input class="tog" type="checkbox" value="${r.id}"> ${esc(r.name || "Unnamed income")}</label>`).join("") : '<span class="note">No active income</span>';
    if (box.dataset.sig !== whoHtml) { box.innerHTML = whoHtml; box.dataset.sig = whoHtml; }
    // The last ticked person can't be unticked: the comparison needs someone changing hours.
    box.querySelectorAll("input").forEach(c => { c.checked = !!who && who.some(r => r.id === c.value); c.disabled = c.checked && who.length === 1; });
    const empty = document.getElementById("ovEmpty"), note = document.getElementById("ovNote");
    const metrics = Object.keys(OV_ROWS).filter(on);
    const anything = metrics.length || on("chart") || on("cats") || on("nm");
    empty.textContent = !who ? "No active income yet. Add it on the Budget tab to compare employment levels."
      : 'Nothing selected to show. Use "Choose what\'s shown" to pick items on the Scenarios tab.';
    show("ovEmpty", !who || !anything);
    if (!who) { ["ovCmp","ovCats","ovNm"].forEach(i => show(i, false)); note.textContent = ""; return; }
    note.textContent = o.note;
    // Actual savings after the Scenario tab's spending adjustments, so they match the comparison above.
    o.runs.slice(1).forEach(r => { document.getElementById("ovSkipT" + r.l).textContent = fmt0(r.s.expFull - r.s.expPT); });

    show("ovCmp", on("chart") || metrics.length);
    show("ovChartWrap", on("chart"));
    if (on("chart")) document.getElementById("ovChart").innerHTML = ovChartHTML(o);
    show("ovTblWrap", metrics.length);
    document.getElementById("ovHead").innerHTML = ovHead(o, "");
    document.getElementById("ovBody").innerHTML = ovMetricRows(o, metrics);

    show("ovCats", on("cats"));
    if (on("cats")) {
      document.getElementById("ovCatHead").innerHTML = ovHead(o, "Category");
      document.getElementById("ovCatBody").innerHTML = ovCatRows(o);
      document.getElementById("ovCatFoot").innerHTML = ovCatFoot(o);
    }

    show("ovNm", on("nm"));
    if (on("nm")) document.getElementById("ovNmBody").innerHTML = ovNmHTML()
      || '<div class="empty">Nothing logged yet. Add costs and benefits under "Life beyond the numbers" on the Scenarios tab.</div>';
  }
  document.getElementById("ovPick").innerHTML = OV_ITEMS.map(([k, l]) => `<label class="check"><input class="tog" type="checkbox" value="${k}"> ${l}</label>`).join("");
  document.getElementById("ovPick").addEventListener("change", () =>
    ovSet({items:[...document.querySelectorAll("#ovPick input:checked")].map(c => c.value)}));
  document.getElementById("ovSet").addEventListener("click", e => {
    const b = e.target.closest("[data-ovpick]"); if (!b) return;
    const g = b.dataset.ovpick;
    ovSet({items: g === "all" ? OV_ITEMS.map(x => x[0]) : g === "none" ? [] : ovDefaults()});
  });
  document.getElementById("ovWho").addEventListener("change", () => {
    const ids = [...document.querySelectorAll("#ovWho input:checked")].map(c => c.value);
    if (ids.length) ovSet({whoIds:ids, who:undefined});
  });
  document.getElementById("ovSkipWrap").addEventListener("change", e => {
    const k = e.target.dataset.sk ?? e.target.dataset.skall; if (k === undefined) return;
    const ids = ovSkipIds(k);
    if (e.target.dataset.skall !== undefined) {
      const rows = COST_LISTS.flatMap(([l]) => state[l].filter(isOn).map(r => r.id));
      rows.forEach(id => e.target.checked ? ids.add(id) : ids.delete(id));
    } else { const id = e.target.closest("tr").dataset.sid; e.target.checked ? ids.add(id) : ids.delete(id); }
    ovSkipSet(k, ids);
  });
  document.getElementById("ovSkipPanel").addEventListener("click", e => {
    const b = e.target.closest("[data-ovskip]"); if (!b) return;
    const g = b.dataset.ovskip;
    if (g === "budget") { const o = Object.assign({}, state.ov); delete o.skip; state.ov = o; save(); renderOverview(); }
    else if (g === "copy") ovSkipSet("0", ovSkipIds("50"));
    else ovSet({skip:{"50":[], "0":[]}});
  });
  document.getElementById("ovGo").onclick = () => showTab("tabOv", true);
  document.getElementById("ovEdit").onclick = () => {
    showTab("tabScen");
    const box = document.getElementById("ovSet");
    box.scrollIntoView({block:"start"});
    const first = box.querySelector("input"); if (first) first.focus({preventScroll:true});
  };

  // ---- tabs ----
  const TABKEY = "household-budget-tab";
  const TABS = [["tabBudget","pBudget"],["tabScen","pScen"],["tabOv","pOv"]];
  function showTab(tid, focus){
    TABS.forEach(([t,p]) => {
      const on = t === tid, b = document.getElementById(t);
      b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
      document.getElementById(p).hidden = !on;
      if (on && focus) b.focus();
    });
    try { localStorage.setItem(TABKEY, tid); } catch(e) {}
  }
  TABS.forEach(([t]) => document.getElementById(t).addEventListener("click", () => showTab(t)));
  document.querySelector(".tabs").addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = TABS.findIndex(([t]) => t === document.activeElement.id); if (i < 0) return;
    showTab(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length][0], true);
    e.preventDefault();
  });
  try { const t = localStorage.getItem(TABKEY); if (t !== "tabBudget" && TABS.some(([x]) => x === t)) showTab(t); } catch(e) {}

  const ra = document.getElementById("resetArea");
  function resetIdle(){ ra.innerHTML = '<button class="btn" id="resetBtn" type="button">Reset to starting estimates</button>'; document.getElementById("resetBtn").onclick = resetAsk; }
  function resetAsk(){
    ra.innerHTML = '<span class="note">Discard your edits?</span><button class="btn danger" type="button" id="rY">Reset</button><button class="btn" type="button" id="rN">Keep edits</button>';
    document.getElementById("rY").onclick = () => { state = defaults(); save(); renderTables(); resetIdle(); };
    document.getElementById("rN").onclick = resetIdle;
  }
  resetIdle();
  renderTables();

  // Another tab or window of this app saved: take its budget, so this tab (e.g. one left on Scenarios)
  // doesn't show stale figures or overwrite the newer edits on its next save.
  window.addEventListener("storage", e => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      const raw = JSON.parse(e.newValue);
      if (!raw || !Array.isArray(raw.fixed)) return;
      state = upgrade(raw); renderTables();
      const ss = document.getElementById("saveState");
      if (ss) ss.textContent = "Updated from another tab " + new Date().toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
    } catch(_) {}
  });

  // ---- messages ----
  const msg = document.getElementById("msg");
  function say(text, undo){
    msg.hidden = false; msg.textContent = text;
    if (undo) { const b = document.createElement("button"); b.className = "link"; b.type = "button"; b.textContent = "Undo"; b.onclick = undo; msg.appendChild(b); }
  }

  // ---- downloads (export) ----
  // Plain browser download: build a Blob and click a temporary link.
  const stamp = () => new Date().toISOString().slice(0,10);
  function offer(filename, data, type){
    try {
      const blob = data instanceof Blob ? data : new Blob([data], {type: type || "application/octet-stream"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      say("Exported " + filename + ".");
    } catch(e) {
      say("Couldn't export " + filename + " (" + (e && e.message || "error") + ").");
    }
  }
  document.getElementById("expJson").onclick = () => offer("household-budget-" + stamp() + ".json", JSON.stringify(portable(), null, 2), "application/json");

  const SHEETS = [["income","Income",false],["fixed","Fixed costs",true],["edu","Education",false],["disc","Discretionary",false]];
  const SHEET_CAT = {income:"Income", edu:"Education", disc:"Discretionary"};
  document.getElementById("expXlsx").onclick = () => {
    if (!window.XLSX) { say("The Excel library didn't load. Check your connection and reload the page."); return; }
    const X = window.XLSX, wb = X.utils.book_new(), money = '"$"#,##0.00';
    const sheetTotals = {};
    SHEETS.forEach(([key, title, withCat]) => {
      const isCost = key !== "income";
      const head = ["Item","Amount","Frequency","Times per year","Category","Monthly","Annual","Active", ...(isCost ? ["Skip if part-time"] : [])];
      const rows = state[key].map(r => [r.name, Number(r.amount)||0, FREQ.find(f=>f[0]===r.freq)[1], PER[r.freq], withCat ? r.cat : SHEET_CAT[key], monthly(r), monthly(r)*12, isOn(r) ? "Yes" : "No", ...(isCost ? [r.pt ? "Yes" : "No"] : [])]);
      const n = rows.length;
      const ws = X.utils.aoa_to_sheet([head, ...rows, ["Total","","","","", 0, 0]]);
      for (let i = 2; i <= n + 1; i++) {
        ws["F"+i].f = `B${i}*D${i}/12`; ws["G"+i].f = `F${i}*12`;
        ["B","F","G"].forEach(c => ws[c+i].z = money);
      }
      const t = n + 2, lastRow = Math.max(n + 1, 2);
      // Totals count only rows marked Active = Yes, so flipping that cell in Excel remodels the workbook too.
      ws["F"+t] = {t:"n", v: rows.reduce((a,r)=>a+(r[7]==="Yes"?r[5]:0),0), f: n ? `SUMIF(H2:H${lastRow},"Yes",F2:F${lastRow})` : undefined, z: money};
      ws["G"+t] = {t:"n", v: rows.reduce((a,r)=>a+(r[7]==="Yes"?r[6]:0),0), f: n ? `SUMIF(H2:H${lastRow},"Yes",G2:G${lastRow})` : undefined, z: money};
      if (!n) { delete ws["F"+t].f; delete ws["G"+t].f; }
      ws["!cols"] = [{wch:32},{wch:12},{wch:15},{wch:14},{wch:15},{wch:13},{wch:13},{wch:8},{wch:16}];
      sheetTotals[key] = {cell: `'${title}'!F${t}`, v: ws["F"+t].v};
      X.utils.book_append_sheet(wb, ws, title);
    });
    const inc = sheetTotals.income, fx = sheetTotals.fixed, ed = sheetTotals.edu, ds = sheetTotals.disc;
    const costs = fx.v + ed.v + ds.v;
    const rh = ["Account","Type","Balance","Active","Annual return %"];
    const rrows = state.reserves.map(r => [r.name, r.type, Number(r.amount)||0, isOn(r) ? "Yes" : "No", isInv(r) ? retOf(r) : ""]);
    const rn = rrows.length, rt = rn + 2;
    const rws = X.utils.aoa_to_sheet([rh, ...rrows, ["Total","", rrows.reduce((a,r)=>a+(r[3]==="Yes"?r[2]:0),0), ""]]);
    for (let i = 2; i <= rt; i++) rws["C"+i].z = money;
    if (rn) rws["C"+rt].f = `SUMIF(D2:D${rn+1},"Yes",C2:C${rn+1})`;
    rws["!cols"] = [{wch:32},{wch:14},{wch:14},{wch:8},{wch:16}];
    X.utils.book_append_sheet(wb, rws, "Reserves");
    const resV = rws["C"+rt].v;
    const s = X.utils.aoa_to_sheet([
      ["Household Budget"], ["Exported", stamp()], [],
      ["", "Monthly", "Annual"],
      ["Income", inc.v, inc.v*12],
      ["Fixed costs", fx.v, fx.v*12],
      ["Education", ed.v, ed.v*12],
      ["Discretionary", ds.v, ds.v*12],
      ["Total costs", costs, costs*12],
      ["Surplus / shortfall", inc.v-costs, (inc.v-costs)*12],
      [],
      ["Reserve funds", resV],
      ["Months of costs covered", costs ? resV/costs : 0],
      ["Months covered, no discretionary", (fx.v + ed.v) ? resV/(fx.v + ed.v) : 0],
      ["Months covered, fixed costs only", fx.v ? resV/fx.v : 0]
    ]);
    s.B14.f = "IF(B6+B7>0,B12/(B6+B7),0)"; s.B14.z = "0.0";
    s.B15.f = "IF(B6>0,B12/B6,0)"; s.B15.z = "0.0";
    s.B12.f = `'Reserves'!C${rt}`; s.B12.z = money;
    s.B13.f = "IF(B9>0,B12/B9,0)"; s.B13.z = "0.0";
    s.B5.f = inc.cell; s.B6.f = fx.cell; s.B7.f = ed.cell; s.B8.f = ds.cell; s.B9.f = "B6+B7+B8"; s.B10.f = "B5-B9";
    for (let i = 5; i <= 10; i++) { s["C"+i].f = `B${i}*12`; s["B"+i].z = money; s["C"+i].z = money; }
    s["!cols"] = [{wch:32},{wch:14},{wch:14}];
    X.utils.book_append_sheet(wb, s, "Summary");
    const nm = X.utils.aoa_to_sheet([["Type","Item","Importance","Added"],
      ...state.ptBen.map(r => ["Benefit", r.name, WEIGHTS[r.weight] || "Medium", r.added || ""]),
      ...state.ptCost.map(r => ["Cost", r.name, WEIGHTS[r.weight] || "Medium", r.added || ""])]);
    nm["!cols"] = [{wch:10},{wch:48},{wch:12},{wch:12}];
    X.utils.book_append_sheet(wb, nm, "Non-monetary");
    wb.SheetNames = ["Summary", ...wb.SheetNames.filter(n => n !== "Summary")];
    const buf = X.write(wb, {type:"array", bookType:"xlsx"});
    offer("household-budget-" + stamp() + ".xlsx", new Blob([buf], {type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
  };

  // ---- import ----
  function readXlsx(buf){
    if (!window.XLSX) throw new Error("The Excel library didn't load. Reload the page and try again.");
    const wb = window.XLSX.read(buf, {type:"array"});
    const out = {};
    SHEETS.forEach(([key, title]) => {
      const ws = wb.Sheets[title] || wb.Sheets[Object.keys(wb.Sheets).find(n => n.toLowerCase() === title.toLowerCase())];
      if (!ws) { out[key] = []; return; }
      out[key] = window.XLSX.utils.sheet_to_json(ws, {defval:""})
        .filter(r => String(r.Item ?? r.Source ?? r.Name ?? "").trim().toLowerCase() !== "total")
        .map(r => ({name: r.Item ?? r.Source ?? r.Name, amount: r.Amount, freq: r.Frequency, cat: r.Category, active: r.Active, skipIfPartTime: r["Skip if part-time"]}));
    });
    const rws = wb.Sheets.Reserves || wb.Sheets[Object.keys(wb.Sheets).find(n => n.toLowerCase() === "reserves")];
    if (rws) out.reserves = window.XLSX.utils.sheet_to_json(rws, {defval:""})
      .filter(r => String(r.Account ?? r.Name ?? "").trim().toLowerCase() !== "total")
      .map(r => ({name: r.Account ?? r.Name, type: r.Type, amount: r.Balance ?? r.Amount, active: r.Active, returnPct: r["Annual return %"]}));
    const nws = wb.Sheets["Non-monetary"] || wb.Sheets[Object.keys(wb.Sheets).find(n => n.toLowerCase().replace(/[^a-z]/g, "") === "nonmonetary")];
    if (nws) {
      const rows = window.XLSX.utils.sheet_to_json(nws, {defval:""}).map(r => ({type:String(r.Type ?? "").trim().toLowerCase(), text:r.Item, importance:r.Importance, added:r.Added}));
      out.nonMonetary = {benefits: rows.filter(r => r.type.startsWith("benefit")), costs: rows.filter(r => r.type.startsWith("cost"))};
    }
    return out;
  }
  document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
  document.getElementById("importFile").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0]; e.target.value = "";
    if (!f) return;
    const isX = /\.xlsx$/i.test(f.name);
    const rd = new FileReader();
    rd.onerror = () => say("Couldn't read " + f.name + ".");
    rd.onload = () => {
      try {
        const next = sanitize(isX ? readXlsx(rd.result) : JSON.parse(rd.result));
        const before = JSON.stringify(state);
        const keptRes = next.reserves === null;
        if (keptRes) next.reserves = state.reserves;
        if (next.ptBen === null) next.ptBen = state.ptBen;
        if (next.ptCost === null) next.ptCost = state.ptCost;
        // Keep this browser's overview choices unless the file has its own; old line-item picks point at replaced rows, so drop them.
        const ov = Object.assign({}, state.ov, next.ov);
        if (!(next.ov && next.ov.skip)) delete ov.skip;
        next.ov = ov;
        state = next; renderTables(); save();
        const n = next.income.length + next.fixed.length + next.edu.length + next.disc.length + (keptRes ? 0 : next.reserves.length);
        say(`Imported ${n} rows from ${f.name}.` + (keptRes ? " That file has no reserve funds, so your current accounts were kept." : ""), () => { state = JSON.parse(before); renderTables(); save(); say("Import undone."); });
      } catch(err) {
        say("Couldn't import " + f.name + ": " + (err instanceof SyntaxError ? "the file isn't valid JSON." : err.message));
      }
    };
    isX ? rd.readAsArrayBuffer(f) : rd.readAsText(f);
  });

  // ---- printable report ----
  // Built from the same figures as the screen into #report, which is only displayed when printing.
  // Scenario sections use whatever levels and adjustments are set on the Scenarios tab right now.
  const RPT_KEY = "household-budget-report";
  const RPT_SECS = [
    ["ov","Employment overview","ov"],
    ["bSum","Summary","budget"], ["bCat","Spending by category","budget"], ["bItems","Line items","budget"], ["bRes","Reserve funds","budget"],
    ["sSum","Summary and assumptions","scen"], ["sInc","Income by person","scen"], ["sCat","Spending by category","scen"], ["sProj","Reserves projection","scen"],
    ["nm","Life beyond the numbers","other"]];
  const rptDefaults = () => ({title:"Household Budget Report", notes:"", inactive:false, secs:RPT_SECS.map(x => x[0])});
  // Kept in memory too, so printing still matches the dialog when browser storage is blocked.
  let rptMem = null;
  function rptPrefs(){
    if (rptMem) return rptMem;
    const d = rptDefaults();
    let p = null;
    try { p = JSON.parse(localStorage.getItem(RPT_KEY)); } catch(e) {}
    if (!p || typeof p !== "object") return d;
    const secs = Array.isArray(p.secs) ? p.secs.filter(k => RPT_SECS.some(x => x[0] === k)) : d.secs;
    // Selections saved before the overview section existed get it switched on once.
    if (!p.hasOv && !secs.includes("ov")) secs.unshift("ov");
    return {title: typeof p.title === "string" ? p.title : d.title, notes: typeof p.notes === "string" ? p.notes : "", inactive: !!p.inactive, secs};
  }
  function rptSave(p){
    rptMem = p;
    try { localStorage.setItem(RPT_KEY, JSON.stringify(Object.assign({hasOv:true}, p))); } catch(e) {}
  }

  const freqLbl = f => (FREQ.find(x => x[0] === f) || FREQ[3])[1];
  const th = (t, r) => `<th${r ? ' class="r"' : ""}>${t}</th>`;
  const tdn = (v, cls) => `<td class="r num${cls ? " " + cls : ""}">${v}</td>`;
  const swatch = c => `<span class="sw" style="background:var(${CAT_COLOR[c]||"--c7"})"></span>`;
  const neg = n => Math.round(n) < 0 ? "neg" : "";
  const rpSec = (title, body, note, keep) => `<section class="rp-sec${keep ? " rp-keep" : ""}"><h3>${title}</h3>${body}${note ? `<p class="rp-note">${note}</p>` : ""}</section>`;
  const rpStats = items => `<div class="rp-stats">${items.map(([l, v, sub, cls]) => `<div><span class="lbl">${l}</span><b class="${cls || ""}">${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`).join("")}</div>`;
  const rpEmpty = t => `<p class="rp-note">${t}</p>`;

  function rptBudgetSummary(b){
    const share = b.inc > 0 ? (b.exp / b.inc * 100).toFixed(0) + "%" : "—";
    const rows = [["Income", b.inc], ["Fixed costs", b.fix], ["Education", b.edu], ["Discretionary", b.disc]];
    return rpSec("Summary", rpStats([
      ["Monthly income", fmt0(b.inc), fmt0(b.inc * 12) + " / yr"],
      ["Monthly costs", fmt0(b.exp), fmt0(b.exp * 12) + " / yr"],
      [b.net >= 0 ? "Monthly surplus" : "Monthly shortfall", fmt0(b.net), fmt0(b.net * 12) + " / yr", b.net >= 0 ? "pos" : "neg"],
      ["Share of income spent", share, b.inc > 0 ? (b.exp > b.inc ? "Costs exceed income" : `${(100 - b.exp / b.inc * 100).toFixed(0)}% left to save or invest`) : "No active income"]])
      + `<table><thead><tr>${th("")}${th("Monthly", 1)}${th("Annual", 1)}</tr></thead><tbody>`
      + rows.map(([l, v]) => `<tr><td>${l}</td>${tdn(fmt(v))}${tdn(fmt(v * 12))}</tr>`).join("")
      + `<tr class="sub"><td>Total costs</td>${tdn(fmt(b.exp))}${tdn(fmt(b.exp * 12))}</tr></tbody>`
      + `<tfoot><tr><td>${b.net >= 0 ? "Surplus" : "Shortfall"}</td>${tdn(fmt(b.net), neg(b.net))}${tdn(fmt(b.net * 12), neg(b.net))}</tr></tfoot></table>`, "", true);
  }
  function rptBudgetCats(b){
    if (!b.cats.length) return rpSec("Spending by category", rpEmpty("No active costs."));
    const pct = v => b.exp ? v / b.exp * 100 : 0;
    return rpSec("Spending by category",
      `<div class="bar">${b.cats.map(([c, v]) => `<span style="width:${pct(v)}%;background:var(${CAT_COLOR[c]||"--c7"})">${pct(v) >= 9 ? `<b>${c}</b>` : ""}</span>`).join("")}</div>`
      + `<table><thead><tr>${th("Category")}${th("Monthly", 1)}${th("Annual", 1)}${th("Share", 1)}</tr></thead><tbody>`
      + b.cats.map(([c, v]) => `<tr><td>${swatch(c)}${c}</td>${tdn(fmt(v))}${tdn(fmt(v * 12))}${tdn(pct(v).toFixed(1) + "%")}</tr>`).join("")
      + `</tbody><tfoot><tr><td>Total costs</td>${tdn(fmt(b.exp))}${tdn(fmt(b.exp * 12))}${tdn("100%")}</tr></tfoot></table>`, "", true);
  }
  function rptItems(opt){
    const lists = [["income","Income"],["fixed","Fixed costs"],["edu","Education"],["disc","Discretionary"]];
    const parts = lists.map(([k, title]) => {
      const rows = state[k].filter(r => opt.inactive || isOn(r));
      if (!rows.length) return "";
      const withCat = k === "fixed";
      const flags = r => [isOn(r) ? "" : "Inactive", r.pt ? "Skip if part-time" : ""].filter(Boolean).join(" · ");
      const hasFlags = rows.some(flags);
      const tot = state[k].filter(isOn).reduce((a, r) => a + monthly(r), 0);
      const lead = withCat ? 4 : 3;
      // Fixed costs always start a new page.
      return `<h4${k === "fixed" ? ' class="rp-break"' : ""}>${title}</h4><table class="rp-items"><thead><tr>${th(k === "income" ? "Source" : "Item")}${th("Amount", 1)}${th("Frequency")}${withCat ? th("Category") : ""}${th("Monthly", 1)}${th("Annual", 1)}${hasFlags ? th("Notes") : ""}</tr></thead><tbody>`
        + rows.map(r => `<tr${isOn(r) ? "" : ' class="off"'}><td>${esc(r.name || "Unnamed")}</td>${tdn(fmt(Number(r.amount) || 0))}<td>${freqLbl(r.freq)}</td>${withCat ? `<td>${esc(r.cat || "Other")}</td>` : ""}${tdn(fmt(monthly(r)))}${tdn(fmt(monthly(r) * 12))}${hasFlags ? `<td class="rp-flag">${flags(r)}</td>` : ""}</tr>`).join("")
        + `</tbody><tfoot><tr><td colspan="${lead}">${title} total${opt.inactive && rows.some(r => !isOn(r)) ? ' <span class="rp-flag">(active rows only)</span>' : ""}</td>${tdn(fmt(tot))}${tdn(fmt(tot * 12))}${hasFlags ? "<td></td>" : ""}</tr></tfoot></table>`;
    }).join("");
    return rpSec("Line items", parts || rpEmpty("No income or cost rows."), opt.inactive ? "Inactive rows are listed for reference but left out of every total." : "");
  }
  function rptReserves(b, opt){
    const rows = state.reserves.filter(r => opt.inactive || isOn(r));
    if (!rows.length) return rpSec("Reserve funds", rpEmpty("No reserve accounts."));
    const months = (n, d) => n > 0 && d > 0 ? fmtMonths(n / d) : "—";
    return rpSec("Reserve funds", rpStats([
      ["Total reserves", fmt0(b.resT)],
      ["Covers costs for", months(b.resT, b.exp), "At current monthly costs"],
      ["With no discretionary", months(b.resT, b.exp - b.disc), `Costs of ${fmt0(b.exp - b.disc)}/mo`],
      ["Fixed costs only", months(b.resT, b.fix), `Costs of ${fmt0(b.fix)}/mo`]])
      + `<table><thead><tr>${th("Account")}${th("Type")}${th("Balance", 1)}${th("Annual return", 1)}</tr></thead><tbody>`
      + rows.map(r => `<tr${isOn(r) ? "" : ' class="off"'}><td>${esc(r.name || "Unnamed")}${isOn(r) ? "" : ' <span class="rp-flag">Inactive</span>'}</td><td>${esc(r.type)}</td>${tdn(fmt(Number(r.amount) || 0))}${tdn(isInv(r) ? retOf(r) + "%" : "—")}</tr>`).join("")
      + `</tbody><tfoot><tr><td colspan="2">Total reserves</td>${tdn(fmt(b.resT))}<td></td></tr></tfoot></table>`,
      "Months covered assume income stops entirely.", true);
  }
  function rptScenSummary(s){
    const rv = scenReserves(s);
    const row = (l, bv, sv, toneIt) => `<tr><td>${l}</td>${tdn(fmt0(bv), toneIt ? neg(bv) : "")}${tdn(fmt0(sv), toneIt ? neg(sv) : "")}${tdn(signed(sv - bv))}</tr>`;
    const a = [];
    s.people.forEach(p => a.push(`<b>${esc(p.r.name || "Unnamed income")}</b>: ${p.pct}% employment${p.pct === 100 ? " (full time)" : p.pct === 0 ? " (not working)" : ""}, ${fmt0(p.base * p.pct / 100)}/mo of ${fmt0(p.base)} budgeted`));
    const adjs = s.cats.filter(x => state.adj[x.c]);
    adjs.forEach(x => a.push(`<b>${x.c}</b>: ${adjText(state.adj[x.c]).toLowerCase()}, ${fmt0(x.val)}/mo`));
    if (!adjs.length) a.push("No spending adjustments; every category as budgeted");
    if (s.ptRows.length) a.push(s.pt
      ? `Someone is below full time, so costs marked "Skip if part-time" are left out (${s.ptRows.map(r => esc(r.name || "Unnamed")).join(", ")}), saving ${fmt0(s.expFull - s.expPT)}/mo`
      : `Everyone is full time, so costs marked "Skip if part-time" stay in`);
    if (s.invs.length) a.push(s.invOn ? `Investment returns of ${fmt0(s.invRet)}/mo counted as income and paid out each month` : "Investment returns not counted as income; they stay invested and compound in the projection");
    return rpSec("Summary and assumptions", rpStats([
      ["Scenario income", fmt0(s.inc), vsBudget(s.inc - s.incB)],
      ["Scenario costs", fmt0(s.exp), vsBudget(s.exp - s.expB)],
      [s.net >= 0 ? "Monthly surplus" : "Monthly shortfall", fmt0(s.net), vsBudget(s.net - s.netB), s.net >= 0 ? "pos" : "neg"],
      ["Reserves", rv.v, rv.note, rv.tone]])
      + `<table><thead><tr>${th("Monthly")}${th("Budget", 1)}${th("Scenario", 1)}${th("Change", 1)}</tr></thead><tbody>`
      + row("Income", s.incB, s.inc) + row("Costs", s.expB, s.exp) + `</tbody><tfoot>${row("Surplus / shortfall", s.netB, s.net, true)}</tfoot></table>`
      + `<h4>Assumptions</h4><ul class="rp-list">${a.map(x => `<li>${x}</li>`).join("")}</ul>`, "", true);
  }
  function rptScenIncome(s){
    if (!s.people.length) return rpSec("Income by person", rpEmpty("No active income."));
    return rpSec("Income by person",
      `<table class="rp-grid"><thead><tr>${th("Source")}${th("Budgeted / mo", 1)}${EMP_LEVELS.map(l => th(l + "%", 1)).join("")}${th("Scenario / mo", 1)}</tr></thead><tbody>`
      + s.people.map(p => `<tr><td>${esc(p.r.name || "Unnamed income")}</td>${tdn(fmt0(p.base))}${EMP_LEVELS.map(l => { const n = levelNet(s, p, l); return tdn(fmt0(n), [neg(n), l === p.pct ? "sel" : ""].filter(Boolean).join(" ")); }).join("")}${tdn(fmt0(p.base * p.pct / 100))}</tr>`).join("")
      + (s.invOn ? `<tr><td>Investment returns</td>${tdn("—")}<td colspan="${EMP_LEVELS.length}" class="rp-flag">Estimated from investment accounts</td>${tdn(fmt0(s.invRet))}</tr>` : "")
      + `</tbody><tfoot><tr><td>Total income</td>${tdn(fmt0(s.incB))}<td colspan="${EMP_LEVELS.length}"></td>${tdn(fmt0(s.inc))}</tr></tfoot></table>`,
      "Each level shows the household's monthly surplus or shortfall if that person worked at that level, with everything else as set. The outlined cell is the level chosen in this scenario. Pay is assumed to scale with hours.", true);
  }
  function rptScenCats(s){
    if (!s.cats.length) return rpSec("Spending by category", rpEmpty("No active costs."));
    return rpSec("Spending by category",
      `<table><thead><tr>${th("Category")}${th("Budgeted / mo", 1)}${th("Adjustment")}${th("Scenario / mo", 1)}${th("Change", 1)}</tr></thead><tbody>`
      + s.cats.map(x => `<tr><td>${swatch(x.c)}${x.c}</td>${tdn(fmt0(x.base))}<td>${state.adj[x.c] ? adjText(state.adj[x.c]) : '<span class="rp-flag">As budgeted</span>'}</td>${tdn(fmt0(x.val))}${tdn(signed(x.val - x.base))}</tr>`).join("")
      + `</tbody><tfoot><tr><td>Total costs</td>${tdn(fmt0(s.expB))}<td></td>${tdn(fmt0(s.exp))}${tdn(signed(s.exp - s.expB))}</tr></tfoot></table>`, ptNote(s), true);
  }
  function rptScenProj(s){
    if (s.resT <= 0) return rpSec("Reserves projection", rpEmpty("No active reserve accounts."));
    const rv = scenReserves(s), path = project(s, 60);
    const inv = s.invs.length ? `<h4>Investment accounts</h4><table><thead><tr>${th("Account")}${th("Balance", 1)}${th("Annual return", 1)}${th("Est. monthly return", 1)}</tr></thead><tbody>`
      + s.invs.map(x => `<tr><td>${esc(x.r.name || "Unnamed account")}</td>${tdn(fmt0(x.bal))}${tdn(x.rate + "%")}${tdn(fmt(x.ret))}</tr>`).join("")
      + `</tbody><tfoot><tr><td>Total</td>${tdn(fmt0(s.invT))}<td></td>${tdn(fmt(s.invRet))}</tr></tfoot></table>` : "";
    return rpSec("Reserves projection",
      `<p class="rp-lead"><b class="${rv.tone}">${rv.v}</b> · ${rv.note}</p>`
      + `<table><thead><tr>${th("After")}${th("Projected balance", 1)}${th("Change from today", 1)}${th("Est. monthly investment return", 1)}</tr></thead><tbody>`
      + PROJ_POINTS.map(([lbl, m]) => { const {total:b, ret} = path[m], gone = b < 0;
          return `<tr><td>${lbl}</td>${tdn(gone ? "Depleted" : fmt0(b), gone ? "neg" : "")}${tdn(m ? signed(Math.max(b, 0) - s.resT) : "—")}${tdn(!s.invs.length || gone ? "—" : fmt(ret))}</tr>`; }).join("")
      + `</tbody></table>` + inv,
      "Active reserve balances carried forward at the scenario's monthly surplus or shortfall. A shortfall draws on non-investment accounts first. Investment returns are compounded monthly and are estimates, not guarantees.", true);
  }
  function rptNotes(){
    const nb = notesBalance();
    if (!nb.ben.length && !nb.cost.length) return rpSec("Life beyond the numbers", rpEmpty("No non-monetary costs or benefits logged."));
    const col = (title, rows) => `<div><h4>${title}</h4>${rows.length ? `<table><thead><tr>${th("Item")}${th("Importance")}${th("Added")}</tr></thead><tbody>`
      + rows.map(r => `<tr><td>${esc(r.name)}</td><td>${WEIGHTS[r.weight] || "Medium"}</td><td class="nowrap">${fmtDay(r.added)}</td></tr>`).join("") + `</tbody></table>` : rpEmpty("None logged.")}</div>`;
    return rpSec("Life beyond the numbers",
      `<p class="rp-lead"><b class="${nb.tone}">${nb.lean}</b> · Benefits weigh ${nb.b}, costs weigh ${nb.c}</p><div class="rp-cols">${col("Benefits", nb.ben)}${col("Costs", nb.cost)}</div>`,
      "Non-monetary costs and benefits of working less than full time. Low counts as 1, Medium as 2, High as 3. Not part of any dollar figure.");
  }

  // The Overview tab as it stands: same person and the same items chosen on the Scenarios tab.
  function rptOverview(){
    const o = ovCalc(), items = ovItems(), on = k => items.includes(k), metrics = Object.keys(OV_ROWS).filter(on);
    if (!o.who) return rpSec("Full time, 50% and not working", rpEmpty("No active income."));
    const parts = [
      on("chart") && `<h4>Monthly surplus or shortfall</h4><div class="ov-chart">${ovChartHTML(o)}</div>`,
      metrics.length && `<table class="ov-tbl"><thead>${ovHead(o, "")}</thead><tbody>${ovMetricRows(o, metrics)}</tbody></table>`,
      on("cats") && `<h4>Spending by category</h4><table class="ov-tbl"><thead>${ovHead(o, "Category")}</thead><tbody>${ovCatRows(o)}</tbody><tfoot>${ovCatFoot(o)}</tfoot></table>`,
      on("nm") && `<h4>Life beyond the numbers</h4>${ovNmHTML() || rpEmpty("No non-monetary costs or benefits logged.")}`
    ].filter(Boolean).join("");
    return rpSec("Full time, 50% and not working", `<p class="rp-lead">${esc(o.note)}</p>` + (parts || rpEmpty("No overview items selected on the Scenarios tab.")),
      "Monthly figures unless noted. Changes are shown against full time. Uses the Scenarios tab's spending adjustments and investment setting, not its employment levels.");
  }

  function buildReport(p){
    const on = k => p.secs.includes(k), b = budgetCalc(), s = scenCalc();
    const now = new Date();
    const budget = [on("bSum") && rptBudgetSummary(b), on("bCat") && rptBudgetCats(b), on("bItems") && rptItems(p), on("bRes") && rptReserves(b, p)].filter(Boolean).join("");
    const scen = [on("sSum") && rptScenSummary(s), on("sInc") && rptScenIncome(s), on("sCat") && rptScenCats(s), on("sProj") && rptScenProj(s)].filter(Boolean).join("");
    const other = on("nm") ? rptNotes() : "";
    const ov = on("ov") ? rptOverview() : "";
    document.getElementById("report").innerHTML =
      `<header class="rp-head"><h1>${esc(p.title.trim() || rptDefaults().title)}</h1>`
      + `<p class="rp-meta">Prepared ${now.toLocaleDateString("en-US", {weekday:"long", month:"long", day:"numeric", year:"numeric"})} at ${now.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})}</p>`
      + (p.notes.trim() ? `<p class="rp-notes">${esc(p.notes.trim())}</p>` : "") + `</header>`
      // Budget and scenario each start on a fresh page; the overview shares page one with the title.
      + (ov ? `<div class="rp-group"><h2>Overview</h2>${ov}</div>` : "")
      + (budget ? `<div class="rp-group rp-page"><h2>Budget</h2>${budget}</div>` : "")
      + (scen ? `<div class="rp-group rp-page"><h2>Scenario</h2><p class="rp-note">What-if model as set on the Scenarios tab. Starts from the active budget rows; the budget itself is unchanged.</p>${scen}</div>` : "")
      + (other ? `<div class="rp-group rp-page"><h2>Working less: beyond the money</h2>${other}</div>` : "")
      + (ov || budget || scen || other ? "" : rpEmpty("No sections selected."))
      + `<p class="rp-foot">Figures are planning estimates, converted to monthly amounts: weekly × 52 ÷ 12, every two weeks × 26 ÷ 12, twice a month × 2, quarterly ÷ 3, annual ÷ 12.</p>`;
  }
  // Ctrl+P / the browser's Print menu also gets a current report, using the last selections.
  window.addEventListener("beforeprint", () => buildReport(rptPrefs()));

  const dlg = document.getElementById("rptDlg"), rform = document.getElementById("rptForm"), rgo = document.getElementById("rptGo");
  ["ov","budget","scen","other"].forEach(g => document.getElementById("rptG-" + g).insertAdjacentHTML("beforeend",
    RPT_SECS.filter(x => x[2] === g).map(([k, l]) => `<label class="check"><input class="tog" type="checkbox" name="sec" value="${k}"> ${l}</label>`).join("")));
  const secBoxes = () => [...rform.querySelectorAll('input[name="sec"]')];
  const syncGo = () => { rgo.disabled = !secBoxes().some(c => c.checked); };
  function openReport(){
    const p = rptPrefs();
    rform.elements.rptName.value = p.title;
    rform.elements.rptNotes.value = p.notes;
    rform.elements.rptInactive.checked = p.inactive;
    secBoxes().forEach(c => c.checked = p.secs.includes(c.value));
    syncGo();
    if (typeof dlg.showModal === "function") dlg.showModal();
    else { buildReport(p); window.print(); }
  }
  document.querySelectorAll("[data-report]").forEach(b => b.addEventListener("click", openReport));
  rform.addEventListener("change", syncGo);
  rform.addEventListener("click", e => {
    const q = e.target.closest("[data-pick]"); if (!q) return;
    const g = q.dataset.pick;
    secBoxes().forEach(c => c.checked = g === "all" || RPT_SECS.find(x => x[0] === c.value)[2] === g);
    syncGo();
  });
  document.getElementById("rptCancel").onclick = () => dlg.close();
  rform.addEventListener("submit", e => {
    e.preventDefault();
    const p = {title:rform.elements.rptName.value, notes:rform.elements.rptNotes.value, inactive:rform.elements.rptInactive.checked,
      secs:secBoxes().filter(c => c.checked).map(c => c.value)};
    if (!p.secs.length) return;
    rptSave(p); buildReport(p); dlg.close();
    // Let the dialog close before the print preview takes over.
    setTimeout(() => window.print(), 60);
  });
})();
