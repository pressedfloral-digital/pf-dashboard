'use client';

import { useEffect, useState } from 'react';

export interface BloomUpdateRow {
  weekOf: string;
  weeksUntilDesigned: number;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function fmtLongDate(iso: string): string {
  const d = new Date(iso + (iso.includes('T') ? '' : 'T12:00:00'));
  const month = d.toLocaleDateString('en-US', { month: 'long' });
  return `${month} ${ordinal(d.getDate())}, ${d.getFullYear()}`;
}

// "April 27th - May 3rd" — full month spelled out on both ends, even when
// the week doesn't cross a month boundary, matching the reference format.
function fmtWeekRange(weekOfIso: string): string {
  const start = new Date(weekOfIso + 'T12:00:00');
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const startStr = `${start.toLocaleDateString('en-US', { month: 'long' })} ${ordinal(start.getDate())}`;
  const endStr = `${end.toLocaleDateString('en-US', { month: 'long' })} ${ordinal(end.getDate())}`;
  return `${startStr} - ${endStr}`;
}

function fmtWeeksUntil(n: number): string {
  if (n <= 0) return 'This week';
  return `${n} week${n === 1 ? '' : 's'}`;
}

// ─── Canvas PNG renderer — mirrors the on-screen preview table exactly ──────────
function drawBloomUpdateCanvas(sentAt: string, rows: BloomUpdateRow[]): HTMLCanvasElement {
  const scale = 2; // render at 2x for a crisp download
  const width = 760;
  const rowHeight = 52;
  const headerHeight = 74;
  const titleHeight = 90;
  const padX = 60;
  const height = titleHeight + headerHeight + rows.length * rowHeight + 40;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#2b2b26';
  ctx.textBaseline = 'middle';

  // Title — letter-spaced serif caps, centered
  const title = fmtLongDate(sentAt).toUpperCase();
  ctx.font = '20px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'left';
  let titleWidth = 0;
  for (const ch of title) titleWidth += ctx.measureText(ch).width + 4;
  let x = (width - titleWidth) / 2;
  const titleY = titleHeight / 2 + 8;
  for (const ch of title) {
    ctx.fillText(ch, x, titleY);
    x += ctx.measureText(ch).width + 4;
  }

  const tableTop = titleHeight;
  const tableLeft = padX;
  const tableWidth = width - padX * 2;
  const colSplit = tableLeft + tableWidth * 0.42;
  const tableBottom = tableTop + headerHeight + rows.length * rowHeight;

  ctx.strokeStyle = '#2b2b26';
  ctx.lineWidth = 1;

  // Outer border
  ctx.strokeRect(tableLeft, tableTop, tableWidth, tableBottom - tableTop);
  // Column divider
  ctx.beginPath();
  ctx.moveTo(colSplit, tableTop);
  ctx.lineTo(colSplit, tableBottom);
  ctx.stroke();
  // Header/body divider
  ctx.beginPath();
  ctx.moveTo(tableLeft, tableTop + headerHeight);
  ctx.lineTo(tableLeft + tableWidth, tableTop + headerHeight);
  ctx.stroke();

  function wrapText(text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Header text — italic serif, centered, wraps within its column
  ctx.font = 'italic 15px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  const col1Center = (tableLeft + colSplit) / 2;
  const col2Center = (colSplit + tableLeft + tableWidth) / 2;
  const col1Lines = wrapText('Blooms Delivered the Week of:', colSplit - tableLeft - 24);
  const col2Lines = wrapText('Estimated remaining time until a design photo is uploaded:', tableLeft + tableWidth - colSplit - 24);
  const headerLineHeight = 20;
  const col1StartY = tableTop + headerHeight / 2 - ((col1Lines.length - 1) * headerLineHeight) / 2;
  const col2StartY = tableTop + headerHeight / 2 - ((col2Lines.length - 1) * headerLineHeight) / 2;
  col1Lines.forEach((line, i) => ctx.fillText(line, col1Center, col1StartY + i * headerLineHeight));
  col2Lines.forEach((line, i) => ctx.fillText(line, col2Center, col2StartY + i * headerLineHeight));

  // Data rows — normal serif, centered
  ctx.font = '15px Georgia, "Times New Roman", serif';
  rows.forEach((row, i) => {
    const rowTop = tableTop + headerHeight + i * rowHeight;
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(tableLeft, rowTop);
      ctx.lineTo(tableLeft + tableWidth, rowTop);
      ctx.stroke();
    }
    const rowCenterY = rowTop + rowHeight / 2;
    ctx.fillText(fmtWeekRange(row.weekOf), col1Center, rowCenterY);
    ctx.fillText(fmtWeeksUntil(row.weeksUntilDesigned), col2Center, rowCenterY);
  });

  return canvas;
}

export function downloadBloomUpdatePNG(sentAt: string, rows: BloomUpdateRow[], location: string) {
  const canvas = drawBloomUpdateCanvas(sentAt, rows);
  const url = canvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `bloom-update-${location.toLowerCase()}-${sentAt.slice(0, 10)}.png`;
  a.click();
}

// ─── Copy-paste HTML for the biweekly email (Klaviyo table block) ───────────────
// Buffers only affect this generated markup — they never touch the
// locked-in promise (`rows` itself is read-only here).
export function generateBloomEmailHtml(rows: BloomUpdateRow[], buffers: Record<string, number>): string {
  const rowsHtml = rows.map(row => {
    const buffered = row.weeksUntilDesigned + (buffers[row.weekOf] ?? 0);
    return `<tr>
<td class="kl-table-subblock" style="width:auto;overflow:hidden;border-right:solid 1px #756A64;border-top:solid 1px #756A64;vertical-align:top;padding-top:5px;padding-right:10px;padding-bottom:5px;padding-left:10px;">
<div style="font-family:Times New Roman;font-size:14px;font-style:normal;font-weight:400;letter-spacing:0px;line-height:1.3;text-align:left;color:#222222;"><div style="text-align: center;"><span style="font-weight: 300; font-family: Brandongrotesquelight, 'New York', TimesNewRoman, 'Times New Roman', Times, Baskerville, Georgia, serif; color: #756a64; font-size: 20px;">${fmtWeekRange(row.weekOf)}</span></div></div>
</td>
<td class="kl-table-subblock" style="width:auto;overflow:hidden;border-top:solid 1px #756A64;vertical-align:top;padding-top:5px;padding-right:10px;padding-bottom:5px;padding-left:10px;">
<div style="font-family:Times New Roman;font-size:14px;font-style:normal;font-weight:400;letter-spacing:0px;line-height:1.3;text-align:left;color:#222222;"><div style="text-align: center;"><span style="font-weight: 300; font-family: Brandongrotesquelight, 'New York', TimesNewRoman, 'Times New Roman', Times, Baskerville, Georgia, serif; color: #756a64; font-size: 20px;">${fmtWeeksUntil(buffered)}</span></div></div>
</td>
</tr>`;
  }).join('\n');

  return `<tr>
<td style="font-size:0px;word-break:break-word;">
<div class="mj-column-per-100 mj-outlook-group-fix component-wrapper" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;">
<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="table-layout:fixed;" width="100%">
<tbody>
<tr>
<td class="" style="background-color:#FFFFFF;vertical-align:top;padding-top:10px;padding-right:10px;padding-bottom:10px;padding-left:10px;">
<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="" width="100%">
<tbody>
<tr>
<td align="left" class="kl-table" style="font-size:0px;padding:0px;word-break:break-word;">
<table border="0" cellpadding="0" cellspacing="0" style="color:#000000;font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:13px;line-height:22px;table-layout:fixed;width:100%;border:solid 2px #756A64;" width="100%">
<thead>
<tr>
<th class="kl-table-subblock" style="width:auto;overflow:hidden;padding-top:8px;padding-right:0px;padding-bottom:8px;padding-left:0px;">
<div style="font-family: SpectralBold, TimesNewRoman, 'Times New Roman', Times, Baskerville, Georgia, serif; font-weight: bold; color: #f9f6f2; font-size: 15px serif;font-size:15px;font-style:italic;font-weight:300;letter-spacing:0px;line-height:1.3;text-align:center;color:#756A64;">Blooms Delivered the Week of:</div>
</th>
<th class="kl-table-subblock" style="width:auto;overflow:hidden;padding-top:8px;padding-right:0px;padding-bottom:8px;padding-left:0px;">
<div style="font-family:'SpectralLight', TimesNewRoman, 'Times New Roman', Times, Baskerville, Georgia, serif;font-size:15px;font-style:italic;font-weight:300;letter-spacing:0px;line-height:1.3;text-align:center;color:#756A64;">Estimated remaining time until a design photo is uploaded:</div>
</th>
</tr>
</thead>
<tbody>
${rowsHtml}
</tbody></table></td></tr></tbody></table></td>
</tr>
`;
}

// ─── Panel that builds the copy-paste email HTML (buffer + live preview) ────────
function BloomEmailExportPanel({ rows }: { rows: BloomUpdateRow[] }) {
  const [buffers, setBuffers] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(200);
  // Regenerated whenever the buffer controls change, but freely hand-editable
  // in between — the live preview below always reflects exactly what's in
  // this box, generated or hand-edited.
  const [html, setHtml] = useState(() => generateBloomEmailHtml(rows, buffers));

  useEffect(() => {
    setHtml(generateBloomEmailHtml(rows, buffers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, buffers]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const previewDoc = `<!DOCTYPE html><html><body style="margin:0;padding:16px;background:#f4f4f4;box-sizing:border-box;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;">` +
    `<tbody>${html}</tbody></table></body></html>`;

  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-3 bg-slate-50">
      <div>
        <label className="text-[11px] font-medium text-slate-500">
          Buffer per week <span className="text-slate-400 font-normal">— only changes what the client email shows; the ops dashboard&apos;s production goals stay set to the real promise</span>
        </label>
        <div className="mt-1 max-h-40 overflow-y-auto border border-slate-200 rounded divide-y divide-slate-100 bg-white">
          {rows.map(row => (
            <div key={row.weekOf} className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
              <span className="text-slate-600">
                {fmtWeekRange(row.weekOf)} <span className="text-slate-400">({fmtWeeksUntil(row.weeksUntilDesigned)})</span>
              </span>
              <select
                value={buffers[row.weekOf] ?? 0}
                onChange={e => setBuffers(b => ({ ...b, [row.weekOf]: Number(e.target.value) }))}
                className="text-xs border border-slate-200 rounded px-1 py-0.5"
              >
                <option value={0}>+0</option>
                <option value={1}>+1 wk</option>
                <option value={2}>+2 wk</option>
                <option value={3}>+3 wk</option>
              </select>
            </div>
          ))}
        </div>
      </div>
      <div>
        <label className="text-[11px] font-medium text-slate-500">Preview</label>
        <iframe
          title="Email HTML preview"
          srcDoc={previewDoc}
          sandbox="allow-same-origin"
          onLoad={e => {
            const doc = (e.target as HTMLIFrameElement).contentDocument;
            if (!doc) return;
            // getBoundingClientRect reflects the body's actual laid-out
            // height from its content alone — unlike scrollHeight, it isn't
            // floored at the iframe's own current height, so this measures
            // correctly whether the content just grew or shrank.
            setPreviewHeight(Math.ceil(doc.body.getBoundingClientRect().height) + 20);
          }}
          style={{ height: previewHeight }}
          className="mt-1 w-full border border-slate-200 rounded bg-white block"
        />
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-[11px] font-medium text-slate-500">
            Email HTML <span className="text-slate-400 font-normal">— edit directly, the preview above updates as you type</span>
          </label>
          <button onClick={handleCopy} className="text-[11px] px-2 py-1 bg-indigo-600 rounded text-white hover:bg-indigo-700">
            {copied ? 'Copied!' : 'Copy to clipboard'}
          </button>
        </div>
        <textarea
          value={html}
          onChange={e => setHtml(e.target.value)}
          rows={6}
          className="w-full text-[10px] font-mono border border-slate-200 rounded px-2 py-1.5 bg-white"
        />
        <p className="mt-1 text-[10px] text-amber-700">
          ⚠ Before pasting, clear out whatever&apos;s already in that email block — pasting into a block that still has an old table will leave both.
        </p>
      </div>
    </div>
  );
}

// ─── On-screen preview table — visually mirrors the PNG ─────────────────────────
function BloomTablePreview({ sentAt, rows }: { sentAt: string; rows: BloomUpdateRow[] }) {
  return (
    <div className="bg-white px-2 py-4" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>
      <div className="text-center text-[15px] tracking-[0.25em] text-stone-800 mb-5">
        {fmtLongDate(sentAt).toUpperCase()}
      </div>
      <table className="w-full border-collapse border border-stone-800 text-[13px] text-stone-800">
        <thead>
          <tr>
            <th className="border-r border-b border-stone-800 px-3 py-3 italic font-normal w-[42%]">Blooms Delivered the Week of:</th>
            <th className="border-b border-stone-800 px-3 py-3 italic font-normal">Estimated remaining time until a design photo is uploaded:</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.weekOf}>
              <td className={`border-r border-stone-800 px-3 py-2.5 text-center ${i > 0 ? 'border-t' : ''}`}>{fmtWeekRange(row.weekOf)}</td>
              <td className={`px-3 py-2.5 text-center ${i > 0 ? 'border-t border-stone-800' : ''}`}>{fmtWeeksUntil(row.weeksUntilDesigned)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Preview → confirm → locked-in modal ─────────────────────────────────────────
export function BloomUpdateModal({ rows, location, onClose, onConfirmed }: {
  rows: BloomUpdateRow[];
  location: string;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [stage, setStage] = useState<'preview' | 'locking' | 'locked' | 'error'>('preview');
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [showEmailExport, setShowEmailExport] = useState(false);

  async function handleConfirm() {
    setStage('locking');
    try {
      const promiseRes = await fetch('/api/design-promises', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, cohorts: rows.map(r => ({ weekOf: r.weekOf, weeksFromNow: r.weeksUntilDesigned })) }),
      });
      if (!promiseRes.ok) throw new Error('Failed to lock in the promise');

      const updateRes = await fetch('/api/bloom-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, rows }),
      });
      if (!updateRes.ok) throw new Error('Failed to save the update record');
      const { update } = await updateRes.json() as { update: { id: number; sent_at: string } };

      setSentAt(update.sent_at);
      setStage('locked');
      onConfirmed();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  }

  const displaySentAt = sentAt ?? new Date().toISOString();

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden my-8">
        <div className="px-5 pt-4">
          <h3 className="text-sm font-semibold text-slate-700">
            {stage === 'locked' ? 'Biweekly bloom update sent' : 'Send biweekly bloom update'}
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {stage === 'preview' && `This is exactly what will be locked in as the client-facing promise for ${location}.`}
            {stage === 'locking' && 'Locking in…'}
            {stage === 'locked' && 'Locked in and saved to history — download the image to send to clients.'}
            {stage === 'error' && errorMsg}
          </p>
        </div>
        {!showEmailExport && (
          <div className="border-y border-slate-100 my-3">
            <BloomTablePreview sentAt={displaySentAt} rows={rows} />
          </div>
        )}
        {(stage === 'preview' || stage === 'locked') && (
          <div className="px-5 pb-3">
            <button
              onClick={() => setShowEmailExport(v => !v)}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
            >
              {showEmailExport ? 'Hide email HTML' : 'Get email HTML →'}
            </button>
            {showEmailExport && (
              <div className="mt-2">
                <BloomEmailExportPanel rows={rows} />
              </div>
            )}
          </div>
        )}
        <div className="px-5 pb-4 flex items-center justify-end gap-2">
          {stage === 'preview' && showEmailExport && (
            <>
              <span className="text-[11px] text-slate-400 mr-auto">Locking in sets the ops dashboard&apos;s production goals to these promises — without the buffers added for the client email.</span>
              <button onClick={() => setShowEmailExport(false)} className="text-xs px-3 py-1.5 border border-slate-200 rounded text-slate-600 hover:bg-slate-50">
                ← Back to review &amp; confirm
              </button>
            </>
          )}
          {stage === 'preview' && !showEmailExport && (
            <>
              <button onClick={onClose} className="text-xs px-3 py-1.5 border border-slate-200 rounded text-slate-600 hover:bg-slate-50">Cancel</button>
              <button onClick={handleConfirm} className="text-xs px-3 py-1.5 bg-indigo-600 rounded text-white hover:bg-indigo-700">Confirm &amp; lock in</button>
            </>
          )}
          {stage === 'locking' && (
            <button disabled className="text-xs px-3 py-1.5 bg-indigo-300 rounded text-white">Locking in…</button>
          )}
          {stage === 'locked' && (
            <>
              <button onClick={onClose} className="text-xs px-3 py-1.5 border border-slate-200 rounded text-slate-600 hover:bg-slate-50">Close</button>
              <button onClick={() => downloadBloomUpdatePNG(displaySentAt, rows, location)} className="text-xs px-3 py-1.5 bg-indigo-600 rounded text-white hover:bg-indigo-700">Download PNG</button>
            </>
          )}
          {stage === 'error' && (
            <>
              <button onClick={onClose} className="text-xs px-3 py-1.5 border border-slate-200 rounded text-slate-600 hover:bg-slate-50">Close</button>
              <button onClick={handleConfirm} className="text-xs px-3 py-1.5 bg-indigo-600 rounded text-white hover:bg-indigo-700">Retry</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── History of everything ever sent ─────────────────────────────────────────────
export function BloomHistoryModal({ updates, loading, location, onClose }: {
  updates: { id: number; sent_at: string; rows: BloomUpdateRow[] }[];
  loading: boolean;
  location: string;
  onClose: () => void;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full overflow-hidden max-h-[80vh] flex flex-col">
        <div className="px-5 pt-4 pb-3 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Past biweekly bloom updates — {location}</h3>
            <p className="text-xs text-slate-400 mt-0.5">Every update that&apos;s been locked in and sent, oldest promises never shown twice.</p>
          </div>
          <button onClick={onClose} className="text-xs px-2.5 py-1 border border-slate-200 rounded text-slate-500 hover:bg-slate-50 shrink-0">Close</button>
        </div>
        <div className="overflow-y-auto px-5 py-3 space-y-2">
          {loading && <p className="text-xs text-slate-400 py-6 text-center">Loading…</p>}
          {!loading && updates.length === 0 && <p className="text-xs text-slate-400 py-6 text-center">No bloom updates sent yet.</p>}
          {!loading && updates.map(u => (
            <div key={u.id} className="border border-slate-100 rounded-lg px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm text-slate-700 font-medium">{fmtLongDate(u.sent_at)}</div>
                  <div className="text-[11px] text-slate-400">{u.rows.length} cohort{u.rows.length === 1 ? '' : 's'}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => setExpandedId(id => id === u.id ? null : u.id)}
                    className="text-xs px-2.5 py-1 border border-slate-200 rounded text-slate-600 hover:bg-slate-50">
                    {expandedId === u.id ? 'Hide email HTML' : 'Get email HTML'}
                  </button>
                  <button
                    onClick={() => downloadBloomUpdatePNG(u.sent_at, u.rows, location)}
                    className="text-xs px-2.5 py-1 border border-indigo-200 bg-indigo-50 rounded text-indigo-700 hover:bg-indigo-100">
                    Download PNG
                  </button>
                </div>
              </div>
              {expandedId === u.id && (
                <div className="mt-2">
                  <BloomEmailExportPanel rows={u.rows} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
