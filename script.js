// =====================================================================
// Núcleo do algoritmo de escala (puro: sem DOM e sem localStorage).
// IMPORTANTE: esta função precisa ser totalmente autocontida, pois seu
// código-fonte é serializado (toString) para rodar em um Web Worker.
// =====================================================================
function createSchedulerCore() {

    // Formats a Date to YYYY-MM-DD using local time (toISOString shifts the date near midnight in UTC-negative timezones)
    function toLocalDateStr(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function formatDateBR(dateStr) {
        if (!dateStr || typeof dateStr !== 'string') return '';
        const parts = dateStr.split('-');
        return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : dateStr;
    }

    // Unbiased Fisher-Yates shuffle (sort(() => Math.random() - 0.5) is biased and breaks sort's contract)
    function shuffleArray(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    function getAdjacentDateStr(dateStr, offset) {
        const d = new Date(dateStr + 'T00:00:00');
        d.setDate(d.getDate() + offset);
        return toLocalDateStr(d);
    }

    function isPlantao(type) {
        if (!type) return true; // Default to true for missing types (backward compatibility)
        return type.toUpperCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .trim() === 'PLANTAO';
    }

    function normalizeActivityName(name) {
        if (!name) return "";
        return name.toUpperCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "") // Remove accents
            .replace(/[^A-Z0-9 ]/g, "")      // Remove special chars
            .trim();
    }

    function checkOverlap(start1, end1, start2, end2) {
        return (start1 < end2 && start2 < end1);
    }

    // Activity exceptions can be a single date string ("YYYY-MM-DD") or an
    // interval object ({start, end}, both inclusive) covering a date range.
    function isActivityExcepted(activity, dateStr) {
        if (!activity.exceptions) return false;
        return activity.exceptions.some(exc => {
            if (typeof exc === 'string') return exc === dateStr;
            if (exc && exc.start && exc.end) return dateStr >= exc.start && dateStr <= exc.end;
            return false;
        });
    }

    // Schedule-wide blackout periods ({start, end}, both inclusive): no activity
    // of any kind is scheduled on a date that falls inside one of these.
    function isDateBlackedOut(config, dateStr) {
        if (!config || !Array.isArray(config.blackoutPeriods)) return false;
        return config.blackoutPeriods.some(bp => bp && bp.start && bp.end && dateStr >= bp.start && dateStr <= bp.end);
    }

    function hasException(student, dateStr, activity) {
        if (!student.exceptions) return false;
        return student.exceptions.some(exc => {
            if (typeof exc === 'string') return exc === dateStr;
            if (exc.date !== dateStr) return false;
            if (!exc.startTime || !exc.endTime) return true;
            return checkOverlap(exc.startTime, exc.endTime, activity.startTime, activity.endTime);
        });
    }

    function hasOverlap(student, dateStr, activity, dailyAssignments) {
        if (!dailyAssignments) return false;
        return dailyAssignments.some(as =>
            as.studentId === student.id &&
            checkOverlap(as.startTime, as.endTime, activity.startTime, activity.endTime)
        );
    }

    function hasPlantaoOnAdjacentDay(studentId, dateStr, allDailyAssignments) {
        if (!allDailyAssignments) return false;

        const checkDay = (offset) => {
            const adjDate = getAdjacentDateStr(dateStr, offset);
            const adjAssignments = allDailyAssignments[adjDate];
            if (!adjAssignments) return false;
            return adjAssignments.some(as => as.studentId === studentId && isPlantao(as.type));
        };

        return checkDay(-1) || checkDay(1);
    }

    // Overnight shifts (e.g. 19:00-07:00) end after midnight, on the following day.
    function isOvernight(startTime, endTime) {
        return !!startTime && !!endTime && endTime <= startTime;
    }

    // After an overnight shift the student rests through the next morning: activities
    // starting before this time on the following day are off-limits.
    const MORNING_REST_CUTOFF = '12:00';

    // True when placing `activity` on `dateStr` collides with an overnight shift's morning
    // rest, in either direction: a morning activity right after the student's night shift,
    // or a night shift right before the student's morning activity.
    function hasOvernightRestConflict(studentId, dateStr, activity, allDailyAssignments) {
        if (!allDailyAssignments) return false;

        if (activity.startTime < MORNING_REST_CUTOFF) {
            const prev = allDailyAssignments[getAdjacentDateStr(dateStr, -1)];
            if (prev && prev.some(as => as.studentId === studentId && isOvernight(as.startTime, as.endTime))) return true;
        }

        if (isOvernight(activity.startTime, activity.endTime)) {
            const next = allDailyAssignments[getAdjacentDateStr(dateStr, 1)];
            if (next && next.some(as => as.studentId === studentId && as.startTime < MORNING_REST_CUTOFF)) return true;
        }

        return false;
    }

    function isStudentEligible(student, dateStr, activity, allDailyAssignments) {
        if (hasException(student, dateStr, activity)) return false;

        // Same day overlap check
        const sameDayAssignments = allDailyAssignments[dateStr] || [];
        if (hasOverlap(student, dateStr, activity, sameDayAssignments)) return false;

        // Rest rule: If this is a plantão, student can't have another plantão on the same day
        // (even at non-overlapping times) nor on adjacent days
        if (isPlantao(activity.type)) {
            const hasPlantaoSameDay = sameDayAssignments.some(as => as.studentId === student.id && isPlantao(as.type));
            if (hasPlantaoSameDay) return false;
            if (hasPlantaoOnAdjacentDay(student.id, dateStr, allDailyAssignments)) return false;
        }

        // Rest rule: no morning activity right after a night shift (any activity type)
        if (hasOvernightRestConflict(student.id, dateStr, activity, allDailyAssignments)) return false;

        return true;
    }

    function getPreferenceScore(student, dateStr, activity) {
        if (!student.preferredDates) return 0;

        const activityDuration = activity.hoursCount || 0;
        let bestScore = 0;

        student.preferredDates.forEach(pref => {
            let matches = false;
            let prefDuration = 0;

            if (typeof pref === 'string') {
                if (pref === dateStr) matches = true;
            } else if (pref.date === dateStr) {
                if (!pref.startTime || !pref.endTime) {
                    matches = true;
                } else if (checkOverlap(pref.startTime, pref.endTime, activity.startTime, activity.endTime)) {
                    matches = true;
                    // Calculate preference duration in hours
                    const [h1, m1] = pref.startTime.split(':').map(Number);
                    const [h2, m2] = pref.endTime.split(':').map(Number);
                    prefDuration = (h2 + m2/60) - (h1 + m1/60);
                }
            }

            if (matches) {
                let currentScore = 1; // Basic date/overlap match

                // Extra priority: 12h preference matched with 12h activity (like Plantão)
                if (prefDuration >= 11.5 && activityDuration >= 11.5) {
                    currentScore = 3;
                } else if (Math.abs(prefDuration - activityDuration) < 1) {
                    // Good duration match
                    currentScore = 2;
                }

                if (currentScore > bestScore) bestScore = currentScore;
            }
        });

        return bestScore;
    }

    function calculateMandatoryActivities(acts, config) {
        if (!config.startDate || !config.endDate) return [];

        const start = new Date(config.startDate + 'T00:00:00');
        const end = new Date(config.endDate + 'T00:00:00');
        const uniqueNames = new Set();

        let current = new Date(start);
        while (current <= end) {
            const dateStr = toLocalDateStr(current);
            if (!isDateBlackedOut(config, dateStr)) {
                const dayName = current.toLocaleDateString('en-US', { weekday: 'long' });

                acts.forEach(a => {
                    if (a.day === dayName && !isActivityExcepted(a, dateStr)) {
                        uniqueNames.add(normalizeActivityName(a.name));
                    }
                });
            }
            current.setDate(current.getDate() + 1);
        }
        return Array.from(uniqueNames);
    }

    // Every dated occurrence of every activity within the configured period
    function buildPotentialSlots(activities, config) {
        if (!config.startDate || !config.endDate) return [];
        const startDate = new Date(config.startDate + 'T00:00:00');
        const endDate = new Date(config.endDate + 'T00:00:00');
        const slots = [];

        let current = new Date(startDate);
        while (current <= endDate) {
            const dateStr = toLocalDateStr(current);
            if (!isDateBlackedOut(config, dateStr)) {
                const dayName = current.toLocaleDateString('en-US', { weekday: 'long' });
                activities.forEach(a => {
                    if (a.day === dayName && !isActivityExcepted(a, dateStr)) {
                        slots.push({
                            dateStr,
                            dayName,
                            activity: { ...a, normalizedName: normalizeActivityName(a.name) }
                        });
                    }
                });
            }
            current.setDate(current.getDate() + 1);
        }
        return slots;
    }

    // Pre-generation feasibility analysis: detects impossible targets before wasting a run
    function analyzeFeasibility(activities, students, config) {
        const errors = [];
        const warnings = [];
        if (!config || !config.startDate || !config.endDate || !Array.isArray(students) || students.length === 0) {
            return { errors, warnings };
        }

        const slots = buildPotentialSlots(activities, config);
        if (slots.length === 0) {
            errors.push('Nenhuma atividade ocorre dentro do período configurado.');
            return { errors, warnings };
        }

        const twoGroupsEnabled = !!config.twoGroupsEnabled;
        const groupNames = (config.groupNames && config.groupNames.length === 2) ? config.groupNames : ['Grupo 1', 'Grupo 2'];

        if (twoGroupsEnabled) {
            const missingGroupMsgs = new Set();
            slots.forEach(s => {
                if (s.activity.activityGroup !== '1' && s.activity.activityGroup !== '2') {
                    missingGroupMsgs.add(`${s.activity.name}: sem grupo de atividade definido — será tratada como "${groupNames[0]}".`);
                }
            });
            missingGroupMsgs.forEach(m => warnings.push(m));
        }

        // Computes capacity/minimum-vs-target checks for one group's slots (or all slots, in single-group mode)
        function checkHoursTarget(groupSlots, label, requiredHours) {
            let maxCapacityHours = 0;
            let minRequiredHours = 0;
            groupSlots.forEach(s => {
                maxCapacityHours += (s.activity.hoursCount || 0) * (s.activity.studentsCount || 0);
                minRequiredHours += (s.activity.hoursCount || 0) * (s.activity.minStudents ?? 1);
            });

            const neededHours = requiredHours * students.length;
            if (neededHours > maxCapacityHours) {
                const maxAvg = maxCapacityHours / students.length;
                errors.push(`Meta de ${requiredHours}h por aluno${label} é inatingível: mesmo lotando todas as atividades, a média máxima possível é de ${maxAvg.toFixed(1)}h por aluno.`);
            }

            const minAvg = minRequiredHours / students.length;
            if (requiredHours > 0 && minAvg > requiredHours) {
                warnings.push(`Para cobrir o mínimo de todas as atividades${label}, os alunos terão em média ${minAvg.toFixed(1)}h — acima da meta de ${requiredHours}h por aluno.`);
            }

            return { maxCapacityHours, minRequiredHours, neededHours };
        }

        let maxCapacityHours, minRequiredHours, neededHours;
        if (twoGroupsEnabled) {
            const r1 = checkHoursTarget(slots.filter(s => (s.activity.activityGroup || '1') === '1'), ` no grupo "${groupNames[0]}"`, config.requiredHoursGroup1 || 0);
            const r2 = checkHoursTarget(slots.filter(s => s.activity.activityGroup === '2'), ` no grupo "${groupNames[1]}"`, config.requiredHoursGroup2 || 0);
            maxCapacityHours = r1.maxCapacityHours + r2.maxCapacityHours;
            minRequiredHours = r1.minRequiredHours + r2.minRequiredHours;
            neededHours = r1.neededHours + r2.neededHours;
        } else {
            ({ maxCapacityHours, minRequiredHours, neededHours } = checkHoursTarget(slots, '', config.requiredHours || 0));
        }

        // Slots where student exceptions alone already make the minimum impossible
        const lowStaffMsgs = [];
        slots.forEach(s => {
            const min = s.activity.minStudents ?? 1;
            if (min === 0) return;
            const available = students.filter(st => !hasException(st, s.dateStr, s.activity)).length;
            if (available < min) {
                lowStaffMsgs.push(`${formatDateBR(s.dateStr)} — ${s.activity.name}: apenas ${available} aluno(s) disponível(is) para um mínimo de ${min}.`);
            }
        });
        lowStaffMsgs.slice(0, 8).forEach(m => warnings.push(m));
        if (lowStaffMsgs.length > 8) {
            warnings.push(`... e mais ${lowStaffMsgs.length - 8} ocorrências de atividades com menos alunos disponíveis que o mínimo.`);
        }

        // Students whose exceptions block every plantão date
        const hasPlantaoSlots = slots.some(s => isPlantao(s.activity.type));
        if (hasPlantaoSlots) {
            students.forEach(st => {
                const anyDay = slots.some(s => isPlantao(s.activity.type) && !hasException(st, s.dateStr, s.activity));
                if (!anyDay) warnings.push(`${st.name} não tem nenhuma data disponível para PLANTÃO (todas bloqueadas por exceções).`);
            });
        }

        return { errors, warnings, maxCapacityHours, minRequiredHours, neededHours };
    }

    // input: { activities, students, config, pins, onProgress? }
    function generate(input) {
        const activities = input.activities || [];
        const students = input.students || [];
        const config = input.config || {};
        const pins = input.pins || [];
        const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null;

        // Size of each affinity group, used to normalize the affinity bonus below so a 2-person
        // group fully reuniting is worth as much as a 4-person group fully clustering (see
        // affinityBonusForSlot / slotAffinityScore).
        const affinityGroupSizes = {};
        students.forEach(s => {
            if (s.affinityGroup) affinityGroupSizes[s.affinityGroup] = (affinityGroupSizes[s.affinityGroup] || 0) + 1;
        });
        const pairCount = n => n * (n - 1) / 2;
        // Bonus for one affinity group appearing `count` times in a single slot: scaled so that
        // getting the WHOLE group into one slot is worth `base` regardless of group size (a pair
        // reuniting fully is just as valuable as a foursome fully clustering), with partial overlap
        // credited proportionally. Without this normalization, pairwise/quadratic counting makes
        // bigger groups worth exponentially more per slot, so small groups (e.g. a 2-person group)
        // always lose the competition for slot space to bigger ones and rarely end up together.
        function affinityBonusForSlot(group, count, base) {
            if (count < 2) return 0;
            const groupSize = affinityGroupSizes[group] || count;
            const maxPairs = pairCount(groupSize) || 1;
            return base * (pairCount(count) / maxPairs);
        }

        const allPotentialSlots = buildPotentialSlots(activities, config);
        const mandatoryActivities = calculateMandatoryActivities(activities, config);
        const feasibility = analyzeFeasibility(activities, students, config);

        // Resolve pinned assignments (manual drag-drop moves or 📌 toggles kept across re-generations)
        const pinWarnings = [];
        const validPins = [];
        pins.forEach(pin => {
            const student = students.find(s => String(s.id) === String(pin.studentId)) ||
                            students.find(s => s.name === pin.studentName);
            const slotExists = allPotentialSlots.some(s => s.dateStr === pin.date && String(s.activity.id) === String(pin.activityId));
            if (!student || !slotExists) {
                pinWarnings.push(`Fixação ignorada: ${pin.studentName || 'aluno desconhecido'} em ${formatDateBR(pin.date || '')} — o aluno ou a atividade não existe mais nessa data.`);
                return;
            }
            validPins.push({ date: pin.date, activityId: pin.activityId, student });
        });
        const pinnedKeys = new Set(validPins.map(p => `${p.date}|${String(p.activityId)}|${p.student.name}`));

        // --- Two activity-group hour split: each activity belongs to group '1' or '2' (default
        // '1' when unset), and each student has an independent hour target per group. Every other
        // rule (overlap, plantão rest, exceptions, affinity, preferences, mandatory coverage) stays
        // scoped globally, not per group — only the hours-balancing math below reads the group.
        const twoGroupsEnabled = !!config.twoGroupsEnabled;

        function groupOf(activity) {
            return activity.activityGroup === '2' ? '2' : '1';
        }

        function addHours(stats, activity) {
            stats.totalHours += activity.hoursCount;
            if (twoGroupsEnabled) stats.hoursByGroup[groupOf(activity)] += activity.hoursCount;
        }

        // Remaining hours needed toward the target relevant to this activity (group target if
        // two-group mode is on, overall target otherwise).
        function remainingHours(stats, activity) {
            if (twoGroupsEnabled) {
                const g = groupOf(activity);
                return stats.requiredHoursByGroup[g] - stats.hoursByGroup[g];
            }
            return stats.requiredHours - stats.totalHours;
        }

        // Hours accumulated so far toward the target relevant to this activity.
        function hoursSoFar(stats, activity) {
            return twoGroupsEnabled ? stats.hoursByGroup[groupOf(activity)] : stats.totalHours;
        }

        function runSingleAttempt() {
            const studentStats = students.map(s => ({
                id: s.id,
                name: s.name,
                affinityGroup: s.affinityGroup,
                totalHours: 0,
                requiredHours: config.requiredHours || 0,
                hoursByGroup: twoGroupsEnabled ? { 1: 0, 2: 0 } : undefined,
                requiredHoursByGroup: twoGroupsEnabled ? { 1: config.requiredHoursGroup1 || 0, 2: config.requiredHoursGroup2 || 0 } : undefined,
                coveredActivities: new Set(),
                hasPlantao: false
            }));

            // Flatten all instances into individual slots
            const allSlots = allPotentialSlots.map(s => ({
                ...s,
                assignedIds: [],
                diagnostics: null
            }));

            // 1. Calculate Global Scarcity
            allSlots.forEach(slot => {
                slot._scarcity = students.filter(student => isStudentEligible(student, slot.dateStr, slot.activity, {})).length;
            });

            const dailyAssignments = {}; // { dateStr: [ {studentId, start, end} ] }

            // 1.5 Apply pinned assignments first (user-forced; later phases respect them)
            validPins.forEach(pin => {
                const slot = allSlots.find(s => s.dateStr === pin.date && String(s.activity.id) === String(pin.activityId));
                if (!slot) return;
                if (slot.assignedIds.includes(pin.student.id)) return;
                if (slot.assignedIds.length >= slot.activity.studentsCount) return;

                const stats = studentStats.find(st => st.id === pin.student.id);
                slot.assignedIds.push(pin.student.id);
                addHours(stats, slot.activity);
                stats.coveredActivities.add(slot.activity.normalizedName);
                if (isPlantao(slot.activity.type)) stats.hasPlantao = true;

                if (!dailyAssignments[pin.date]) dailyAssignments[pin.date] = [];
                dailyAssignments[pin.date].push({
                    studentId: pin.student.id,
                    startTime: slot.activity.startTime,
                    endTime: slot.activity.endTime,
                    type: slot.activity.type
                });
            });

            // 2. Global Phase 1: Minimum Staffing (Guarantee MINIMUM people per activity)
            // Shuffle first (random tie-break for Monte Carlo), then stable-sort by scarcity (hardest first)
            const phase1Order = shuffleArray([...allSlots]).sort((a, b) => a._scarcity - b._scarcity);

            phase1Order.forEach(slot => {
                const dateStr = slot.dateStr;
                if (!dailyAssignments[dateStr]) dailyAssignments[dateStr] = [];

                const targetMin = slot.activity.minStudents ?? 1;

                while (slot.assignedIds.length < targetMin) {
                    const eligible = shuffleArray(students.filter(s =>
                        !slot.assignedIds.includes(s.id) &&
                        isStudentEligible(s, dateStr, slot.activity, dailyAssignments)
                    ));

                    if (eligible.length > 0) {
                        // Pick student who NEEDS this activity name most OR needs a Plantão
                        // ADDED: Or shares an affinity group with someone already in this slot
                        eligible.sort((a, b) => {
                            const statsA = studentStats.find(st => st.id === a.id);
                            const statsB = studentStats.find(st => st.id === b.id);

                            const needsActA = !statsA.coveredActivities.has(slot.activity.normalizedName);
                            const needsActB = !statsB.coveredActivities.has(slot.activity.normalizedName);
                            const needsPlantaoA = isPlantao(slot.activity.type) && !statsA.hasPlantao;
                            const needsPlantaoB = isPlantao(slot.activity.type) && !statsB.hasPlantao;

                            // Priority 1: Mandatory Activity Coverage
                            if (needsActA !== needsActB) return needsActA ? -1 : 1;

                            // Priority 2: Mandatory Plantao Coverage
                            if (needsPlantaoA !== needsPlantaoB) return needsPlantaoA ? -1 : 1;

                            // Priority 3: Preferences (Elevated Priority)
                            const scoreA = getPreferenceScore(a, dateStr, slot.activity);
                            const scoreB = getPreferenceScore(b, dateStr, slot.activity);
                            if (scoreA !== scoreB) return scoreB - scoreA; // Higher score first

                            // Priority 4: Affinity Group (SOFT CONSTRAINT)
                            if (slot.assignedIds.length > 0) {
                                const groupInSlot = studentStats.filter(st => slot.assignedIds.includes(st.id)).map(st => st.affinityGroup);
                                const sharesA = statsA.affinityGroup && groupInSlot.includes(statsA.affinityGroup);
                                const sharesB = statsB.affinityGroup && groupInSlot.includes(statsB.affinityGroup);
                                if (sharesA !== sharesB) return sharesA ? -1 : 1;
                            }

                            // Priority 5: Overshoot fit - prefer students whose remaining hour deficit absorbs this slot
                            const overA = Math.max(0, slot.activity.hoursCount - Math.max(0, remainingHours(statsA, slot.activity)));
                            const overB = Math.max(0, slot.activity.hoursCount - Math.max(0, remainingHours(statsB, slot.activity)));
                            if (overA !== overB) return overA - overB;

                            // Priority 6: Hours Balance (ties keep the pre-shuffled random order — sort is stable)
                            return hoursSoFar(statsA, slot.activity) - hoursSoFar(statsB, slot.activity);
                        });

                        const chosen = eligible[0];
                        const stats = studentStats.find(st => st.id === chosen.id);

                        slot.assignedIds.push(chosen.id);
                        addHours(stats, slot.activity);
                        stats.coveredActivities.add(slot.activity.normalizedName);
                        if (isPlantao(slot.activity.type)) stats.hasPlantao = true;

                        dailyAssignments[dateStr].push({
                            studentId: chosen.id,
                            startTime: slot.activity.startTime,
                            endTime: slot.activity.endTime,
                            type: slot.activity.type
                        });
                    } else {
                        // Diagnostic tracking for failures
                        let rejectedException = 0;
                        let rejectedOverlap = 0;
                        let rejectedBackToBack = 0;
                        students.forEach(s => {
                            if (hasException(s, dateStr, slot.activity)) rejectedException++;
                            else if (hasOverlap(s, dateStr, slot.activity, dailyAssignments[dateStr])) rejectedOverlap++;
                            else if (isPlantao(slot.activity.type) && hasPlantaoOnAdjacentDay(s.id, dateStr, dailyAssignments)) rejectedBackToBack++;
                            else if (hasOvernightRestConflict(s.id, dateStr, slot.activity, dailyAssignments)) rejectedBackToBack++;
                        });

                        if (slot.assignedIds.length === 0) {
                            slot.diagnostics = `Não foi possível preencher. ${rejectedException} exceções, ${rejectedOverlap} sobreposições, ${rejectedBackToBack} plantões seguidos.`;
                        } else {
                            slot.diagnostics = `Mínimo de ${targetMin} não atingido (atribuídos: ${slot.assignedIds.length}).`;
                        }
                        break;
                    }
                }
            });

            const fillSlotToTarget = (slot, limit) => {
                const dateStr = slot.dateStr;
                while (slot.assignedIds.length < limit) {
                    const eligible = shuffleArray(students.filter(s =>
                        !slot.assignedIds.includes(s.id) &&
                        isStudentEligible(s, dateStr, slot.activity, dailyAssignments)
                    ));

                    // Only take students who still need hours OR still need this activity/plantao for coverage
                    const needingHoursOrCoverage = eligible.filter(s => {
                        const stats = studentStats.find(st => st.id === s.id);
                        const needsAct = !stats.coveredActivities.has(slot.activity.normalizedName);
                        const needsPlantao = isPlantao(slot.activity.type) && !stats.hasPlantao;
                        return remainingHours(stats, slot.activity) > 0 || needsAct || needsPlantao;
                    });

                    if (needingHoursOrCoverage.length === 0) break;

                    // Prioritize Coverage then Preferences then Affinity
                    needingHoursOrCoverage.sort((a, b) => {
                        const statsA = studentStats.find(st => st.id === a.id);
                        const statsB = studentStats.find(st => st.id === b.id);

                        const needsActA = !statsA.coveredActivities.has(slot.activity.normalizedName);
                        const needsActB = !statsB.coveredActivities.has(slot.activity.normalizedName);
                        const needsPlantaoA = isPlantao(slot.activity.type) && !statsA.hasPlantao;
                        const needsPlantaoB = isPlantao(slot.activity.type) && !statsB.hasPlantao;

                        if (needsActA !== needsActB) return needsActA ? -1 : 1;
                        if (needsPlantaoA !== needsPlantaoB) return needsPlantaoA ? -1 : 1;

                        // Priority 3: Preferences
                        const scoreA = getPreferenceScore(a, dateStr, slot.activity);
                        const scoreB = getPreferenceScore(b, dateStr, slot.activity);
                        if (scoreA !== scoreB) return scoreB - scoreA;

                        // Priority 4: Affinity Group (SOFT CONSTRAINT)
                        if (slot.assignedIds.length > 0) {
                            const groupInSlot = studentStats.filter(st => slot.assignedIds.includes(st.id)).map(st => st.affinityGroup);
                            const sharesA = statsA.affinityGroup && groupInSlot.includes(statsA.affinityGroup);
                            const sharesB = statsB.affinityGroup && groupInSlot.includes(statsB.affinityGroup);
                            if (sharesA !== sharesB) return sharesA ? -1 : 1;
                        }

                        // Priority 5: Overshoot fit - prefer students whose remaining hour deficit absorbs this slot
                        const overA = Math.max(0, slot.activity.hoursCount - Math.max(0, remainingHours(statsA, slot.activity)));
                        const overB = Math.max(0, slot.activity.hoursCount - Math.max(0, remainingHours(statsB, slot.activity)));
                        if (overA !== overB) return overA - overB;

                        return hoursSoFar(statsA, slot.activity) - hoursSoFar(statsB, slot.activity);
                    });

                    const chosen = needingHoursOrCoverage[0];
                    const stats = studentStats.find(st => st.id === chosen.id);
                    slot.assignedIds.push(chosen.id);
                    addHours(stats, slot.activity);
                    stats.coveredActivities.add(slot.activity.normalizedName);
                    if (isPlantao(slot.activity.type)) stats.hasPlantao = true;

                    dailyAssignments[dateStr].push({
                        studentId: chosen.id,
                        startTime: slot.activity.startTime,
                        endTime: slot.activity.endTime,
                        type: slot.activity.type
                    });
                }
            };

            // 3. Global Phase 2: Targeted Staffing (Fill up to the MEDIUM point)
            const phase2Order = shuffleArray([...allSlots]);
            phase2Order.forEach(slot => {
                const min = slot.activity.minStudents ?? 1;
                const max = slot.activity.studentsCount;
                const ideal = Math.ceil((min + max) / 2);
                fillSlotToTarget(slot, ideal);
            });

            // 4. Global Phase 3: Final Staffing (Fill up to MAX if students still need hours/coverage)
            const phase3Order = shuffleArray([...allSlots]);
            phase3Order.forEach(slot => {
                fillSlotToTarget(slot, slot.activity.studentsCount);
            });

            // 5. Format for UI
            const finalSchedule = [];
            const slotsByDate = {};
            allSlots.forEach(slot => {
                if (!slotsByDate[slot.dateStr]) slotsByDate[slot.dateStr] = { date: slot.dateStr, dayName: slot.dayName, slots: [] };
                slotsByDate[slot.dateStr].slots.push({
                    activity: slot.activity,
                    assigned: slot.assignedIds.map(id => students.find(s => s.id === id).name),
                    capacityString: `${slot.assignedIds.length}/${slot.activity.studentsCount}`,
                    diagnostics: slot.diagnostics
                });
            });

            Object.keys(slotsByDate).sort().forEach(d => {
                const dayGroup = slotsByDate[d];
                dayGroup.slots.sort((a, b) => a.activity.startTime.localeCompare(b.activity.startTime));
                finalSchedule.push(dayGroup);
            });

            return { finalSchedule, studentStats };
        }

        // Sem nenhum PLANTÃO cadastrado, a garantia de plantão não se aplica
        const anyPlantaoActivity = activities.some(a => isPlantao(a.type));

        function calculateScore({ finalSchedule, studentStats }) {
            let emptyCount = 0;
            let understaffedPenalty = 0;
            let coveragePenalty = 0;
            let preferenceBonus = 0;
            let affinityBonus = 0;
            let distributionPenalty = 0;

            finalSchedule.forEach(day => {
                day.slots.forEach(slot => {
                    const assigned = slot.assigned.length;
                    const min = slot.activity.minStudents ?? 1;
                    const max = slot.activity.studentsCount;
                    const ideal = Math.ceil((min + max) / 2);

                    if (assigned === 0) {
                        if (min > 0) emptyCount++;
                    } else if (assigned < min) {
                        understaffedPenalty += (min - assigned);
                    }

                    // Distribution Penalty: Favor being close to the medium
                    if (assigned > 0) {
                        distributionPenalty += Math.abs(assigned - ideal) * 10;
                    }

                    // Preference Bonus and Affinity Reward
                    if (assigned > 0) {
                        const studentObjs = slot.assigned.map(name => students.find(s => s.name === name));

                        // Preference Bonus
                        studentObjs.forEach(s => {
                            const pScore = s ? getPreferenceScore(s, day.date, slot.activity) : 0;
                            if (pScore > 0) {
                                preferenceBonus += (pScore * 100); // 100 for date, 200 for duration, 300 for 12h-12h
                            }
                        });

                        // Affinity Reward: bonus per group present, normalized by that group's own
                        // size (see affinityBonusForSlot) so a small group fully reuniting scores as
                        // well as a big group fully clustering.
                        if (assigned > 1) {
                            const countByGroup = {};
                            studentObjs.forEach(s => {
                                if (s && s.affinityGroup) countByGroup[s.affinityGroup] = (countByGroup[s.affinityGroup] || 0) + 1;
                            });
                            Object.entries(countByGroup).forEach(([group, count]) => {
                                affinityBonus += affinityBonusForSlot(group, count, 200);
                            });
                        }
                    }
                });
            });

            // Calculate student-specific coverage penalties
            let hoursShortfall = 0;
            studentStats.forEach(stat => {
                // Penalty for missing mandatory activities
                const missingCount = mandatoryActivities.length - stat.coveredActivities.size;
                coveragePenalty += (missingCount * 10);

                // Penalty for missing Plantao
                if (anyPlantaoActivity && !stat.hasPlantao) coveragePenalty += 100;

                // Penalty for finishing below the required hours target. In two-group mode this is
                // the sum of each group's own shortfall — a student who's over on one group and
                // under on the other still shows a shortfall here, instead of the groups masking
                // each other out through a combined total.
                if (twoGroupsEnabled) {
                    hoursShortfall += Math.max(0, stat.requiredHoursByGroup[1] - stat.hoursByGroup[1]);
                    hoursShortfall += Math.max(0, stat.requiredHoursByGroup[2] - stat.hoursByGroup[2]);
                } else {
                    hoursShortfall += Math.max(0, stat.requiredHours - stat.totalHours);
                }
            });

            // Calculate variance in student hours (lower is more balanced). In two-group mode this
            // is the SUM of each group's own variance across students — variance of the combined
            // total alone can't detect a student skewed heavily toward one group and away from the
            // other, since the totals could still look balanced.
            let variance;
            if (twoGroupsEnabled) {
                const hoursG1 = studentStats.map(s => s.hoursByGroup[1]);
                const hoursG2 = studentStats.map(s => s.hoursByGroup[2]);
                const varianceOf = (arr) => {
                    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
                    return arr.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / arr.length;
                };
                variance = varianceOf(hoursG1) + varianceOf(hoursG2);
            } else {
                const hours = studentStats.map(s => s.totalHours);
                const avg = hours.reduce((a, b) => a + b, 0) / hours.length;
                variance = hours.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / hours.length;
            }

            // Score: Higher weights for critical requirements, subtract bonuses
            return (emptyCount * 1000000) +
                   (understaffedPenalty * 100000) +
                   (coveragePenalty * 1000) +
                   (hoursShortfall * 200) +
                   distributionPenalty +
                   (variance * 400) - affinityBonus - preferenceBonus;
        }

        function optimizeAffinitySwaps(finalSchedule) {
            const nameToStudent = {};
            students.forEach(s => { nameToStudent[s.name] = s; });
            const dayByDate = {};
            finalSchedule.forEach(day => { dayByDate[day.date] = day; });

            // Group slot instances by activity (same id = same weekly activity, hours and times)
            const byActivity = {};
            finalSchedule.forEach(day => {
                day.slots.forEach(slot => {
                    (byActivity[slot.activity.id] ||= []).push({ date: day.date, slot });
                });
            });

            // Matches calculateScore's affinityBonusForSlot: normalized by each group's own size, so
            // a 2-person group reuniting fully is worth exactly as much as a 4-person group fully
            // clustering, instead of the pairwise/quadratic count that favors bigger groups.
            const slotAffinityPairs = (names) => {
                const countByGroup = {};
                names.forEach(name => {
                    const g = nameToStudent[name] && nameToStudent[name].affinityGroup;
                    if (g) countByGroup[g] = (countByGroup[g] || 0) + 1;
                });
                let score = 0;
                Object.entries(countByGroup).forEach(([group, count]) => {
                    score += affinityBonusForSlot(group, count, 5);
                });
                return score;
            };

            // Can `name` take `activity` on `date`, ignoring the two slots being swapped?
            const canPlace = (name, date, activity, ignoredSlots) => {
                const student = nameToStudent[name];
                if (student && hasException(student, date, activity)) return false;

                const day = dayByDate[date];
                if (day && day.slots.some(s =>
                    !ignoredSlots.includes(s) && s.assigned.includes(name) &&
                    checkOverlap(s.activity.startTime, s.activity.endTime, activity.startTime, activity.endTime))) {
                    return false;
                }

                // Overnight rest: mirrors hasOvernightRestConflict, over the finished schedule
                const nightRestConflict = (adjOffset, matches) => {
                    const adjDay = dayByDate[getAdjacentDateStr(date, adjOffset)];
                    return !!adjDay && adjDay.slots.some(s =>
                        !ignoredSlots.includes(s) && s.assigned.includes(name) && matches(s.activity));
                };
                if (activity.startTime < MORNING_REST_CUTOFF &&
                    nightRestConflict(-1, a => isOvernight(a.startTime, a.endTime))) return false;
                if (isOvernight(activity.startTime, activity.endTime) &&
                    nightRestConflict(1, a => a.startTime < MORNING_REST_CUTOFF)) return false;

                if (isPlantao(activity.type)) {
                    for (const offset of [-1, 0, 1]) {
                        const adjDay = dayByDate[getAdjacentDateStr(date, offset)];
                        if (adjDay && adjDay.slots.some(s =>
                            !ignoredSlots.includes(s) && isPlantao(s.activity.type) && s.assigned.includes(name))) {
                            return false;
                        }
                    }
                }
                return true;
            };

            let improved = true;
            let passes = 0;
            while (improved && passes < 30) {
                improved = false;
                passes++;

                Object.values(byActivity).forEach(instances => {
                    for (let a = 0; a < instances.length; a++) {
                        for (let b = a + 1; b < instances.length; b++) {
                            const instA = instances[a];
                            const instB = instances[b];
                            if (instA.date === instB.date) continue;

                            let swapped = false;
                            for (const x of [...instA.slot.assigned]) {
                                if (swapped) break;
                                // Pinned assignments never move
                                if (pinnedKeys.has(`${instA.date}|${String(instA.slot.activity.id)}|${x}`)) continue;
                                for (const y of [...instB.slot.assigned]) {
                                    if (pinnedKeys.has(`${instB.date}|${String(instB.slot.activity.id)}|${y}`)) continue;
                                    if (x === y || instA.slot.assigned.includes(y) || instB.slot.assigned.includes(x)) continue;

                                    const newA = instA.slot.assigned.map(n => n === x ? y : n);
                                    const newB = instB.slot.assigned.map(n => n === y ? x : n);
                                    const affinityGain = (slotAffinityPairs(newA) + slotAffinityPairs(newB)) -
                                        (slotAffinityPairs(instA.slot.assigned) + slotAffinityPairs(instB.slot.assigned));

                                    // Don't trade away personal date preferences for affinity
                                    const prefDelta =
                                        (getPreferenceScore(nameToStudent[y] || {}, instA.date, instA.slot.activity) +
                                         getPreferenceScore(nameToStudent[x] || {}, instB.date, instB.slot.activity)) -
                                        (getPreferenceScore(nameToStudent[x] || {}, instA.date, instA.slot.activity) +
                                         getPreferenceScore(nameToStudent[y] || {}, instB.date, instB.slot.activity));

                                    if (affinityGain * 5 + prefDelta <= 0) continue;

                                    const ignored = [instA.slot, instB.slot];
                                    if (!canPlace(x, instB.date, instB.slot.activity, ignored)) continue;
                                    if (!canPlace(y, instA.date, instA.slot.activity, ignored)) continue;

                                    instA.slot.assigned = newA;
                                    instB.slot.assigned = newB;
                                    improved = true;
                                    swapped = true;
                                    break;
                                }
                            }
                        }
                    }
                });
            }
        }

        // --- Multi-Pass Logic (Monte Carlo: keep the best of ATTEMPTS runs) ---
        let bestResult = null;
        let bestScore = Infinity;

        const ATTEMPTS = 200;
        for (let i = 0; i < ATTEMPTS; i++) {
            const currentAttempt = runSingleAttempt();
            const currentScore = calculateScore(currentAttempt);

            if (currentScore < bestScore) {
                bestScore = currentScore;
                bestResult = currentAttempt;
                if (bestScore === 0) break;
            }
            if (onProgress && (i + 1) % 20 === 0) onProgress(i + 1, ATTEMPTS);
        }

        // Post-optimization: swap students between instances of the same activity on different
        // dates to keep affinity groups together. Hours, coverage and plantão counts stay identical.
        optimizeAffinitySwaps(bestResult.finalSchedule);

        return { ...bestResult, mandatoryActivities, feasibility, pinWarnings };
    }

    return {
        generate,
        analyzeFeasibility,
        calculateMandatoryActivities,
        buildPotentialSlots,
        toLocalDateStr,
        formatDateBR,
        shuffleArray,
        getAdjacentDateStr,
        isPlantao,
        isOvernight,
        MORNING_REST_CUTOFF,
        normalizeActivityName,
        checkOverlap,
        hasException,
        isActivityExcepted,
        isDateBlackedOut,
        getPreferenceScore
    };
}

const SchedulerCore = createSchedulerCore();
const {
    isPlantao, normalizeActivityName, toLocalDateStr, formatDateBR,
    getAdjacentDateStr, hasException, checkOverlap, calculateMandatoryActivities,
    isOvernight, MORNING_REST_CUTOFF
} = SchedulerCore;

// =====================================================================
// Formato brasileiro: datas dd/mm/aaaa e relógio 24h na tela.
// Internamente (estado, localStorage e backups JSON) continua tudo em
// AAAA-MM-DD e HH:MM, então backups antigos seguem compatíveis.
// =====================================================================

// Aceita AAAA-MM-DD, dd/mm/aaaa, d/m/aa, ddmmaaaa (também com "-" ou "."). Retorna AAAA-MM-DD ou null.
function parseDateBR(input) {
    if (input == null) return null;
    const s = String(input).trim();
    if (!s) return null;
    let y, m, d, match;
    if ((match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:T.*)?$/))) {
        [, y, m, d] = match;
    } else if ((match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
        [, d, m, y] = match;
    } else if ((match = s.match(/^(\d{2})(\d{2})(\d{4})$/))) {
        [, d, m, y] = match;
    } else {
        return null;
    }
    y = Number(y.length === 2 ? '20' + y : y);
    m = Number(m);
    d = Number(d);
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Aceita 7, 07, 7:30, 0730, 7h, 7h30, 7:30 PM, 07:00:00... Retorna HH:MM (24h) ou null.
function parseTime24(input) {
    if (input == null) return null;
    let s = String(input).trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    let ampm = null;
    const ap = s.match(/(a|p)\.?m\.?$/);
    if (ap) { ampm = ap[1]; s = s.slice(0, ap.index); }
    let h, mi, match;
    if ((match = s.match(/^(\d{1,2})(?:[:h.](\d{2})?(?::\d{2})?)?(?:min)?$/))) {
        h = Number(match[1]); mi = Number(match[2] || 0);
    } else if ((match = s.match(/^(\d{1,2})(\d{2})$/))) {
        h = Number(match[1]); mi = Number(match[2]);
    } else {
        return null;
    }
    if (ampm) {
        if (h < 1 || h > 12) return null;
        if (ampm === 'a' && h === 12) h = 0;
        if (ampm === 'p' && h !== 12) h += 12;
    }
    if (h > 23 || mi > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

// Converte (in place) qualquer data/horário de um backup ou do localStorage para AAAA-MM-DD / HH:MM.
// Valores irreconhecíveis ficam como estão para a validação apontar o problema.
function normalizeBackupFormats(data) {
    if (!data || typeof data !== 'object') return data;
    const fixDate = (v) => (typeof v === 'string' && parseDateBR(v)) || v;
    const fixTime = (v) => (typeof v === 'string' && v.trim() !== '' && parseTime24(v)) || v;
    const fixRange = (r) => { if (r && typeof r === 'object') { r.start = fixDate(r.start); r.end = fixDate(r.end ?? r.start); } return r; };
    const fixActivity = (a) => {
        if (!a || typeof a !== 'object') return;
        a.startTime = fixTime(a.startTime);
        a.endTime = fixTime(a.endTime);
        if (Array.isArray(a.exceptions)) a.exceptions = a.exceptions.map(ex => typeof ex === 'string' ? fixDate(ex) : fixRange(ex));
    };
    const fixStudentDates = (list) => Array.isArray(list) ? list.map(e => {
        if (typeof e === 'string') return fixDate(e);
        if (e && typeof e === 'object') { e.date = fixDate(e.date); e.startTime = fixTime(e.startTime); e.endTime = fixTime(e.endTime); }
        return e;
    }) : list;

    const cfg = data.config;
    if (cfg && typeof cfg === 'object') {
        cfg.startDate = fixDate(cfg.startDate);
        cfg.endDate = fixDate(cfg.endDate);
        if (Array.isArray(cfg.blackoutPeriods)) cfg.blackoutPeriods.forEach(fixRange);
    }
    if (Array.isArray(data.activities)) data.activities.forEach(fixActivity);
    if (Array.isArray(data.students)) data.students.forEach(s => {
        if (!s || typeof s !== 'object') return;
        s.exceptions = fixStudentDates(s.exceptions);
        s.preferredDates = fixStudentDates(s.preferredDates);
    });
    if (Array.isArray(data.pinnedAssignments)) data.pinnedAssignments.forEach(p => { if (p && typeof p === 'object') p.date = fixDate(p.date); });
    const sched = data.lastGeneratedSchedule;
    if (sched && Array.isArray(sched.finalSchedule)) sched.finalSchedule.forEach(day => {
        if (!day || typeof day !== 'object') return;
        day.date = fixDate(day.date);
        (day.slots || []).forEach(slot => slot && fixActivity(slot.activity));
    });
    return data;
}

// Rótulo de horário opcional "(HH:MM-HH:MM)" usado nas tags de exceção/preferência
function formatTimeRangeSuffix(item) {
    return (item && item.startTime && item.endTime) ? ` (${item.startTime}-${item.endTime})` : '';
}

// Troca os <input type="date|time"> nativos (que seguem o idioma do navegador, ex. mm/dd/yyyy e AM/PM)
// por campos de texto dd/mm/aaaa e HH:MM. A propriedade .value continua lendo/gravando AAAA-MM-DD e HH:MM,
// então o restante do código não precisa saber da troca.
function enhanceBrazilianInputs(root) {
    if (typeof HTMLInputElement === 'undefined' || !root || !root.querySelectorAll) return;
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (!nativeValue) return;

    root.querySelectorAll('input[type="date"]:not([data-br-input]), input[type="time"]:not([data-br-input])').forEach(el => {
        if (el.classList.contains('br-date-picker-native')) return;
        const kind = el.type;
        const initial = nativeValue.get.call(el);
        el.setAttribute('data-br-input', kind);
        el.type = 'text';
        el.inputMode = 'numeric';
        el.autocomplete = 'off';
        el.classList.add(kind === 'date' ? 'br-date-input' : 'br-time-input');
        if (kind === 'date') {
            el.placeholder = 'dd/mm/aaaa';
            el.maxLength = 10;
            el.title = 'Data no formato dd/mm/aaaa';
        } else {
            el.placeholder = 'hh:mm';
            el.maxLength = 5;
            el.title = 'Horário 24h no formato hh:mm (ex.: 07:00, 19:00)';
        }

        const parse = kind === 'date' ? parseDateBR : parseTime24;
        const display = (canon) => kind === 'date' ? formatDateBR(canon) : canon;
        Object.defineProperty(el, 'value', {
            configurable: true,
            get() { return parse(nativeValue.get.call(el)) || ''; },
            set(v) {
                const canon = parse(v);
                nativeValue.set.call(el, canon ? display(canon) : (v == null ? '' : String(v)));
                el.setCustomValidity('');
            }
        });
        el.value = initial;

        // Máscara leve: só caracteres válidos e separador automático ao digitar
        el.addEventListener('input', (e) => {
            if (e.inputType && e.inputType.startsWith('delete')) return;
            let t = nativeValue.get.call(el);
            if (kind === 'date') {
                t = t.replace(/[^\d/]/g, '').replace(/\/{2,}/g, '/');
                if (/^\d{3,8}$/.test(t)) t = t.replace(/^(\d{2})(\d{1,2})?(\d{1,4})?$/, (_, d, m, y) => [d, m, y].filter(Boolean).join('/'));
                if (/^\d{2}$/.test(t) || /^\d{1,2}\/\d{2}$/.test(t)) t += '/';
            } else {
                t = t.replace(/[^\d:]/g, '').replace(/:{2,}/g, ':');
                if (/^\d{3,4}$/.test(t)) t = t.slice(0, 2) + ':' + t.slice(2);
                if (/^\d{2}$/.test(t) && Number(t) <= 23) t += ':';
            }
            nativeValue.set.call(el, t);
        });

        // Ao sair do campo, completa (ex.: 6/11/26 → 06/11/2026, 7 → 07:00) ou marca como inválido
        el.addEventListener('blur', () => {
            const raw = nativeValue.get.call(el).trim();
            if (!raw) { el.setCustomValidity(''); return; }
            const canon = parse(raw);
            if (canon) {
                nativeValue.set.call(el, display(canon));
                el.setCustomValidity('');
            } else {
                el.setCustomValidity(kind === 'date' ? 'Use o formato dd/mm/aaaa.' : 'Use o formato 24h hh:mm (ex.: 07:00).');
                el.reportValidity();
            }
        });

        // Botão de calendário: abre o seletor nativo e devolve a data no formato brasileiro
        if (kind === 'date') {
            const wrap = document.createElement('span');
            wrap.className = 'br-date-field';
            el.parentNode.insertBefore(wrap, el);
            wrap.appendChild(el);
            const native = document.createElement('input');
            native.type = 'date';
            native.tabIndex = -1;
            native.className = 'br-date-picker-native';
            native.setAttribute('aria-hidden', 'true');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'br-date-picker-btn';
            btn.title = 'Abrir calendário';
            btn.setAttribute('aria-label', 'Abrir calendário');
            btn.textContent = '📅';
            wrap.appendChild(btn);
            wrap.appendChild(native);
            btn.addEventListener('click', () => {
                nativeValue.set.call(native, el.value);
                try { native.showPicker(); } catch (err) { native.focus(); native.click(); }
            });
            native.addEventListener('change', () => {
                el.value = nativeValue.get.call(native);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Campos de data/hora no formato brasileiro, inclusive os criados depois (modais de edição)
    enhanceBrazilianInputs(document);
    if (typeof MutationObserver !== 'undefined' && document.body) {
        new MutationObserver(() => enhanceBrazilianInputs(document)).observe(document.body, { childList: true, subtree: true });
    }

    // =================================================================
    // Avisos e confirmações dentro do app. Substituem alert()/confirm() do
    // navegador, que mostram "file://" e travam a página.
    // =================================================================
    const toastContainer = document.getElementById('toast-container');

    // type: 'info' | 'success' | 'error' | 'warning'. Opcional: um botão de ação (ex.: "Desfazer").
    function showToast(message, { type = 'info', actionLabel = '', onAction = null, duration } = {}) {
        if (!toastContainer || typeof document.createElement !== 'function') return () => {};
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const text = document.createElement('div');
        text.className = 'toast-text';
        text.textContent = message;
        toast.appendChild(text);
        let timer = null;
        const close = () => {
            clearTimeout(timer);
            if (toast.parentNode) toast.parentNode.removeChild(toast);
        };
        if (actionLabel && typeof onAction === 'function') {
            const action = document.createElement('button');
            action.type = 'button';
            action.className = 'toast-action';
            action.textContent = actionLabel;
            action.addEventListener('click', () => { close(); onAction(); });
            toast.appendChild(action);
        }
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', 'Fechar aviso');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', close);
        toast.appendChild(closeBtn);
        toastContainer.appendChild(toast);
        timer = setTimeout(close, duration ?? (type === 'error' ? 9000 : actionLabel ? 8000 : 4500));
        return close;
    }

    // Confirmação dentro do app. Resolve true (confirmou) ou false (cancelou/fechou).
    // extraLabel/onExtra: um terceiro botão que executa algo sem fechar (ex.: "Baixar backup antes").
    const confirmModal = document.getElementById('confirm-modal');
    let confirmDialogOpen = false;
    function askConfirm({ title = 'Confirmar', message = '', details = [], confirmLabel = 'Confirmar',
                          cancelLabel = 'Cancelar', danger = false, extraLabel = '', onExtra = null } = {}) {
        if (!confirmModal || typeof confirmModal.querySelector !== 'function' || !document.getElementById('confirm-ok').addEventListener) {
            return Promise.resolve(typeof confirm === 'function' ? confirm(`${title}\n\n${message}`) : true);
        }
        return new Promise(resolve => {
            const okBtn = document.getElementById('confirm-ok');
            const cancelBtn = document.getElementById('confirm-cancel');
            const extraBtn = document.getElementById('confirm-extra');
            const list = document.getElementById('confirm-details');
            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-message').textContent = message;
            list.innerHTML = '';
            details.forEach(d => { const li = document.createElement('li'); li.textContent = d; list.appendChild(li); });
            list.classList.toggle('hidden', details.length === 0);
            okBtn.textContent = confirmLabel;
            okBtn.classList.toggle('danger-btn', !!danger);
            cancelBtn.textContent = cancelLabel;
            extraBtn.textContent = extraLabel;
            extraBtn.classList.toggle('hidden', !extraLabel);

            const previouslyFocused = document.activeElement;
            const finish = (result) => {
                confirmModal.classList.add('hidden');
                confirmDialogOpen = false;
                okBtn.onclick = cancelBtn.onclick = extraBtn.onclick = confirmModal.onclick = null;
                document.removeEventListener('keydown', onKey, true);
                if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
                resolve(result);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
            };
            okBtn.onclick = () => finish(true);
            cancelBtn.onclick = () => finish(false);
            extraBtn.onclick = () => { if (typeof onExtra === 'function') onExtra(); };
            confirmModal.onclick = (e) => { if (e.target === confirmModal) finish(false); };
            document.addEventListener('keydown', onKey, true);

            confirmDialogOpen = true;
            confirmModal.classList.remove('hidden');
            (danger ? cancelBtn : okBtn).focus();
        });
    }

    // localStorage pode falhar (modo anônimo, bloqueio): preferências de tela não podem quebrar o app
    const prefs = {
        get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* ignora */ } },
        remove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignora */ } }
    };

    // ---------- Guia "Como usar" (pode ser escondido e reaberto pelo "❓ Ajuda") ----------
    const guideCard = document.getElementById('guia');
    function setGuideVisible(visible) {
        if (!guideCard || !guideCard.classList) return;
        guideCard.classList.toggle('hidden', !visible);
        if (visible) prefs.remove('med_rotations_guide_hidden');
        else prefs.set('med_rotations_guide_hidden', '1');
    }
    if (guideCard && guideCard.classList && prefs.get('med_rotations_guide_hidden') === '1') guideCard.classList.add('hidden');
    const hideGuideBtn = document.getElementById('hide-guide-btn');
    if (hideGuideBtn && hideGuideBtn.addEventListener) {
        hideGuideBtn.addEventListener('click', () => {
            setGuideVisible(false);
            showToast('Guia escondido. Para ver de novo, clique em "❓ Ajuda" no topo.');
        });
    }
    const showGuideLink = document.getElementById('show-guide-link');
    if (showGuideLink && showGuideLink.addEventListener) {
        showGuideLink.addEventListener('click', () => setGuideVisible(true));
    }

    // ---------- Progresso: ✓ nos passos concluídos (guia, números das seções e menu) ----------
    function updateProgress() {
        let schedule = null;
        try { schedule = lastGeneratedSchedule; } catch (e) { schedule = null; }
        const done = {
            periodo: !!(rotationConfig.startDate && rotationConfig.endDate),
            atividades: activities.length > 0,
            alunos: students.length > 0,
            gerar: !!schedule
        };
        const sectionOf = { periodo: 'section-periodo', atividades: 'section-atividades', alunos: 'section-alunos', gerar: 'section-gerar' };
        Object.keys(done).forEach((step, i) => {
            const li = guideCard && guideCard.querySelector ? guideCard.querySelector(`[data-step="${step}"]`) : null;
            if (li && li.classList) li.classList.toggle('done', done[step]);
            const section = document.getElementById(sectionOf[step]);
            const badge = section && section.querySelector ? section.querySelector('.step-badge') : null;
            if (badge && badge.classList) {
                badge.classList.toggle('done', done[step]);
                badge.textContent = done[step] ? '✓' : String(i + 1);
                badge.title = done[step] ? 'Passo concluído' : '';
            }
        });
    }

    // ---------- Aviso de escala desatualizada ----------
    function markScheduleStale() {
        let schedule = null;
        try { schedule = lastGeneratedSchedule; } catch (e) { return; }
        if (!schedule) return;
        prefs.set('med_rotations_schedule_stale', '1');
        const banner = document.getElementById('stale-banner');
        if (banner && banner.classList) banner.classList.remove('hidden');
    }
    function markScheduleFresh() {
        prefs.remove('med_rotations_schedule_stale');
        const banner = document.getElementById('stale-banner');
        if (banner && banner.classList) banner.classList.add('hidden');
    }

    function escapeHtml(v) {
        return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Rótulo amigável do tipo (o valor salvo continua "PLANTÃO"/"AMBULATORIO")
    function typeLabel(type) {
        return isPlantao(type) ? 'Plantão' : 'Ambulatório';
    }

    // Texto bruto digitado em um campo de data/hora (o .value só devolve datas válidas)
    function typedText(el) {
        if (!el) return '';
        try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            return String(desc.get.call(el) || '').trim();
        } catch (e) {
            return String(el.value || '').trim();
        }
    }

    const activityForm = document.getElementById('activity-form');
    const activitiesContainer = document.getElementById('activities-container');
    const studentForm = document.getElementById('student-form');
    const studentsContainer = document.getElementById('students-container');
    const saveGlobalBtn = document.getElementById('save-global-dates');
    const addBlackoutBtn = document.getElementById('add-blackout-btn');
    const currentBlackoutList = document.getElementById('current-blackout-list');
    const addExceptionBtn = document.getElementById('add-exception-btn');
    const currentExceptionsList = document.getElementById('current-exceptions-list');
    const addStudentExceptionBtn = document.getElementById('add-student-exception-btn');
    const currentStudentExceptionsList = document.getElementById('current-student-exceptions-list');
    const addStudentPreferredBtn = document.getElementById('add-student-preferred-btn');
    const currentStudentPreferredList = document.getElementById('current-student-preferred-list');
    
    // Modal elements
    const editModal = document.getElementById('edit-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    const closeModal = editModal.querySelector('.close-modal');

    // Data state
    let activities = [];
    let students = [];
    let currentExceptions = [];
    let currentStudentExceptions = [];
    let currentStudentPreferred = [];
    let currentBlackoutPeriods = [];
    let rotationConfig = {
        startDate: '',
        endDate: '',
        requiredHours: 0,
        twoGroupsEnabled: false,
        groupNames: ['Grupo 1', 'Grupo 2'],
        requiredHoursGroup1: 0,
        requiredHoursGroup2: 0,
        blackoutPeriods: []
    };

    // --- Slow page auto-scroll while dragging a student near the viewport edges ---
    const AUTOSCROLL_EDGE = 90;  // px from top/bottom edge that activates scrolling
    const AUTOSCROLL_SPEED = 2;  // px per frame (~120px/s) — intentionally slow
    let autoScrollDir = 0;
    let autoScrollRaf = null;

    function autoScrollStep() {
        if (autoScrollDir === 0) {
            autoScrollRaf = null;
            return;
        }
        window.scrollBy(0, autoScrollDir * AUTOSCROLL_SPEED);
        autoScrollRaf = requestAnimationFrame(autoScrollStep);
    }

    function stopAutoScroll() {
        autoScrollDir = 0;
    }

    document.addEventListener('dragover', (e) => {
        if (e.clientY < AUTOSCROLL_EDGE) {
            autoScrollDir = -1;
        } else if (e.clientY > window.innerHeight - AUTOSCROLL_EDGE) {
            autoScrollDir = 1;
        } else {
            autoScrollDir = 0;
        }
        if (autoScrollDir !== 0 && autoScrollRaf === null) {
            autoScrollRaf = requestAnimationFrame(autoScrollStep);
        }
    });

    document.addEventListener('dragend', stopAutoScroll);
    document.addEventListener('drop', stopAutoScroll);
    document.addEventListener('dragleave', (e) => {
        // Cursor left the window entirely
        if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
            stopAutoScroll();
        }
    });

    const DAY_TRANSLATIONS = {
        'Monday': 'Segunda-feira', 'Tuesday': 'Terça-feira', 'Wednesday': 'Quarta-feira',
        'Thursday': 'Quinta-feira', 'Friday': 'Sexta-feira', 'Saturday': 'Sábado', 'Sunday': 'Domingo'
    };

    const STUDENT_COLORS = [
        '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', 
        '#1abc9c', '#e67e22', '#34495e', '#d35400', '#c0392b',
        '#16a085', '#27ae60', '#2980b9', '#8e44ad', '#2c3e50',
        '#f39c12', '#7f8c8d'
    ];

    function getRandomColor() {
        return STUDENT_COLORS[Math.floor(Math.random() * STUDENT_COLORS.length)];
    }

    // --- Rodízio com 2 grupos de atividades ---

    function currentGroupNames() {
        const name1 = document.getElementById('group1-name').value.trim() || 'Grupo 1';
        const name2 = document.getElementById('group2-name').value.trim() || 'Grupo 2';
        return [name1, name2];
    }

    function groupDisplayName(activityGroupKey) {
        const names = (rotationConfig.groupNames && rotationConfig.groupNames.length === 2) ? rotationConfig.groupNames : ['Grupo 1', 'Grupo 2'];
        return activityGroupKey === '2' ? names[1] : names[0];
    }

    function updateTwoGroupsUI() {
        const enabled = document.getElementById('two-groups-toggle').checked;
        document.getElementById('single-hours-row').classList.toggle('hidden', enabled);
        document.getElementById('two-groups-row').classList.toggle('hidden', !enabled);

        const [name1, name2] = currentGroupNames();
        document.querySelectorAll('.group-hours-label').forEach((el, idx) => {
            el.textContent = idx === 0 ? name1 : name2;
        });

        const groupField = document.getElementById('activity-group-field');
        const groupSelect = document.getElementById('activity-group');
        groupField.classList.toggle('hidden', !enabled);
        groupSelect.required = enabled;
        const previousValue = groupSelect.value;
        groupSelect.innerHTML = `<option value="1">${name1}</option><option value="2">${name2}</option>`;
        if (previousValue) groupSelect.value = previousValue;

        renderActivities();
    }

    // Load data from localStorage
    const savedActivities = localStorage.getItem('med_rotations_activities');
    if (savedActivities) {
        activities = JSON.parse(savedActivities);
        normalizeBackupFormats({ activities });
        // Ensure all activities have a type (for backward compatibility) and trim names
        activities.forEach(a => {
            if (!a.type) a.type = 'PLANTÃO';
            if (a.name) a.name = a.name.trim();
        });
    }

    const savedStudents = localStorage.getItem('med_rotations_students');
    if (savedStudents) {
        students = JSON.parse(savedStudents);
        normalizeBackupFormats({ students });
        // Ensure all students have a color and affinity group
        let updated = false;
        students.forEach(s => {
            if (!s.color) {
                s.color = getRandomColor();
                updated = true;
            }
            if (!s.affinityGroup) {
                s.affinityGroup = 'A';
                updated = true;
            }
        });
        if (updated) saveStudents();
    }

    const savedConfig = localStorage.getItem('med_rotations_config');
    if (savedConfig) {
        rotationConfig = JSON.parse(savedConfig);
        normalizeBackupFormats({ config: rotationConfig });
        document.getElementById('rotation-start').value = rotationConfig.startDate || '';
        document.getElementById('rotation-end').value = rotationConfig.endDate || '';
        document.getElementById('required-hours').value = rotationConfig.requiredHours || '';
        document.getElementById('two-groups-toggle').checked = !!rotationConfig.twoGroupsEnabled;
        document.getElementById('group1-name').value = (rotationConfig.groupNames && rotationConfig.groupNames[0]) || 'Grupo 1';
        document.getElementById('group2-name').value = (rotationConfig.groupNames && rotationConfig.groupNames[1]) || 'Grupo 2';
        document.getElementById('group1-hours').value = rotationConfig.requiredHoursGroup1 || '';
        document.getElementById('group2-hours').value = rotationConfig.requiredHoursGroup2 || '';
        currentBlackoutPeriods = [...(rotationConfig.blackoutPeriods || [])];
        renderBlackoutChips();
    }
    updateTwoGroupsUI();

    document.getElementById('two-groups-toggle').addEventListener('change', updateTwoGroupsUI);
    document.getElementById('group1-name').addEventListener('input', updateTwoGroupsUI);
    document.getElementById('group2-name').addEventListener('input', updateTwoGroupsUI);

    renderActivities();
    renderStudents();

    // Toggle Activities List
    const toggleActivitiesBtn = document.getElementById('toggle-activities');
    if (toggleActivitiesBtn) {
        toggleActivitiesBtn.addEventListener('click', () => {
            const content = document.getElementById('activities-container');
            toggleActivitiesBtn.classList.toggle('active');
            content.classList.toggle('hidden');
        });
    }

    // Toggle Students List
    const toggleStudentsBtn = document.getElementById('toggle-students');
    if (toggleStudentsBtn) {
        toggleStudentsBtn.addEventListener('click', () => {
            const content = document.getElementById('students-container');
            toggleStudentsBtn.classList.toggle('active');
            content.classList.toggle('hidden');
        });
    }

    // Em telas largas as listas ficam ao lado dos formulários: começam abertas
    if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 1200px)').matches) {
        [['toggle-activities', 'activities-container'], ['toggle-students', 'students-container']].forEach(([btnId, contentId]) => {
            const btn = document.getElementById(btnId);
            const content = document.getElementById(contentId);
            if (btn && content && content.classList.contains('hidden')) {
                btn.classList.add('active');
                content.classList.remove('hidden');
            }
        });
    }

    // Toggle Rules List
    const toggleRulesBtn = document.getElementById('toggle-rules');
    if (toggleRulesBtn) {
        toggleRulesBtn.addEventListener('click', () => {
            const content = document.getElementById('rules-container');
            toggleRulesBtn.classList.toggle('active');
            content.classList.toggle('hidden');
        });
    }

    // Configurações do período: salvam sozinhas ao mudar qualquer campo (o botão continua existindo)
    const configStatus = document.getElementById('config-save-status');
    let configStatusTimer = null;
    function flashConfigSaved(text = '✓ Salvo automaticamente') {
        if (!configStatus) return;
        configStatus.textContent = text;
        configStatus.classList.add('visible');
        clearTimeout(configStatusTimer);
        configStatusTimer = setTimeout(() => configStatus.classList.remove('visible'), 2500);
    }

    // Adiciona um período sem atividades que foi digitado mas não "Adicionado"
    function commitPendingBlackout() {
        const startEl = document.getElementById('blackout-start');
        if (!typedText(startEl)) return true;
        return addBlackoutFromInputs();
    }

    function saveConfig({ announce = false } = {}) {
        const startEl = document.getElementById('rotation-start');
        const endEl = document.getElementById('rotation-end');
        // Data digitada pela metade/errada: não salva por cima do valor anterior
        if ((typedText(startEl) && !startEl.value) || (typedText(endEl) && !endEl.value)) {
            if (announce) showToast('Confira as datas do período: use o formato dd/mm/aaaa.', { type: 'error' });
            return false;
        }
        if (startEl.value && endEl.value && endEl.value < startEl.value) {
            showToast('A data de término precisa ser depois da data de início.', { type: 'error' });
            return false;
        }
        // Feriado digitado e não "adicionado" só entra no clique em Salvar (no autosave ele ainda pode estar sendo digitado)
        if (announce && !commitPendingBlackout()) return false;
        saveConfigValues();
        if (announce) showToast('✅ Configurações salvas.', { type: 'success' });
        else flashConfigSaved();
        markScheduleStale();
        updateProgress();
        return true;
    }

    ['rotation-start', 'rotation-end', 'required-hours', 'two-groups-toggle', 'group1-name', 'group1-hours', 'group2-name', 'group2-hours']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el && el.addEventListener) el.addEventListener('change', () => saveConfig());
        });

    saveGlobalBtn.addEventListener('click', () => saveConfig({ announce: true }));

    function saveConfigValues() {
        rotationConfig.startDate = document.getElementById('rotation-start').value;
        rotationConfig.endDate = document.getElementById('rotation-end').value;
        rotationConfig.requiredHours = parseFloat(document.getElementById('required-hours').value) || 0;
        rotationConfig.twoGroupsEnabled = document.getElementById('two-groups-toggle').checked;
        rotationConfig.groupNames = currentGroupNames();
        rotationConfig.requiredHoursGroup1 = parseFloat(document.getElementById('group1-hours').value) || 0;
        rotationConfig.requiredHoursGroup2 = parseFloat(document.getElementById('group2-hours').value) || 0;
        rotationConfig.blackoutPeriods = [...currentBlackoutPeriods];
        localStorage.setItem('med_rotations_config', JSON.stringify(rotationConfig));
    }

    // Schedule-wide blackout periods: no activity happens for anyone in these date ranges.
    function renderBlackoutChips() {
        currentBlackoutList.innerHTML = '';
        currentBlackoutPeriods.forEach((bp, index) => {
            const tag = document.createElement('span');
            tag.className = 'tag exception';
            tag.innerHTML = `
                ${bp.start === bp.end ? formatDateBR(bp.start) : `${formatDateBR(bp.start)} a ${formatDateBR(bp.end)}`}
                <span class="remove-blackout-tag" data-index="${index}" role="button" title="Remover">&times;</span>
            `;
            currentBlackoutList.appendChild(tag);
        });

        document.querySelectorAll('.remove-blackout-tag').forEach(span => {
            span.onclick = (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                currentBlackoutPeriods.splice(idx, 1);
                renderBlackoutChips();
                saveConfig();
            };
        });
    }

    function addBlackoutFromInputs() {
        const startInput = document.getElementById('blackout-start');
        const endInput = document.getElementById('blackout-end');
        const startValue = startInput.value;
        const endValue = endInput.value || startValue;

        if (!startValue) {
            showToast(typedText(startInput) ? 'Data inválida: use o formato dd/mm/aaaa.' : 'Escolha pelo menos a data de início do recesso/feriado.', { type: 'error' });
            if (startInput.focus) startInput.focus();
            return false;
        }
        if (typedText(endInput) && !endInput.value) {
            showToast('A data final está incompleta: use o formato dd/mm/aaaa (ou deixe vazia para um dia só).', { type: 'error' });
            return false;
        }
        if (endValue < startValue) {
            showToast('A data final do período precisa ser igual ou depois da data inicial.', { type: 'error' });
            return false;
        }
        if (!currentBlackoutPeriods.some(bp => bp.start === startValue && bp.end === endValue)) {
            currentBlackoutPeriods.push({ start: startValue, end: endValue });
            currentBlackoutPeriods.sort((a, b) => a.start.localeCompare(b.start));
        }
        renderBlackoutChips();
        startInput.value = '';
        endInput.value = '';
        return true;
    }

    addBlackoutBtn.addEventListener('click', () => {
        if (addBlackoutFromInputs()) saveConfig();
    });

    // Activity exceptions can be a single date ("YYYY-MM-DD") or an interval
    // ({start, end}) covering a range of days the activity won't happen.
    function formatExceptionLabel(exc) {
        if (typeof exc === 'string') return formatDateBR(exc);
        return exc.start === exc.end ? formatDateBR(exc.start) : `${formatDateBR(exc.start)} a ${formatDateBR(exc.end)}`;
    }

    // Add exception handler
    // Adiciona a exceção digitada nos campos. Retorna false se houver erro (já avisado ao usuário).
    function addActivityExceptionFromInputs({ quietIfEmpty = false } = {}) {
        const dateInput = document.getElementById('exception-date');
        const endInput = document.getElementById('exception-date-end');
        const startValue = dateInput.value;
        const endValue = endInput.value;

        if (!startValue) {
            if (typedText(dateInput)) {
                showToast('Data da exceção inválida: use o formato dd/mm/aaaa.', { type: 'error' });
                return false;
            }
            if (!quietIfEmpty) showToast('Escolha a data em que a atividade não acontece.', { type: 'warning' });
            return quietIfEmpty;
        }
        if (typedText(endInput) && !endValue) {
            showToast('A data final da exceção está incompleta (dd/mm/aaaa). Deixe vazia para um dia só.', { type: 'error' });
            return false;
        }

        if (endValue && endValue !== startValue) {
            if (endValue < startValue) {
                showToast('A data final da exceção precisa ser igual ou depois da data inicial.', { type: 'error' });
                return false;
            }
            currentExceptions.push({ start: startValue, end: endValue });
        } else if (!currentExceptions.includes(startValue)) {
            currentExceptions.push(startValue);
        }

        renderExceptionChips();
        dateInput.value = '';
        endInput.value = '';
        return true;
    }

    addExceptionBtn.addEventListener('click', () => addActivityExceptionFromInputs());

    function renderExceptionChips() {
        currentExceptionsList.innerHTML = '';
        currentExceptions.forEach((exc, index) => {
            const tag = document.createElement('span');
            tag.className = 'tag exception';
            tag.innerHTML = `
                ${formatExceptionLabel(exc)}
                <span class="remove-tag" data-index="${index}">&times;</span>
            `;
            currentExceptionsList.appendChild(tag);
        });

        // Add removal listeners
        document.querySelectorAll('.remove-tag').forEach(span => {
            span.onclick = (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                currentExceptions.splice(idx, 1);
                renderExceptionChips();
            };
        });
    }

    // Form submission handler
    // Carga horária calculada pelo horário (até o usuário mudar à mão)
    function hoursBetween(start, end) {
        if (!start || !end) return null;
        const [sh, sm] = start.split(':').map(Number);
        const [eh, em] = end.split(':').map(Number);
        let minutes = (eh * 60 + em) - (sh * 60 + sm);
        if (minutes <= 0) minutes += 24 * 60;     // plantão que vira a noite (ex.: 19:00 → 07:00)
        return Math.round(minutes / 30) / 2;      // arredonda para meia hora
    }

    function setupAutoHours(startEl, endEl, hoursEl, { startsAuto = true } = {}) {
        if (!startEl || !endEl || !hoursEl || !hoursEl.addEventListener) return () => {};
        let auto = startsAuto;
        const fill = () => {
            const h = hoursBetween(startEl.value, endEl.value);
            if (auto && h != null) hoursEl.value = h;
        };
        hoursEl.addEventListener('input', () => { auto = hoursEl.value === ''; });
        ['change', 'blur'].forEach(ev => { startEl.addEventListener(ev, fill); endEl.addEventListener(ev, fill); });
        return () => { auto = true; };   // reset (ex.: depois de limpar o formulário)
    }

    const resetActivityAutoHours = setupAutoHours(
        document.getElementById('start-hour'), document.getElementById('end-hour'), document.getElementById('hours-count'));

    // Validação comum (formulário e janela de edição). Retorna a mensagem de erro ou null.
    function validateActivityFields({ type, startTime, endTime, studentsCount, minStudents, hoursCount }) {
        if (!type) return 'Escolha o tipo da atividade: Plantão ou Ambulatório.';
        if (!startTime || !endTime) return 'Preencha o horário de início e de término no formato 24h (ex.: 07:00 e 19:00).';
        if (startTime === endTime) return 'O horário de término precisa ser diferente do horário de início.';
        if (!Number.isInteger(studentsCount) || studentsCount < 1) return 'O máximo de alunos precisa ser pelo menos 1.';
        if (minStudents > studentsCount) return `O mínimo de alunos (${minStudents}) não pode ser maior que o máximo (${studentsCount}).`;
        if (!(hoursCount > 0)) return 'Informe a carga horária da atividade (em horas, ex.: 4 ou 4.5).';
        return null;
    }

    activityForm.addEventListener('submit', (e) => {
        e.preventDefault();

        // Exceção digitada mas não "adicionada": entra junto (antes era perdida em silêncio)
        if (!addActivityExceptionFromInputs({ quietIfEmpty: true })) return;

        // Extract values
        const minStudentsInput = parseInt(document.getElementById('min-students-number').value);
        const newActivity = {
            id: Date.now(),
            day: document.getElementById('day').value,
            startTime: document.getElementById('start-hour').value,
            endTime: document.getElementById('end-hour').value,
            name: document.getElementById('activity-name').value,
            type: document.getElementById('activity-type').value,
            location: document.getElementById('location').value,
            studentsCount: parseInt(document.getElementById('students-number').value),
            minStudents: Number.isNaN(minStudentsInput) ? 1 : minStudentsInput,
            hoursCount: parseFloat(document.getElementById('hours-count').value),
            exceptions: [...currentExceptions]
        };
        if (rotationConfig.twoGroupsEnabled) {
            newActivity.activityGroup = document.getElementById('activity-group').value;
        }

        newActivity.name = newActivity.name.trim();
        newActivity.location = newActivity.location.trim();
        const problem = validateActivityFields(newActivity);
        if (problem) {
            showToast(problem, { type: 'error' });
            return;
        }

        activities.push(newActivity);
        saveActivities();
        renderActivities();

        const overnight = newActivity.endTime < newActivity.startTime ? ' (vira a noite)' : '';
        const shortPlantao = isPlantao(newActivity.type) && newActivity.hoursCount <= 6
            ? `\nObs.: está marcada como PLANTÃO com ${newActivity.hoursCount}h. Se for um ambulatório, edite e troque o tipo.` : '';
        showToast(`✅ "${newActivity.name}" adicionada: ${DAY_TRANSLATIONS[newActivity.day]}, ${newActivity.startTime}–${newActivity.endTime}${overnight}. O formulário continua preenchido: para outra parecida, mude só o dia e o horário.${shortPlantao}`, { type: shortPlantao ? 'warning' : 'success', duration: shortPlantao ? 10000 : 6500 });

        // Mantém os campos preenchidos e limpa só o horário: cadastrar a mesma atividade
        // em outro dia/horário (o caso mais comum) fica bem mais rápido
        document.getElementById('start-hour').value = '';
        document.getElementById('end-hour').value = '';
        document.getElementById('hours-count').value = '';
        resetActivityAutoHours();
        currentExceptions = [];
        renderExceptionChips();
        const dayField = document.getElementById('day');
        if (dayField && dayField.focus) dayField.focus();
    });

    // Lê "data + horário opcional" (indisponibilidade/preferência do aluno) e valida.
    // Retorna { entry } se ok, { empty: true } se nada foi digitado, ou { error: true } (já avisado).
    function readDateTimeEntry(dateId, startId, endId, what) {
        const dateInput = document.getElementById(dateId);
        const startInput = document.getElementById(startId);
        const endInput = document.getElementById(endId);
        const date = dateInput.value;
        const startTime = startInput.value;
        const endTime = endInput.value;
        const anyTyped = typedText(dateInput) || typedText(startInput) || typedText(endInput);

        if (!date) {
            if (!anyTyped) return { empty: true };
            showToast(typedText(dateInput) ? `Data da ${what} inválida: use dd/mm/aaaa.` : `Escolha a data da ${what}.`, { type: 'error' });
            return { error: true };
        }
        if ((typedText(startInput) && !startTime) || (typedText(endInput) && !endTime)) {
            showToast(`Horário da ${what} inválido: use 24h, ex.: 07:00 ou 13:30.`, { type: 'error' });
            return { error: true };
        }
        if (!!startTime !== !!endTime) {
            showToast(`Preencha o horário de início e de fim da ${what}, ou deixe os dois vazios para o dia inteiro.`, { type: 'error' });
            return { error: true };
        }
        if (startTime && endTime <= startTime) {
            showToast(`O horário final da ${what} precisa ser depois do inicial.`, { type: 'error' });
            return { error: true };
        }
        const clear = () => { dateInput.value = ''; startInput.value = ''; endInput.value = ''; };
        return { entry: { date, startTime, endTime }, clear };
    }

    function addStudentEntry(list, ids, what, render, { quietIfEmpty = false } = {}) {
        const result = readDateTimeEntry(...ids, what);
        if (result.error) return false;
        if (result.empty) {
            if (!quietIfEmpty) showToast(`Escolha a data da ${what} antes de adicionar.`, { type: 'warning' });
            return quietIfEmpty;
        }
        const e = result.entry;
        if (!list.some(x => x.date === e.date && x.startTime === e.startTime && x.endTime === e.endTime)) {
            list.push(e);
            list.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
        }
        render();
        result.clear();
        return true;
    }

    const STUDENT_EXC_IDS = ['student-exception-date', 'student-exc-start', 'student-exc-end'];
    const STUDENT_PREF_IDS = ['student-preferred-date', 'student-pref-start', 'student-pref-end'];

    addStudentExceptionBtn.addEventListener('click', () => {
        addStudentEntry(currentStudentExceptions, STUDENT_EXC_IDS, 'indisponibilidade', renderStudentExceptionChips);
    });

    function renderStudentExceptionChips() {
        currentStudentExceptionsList.innerHTML = '';
        currentStudentExceptions.forEach((exc, index) => {
            const timeInfo = (exc.startTime && exc.endTime) ? ` (${exc.startTime}-${exc.endTime})` : '';
            const tag = document.createElement('span');
            tag.className = 'tag exception';
            tag.innerHTML = `
                ${formatDateBR(exc.date)}${timeInfo} 
                <span class="remove-student-tag" data-index="${index}">&times;</span>
            `;
            currentStudentExceptionsList.appendChild(tag);
        });

        document.querySelectorAll('.remove-student-tag').forEach(span => {
            span.onclick = (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                currentStudentExceptions.splice(idx, 1);
                renderStudentExceptionChips();
            };
        });
    }

    // Student preferred date handler
    addStudentPreferredBtn.addEventListener('click', () => {
        addStudentEntry(currentStudentPreferred, STUDENT_PREF_IDS, 'preferência', renderStudentPreferredChips);
    });

    function renderStudentPreferredChips() {
        currentStudentPreferredList.innerHTML = '';
        currentStudentPreferred.forEach((pref, index) => {
            const timeInfo = (pref.startTime && pref.endTime) ? ` (${pref.startTime}-${pref.endTime})` : '';
            const tag = document.createElement('span');
            tag.className = 'tag preferred';
            tag.innerHTML = `
                ${formatDateBR(pref.date)}${timeInfo} 
                <span class="remove-preferred-tag" data-index="${index}">&times;</span>
            `;
            currentStudentPreferredList.appendChild(tag);
        });

        document.querySelectorAll('.remove-preferred-tag').forEach(span => {
            span.onclick = (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                currentStudentPreferred.splice(idx, 1);
                renderStudentPreferredChips();
            };
        });
    }

    // Student form submission
    // Nomes iguais confundem a escala (ela identifica alunos pelo nome)
    function findStudentByName(name, exceptId = null) {
        const key = name.trim().toLocaleLowerCase('pt-BR');
        return students.find(s => s.id !== exceptId && String(s.name).trim().toLocaleLowerCase('pt-BR') === key);
    }

    studentForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const typedName = document.getElementById('student-name').value.trim().replace(/\s+/g, ' ');
        if (!typedName) {
            showToast('Digite o nome do aluno.', { type: 'error' });
            return;
        }
        if (findStudentByName(typedName)) {
            showToast(`Já existe um aluno chamado "${typedName}". Use um nome diferente (ex.: com o sobrenome).`, { type: 'error' });
            return;
        }
        // Datas digitadas mas não "adicionadas" entram junto (antes eram perdidas em silêncio)
        if (!addStudentEntry(currentStudentPreferred, STUDENT_PREF_IDS, 'preferência', renderStudentPreferredChips, { quietIfEmpty: true })) return;
        if (!addStudentEntry(currentStudentExceptions, STUDENT_EXC_IDS, 'indisponibilidade', renderStudentExceptionChips, { quietIfEmpty: true })) return;

        const newStudent = {
            id: Date.now(),
            name: typedName,
            affinityGroup: document.getElementById('student-affinity').value || 'A',
            exceptions: [...currentStudentExceptions],
            preferredDates: [...currentStudentPreferred],
            color: getRandomColor()
        };

        students.push(newStudent);
        saveStudents();
        renderStudents();
        showToast(`✅ ${newStudent.name} adicionado(a).`, { type: 'success' });

        // Reset
        studentForm.reset();
        currentStudentExceptions = [];
        currentStudentPreferred = [];
        renderStudentExceptionChips();
        renderStudentPreferredChips();
        const nameField = document.getElementById('student-name');
        if (nameField && nameField.focus) nameField.focus();
    });

    function renderStudents() {
        if (!studentsContainer) return;

        const studentsCountBadge = document.getElementById('students-count');
        if (studentsCountBadge) studentsCountBadge.textContent = students.length;

        if (students.length === 0) {
            studentsContainer.innerHTML = '<p class="empty-msg">Nenhum aluno ainda. Digite o nome no formulário e clique em "Adicionar Aluno".</p>';
            return;
        }

        studentsContainer.innerHTML = '';

        students.forEach(student => {
            const card = document.createElement('div');
            card.className = 'student-card';
            
            let exceptionsHtml = '';
            if (student.exceptions && student.exceptions.length > 0) {
                exceptionsHtml = `
                    <div class="activity-exceptions">
                        <strong>Exceções:</strong>
                        ${student.exceptions.map(exc => {
                            const val = typeof exc === 'string' ? formatDateBR(exc) : formatDateBR(exc.date) + formatTimeRangeSuffix(exc);
                            return `<span class="exception-tag">${val}</span>`;
                        }).join('')}
                    </div>
                `;
            }

            let preferredHtml = '';
            if (student.preferredDates && student.preferredDates.length > 0) {
                preferredHtml = `
                    <div class="activity-preferences">
                        <strong>Preferências:</strong>
                        ${student.preferredDates.map(pref => {
                            const val = typeof pref === 'string' ? formatDateBR(pref) : formatDateBR(pref.date) + formatTimeRangeSuffix(pref);
                            return `<span class="preferred-tag">${val}</span>`;
                        }).join('')}
                    </div>
                `;
            }

            card.innerHTML = `
                <div class="student-info-row">
                    <div class="student-color-dot" style="background-color: ${student.color}"></div>
                    <div class="activity-info">
                        <h3>${student.name} ${student.affinityGroup ? `<span class="affinity-badge">👥 ${student.affinityGroup}</span>` : ''}</h3>
                        ${exceptionsHtml}
                        ${preferredHtml}
                    </div>
                </div>
                <div class="card-actions">
                    <button class="edit-student-btn edit-btn" data-id="${student.id}">✏️ Editar</button>
                    <button class="delete-student-btn delete-btn" data-id="${student.id}">🗑️ Excluir</button>
                </div>
            `;

            studentsContainer.appendChild(card);
        });

        document.querySelectorAll('.delete-student-btn').forEach(btn => {
            btn.onclick = (e) => {
                const id = parseInt(e.target.getAttribute('data-id'));
                deleteStudent(id);
            };
        });

        document.querySelectorAll('.edit-student-btn').forEach(btn => {
            btn.onclick = (e) => {
                const id = parseInt(e.target.getAttribute('data-id'));
                openEditStudentModal(id);
            };
        });
    }

    function openEditStudentModal(id) {
        const student = students.find(s => s.id === id);
        if (!student) return;

        // Local state for modal
        let modalExceptions = JSON.parse(JSON.stringify(student.exceptions || []));
        let modalPreferred = JSON.parse(JSON.stringify(student.preferredDates || []));

        modalTitle.textContent = 'Editar Aluno';
        modalBody.innerHTML = `
            <form id="edit-student-form">
                <div class="form-group">
                    <label for="edit-student-name">Nome do Aluno</label>
                    <input type="text" id="edit-student-name" value="${escapeHtml(student.name)}" required>
                </div>
                <div class="form-group">
                    <label>Grupo de Afinidade</label>
                    <select id="edit-student-affinity" required>
                        <option value="A" ${student.affinityGroup === 'A' || !student.affinityGroup ? 'selected' : ''}>A</option>
                        <option value="B" ${student.affinityGroup === 'B' ? 'selected' : ''}>B</option>
                        <option value="C" ${student.affinityGroup === 'C' ? 'selected' : ''}>C</option>
                    </select>
                </div>

                <div class="modal-section exceptions-section">
                    <h4>Indisponibilidades (dias em que não pode)</h4>
                    <p class="field-hint">Horário vazio = dia inteiro.</p>
                    <div class="form-row time-input-row">
                        <input type="date" id="modal-exc-date">
                        <div class="time-range">
                            <input type="time" id="modal-exc-start">
                            <span>até</span>
                            <input type="time" id="modal-exc-end">
                        </div>
                        <button type="button" id="modal-add-exc" class="secondary-btn">Adicionar</button>
                    </div>
                    <div id="modal-exc-list" class="tag-container"></div>
                </div>

                <div class="modal-section preferences-section">
                    <h4>Preferências (dias em que gostaria de estar)</h4>
                    <div class="form-row time-input-row">
                        <input type="date" id="modal-pref-date">
                        <div class="time-range">
                            <input type="time" id="modal-pref-start">
                            <span>até</span>
                            <input type="time" id="modal-pref-end">
                        </div>
                        <button type="button" id="modal-add-pref" class="secondary-btn preferred-btn">Adicionar</button>
                    </div>
                    <div id="modal-pref-list" class="tag-container"></div>
                </div>

                <button type="submit">💾 Salvar Alterações</button>
            </form>
        `;
        enhanceBrazilianInputs(modalBody);

        const renderModalChips = () => {
            const excList = document.getElementById('modal-exc-list');
            excList.innerHTML = '';
            modalExceptions.forEach((exc, idx) => {
                const timeInfo = (exc.startTime && exc.endTime) ? ` (${exc.startTime}-${exc.endTime})` : '';
                const tag = document.createElement('span');
                tag.className = 'tag exception';
                tag.innerHTML = `${formatDateBR(exc.date)}${timeInfo} <span class="remove-modal-tag" data-idx="${idx}">&times;</span>`;
                excList.appendChild(tag);
            });

            const prefList = document.getElementById('modal-pref-list');
            prefList.innerHTML = '';
            modalPreferred.forEach((pref, idx) => {
                const timeInfo = (pref.startTime && pref.endTime) ? ` (${pref.startTime}-${pref.endTime})` : '';
                const tag = document.createElement('span');
                tag.className = 'tag preferred';
                tag.innerHTML = `${formatDateBR(pref.date)}${timeInfo} <span class="remove-modal-tag" data-idx="${idx}">&times;</span>`;
                prefList.appendChild(tag);
            });

            // Re-add click listeners
            modalBody.querySelectorAll('.remove-modal-tag').forEach(span => {
                span.onclick = (e) => {
                    const isExc = e.target.closest('.tag').classList.contains('exception');
                    const idx = parseInt(e.target.getAttribute('data-idx'));
                    if (isExc) modalExceptions.splice(idx, 1);
                    else modalPreferred.splice(idx, 1);
                    renderModalChips();
                };
            });
        };

        renderModalChips();

        const MODAL_EXC_IDS = ['modal-exc-date', 'modal-exc-start', 'modal-exc-end'];
        const MODAL_PREF_IDS = ['modal-pref-date', 'modal-pref-start', 'modal-pref-end'];
        document.getElementById('modal-add-exc').onclick = () =>
            addStudentEntry(modalExceptions, MODAL_EXC_IDS, 'indisponibilidade', renderModalChips);
        document.getElementById('modal-add-pref').onclick = () =>
            addStudentEntry(modalPreferred, MODAL_PREF_IDS, 'preferência', renderModalChips);

        editModal.classList.remove('hidden');

        document.getElementById('edit-student-form').onsubmit = (e) => {
            e.preventDefault();
            const newName = document.getElementById('edit-student-name').value.trim().replace(/\s+/g, ' ');
            if (!newName) {
                showToast('O nome do aluno não pode ficar vazio.', { type: 'error' });
                return;
            }
            if (findStudentByName(newName, student.id)) {
                showToast(`Já existe outro aluno chamado "${newName}".`, { type: 'error' });
                return;
            }
            // Datas digitadas mas não "adicionadas" entram junto
            if (!addStudentEntry(modalExceptions, MODAL_EXC_IDS, 'indisponibilidade', renderModalChips, { quietIfEmpty: true })) return;
            if (!addStudentEntry(modalPreferred, MODAL_PREF_IDS, 'preferência', renderModalChips, { quietIfEmpty: true })) return;

            const oldName = student.name;
            const newAffinity = document.getElementById('edit-student-affinity').value || 'A';
            const rulesChanged = student.affinityGroup !== newAffinity ||
                JSON.stringify(student.exceptions || []) !== JSON.stringify(modalExceptions) ||
                JSON.stringify(student.preferredDates || []) !== JSON.stringify(modalPreferred);

            student.name = newName;
            student.affinityGroup = newAffinity;
            student.exceptions = modalExceptions;
            student.preferredDates = modalPreferred;
            saveStudents({ stale: rulesChanged });
            if (oldName !== newName) renameStudentEverywhere(oldName, newName);
            renderStudents();
            closeModalHandler();
            showToast(`✅ ${newName} atualizado(a).`, { type: 'success' });
        };
    }

    function deleteStudent(id) {
        const index = students.findIndex(s => s.id === id);
        if (index === -1) return;
        const removed = students[index];
        students.splice(index, 1);
        saveStudents();
        renderStudents();
        showToast(`${removed.name} excluído(a) da lista de alunos.`, {
            actionLabel: 'Desfazer',
            onAction: () => {
                students.splice(Math.min(index, students.length), 0, removed);
                saveStudents();
                renderStudents();
            }
        });
    }

    function saveStudents({ stale = true } = {}) {
        localStorage.setItem('med_rotations_students', JSON.stringify(students));
        if (stale) markScheduleStale();
        updateProgress();
    }

    // Renomear um aluno: a escala e os 📌 guardam o nome, então atualiza tudo junto
    function renameStudentEverywhere(oldName, newName) {
        pinnedAssignments.forEach(p => { if (p.studentName === oldName) p.studentName = newName; });
        savePins();
        if (lastGeneratedSchedule && Array.isArray(lastGeneratedSchedule.finalSchedule)) {
            lastGeneratedSchedule.finalSchedule.forEach(day => (day.slots || []).forEach(slot => {
                slot.assigned = (slot.assigned || []).map(n => n === oldName ? newName : n);
            }));
            (lastGeneratedSchedule.studentStats || []).forEach(st => { if (st.name === oldName) st.name = newName; });
            persistSchedule();
            renderGeneratedResults(lastGeneratedSchedule);
            renderCalendarView(lastGeneratedSchedule.finalSchedule);
            renderStudentView(lastGeneratedSchedule.finalSchedule);
        }
    }

    // Render function
    function renderActivities() {
        const activitiesCountBadge = document.getElementById('activities-count');
        if (activitiesCountBadge) activitiesCountBadge.textContent = activities.length;

        if (activities.length === 0) {
            activitiesContainer.innerHTML = '<p class="empty-msg">Nenhuma atividade ainda. Comece pelo plantão ou ambulatório de segunda-feira e vá adicionando a semana.</p>';
            return;
        }

        const dayOrder = {
            'Monday': 1, 'Tuesday': 2, 'Wednesday': 3, 'Thursday': 4, 
            'Friday': 5, 'Saturday': 6, 'Sunday': 7
        };

        const sortedActivities = [...activities].sort((a, b) => {
            if (dayOrder[a.day] !== dayOrder[b.day]) {
                return dayOrder[a.day] - dayOrder[b.day];
            }
            return a.startTime.localeCompare(b.startTime);
        });

        activitiesContainer.innerHTML = '';

        sortedActivities.forEach(activity => {
            const card = document.createElement('div');
            card.className = 'activity-card';
            
            let exceptionsHtml = '';
            if (activity.exceptions && activity.exceptions.length > 0) {
                exceptionsHtml = `
                    <div class="activity-exceptions">
                        <strong>Exceções:</strong>
                        ${activity.exceptions.map(ex => `<span class="exception-tag">${formatExceptionLabel(ex)}</span>`).join('')}
                    </div>
                `;
            }

            const groupBadge = rotationConfig.twoGroupsEnabled
                ? `<span class="group-badge">${groupDisplayName(activity.activityGroup || '1')}</span>`
                : '';

            card.innerHTML = `
                <div class="activity-info">
                    <h3>${escapeHtml(activity.name)} <span class="type-badge ${isPlantao(activity.type) ? 'type-plantao' : ''}">${typeLabel(activity.type)}</span>${groupBadge}</h3>
                    <div class="activity-details">
                        <span><strong>Dia:</strong> ${DAY_TRANSLATIONS[activity.day]}</span>
                        <span><strong>Horário:</strong> ${activity.startTime} - ${activity.endTime}</span>
                        <span><strong>Local:</strong> ${escapeHtml(activity.location)}</span>
                        <span><strong>Alunos:</strong> ${activity.minStudents ?? 1}-${activity.studentsCount}</span>
                        <span><strong>Horas:</strong> ${activity.hoursCount}</span>
                    </div>
                    ${exceptionsHtml}
                </div>
                <div class="card-actions">
                    <button class="edit-activity-btn edit-btn" data-id="${activity.id}">✏️ Editar</button>
                    <button class="delete-btn" data-id="${activity.id}">🗑️ Excluir</button>
                </div>
            `;

            activitiesContainer.appendChild(card);
        });

        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.onclick = (e) => {
                const id = parseInt(e.target.getAttribute('data-id'));
                deleteActivity(id);
            };
        });

        document.querySelectorAll('.edit-activity-btn').forEach(btn => {
            btn.onclick = (e) => {
                const id = parseInt(e.target.getAttribute('data-id'));
                openEditActivityModal(id);
            };
        });
    }

    function openEditActivityModal(id) {
        const activity = activities.find(a => a.id === id);
        if (!activity) return;

        // Local state for modal
        let modalExceptions = [...(activity.exceptions || [])];

        modalTitle.textContent = 'Editar Atividade';
        modalBody.innerHTML = `
            <form id="edit-activity-form">
                <div class="form-row">
                    <div class="form-group">
                        <label for="edit-activity-day">Dia da Semana</label>
                        <select id="edit-activity-day" required>
                            ${Object.keys(DAY_TRANSLATIONS).map(d => `<option value="${d}" ${activity.day === d ? 'selected' : ''}>${DAY_TRANSLATIONS[d]}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="edit-start-hour">Início</label>
                        <input type="time" id="edit-start-hour" value="${activity.startTime}" required>
                    </div>
                    <div class="form-group">
                        <label for="edit-end-hour">Término</label>
                        <input type="time" id="edit-end-hour" value="${activity.endTime}" required>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="edit-activity-name">Nome da Atividade</label>
                        <input type="text" id="edit-activity-name" value="${escapeHtml(activity.name)}" required>
                    </div>
                    <div class="form-group">
                        <label for="edit-activity-type">Tipo</label>
                        <select id="edit-activity-type" required>
                            <option value="PLANTÃO" ${isPlantao(activity.type) ? 'selected' : ''}>Plantão</option>
                            <option value="AMBULATORIO" ${!isPlantao(activity.type) ? 'selected' : ''}>Ambulatório</option>
                        </select>
                    </div>
                </div>
                ${rotationConfig.twoGroupsEnabled ? `
                <div class="form-group">
                    <label>Grupo de Atividade</label>
                    <select id="edit-activity-group" required>
                        <option value="1" ${(activity.activityGroup || '1') === '1' ? 'selected' : ''}>${groupDisplayName('1')}</option>
                        <option value="2" ${activity.activityGroup === '2' ? 'selected' : ''}>${groupDisplayName('2')}</option>
                    </select>
                </div>` : ''}
                <div class="form-group">
                    <label for="edit-location">Local</label>
                    <input type="text" id="edit-location" value="${escapeHtml(activity.location)}" required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label for="edit-min-students">Mínimo de Alunos</label>
                        <input type="number" id="edit-min-students" min="0" value="${activity.minStudents ?? 1}" required inputmode="numeric">
                    </div>
                    <div class="form-group">
                        <label for="edit-students-number">Máximo de Alunos</label>
                        <input type="number" id="edit-students-number" min="1" value="${activity.studentsCount}" required inputmode="numeric">
                    </div>
                    <div class="form-group">
                        <label for="edit-hours-count">Carga Horária</label>
                        <input type="number" id="edit-hours-count" step="0.5" min="0" value="${activity.hoursCount}" required inputmode="decimal">
                    </div>
                </div>

                <div class="modal-section exceptions-section">
                    <h4>Dias em que esta atividade não acontece</h4>
                    <div class="form-row">
                        <input type="date" id="modal-act-exc-date">
                        <span>até (opcional)</span>
                        <input type="date" id="modal-act-exc-date-end">
                        <button type="button" id="modal-act-add-exc" class="secondary-btn">Adicionar Exceção</button>
                    </div>
                    <div id="modal-act-exc-list" class="tag-container"></div>
                </div>

                <button type="submit">💾 Salvar Alterações</button>
            </form>
        `;
        enhanceBrazilianInputs(modalBody);

        const renderModalChips = () => {
            const list = document.getElementById('modal-act-exc-list');
            list.innerHTML = '';
            modalExceptions.forEach((exc, idx) => {
                const tag = document.createElement('span');
                tag.className = 'tag exception';
                tag.innerHTML = `${formatExceptionLabel(exc)} <span class="remove-modal-tag" data-idx="${idx}">&times;</span>`;
                list.appendChild(tag);
            });

            modalBody.querySelectorAll('.remove-modal-tag').forEach(span => {
                span.onclick = (e) => {
                    const idx = parseInt(e.target.getAttribute('data-idx'));
                    modalExceptions.splice(idx, 1);
                    renderModalChips();
                };
            });
        };

        renderModalChips();

        const addModalActivityException = ({ quietIfEmpty = false } = {}) => {
            const startInput = document.getElementById('modal-act-exc-date');
            const endInput = document.getElementById('modal-act-exc-date-end');
            const startValue = startInput.value;
            const endValue = endInput.value;

            if (!startValue) {
                if (typedText(startInput)) {
                    showToast('Data da exceção inválida: use dd/mm/aaaa.', { type: 'error' });
                    return false;
                }
                if (!quietIfEmpty) showToast('Escolha a data em que a atividade não acontece.', { type: 'warning' });
                return quietIfEmpty;
            }
            if (typedText(endInput) && !endValue) {
                showToast('A data final da exceção está incompleta (dd/mm/aaaa).', { type: 'error' });
                return false;
            }
            if (endValue && endValue !== startValue) {
                if (endValue < startValue) {
                    showToast('A data final da exceção precisa ser igual ou depois da data inicial.', { type: 'error' });
                    return false;
                }
                modalExceptions.push({ start: startValue, end: endValue });
            } else if (!modalExceptions.includes(startValue)) {
                modalExceptions.push(startValue);
            }

            renderModalChips();
            startInput.value = '';
            endInput.value = '';
            return true;
        };
        document.getElementById('modal-act-add-exc').onclick = () => addModalActivityException();
        setupAutoHours(document.getElementById('edit-start-hour'), document.getElementById('edit-end-hour'),
            document.getElementById('edit-hours-count'), { startsAuto: false });

        editModal.classList.remove('hidden');

        document.getElementById('edit-activity-form').onsubmit = (e) => {
            e.preventDefault();
            if (!addModalActivityException({ quietIfEmpty: true })) return;

            const editedMin = parseInt(document.getElementById('edit-min-students').value);
            const updated = {
                day: document.getElementById('edit-activity-day').value,
                startTime: document.getElementById('edit-start-hour').value,
                endTime: document.getElementById('edit-end-hour').value,
                name: document.getElementById('edit-activity-name').value.trim(),
                type: document.getElementById('edit-activity-type').value,
                location: document.getElementById('edit-location').value.trim(),
                minStudents: Number.isNaN(editedMin) ? 1 : editedMin,
                studentsCount: parseInt(document.getElementById('edit-students-number').value),
                hoursCount: parseFloat(document.getElementById('edit-hours-count').value)
            };
            const problem = validateActivityFields(updated);
            if (problem) {
                showToast(problem, { type: 'error' });
                return;
            }
            Object.assign(activity, updated);
            activity.exceptions = modalExceptions;
            if (rotationConfig.twoGroupsEnabled) {
                activity.activityGroup = document.getElementById('edit-activity-group').value;
            }

            saveActivities();
            renderActivities();
            closeModalHandler();
            showToast(`✅ "${activity.name}" atualizada.`, { type: 'success' });
        };
    }

    // Modal Close Logic
    function closeModalHandler() {
        editModal.classList.add('hidden');
        modalBody.innerHTML = '';
    }

    closeModal.onclick = closeModalHandler;
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !confirmDialogOpen && editModal.classList && !editModal.classList.contains('hidden')) closeModalHandler();
    });
    window.onclick = (e) => {
        if (e.target === editModal) closeModalHandler();
    };

    function deleteActivity(id) {
        const index = activities.findIndex(activity => activity.id === id);
        if (index === -1) return;
        const removed = activities[index];
        activities.splice(index, 1);
        saveActivities();
        renderActivities();
        showToast(`Atividade "${removed.name}" (${DAY_TRANSLATIONS[removed.day]} ${removed.startTime}) excluída.`, {
            actionLabel: 'Desfazer',
            onAction: () => {
                activities.splice(Math.min(index, activities.length), 0, removed);
                saveActivities();
                renderActivities();
            }
        });
    }

    function saveActivities() {
        localStorage.setItem('med_rotations_activities', JSON.stringify(activities));
        markScheduleStale();
        updateProgress();
    }

    // --- Schedule Generation Logic ---

    const generateBtn = document.getElementById('generate-btn');
    const resultsContainer = document.getElementById('results-container');
    const calendarOutput = document.getElementById('calendar-output');
    const statisticsOutput = document.getElementById('statistics-output');
    const printBtn = document.getElementById('print-btn');
    const studentViewOutput = document.getElementById('student-view-output');
    const viewToggleBtn = document.getElementById('view-toggle-btn');
    const exportCsvBtn = document.getElementById('export-csv-btn');
    const exportXlsxBtn = document.getElementById('export-xlsx-btn');
    const exportSheetsBtn = document.getElementById('export-sheets-btn');
    const clearPinsBtn = document.getElementById('clear-pins-btn');

    let lastGeneratedSchedule = null;

    // A escala gerada (com as trocas feitas à mão) fica salva no navegador: recarregar a página não perde nada
    const SCHEDULE_STORAGE_KEY = 'med_rotations_schedule';

    // Cópia segura para JSON (coveredActivities é um Set)
    function serializeSchedule(sched) {
        if (!sched) return null;
        const copy = JSON.parse(JSON.stringify(sched));
        if (Array.isArray(copy.studentStats) && Array.isArray(sched.studentStats)) {
            copy.studentStats.forEach((stat, i) => {
                const original = sched.studentStats[i];
                if (original && original.coveredActivities instanceof Set) stat.coveredActivities = Array.from(original.coveredActivities);
            });
        }
        return copy;
    }

    function persistSchedule() {
        try {
            if (lastGeneratedSchedule) localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(serializeSchedule(lastGeneratedSchedule)));
            else localStorage.removeItem(SCHEDULE_STORAGE_KEY);
        } catch (e) {
            console.warn('Não foi possível salvar a escala no navegador:', e);
        }
    }

    // Recoloca na tela uma escala salva (backup importado ou localStorage), recalculando as estatísticas
    function restoreSchedule(sched) {
        if (!sched || !Array.isArray(sched.finalSchedule)) return false;
        lastGeneratedSchedule = sched;
        sched.finalSchedule.forEach(day => (day.slots || []).forEach(slot => {
            if (slot.activity && slot.activity.name) slot.activity.name = slot.activity.name.trim();
            if (!Array.isArray(slot.assigned)) slot.assigned = [];
        }));
        sched.mandatoryActivities = calculateMandatoryActivities(activities, rotationConfig);
        sched.studentStats = students.map(s => ({
            id: s.id,
            name: s.name,
            affinityGroup: s.affinityGroup,
            totalHours: 0,
            requiredHours: rotationConfig.requiredHours || 0,
            hoursByGroup: rotationConfig.twoGroupsEnabled ? { 1: 0, 2: 0 } : undefined,
            requiredHoursByGroup: rotationConfig.twoGroupsEnabled
                ? { 1: rotationConfig.requiredHoursGroup1 || 0, 2: rotationConfig.requiredHoursGroup2 || 0 }
                : undefined,
            coveredActivities: new Set(),
            hasPlantao: false
        }));
        recalculateAllStats();
        renderGeneratedResults(sched);
        renderCalendarView(sched.finalSchedule);
        renderStudentView(sched.finalSchedule);
        return true;
    }
    let currentView = 'calendar'; // 'calendar' | 'student'

    // Atribuições fixadas (📌): sobrevivem à re-geração da escala
    let pinnedAssignments = [];
    try {
        pinnedAssignments = JSON.parse(localStorage.getItem('med_rotations_pins')) || [];
        normalizeBackupFormats({ pinnedAssignments });
    } catch (e) {
        pinnedAssignments = [];
    }

    // Dados da escala no formato usado pelas exportações (xlsx, PDF e Google Sheets)
    function scheduleExportData() {
        return { finalSchedule: lastGeneratedSchedule.finalSchedule, config: rotationConfig, students };
    }

    // Imprimir / PDF: uma página paisagem por semana no mesmo formato da planilha + balanço
    const printOutput = document.getElementById('print-output');
    if (printBtn) {
        printBtn.addEventListener('click', () => {
            if (!lastGeneratedSchedule || !lastGeneratedSchedule.finalSchedule) {
                showToast('Gere uma escala primeiro (botão "✨ Gerar Escala de Rodízio").', { type: 'warning' });
                return;
            }
            try {
                printOutput.innerHTML = buildPrintHtml(scheduleExportData());
            } catch (err) {
                console.error(err);
                showToast('Não foi possível montar a impressão: ' + err.message, { type: 'error' });
                return;
            }
            document.body.classList.add('printing-schedule');
            window.print();
        });
        window.addEventListener('afterprint', () => {
            document.body.classList.remove('printing-schedule');
            printOutput.innerHTML = '';
        });
    }

    if (generateBtn) {
        const generateBtnDefaultLabel = generateBtn.textContent;
        // Leva o usuário até o passo que falta, em vez de só reclamar
        const goToStep = (sectionId, focusId) => {
            const section = document.getElementById(sectionId);
            if (section && section.scrollIntoView) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const field = focusId && document.getElementById(focusId);
            if (field && field.focus) setTimeout(() => field.focus({ preventScroll: true }), 400);
        };

        generateBtn.addEventListener('click', async () => {
            if (!rotationConfig.startDate || !rotationConfig.endDate) {
                showToast('Falta o período: preencha a data de início e de término no passo 1.', { type: 'warning' });
                goToStep('section-periodo', rotationConfig.startDate ? 'rotation-end' : 'rotation-start');
                return;
            }
            if (activities.length === 0) {
                showToast('Falta cadastrar as atividades (passo 2): os plantões e ambulatórios da semana.', { type: 'warning' });
                goToStep('section-atividades', 'day');
                return;
            }
            if (students.length === 0) {
                showToast('Falta cadastrar os alunos (passo 3).', { type: 'warning' });
                goToStep('section-alunos', 'student-name');
                return;
            }

            // Verificação prévia (rápida; não precisa gerar a escala)
            const feasibility = SchedulerCore.analyzeFeasibility(activities, students, rotationConfig);
            renderHealthIssues(feasibility, [], null);
            if (feasibility.errors.length > 0) {
                const proceed = await askConfirm({
                    title: 'A escala pode não fechar',
                    message: 'Antes de gerar, encontramos estes problemas. Você pode ajustar os dados ou gerar assim mesmo e corrigir depois arrastando os alunos.',
                    details: feasibility.errors,
                    confirmLabel: 'Gerar assim mesmo',
                    cancelLabel: 'Voltar e ajustar'
                });
                if (!proceed) return;
            }

            generateBtn.disabled = true;
            generateBtn.textContent = 'Gerando escala...';

            const input = JSON.parse(JSON.stringify({
                activities,
                students,
                config: rotationConfig,
                pins: pinnedAssignments
            }));

            runGeneration(input)
                .then(scheduleData => {
                    lastGeneratedSchedule = scheduleData;
                    persistSchedule();
                    markScheduleFresh();
                    updateProgress();
                    showToast('✅ Escala gerada! Confira o calendário abaixo e compartilhe pelos botões de "Compartilhar".', { type: 'success' });
                    renderGeneratedResults(scheduleData, { scroll: true });
                    renderCalendarView(scheduleData.finalSchedule);
                    renderStudentView(scheduleData.finalSchedule);
                })
                .catch(err => {
                    showToast('Erro ao gerar a escala: ' + err.message, { type: 'error' });
                })
                .finally(() => {
                    generateBtn.disabled = false;
                    generateBtn.textContent = generateBtnDefaultLabel;
                });
        });
    }

    // --- "Tocar para mover": alternativa ao arrastar (celular/tablet não arrastam) ---
    // Toque num nome → toque na atividade de destino (ou na caixa "Alunos" para tirar).
    let pendingMove = null;   // { name, date, activityId }
    const moveBar = document.getElementById('move-bar');
    const moveBarText = document.getElementById('move-bar-text');

    function cancelMove() {
        pendingMove = null;
        if (document.body && document.body.classList) document.body.classList.remove('moving-student');
        if (calendarOutput && calendarOutput.querySelectorAll) {
            calendarOutput.querySelectorAll('.move-selected').forEach(el => el.classList.remove('move-selected'));
        }
        if (moveBar && moveBar.classList) moveBar.classList.add('hidden');
    }

    function selectForMove(name, date, activityId, tagEl) {
        if (pendingMove && pendingMove.name === name && pendingMove.date === date && String(pendingMove.activityId) === String(activityId)) {
            cancelMove();
            return;
        }
        cancelMove();
        pendingMove = { name, date, activityId };
        if (tagEl && tagEl.classList) tagEl.classList.add('move-selected');
        if (document.body && document.body.classList) document.body.classList.add('moving-student');
        if (moveBar && moveBar.classList) {
            moveBarText.textContent = date === 'roster'
                ? `Colocando ${name}: toque na atividade onde ele(a) deve entrar.`
                : `Movendo ${name}: toque na atividade de destino, ou na caixa "Alunos" (fim do mês) para tirar.`;
            moveBar.classList.remove('hidden');
        }
    }

    const moveCancelBtn = document.getElementById('move-bar-cancel');
    if (moveCancelBtn && moveCancelBtn.addEventListener) moveCancelBtn.addEventListener('click', cancelMove);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pendingMove && !confirmDialogOpen) cancelMove(); });

    function renderCalendarView(finalSchedule) {
        if (!rotationConfig.startDate || !rotationConfig.endDate || !Array.isArray(finalSchedule)) return;
        cancelMove();
        
        calendarOutput.innerHTML = '';
        
        const start = new Date(rotationConfig.startDate + 'T00:00:00');
        const end = new Date(rotationConfig.endDate + 'T00:00:00');
        const todayStr = toLocalDateStr(new Date());

        // Iterate through each month in the range
        let currentMonth = new Date(start.getFullYear(), start.getMonth(), 1);
        
        while (currentMonth <= end) {
            const monthYear = currentMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
            
            const monthDiv = document.createElement('div');
            monthDiv.className = 'calendar-month';
            monthDiv.innerHTML = `<h3>${monthYear.charAt(0).toUpperCase() + monthYear.slice(1)}</h3>`;

            const grid = document.createElement('div');
            grid.className = 'calendar-grid';

            // Headers
            const dayHeaders = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
            dayHeaders.forEach(h => {
                const hDiv = document.createElement('div');
                hDiv.className = 'calendar-day-header';
                hDiv.textContent = h;
                grid.appendChild(hDiv);
            });

            // --- Collect all days for this month ---
            const allMonthCells = [];
            
            // Start Padding
            const startPadding = currentMonth.getDay();
            for (let i = 0; i < startPadding; i++) {
                const pad = document.createElement('div');
                pad.className = 'calendar-day other-month';
                allMonthCells.push({ element: pad, hasActivity: false });
            }

            // Days of the month
            const year = currentMonth.getFullYear();
            const month = currentMonth.getMonth();
            const lastDay = new Date(year, month + 1, 0).getDate();
            
            for (let i = 1; i <= lastDay; i++) {
                const dayDiv = document.createElement('div');
                dayDiv.className = 'calendar-day';
                
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                if (dateStr === todayStr) dayDiv.classList.add('today');
                
                dayDiv.innerHTML = `<div class="calendar-day-number">${i}</div>`;
                
                const dayData = finalSchedule.find(d => d.date === dateStr);
                let dayHasActivity = false;

                if (dayData) {
                    dayHasActivity = true;
                    const eventsCont = document.createElement('div');
                    eventsCont.className = 'calendar-events';
                    dayData.slots.forEach(slot => {
                        if (!slot.assigned) slot.assigned = [];
                        
                        const eventEl = document.createElement('div');
                        eventEl.className = 'calendar-event';
                        eventEl.classList.add(isPlantao(slot.activity.type) ? 'type-plantao' : 'type-ambulatorio');
                        if (slot.assigned.length === 0) eventEl.classList.add('empty-slot');

                        // Drop target data
                        eventEl.setAttribute('data-date', dateStr);
                        eventEl.setAttribute('data-activity-id', slot.activity.id);

                        // Drop events
                        eventEl.addEventListener('dragover', (e) => {
                            e.preventDefault();
                            eventEl.classList.add('drag-over');
                        });

                        eventEl.addEventListener('dragleave', () => {
                            eventEl.classList.remove('drag-over');
                        });

                        eventEl.addEventListener('drop', (e) => {
                            e.preventDefault();
                            eventEl.classList.remove('drag-over');
                            const studentName = e.dataTransfer.getData('text/plain');
                            const sourceDate = e.dataTransfer.getData('source-date');
                            const sourceActivityId = e.dataTransfer.getData('source-activity-id');
                            
                            handleStudentReassignment(studentName, sourceDate, sourceActivityId, dateStr, slot.activity.id);
                        });

                        // Tocar para mover: destino
                        eventEl.addEventListener('click', () => {
                            if (!pendingMove) return;
                            const move = pendingMove;
                            cancelMove();
                            handleStudentReassignment(move.name, move.date, move.activityId, dateStr, slot.activity.id);
                        });
                        
                        const assignedHtml = slot.assigned.map(name => {
                            const student = students.find(s => s.name === name);
                            const color = student ? student.color : '#ccc';
                            const pinned = isPinned(dateStr, slot.activity.id, name);
                            const pinTitle = pinned ? 'Desafixar (voltar a ser realocável)' : 'Fixar aluno nesta atividade';
                            const studentSpan = `<span class="calendar-student-tag${pinned ? ' pinned' : ''}" draggable="true" data-name="${escapeHtml(name)}" data-date="${dateStr}" data-activity-id="${slot.activity.id}"><span class="color-dot" style="background-color: ${color}"></span>${escapeHtml(name)}<span class="pin-toggle" title="${pinTitle}">📌</span></span>`;
                            return studentSpan;
                        }).join('');

                        const names = slot.assigned.length > 0 ? slot.assigned.join(', ') : 'Vazio';
                        eventEl.title = `${slot.activity.name} · ${typeLabel(slot.activity.type)} (${slot.activity.startTime}–${slot.activity.endTime})\nAlunos: ${names}`;
                        
                        eventEl.innerHTML = `
                            <div class="event-time-name">${slot.activity.startTime} ${slot.activity.name}</div>
                            <div class="event-assigned">${slot.assigned.length > 0 ? assignedHtml : 'Vazio'}</div>
                        `;

                        // Drag events for students in this slot
                        eventEl.querySelectorAll('.calendar-student-tag').forEach(tag => {
                            tag.addEventListener('dragstart', (e) => {
                                e.dataTransfer.setData('text/plain', tag.getAttribute('data-name'));
                                e.dataTransfer.setData('source-date', tag.getAttribute('data-date'));
                                e.dataTransfer.setData('source-activity-id', tag.getAttribute('data-activity-id'));
                                tag.classList.add('dragging');
                            });
                            tag.addEventListener('dragend', () => {
                                tag.classList.remove('dragging');
                            });

                            const pinToggle = tag.querySelector('.pin-toggle');
                            if (pinToggle) {
                                pinToggle.addEventListener('click', (e) => {
                                    e.stopPropagation();
                                    togglePin(tag.getAttribute('data-date'), tag.getAttribute('data-activity-id'), tag.getAttribute('data-name'));
                                });
                            }

                            // Tocar para mover: escolhe o aluno (tocar no mesmo aluno de novo cancela)
                            tag.addEventListener('click', (e) => {
                                e.stopPropagation();
                                if (pendingMove && !(pendingMove.name === tag.getAttribute('data-name') &&
                                    pendingMove.date === tag.getAttribute('data-date') &&
                                    String(pendingMove.activityId) === tag.getAttribute('data-activity-id'))) {
                                    // Já havia alguém escolhido: tocar em outro nome de outra atividade leva o escolhido para lá
                                    if (tag.getAttribute('data-activity-id') !== String(pendingMove.activityId) || tag.getAttribute('data-date') !== pendingMove.date) {
                                        const move = pendingMove;
                                        cancelMove();
                                        handleStudentReassignment(move.name, move.date, move.activityId, dateStr, slot.activity.id);
                                        return;
                                    }
                                }
                                selectForMove(tag.getAttribute('data-name'), tag.getAttribute('data-date'), tag.getAttribute('data-activity-id'), tag);
                            });
                        });

                        eventsCont.appendChild(eventEl);
                    });
                    dayDiv.appendChild(eventsCont);
                }

                allMonthCells.push({ element: dayDiv, hasActivity: dayHasActivity });
            }

            // End Padding to fill the week
            const currentTotal = allMonthCells.length;
            const endPadding = (7 - (currentTotal % 7)) % 7;
            for (let i = 0; i < endPadding; i++) {
                const pad = document.createElement('div');
                pad.className = 'calendar-day other-month';
                allMonthCells.push({ element: pad, hasActivity: false });
            }

            // --- Chunk into weeks and render ONLY if the week has activities ---
            for (let i = 0; i < allMonthCells.length; i += 7) {
                const weekChunk = allMonthCells.slice(i, i + 7);
                const weekHasActivity = weekChunk.some(cell => cell.hasActivity);
                
                if (weekHasActivity) {
                    weekChunk.forEach(cell => grid.appendChild(cell.element));
                }
            }

            if (grid.children.length > 7) { // Only add month if it has at least one week with activities
                monthDiv.appendChild(grid);

                // --- Student Roster for this month ---
                const rosterDiv = document.createElement('div');
                rosterDiv.className = 'calendar-roster';
                rosterDiv.innerHTML = '<h4>Alunos <span class="roster-hint">Arraste (ou toque em) um nome para colocá-lo numa atividade. Para tirar alguém, traga o nome para cá.</span></h4>';
                
                const rosterList = document.createElement('div');
                rosterList.className = 'roster-list';
                
                students.forEach(student => {
                    const studentTag = document.createElement('span');
                    studentTag.className = 'calendar-student-tag roster-item';
                    studentTag.draggable = true;
                    studentTag.innerHTML = `<span class="color-dot" style="background-color: ${student.color}"></span>${escapeHtml(student.name)}`;
                    studentTag.addEventListener('click', (e) => {
                        e.stopPropagation();
                        selectForMove(student.name, 'roster', 'roster', studentTag);
                    });
                    
                    studentTag.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', student.name);
                        e.dataTransfer.setData('source-date', 'roster');
                        e.dataTransfer.setData('source-activity-id', 'roster');
                        studentTag.classList.add('dragging');
                    });
                    
                    studentTag.addEventListener('dragend', () => {
                        studentTag.classList.remove('dragging');
                    });
                    
                    rosterList.appendChild(studentTag);
                });

                // Tocar para mover: tocar na caixa "Alunos" tira o aluno escolhido da atividade
                rosterDiv.addEventListener('click', () => {
                    if (!pendingMove || pendingMove.date === 'roster') return;
                    const move = pendingMove;
                    cancelMove();
                    handleStudentUnassignment(move.name, move.date, move.activityId);
                });

                // Make roster a drop target for unassignment
                rosterDiv.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    rosterDiv.classList.add('drag-over');
                });

                rosterDiv.addEventListener('dragleave', () => {
                    rosterDiv.classList.remove('drag-over');
                });

                rosterDiv.addEventListener('drop', (e) => {
                    e.preventDefault();
                    rosterDiv.classList.remove('drag-over');
                    const studentName = e.dataTransfer.getData('text/plain');
                    const sourceDate = e.dataTransfer.getData('source-date');
                    const sourceActivityId = e.dataTransfer.getData('source-activity-id');
                    
                    if (sourceDate !== 'roster') {
                        handleStudentUnassignment(studentName, sourceDate, sourceActivityId);
                    }
                });

                rosterDiv.appendChild(rosterList);
                monthDiv.appendChild(rosterDiv);
                
                calendarOutput.appendChild(monthDiv);
            }

            // Move to next month
            currentMonth.setMonth(currentMonth.getMonth() + 1);
        }
    }

    async function handleStudentReassignment(studentName, sourceDate, sourceActivityId, targetDate, targetActivityId) {
        if (!lastGeneratedSchedule || confirmDialogOpen) return;

        // Mesmo lugar: nada a fazer
        if (sourceDate === targetDate && sourceActivityId === targetActivityId) return;

        const { finalSchedule } = lastGeneratedSchedule;

        const targetDay = finalSchedule.find(d => d.date === targetDate);
        if (!targetDay) return;
        const targetSlot = targetDay.slots.find(s => s.activity.id == targetActivityId);
        if (!targetSlot) return;

        if (targetSlot.assigned.includes(studentName)) {
            showToast(`${studentName} já está nessa atividade.`, { type: 'warning' });
            return;
        }

        // Junta todos os conflitos e pergunta UMA vez
        const conflicts = [];
        const act = targetSlot.activity;

        const studentObj = students.find(s => s.name === studentName);
        if (studentObj && hasException(studentObj, targetDate, act)) {
            conflicts.push('Marcou indisponibilidade (exceção) nesse dia/horário.');
        }

        // Ignora o lugar de onde o aluno está saindo
        const isSourceSlot = (dateStr, slot) => dateStr === sourceDate && slot.activity.id == sourceActivityId;

        const hasTimeOverlap = targetDay.slots.some(s =>
            s !== targetSlot &&
            !isSourceSlot(targetDate, s) &&
            s.assigned.includes(studentName) &&
            checkOverlap(s.activity.startTime, s.activity.endTime, act.startTime, act.endTime)
        );
        if (hasTimeOverlap) conflicts.push('Já tem outra atividade no mesmo horário nesse dia.');

        if (isPlantao(act.type)) {
            const hasPlantaoConflict = (offset) => {
                const adjDate = getAdjacentDateStr(targetDate, offset);
                const adjDay = finalSchedule.find(d => d.date === adjDate);
                if (!adjDay) return false;
                return adjDay.slots.some(s =>
                    s !== targetSlot &&
                    !isSourceSlot(adjDate, s) &&
                    isPlantao(s.activity.type) && s.assigned.includes(studentName)
                );
            };
            if (hasPlantaoConflict(-1) || hasPlantaoConflict(0) || hasPlantaoConflict(1)) {
                conflicts.push('Já tem um plantão no mesmo dia, no dia anterior ou no seguinte (sem o descanso entre plantões).');
            }
        }

        {
            const nightRestConflict = (offset, matches) => {
                const adjDate = getAdjacentDateStr(targetDate, offset);
                const adjDay = finalSchedule.find(d => d.date === adjDate);
                if (!adjDay) return false;
                return adjDay.slots.some(s =>
                    s !== targetSlot &&
                    !isSourceSlot(adjDate, s) &&
                    s.assigned.includes(studentName) && matches(s.activity)
                );
            };
            if (act.startTime < MORNING_REST_CUTOFF && nightRestConflict(-1, a => isOvernight(a.startTime, a.endTime))) {
                conflicts.push('Fez plantão noturno na noite anterior.');
            }
            if (isOvernight(act.startTime, act.endTime) && nightRestConflict(1, a => a.startTime < MORNING_REST_CUTOFF)) {
                conflicts.push('Tem atividade na manhã seguinte a esse plantão noturno.');
            }
        }

        if (conflicts.length > 0) {
            const ok = await askConfirm({
                title: `Colocar ${studentName} mesmo assim?`,
                message: `${act.name} · ${formatDateBR(targetDate)} · ${act.startTime}–${act.endTime}\n\nAtenção:`,
                details: conflicts,
                confirmLabel: 'Colocar mesmo assim',
                cancelLabel: 'Cancelar'
            });
            if (!ok) return;
        }

        // Guarda o estado anterior para o "Desfazer"
        const sourceDay = sourceDate !== 'roster' ? finalSchedule.find(d => d.date === sourceDate) : null;
        const sourceSlot = sourceDay ? sourceDay.slots.find(s => s.activity.id == sourceActivityId) : null;
        const snapshot = {
            source: sourceSlot ? sourceSlot.assigned.slice() : null,
            target: targetSlot.assigned.slice(),
            pins: JSON.parse(JSON.stringify(pinnedAssignments))
        };

        // Tira do lugar de origem (se não veio da lista de alunos)
        if (sourceDate !== 'roster') {
            if (sourceSlot) {
                sourceSlot.assigned = sourceSlot.assigned.filter(n => n !== studentName);
                sourceSlot.capacityString = `${sourceSlot.assigned.length}/${sourceSlot.activity.studentsCount}`;
            }
            removePin(sourceDate, sourceActivityId, studentName);
        }

        // Coloca no destino (trocas manuais ficam fixadas para sobreviver a uma nova geração)
        targetSlot.assigned.push(studentName);
        targetSlot.capacityString = `${targetSlot.assigned.length}/${targetSlot.activity.studentsCount}`;
        addPin(targetDate, targetActivityId, studentName);

        const refresh = () => {
            recalculateAllStats();
            persistSchedule();
            renderGeneratedResults(lastGeneratedSchedule);
            renderCalendarView(lastGeneratedSchedule.finalSchedule);
            renderStudentView(lastGeneratedSchedule.finalSchedule);
        };
        refresh();

        const where = `${act.name} (${formatDateBR(targetDate)} ${act.startTime})`;
        showToast(sourceDate === 'roster' ? `${studentName} entrou em ${where}. 📌 Fixado.` : `${studentName} foi para ${where}. 📌 Fixado.`, {
            actionLabel: 'Desfazer',
            onAction: () => {
                if (sourceSlot && snapshot.source) {
                    sourceSlot.assigned = snapshot.source;
                    sourceSlot.capacityString = `${sourceSlot.assigned.length}/${sourceSlot.activity.studentsCount}`;
                }
                targetSlot.assigned = snapshot.target;
                targetSlot.capacityString = `${targetSlot.assigned.length}/${targetSlot.activity.studentsCount}`;
                pinnedAssignments = snapshot.pins;
                savePins();
                refresh();
            }
        });
    }

    // Remover um aluno de uma atividade: sem pergunta, mas com "Desfazer"
    function handleStudentUnassignment(studentName, sourceDate, sourceActivityId) {
        if (!lastGeneratedSchedule || confirmDialogOpen) return;
        const { finalSchedule } = lastGeneratedSchedule;

        const sourceDay = finalSchedule.find(d => d.date === sourceDate);
        if (!sourceDay) return;
        const sourceSlot = sourceDay.slots.find(s => s.activity.id == sourceActivityId);
        if (!sourceSlot) return;

        const previousIndex = sourceSlot.assigned.indexOf(studentName);
        if (previousIndex === -1) return;
        const wasPinned = isPinned(sourceDate, sourceActivityId, studentName);

        const refresh = () => {
            sourceSlot.capacityString = `${sourceSlot.assigned.length}/${sourceSlot.activity.studentsCount}`;
            recalculateAllStats();
            persistSchedule();
            renderGeneratedResults(lastGeneratedSchedule);
            renderCalendarView(lastGeneratedSchedule.finalSchedule);
            renderStudentView(lastGeneratedSchedule.finalSchedule);
        };

        sourceSlot.assigned = sourceSlot.assigned.filter(n => n !== studentName);
        removePin(sourceDate, sourceActivityId, studentName);
        refresh();

        showToast(`${studentName} saiu de ${sourceSlot.activity.name} (${formatDateBR(sourceDate)}).`, {
            actionLabel: 'Desfazer',
            onAction: () => {
                if (sourceSlot.assigned.includes(studentName)) return;
                sourceSlot.assigned.splice(Math.min(previousIndex, sourceSlot.assigned.length), 0, studentName);
                if (wasPinned) addPin(sourceDate, sourceActivityId, studentName);
                refresh();
            }
        });
    }

    function recalculateAllStats() {
        if (!lastGeneratedSchedule || !lastGeneratedSchedule.finalSchedule || !lastGeneratedSchedule.studentStats) return;

        const { finalSchedule, studentStats } = lastGeneratedSchedule;

        const twoGroupsEnabled = !!rotationConfig.twoGroupsEnabled;

        // Reset all totals and ensure coveredActivities is a Set
        studentStats.forEach(stat => {
            stat.totalHours = 0;
            stat.hasPlantao = false;
            if (twoGroupsEnabled) {
                stat.hoursByGroup = { 1: 0, 2: 0 };
                stat.requiredHoursByGroup = { 1: rotationConfig.requiredHoursGroup1 || 0, 2: rotationConfig.requiredHoursGroup2 || 0 };
            }
            if (!(stat.coveredActivities instanceof Set)) {
                stat.coveredActivities = new Set();
            } else {
                stat.coveredActivities.clear();
            }
        });

        // Sum up from schedule
        finalSchedule.forEach(day => {
            if (!day || !day.slots) return;
            day.slots.forEach(slot => {
                if (!slot.assigned || !slot.activity) return;
                slot.assigned.forEach(name => {
                    const stat = studentStats.find(s => s.name === name);
                    if (stat) {
                        stat.totalHours += (slot.activity.hoursCount || 0);
                        if (twoGroupsEnabled) {
                            const g = slot.activity.activityGroup === '2' ? 2 : 1;
                            stat.hoursByGroup[g] += (slot.activity.hoursCount || 0);
                        }
                        if (slot.activity.name) {
                            stat.coveredActivities.add(normalizeActivityName(slot.activity.name));
                        }
                        if (isPlantao(slot.activity.type)) {
                            stat.hasPlantao = true;
                        }
                    }
                });
            });
        });
    }

    // --- Ponte com o núcleo do algoritmo (roda em Web Worker quando disponível) ---

    function normalizeScheduleResult(result) {
        if (result && Array.isArray(result.studentStats)) {
            result.studentStats.forEach(st => {
                if (!(st.coveredActivities instanceof Set)) {
                    st.coveredActivities = new Set(st.coveredActivities || []);
                }
            });
        }
        return result;
    }

    function runGeneration(input) {
        return new Promise((resolve, reject) => {
            const fallback = () => {
                try {
                    resolve(normalizeScheduleResult(SchedulerCore.generate(input)));
                } catch (err) {
                    reject(err);
                }
            };

            let url = null;
            let worker = null;
            try {
                const workerCode =
                    `const core = (${createSchedulerCore.toString()})();\n` +
                    'self.onmessage = (e) => {\n' +
                    '    try {\n' +
                    '        const input = e.data;\n' +
                    '        input.onProgress = (done, total) => self.postMessage({ type: "progress", done, total });\n' +
                    '        const result = core.generate(input);\n' +
                    '        self.postMessage({ type: "done", result });\n' +
                    '    } catch (err) {\n' +
                    '        self.postMessage({ type: "error", message: String((err && err.message) || err) });\n' +
                    '    }\n' +
                    '};';
                url = URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' }));
                worker = new Worker(url);
            } catch (e) {
                // Worker unavailable (e.g. file:// restrictions) — generate synchronously
                if (url) URL.revokeObjectURL(url);
                fallback();
                return;
            }

            const cleanup = () => {
                URL.revokeObjectURL(url);
                worker.terminate();
            };
            worker.onmessage = (e) => {
                const msg = e.data || {};
                if (msg.type === 'progress') {
                    generateBtn.textContent = `Gerando escala... ${Math.round((msg.done / msg.total) * 100)}%`;
                    return;
                }
                cleanup();
                if (msg.type === 'done') resolve(normalizeScheduleResult(msg.result));
                else reject(new Error(msg.message || 'Falha na geração da escala.'));
            };
            worker.onerror = () => {
                cleanup();
                fallback();
            };
            worker.postMessage(input);
        });
    }

    function renderHealthIssues(feasibility, pinWarnings, legacyWarning) {
        const healthWarningEl = document.getElementById('health-warning');
        const items = [];
        if (feasibility) {
            (feasibility.errors || []).forEach(m => items.push(`<li>⛔ ${m}</li>`));
            (feasibility.warnings || []).forEach(m => items.push(`<li>⚠️ ${m}</li>`));
        }
        (pinWarnings || []).forEach(m => items.push(`<li>📌 ${m}</li>`));
        if (legacyWarning) items.push(`<li>⚠️ ${legacyWarning}</li>`);

        if (items.length === 0) {
            healthWarningEl.innerHTML = '';
            healthWarningEl.classList.add('hidden');
            return;
        }
        const hasBlocking = feasibility && (feasibility.errors || []).length > 0;
        const howTo = hasBlocking || (feasibility && (feasibility.warnings || []).length)
            ? '<p class="health-howto">💡 Como resolver: confira as <strong>horas por aluno</strong> (passo 1), o <strong>máximo/mínimo de alunos</strong> das atividades (passo 2) e as <strong>indisponibilidades</strong> dos alunos (passo 3). Também dá para gerar assim mesmo e ajustar à mão depois.</p>'
            : '';
        healthWarningEl.innerHTML = `<strong>Avisos da Escala:</strong><ul>${items.join('')}</ul>${howTo}`;
        healthWarningEl.classList.remove('hidden');
    }

    // --- Atribuições fixadas (📌) ---

    function savePins() {
        localStorage.setItem('med_rotations_pins', JSON.stringify(pinnedAssignments));
        updateClearPinsButton();
    }

    function isPinned(date, activityId, studentName) {
        return pinnedAssignments.some(p =>
            p.date === date && String(p.activityId) === String(activityId) && p.studentName === studentName);
    }

    function addPin(date, activityId, studentName) {
        if (isPinned(date, activityId, studentName)) return;
        const student = students.find(s => s.name === studentName);
        pinnedAssignments.push({
            date,
            activityId,
            studentId: student ? student.id : null,
            studentName
        });
        savePins();
    }

    function removePin(date, activityId, studentName) {
        const before = pinnedAssignments.length;
        pinnedAssignments = pinnedAssignments.filter(p =>
            !(p.date === date && String(p.activityId) === String(activityId) && p.studentName === studentName));
        if (pinnedAssignments.length !== before) savePins();
    }

    function togglePin(date, activityId, studentName) {
        if (isPinned(date, activityId, studentName)) removePin(date, activityId, studentName);
        else addPin(date, activityId, studentName);
        if (lastGeneratedSchedule) renderCalendarView(lastGeneratedSchedule.finalSchedule);
    }

    function updateClearPinsButton() {
        if (!clearPinsBtn) return;
        clearPinsBtn.textContent = `Limpar Fixados (${pinnedAssignments.length})`;
        clearPinsBtn.classList.toggle('hidden', pinnedAssignments.length === 0);
    }

    if (clearPinsBtn) {
        clearPinsBtn.addEventListener('click', async () => {
            if (pinnedAssignments.length === 0) return;
            const ok = await askConfirm({
                title: 'Soltar todos os alunos fixados?',
                message: `Há ${pinnedAssignments.length} aluno(s) fixado(s) com 📌. A escala atual não muda agora, mas na próxima vez que você gerar a escala esses alunos poderão ser trocados de lugar.`,
                confirmLabel: 'Soltar todos'
            });
            if (!ok) return;
            pinnedAssignments = [];
            savePins();
            if (lastGeneratedSchedule) renderCalendarView(lastGeneratedSchedule.finalSchedule);
            showToast('Fixações removidas.', { type: 'success' });
        });
    }
    updateClearPinsButton();

    // --- Exportação CSV e visão por aluno ---

    function downloadFile(content, mimeType, filename) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    if (exportCsvBtn) {
        exportCsvBtn.addEventListener('click', () => {
            if (!lastGeneratedSchedule || !lastGeneratedSchedule.finalSchedule) {
                showToast('Gere uma escala primeiro (botão "✨ Gerar Escala de Rodízio").', { type: 'warning' });
                return;
            }
            // Semicolon separator + BOM + decimal comma: opens correctly in Excel pt-BR
            const escapeCsv = (v) => {
                v = String(v ?? '');
                return (v.includes(';') || v.includes('"') || v.includes('\n')) ? '"' + v.replace(/"/g, '""') + '"' : v;
            };
            const header = ['Data', 'Dia da Semana', 'Atividade', 'Tipo'];
            if (rotationConfig.twoGroupsEnabled) header.push('Grupo de Atividade');
            header.push('Início', 'Término', 'Local', 'Horas', 'Aluno', 'Grupo');
            const rows = [header];
            lastGeneratedSchedule.finalSchedule.forEach(day => {
                day.slots.forEach(slot => {
                    const base = [
                        formatDateBR(day.date),
                        DAY_TRANSLATIONS[day.dayName] || day.dayName,
                        slot.activity.name,
                        slot.activity.type || 'PLANTÃO'
                    ];
                    if (rotationConfig.twoGroupsEnabled) base.push(groupDisplayName(slot.activity.activityGroup || '1'));
                    base.push(
                        slot.activity.startTime,
                        slot.activity.endTime,
                        slot.activity.location || '',
                        String(slot.activity.hoursCount ?? '').replace('.', ',')
                    );
                    if (!slot.assigned || slot.assigned.length === 0) {
                        rows.push([...base, '(vago)', '']);
                    } else {
                        slot.assigned.forEach(name => {
                            const student = students.find(s => s.name === name);
                            rows.push([...base, name, student ? (student.affinityGroup || '') : '']);
                        });
                    }
                });
            });
            const csv = '\uFEFF' + rows.map(r => r.map(escapeCsv).join(';')).join('\r\n');
            downloadFile(csv, 'text/csv;charset=utf-8', `escala_${formatDateBR(toLocalDateStr(new Date())).replace(/\//g, '-')}.csv`);
        });
    }

    // --- Exportar .xlsx no formato das planilhas montadas à mão (abre no Google Sheets e no Excel) ---
    // A biblioteca ExcelJS só é baixada quando o botão é usado (o resto do app continua 100% offline).
    const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
    let excelJsPromise = null;
    function loadExcelJS() {
        if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
        if (!excelJsPromise) {
            excelJsPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = EXCELJS_URL;
                script.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS não carregou'));
                script.onerror = () => { excelJsPromise = null; reject(new Error('Falha ao baixar ExcelJS')); };
                document.head.appendChild(script);
            });
        }
        return excelJsPromise;
    }

    if (exportXlsxBtn) {
        exportXlsxBtn.addEventListener('click', async () => {
            if (!lastGeneratedSchedule || !lastGeneratedSchedule.finalSchedule) {
                showToast('Gere uma escala primeiro (botão "✨ Gerar Escala de Rodízio").', { type: 'warning' });
                return;
            }
            const originalLabel = exportXlsxBtn.textContent;
            exportXlsxBtn.disabled = true;
            exportXlsxBtn.textContent = '⏳ Gerando planilha...';
            try {
                await downloadScheduleXlsx();
            } catch (err) {
                console.error(err);
                showToast('Não foi possível gerar a planilha .xlsx. Na primeira vez é preciso estar conectado à internet. Alternativa: "Exportar CSV".', { type: 'error' });
            } finally {
                exportXlsxBtn.disabled = false;
                exportXlsxBtn.textContent = originalLabel;
            }
        });
    }

    // --- Criar Planilha no Google Sheets ---
    // Sem API/OAuth: copia a MESMA grade do .xlsx (cartões coloridos, uma semana embaixo da outra e o
    // balanço ao lado) como HTML para a área de transferência e abre uma planilha nova para colar.
    //
    // O copy precisa ser SÍNCRONO e acontecer ANTES do window.open: a Clipboard API assíncrona
    // depende do documento estar em foco, e abrir a nova aba tira o foco antes da promise resolver.
    // document.execCommand('copy') com um handler de 'copy' é síncrono e permite gravar text/html.
    function copyRichToClipboardSync(html, text) {
        let wrote = false;
        const onCopy = (e) => {
            if (!e.clipboardData) return;
            e.clipboardData.setData('text/html', html);
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
            wrote = true;
        };
        document.addEventListener('copy', onCopy);
        // Alguns navegadores só disparam 'copy' se houver uma seleção
        const textarea = document.createElement('textarea');
        textarea.value = ' ';
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(textarea);
        document.removeEventListener('copy', onCopy);
        return ok && wrote;
    }

    // Modal com as instruções: o usuário copia e abre a planilha nova quando quiser (sem alertas do navegador)
    const sheetsModal = document.getElementById('sheets-modal');
    const sheetsStatus = document.getElementById('sheets-status');

    function setSheetsStatus(msg, kind) {
        sheetsStatus.textContent = msg;
        sheetsStatus.className = 'sheets-status' + (kind ? ' ' + kind : '');
    }

    function openSheetsModal() {
        setSheetsStatus('', '');
        sheetsModal.classList.remove('hidden');
        document.getElementById('sheets-copy-btn').focus();
    }

    function closeSheetsModal() {
        sheetsModal.classList.add('hidden');
    }

    async function downloadScheduleXlsx() {
        const ExcelJS = await loadExcelJS();
        const buffer = await buildScheduleWorkbook(ExcelJS, scheduleExportData()).xlsx.writeBuffer();
        const range = (rotationConfig.startDate && rotationConfig.endDate)
            ? `${formatDateBR(rotationConfig.startDate)}_a_${formatDateBR(rotationConfig.endDate)}`.replace(/\//g, '-')
            : formatDateBR(toLocalDateStr(new Date())).replace(/\//g, '-');
        const filename = `escala_${range}.xlsx`;
        downloadFile(buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename);
        return filename;
    }

    if (exportSheetsBtn && sheetsModal) {
        exportSheetsBtn.addEventListener('click', () => {
            if (!lastGeneratedSchedule || !lastGeneratedSchedule.finalSchedule) {
                showToast('Gere uma escala primeiro (botão "✨ Gerar Escala de Rodízio").', { type: 'warning' });
                return;
            }
            openSheetsModal();
        });

        document.getElementById('sheets-copy-btn').addEventListener('click', () => {
            let clip;
            try {
                clip = buildSheetsClipboard(scheduleExportData());
            } catch (err) {
                console.error(err);
                setSheetsStatus('Não foi possível montar os dados: ' + err.message, 'error');
                return;
            }
            if (copyRichToClipboardSync(clip.html, clip.text)) {
                setSheetsStatus('✅ Dados copiados! Agora clique em “Nova planilha” e cole na célula A1.', 'success');
            } else {
                setSheetsStatus('O navegador não deixou copiar automaticamente. Use a opção “uma aba por semana” logo abaixo (Baixar .xlsx).', 'error');
                sheetsModal.querySelector('.sheets-full').open = true;
            }
        });

        const openNewSheet = () => window.open('https://sheets.new', '_blank', 'noopener');
        document.getElementById('sheets-new-btn').addEventListener('click', openNewSheet);
        document.getElementById('sheets-new-btn-2').addEventListener('click', openNewSheet);

        const sheetsXlsxBtn = document.getElementById('sheets-xlsx-btn');
        sheetsXlsxBtn.addEventListener('click', async () => {
            const label = sheetsXlsxBtn.textContent;
            sheetsXlsxBtn.disabled = true;
            sheetsXlsxBtn.textContent = '⏳ Gerando...';
            try {
                const filename = await downloadScheduleXlsx();
                sheetsXlsxBtn.textContent = `✅ Baixado: ${filename}`;
                setTimeout(() => { sheetsXlsxBtn.textContent = label; }, 4000);
            } catch (err) {
                console.error(err);
                sheetsXlsxBtn.textContent = label;
                setSheetsStatus('Não foi possível gerar o .xlsx (é preciso internet na primeira vez).', 'error');
            } finally {
                sheetsXlsxBtn.disabled = false;
            }
        });

        sheetsModal.querySelector('.sheets-close').addEventListener('click', closeSheetsModal);
        sheetsModal.addEventListener('click', (e) => { if (e.target === sheetsModal) closeSheetsModal(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !sheetsModal.classList.contains('hidden')) closeSheetsModal();
        });
    }

    function renderStudentView(finalSchedule) {
        if (!studentViewOutput || !Array.isArray(finalSchedule)) return;
        studentViewOutput.innerHTML = '';

        const byStudent = {};
        students.forEach(s => { byStudent[s.name] = []; });
        finalSchedule.forEach(day => {
            day.slots.forEach(slot => {
                (slot.assigned || []).forEach(name => {
                    (byStudent[name] ||= []).push({ date: day.date, dayName: day.dayName, activity: slot.activity });
                });
            });
        });

        Object.keys(byStudent).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(name => {
            const student = students.find(s => s.name === name);
            const entries = byStudent[name].sort((a, b) =>
                a.date === b.date
                    ? a.activity.startTime.localeCompare(b.activity.startTime)
                    : a.date.localeCompare(b.date));
            const totalHours = entries.reduce((sum, e) => sum + (e.activity.hoursCount || 0), 0);

            let totalsHtml;
            if (rotationConfig.twoGroupsEnabled) {
                const hoursGroup1 = entries.filter(e => (e.activity.activityGroup || '1') === '1').reduce((sum, e) => sum + (e.activity.hoursCount || 0), 0);
                const hoursGroup2 = entries.filter(e => e.activity.activityGroup === '2').reduce((sum, e) => sum + (e.activity.hoursCount || 0), 0);
                totalsHtml = `
                    <span class="student-agenda-total">${hoursGroup1.toFixed(1)}h / ${rotationConfig.requiredHoursGroup1 || 0}h (${groupDisplayName('1')})</span>
                    <span class="student-agenda-total">${hoursGroup2.toFixed(1)}h / ${rotationConfig.requiredHoursGroup2 || 0}h (${groupDisplayName('2')})</span>
                `;
            } else {
                totalsHtml = `<span class="student-agenda-total">${totalHours.toFixed(1)}h / ${rotationConfig.requiredHours || 0}h</span>`;
            }

            const card = document.createElement('div');
            card.className = 'student-agenda-card';

            const rowsHtml = entries.map(e => `
                <tr>
                    <td>${formatDateBR(e.date)}</td>
                    <td>${DAY_TRANSLATIONS[e.dayName] || e.dayName}</td>
                    <td>${e.activity.name}</td>
                    <td>${e.activity.startTime} - ${e.activity.endTime}</td>
                    <td>${e.activity.location || ''}</td>
                    <td>${e.activity.hoursCount}h</td>
                </tr>`).join('');

            card.innerHTML = `
                <div class="student-agenda-header">
                    <span class="color-dot" style="background-color: ${student ? student.color : '#ccc'}"></span>
                    <h4>${name}</h4>
                    ${student && student.affinityGroup ? `<span class="affinity-badge">👥 ${student.affinityGroup}</span>` : ''}
                    ${totalsHtml}
                </div>
                ${entries.length === 0 ? '<p class="empty-msg">Nenhuma atividade atribuída.</p>' : `
                <table class="stats-table student-agenda-table">
                    <thead><tr><th>Data</th><th>Dia</th><th>Atividade</th><th>Horário</th><th>Local</th><th>Horas</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>`}
            `;
            studentViewOutput.appendChild(card);
        });
    }

    function applyViewMode() {
        const isStudentView = currentView === 'student';
        calendarOutput.classList.toggle('hidden', isStudentView);
        if (studentViewOutput) studentViewOutput.classList.toggle('hidden', !isStudentView);
        if (viewToggleBtn) viewToggleBtn.textContent = isStudentView ? 'Visão por Calendário' : 'Visão por Aluno';
    }

    if (viewToggleBtn) {
        viewToggleBtn.addEventListener('click', () => {
            if (!lastGeneratedSchedule) {
                showToast('Gere uma escala primeiro (botão "✨ Gerar Escala de Rodízio").', { type: 'warning' });
                return;
            }
            currentView = currentView === 'calendar' ? 'student' : 'calendar';
            if (currentView === 'student') renderStudentView(lastGeneratedSchedule.finalSchedule);
            applyViewMode();
        });
    }

    // --- Validação de backup importado ---

    function validateBackupData(data) {
        const errors = [];
        const warnings = [];
        const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
        const TIME_RE = /^\d{2}:\d{2}$/;
        const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            errors.push('O arquivo não tem o formato de um backup deste sistema.');
            return { errors, warnings };
        }
        if (!Array.isArray(data.activities)) errors.push('Campo "activities" ausente ou inválido.');
        if (!data.config || typeof data.config !== 'object') errors.push('Campo "config" ausente ou inválido.');
        if (data.students !== undefined && !Array.isArray(data.students)) errors.push('Campo "students" inválido (deveria ser uma lista).');
        if (errors.length) return { errors, warnings };

        const cfg = data.config;
        if (cfg.startDate && !DATE_RE.test(cfg.startDate)) errors.push(`Config: data de início inválida ("${cfg.startDate}").`);
        if (cfg.endDate && !DATE_RE.test(cfg.endDate)) errors.push(`Config: data de término inválida ("${cfg.endDate}").`);
        if (DATE_RE.test(cfg.startDate || '') && DATE_RE.test(cfg.endDate || '') && cfg.startDate > cfg.endDate) {
            errors.push('Config: a data de início é posterior à data de término.');
        }
        if (cfg.requiredHours != null && (typeof cfg.requiredHours !== 'number' || cfg.requiredHours < 0)) {
            warnings.push('Config: meta de horas inválida — será tratada como 0.');
        }
        if (cfg.blackoutPeriods != null) {
            const isValidBlackoutPeriod = (bp) => bp && typeof bp === 'object' &&
                DATE_RE.test(bp.start || '') && DATE_RE.test(bp.end || '') && bp.start <= bp.end;
            if (!Array.isArray(cfg.blackoutPeriods) || cfg.blackoutPeriods.some(bp => !isValidBlackoutPeriod(bp))) {
                warnings.push('Config: lista de períodos sem atividades contém datas inválidas e será ignorada.');
            }
        }
        if (cfg.twoGroupsEnabled) {
            if (!Array.isArray(cfg.groupNames) || cfg.groupNames.length !== 2) {
                warnings.push('Config: nomes dos grupos de atividade ausentes ou inválidos — serão tratados como "Grupo 1"/"Grupo 2".');
            }
            if (cfg.requiredHoursGroup1 != null && (typeof cfg.requiredHoursGroup1 !== 'number' || cfg.requiredHoursGroup1 < 0)) {
                warnings.push('Config: meta de horas do Grupo 1 inválida — será tratada como 0.');
            }
            if (cfg.requiredHoursGroup2 != null && (typeof cfg.requiredHoursGroup2 !== 'number' || cfg.requiredHoursGroup2 < 0)) {
                warnings.push('Config: meta de horas do Grupo 2 inválida — será tratada como 0.');
            }
        }

        const isValidActivityException = (ex) => {
            if (typeof ex === 'string') return DATE_RE.test(ex);
            if (ex && typeof ex === 'object') return DATE_RE.test(ex.start || '') && DATE_RE.test(ex.end || '') && ex.start <= ex.end;
            return false;
        };

        const activityIds = new Set();
        data.activities.forEach((a, i) => {
            const label = `Atividade ${i + 1}` + (a && a.name ? ` ("${a.name}")` : '');
            if (!a || typeof a !== 'object') {
                errors.push(`${label}: entrada inválida.`);
                return;
            }
            if (a.id == null) errors.push(`${label}: sem "id".`);
            else if (activityIds.has(String(a.id))) errors.push(`${label}: "id" duplicado (${a.id}).`);
            else activityIds.add(String(a.id));

            if (!a.name || !String(a.name).trim()) errors.push(`${label}: sem nome.`);
            if (!VALID_DAYS.includes(a.day)) errors.push(`${label}: dia da semana inválido ("${a.day}").`);
            if (!TIME_RE.test(a.startTime || '') || !TIME_RE.test(a.endTime || '')) errors.push(`${label}: horários inválidos.`);
            else if (a.startTime >= a.endTime) warnings.push(`${label}: o término não é depois do início.`);
            if (typeof a.hoursCount !== 'number' || a.hoursCount < 0) errors.push(`${label}: carga horária inválida.`);
            if (!Number.isInteger(a.studentsCount) || a.studentsCount < 1) errors.push(`${label}: número máximo de alunos inválido.`);
            const min = a.minStudents ?? 1;
            if (!Number.isInteger(min) || min < 0) errors.push(`${label}: mínimo de alunos inválido.`);
            else if (Number.isInteger(a.studentsCount) && min > a.studentsCount) errors.push(`${label}: mínimo (${min}) maior que o máximo (${a.studentsCount}).`);
            if (a.exceptions && (!Array.isArray(a.exceptions) || a.exceptions.some(ex => !isValidActivityException(ex)))) {
                warnings.push(`${label}: lista de exceções contém datas inválidas.`);
            }
            if (cfg.twoGroupsEnabled && a.activityGroup !== '1' && a.activityGroup !== '2') {
                warnings.push(`${label}: sem grupo de atividade definido — será tratada como Grupo 1.`);
            }
        });

        const studentIds = new Set();
        const studentNames = new Set();
        (data.students || []).forEach((s, i) => {
            const label = `Aluno ${i + 1}` + (s && s.name ? ` ("${s.name}")` : '');
            if (!s || typeof s !== 'object') {
                errors.push(`${label}: entrada inválida.`);
                return;
            }
            if (s.id == null) errors.push(`${label}: sem "id".`);
            else if (studentIds.has(String(s.id))) errors.push(`${label}: "id" duplicado (${s.id}).`);
            else studentIds.add(String(s.id));

            const trimmedName = s.name && String(s.name).trim();
            if (!trimmedName) errors.push(`${label}: sem nome.`);
            else if (studentNames.has(trimmedName)) errors.push(`${label}: nome duplicado — a escala identifica alunos pelo nome.`);
            else studentNames.add(trimmedName);

            if (s.exceptions && !Array.isArray(s.exceptions)) warnings.push(`${label}: campo de exceções inválido e será ignorado.`);
            if (s.preferredDates && !Array.isArray(s.preferredDates)) warnings.push(`${label}: campo de preferências inválido e será ignorado.`);
        });

        if (data.lastGeneratedSchedule && !Array.isArray(data.lastGeneratedSchedule.finalSchedule)) {
            warnings.push('A escala salva no backup está incompleta e será ignorada.');
        }
        if (data.pinnedAssignments !== undefined && !Array.isArray(data.pinnedAssignments)) {
            warnings.push('Lista de atribuições fixadas inválida e será ignorada.');
        }

        return { errors, warnings };
    }

    function renderGeneratedResults(scheduleData, { scroll = false } = {}) {
        if (!scheduleData) return;
        
        const {
            studentStats = [],
            mandatoryActivities = []
        } = scheduleData;

        // healthWarning (string) vem de backups antigos; feasibility/pinWarnings é o formato atual
        renderHealthIssues(scheduleData.feasibility, scheduleData.pinWarnings, scheduleData.healthWarning);

        resultsContainer.classList.remove('hidden');

        const showGroupHours = !!rotationConfig.twoGroupsEnabled;
        // Coluna/exigência de plantão só existe se a escala tiver algum PLANTÃO
        const showPlantao = (scheduleData.finalSchedule || []).some(day =>
            (day.slots || []).some(slot => isPlantao(slot.activity.type)));
        const [group1Label, group2Label] = showGroupHours ? [groupDisplayName('1'), groupDisplayName('2')] : ['', ''];

        // 1. Render Stats
        let statsHtml = `
            <h3>Equilíbrio de Carga Horária e Requisitos</h3>
            <p class="field-hint">Horas: quanto cada aluno ficou escalado comparado com a meta. Atividades cobertas: se o aluno passou pelo menos uma vez por cada atividade diferente (passe o mouse para ver o que falta).</p>
            <div class="table-scroll"><table class="stats-table">
                <thead>
                    <tr>
                        <th>Nome do Aluno</th>
                        ${showGroupHours
                            ? `<th>Horas (${group1Label})</th><th>Horas (${group2Label})</th>`
                            : '<th>Horas</th>'}
                        ${showPlantao ? '<th>Plantão</th>' : ''}
                        <th>Atividades Cobertas</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
        `;

        studentStats.forEach(stat => {
            const diff = stat.requiredHours - stat.totalHours;

            const hourPillFor = (hours, required) => (required - hours) <= 0
                ? `<span class="pill pill-success">✅ ${hours.toFixed(1)}h / ${required}h</span>`
                : `<span class="pill pill-warning">⌛ ${hours.toFixed(1)}h / ${required}h</span>`;

            let hoursCellsHtml;
            let groupsComplete = true;
            if (showGroupHours) {
                const hoursByGroup = stat.hoursByGroup || { 1: 0, 2: 0 };
                const requiredByGroup = stat.requiredHoursByGroup || { 1: 0, 2: 0 };
                groupsComplete = (requiredByGroup[1] - hoursByGroup[1]) <= 0 && (requiredByGroup[2] - hoursByGroup[2]) <= 0;
                hoursCellsHtml = `
                    <td>${hourPillFor(hoursByGroup[1] || 0, requiredByGroup[1] || 0)}</td>
                    <td>${hourPillFor(hoursByGroup[2] || 0, requiredByGroup[2] || 0)}</td>
                `;
            } else {
                hoursCellsHtml = `<td>${hourPillFor(stat.totalHours, stat.requiredHours)}</td>`;
            }

            const plantaoPill = stat.hasPlantao
                ? '<span class="pill pill-success">✅</span>'
                : '<span class="pill pill-danger">❌</span>';

            const coveredCount = stat.coveredActivities.size;
            const totalMandatory = mandatoryActivities.length;
            const coveragePill = coveredCount === totalMandatory
                ? '<span class="pill pill-success">✅ Completo</span>'
                : `<span class="pill pill-warning">⚠️ ${coveredCount}/${totalMandatory}</span>`;

            const isComplete = (showGroupHours ? groupsComplete : diff <= 0) && (!showPlantao || stat.hasPlantao) && coveredCount === totalMandatory;
            const overallPill = isComplete
                ? '<span class="pill pill-success">✅ Completo</span>'
                : '<span class="pill pill-warning">⌛ Pendente</span>';

            // Create a tooltip for missing activities
            const missing = mandatoryActivities.filter(m => !stat.coveredActivities.has(m));
            const coverageTitle = missing.length > 0 ? `Faltando: ${missing.join(', ')}` : 'Todas cobertas';

            statsHtml += `
                <tr>
                    <td>${stat.name}</td>
                    ${hoursCellsHtml}
                    ${showPlantao ? `<td style="text-align: center">${plantaoPill}</td>` : ''}
                    <td title="${coverageTitle}" style="cursor: help">${coveragePill}</td>
                    <td>${overallPill}</td>
                </tr>
            `;
        });
        statsHtml += '</tbody></table></div>';
        statisticsOutput.innerHTML = statsHtml;
        
        // Rola até o resultado só quando a escala acabou de ser gerada (não a cada troca manual)
        if (scroll) resultsContainer.scrollIntoView({ behavior: 'smooth' });
    }

    // Export Data
    const exportBtn = document.getElementById('export-btn');
    exportBtn.addEventListener('click', () => {
        // Deep clone lastGeneratedSchedule to avoid modifying the live state
        const exportedSchedule = serializeSchedule(lastGeneratedSchedule);

        const dataToExport = {
            version: 1,
            config: rotationConfig,
            activities: activities,
            students: students,
            pinnedAssignments: pinnedAssignments,
            lastGeneratedSchedule: exportedSchedule
        };

        const dateStr = formatDateBR(toLocalDateStr(new Date())).replace(/\//g, '-');
        downloadFile(JSON.stringify(dataToExport, null, 2), 'application/json', `backup_escalas_med_${dateStr}.json`);
    });

    // Import Data (JSON)
    const importBtn = document.getElementById('import-btn');
    const importFile = document.getElementById('import-file');

    importBtn.addEventListener('click', () => {
        importFile.click();
    });

    importFile.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            importFile.value = '';
            let importedData;
            try {
                importedData = JSON.parse(event.target.result);
            } catch (err) {
                showToast('Esse arquivo não é um backup válido. Escolha o arquivo .json baixado em "Baixar backup (.json)".', { type: 'error' });
                return;
            }

            // Backups antigos (ou editados à mão) podem ter datas dd/mm/aaaa ou horários 7:00 / 7:00 PM
            normalizeBackupFormats(importedData);

            // Validação com mensagens claras (backups ruins corrompiam o estado em silêncio)
            const validation = validateBackupData(importedData);
            if (validation.errors.length > 0) {
                const shown = validation.errors.slice(0, 12);
                if (validation.errors.length > shown.length) shown.push(`... e mais ${validation.errors.length - shown.length} problema(s).`);
                await askConfirm({
                    title: 'Não foi possível importar',
                    message: 'O arquivo tem problemas e nada foi alterado. Detalhes:',
                    details: shown,
                    confirmLabel: 'Entendi',
                    cancelLabel: 'Fechar'
                });
                return;
            }

            const ok = await askConfirm({
                title: 'Importar backup?',
                message: `Isso vai SUBSTITUIR tudo o que está no app agora (período, ${importedData.activities.length} atividade(s), ${(importedData.students || []).length} aluno(s) e a escala gerada).` +
                    (validation.warnings.length ? '\n\nAvisos encontrados no arquivo:' : ''),
                details: validation.warnings.slice(0, 10),
                confirmLabel: 'Importar e substituir',
                extraLabel: '⬇️ Baixar backup do que está aqui antes',
                onExtra: () => exportBtn.click()
            });
            if (!ok) return;

            try {
                activities = importedData.activities;
                // Garante tipo (compatibilidade) e nomes sem espaços sobrando
                activities.forEach(a => {
                    if (!a.type) a.type = 'PLANTÃO';
                    if (a.name) a.name = a.name.trim();
                });

                // rotationConfig precisa estar atualizado antes de qualquer cálculo
                rotationConfig = importedData.config;
                if (rotationConfig.twoGroupsEnabled) {
                    activities.forEach(a => {
                        if (a.activityGroup !== '1' && a.activityGroup !== '2') a.activityGroup = '1';
                    });
                }
                students = importedData.students || [];
                pinnedAssignments = Array.isArray(importedData.pinnedAssignments) ? importedData.pinnedAssignments : [];
                savePins();

                // Garante cor e grupo de afinidade
                students.forEach(s => {
                    if (!s.color) s.color = getRandomColor();
                    if (!s.affinityGroup) s.affinityGroup = 'A';
                });

                localStorage.setItem('med_rotations_activities', JSON.stringify(activities));
                localStorage.setItem('med_rotations_config', JSON.stringify(rotationConfig));
                localStorage.setItem('med_rotations_students', JSON.stringify(students));

                // Atualiza a tela
                document.getElementById('rotation-start').value = rotationConfig.startDate || '';
                document.getElementById('rotation-end').value = rotationConfig.endDate || '';
                document.getElementById('required-hours').value = rotationConfig.requiredHours || '';
                document.getElementById('two-groups-toggle').checked = !!rotationConfig.twoGroupsEnabled;
                document.getElementById('group1-name').value = (rotationConfig.groupNames && rotationConfig.groupNames[0]) || 'Grupo 1';
                document.getElementById('group2-name').value = (rotationConfig.groupNames && rotationConfig.groupNames[1]) || 'Grupo 2';
                document.getElementById('group1-hours').value = rotationConfig.requiredHoursGroup1 || '';
                document.getElementById('group2-hours').value = rotationConfig.requiredHoursGroup2 || '';
                currentBlackoutPeriods = [...(rotationConfig.blackoutPeriods || [])];
                renderBlackoutChips();
                updateTwoGroupsUI();
                renderStudents();

                const sched = importedData.lastGeneratedSchedule;
                if (!(sched && Array.isArray(sched.finalSchedule) && restoreSchedule(sched))) {
                    lastGeneratedSchedule = null;
                    resultsContainer.classList.add('hidden');
                }
                persistSchedule();
                markScheduleFresh();
                updateProgress();

                showToast(lastGeneratedSchedule
                    ? '✅ Backup importado, com a escala que estava salva nele.'
                    : '✅ Backup importado. Agora é só clicar em "Gerar Escala de Rodízio".', { type: 'success' });
            } catch (error) {
                console.error(error);
                showToast('Erro ao importar dados: ' + error.message, { type: 'error' });
            }
        };
        reader.readAsText(file);
    });

    // Delete All Data
    const deleteAllBtn = document.getElementById('delete-all-btn');
    deleteAllBtn.addEventListener('click', async () => {
        const ok = await askConfirm({
            title: 'Começar do zero?',
            message: 'Isso apaga o período, todas as atividades, todos os alunos e a escala gerada deste navegador. Não dá para desfazer.\n\nDica: baixe um backup antes. Ele pode ser importado depois para recuperar tudo.',
            confirmLabel: 'Excluir tudo',
            danger: true,
            extraLabel: '⬇️ Baixar backup antes',
            onExtra: () => exportBtn.click()
        });
        if (ok) {
            // Clear localStorage
            localStorage.removeItem('med_rotations_activities');
            localStorage.removeItem('med_rotations_config');
            localStorage.removeItem('med_rotations_students');
            localStorage.removeItem('med_rotations_pins');
            localStorage.removeItem(SCHEDULE_STORAGE_KEY);

            // Reset state
            activities = [];
            students = [];
            rotationConfig = {
                startDate: '',
                endDate: '',
                requiredHours: 0,
                twoGroupsEnabled: false,
                groupNames: ['Grupo 1', 'Grupo 2'],
                requiredHoursGroup1: 0,
                requiredHoursGroup2: 0,
                blackoutPeriods: []
            };
            lastGeneratedSchedule = null;
            pinnedAssignments = [];
            updateClearPinsButton();
            currentExceptions = [];
            currentStudentExceptions = [];
            currentStudentPreferred = [];
            currentBlackoutPeriods = [];

            // Update UI
            document.getElementById('rotation-start').value = '';
            document.getElementById('rotation-end').value = '';
            document.getElementById('required-hours').value = '';
            document.getElementById('two-groups-toggle').checked = false;
            document.getElementById('group1-name').value = 'Grupo 1';
            document.getElementById('group2-name').value = 'Grupo 2';
            document.getElementById('group1-hours').value = '';
            document.getElementById('group2-hours').value = '';

            activityForm.reset();
            studentForm.reset();

            updateTwoGroupsUI();
            renderStudents();
            renderExceptionChips();
            renderStudentExceptionChips();
            renderStudentPreferredChips();
            renderBlackoutChips();
            
            resultsContainer.classList.add('hidden');
            markScheduleFresh();
            updateProgress();

            showToast('Todos os dados foram excluídos.', { type: 'success' });
        }
    });
    // --- Ao abrir a página: recoloca a última escala gerada (com as trocas manuais) ---
    const staleBtn = document.getElementById('stale-regenerate-btn');
    if (staleBtn && staleBtn.addEventListener) staleBtn.addEventListener('click', () => generateBtn.click());

    try {
        const savedSchedule = prefs.get(SCHEDULE_STORAGE_KEY);
        if (savedSchedule) {
            const parsed = normalizeBackupFormats({ lastGeneratedSchedule: JSON.parse(savedSchedule) }).lastGeneratedSchedule;
            if (restoreSchedule(parsed) && prefs.get('med_rotations_schedule_stale') === '1') {
                const banner = document.getElementById('stale-banner');
                if (banner && banner.classList) banner.classList.remove('hidden');
            }
        }
    } catch (e) {
        console.warn('Não foi possível recuperar a escala salva:', e);
        prefs.remove(SCHEDULE_STORAGE_KEY);
    }
    updateProgress();
});