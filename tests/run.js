// Teste de fumaça do gerador de escalas: roda o script.js real com dados reais
// (tests/fixtures/backup_test.json) em um DOM simulado e valida as regras rígidas.
//
// Uso: npm test
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const backup = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'backup_test.json'), 'utf8'));

// Grupos de afinidade sintéticos (o fixture pode não ter): A x3, B x3, C x4
const GROUPS = {};
backup.students.forEach((s, i) => {
    s.affinityGroup = ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C', 'C', 'C'][i % 10];
    GROUPS[s.name] = s.affinityGroup;
});

// ---------- Helpers compartilhados pelas validações ----------
const isPlantao = t => !t || t.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim() === 'PLANTAO';
const overlap = (s1, e1, s2, e2) => s1 < e2 && s2 < e1;
const weekdayOf = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });
const addDays = (d, off) => {
    const dt = new Date(d + 'T00:00:00');
    dt.setDate(dt.getDate() + off);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};
const hasStudentException = (student, date, activity) => (student.exceptions || []).some(exc => {
    if (typeof exc === 'string') return exc === date;
    if (exc.date !== date) return false;
    if (!exc.startTime || !exc.endTime) return true;
    return overlap(exc.startTime, exc.endTime, activity.startTime, activity.endTime);
});

// ---------- Fixação (📌) de teste: 1 aluno preso a um slot específico ----------
// Escolhe a primeira ocorrência de atividade dentro do período em que o aluno
// escolhido não tem exceção, e espera vê-lo alocado exatamente ali.
const pinStudent = backup.students[backup.students.length - 1];
let testPin = null;
outer:
for (let date = backup.config.startDate; date <= backup.config.endDate; date = addDays(date, 1)) {
    for (const act of backup.activities) {
        if (act.day !== weekdayOf(date)) continue;
        if (act.exceptions && act.exceptions.includes(date)) continue;
        if (hasStudentException(pinStudent, date, act)) continue;
        testPin = { date, activityId: act.id, studentId: pinStudent.id, studentName: pinStudent.name };
        break outer;
    }
}
if (!testPin) {
    console.error('FALHA NO SETUP: não foi possível escolher um slot para o teste de fixação.');
    process.exit(1);
}

// ---------- Stubs de DOM ----------
function makeElement(id) {
    const el = {
        id: id || '',
        value: '',
        innerHTML: '',
        textContent: '',
        title: '',
        style: {},
        children: [],
        draggable: false,
        disabled: false,
        listeners: {},
        classList: {
            _set: new Set(),
            add(c) { this._set.add(c); },
            remove(c) { this._set.delete(c); },
            toggle(c, force) {
                const target = force === undefined ? !this._set.has(c) : force;
                target ? this._set.add(c) : this._set.delete(c);
            },
            contains(c) { return this._set.has(c); },
        },
        setAttribute(k, v) { (el._attrs ||= {})[k] = v; },
        getAttribute(k) { return (el._attrs || {})[k]; },
        addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
        appendChild(child) { el.children.push(child); return child; },
        removeChild(child) { el.children = el.children.filter(c => c !== child); },
        querySelectorAll() { return []; },
        querySelector() { return makeElement(); },
        reset() {},
        scrollIntoView() {},
        click() { (el.listeners['click'] || []).forEach(fn => fn({ preventDefault() {} })); },
        closest() { return null; },
    };
    return el;
}

const elements = {};
function getEl(id) {
    if (!elements[id]) elements[id] = makeElement(id);
    return elements[id];
}

let domContentLoadedCb = null;
global.document = {
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') domContentLoadedCb = fn; },
    getElementById: getEl,
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
    createElement() { return makeElement(); },
    body: makeElement('body'),
};
global.window = {};
global.alert = () => {};
global.confirm = () => true;

const storage = {
    med_rotations_activities: JSON.stringify(backup.activities),
    med_rotations_students: JSON.stringify(backup.students),
    med_rotations_config: JSON.stringify(backup.config),
    med_rotations_pins: JSON.stringify([testPin]),
};
global.localStorage = {
    getItem: k => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = v; },
    removeItem: k => { delete storage[k]; },
};

