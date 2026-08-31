'use client';

import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { parseWeeklyLaborXLSX } from './weeklyLaborParser';
import type { WeeklyLaborRow } from './weeklyLaborParser';
import { parseMonthlyBonusXLSX } from './monthlyBonusParser';
import type { MonthlyBonusRow } from './monthlyBonusParser';

function fmt$(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtDate(iso: string) {
  if (!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function excelDate(val: unknown): string {
  if (!val) return '';
  if (val instanceof Date) {
    // Use local date parts to avoid UTC offset issues
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'number') {
    // Excel serial date
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dy = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${dy}`;
  }
  return String(val).split('T')[0];
}

// ─── Employee Directory Upload ─────────────────────────────────────────────────

interface EmployeeRow { fullName: string; location: string; department: string; title: string; payType: 'hourly'|'salary'; hourlyRate: number; annualSalary: number; employmentType: string; }

function parseEmployeesXLSX(file: File): Promise<EmployeeRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target!.result as ArrayBuffer), { type: 'array', cellDates: true });
        const rows = XLSX.utils.sheet_to_json<Record<string,unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        const depts = new Set(['Design','Preservation','Fulfillment','Resin','design','preservation','fulfillment','resin']);
        const parsed = rows
          .filter(r => r['Full name'] && r['Full name'] !== 'All' && depts.has(String(r['Department'] ?? '')))
          .map(r => ({
            fullName:       String(r['Full name']).trim(),
            location:       String(r['Work location name'] ?? ''),
            department:     String(r['Department'] ?? ''),
            title:          String(r['Title'] ?? '').trim(),
            payType:        (r['annual_base_pay'] && Number(r['annual_base_pay']) > 0 ? 'salary' : 'hourly') as 'hourly'|'salary',
            hourlyRate:     parseFloat(String(r['hourly_rate'] ?? '0')) || 0,
            annualSalary:   parseFloat(String(r['annual_base_pay'] ?? '0')) || 0,
            employmentType: String(r['Employment type name'] ?? '').trim(),
          }));
        resolve(parsed);
      } catch (err) { reject(new Error(err instanceof Error ? err.message : JSON.stringify(err))); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ─── Hours Upload ──────────────────────────────────────────────────────────────

interface HoursRow { employee: string; location: string; department: string; date: string; durationHours: number; }

function parseHoursXLSX(file: File): Promise<HoursRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target!.result as ArrayBuffer), { type: 'array', cellDates: true });
        const rows = XLSX.utils.sheet_to_json<Record<string,unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        const depts = new Set(['Design','Preservation','Fulfillment','Resin','design','preservation','fulfillment','resin']);
        const parsed = rows
          .filter(r => r['Employee'] && r['Time entry clock in date'] && depts.has(String(r['Department (Worked)'] ?? '')))
          .map(r => ({
            employee:      String(r['Employee']).trim(),
            location:      String(r['Work location name'] ?? ''),
            department:    String(r['Department (Worked)'] ?? ''),
            date:          excelDate(r['Time entry clock in date']),
            durationHours: parseFloat(String(r['Time entry duration (hours)'] ?? '0')) || 0,
          }))
          .filter(r => r.durationHours > 0 && r.date);
        resolve(parsed);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ─── Payroll CPO Upload ────────────────────────────────────────────────────────

interface PayrollRow { employee: string; department: string; location: string; title: string; hourlyRate: number|null; salary: number|null; grossPay: number; periodStart: string; periodEnd: string; checkDateWeek: string; payRunStatus: string; }

function parsePayrollXLSX(file: File): Promise<PayrollRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb   = XLSX.read(new Uint8Array(e.target!.result as ArrayBuffer), { type: 'array', cellDates: true });
        const rows = XLSX.utils.sheet_to_json<Record<string,unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        const parsed = rows
          .filter(r => {
            const emp  = String(r['Employee'] ?? '');
            const dept = String(r['Department - Most Specific'] ?? '');
            const loc  = String(r['Work location'] ?? '');
            return emp !== 'All' && emp !== '' && dept !== 'All' && loc !== 'All';
          })
          .map(r => ({
            employee:      String(r['Employee']).trim(),
            department:    String(r['Department - Most Specific'] ?? ''),
            location:      String(r['Work location'] ?? ''),
            title:         String(r['Title'] ?? '').trim(),
            hourlyRate:    parseFloat(String(r['Hourly Rate'] ?? '0')) || null,
            salary:        parseFloat(String(r['Salary'] ?? '0')) || null,
            grossPay:      parseFloat(String(r['Employee gross pay'] ?? '0')) || 0,
            periodStart:   excelDate(r['Start date']),
            periodEnd:     excelDate(r['End date']),
            checkDateWeek: String(r['Pay run check date (Year and Week)'] ?? ''),
            payRunStatus:  String(r['Pay run status'] ?? ''),
          }))
          .map(r => {
            // Some rows have no start/end date (e.g. bonus-only rows)
            // Infer a 2-week period from the check date week string if available
            if (!r.periodStart && r.checkDateWeek) {
              // checkDateWeek looks like "Jan 26 2026 - Feb 01 2026"
              // Use it as both start and end as a fallback
              const parts = r.checkDateWeek.split(' - ');
              if (parts.length === 2) {
                const tryParse = (s: string) => { const d = new Date(s); return isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0]; };
                r.periodStart = tryParse(parts[0]) || r.periodStart;
                r.periodEnd   = tryParse(parts[1]) || r.periodEnd;
              }
            }
            return r;
          })
          .filter(r => r.grossPay > 0 && r.periodStart && r.periodEnd);
        resolve(parsed);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ─── Upload Card ───────────────────────────────────────────────────────────────

type UploadType = 'employees' | 'hours' | 'payroll' | 'weeklylabor' | 'bonus';

interface UploadCardProps {
  type:        UploadType;
  title:       string;
  description: string;
  frequency:   string;
  accentColor: string;
}

function UploadCard({ type, title, description, frequency, accentColor }: UploadCardProps) {
  const [status,   setStatus]   = useState<'idle'|'parsing'|'preview'|'uploading'|'done'|'error'>('idle');
  const [preview,  setPreview]  = useState<unknown[] | null>(null);
  const [result,   setResult]   = useState<Record<string,unknown> | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setStatus('parsing'); setErrorMsg(''); setResult(null);
    try {
      let rows: unknown[] = [];
      if (type === 'employees')    rows = await parseEmployeesXLSX(file);
      if (type === 'hours')          rows = await parseHoursXLSX(file);
      if (type === 'payroll')        rows = await parsePayrollXLSX(file);
      if (type === 'weeklylabor')   rows = await parseWeeklyLaborXLSX(file);
      if (type === 'bonus')          rows = await parseMonthlyBonusXLSX(file);
      setPreview(rows);
      setStatus('preview');
    } catch (err) { setErrorMsg(`Parse failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`); setStatus('error'); }
  }

  async function handleUpload() {
    if (!preview) return;
    setStatus('uploading');
    try {
      const endpoint = type === 'employees'  ? '/api/admin/employees-upload'
                     : type === 'hours'      ? '/api/admin/hours-upload'
                     : type === 'weeklylabor' ? '/api/admin/weekly-labor-upload'
                     : type === 'bonus'       ? '/api/admin/monthly-bonus-upload'
                     : '/api/admin/payroll-upload';
      const bodyKey  = type === 'employees' ? 'employees' : 'rows';
      const res  = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [bodyKey]: preview }),
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error) ?? 'Upload failed');
      setResult(data);
      setPreview(null);
      setStatus('done');
    } catch (err) { setErrorMsg(String(err)); setStatus('error'); }
  }

  const previewCount = preview?.length ?? 0;

  return (
    <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
      <div className={`px-5 py-3 border-b border-slate-100 flex items-center justify-between`}>
        <div>
          <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">{description}</p>
        </div>
        <span className={`text-[10px] rounded px-2 py-1 ${accentColor}`}>{frequency}</span>
      </div>
      <div className="p-5 space-y-3">
        {status === 'idle' || status === 'error' ? (
          <>
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-5 text-center cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/20 transition-colors"
              onClick={() => inputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}>
              <div className="text-xl mb-1">📄</div>
              <p className="text-xs font-medium text-slate-600">Drop XLSX here or click to browse</p>
              <input ref={inputRef} type="file" accept=".xlsx,.xls" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
            {status === 'error' && <p className="text-xs text-red-600 bg-red-50 rounded p-2">{errorMsg} <button onClick={() => setStatus('idle')} className="underline ml-2">Retry</button></p>}
          </>
        ) : status === 'parsing' ? (
          <p className="text-xs text-slate-400 text-center py-3">Parsing file…</p>
        ) : status === 'preview' ? (
          <div className="space-y-3">
            <div className="bg-slate-50 rounded-lg px-4 py-3 text-xs text-slate-600">
              <span className="font-semibold">{previewCount}</span> rows ready to upload
              {type === 'employees' && ` (${new Set((preview as EmployeeRow[]).map(r => r.fullName)).size} people)`}
              {type === 'hours'     && ` (${new Set((preview as HoursRow[]).map(r => r.employee)).size} people, ${new Set((preview as HoursRow[]).map(r => r.date.slice(0,7))).size} months)`}
              {type === 'payroll'   && ` (${new Set((preview as PayrollRow[]).map(r => r.employee)).size} people — ${fmt$((preview as PayrollRow[]).reduce((s,r) => s + r.grossPay, 0))} total gross)`}
              {type === 'weeklylabor' && ` (${new Set((preview as WeeklyLaborRow[]).map(r => r.employee)).size} people, ${new Set((preview as WeeklyLaborRow[]).map(r => r.weekOf)).size} weeks — ${fmt$((preview as WeeklyLaborRow[]).reduce((s,r) => s + r.grossPay, 0))} total)`}
              {type === 'bonus' && (() => {
                const rows = preview as MonthlyBonusRow[];
                const skippedCount = rows.filter(r => !r.bonusMonth || !r.checkDate).length;
                const months = new Set(rows.filter(r => r.bonusMonth).map(r => r.bonusMonth)).size;
                return ` (${new Set(rows.map(r => r.employee)).size} people, ${months} months — ${fmt$(rows.reduce((s,r) => s + r.grossPay, 0))} total`
                  + (skippedCount > 0 ? `, ${skippedCount} row${skippedCount === 1 ? '' : 's'} will be skipped — unrecognized pay run name)` : ')');
              })()}
            </div>
            <div className="flex gap-2">
              <button onClick={handleUpload} className="px-4 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
                Upload {previewCount} rows
              </button>
              <button onClick={() => { setPreview(null); setStatus('idle'); if (inputRef.current) inputRef.current.value = ''; }}
                className="px-3 py-1.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">
                Cancel
              </button>
            </div>
          </div>
        ) : status === 'uploading' ? (
          <p className="text-xs text-slate-400 text-center py-3">Uploading…</p>
        ) : status === 'done' && result ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-green-700 text-sm font-medium">
              <span>✓</span> Upload successful
            </div>
            <div className="bg-green-50 rounded-lg px-4 py-3 text-xs text-slate-600 space-y-1">
              {type === 'employees' && <>
                <p><span className="font-medium">{String(result.inserted)}</span> employees synced to directory</p>
              </>}
              {type === 'hours' && <>
                <p><span className="font-medium">{String(result.people)}</span> people · <span className="font-medium">{String(result.upserted)}</span> week entries updated</p>
                {result.weeks && <p>Weeks: {fmtDate(String((result.weeks as {from:string}).from))} – {fmtDate(String((result.weeks as {to:string}).to))}</p>}
                <p>Total hours: <span className="font-medium">{String(result.totalHours)}</span></p>
              </>}
              {type === 'payroll' && <>
                <p><span className="font-medium">{String(result.people)}</span> people · <span className="font-medium">{String(result.inserted)}</span> pay records</p>
                {result.dateRange && <p>Period: {fmtDate(String((result.dateRange as {from:string}).from))} – {fmtDate(String((result.dateRange as {to:string}).to))}</p>}
                <p>Total gross: <span className="font-medium">{fmt$(Number(result.totalGross))}</span></p>
              </>}
              {type === 'bonus' && <>
                <p><span className="font-medium">{String(result.inserted)}</span> bonus records saved
                  {Number(result.skipped) > 0 && <span className="text-amber-600"> · {String(result.skipped)} skipped (unrecognized pay run name)</span>}
                </p>
                {result.dateRange && <p>Months: {fmtDate(String((result.dateRange as {from:string}).from))} – {fmtDate(String((result.dateRange as {to:string}).to))}</p>}
                <p>Total gross: <span className="font-medium">{fmt$(Number(result.totalGross))}</span></p>
                {Array.isArray(result.unmatched) && result.unmatched.length > 0 && (
                  <div className="bg-amber-50 text-amber-800 rounded p-2 mt-1">
                    <p className="font-medium">{result.unmatched.length} row(s) excluded from department/location CPO totals until fixed:</p>
                    <ul className="list-disc list-inside">
                      {(result.unmatched as {employee:string; grossPay:number; reason?:string}[]).map((u, i) => (
                        <li key={`${u.employee}-${i}`}>{u.employee} — {fmt$(u.grossPay)}{u.reason ? ` (${u.reason})` : ''}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>}
            </div>
            <button onClick={() => { setStatus('idle'); setResult(null); if (inputRef.current) inputRef.current.value = ''; }}
              className="text-xs text-indigo-600 hover:text-indigo-800">Upload another file</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Main Export ───────────────────────────────────────────────────────────────

export function PayrollUploadPanel() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-1">Data Uploads</h2>
        <p className="text-xs text-slate-400">These uploads power accurate CPO calculations and keep the employee directory current. Pay details are stored securely and never shown to team members.</p>
      </div>

      <UploadCard
        type="employees"
        title="Active Employee Directory"
        description='Upload "Active Employees with Hourly and Annual Base Pay" from Rippling. Updates pay rates, titles, and roles for all production staff.'
        frequency="as needed"
        accentColor="bg-slate-100 text-slate-500"
      />

      <UploadCard
        type="hours"
        title="Weekly Hours — Master Calc Time"
        description='Upload "Weekly Master Calc Time_Final Draft" from Rippling. Populates actual hours worked per person per week for each department.'
        frequency="weekly"
        accentColor="bg-blue-50 text-blue-600"
      />

      <UploadCard
        type="payroll"
        title="Payroll CPO Upload"
        description='Upload "App dashboard upload for CPO" from Rippling. Actual gross pay per person per pay period — used for green CPO in historicals.'
        frequency="bi-weekly"
        accentColor="bg-green-50 text-green-700"
      />
      <UploadCard
        type="weeklylabor"
        title="Weekly Labor Cost by Location & Department"
        description='Upload "Weekly_Earnings_by_Location__Department" from Rippling. Used for accurate CPO calculations — includes G&A allocation and salary manager costs.'
        frequency="weekly"
        accentColor="bg-green-50 text-green-700"
      />
      <UploadCard
        type="bonus"
        title="Monthly Bonus Upload"
        description='Upload the monthly bonus payroll report from Rippling. Per-employee bonus payouts are matched to the Employee Directory by name to attribute cost to department/location for the "Incl. Bonus" toggle on the Monthly CPO view. Paid ~monthly, 3-4 weeks after the month earned.'
        frequency="~monthly"
        accentColor="bg-amber-50 text-amber-700"
      />
    </div>
  );
}

// Keep old export for backward compatibility
export { PayrollUploadPanel as RipplingUpload };
