document.addEventListener('DOMContentLoaded', () => {
    const activityForm = document.getElementById('activity-form');
    const activitiesContainer = document.getElementById('activities-container');
    const studentForm = document.getElementById('student-form');
    const studentsContainer = document.getElementById('students-container');
    const saveGlobalBtn = document.getElementById('save-global-dates');
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
    let rotationConfig = {
        startDate: '',
        endDate: '',
        requiredHours: 0
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

    // Load data from localStorage
    const savedActivities = localStorage.getItem('med_rotations_activities');
    if (savedActivities) {
        activities = JSON.parse(savedActivities);
        // Ensure all activities have a type (for backward compatibility)
        activities.forEach(a => {
            if (!a.type) a.type = 'PLANTÃO';
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
    }

    renderActivities();
    renderStudents();

    // Global dates handler
    saveGlobalBtn.addEventListener('click', () => {
        rotationConfig.startDate = document.getElementById('rotation-start').value;
        rotationConfig.endDate = document.getElementById('rotation-end').value;
        rotationConfig.requiredHours = parseFloat(document.getElementById('required-hours').value) || 0;
        localStorage.setItem('med_rotations_config', JSON.stringify(rotationConfig));
        alert('Configurações da escala salvas!');
    });

    // Add exception handler
    addExceptionBtn.addEventListener('click', () => {
        const dateInput = document.getElementById('exception-date');
        const dateValue = dateInput.value;
        
        if (dateValue && !currentExceptions.includes(dateValue)) {
            currentExceptions.push(dateValue);
            renderExceptionChips();
            dateInput.value = '';
        }
    });

    function renderExceptionChips() {
        currentExceptionsList.innerHTML = '';
        currentExceptions.forEach((date, index) => {
            const tag = document.createElement('span');
            tag.className = 'tag exception';
            tag.innerHTML = `
                ${date} 
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
        const newActivity = {
            id: Date.now(),
            day: document.getElementById('day').value,
            startTime: document.getElementById('start-hour').value,
            endTime: document.getElementById('end-hour').value,
            name: document.getElementById('activity-name').value,
            type: document.getElementById('activity-type').value,
            location: document.getElementById('location').value,
            studentsCount: parseInt(document.getElementById('students-number').value),
            minStudents: parseInt(document.getElementById('min-students-number').value) || 1,
            hoursCount: parseFloat(document.getElementById('hours-count').value),
            exceptions: [...currentExceptions]
        };

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
                    <button class="edit-student-btn edit-btn" data-id="${student.id}">Editar</button>
                    <button class="delete-student-btn delete-btn" data-id="${student.id}">Excluir</button>
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

                <button type="submit">Salvar Alterações</button>
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
                        ${activity.exceptions.map(ex => `<span class="exception-tag">${ex}</span>`).join('')}
                    </div>
                `;
            }

            const dayTranslations = {
                'Monday': 'Segunda-feira', 'Tuesday': 'Terça-feira', 'Wednesday': 'Quarta-feira',
                'Thursday': 'Quinta-feira', 'Friday': 'Sexta-feira', 'Saturday': 'Sábado', 'Sunday': 'Domingo'
            };

            card.innerHTML = `
                <div class="activity-info">
                    <h3>${activity.name} <span class="type-badge">${activity.type || 'PLANTÃO'}</span></h3>
                    <div class="activity-details">
                        <span><strong>Dia:</strong> ${dayTranslations[activity.day]}</span>
                        <span><strong>Horário:</strong> ${activity.startTime} - ${activity.endTime}</span>
                        <span><strong>Local:</strong> ${activity.location}</span>
                        <span><strong>Alunos:</strong> ${activity.minStudents || 1}-${activity.studentsCount}</span>
                        <span><strong>Horas:</strong> ${activity.hoursCount}</span>
                    </div>
                    ${exceptionsHtml}
                </div>
                <div class="card-actions">
                    <button class="edit-activity-btn edit-btn" data-id="${activity.id}">Editar</button>
                    <button class="delete-btn" data-id="${activity.id}">Excluir</button>
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
                <div class="form-group">
                    <label>Local</label>
                    <input type="text" id="edit-location" value="${activity.location}" required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Alunos (Mín)</label>
                        <input type="number" id="edit-min-students" value="${activity.minStudents || 1}" required>
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
                        <button type="button" id="modal-act-add-exc" class="secondary-btn">Adicionar Exceção</button>
                    </div>
                    <div id="modal-act-exc-list" class="tag-container"></div>
                </div>

                <button type="submit">Salvar Alterações</button>
            </form>
        `;

        const renderModalChips = () => {
            const list = document.getElementById('modal-act-exc-list');
            list.innerHTML = '';
            modalExceptions.forEach((date, idx) => {
                const tag = document.createElement('span');
                tag.className = 'tag exception';
                tag.innerHTML = `${date} <span class="remove-modal-tag" data-idx="${idx}">&times;</span>`;
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
            const date = document.getElementById('modal-act-exc-date').value;
            if (date && !modalExceptions.includes(date)) {
                modalExceptions.push(date);
                renderModalChips();
                document.getElementById('modal-act-exc-date').value = '';
            }
        };

        editModal.classList.remove('hidden');

        document.getElementById('edit-activity-form').onsubmit = (e) => {
            e.preventDefault();
            activity.name = document.getElementById('edit-activity-name').value;
            activity.type = document.getElementById('edit-activity-type').value;
            activity.location = document.getElementById('edit-location').value;
            activity.minStudents = parseInt(document.getElementById('edit-min-students').value) || 1;
            activity.studentsCount = parseInt(document.getElementById('edit-students-number').value);
            activity.hoursCount = parseFloat(document.getElementById('edit-hours-count').value);
            activity.exceptions = modalExceptions;
            
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
    const scheduleOutput = document.getElementById('schedule-output');
    const calendarOutput = document.getElementById('calendar-output');
    const statisticsOutput = document.getElementById('statistics-output');
    const printBtn = document.getElementById('print-btn');
    const listViewBtn = document.getElementById('list-view-btn');
    const calendarViewBtn = document.getElementById('calendar-view-btn');

    let lastGeneratedSchedule = null;

    if (listViewBtn && calendarViewBtn) {
        listViewBtn.addEventListener('click', () => {
            listViewBtn.classList.add('active');
            calendarViewBtn.classList.remove('active');
            scheduleOutput.classList.remove('hidden');
            calendarOutput.classList.add('hidden');
        });

        calendarViewBtn.addEventListener('click', () => {
            calendarViewBtn.classList.add('active');
            listViewBtn.classList.remove('active');
            calendarOutput.classList.remove('hidden');
            scheduleOutput.classList.add('hidden');
            if (lastGeneratedSchedule) {
                renderCalendarView(lastGeneratedSchedule.finalSchedule);
            }
        });
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
        generateBtn.addEventListener('click', () => {
            if (!rotationConfig.startDate || !rotationConfig.endDate) {
                alert('Por favor, defina as datas de início e término primeiro.');
                return;
            }
            if (activities.length === 0 || students.length === 0) {
                alert('Por favor, adicione atividades e alunos primeiro.');
                return;
            }

            const scheduleData = generateSchedule();
            lastGeneratedSchedule = scheduleData;
            renderGeneratedResults(scheduleData);
            if (calendarViewBtn.classList.contains('active')) {
                renderCalendarView(scheduleData.finalSchedule);
            }
        });
    }

    function renderCalendarView(finalSchedule) {
        if (!rotationConfig.startDate || !rotationConfig.endDate) return;
        
        calendarOutput.innerHTML = '';
        
        const start = new Date(rotationConfig.startDate + 'T00:00:00');
        const end = new Date(rotationConfig.endDate + 'T00:00:00');
        const todayStr = new Date().toISOString().split('T')[0];

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

            // Start Padding
            const startPadding = currentMonth.getDay();
            for (let i = 0; i < startPadding; i++) {
                const pad = document.createElement('div');
                pad.className = 'calendar-day other-month';
                grid.appendChild(pad);
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
                if (dayData) {
                    const eventsCont = document.createElement('div');
                    eventsCont.className = 'calendar-events';
                    dayData.slots.forEach(slot => {
                        const eventEl = document.createElement('div');
                        eventEl.className = 'calendar-event';
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
                            const studentSpan = `<span class="calendar-student-tag" draggable="true" data-name="${name}" data-date="${dateStr}" data-activity-id="${slot.activity.id}"><span class="color-dot" style="background-color: ${color}"></span>${name}</span>`;
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
                        });

                        eventsCont.appendChild(eventEl);
                    });
                    dayDiv.appendChild(eventsCont);
                }

                grid.appendChild(dayDiv);
            }

            // End Padding to fill the week
            const totalCells = startPadding + lastDay;
            const endPadding = (7 - (totalCells % 7)) % 7;
            for (let i = 0; i < endPadding; i++) {
                const pad = document.createElement('div');
                pad.className = 'calendar-day other-month';
                grid.appendChild(pad);
            }

            monthDiv.appendChild(grid);
            calendarOutput.appendChild(monthDiv);

            // Move to next month
            currentMonth.setMonth(currentMonth.getMonth() + 1);
        }
    }

    function handleStudentReassignment(studentName, sourceDate, sourceActivityId, targetDate, targetActivityId) {
        if (!lastGeneratedSchedule) return;

        // If same slot, do nothing
        if (sourceDate === targetDate && sourceActivityId === targetActivityId) return;

        const { finalSchedule } = lastGeneratedSchedule;

        // 1. Find source and target slots
        const sourceDay = finalSchedule.find(d => d.date === sourceDate);
        const targetDay = finalSchedule.find(d => d.date === targetDate);
        
        if (!sourceDay || !targetDay) return;

        const sourceSlot = sourceDay.slots.find(s => s.activity.id == sourceActivityId);
        const targetSlot = targetDay.slots.find(s => s.activity.id == targetActivityId);

        if (!sourceSlot || !targetSlot) return;

        // 2. Check if student already in target
        if (targetSlot.assigned.includes(studentName)) {
            alert(`${studentName} já está atribuído a este horário.`);
            return;
        }

        // 3. Perform move
        sourceSlot.assigned = sourceSlot.assigned.filter(n => n !== studentName);
        sourceSlot.capacityString = `${sourceSlot.assigned.length}/${sourceSlot.activity.studentsCount}`;
        
        targetSlot.assigned.push(studentName);
        targetSlot.capacityString = `${targetSlot.assigned.length}/${targetSlot.activity.studentsCount}`;

        // 4. Update Math (Recalculate all student stats)
        recalculateAllStats();

        // 5. Re-render UI
        renderGeneratedResults(lastGeneratedSchedule);
        if (calendarViewBtn.classList.contains('active')) {
            renderCalendarView(lastGeneratedSchedule.finalSchedule);
        }
    }

    function recalculateAllStats() {
        if (!lastGeneratedSchedule) return;

        const { finalSchedule, studentStats } = lastGeneratedSchedule;

        // Reset all totals
        studentStats.forEach(stat => {
            stat.totalHours = 0;
            stat.coveredActivities = new Set();
            stat.hasPlantao = false;
        });

        // Sum up from schedule
        finalSchedule.forEach(day => {
            day.slots.forEach(slot => {
                slot.assigned.forEach(name => {
                    const stat = studentStats.find(s => s.name === name);
                    if (stat) {
                        stat.totalHours += slot.activity.hoursCount;
                        stat.coveredActivities.add(normalizeActivityName(slot.activity.name));
                        if (isPlantao(slot.activity.type)) {
                            stat.hasPlantao = true;
                        }
                    }
                });
            });
        });
    }

    function isPlantao(type) {
        if (!type) return true; // Default to true for missing types (backward compatibility)
        return type.toUpperCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .trim() === 'PLANTAO';
    }

    function normalizeActivityName(name) {
        return name.toUpperCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "") // Remove accents
            .replace(/[^A-Z0-9 ]/g, "")      // Remove special chars
            .trim();
    }

    function generateSchedule() {
        const startDate = new Date(rotationConfig.startDate + 'T00:00:00');
        const endDate = new Date(rotationConfig.endDate + 'T00:00:00');
        const dateArray = [];
        
        let currentDate = new Date(startDate);
        while (currentDate <= endDate) {
            dateArray.push(new Date(currentDate));
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // --- Global Health Check ---
        let totalMinimumActivityHours = 0;
        const allPotentialSlots = [];
        const uniqueActivityNames = new Set();

        dateArray.forEach(date => {
            const dateStr = date.toISOString().split('T')[0];
            const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
            activities.forEach(a => {
                if (a.day === dayName && (!a.exceptions || !a.exceptions.includes(dateStr))) {
                    totalMinimumActivityHours += a.hoursCount * (a.minStudents || 1);
                    allPotentialSlots.push({
                        dateStr,
                        dayName,
                        activity: { ...a, normalizedName: normalizeActivityName(a.name) }
                    });
                    uniqueActivityNames.add(normalizeActivityName(a.name));
                }
            });
        });

        const mandatoryActivities = Array.from(uniqueActivityNames);
        const avgHoursRequired = totalMinimumActivityHours / students.length;
        let healthWarning = null;
        if (avgHoursRequired > rotationConfig.requiredHours) {
            healthWarning = `<strong>Aviso de Saúde da Escala:</strong> Sua meta é ${rotationConfig.requiredHours}h por aluno. 
                Para garantir que nenhuma atividade fique vazia, os alunos devem ter uma média de pelo menos <strong>${avgHoursRequired.toFixed(1)}h</strong>.`;
        }

        // --- Multi-Pass Logic ---
        let bestResult = null;
        let bestScore = Infinity;

        const ATTEMPTS = 100;
        for (let i = 0; i < ATTEMPTS; i++) {
            const currentAttempt = runSingleAttempt(allPotentialSlots, mandatoryActivities);
            const currentScore = calculateScore(currentAttempt, mandatoryActivities);

            if (currentScore < bestScore) {
                bestScore = currentScore;
                bestResult = currentAttempt;
                if (bestScore === 0) break;
            }
        }

        return { ...bestResult, healthWarning, mandatoryActivities };
    }

    function runSingleAttempt(allPotentialSlots, mandatoryActivities) {
        const studentStats = students.map(s => ({
            id: s.id,
            name: s.name,
            affinityGroup: s.affinityGroup,
            totalHours: 0,
            requiredHours: rotationConfig.requiredHours,
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
            slot._scarcity = students.filter(student => isStudentEligible(student, slot.dateStr, slot.activity, [])).length;
        });

        // 2. Global Phase 1: Minimum Staffing (Guarantee MINIMUM people per activity)
        // Sort by scarcity (hardest first) + random for Monte Carlo
        const phase1Order = [...allSlots].sort((a, b) => (a._scarcity - b._scarcity) || (Math.random() - 0.5));
        const dailyAssignments = {}; // { dateStr: [ {studentId, start, end} ] }

        phase1Order.forEach(slot => {
            const dateStr = slot.dateStr;
            if (!dailyAssignments[dateStr]) dailyAssignments[dateStr] = [];

            const targetMin = slot.activity.minStudents || 1;

            while (slot.assignedIds.length < targetMin) {
                const eligible = students.filter(s => 
                    !slot.assignedIds.includes(s.id) && 
                    isStudentEligible(s, dateStr, slot.activity, dailyAssignments[dateStr])
                );
                
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

                        // Priority 3: Affinity Group (SOFT CONSTRAINT)
                        if (slot.assignedIds.length > 0) {
                            const groupInSlot = studentStats.filter(st => slot.assignedIds.includes(st.id)).map(st => st.affinityGroup);
                            const sharesA = statsA.affinityGroup && groupInSlot.includes(statsA.affinityGroup);
                            const sharesB = statsB.affinityGroup && groupInSlot.includes(statsB.affinityGroup);
                            if (sharesA !== sharesB) return sharesA ? -1 : 1;
                        }

                        // Priority 4: Hours Balance
                        return statsA.totalHours - statsB.totalHours || (Math.random() - 0.5);
                    });

                    const chosen = eligible[0];
                    const stats = studentStats.find(st => st.id === chosen.id);
                    
                    slot.assignedIds.push(chosen.id);
                    stats.totalHours += slot.activity.hoursCount;
                    stats.coveredActivities.add(slot.activity.normalizedName);
                    if (isPlantao(slot.activity.type)) stats.hasPlantao = true;

                    dailyAssignments[dateStr].push({ studentId: chosen.id, startTime: slot.activity.startTime, endTime: slot.activity.endTime });
                } else {
                    // Diagnostic tracking for failures
                    let rejectedException = 0;
                    let rejectedOverlap = 0;
                    students.forEach(s => {
                        if (hasException(s, dateStr, slot.activity)) rejectedException++;
                        else if (hasOverlap(s, dateStr, slot.activity, dailyAssignments[dateStr])) rejectedOverlap++;
                    });
                    
                    if (slot.assignedIds.length === 0) {
                        slot.diagnostics = `Não foi possível preencher. ${rejectedException} exceções, ${rejectedOverlap} sobreposições.`;
                    } else {
                        slot.diagnostics = `Mínimo de ${targetMin} não atingido (atribuídos: ${slot.assignedIds.length}).`;
                    }
                    break; 
                }
            }
        });

        // 3. Global Phase 2: Sparse Goal Fulfillment (Fill remaining seats only if students need hours)
        const phase2Order = [...allSlots].sort(() => Math.random() - 0.5);
        phase2Order.forEach(slot => {
            const dateStr = slot.dateStr;
            
            while (slot.assignedIds.length < slot.activity.studentsCount) {
                const eligible = students.filter(s => 
                    !slot.assignedIds.includes(s.id) && 
                    isStudentEligible(s, dateStr, slot.activity, dailyAssignments[dateStr])
                );

                // Only take students who still need hours OR still need this activity/plantao for coverage
                const needingHoursOrCoverage = eligible.filter(s => {
                    const stats = studentStats.find(st => st.id === s.id);
                    const needsAct = !stats.coveredActivities.has(slot.activity.normalizedName);
                    const needsPlantao = isPlantao(slot.activity.type) && !stats.hasPlantao;
                    return stats.totalHours < stats.requiredHours || needsAct || needsPlantao;
                });

                if (needingHoursOrCoverage.length === 0) break;

                // Prioritize Coverage then Affinity then Preferences
                needingHoursOrCoverage.sort((a, b) => {
                    const statsA = studentStats.find(st => st.id === a.id);
                    const statsB = studentStats.find(st => st.id === b.id);
                    
                    const needsActA = !statsA.coveredActivities.has(slot.activity.normalizedName);
                    const needsActB = !statsB.coveredActivities.has(slot.activity.normalizedName);
                    const needsPlantaoA = isPlantao(slot.activity.type) && !statsA.hasPlantao;
                    const needsPlantaoB = isPlantao(slot.activity.type) && !statsB.hasPlantao;

                    if (needsActA !== needsActB) return needsActA ? -1 : 1;
                    if (needsPlantaoA !== needsPlantaoB) return needsPlantaoA ? -1 : 1;

                    // Affinity Group (SOFT CONSTRAINT)
                    if (slot.assignedIds.length > 0) {
                        const groupInSlot = studentStats.filter(st => slot.assignedIds.includes(st.id)).map(st => st.affinityGroup);
                        const sharesA = statsA.affinityGroup && groupInSlot.includes(statsA.affinityGroup);
                        const sharesB = statsB.affinityGroup && groupInSlot.includes(statsB.affinityGroup);
                        if (sharesA !== sharesB) return sharesA ? -1 : 1;
                    }

                    const prefA = hasPreference(a, dateStr, slot.activity);
                    const prefB = hasPreference(b, dateStr, slot.activity);
                    if (prefA !== prefB) return prefA ? -1 : 1;

                    return statsA.totalHours - statsB.totalHours || (Math.random() - 0.5);
                });

                const chosen = needingHoursOrCoverage[0];
                const stats = studentStats.find(st => st.id === chosen.id);
                slot.assignedIds.push(chosen.id);
                stats.totalHours += slot.activity.hoursCount;
                stats.coveredActivities.add(slot.activity.normalizedName);
                if (isPlantao(slot.activity.type)) stats.hasPlantao = true;

                dailyAssignments[dateStr].push({ studentId: chosen.id, startTime: slot.activity.startTime, endTime: slot.activity.endTime });
            }
        });

        // 4. Format for UI
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

    // --- Helper Logic for Refactored Algorithm ---

    function isStudentEligible(student, dateStr, activity, dailyAssignments) {
        if (hasException(student, dateStr, activity)) return false;
        if (hasOverlap(student, dateStr, activity, dailyAssignments)) return false;
        return true;
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

    function hasPreference(student, dateStr, activity) {
        if (!student.preferredDates) return false;
        return student.preferredDates.some(pref => {
            if (typeof pref === 'string') return pref === dateStr;
            if (pref.date !== dateStr) return false;
            if (!pref.startTime || !pref.endTime) return true;
            return checkOverlap(pref.startTime, pref.endTime, activity.startTime, activity.endTime);
        });
    }

    function calculateScore({ finalSchedule, studentStats }, mandatoryActivities) {
        let emptyCount = 0;
        let understaffedPenalty = 0;
        let coveragePenalty = 0;
        let affinityBonus = 0;

        finalSchedule.forEach(day => {
            day.slots.forEach(slot => {
                const assigned = slot.assigned.length;
                const min = slot.activity.minStudents || 1;
                
                if (assigned === 0) {
                    emptyCount++;
                } else if (assigned < min) {
                    understaffedPenalty += (min - assigned);
                }

                // Affinity Reward: Check pairs within the slot
                if (assigned > 1) {
                    const studentObjs = slot.assigned.map(name => students.find(s => s.name === name));
                    for (let i = 0; i < studentObjs.length; i++) {
                        for (let j = i + 1; j < studentObjs.length; j++) {
                            const s1 = studentObjs[i];
                            const s2 = studentObjs[j];
                            if (s1 && s2 && s1.affinityGroup && s1.affinityGroup === s2.affinityGroup) {
                                affinityBonus += 50; // Bonus for each pairing
                            }
                        }
                    }
                }
            });
        });

        // Calculate student-specific coverage penalties
        studentStats.forEach(stat => {
            // Penalty for missing mandatory activities
            const missingCount = mandatoryActivities.length - stat.coveredActivities.size;
            coveragePenalty += (missingCount * 10);

            // Penalty for missing Plantao
            if (!stat.hasPlantao) coveragePenalty += 100;
        });

        // Calculate variance in student hours (lower is more balanced)
        const hours = studentStats.map(s => s.totalHours);
        const avg = hours.reduce((a, b) => a + b, 0) / hours.length;
        const variance = hours.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / hours.length;

        // Score: Higher weights for critical requirements, subtract bonus
        return (emptyCount * 1000000) + 
               (understaffedPenalty * 100000) + 
               (coveragePenalty * 1000) + 
               variance - affinityBonus;
    }

    function checkOverlap(start1, end1, start2, end2) {
        return (start1 < end2 && start2 < end1);
    }

    function renderGeneratedResults({ finalSchedule, studentStats, healthWarning, mandatoryActivities }) {
        const healthWarningEl = document.getElementById('health-warning');
        if (healthWarning) {
            healthWarningEl.innerHTML = healthWarning;
            healthWarningEl.classList.remove('hidden');
        } else {
            healthWarningEl.classList.add('hidden');
        }

        resultsContainer.classList.remove('hidden');
        
        // 1. Render Stats
        let statsHtml = `
            <h3>Equilíbrio de Carga Horária e Requisitos</h3>
            <table class="stats-table">
                <thead>
                    <tr>
                        <th>Nome do Aluno</th>
                        <th>Horas</th>
                        <th>Plantão</th>
                        <th>Atividades Cobertas</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
        `;

        studentStats.forEach(stat => {
            const diff = stat.requiredHours - stat.totalHours;
            const hourStatus = diff <= 0 ? '✅' : '⌛';
            const plantaoStatus = stat.hasPlantao ? '✅' : '❌';
            
            const coveredCount = stat.coveredActivities.size;
            const totalMandatory = mandatoryActivities.length;
            const coverageStatus = coveredCount === totalMandatory ? '✅' : `⚠️ ${coveredCount}/${totalMandatory}`;

            // Create a tooltip for missing activities
            const missing = mandatoryActivities.filter(m => !stat.coveredActivities.has(m));
            const coverageTitle = missing.length > 0 ? `Faltando: ${missing.join(', ')}` : 'Todas cobertas';

            statsHtml += `
                <tr>
                    <td>${stat.name}</td>
                    <td>${hourStatus} ${stat.totalHours.toFixed(1)}h / ${stat.requiredHours}h</td>
                    <td style="text-align: center">${plantaoStatus}</td>
                    <td title="${coverageTitle}" style="cursor: help">${coverageStatus}</td>
                    <td>${diff <= 0 && stat.hasPlantao && coveredCount === totalMandatory ? '✅ Completo' : '⌛ Pendente'}</td>
                </tr>
            `;
        });
        statsHtml += '</tbody></table>';
        statisticsOutput.innerHTML = statsHtml;

        // 2. Render Schedule
        let scheduleHtml = '';
        const dayTranslations = {
            'Monday': 'Segunda-feira', 'Tuesday': 'Terça-feira', 'Wednesday': 'Quarta-feira',
            'Thursday': 'Quinta-feira', 'Friday': 'Sexta-feira', 'Saturday': 'Sábado', 'Sunday': 'Domingo'
        };

        finalSchedule.forEach(day => {
            scheduleHtml += `
                <div class="schedule-day-group">
                    <div class="schedule-date-header">
                        ${day.date} - ${dayTranslations[day.dayName] || day.dayName}
                    </div>
            `;

            day.slots.forEach(slot => {
                const isEmpty = slot.assigned.length === 0;
                const diagHtml = slot.diagnostics ? `<span class="diagnostic-text">⚠️ ${slot.diagnostics}</span>` : '';
                
                scheduleHtml += `
                    <div class="schedule-item ${isEmpty ? 'empty' : ''}">
                        <h4>${slot.activity.name} <span class="type-badge">${slot.activity.type || 'PLANTÃO'}</span></h4>
                        <div class="schedule-item-details">
                            <span>🕒 ${slot.activity.startTime} - ${slot.activity.endTime}</span> | 
                            <span>📍 ${slot.activity.location}</span>
                        </div>
                        <div class="assigned-students">
                            Atribuídos: ${slot.assigned.length > 0 ? slot.assigned.join(', ') : 'Nenhum'} 
                            (Mín: ${slot.activity.minStudents || 1} | ${slot.capacityString})
                        </div>
                        ${diagHtml}
                    </div>
                `;
            });

            scheduleHtml += '</div>';
        });

        scheduleOutput.innerHTML = scheduleHtml;
        
        // Scroll to results
        resultsContainer.scrollIntoView({ behavior: 'smooth' });
    }

    // Export Data
    const exportBtn = document.getElementById('export-btn');
    exportBtn.addEventListener('click', () => {
        const dataToExport = {
            version: 1,
            config: rotationConfig,
            activities: activities,
            students: students,
            lastGeneratedSchedule: lastGeneratedSchedule
        };
        
        const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        
        const dateStr = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `backup_escalas_med_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // CSV Export
    const csvExportBtn = document.getElementById('csv-export-btn');
    csvExportBtn.addEventListener('click', () => {
        if (!lastGeneratedSchedule) return;

        let csvContent = "Data,Dia,Atividade,Tipo,Horário,Local,Alunos Atribuídos\n";
        
        const dayTranslations = {
            'Monday': 'Segunda-feira', 'Tuesday': 'Terça-feira', 'Wednesday': 'Quarta-feira',
            'Thursday': 'Quinta-feira', 'Friday': 'Sexta-feira', 'Saturday': 'Sábado', 'Sunday': 'Domingo'
        };

        lastGeneratedSchedule.finalSchedule.forEach(day => {
            day.slots.forEach(slot => {
                const assigned = slot.assigned.join('; ');
                const row = [
                    day.date,
                    dayTranslations[day.dayName] || day.dayName,
                    `"${slot.activity.name}"`,
                    `"${slot.activity.type || 'PLANTÃO'}"`,
                    `"${slot.activity.startTime} - ${slot.activity.endTime}"`,
                    `"${slot.activity.location}"`,
                    `"${assigned}"`
                ].join(',');
                csvContent += row + "\n";
            });
        });

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `escala_plantao_med_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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
                
                // Simple validation
                if (!importedData.activities || !importedData.config) {
                    throw new Error('Formato de arquivo inválido. Atividades ou configuração ausentes.');
                }

                if (confirm('Importar este arquivo substituirá seus dados atuais. Continuar?')) {
                    // Update state
                    activities = importedData.activities;
                    // Ensure all activities have a type (for backward compatibility)
                    activities.forEach(a => {
                        if (!a.type) a.type = 'PLANTÃO';
                    });
                    rotationConfig = importedData.config;
                    students = importedData.students || [];
                    lastGeneratedSchedule = importedData.lastGeneratedSchedule || null;

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
                    renderActivities();
                    renderStudents();

                    if (lastGeneratedSchedule) {
                        recalculateAllStats();
                        renderGeneratedResults(lastGeneratedSchedule);
                        if (calendarViewBtn.classList.contains('active')) {
                            renderCalendarView(lastGeneratedSchedule.finalSchedule);
                        }
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

    function saveActivities() {
        localStorage.setItem('med_rotations_activities', JSON.stringify(activities));
    }

    function saveStudents() {
        localStorage.setItem('med_rotations_students', JSON.stringify(students));
    }
});