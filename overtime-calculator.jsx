import { useState, useCallback } from "react";
import JSZip from "jszip";

/* ──────────────────────────────────────────────
   한국 공휴일 (2025~2026)
────────────────────────────────────────────── */
const HOLIDAYS = new Set([
  "2025-01-01","2025-01-28","2025-01-29","2025-01-30",
  "2025-03-01","2025-05-01","2025-05-05","2025-05-06",
  "2025-06-06","2025-08-15","2025-10-03","2025-10-05",
  "2025-10-06","2025-10-07","2025-10-09","2025-12-25",
  "2026-01-01","2026-02-16","2026-02-17","2026-02-18",
  "2026-03-01","2026-05-01","2026-05-05","2026-06-06",
  "2026-08-15","2026-10-03","2026-10-09","2026-12-25",
]);

const DOW_KO = ["일","월","화","수","목","금","토"];

/* startDate 자정 기준 분 */
function toBaseMinutes(startDate, targetDate, time) {
  const [h, m] = time.split(":").map(Number);
  const dayDiff = Math.round((new Date(targetDate) - new Date(startDate)) / 86400000);
  return dayDiff * 1440 + h * 60 + m;
}

/* 야간 시간(분): 22:00~06:00 */
function nightMins(from, to) {
  let total = 0;
  const maxDay = Math.ceil(to / 1440) + 1;
  for (let n = 0; n <= maxDay; n++) {
    const base = n * 1440;
    total += Math.max(0, Math.min(to, base + 360)  - Math.max(from, base));
    total += Math.max(0, Math.min(to, base + 1440) - Math.max(from, base + 1320));
  }
  return total;
}

/* ──────────────────────────────────────────────
   핵심 계산 함수 (모든 값은 "분" 단위)
────────────────────────────────────────────── */
function calculate(startDate, startTime, endDate, endTime, isHoliday) {
  const d   = new Date(startDate);
  const dow = d.getDay();

  const startM = toBaseMinutes(startDate, startDate, startTime);
  const endM   = toBaseMinutes(startDate, endDate,   endTime);

  if (endM <= startM) return { 연장:0, 휴일초과:0, 야간:0 };

  const isHolidayOrSun = isHoliday || dow === 0;

  let overtimeMins = 0;
  if (isHolidayOrSun) {
    overtimeMins = endM - startM;
  } else {
    const regStart = 9 * 60;
    const regEnd   = dow === 6 ? 12*60+30 : 17*60+30;
    const before   = Math.max(0, Math.min(endM, regStart) - startM);
    const after    = Math.max(0, endM - Math.max(startM, regEnd));
    overtimeMins   = before + after;
  }

  const nightMin = nightMins(startM, endM);

  let 연장M = 0, 휴일초과M = 0;
  if (isHolidayOrSun) {
    if (overtimeMins <= 8*60) { 연장M = overtimeMins; }
    else { 연장M = 8*60; 휴일초과M = overtimeMins - 8*60; }
  } else {
    연장M = overtimeMins;
  }

  return { 연장: 연장M, 휴일초과: 휴일초과M, 야간: nightMin };
}

/* 소수 시간 → "XX시간 XX분" */
function fmtHour(mins) {
  if (!mins) return "";
  const hrs = Math.floor(mins / 60);
  const m   = mins % 60;
  if (hrs === 0) return `${m}분`;
  if (m   === 0) return `${hrs}시간`;
  return `${hrs}시간 ${m}분`;
}

