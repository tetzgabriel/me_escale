// =====================================================================
// Exportação da escala no formato "feito à mão" usado pelas turmas:
// uma grade por semana (SEM 1, SEM 2, ...), dias lado a lado, cada atividade
// como um cartão com faixa lateral colorida (Plantão / Manhã / Tarde / Noite),
// e um "Balanço" com as horas por aluno.
//
// Um único layout (layoutSchedule) alimenta três saídas, para todas mostrarem
// exatamente os mesmos dados:
//   - buildScheduleWorkbook  → arquivo .xlsx (ExcelJS)
//   - buildPrintHtml         → PDF / impressão (uma página paisagem por semana)
//   - buildSheetsClipboard   → HTML para colar no Google Sheets
//
// Puro (sem DOM): roda no navegador e no Node.
// =====================================================================

const SCHEDULE_COLORS = {
    plantao: 'B6D7A8', manha: 'FFE599', tarde: 'EA9999', noite: 'A4C2F4',
    blackout: 'FFFF00', outside: 'EFEFEF', header: 'D9D9D9', vago: 'C00000', muted: '808080'
};

function layoutSchedule({ finalSchedule, config, students }) {
    config = config || {};
    const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const DAY_SHORT_PT = {
        Monday: 'Segunda', Tuesday: 'Terça', Wednesday: 'Quarta', Thursday: 'Quinta',
        Friday: 'Sexta', Saturday: 'Sábado', Sunday: 'Domingo'
    };
    const C = SCHEDULE_COLORS;

    // ---------- Helpers de data/hora ----------
    const parse = (s) => new Date(s + 'T00:00:00');
    const toStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return toStr(d); };
    const weekdayOf = (s) => WEEKDAYS[(parse(s).getDay() + 6) % 7];
    const mondayOf = (s) => addDays(s, -((parse(s).getDay() + 6) % 7));
    const fmtDate = (s) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };      // dd/mm/aaaa
    const fmtHour = (t) => {                                                                   // 24h HH:MM
        if (!t) return '';
        const [h, m] = String(t).split(':').map(Number);
        return `${String(h || 0).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;
    };
    const isBlackout = (s) => (config.blackoutPeriods || []).some(p => s >= p.start && s <= (p.end || p.start));
    const isPlantao = (t) => !t || String(t).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim() === 'PLANTAO';
    const periodOf = (act) => {
        if (isPlantao(act.type)) return { label: 'Plantão', fill: C.plantao };
        const h = Number((act.startTime || '0').split(':')[0]);
        if (h < 12) return { label: 'Manhã', fill: C.manha };
        if (h < 18) return { label: 'Tarde', fill: C.tarde };
        return { label: 'Noite', fill: C.noite };
    };
    const slotOrder = (a, b) =>
        (isPlantao(b.activity.type) - isPlantao(a.activity.type)) ||
        (a.activity.startTime || '').localeCompare(b.activity.startTime || '') ||
        (a.activity.name || '').localeCompare(b.activity.name || '');

    // ---------- Dados ----------
    const schedule = Array.isArray(finalSchedule) ? finalSchedule : [];
    const byDate = {};
    schedule.forEach(day => { byDate[day.date] = [...(day.slots || [])].sort(slotOrder); });

    const startDate = config.startDate || (schedule[0] && schedule[0].date);
    const endDate = config.endDate || (schedule.length && schedule[schedule.length - 1].date);
    if (!startDate || !endDate) throw new Error('Período da escala não definido.');

    // Só mostra colunas para dias da semana que têm alguma atividade na escala
    const usedWeekdays = new Set(schedule.filter(d => d.slots && d.slots.length).map(d => weekdayOf(d.date)));
    let shownDays = WEEKDAYS.filter(w => usedWeekdays.has(w));
    if (shownDays.length === 0) shownDays = WEEKDAYS.slice(0, 5);

    // Altura uniforme dos cartões (alinha as linhas entre os dias, como na planilha manual)
    let maxCapacity = 0;
    schedule.forEach(d => (d.slots || []).forEach(s => {
        maxCapacity = Math.max(maxCapacity, Number(s.activity.studentsCount) || 0, (s.assigned || []).length);
    }));
    const studentRows = Math.max(2, Math.ceil(maxCapacity / 2));
    const CARD_H = 3 + studentRows;

    const mondays = [];
    for (let mon = mondayOf(startDate); mon <= endDate; mon = addDays(mon, 7)) mondays.push(mon);

    // Colunas: 1 = margem; por dia: faixa, nome/rótulo, valor 1, valor 2, espaço
    const colWidths = [null, 2];
    shownDays.forEach(() => colWidths.push(4.5, 16, 9, 9, 3));
    const HDR = 2;              // linha do nome do dia (linha 1 = margem)
    const FIRST = HDR + 2;      // primeira linha de cartões

    const weeks = mondays.map((monday, wi) => {
        const cells = [];
        const add = (cell) => { cells.push(Object.assign({ rs: 1, cs: 1, edges: { t: 1, b: 1, l: 1, r: 1 } }, cell)); };
        let maxCards = 1;
        const days = shownDays.map(w => addDays(monday, WEEKDAYS.indexOf(w)));

        shownDays.forEach((weekday, di) => {
            const date = days[di];
            const base = 2 + di * 5;
            const c1 = base + 1, c2 = base + 2, c3 = base + 3;

            add({ r: HDR, c: c1, cs: 3, v: DAY_SHORT_PT[weekday], bold: true, fill: C.header });
            add({ r: HDR + 1, c: c1, cs: 3, v: fmtDate(date), bold: true, text: true });

            const inRange = date >= startDate && date <= endDate;
            const slots = byDate[date] || [];
            if (!inRange || slots.length === 0) {
                add({
                    r: FIRST, c: c1, rs: CARD_H, cs: 3,
                    v: !inRange ? 'Fora do período' : (isBlackout(date) ? 'Sem atividades' : '—'),
                    size: inRange ? 14 : 11, italic: !inRange,
                    fill: inRange ? C.blackout : C.outside, color: inRange ? null : C.muted
                });
                return;
            }

            maxCards = Math.max(maxCards, slots.length);
            slots.forEach((slot, si) => {
                const act = slot.activity;
                const r0 = FIRST + si * (CARD_H + 1);
                const period = periodOf(act);

                add({ r: r0, c: base, rs: CARD_H, v: period.label, bold: true, fill: period.fill, rotate: true });

                add({ r: r0, c: c1, v: 'Horário', bold: true });
                add({ r: r0, c: c2, v: fmtHour(act.startTime), text: true });
                add({ r: r0, c: c3, v: fmtHour(act.endTime), text: true });

                const loc = (act.location || '').trim();
                const name = (act.name || '').trim();
                if (!loc || loc.toUpperCase() === name.toUpperCase()) {
                    add({ r: r0 + 1, c: c1, cs: 3, v: name || loc });
                } else {
                    add({ r: r0 + 1, c: c1, v: loc });
                    add({ r: r0 + 1, c: c2, cs: 2, v: name });
                }

                add({ r: r0 + 2, c: c1, v: 'Horas', bold: true });
                add({ r: r0 + 2, c: c2, cs: 2, v: Number(act.hoursCount) || 0 });

                // Alunos em duas colunas, sem linhas horizontais internas
                const names = slot.assigned || [];
                for (let k = 0; k < studentRows; k++) {
                    const r = r0 + 3 + k;
                    const edges = { t: k === 0 ? 1 : 0, b: k === studentRows - 1 ? 1 : 0, l: 1, r: 1 };
                    const left = names[k * 2] || '';
                    const vago = names.length === 0 && k === 0;
                    add({ r, c: c1, v: vago ? '(vago)' : left, align: 'left', edges, italic: vago, color: vago ? C.vago : null });
                    add({ r, c: c2, cs: 2, v: names[k * 2 + 1] || '', align: 'left', edges });
                }
            });
        });

        const firstShown = days.find(d => d >= startDate && d <= endDate) || days[0];
        const lastShown = [...days].reverse().find(d => d >= startDate && d <= endDate) || days[days.length - 1];
        return {
            name: `SEM ${wi + 1}`,
            title: `Semana ${wi + 1} · ${firstShown === lastShown ? fmtDate(firstShown) : `${fmtDate(firstShown)} a ${fmtDate(lastShown)}`}`,
            colWidths,
            nCols: colWidths.length - 1,
            nRows: FIRST + maxCards * (CARD_H + 1) - 1,
            headerRows: [HDR, HDR + 1],
            // Grupos de linhas que não devem ser quebrados entre páginas (um "andar" de cartões cada)
            groups: Array.from({ length: maxCards }, (_, k) => ({ from: FIRST + k * (CARD_H + 1), to: FIRST + k * (CARD_H + 1) + CARD_H })),
            cells
        };
    });

    // ---------- Balanço ----------
    const twoGroups = !!config.twoGroupsEnabled;
    const groupNames = config.groupNames || ['Grupo 1', 'Grupo 2'];
    const anyPlantao = schedule.some(d => (d.slots || []).some(s => isPlantao(s.activity.type)));
    const hours = {};
    const ensure = (n) => (hours[n] ||= { total: 0, g1: 0, g2: 0, plantoes: 0, weeks: mondays.map(() => 0) });
    (students || []).forEach(s => ensure(s.name));
    schedule.forEach(day => {
        const wi = mondays.indexOf(mondayOf(day.date));
        (day.slots || []).forEach(slot => {
            const h = Number(slot.activity.hoursCount) || 0;
            (slot.assigned || []).forEach(n => {
                const st = ensure(n);
                st.total += h;
                if (String(slot.activity.activityGroup || '1') === '2') st.g2 += h; else st.g1 += h;
                if (isPlantao(slot.activity.type)) st.plantoes++;
                if (wi >= 0) st.weeks[wi] += h;
            });
        });
    });

    const header = ['Aluno', 'Grupo', ...mondays.map((_, i) => `SEM ${i + 1}`)];
    if (twoGroups) header.push(groupNames[0], groupNames[1]);
    header.push('Total (h)');
    if (twoGroups) header.push(`Meta ${groupNames[0]}`, `Meta ${groupNames[1]}`);
    else header.push('Meta (h)', 'Diferença');
    if (anyPlantao) header.push('Plantões');

    const groupOf = (n) => ((students || []).find(s => s.name === n) || {}).affinityGroup || '';
    const rows = Object.keys(hours).sort((a, b) => a.localeCompare(b, 'pt-BR')).map(n => {
        const st = hours[n];
        const row = [n, groupOf(n), ...st.weeks];
        if (twoGroups) row.push(st.g1, st.g2);
        row.push(st.total);
        if (twoGroups) row.push(Number(config.requiredHoursGroup1) || 0, Number(config.requiredHoursGroup2) || 0);
        else row.push(Number(config.requiredHours) || 0, st.total - (Number(config.requiredHours) || 0));
        if (anyPlantao) row.push(st.plantoes);
        return row;
    });

    return {
        weeks,
        balance: { header, rows, totalCol: header.indexOf('Total (h)'), diffCol: header.indexOf('Diferença') },
        period: `${fmtDate(startDate)} a ${fmtDate(endDate)}`
    };
}

// ---------------------------------------------------------------------
// .xlsx
// ---------------------------------------------------------------------
function buildScheduleWorkbook(ExcelJS, data) {
    const layout = layoutSchedule(data);
    const FONT = 'Arial';
    const thin = { style: 'thin', color: { argb: 'FF000000' } };
    const argb = (hex) => hex ? { argb: 'FF' + hex } : undefined;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Escala de Rodízio';
    wb.created = new Date();

    layout.weeks.forEach(week => {
        const ws = wb.addWorksheet(week.name, {
            views: [{ showGridLines: false }],
            pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 }
        });
        week.colWidths.forEach((w, c) => { if (c > 0) ws.getColumn(c).width = w; });
        for (let r = 1; r <= week.nRows + 1; r++) ws.getRow(r).height = 20;

        week.cells.forEach(cell => {
            const r2 = cell.r + cell.rs - 1, c2 = cell.c + cell.cs - 1;
            if (cell.rs > 1 || cell.cs > 1) ws.mergeCells(cell.r, cell.c, r2, c2);
            for (let r = cell.r; r <= r2; r++) {
                for (let c = cell.c; c <= c2; c++) {
                    const x = ws.getCell(r, c);
                    x.font = { name: FONT, size: cell.size || 11, bold: !!cell.bold, italic: !!cell.italic, color: argb(cell.color) };
                    x.alignment = {
                        horizontal: cell.align || 'center', vertical: 'middle',
                        textRotation: cell.rotate ? 90 : 0, wrapText: !cell.rotate, indent: cell.align === 'left' ? 1 : 0
                    };
                    if (cell.fill) x.fill = { type: 'pattern', pattern: 'solid', fgColor: argb(cell.fill) };
                    x.border = {
                        top: cell.edges.t && r === cell.r ? thin : undefined,
                        bottom: cell.edges.b && r === r2 ? thin : undefined,
                        left: cell.edges.l && c === cell.c ? thin : undefined,
                        right: cell.edges.r && c === c2 ? thin : undefined
                    };
                }
            }
            ws.getCell(cell.r, cell.c).value = cell.v;
        });
    });

    const { header, rows, totalCol, diffCol } = layout.balance;
    const ws = wb.addWorksheet('Balanço', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1, showGridLines: false }] });
    ws.addRow(header);
    rows.forEach(r => ws.addRow(r));
    header.forEach((h, i) => { ws.getColumn(i + 1).width = i === 0 ? 22 : Math.max(10, String(h).length + 3); });
    ws.eachRow((row, rn) => {
        row.height = 20;
        row.eachCell({ includeEmpty: true }, (cell, cn) => {
            const negative = rn > 1 && cn - 1 === diffCol && typeof cell.value === 'number' && cell.value < 0;
            cell.font = { name: FONT, size: 11, bold: rn === 1 || cn - 1 === totalCol, color: negative ? argb(SCHEDULE_COLORS.vago) : undefined };
            cell.alignment = { horizontal: cn === 1 ? 'left' : 'center', vertical: 'middle', indent: cn === 1 ? 1 : 0 };
            cell.border = { top: thin, bottom: thin, left: thin, right: thin };
            if (rn === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: argb(SCHEDULE_COLORS.header) };
        });
    });

    return wb;
}

// ---------------------------------------------------------------------
// HTML (impressão/PDF e Google Sheets)
// ---------------------------------------------------------------------
function escapeScheduleHtml(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Renderiza as linhas [fromRow..toRow] de uma semana como <tr>s, pulando a coluna de margem.
// mode 'print': rótulo vertical via CSS. mode 'sheets': marca o tipo das células para o Sheets
// não converter "09/11/2026" ou "07:00" em data/hora (que poderiam virar mm/dd ou AM/PM).
function renderWeekRows(week, fromRow, toRow, mode, colOffset = 0, extraCells = null) {
    const esc = escapeScheduleHtml;
    const byPos = {};
    const covered = new Set();
    week.cells.forEach(cell => {
        byPos[cell.r + ':' + cell.c] = cell;
        for (let r = cell.r; r < cell.r + cell.rs; r++)
            for (let c = cell.c; c < cell.c + cell.cs; c++)
                if (r !== cell.r || c !== cell.c) covered.add(r + ':' + c);
    });
    const line = '1px solid #000';
    let html = '';
    const occupied = new Set();
    week.cells.forEach(cell => { for (let r = cell.r; r < cell.r + cell.rs; r++) occupied.add(r); });
    for (let r = fromRow; r <= toRow; r++) {
        html += (mode === 'print' && !occupied.has(r)) ? '<tr class="pw-gap">' : '<tr>';
        for (let c = 2; c <= week.nCols; c++) {
            if (covered.has(r + ':' + c)) continue;
            const cell = byPos[r + ':' + c];
            if (!cell) { html += '<td></td>'; continue; }
            const st = [
                `text-align:${cell.align || 'center'}`, 'vertical-align:middle',
                cell.bold ? 'font-weight:bold' : '', cell.italic ? 'font-style:italic' : '',
                cell.fill ? `background-color:#${cell.fill}` : '', cell.color ? `color:#${cell.color}` : '',
                cell.size && cell.size !== 11 ? `font-size:${cell.size / 11}em` : '',
                cell.edges.t ? `border-top:${line}` : '', cell.edges.b ? `border-bottom:${line}` : '',
                cell.edges.l ? `border-left:${line}` : '', cell.edges.r ? `border-right:${line}` : '',
                cell.align === 'left' ? 'padding-left:4px' : ''
            ].filter(Boolean).join(';');
            const span = (cell.rs > 1 ? ` rowspan="${cell.rs}"` : '') + (cell.cs > 1 ? ` colspan="${cell.cs}"` : '');
            let content;
            if (cell.rotate) {
                content = mode === 'print'
                    ? `<div class="pw-rot">${esc(cell.v)}</div>`
                    : [...String(cell.v)].map(esc).join('<br>');
            } else {
                content = esc(cell.v);
            }
            let attrs = '';
            if (mode === 'sheets' && cell.v !== '' && cell.v != null) {
                const sv = typeof cell.v === 'number' ? { 1: 3, 3: cell.v } : { 1: 2, 2: String(cell.v) };
                attrs = ` data-sheets-value="${esc(JSON.stringify(sv))}"`;
            }
            html += `<td${span}${attrs} style="${st}">${content}</td>`;
        }
        if (extraCells) html += extraCells(r);
        html += '</tr>';
    }
    return html;
}