// Captura o conteúdo do último Blob "baixado" (export JSON/CSV)
let lastBlobContent = null;
global.Blob = class { constructor(parts) { this.parts = parts; } };
global.URL = {
    createObjectURL(blob) { lastBlobContent = blob.parts.join(''); return 'blob:fake'; },
    revokeObjectURL() {},
};
global.FileReader = class {};
// global.Worker fica indefinido de propósito: exercita o fallback síncrono do runGeneration

// ---------- Execução ----------
async function main() {
    eval(fs.readFileSync(path.join(REPO, 'script.js'), 'utf8'));
    domContentLoadedCb();

    const t0 = Date.now();
    getEl('generate-btn').click();

    // A geração é assíncrona (Promise); espera o botão ser reabilitado
    for (let i = 0; i < 200 && getEl('generate-btn').disabled; i++) {
        await new Promise(r => setTimeout(r, 50));
    }
    const elapsed = Date.now() - t0;
    if (getEl('generate-btn').disabled) {
        console.error('FALHA: geração não terminou em 10s.');
        process.exit(1);
    }

    getEl('export-btn').click();
    const data = JSON.parse(lastBlobContent);
    if (!data.lastGeneratedSchedule) {
        console.error('FALHA: export não contém lastGeneratedSchedule.');
        process.exit(1);
    }
    const { finalSchedule, studentStats } = data.lastGeneratedSchedule;
    const config = data.config;

    const errors = [];
    const warnings = [];

    // Mapa aluno -> dia -> slots
    const byStudentDay = {};
    finalSchedule.forEach(day => {
        day.slots.forEach(slot => {
            slot.assigned.forEach(name => {
                ((byStudentDay[name] ||= {})[day.date] ||= []).push(slot);
            });
        });
    });

    // 1. Lotação mínima
    let emptySlots = 0, understaffed = 0, totalSlots = 0;
    finalSchedule.forEach(day => day.slots.forEach(slot => {
        totalSlots++;
        const min = slot.activity.minStudents ?? 1;
        if (slot.assigned.length === 0 && min > 0) emptySlots++;
        else if (slot.assigned.length < min) understaffed++;
    }));
    if (emptySlots) warnings.push(`${emptySlots} slots vazios (min>0)`);
    if (understaffed) warnings.push(`${understaffed} slots abaixo do mínimo`);

    // 2. Sem sobreposição de horários no mesmo dia
    Object.entries(byStudentDay).forEach(([name, days]) => {
        Object.entries(days).forEach(([date, slots]) => {
            for (let i = 0; i < slots.length; i++)
                for (let j = i + 1; j < slots.length; j++)
                    if (overlap(slots[i].activity.startTime, slots[i].activity.endTime, slots[j].activity.startTime, slots[j].activity.endTime))
                        errors.push(`SOBREPOSIÇÃO: ${name} em ${date}: ${slots[i].activity.name} x ${slots[j].activity.name}`);
        });
    });

    // 3. Descanso de plantão: nunca no mesmo dia nem em dias adjacentes
    Object.entries(byStudentDay).forEach(([name, days]) => {
        Object.entries(days).forEach(([date, slots]) => {
            const plantoes = slots.filter(s => isPlantao(s.activity.type));
            if (plantoes.length > 1) errors.push(`PLANTÃO DUPLO NO DIA: ${name} em ${date}`);
            if (plantoes.length > 0) {
                const next = days[addDays(date, 1)];
                if (next && next.some(s => isPlantao(s.activity.type)))
                    errors.push(`PLANTÃO SEGUIDO: ${name} em ${date} e ${addDays(date, 1)}`);
            }
        });
    });

    // 3b. Descanso pós-plantão noturno: nada de manhã (antes das 12:00) no dia seguinte
    Object.entries(byStudentDay).forEach(([name, days]) => {
        Object.entries(days).forEach(([date, slots]) => {
            if (!slots.some(s => s.activity.endTime <= s.activity.startTime)) return;
            const next = days[addDays(date, 1)] || [];
            next.filter(s => s.activity.startTime < '12:00').forEach(s =>
                errors.push(`DESCANSO NOTURNO: ${name} em ${addDays(date, 1)}: ${s.activity.name} ${s.activity.startTime}`));
        });
    });

    // 4. Exceções dos alunos respeitadas (fixações são a única exceção permitida)
    const studentByName = {};
    backup.students.forEach(s => { studentByName[s.name] = s; });
    Object.entries(byStudentDay).forEach(([name, days]) => {
        const st = studentByName[name];
        if (!st) return;
        Object.entries(days).forEach(([date, slots]) => {
            slots.forEach(slot => {
                const isThePin = date === testPin.date && String(slot.activity.id) === String(testPin.activityId) && name === testPin.studentName;
                if (!isThePin && hasStudentException(st, date, slot.activity))
                    errors.push(`EXCEÇÃO VIOLADA: ${name} em ${date} (${slot.activity.name})`);
            });
        });
    });

    // 5. Fixação (📌) respeitada
    const pinDay = finalSchedule.find(d => d.date === testPin.date);
    const pinSlot = pinDay && pinDay.slots.find(s => String(s.activity.id) === String(testPin.activityId));
    if (!pinSlot || !pinSlot.assigned.includes(testPin.studentName)) {
        errors.push(`FIXAÇÃO IGNORADA: ${testPin.studentName} deveria estar em ${testPin.date} (atividade ${testPin.activityId}).`);
    }

    // 6. Viabilidade presente no resultado
    if (!data.lastGeneratedSchedule.feasibility || !Array.isArray(data.lastGeneratedSchedule.feasibility.warnings)) {
        errors.push('VIABILIDADE AUSENTE: o resultado não contém a análise de viabilidade.');
    }

    // 7. Exportação CSV
    getEl('export-csv-btn').click();
    const csv = lastBlobContent;
    if (typeof csv !== 'string' || csv.charCodeAt(0) !== 0xFEFF) errors.push('CSV sem BOM UTF-8.');
    if (!csv.includes('Data;Dia da Semana;Atividade')) errors.push('CSV sem cabeçalho esperado.');
    if (csv.split('\r\n').length < 10) errors.push('CSV com menos linhas que o esperado.');

    // ---------- Relatório ----------
    console.log(`Gerado em ${elapsed}ms (fallback síncrono, sem Worker) | ${totalSlots} slots | meta ${config.requiredHours}h`);
    const hrs = studentStats.map(s => s.totalHours);
    const mean = hrs.reduce((a, b) => a + b, 0) / hrs.length;
    const variance = hrs.reduce((a, b) => a + (b - mean) ** 2, 0) / hrs.length;
    console.log(`Horas: min ${Math.min(...hrs)} | max ${Math.max(...hrs)} | amplitude ${Math.max(...hrs) - Math.min(...hrs)} | desvio-padrão ${Math.sqrt(variance).toFixed(1)}h`);

    let samePairs = 0, totalPairs = 0;
    finalSchedule.forEach(day => day.slots.forEach(slot => {
        const groups = slot.assigned.map(n => GROUPS[n]);
        for (let i = 0; i < groups.length; i++)
            for (let j = i + 1; j < groups.length; j++) {
                totalPairs++;
                if (groups[i] === groups[j]) samePairs++;
            }
    }));
    console.log(`Afinidade: ${samePairs}/${totalPairs} pares no mesmo grupo (${(100 * samePairs / totalPairs).toFixed(0)}%)`);
    console.log(`Fixação de teste: ${testPin.studentName} em ${testPin.date} (atividade ${testPin.activityId})`);

    console.log('\n--- Alunos ---');
    studentStats.forEach(st => {
        const cov = Array.isArray(st.coveredActivities) ? st.coveredActivities.length : 'n/a';
        const flag = st.totalHours >= config.requiredHours ? 'OK   ' : 'FALTA';
        console.log(`${flag} ${st.name.padEnd(12)} ${String(st.totalHours).padStart(5)}h  plantão:${st.hasPlantao ? 'sim' : 'NÃO'}  atividades:${cov}`);
    });

    console.log('\n--- Validação de regras rígidas ---');
    if (errors.length === 0) console.log('Nenhuma violação. ✅');
    else errors.forEach(e => console.log('ERRO: ' + e));
    if (warnings.length) warnings.forEach(w => console.log('AVISO: ' + w));

    process.exit(errors.length ? 1 : 0);
}

main().catch(err => {
    console.error('FALHA INESPERADA:', err);
    process.exit(1);
});