/* "18:00" → "18시 00분" */
function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h}시 ${String(m).padStart(2,"0")}분`;
}

/* 24시 드롭다운 시각 선택 */
function TimePicker({ value, onChange }) {
  const [h, m] = (value || "00:00").split(":").map(Number);
  const set = (nh, nm) => onChange(`${String(nh).padStart(2,"0")}:${String(nm).padStart(2,"0")}`);
  return (
    <div style={{display:"flex",alignItems:"center",gap:4}}>
      <select value={h} onChange={e=>set(+e.target.value,m)} style={{...S.inp,width:64,padding:"9px 4px",textAlign:"center"}}>
        {Array.from({length:24},(_,i)=>i).map(v=><option key={v} value={v}>{v}시</option>)}
      </select>
      <span style={{fontWeight:700,color:"#999"}}>:</span>
      <select value={m} onChange={e=>set(h,+e.target.value)} style={{...S.inp,width:72,padding:"9px 4px",textAlign:"center"}}>
        {Array.from({length:60},(_,i)=>i).map(v=><option key={v} value={v}>{String(v).padStart(2,"0")}분</option>)}
      </select>
    </div>
  );
}

function dateLabel(iso) {
  const d = new Date(iso);
  return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
}

/* ──────────────────────────────────────────────
   ODS 다운로드 (template.ods XML 직접 수정)
────────────────────────────────────────────── */
function escXml(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function odsCell(v, style="ce2") {
  if (!v) return `<table:table-cell table:style-name="${style}"/>`;
  return `<table:table-cell office:value-type="string" table:style-name="${style}"><text:p>${escXml(v)}</text:p></table:table-cell>`;
}

async function downloadODS(entries, year, month, userInfo) {
  const res = await fetch("/template.ods");
  const buf = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  let xml = await zip.file("content.xml").async("string");

  /* ── 1. 신청자 정보 (빈 셀에 값 채우기) ── */
  // B2: 신청부서
  xml = xml.replace(
    /(<text:p>신청부서<\/text:p><\/table:table-cell>)<table:table-cell (table:number-columns-spanned="4" table:number-rows-spanned="1" table:style-name="ce10")\/>/,
    `$1<table:table-cell office:value-type="string" $2><text:p>${escXml(userInfo.department)}</text:p></table:table-cell>`
  );
  // G2: 직급
  xml = xml.replace(
    /(<text:p>직 <text:s text:c="4"\/>급<\/text:p><\/table:table-cell>)<table:table-cell (table:number-columns-spanned="2" table:number-rows-spanned="1" table:style-name="ce10")\/>/,
    `$1<table:table-cell office:value-type="string" $2><text:p>${escXml(userInfo.rank)}</text:p></table:table-cell>`
  );
  // B3: 성명
  xml = xml.replace(
    /(<text:p>성 <text:s text:c="5"\/>명<\/text:p><\/table:table-cell>)<table:table-cell (table:number-columns-spanned="4" table:number-rows-spanned="1" table:style-name="ce10")\/>/,
    `$1<table:table-cell office:value-type="string" $2><text:p>${escXml(userInfo.name)}</text:p></table:table-cell>`
  );
  // G3: 생년월일
  xml = xml.replace(
    /(<text:p>생년월일<\/text:p><\/table:table-cell>)<table:table-cell (table:number-columns-spanned="2" table:number-rows-spanned="1" table:style-name="ce10")\/>/,
    `$1<table:table-cell office:value-type="string" $2><text:p>${escXml(userInfo.birthdate)}</text:p></table:table-cell>`
  );
  // B4: 발생년월
  xml = xml.replace(
    /(<text:p>발생년월<\/text:p><\/table:table-cell>)<table:table-cell (table:number-columns-spanned="7" table:number-rows-spanned="1" table:style-name="ce10")\/>/,
    `$1<table:table-cell office:value-type="string" $2><text:p>${escXml(`${year}년 ${String(month).padStart(2,"0")}월`)}</text:p></table:table-cell>`
  );

  /* ── 2. 데이터 행 (30행: row6~35) 교체 ── */
  const dataRows = [];
  for (let i = 0; i < 30; i++) {
    if (i < entries.length) {
      const e = entries[i];
      dataRows.push(
        `<table:table-row table:style-name="ro4">` +
        odsCell(e.startLabel) + odsCell(e.dow) +
        odsCell(e.isHoliday ? "●" : "") + odsCell(fmtTime(e.startTime)) +
        odsCell(e.startDate !== e.endDate ? e.endLabel : "") +
        odsCell(fmtTime(e.endTime)) + odsCell(e.reason, "ce3") +
        odsCell(fmtHour(e.result.휴일초과)) +
        odsCell(fmtHour(e.result.연장)) +
        odsCell(fmtHour(e.result.야간)) +
        `<table:table-cell table:number-columns-repeated="16374" table:style-name="ce1"/></table:table-row>`
      );
    } else {
      dataRows.push(
        `<table:table-row table:style-name="ro4"><table:table-cell table:number-columns-repeated="10" table:style-name="ce3"/><table:table-cell table:number-columns-repeated="16374" table:style-name="ce1"/></table:table-row>`
      );
    }
  }
  // ro3 = 컬럼 헤더 행, ro5 = 합계 행 → 그 사이 전체 교체
  xml = xml.replace(
    /(<table:table-row table:style-name="ro3">[\s\S]*?<\/table:table-row>)([\s\S]*?)(<table:table-row table:style-name="ro5">)/,
    `$1${dataRows.join("")}$3`
  );

  /* ── 3. 합계 행 (H36·I36·J36) ── */
  const tots = entries.reduce((a,e) => ({
    h: a.h + e.result.휴일초과, o: a.o + e.result.연장, n: a.n + e.result.야간
  }), { h:0, o:0, n:0 });
  xml = xml.replace(
    /<table:table-cell table:style-name="ce5"\/><table:table-cell[^>]*table:style-name="ce6"[^>]*>[\s\S]*?<\/table:table-cell><table:table-cell[^>]*table:style-name="ce7"[^>]*>[\s\S]*?<\/table:table-cell>/,
    odsCell(fmtHour(tots.h), "ce5") + odsCell(fmtHour(tots.o), "ce6") + odsCell(fmtHour(tots.n), "ce7")
  );

  /* ── 4. 신청일 업데이트 ── */
  const now = new Date();
  xml = xml.replace(
    /신청일 : \d{4} 년 <text:s text:c="\d+"\/?>\d{1,2} 월 <text:s text:c="\d+"\/?>\d{1,2} 일/,
    `신청일 : ${now.getFullYear()} 년 <text:s text:c="3"/>${String(now.getMonth()+1).padStart(2," ")} 월 <text:s text:c="5"/>${String(now.getDate()).padStart(2," ")} 일`
  );

  /* ── 5. 재압축 & 다운로드 ── */
  zip.file("content.xml", xml);
  const blob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.oasis.opendocument.spreadsheet",
    compression: "DEFLATE",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `시간외근무_${year}${String(month).padStart(2,"0")}.ods`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

/* ──────────────────────────────────────────────
   메인 컴포넌트
────────────────────────────────────────────── */
const EMPTY = { startDate:"", startTime:"", endDate:"", endTime:"", reason:"", manualHoliday:false };

export default function OvertimeCalc() {
  const today = new Date();
  const [year,    setYear]   = useState(today.getFullYear());
  const [month,   setMonth]  = useState(today.getMonth()+1);
  const [form,    setForm]   = useState(EMPTY);
  const [entries, setEntries]= useState([]);
  const [editId,  setEditId] = useState(null);
  const [userInfo, setUserInfo] = useState({ department:"", rank:"", name:"", birthdate:"" });

  const handleStartDate = useCallback((v) => {
    const dow = new Date(v).getDay();
    setForm(f => ({
      ...f,
      startDate: v,
      endDate: f.endDate || v,
      manualHoliday: dow===0 || HOLIDAYS.has(v),
    }));
  }, []);

  const dayDiff = form.startDate && form.endDate
    ? Math.round((new Date(form.endDate)-new Date(form.startDate))/86400000)
    : 0;

  const addEntry = () => {
    if (!form.startDate||!form.startTime||!form.endDate||!form.endTime) return;
    const result = calculate(form.startDate,form.startTime,form.endDate,form.endTime,form.manualHoliday);
    const d = new Date(form.startDate);
    const entry = {
      id: Date.now(),
      startDate: form.startDate, endDate:  form.endDate,
      startLabel: dateLabel(form.startDate), endLabel: dateLabel(form.endDate),
      dow: DOW_KO[d.getDay()],
      startTime: form.startTime, endTime: form.endTime,
      reason: form.reason, isHoliday: form.manualHoliday, result,
    };
    const sorted = (arr) => arr.sort((a,b)=>a.startDate.localeCompare(b.startDate));
    if (editId!==null) {
      setEntries(prev=>sorted(prev.map(e=>e.id===editId?entry:e)));
      setEditId(null);
    } else {
      setEntries(prev=>sorted([...prev,entry]));
    }
    setForm(EMPTY);
  };

  const startEdit = (e) => {
    setForm({startDate:e.startDate,startTime:e.startTime,endDate:e.endDate,endTime:e.endTime,reason:e.reason,manualHoliday:e.isHoliday});
    setEditId(e.id);
  };
  const deleteEntry = (id) => setEntries(prev=>prev.filter(e=>e.id!==id));
  const cancelEdit  = () => { setEditId(null); setForm(EMPTY); };

  const totals = entries.reduce((acc,e)=>({
    연장:acc.연장+e.result.연장, 휴일초과:acc.휴일초과+e.result.휴일초과, 야간:acc.야간+e.result.야간
  }),{연장:0,휴일초과:0,야간:0});

  const disp = v => fmtHour(v);

  return (
    <div style={S.page}>
      {/* 헤더 */}
      <header style={S.header}>
        <div style={S.headerInner}>
          <div>
            <div style={S.tag}>OVERTIME TRACKER</div>
            <h1 style={S.title}>시간 외 근무 계산기</h1>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
            <div style={S.mpicker}>
              <select value={year} onChange={e=>setYear(+e.target.value)} style={S.sel}>
                {[2024,2025,2026].map(y=><option key={y}>{y}</option>)}
              </select>
              <span style={S.msep}>년</span>
              <select value={month} onChange={e=>setMonth(+e.target.value)} style={S.sel}>
                {Array.from({length:12},(_,i)=>i+1).map(m=><option key={m}>{m}</option>)}
              </select>
              <span style={S.msep}>월</span>
            </div>
            <div style={S.verInfo}>v1.5 &nbsp;·&nbsp; 2026-02-20 updated</div>
          </div>
        </div>
      </header>

      <main style={S.main}>
        {/* 신청자 정보 */}
        <section style={S.card}>
          <h2 style={S.cardTitle}>신청자 정보</h2>
          <div style={{...S.grid, gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", marginBottom:0}}>
            <label style={S.lbl}>
              <span style={S.lbTxt}>신청부서</span>
              <input type="text" value={userInfo.department} placeholder="예: 연구개발부"
                onChange={e=>setUserInfo(u=>({...u,department:e.target.value}))} style={S.inp}/>
            </label>
            <label style={S.lbl}>
              <span style={S.lbTxt}>직급</span>
              <input type="text" value={userInfo.rank} placeholder="예: 연구원"
                onChange={e=>setUserInfo(u=>({...u,rank:e.target.value}))} style={S.inp}/>
            </label>
            <label style={S.lbl}>
              <span style={S.lbTxt}>성명</span>
              <input type="text" value={userInfo.name} placeholder="홍길동"
                onChange={e=>setUserInfo(u=>({...u,name:e.target.value}))} style={S.inp}/>
            </label>
            <label style={S.lbl}>
              <span style={S.lbTxt}>생년월일</span>
              <input type="date" value={userInfo.birthdate}
                onChange={e=>setUserInfo(u=>({...u,birthdate:e.target.value}))} style={S.inp}/>
            </label>
          </div>
        </section>

        {/* 입력 카드 */}
        <section style={S.card}>
          <h2 style={S.cardTitle}>{editId?"✏️ 수정":"근무 입력"}</h2>

          {/* 시작 */}
          <div style={S.sectionLabel}>▶ 시작</div>
          <div style={{...S.grid, marginBottom:8}}>
            <label style={S.lbl}>
              <span style={S.lbTxt}>날짜</span>
              <input type="date" value={form.startDate} onChange={e=>handleStartDate(e.target.value)} style={S.inp}/>
            </label>
            <label style={S.lbl}>
              <span style={S.lbTxt}>시각</span>
              <TimePicker value={form.startTime} onChange={v=>setForm(f=>({...f,startTime:v}))}/>
            </label>
            {form.startDate && (
              <div style={S.badgeBox}>
                <span style={{
                  ...S.badge,
                  ...(new Date(form.startDate).getDay()===0||HOLIDAYS.has(form.startDate)?S.badgeRed:{})
                }}>
                  {DOW_KO[new Date(form.startDate).getDay()]}요일
                  {(new Date(form.startDate).getDay()===0||HOLIDAYS.has(form.startDate))&&" 🔴 자동감지"}
                </span>
              </div>
            )}
          </div>
          <div style={{marginBottom:14}}>
            <label style={S.chkLbl}>
              <input type="checkbox" checked={form.manualHoliday}
                onChange={e=>setForm(f=>({...f,manualHoliday:e.target.checked}))} style={S.chk}/>
              <span>시작날짜 공휴일 / 대체휴일 / 근로자의날</span>
            </label>
          </div>

          {/* 종료 */}
          <div style={S.sectionLabel}>▶ 종료</div>
          <div style={{...S.grid, marginBottom:16}}>
            <label style={S.lbl}>
              <span style={S.lbTxt}>날짜</span>
              <input type="date" value={form.endDate} min={form.startDate||undefined}
                onChange={e=>setForm(f=>({...f,endDate:e.target.value}))} style={S.inp}/>
            </label>
            <label style={S.lbl}>
              <span style={S.lbTxt}>시각</span>
              <TimePicker value={form.endTime} onChange={v=>setForm(f=>({...f,endTime:v}))}/>
            </label>
            {dayDiff>0 && (
              <div style={S.badgeBox}>
                <span style={S.badgeOrange}>+{dayDiff}일 익일 근무 🌙</span>
              </div>
            )}
          </div>

          {/* 사유 */}
          <div style={{marginBottom:16}}>
            <label style={S.lbl}>
              <span style={S.lbTxt}>사유</span>
              <input type="text" value={form.reason} placeholder="업무 사유를 입력하세요"
                onChange={e=>setForm(f=>({...f,reason:e.target.value}))} style={S.inp}/>
            </label>
          </div>

          <div style={S.formBottom}>
            <div style={S.btnRow}>
              {editId && <button onClick={cancelEdit} style={S.btnCancel}>취소</button>}
              <button onClick={addEntry} style={S.btnAdd}>{editId?"저장":"+ 추가"}</button>
            </div>
          </div>
        </section>

        {/* 규칙 안내 */}
        <section style={S.ruleCard}>
          <span style={S.ruleTitle}>계산 규칙</span>
          <span style={S.rule}>🕔 평일 퇴근: 17시 30분 &nbsp;|&nbsp; 토요일 퇴근: 12시 30분 &nbsp;|&nbsp; 야간: 22시 00분~06시 00분</span>
          <span style={S.rule}>📋 공휴일/일요일: 8시간까지 → 연장, 초과분 → 휴일초과</span>
        </section>

        {/* 테이블 */}
        {entries.length>0 && (
          <section style={S.tableWrap}>
            <div style={S.tableTop}>
              <span style={S.tableTitle}>기록 ({entries.length}건)</span>
              <button onClick={()=>downloadODS(entries,year,month,userInfo)} style={S.btnOds}>⬇ ODS 다운로드</button>
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={S.table}>
                <thead>
                  <tr>
                    {["일자","요일","공휴일","시작","종료","사유","휴일초과\n근로시간","연장\n근로시간","야간\n근로시간",""].map((h,i)=>(
                      <th key={i} style={{...S.th,...(i>=6&&i<=8?S.thN:{})}}>
                        {h.split("\n").map((l,j)=><div key={j}>{l}</div>)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e,idx)=>(
                    <tr key={e.id} style={idx%2===0?S.trE:S.trO}>
                      <td style={S.td}>{e.startLabel}</td>
                      <td style={{...S.td,...S.tdC, color:e.dow==="일"||e.isHoliday?"#e53935":"#333"}}>{e.dow}</td>
                      <td style={{...S.td,...S.tdC}}>
                        {e.isHoliday && <span style={S.holiBadge}>공휴일</span>}
                      </td>
                      <td style={{...S.td,...S.tdM}}>{fmtTime(e.startTime)}</td>
                      <td style={{...S.td,...S.tdM}}>
                        {e.startDate!==e.endDate && <span style={S.ndTag}>{e.endLabel} </span>}
                        {fmtTime(e.endTime)}
                      </td>
                      <td style={{...S.td,...S.tdR}}>{e.reason}</td>
                      <td style={{...S.td,...S.tdN,...(e.result.휴일초과?S.nH:{})}}>{disp(e.result.휴일초과)}</td>
                      <td style={{...S.td,...S.tdN,...(e.result.연장?S.nO:{})}}>{disp(e.result.연장)}</td>
                      <td style={{...S.td,...S.tdN,...(e.result.야간?S.nNi:{})}}>{disp(e.result.야간)}</td>
                      <td style={{...S.td,...S.tdAct}}>
                        <button onClick={()=>startEdit(e)} style={S.ibtn}>✏</button>
                        <button onClick={()=>deleteEntry(e.id)} style={S.ibtnD}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={S.tfoot}>
                    <td colSpan={6} style={{...S.td,...S.tdTot}}>합 계</td>
                    <td style={{...S.td,...S.tdN,...S.totN}}>{disp(totals.휴일초과)}</td>
                    <td style={{...S.td,...S.tdN,...S.totN}}>{disp(totals.연장)}</td>
                    <td style={{...S.td,...S.tdN,...S.totN}}>{disp(totals.야간)}</td>
                    <td style={S.td}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        )}

        {entries.length===0 && (
          <div style={S.empty}>
            <div style={{fontSize:48}}>🗓</div>
            <p style={{color:"#9e9e9e",fontSize:14,marginTop:10}}>근무 기록을 추가하면 자동으로 계산됩니다</p>
          </div>
        )}
      </main>

      <footer style={S.footer}>
        <span>Developed by <a href="mailto:pyotel@gmail.com" style={S.footerLink}>Inpyo Cho</a>, <a href="mailto:badger2002@naver.com" style={S.footerLink}>Jaeyoung Lee</a></span>
      </footer>
    </div>
  );
}

/* ── 스타일 ── */
const S = {
  page:{fontFamily:"'Noto Sans KR',sans-serif",background:"#f4f5f7",minHeight:"100vh"},
  header:{background:"#1a237e",color:"#fff"},
  headerInner:{maxWidth:900,margin:"0 auto",padding:"24px 24px 20px",display:"flex",justifyContent:"space-between",alignItems:"flex-end"},
  tag:{fontSize:10,letterSpacing:3,color:"#9fa8da",marginBottom:6,fontWeight:600},
  title:{fontSize:24,fontWeight:700,margin:0,letterSpacing:-0.5},
  mpicker:{display:"flex",alignItems:"center",gap:6,background:"#fff",borderRadius:8,padding:"8px 14px"},
  sel:{background:"#fff",border:"none",color:"#000",fontSize:15,fontWeight:600,cursor:"pointer",outline:"none"},
  msep:{color:"#000",fontSize:13},
  verInfo:{fontSize:10,color:"rgba(255,255,255,0.4)",letterSpacing:0.5},

  main:{maxWidth:900,margin:"0 auto",padding:"24px 16px"},
  card:{background:"#fff",borderRadius:12,padding:24,boxShadow:"0 2px 8px rgba(0,0,0,.08)",marginBottom:16},
  cardTitle:{fontSize:15,fontWeight:700,margin:"0 0 16px",color:"#1a237e"},
  sectionLabel:{fontSize:11,fontWeight:800,color:"#9e9e9e",letterSpacing:1,marginBottom:8},

  grid:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:14},
  lbl:{display:"flex",flexDirection:"column",gap:6},
  lbTxt:{fontSize:11,fontWeight:700,color:"#5c6bc0",textTransform:"uppercase",letterSpacing:0.5},
  inp:{border:"1.5px solid #e0e0e0",borderRadius:7,padding:"9px 12px",fontSize:14,color:"#333",outline:"none"},

  badgeBox:{display:"flex",alignItems:"flex-end",paddingBottom:2},
  badge:{fontSize:12,background:"#e8eaf6",color:"#3949ab",borderRadius:20,padding:"5px 12px",fontWeight:600},
  badgeRed:{background:"#ffebee",color:"#c62828"},
  badgeOrange:{fontSize:12,background:"#fff3e0",color:"#e65100",borderRadius:20,padding:"5px 12px",fontWeight:700},

  formBottom:{display:"flex",alignItems:"center",flexWrap:"wrap",gap:12},
  chkLbl:{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#555",cursor:"pointer"},
  chk:{width:16,height:16,cursor:"pointer"},
  btnRow:{marginLeft:"auto",display:"flex",gap:8},
  btnAdd:{background:"#3f51b5",color:"#fff",border:"none",borderRadius:8,padding:"10px 22px",fontSize:14,fontWeight:700,cursor:"pointer"},
  btnCancel:{background:"#f5f5f5",color:"#666",border:"none",borderRadius:8,padding:"10px 16px",fontSize:14,cursor:"pointer"},

  ruleCard:{background:"#e8eaf6",borderRadius:10,padding:"12px 18px",display:"flex",flexWrap:"wrap",gap:10,alignItems:"center",marginBottom:16},
  ruleTitle:{fontSize:11,fontWeight:800,color:"#3949ab",textTransform:"uppercase",letterSpacing:1},
  rule:{fontSize:12,color:"#3949ab"},

  tableWrap:{background:"#fff",borderRadius:12,boxShadow:"0 2px 8px rgba(0,0,0,.08)",overflow:"hidden"},
  tableTop:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"18px 20px 14px"},
  tableTitle:{fontSize:15,fontWeight:700,color:"#1a237e"},
  btnOds:{background:"#43a047",color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontSize:13,fontWeight:700,cursor:"pointer"},

  table:{width:"100%",borderCollapse:"collapse",fontSize:13},
  th:{background:"#283593",color:"#c5cae9",padding:"10px 12px",textAlign:"left",fontWeight:600,fontSize:12,whiteSpace:"nowrap"},
  thN:{textAlign:"center"},
  trE:{background:"#fff"},trO:{background:"#f8f9ff"},
  td:{padding:"9px 12px",borderBottom:"1px solid #f0f0f0",color:"#333"},
  tdC:{textAlign:"center"},
  tdM:{fontFamily:"'Courier New',monospace",fontSize:13},
  tdR:{fontSize:12,color:"#666",maxWidth:200},
  tdN:{textAlign:"center",fontWeight:600,fontFamily:"'Courier New',monospace"},
  tdAct:{textAlign:"center",whiteSpace:"nowrap"},
  tdTot:{textAlign:"right",fontWeight:700,color:"#1a237e"},

  holiBadge:{fontSize:10,background:"#ffebee",color:"#c62828",borderRadius:4,padding:"2px 6px",fontWeight:700},
  ndTag:{fontSize:10,background:"#fff3e0",color:"#e65100",borderRadius:4,padding:"1px 5px",marginRight:3,fontWeight:700},

  nH:{color:"#c62828",background:"#ffebee",borderRadius:4},
  nO:{color:"#283593",background:"#e8eaf6",borderRadius:4},
  nNi:{color:"#00695c",background:"#e0f2f1",borderRadius:4},

  tfoot:{background:"#e8eaf6"},
  totN:{fontSize:14,color:"#1a237e"},

  ibtn:{background:"none",border:"none",cursor:"pointer",fontSize:14,color:"#9e9e9e",padding:"2px 5px"},
  ibtnD:{background:"none",border:"none",cursor:"pointer",fontSize:13,color:"#ef9a9a",padding:"2px 5px"},

  empty:{textAlign:"center",padding:"60px 0"},

  footer:{textAlign:"center",padding:"24px 16px",color:"#9e9e9e",fontSize:12,borderTop:"1px solid #e0e0e0",marginTop:32},
  footerLink:{color:"#7986cb",textDecoration:"none"},
};