function colgroupHtml(week, unit) {
    let html = '<colgroup>';
    const total = week.colWidths.slice(2).reduce((a, b) => a + b, 0);
    for (let c = 2; c <= week.nCols; c++) {
        const w = week.colWidths[c];
        html += unit === '%' ? `<col style="width:${(w / total * 100).toFixed(3)}%">` : `<col width="${Math.round(w * 7 + 5)}" style="width:${Math.round(w * 7 + 5)}px">`;
    }
    return html + '</colgroup>';
}

function balanceTableHtml(balance, mode) {
    const esc = escapeScheduleHtml;
    const sv = (v) => mode === 'sheets' ? ` data-sheets-value="${esc(JSON.stringify(typeof v === 'number' ? { 1: 3, 3: v } : { 1: 2, 2: String(v) }))}"` : '';
    const line = '1px solid #000';
    let html = '<tr>' + balance.header.map(h => `<th${sv(h)} style="border:${line};background-color:#${SCHEDULE_COLORS.header};font-weight:bold;text-align:center;padding:2px 6px">${esc(h)}</th>`).join('') + '</tr>';
    balance.rows.forEach(row => {
        html += '<tr>' + row.map((v, i) => {
            const neg = i === balance.diffCol && typeof v === 'number' && v < 0;
            const st = [`border:${line}`, `text-align:${i === 0 ? 'left' : 'center'}`, 'padding:2px 6px',
                i === balance.totalCol ? 'font-weight:bold' : '', neg ? `color:#${SCHEDULE_COLORS.vago}` : ''].filter(Boolean).join(';');
            return `<td${sv(v)} style="${st}">${esc(v)}</td>`;
        }).join('') + '</tr>';
    });
    return html;
}

