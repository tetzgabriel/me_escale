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
                if (!stat.hasPlantao) coveragePenalty += 100;

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
    getAdjacentDateStr, hasException, checkOverlap, calculateMandatoryActivities
} = SchedulerCore;

document.addEventListener('DOMContentLoaded', () => {
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
    const closeModal = document.querySelector('.close-modal');

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
        // Ensure all activities have a type (for backward compatibility) and trim names
        activities.forEach(a => {
            if (!a.type) a.type = 'PLANTÃO';
            if (a.name) a.name = a.name.trim();
        });
    }

    const savedStudents = localStorage.getItem('med_rotations_students');
    if (savedStudents) {
        students = JSON.parse(savedStudents);
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

    // Toggle Rules List
    const toggleRulesBtn = document.getElementById('toggle-rules');
    if (toggleRulesBtn) {
        toggleRulesBtn.addEventListener('click', () => {
            const content = document.getElementById('rules-container');
            toggleRulesBtn.classList.toggle('active');
            content.classList.toggle('hidden');
        });
    }

    // Global dates handler
    saveGlobalBtn.addEventListener('click', () => {
        rotationConfig.startDate = document.getElementById('rotation-start').value;
        rotationConfig.endDate = document.getElementById('rotation-end').value;
        rotationConfig.requiredHours = parseFloat(document.getElementById('required-hours').value) || 0;
        rotationConfig.twoGroupsEnabled = document.getElementById('two-groups-toggle').checked;
        rotationConfig.groupNames = currentGroupNames();
        rotationConfig.requiredHoursGroup1 = parseFloat(document.getElementById('group1-hours').value) || 0;
        rotationConfig.requiredHoursGroup2 = parseFloat(document.getElementById('group2-hours').value) || 0;
        rotationConfig.blackoutPeriods = [...currentBlackoutPeriods];
        localStorage.setItem('med_rotations_config', JSON.stringify(rotationConfig));
        alert('Configurações da escala salvas!');
    });

    // Schedule-wide blackout periods: no activity happens for anyone in these date ranges.
    function renderBlackoutChips() {
        currentBlackoutList.innerHTML = '';
        currentBlackoutPeriods.forEach((bp, index) => {
            const tag = document.createElement('span');
            tag.className = 'tag exception';
            tag.innerHTML = `
                ${bp.start} a ${bp.end}
                <span class="remove-blackout-tag" data-index="${index}">&times;</span>
            `;
            currentBlackoutList.appendChild(tag);
        });

        document.querySelectorAll('.remove-blackout-tag').forEach(span => {
            span.onclick = (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'));
                currentBlackoutPeriods.splice(idx, 1);
                renderBlackoutChips();
            };
        });
    }

    addBlackoutBtn.addEventListener('click', () => {
        const startInput = document.getElementById('blackout-start');
        const endInput = document.getElementById('blackout-end');
        const startValue = startInput.value;
        let endValue = endInput.value || startValue;

        if (!startValue) return;

        if (endValue < startValue) {
            alert('A data final do período deve ser igual ou posterior à data inicial.');
            return;
        }

        currentBlackoutPeriods.push({ start: startValue, end: endValue });
        renderBlackoutChips();
        startInput.value = '';
        endInput.value = '';
    });

    // Activity exceptions can be a single date ("YYYY-MM-DD") or an interval
    // ({start, end}) covering a range of days the activity won't happen.
    function formatExceptionLabel(exc) {
        return typeof exc === 'string' ? exc : `${exc.start} a ${exc.end}`;
    }

    // Add exception handler
    addExceptionBtn.addEventListener('click', () => {
        const dateInput = document.getElementById('exception-date');
        const endInput = document.getElementById('exception-date-end');
        const startValue = dateInput.value;
        const endValue = endInput.value;

        if (!startValue) return;

        if (endValue && endValue !== startValue) {
            if (endValue < startValue) {
                alert('A data final da exceção deve ser igual ou posterior à data inicial.');
                return;
            }
            currentExceptions.push({ start: startValue, end: endValue });
        } else if (!currentExceptions.includes(startValue)) {
            currentExceptions.push(startValue);
        }

        renderExceptionChips();
        dateInput.value = '';
        endInput.value = '';
    });

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
    activityForm.addEventListener('submit', (e) => {
        e.preventDefault();

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

        activities.push(newActivity);
        saveActivities();
        renderActivities();

        // Reset
        activityForm.reset();
        currentExceptions = [];
        renderExceptionChips();
    });

    // Student exception handler
    addStudentExceptionBtn.addEventListener('click', () => {
        const dateInput = document.getElementById('student-exception-date');
        const startInput = document.getElementById('student-exc-start');
        const endInput = document.getElementById('student-exc-end');
        const dateValue = dateInput.value;
        
        if (dateValue) {
            currentStudentExceptions.push({
                date: dateValue,
                startTime: startInput.value,
                endTime: endInput.value
            });
            renderStudentExceptionChips();
            dateInput.value = '';
            startInput.value = '';
            endInput.value = '';
        }
    });

    function renderStudentExceptionChips() {
        currentStudentExceptionsList.innerHTML = '';
        currentStudentExceptions.forEach((exc, index) => {
            const timeInfo = (exc.startTime && exc.endTime) ? ` (${exc.startTime}-${exc.endTime})` : '';
            const tag = document.createElement('span');
            tag.className = 'tag exception';
            tag.innerHTML = `
                ${exc.date}${timeInfo} 
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
        const dateInput = document.getElementById('student-preferred-date');
        const startInput = document.getElementById('student-pref-start');
        const endInput = document.getElementById('student-pref-end');
        const dateValue = dateInput.value;
        
        if (dateValue) {
            currentStudentPreferred.push({
                date: dateValue,
                startTime: startInput.value,
                endTime: endInput.value
            });
            renderStudentPreferredChips();
            dateInput.value = '';
            startInput.value = '';
            endInput.value = '';
        }
    });

    function renderStudentPreferredChips() {
        currentStudentPreferredList.innerHTML = '';
        currentStudentPreferred.forEach((pref, index) => {
            const timeInfo = (pref.startTime && pref.endTime) ? ` (${pref.startTime}-${pref.endTime})` : '';
            const tag = document.createElement('span');
            tag.className = 'tag preferred';
            tag.innerHTML = `
                ${pref.date}${timeInfo} 
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
    studentForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const newStudent = {
            id: Date.now(),
            name: document.getElementById('student-name').value,
            affinityGroup: document.getElementById('student-affinity').value || 'A',
            exceptions: [...currentStudentExceptions],
            preferredDates: [...currentStudentPreferred],
            color: getRandomColor()
        };

        students.push(newStudent);
        saveStudents();
        renderStudents();

        // Reset
        studentForm.reset();
        currentStudentExceptions = [];
        currentStudentPreferred = [];
        renderStudentExceptionChips();
        renderStudentPreferredChips();
    });

    function renderStudents() {
        if (!studentsContainer) return;

        const studentsCountBadge = document.getElementById('students-count');
        if (studentsCountBadge) studentsCountBadge.textContent = students.length;

        if (students.length === 0) {
            studentsContainer.innerHTML = '<p class="empty-msg">Nenhum aluno adicionado ainda.</p>';
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
                            const val = typeof exc === 'string' ? exc : exc.date + (exc.startTime ? ` (${exc.startTime}-${exc.endTime})` : '');
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
                            const val = typeof pref === 'string' ? pref : pref.date + (pref.startTime ? ` (${pref.startTime}-${pref.endTime})` : '');
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
                    <label>Nome do Aluno</label>
                    <input type="text" id="edit-student-name" value="${student.name}" required>
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
                    <h4>Exceções e Horários do Aluno</h4>
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
                    <h4>Datas e Horários Preferenciais</h4>
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

        const renderModalChips = () => {
            const excList = document.getElementById('modal-exc-list');
            excList.innerHTML = '';
            modalExceptions.forEach((exc, idx) => {
                const timeInfo = (exc.startTime && exc.endTime) ? ` (${exc.startTime}-${exc.endTime})` : '';
                const tag = document.createElement('span');
                tag.className = 'tag exception';
                tag.innerHTML = `${exc.date}${timeInfo} <span class="remove-modal-tag" data-idx="${idx}">&times;</span>`;
                excList.appendChild(tag);
            });

            const prefList = document.getElementById('modal-pref-list');
            prefList.innerHTML = '';
            modalPreferred.forEach((pref, idx) => {
                const timeInfo = (pref.startTime && pref.endTime) ? ` (${pref.startTime}-${pref.endTime})` : '';
                const tag = document.createElement('span');
                tag.className = 'tag preferred';
                tag.innerHTML = `${pref.date}${timeInfo} <span class="remove-modal-tag" data-idx="${idx}">&times;</span>`;
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

        document.getElementById('modal-add-exc').onclick = () => {
            const date = document.getElementById('modal-exc-date').value;
            if (date) {
                modalExceptions.push({
                    date,
                    startTime: document.getElementById('modal-exc-start').value,
                    endTime: document.getElementById('modal-exc-end').value
                });
                renderModalChips();
                document.getElementById('modal-exc-date').value = '';
                document.getElementById('modal-exc-start').value = '';
                document.getElementById('modal-exc-end').value = '';
            }
        };

        document.getElementById('modal-add-pref').onclick = () => {
            const date = document.getElementById('modal-pref-date').value;
            if (date) {
                modalPreferred.push({
                    date,
                    startTime: document.getElementById('modal-pref-start').value,
                    endTime: document.getElementById('modal-pref-end').value
                });
                renderModalChips();
                document.getElementById('modal-pref-date').value = '';
                document.getElementById('modal-pref-start').value = '';
                document.getElementById('modal-pref-end').value = '';
            }
        };

        editModal.classList.remove('hidden');

        document.getElementById('edit-student-form').onsubmit = (e) => {
            e.preventDefault();
            student.name = document.getElementById('edit-student-name').value;
            student.affinityGroup = document.getElementById('edit-student-affinity').value || 'A';
            student.exceptions = modalExceptions;
            student.preferredDates = modalPreferred;
            saveStudents();
            renderStudents();
            closeModalHandler();
        };
    }

    function deleteStudent(id) {
        students = students.filter(s => s.id !== id);
        saveStudents();
        renderStudents();
    }

    function saveStudents() {
        localStorage.setItem('med_rotations_students', JSON.stringify(students));
    }

    // Render function
    function renderActivities() {
        const activitiesCountBadge = document.getElementById('activities-count');
        if (activitiesCountBadge) activitiesCountBadge.textContent = activities.length;

        if (activities.length === 0) {
            activitiesContainer.innerHTML = '<p class="empty-msg">Nenhuma atividade adicionada ainda.</p>';
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
                    <h3>${activity.name} <span class="type-badge">${activity.type || 'PLANTÃO'}</span>${groupBadge}</h3>
                    <div class="activity-details">
                        <span><strong>Dia:</strong> ${DAY_TRANSLATIONS[activity.day]}</span>
                        <span><strong>Horário:</strong> ${activity.startTime} - ${activity.endTime}</span>
                        <span><strong>Local:</strong> ${activity.location}</span>
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
                <div class="form-group">
                    <label>Nome da Atividade</label>
                    <input type="text" id="edit-activity-name" value="${activity.name}" required>
                </div>
                <div class="form-group">
                    <label>Tipo de Atividade</label>
                    <select id="edit-activity-type" required>
                        <option value="PLANTÃO" ${activity.type === 'PLANTÃO' ? 'selected' : ''}>PLANTÃO</option>
                        <option value="AMBULATORIO" ${activity.type === 'AMBULATORIO' ? 'selected' : ''}>AMBULATORIO</option>
                    </select>
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
                    <label>Local</label>
                    <input type="text" id="edit-location" value="${activity.location}" required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Alunos (Mín)</label>
                        <input type="number" id="edit-min-students" min="0" value="${activity.minStudents ?? 1}" required>
                    </div>
                    <div class="form-group">
                        <label>Alunos (Máx)</label>
                        <input type="number" id="edit-students-number" value="${activity.studentsCount}" required>
                    </div>
                    <div class="form-group">
                        <label>Carga Horária</label>
                        <input type="number" id="edit-hours-count" step="0.5" value="${activity.hoursCount}" required>
                    </div>
                </div>

                <div class="modal-section exceptions-section">
                    <h4>Exceções da Atividade</h4>
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

        document.getElementById('modal-act-add-exc').onclick = () => {
            const startInput = document.getElementById('modal-act-exc-date');
            const endInput = document.getElementById('modal-act-exc-date-end');
            const startValue = startInput.value;
            const endValue = endInput.value;

            if (!startValue) return;

            if (endValue && endValue !== startValue) {
                if (endValue < startValue) {
                    alert('A data final da exceção deve ser igual ou posterior à data inicial.');
                    return;
                }
                modalExceptions.push({ start: startValue, end: endValue });
            } else if (!modalExceptions.includes(startValue)) {
                modalExceptions.push(startValue);
            }

            renderModalChips();
            startInput.value = '';
            endInput.value = '';
        };

        editModal.classList.remove('hidden');

        document.getElementById('edit-activity-form').onsubmit = (e) => {
            e.preventDefault();
            activity.name = document.getElementById('edit-activity-name').value;
            activity.type = document.getElementById('edit-activity-type').value;
            activity.location = document.getElementById('edit-location').value;
            const editedMin = parseInt(document.getElementById('edit-min-students').value);
            activity.minStudents = Number.isNaN(editedMin) ? 1 : editedMin;
            activity.studentsCount = parseInt(document.getElementById('edit-students-number').value);
            activity.hoursCount = parseFloat(document.getElementById('edit-hours-count').value);
            activity.exceptions = modalExceptions;
            if (rotationConfig.twoGroupsEnabled) {
                activity.activityGroup = document.getElementById('edit-activity-group').value;
            }

            saveActivities();
            renderActivities();
            closeModalHandler();
        };
    }

    // Modal Close Logic
    function closeModalHandler() {
        editModal.classList.add('hidden');
        modalBody.innerHTML = '';
    }

    closeModal.onclick = closeModalHandler;
    window.onclick = (e) => {
        if (e.target === editModal) closeModalHandler();
    };

    function deleteActivity(id) {
        activities = activities.filter(activity => activity.id !== id);
        saveActivities();
        renderActivities();
    }

    function saveActivities() {
        localStorage.setItem('med_rotations_activities', JSON.stringify(activities));
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
    const exportSheetsBtn = document.getElementById('export-sheets-btn');
    const clearPinsBtn = document.getElementById('clear-pins-btn');

    let lastGeneratedSchedule = null;
    let currentView = 'calendar'; // 'calendar' | 'student'

    // Atribuições fixadas (📌): sobrevivem à re-geração da escala
    let pinnedAssignments = [];
    try {
        pinnedAssignments = JSON.parse(localStorage.getItem('med_rotations_pins')) || [];
    } catch (e) {
        pinnedAssignments = [];
    }

    if (printBtn) {
        printBtn.addEventListener('click', () => {
            if (lastGeneratedSchedule && calendarOutput.innerHTML === '') {
                renderCalendarView(lastGeneratedSchedule.finalSchedule);
            }
            window.print();
        });
    }

    if (generateBtn) {
        const generateBtnDefaultLabel = generateBtn.textContent;
        generateBtn.addEventListener('click', () => {
            if (!rotationConfig.startDate || !rotationConfig.endDate) {
                alert('Por favor, defina as datas de início e término primeiro.');
                return;
            }
            if (activities.length === 0 || students.length === 0) {
                alert('Por favor, adicione atividades e alunos primeiro.');
                return;
            }

            // Pre-generation feasibility check (cheap; no schedule required)
            const feasibility = SchedulerCore.analyzeFeasibility(activities, students, rotationConfig);
            renderHealthIssues(feasibility, [], null);
            if (feasibility.errors.length > 0) {
                const proceed = confirm(
                    'A verificação prévia encontrou problemas:\n\n- ' +
                    feasibility.errors.join('\n- ') +
                    '\n\nDeseja gerar a escala mesmo assim?'
                );
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
                    renderGeneratedResults(scheduleData);
                    renderCalendarView(scheduleData.finalSchedule);
                    renderStudentView(scheduleData.finalSchedule);
                })
                .catch(err => {
                    alert('Erro ao gerar a escala: ' + err.message);
                })
                .finally(() => {
                    generateBtn.disabled = false;
                    generateBtn.textContent = generateBtnDefaultLabel;
                });
        });
    }

    function renderCalendarView(finalSchedule) {
        if (!rotationConfig.startDate || !rotationConfig.endDate || !Array.isArray(finalSchedule)) return;
        
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
                        
                        const assignedHtml = slot.assigned.map(name => {
                            const student = students.find(s => s.name === name);
                            const color = student ? student.color : '#ccc';
                            const pinned = isPinned(dateStr, slot.activity.id, name);
                            const pinTitle = pinned ? 'Desafixar (voltar a ser realocável)' : 'Fixar aluno nesta atividade';
                            const studentSpan = `<span class="calendar-student-tag${pinned ? ' pinned' : ''}" draggable="true" data-name="${name}" data-date="${dateStr}" data-activity-id="${slot.activity.id}"><span class="color-dot" style="background-color: ${color}"></span>${name}<span class="pin-toggle" title="${pinTitle}">📌</span></span>`;
                            return studentSpan;
                        }).join('');

                        const names = slot.assigned.length > 0 ? slot.assigned.join(', ') : 'Vazio';
                        eventEl.title = `${slot.activity.name} [${slot.activity.type || 'PLANTÃO'}] (${slot.activity.startTime}-${slot.activity.endTime})\nAtribuído: ${names}`;
                        
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
                rosterDiv.innerHTML = '<h4>Alunos (Arraste para atribuir ou remover)</h4>';
                
                const rosterList = document.createElement('div');
                rosterList.className = 'roster-list';
                
                students.forEach(student => {
                    const studentTag = document.createElement('span');
                    studentTag.className = 'calendar-student-tag roster-item';
                    studentTag.draggable = true;
                    studentTag.innerHTML = `<span class="color-dot" style="background-color: ${student.color}"></span>${student.name}`;
                    
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

    function handleStudentReassignment(studentName, sourceDate, sourceActivityId, targetDate, targetActivityId) {
        if (!lastGeneratedSchedule) return;

        // If same slot, do nothing
        if (sourceDate === targetDate && sourceActivityId === targetActivityId) return;

        const { finalSchedule } = lastGeneratedSchedule;

        // 1. Find target slot
        const targetDay = finalSchedule.find(d => d.date === targetDate);
        if (!targetDay) return;
        const targetSlot = targetDay.slots.find(s => s.activity.id == targetActivityId);
        if (!targetSlot) return;

        // 2. Check if student already in target
        if (targetSlot.assigned.includes(studentName)) {
            alert(`${studentName} já está atribuído a este horário.`);
            return;
        }

        // 2.3 Check student unavailability (exceptions)
        const studentObj = students.find(s => s.name === studentName);
        if (studentObj && hasException(studentObj, targetDate, targetSlot.activity)) {
            if (!confirm(`${studentName} possui uma exceção (indisponibilidade) nesta data/horário. Deseja forçar esta atribuição?`)) {
                return;
            }
        }

        // Ignore assignments in the slot the student is being moved out of
        const isSourceSlot = (dateStr, slot) => dateStr === sourceDate && slot.activity.id == sourceActivityId;

        // 2.4 Check time overlap with the student's other activities on the target day
        const hasTimeOverlap = targetDay.slots.some(s =>
            s !== targetSlot &&
            !isSourceSlot(targetDate, s) &&
            s.assigned.includes(studentName) &&
            checkOverlap(s.activity.startTime, s.activity.endTime, targetSlot.activity.startTime, targetSlot.activity.endTime)
        );
        if (hasTimeOverlap) {
            if (!confirm(`${studentName} já possui outra atividade em horário sobreposto neste dia. Deseja forçar esta atribuição?`)) {
                return;
            }
        }

        // 2.5 Check rest rule (no plantão on the same day or adjacent days)
        if (isPlantao(targetSlot.activity.type)) {
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
                if (!confirm(`${studentName} já possui um PLANTÃO no mesmo dia, no dia anterior ou posterior. Deseja forçar esta atribuição?`)) {
                    return;
                }
            }
        }

        // 3. Perform removal from source (if not from roster)
        if (sourceDate !== 'roster') {
            const sourceDay = finalSchedule.find(d => d.date === sourceDate);
            if (sourceDay) {
                const sourceSlot = sourceDay.slots.find(s => s.activity.id == sourceActivityId);
                if (sourceSlot) {
                    sourceSlot.assigned = sourceSlot.assigned.filter(n => n !== studentName);
                    sourceSlot.capacityString = `${sourceSlot.assigned.length}/${sourceSlot.activity.studentsCount}`;
                }
            }
            removePin(sourceDate, sourceActivityId, studentName);
        }

        // 4. Perform addition to target (manual moves are pinned so re-generation preserves them)
        targetSlot.assigned.push(studentName);
        targetSlot.capacityString = `${targetSlot.assigned.length}/${targetSlot.activity.studentsCount}`;
        addPin(targetDate, targetActivityId, studentName);

        // 5. Update Math (Recalculate all student stats)
        recalculateAllStats();

        // 6. Re-render UI
        renderGeneratedResults(lastGeneratedSchedule);
        renderCalendarView(lastGeneratedSchedule.finalSchedule);
        renderStudentView(lastGeneratedSchedule.finalSchedule);
    }

    function handleStudentUnassignment(studentName, sourceDate, sourceActivityId) {
        if (!lastGeneratedSchedule) return;
        const { finalSchedule } = lastGeneratedSchedule;

        const sourceDay = finalSchedule.find(d => d.date === sourceDate);
        if (!sourceDay) return;
        const sourceSlot = sourceDay.slots.find(s => s.activity.id == sourceActivityId);
        if (!sourceSlot) return;

        if (confirm(`Deseja remover ${studentName} da atividade ${sourceSlot.activity.name}?`)) {
            sourceSlot.assigned = sourceSlot.assigned.filter(n => n !== studentName);
            sourceSlot.capacityString = `${sourceSlot.assigned.length}/${sourceSlot.activity.studentsCount}`;
            removePin(sourceDate, sourceActivityId, studentName);

            recalculateAllStats();
            renderGeneratedResults(lastGeneratedSchedule);
            renderCalendarView(lastGeneratedSchedule.finalSchedule);
            renderStudentView(lastGeneratedSchedule.finalSchedule);
        }
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
        healthWarningEl.innerHTML = `<strong>Avisos da Escala:</strong><ul>${items.join('')}</ul>`;
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
        clearPinsBtn.addEventListener('click', () => {
            if (pinnedAssignments.length === 0) return;
            if (!confirm(`Remover as ${pinnedAssignments.length} atribuições fixadas? Elas voltarão a ser realocáveis na próxima geração.`)) return;
            pinnedAssignments = [];
            savePins();
            if (lastGeneratedSchedule) renderCalendarView(lastGeneratedSchedule.finalSchedule);
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
                alert('Gere uma escala primeiro.');
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
            downloadFile(csv, 'text/csv;charset=utf-8', `escala_${toLocalDateStr(new Date())}.csv`);
        });
    }

    // --- Criar Planilha no Google Sheets ---
    // Sem API/OAuth: copia os dados como TSV (formato que o Sheets separa em
    // colunas ao colar) e abre uma planilha nova em branco para o usu\u00E1rio colar.
    //
    // O copy precisa ser S\u00CDNCRONO e acontecer ANTES do window.open: a Clipboard
    // API ass\u00EDncrona (navigator.clipboard.writeText) depende do documento estar
    // em foco, e abrir a nova aba tira o foco antes da promise resolver \u2014 o que
    // pode falhar silenciosamente enquanto o alerta ainda afirma "copiado".
    // document.execCommand('copy') \u00E9 s\u00EDncrono, ent\u00E3o termina antes de qualquer
    // navega\u00E7\u00E3o, o que o torna mais confi\u00E1vel aqui apesar de deprecated.
    function copyToClipboardSync(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(textarea);
        return ok;
    }

    if (exportSheetsBtn) {
        exportSheetsBtn.addEventListener('click', () => {
            if (!lastGeneratedSchedule || !lastGeneratedSchedule.finalSchedule) {
                alert('Gere uma escala primeiro.');
                return;
            }
            const escapeTsv = (v) => String(v ?? '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
            const rows = [['Data', 'Atividade', 'Alunos Alocados']];
            lastGeneratedSchedule.finalSchedule.forEach(day => {
                day.slots.forEach(slot => {
                    const title = `${slot.activity.startTime} ${slot.activity.name}`;
                    const names = (slot.assigned && slot.assigned.length > 0) ? slot.assigned.join(', ') : '(vago)';
                    rows.push([formatDateBR(day.date), title, names]);
                });
            });
            const tsv = rows.map(r => r.map(escapeTsv).join('\t')).join('\n');

            const copied = copyToClipboardSync(tsv);
            if (copied) {
                window.open('https://sheets.new', '_blank');
                alert('Dados copiados! Uma planilha nova do Google Sheets foi aberta em outra aba \u2014 clique na c\u00E9lula A1 e cole (Ctrl+V ou Cmd+V) para preencher a escala.');
            } else {
                // N\u00E3o foi poss\u00EDvel copiar automaticamente (ex: navegador bloqueou):
                // baixa um .tsv que pode ser importado (Arquivo > Importar) ou colado manualmente.
                downloadFile(tsv, 'text/tab-separated-values;charset=utf-8', `escala_google_sheets_${toLocalDateStr(new Date())}.tsv`);
                window.open('https://sheets.new', '_blank');
                alert('N\u00E3o foi poss\u00EDvel copiar automaticamente para a \u00E1rea de transfer\u00EAncia. Baixamos um arquivo .tsv \u2014 na planilha que abriu, use Arquivo > Importar > Fazer upload para carreg\u00E1-lo.');
            }
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
                alert('Gere uma escala primeiro.');
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

    function renderGeneratedResults(scheduleData) {
        if (!scheduleData) return;
        
        const {
            studentStats = [],
            mandatoryActivities = []
        } = scheduleData;

        // healthWarning (string) vem de backups antigos; feasibility/pinWarnings é o formato atual
        renderHealthIssues(scheduleData.feasibility, scheduleData.pinWarnings, scheduleData.healthWarning);

        resultsContainer.classList.remove('hidden');

        const showGroupHours = !!rotationConfig.twoGroupsEnabled;
        const [group1Label, group2Label] = showGroupHours ? [groupDisplayName('1'), groupDisplayName('2')] : ['', ''];

        // 1. Render Stats
        let statsHtml = `
            <h3>Equilíbrio de Carga Horária e Requisitos</h3>
            <table class="stats-table">
                <thead>
                    <tr>
                        <th>Nome do Aluno</th>
                        ${showGroupHours
                            ? `<th>Horas (${group1Label})</th><th>Horas (${group2Label})</th>`
                            : '<th>Horas</th>'}
                        <th>Plantão</th>
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

            const isComplete = (showGroupHours ? groupsComplete : diff <= 0) && stat.hasPlantao && coveredCount === totalMandatory;
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
                    <td style="text-align: center">${plantaoPill}</td>
                    <td title="${coverageTitle}" style="cursor: help">${coveragePill}</td>
                    <td>${overallPill}</td>
                </tr>
            `;
        });
        statsHtml += '</tbody></table>';
        statisticsOutput.innerHTML = statsHtml;
        
        // Scroll to results
        resultsContainer.scrollIntoView({ behavior: 'smooth' });
    }

    // Export Data
    const exportBtn = document.getElementById('export-btn');
    exportBtn.addEventListener('click', () => {
        // Deep clone lastGeneratedSchedule to avoid modifying the live state
        let exportedSchedule = null;
        if (lastGeneratedSchedule) {
            exportedSchedule = JSON.parse(JSON.stringify(lastGeneratedSchedule));
            // Convert coveredActivities Sets to Arrays for JSON serialization
            if (exportedSchedule.studentStats) {
                exportedSchedule.studentStats.forEach(stat => {
                    if (lastGeneratedSchedule.studentStats) {
                        const originalStat = lastGeneratedSchedule.studentStats.find(s => s.id === stat.id);
                        if (originalStat && originalStat.coveredActivities instanceof Set) {
                            stat.coveredActivities = Array.from(originalStat.coveredActivities);
                        }
                    }
                });
            }
        }

        const dataToExport = {
            version: 1,
            config: rotationConfig,
            activities: activities,
            students: students,
            pinnedAssignments: pinnedAssignments,
            lastGeneratedSchedule: exportedSchedule
        };

        const dateStr = toLocalDateStr(new Date());
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
        reader.onload = (event) => {
            try {
                const importedData = JSON.parse(event.target.result);

                // Structural validation with clear messages (bad backups used to corrupt state silently)
                const validation = validateBackupData(importedData);
                if (validation.errors.length > 0) {
                    const shown = validation.errors.slice(0, 15);
                    const extra = validation.errors.length > shown.length ? `\n... e mais ${validation.errors.length - shown.length} erro(s).` : '';
                    throw new Error('o arquivo contém problemas e não foi importado:\n\n- ' + shown.join('\n- ') + extra);
                }

                let confirmMsg = 'Importar este arquivo substituirá seus dados atuais. Continuar?';
                if (validation.warnings.length > 0) {
                    confirmMsg = 'Avisos encontrados no arquivo:\n\n- ' + validation.warnings.slice(0, 10).join('\n- ') + '\n\n' + confirmMsg;
                }

                if (confirm(confirmMsg)) {
                    // Update state
                    activities = importedData.activities;
                    // Ensure all activities have a type (for backward compatibility) and trim names
                    activities.forEach(a => {
                        if (!a.type) a.type = 'PLANTÃO';
                        if (a.name) a.name = a.name.trim();
                    });

                    // IMPORTANT: Update rotationConfig IMMEDIATELY so it's available for calculations
                    rotationConfig = importedData.config;
                    if (rotationConfig.twoGroupsEnabled) {
                        activities.forEach(a => {
                            if (a.activityGroup !== '1' && a.activityGroup !== '2') a.activityGroup = '1';
                        });
                    }
                    students = importedData.students || [];
                    lastGeneratedSchedule = (importedData.lastGeneratedSchedule && Array.isArray(importedData.lastGeneratedSchedule.finalSchedule))
                        ? importedData.lastGeneratedSchedule
                        : null;
                    pinnedAssignments = Array.isArray(importedData.pinnedAssignments) ? importedData.pinnedAssignments : [];
                    savePins();

                    // Ensure all students have a color and affinity group
                    students.forEach(s => {
                        if (!s.color) s.color = getRandomColor();
                        if (!s.affinityGroup) s.affinityGroup = 'A';
                    });

                    // Update localStorage
                    localStorage.setItem('med_rotations_activities', JSON.stringify(activities));
                    localStorage.setItem('med_rotations_config', JSON.stringify(rotationConfig));
                    localStorage.setItem('med_rotations_students', JSON.stringify(students));

                    // Update UI
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

                    if (lastGeneratedSchedule) {
                        // Trim names inside the schedule data for consistency
                        if (lastGeneratedSchedule.finalSchedule) {
                            lastGeneratedSchedule.finalSchedule.forEach(day => {
                                if (day.slots) {
                                    day.slots.forEach(slot => {
                                        if (slot.activity && slot.activity.name) {
                                            slot.activity.name = slot.activity.name.trim();
                                        }
                                    });
                                }
                            });
                        }

                        // Ensure mandatoryActivities is recalculated for consistency
                        lastGeneratedSchedule.mandatoryActivities = calculateMandatoryActivities(activities, rotationConfig);
                        
                        // Re-initialize studentStats from the imported students list to ensure they are fresh and clean
                        lastGeneratedSchedule.studentStats = students.map(s => ({
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
                        renderGeneratedResults(lastGeneratedSchedule);
                        renderCalendarView(lastGeneratedSchedule.finalSchedule);
                        renderStudentView(lastGeneratedSchedule.finalSchedule);
                    } else {
                        resultsContainer.classList.add('hidden');
                    }

                    alert('Dados importados com sucesso!');
                }
            } catch (error) {
                alert('Erro ao importar dados: ' + error.message);
            }
            importFile.value = '';
        };
        reader.readAsText(file);
    });

    // Delete All Data
    const deleteAllBtn = document.getElementById('delete-all-btn');
    deleteAllBtn.addEventListener('click', () => {
        if (confirm('Tem certeza de que deseja excluir TODOS os dados? Esta ação não pode ser desfeita.')) {
            // Clear localStorage
            localStorage.removeItem('med_rotations_activities');
            localStorage.removeItem('med_rotations_config');
            localStorage.removeItem('med_rotations_students');
            localStorage.removeItem('med_rotations_pins');

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
            
            alert('Todos os dados foram excluídos com sucesso.');
        }
    });
});