// Uma página (paisagem) por semana + página final com o balanço.
function buildPrintHtml(data, { title } = {}) {
    const layout = layoutSchedule(data);
    const esc = escapeScheduleHtml;
    const heading = esc(title || 'Escala de Rodízio');
    let html = '';
    const GAP = 0.45;            // linha entre cartões = 45% de uma linha normal
    const USABLE_PT = 500;       // altura útil de uma A4 paisagem (margens 8mm) menos o título
    layout.weeks.forEach(week => {
        // Ajusta altura da linha e fonte para a semana caber em uma página (até um limite legível)
        const gapRows = week.groups.length;
        const normalRows = (week.nRows - week.headerRows[0] + 1) - gapRows;
        const rowPt = Math.max(9, Math.min(20, USABLE_PT / (normalRows + gapRows * GAP)));
        const fontPt = Math.min(10.5, Math.max(6.5, rowPt * 0.62));
        html += `<section class="pw-page">
            <div class="pw-title"><strong>${heading}</strong><span>${esc(week.title)}</span></div>
            <table class="pw-grid" style="--pw-row:${rowPt.toFixed(2)}pt;font-size:${fontPt.toFixed(2)}pt">${colgroupHtml(week, '%')}
                <thead>${renderWeekRows(week, week.headerRows[0], week.headerRows[1], 'print')}</thead>`;
        week.groups.forEach(g => {
            html += `<tbody class="pw-group">${renderWeekRows(week, g.from, Math.min(g.to, week.nRows), 'print')}</tbody>`;
        });
        html += `</table></section>`;
    });
    html += `<section class="pw-page pw-balance">
        <div class="pw-title"><strong>${heading}</strong><span>Balanço de horas · ${esc(layout.period)}</span></div>
        <table class="pw-balance-table">${balanceTableHtml(layout.balance, 'print')}</table>
    </section>`;
    return html;
}

// HTML para colar no Google Sheets: todas as semanas empilhadas, com o balanço à direita da primeira.
// Também devolve um texto simples (TSV) como alternativa para quem colar em outro lugar.
function buildSheetsClipboard(data) {
    const layout = layoutSchedule(data);
    const esc = escapeScheduleHtml;
    const week0 = layout.weeks[0];
    const nGrid = week0.nCols - 1;                        // colunas da grade (sem a margem)
    const balCols = layout.balance.header.length;
    const balRows = [layout.balance.header, ...layout.balance.rows];
    const line = '1px solid #000';
    const sv = (v) => ` data-sheets-value="${esc(JSON.stringify(typeof v === 'number' ? { 1: 3, 3: v } : { 1: 2, 2: String(v) }))}"`;

    let html = '<google-sheets-html-origin><table data-sheets-root="1" style="border-collapse:collapse;font-family:Arial;font-size:11pt">';
    html += colgroupHtml(week0, 'px').replace('</colgroup>', '') +
        '<col width="30" style="width:30px">' +
        layout.balance.header.map((h, i) => { const w = i === 0 ? 160 : Math.max(75, String(h).length * 9 + 20); return `<col width="${w}" style="width:${w}px">`; }).join('') +
        '</colgroup>';

    // Linhas do balanço ficam ao lado das primeiras linhas da planilha
    let sheetRow = 0;
    const balanceStart = 2;   // título "Balanço" na linha 1, tabela a partir da linha 2
    const extra = () => {
        const i = sheetRow - balanceStart;
        let cells = '<td></td>';
        if (sheetRow === 0) {
            cells += `<td colspan="${balCols}"${sv('Balanço de horas')} style="font-weight:bold;font-size:13pt">Balanço de horas</td>`;
        } else if (i >= 0 && i < balRows.length) {
            cells += balRows[i].map((v, ci) => {
                const head = i === 0;
                const neg = !head && ci === layout.balance.diffCol && typeof v === 'number' && v < 0;
                const st = [`border:${line}`, `text-align:${ci === 0 ? 'left' : 'center'}`,
                    head || ci === layout.balance.totalCol ? 'font-weight:bold' : '',
                    head ? `background-color:#${SCHEDULE_COLORS.header}` : '', neg ? `color:#${SCHEDULE_COLORS.vago}` : ''].filter(Boolean).join(';');
                return `<td${sv(v)} style="${st}">${esc(v)}</td>`;
            }).join('');
        } else {
            cells += `<td colspan="${balCols}"></td>`;
        }
        sheetRow++;
        return cells;
    };

    layout.weeks.forEach(week => {
        html += `<tr><td colspan="${nGrid}"${sv(week.title)} style="font-weight:bold;font-size:13pt;height:28px;vertical-align:bottom">${esc(week.title)}</td>${extra()}</tr>`;
        html += renderWeekRows(week, week.headerRows[0], week.nRows, 'sheets', 0, extra);
        html += `<tr><td colspan="${nGrid}"></td>${extra()}</tr>`;
    });
    html += '</table></google-sheets-html-origin>';

    // Texto simples: lista corrida (Data, Dia, Início, Término, Atividade, Local, Horas, Alunos)
    const text = [['Data', 'Início', 'Término', 'Atividade', 'Horas', 'Alunos'].join('\t')];
    (data.finalSchedule || []).forEach(day => (day.slots || []).forEach(slot => {
        const [y, m, d] = day.date.split('-');
        text.push([`${d}/${m}/${y}`, slot.activity.startTime, slot.activity.endTime, slot.activity.name,
            slot.activity.hoursCount, (slot.assigned || []).join(', ') || '(vago)'].map(v => String(v ?? '').replace(/[\t\n]/g, ' ')).join('\t'));
    }));
    return { html, text: text.join('\n') };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { layoutSchedule, buildScheduleWorkbook, buildPrintHtml, buildSheetsClipboard };
}
