/**
 * System Architecture (Production Single-File approach):
 * 1. DB: Handles localStorage CRUD operations.
 * 2. AudioSys: Web Audio API synthesizer for self-contained sounds (No missing MP3 links).
 * 3. Session: Handles the active quiz logic (randomization, fairness, points, timer).
 * 4. UI: Handles DOM manipulation, view switching, and rendering.
 * 5. App: Main controller bridging events and initialization.
 */

// Utility: Generate Unique IDs
const generateId = () => Math.random().toString(36).substr(2, 9);
const DB = {
  getKeys() {
    return {
      students: 'mizan_students',
      questions: 'mizan_questions',
      session: 'mizan_session_state',
      scores: 'mizan_scores',
      settings: 'mizan_settings'
    };
  },

  // Generic Save/Load
  save(key, data) { localStorage.setItem(key, JSON.stringify(data)); },
  load(key, defaultVal = []) {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : defaultVal;
  },

  // Students
  getStudents() { return this.load(this.getKeys().students); },
  saveStudents(data) { this.save(this.getKeys().students, data); },
  addStudent(student) {
    const students = this.getStudents();
    student.id = generateId();
    students.push(student);
    this.saveStudents(students);
    return student;
  },
  deleteStudent(id) {
    const students = this.getStudents().filter(s => s.id !== id);
    this.saveStudents(students);
  },
  clearStudents() { this.saveStudents([]); },
  getCircles() {
    const students = this.getStudents();
    const circles = new Set(students.map(s => s.circle).filter(c => c));
    return Array.from(circles).sort();
  },

  // Questions
  getQuestions() { return this.load(this.getKeys().questions); },
  saveQuestions(data) { this.save(this.getKeys().questions, data); },
  addQuestion(q) {
    const qs = this.getQuestions();
    q.id = generateId();
    qs.push(q);
    this.saveQuestions(qs);
    return q;
  },
  deleteQuestion(id) {
    const qs = this.getQuestions().filter(q => q.id !== id);
    this.saveQuestions(qs);
  },
  clearQuestions() { this.saveQuestions([]); },

  // Session & Scores
  getSession() {
    return this.load(this.getKeys().session, {
      activeCircle: 'all',
      timerSetting: 60,
      usedStudents: [], // IDs
      usedQuestions: [], // IDs
      stats: { called: 0, correct: 0, wrong: 0, skips: 0 }
    });
  },
  saveSession(state) { this.save(this.getKeys().session, state); },

  getScores() { return this.load(this.getKeys().scores, {}); },
  saveScores(scores) { this.save(this.getKeys().scores, scores); },
  addScore(studentId, points) {
    const scores = this.getScores();
    scores[studentId] = (scores[studentId] || 0) + points;
    this.saveScores(scores);
  },

  // Settings
  getSettings() { return this.load(this.getKeys().settings, { soundEnabled: true }); },
  saveSettings(settings) { this.save(this.getKeys().settings, settings); }
};

// ================= 2. AUDIO SYNTHESIZER =================
// Using Web Audio API to ensure sounds always work offline/without external assets
const AudioSys = {
  ctx: null,
  init() {
    if (!this.ctx) {
      window.AudioContext = window.AudioContext || window.webkitAudioContext;
      if (window.AudioContext) this.ctx = new AudioContext();
    }
  },
  playTone(freq, type, duration, vol = 0.1) {
    if (!DB.getSettings().soundEnabled) return;
    try {
      this.init();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.00001, this.ctx.currentTime + duration);

      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) { console.warn("Audio error", e); }
  },
  playSelect() { this.playTone(600, 'sine', 0.1, 0.1); setTimeout(() => this.playTone(800, 'sine', 0.2, 0.1), 100); },
  playReveal() { this.playTone(400, 'triangle', 0.3, 0.1); setTimeout(() => this.playTone(600, 'triangle', 0.5, 0.1), 150); },
  playCorrect() { this.playTone(523.25, 'sine', 0.1); setTimeout(() => this.playTone(659.25, 'sine', 0.1), 100); setTimeout(() => this.playTone(783.99, 'sine', 0.4), 200); },
  playWrong() { this.playTone(300, 'sawtooth', 0.3, 0.1); setTimeout(() => this.playTone(250, 'sawtooth', 0.5, 0.1), 200); },
  playTimeUp() { this.playTone(800, 'square', 0.5, 0.05); setTimeout(() => this.playTone(800, 'square', 0.5, 0.05), 600); }
};

// ================= 3. ACTIVE SESSION LOGIC =================
const Session = {
  state: null,
  activeStudent: null,
  activeQuestion: null,
  timerInterval: null,
  timeLeft: 0,
  isPresentation: false,

  init() {
    this.state = DB.getSession();
  },

  startNew() {
    const circle = document.getElementById('circle-filter').value;
    const timer = parseInt(document.getElementById('timer-setting').value);

    // Validate if we have data
    let students = DB.getStudents();
    if (circle !== 'all') students = students.filter(s => s.circle === circle);
    const questions = DB.getQuestions();

    if (students.length === 0) return UI.toast('لا يوجد طلاب في هذه الحلقة!', 'error');
    if (questions.length === 0) return UI.toast('لا يوجد أسئلة مسجلة!', 'error');

    this.state = {
      activeCircle: circle,
      timerSetting: timer,
      usedStudents: [],
      usedQuestions: [],
      stats: { called: 0, correct: 0, wrong: 0, skips: 0 }
    };
    DB.saveSession(this.state);
    DB.saveScores({}); // Reset scores on new session

    App.navigate('session');
    this.resetStage();
    UI.updateSessionStats();
    UI.updateLeaderboard();
    UI.toast('تم بدء جلسة جديدة بنجاح', 'success');
  },

  resetStage() {
    document.getElementById('stage-init').classList.remove('hidden');
    document.getElementById('stage-active').classList.add('hidden');
    document.getElementById('btn-next-turn').classList.remove('hidden');
    document.getElementById('timer-container').classList.add('hidden');
    this.stopTimer();
    this.activeStudent = null;
    this.activeQuestion = null;

    if (this.isPresentation) {
      document.getElementById('btn-next-pres').classList.remove('hidden');
      document.getElementById('btn-reveal-pres').classList.add('hidden');
    }
  },
  nextTurn() {
    AudioSys.playSelect();

    // 1. Get pool of students and questions
    let students = DB.getStudents();
    if (this.state.activeCircle !== 'all') {
      students = students.filter(s => s.circle === this.state.activeCircle);
    }
    const questions = DB.getQuestions();

    // 2. Filter un-used
    let availableStudents = students.filter(s => !this.state.usedStudents.includes(s.id));
    let availableQuestions = questions.filter(q => !this.state.usedQuestions.includes(q.id));

    // 3. Cycle Fairness Logic (if all used, reset)
    if (availableStudents.length === 0) {
      this.state.usedStudents = [];
      availableStudents = students;
      UI.toast('تمت مناداة جميع الطلاب، بدء دورة جديدة!', 'success');
    }
    if (availableQuestions.length === 0) {
      this.state.usedQuestions = [];
      availableQuestions = questions;
      UI.toast('تم استخدام جميع الأسئلة، إعادة تدوير الأسئلة!', 'success');
    }

    // 4. Select Random
    const randomStudent = availableStudents[Math.floor(Math.random() * availableStudents.length)];
    const randomQuestion = availableQuestions[Math.floor(Math.random() * availableQuestions.length)];

    this.activeStudent = randomStudent;
    this.activeQuestion = randomQuestion;

    // 5. Update State
    this.state.usedStudents.push(randomStudent.id);
    this.state.usedQuestions.push(randomQuestion.id);
    this.state.stats.called++;
    DB.saveSession(this.state);

    // 6. Update UI
    document.getElementById('stage-init').classList.add('hidden');
    document.getElementById('stage-active').classList.remove('hidden');
    document.getElementById('btn-next-turn').classList.add('hidden');

    document.getElementById('revealed-answer').classList.add('hidden');
    document.getElementById('btn-reveal').classList.remove('hidden');

    document.getElementById('s-student-name').textContent = randomStudent.name;
    document.getElementById('s-question-text').textContent = randomQuestion.question;

    const meta = [];
    if (randomQuestion.category) meta.push(randomQuestion.category);
    if (randomQuestion.lesson) meta.push(randomQuestion.lesson);
    document.getElementById('s-category-lesson').textContent = meta.join(' | ');

    if (this.isPresentation) {
      document.getElementById('btn-next-pres').classList.add('hidden');
      document.getElementById('btn-reveal-pres').classList.remove('hidden');
    }

    UI.updateSessionStats();
    this.startTimer();
  },

  revealAnswer() {
    if (!this.activeQuestion) return;
    AudioSys.playReveal();
    this.stopTimer(); // Pause timer when revealing

    document.getElementById('btn-reveal').classList.add('hidden');
    document.getElementById('revealed-answer').classList.remove('hidden');
    document.getElementById('s-answer-text').textContent = this.activeQuestion.answer;

    if (this.isPresentation) {
      document.getElementById('btn-reveal-pres').classList.add('hidden');
      // In presentation mode, we just show Next, grading happens on host device
      document.getElementById('btn-next-pres').classList.remove('hidden');
    }
  },
  gradeAnswer(result) {
    if (!this.activeStudent) return;

    if (result === 'correct') {
      AudioSys.playCorrect();
      DB.addScore(this.activeStudent.id, 1);
      this.state.stats.correct++;
    } else if (result === 'wrong') {
      AudioSys.playWrong();
      this.state.stats.wrong++;
    } else {
      this.state.stats.skips++;
    }

    DB.saveSession(this.state);
    UI.updateSessionStats();
    UI.updateLeaderboard();

    // Immediately go to next turn
    this.nextTurn();
  },

  resetScores() {
    if (confirm('هل أنت متأكد من تصفير جميع نقاط الطلاب؟')) {
      DB.saveScores({});
      UI.updateLeaderboard();
      UI.toast('تم تصفير النقاط', 'success');
    }
  },

  // Timer Logic
  startTimer() {
    this.stopTimer();
    if (this.state.timerSetting > 0) {
      this.timeLeft = this.state.timerSetting;
      const timerUI = document.getElementById('timer-container');
      const timeSpan = document.getElementById('time-left');
      timerUI.classList.remove('hidden');
      timeSpan.textContent = this.timeLeft;
      timeSpan.classList.remove('text-red-500');

      this.timerInterval = setInterval(() => {
        this.timeLeft--;
        timeSpan.textContent = this.timeLeft;

        if (this.timeLeft <= 10) {
          timeSpan.classList.add('text-red-500');
        }

        if (this.timeLeft <= 0) {
          this.stopTimer();
          AudioSys.playTimeUp();
          UI.toast('انتهى الوقت!', 'error');
        }
      }, 1000);
    } else {
      document.getElementById('timer-container').classList.add('hidden');
    }
  },
  stopTimer() {
    if (this.timerInterval) clearInterval(this.timerInterval);
  },

  // Presentation Mode
  togglePresentation() {
    this.isPresentation = !this.isPresentation;
    const body = document.body;
    if (this.isPresentation) {
      body.classList.add('presentation-mode');
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.log(err));
      }
      document.querySelector('.presentation-controls').classList.remove('hidden');
    } else {
      body.classList.remove('presentation-mode');
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
      document.querySelector('.presentation-controls').classList.add('hidden');
    }
  }
};

// ================= 4. UI CONTROLLER =================
const UI = {
  init() {
    // Initial Renders
    this.updateHomeStatus();
    this.renderDashboardTables();
    this.populateCircleFilter();
    this.updateSoundIcon();

    // Check if active session exists to show tab
    const session = DB.getSession();
    if (session.activeCircle) {
      document.getElementById('nav-session-btn').classList.remove('hidden');
    }
    // Setup Listeners
    this.setupEventListeners();

    // Routing based on hash or default to home
    App.navigate('home');
  },

  toast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  showTab(tabId) {
    document.querySelectorAll('.dash-tab').forEach(el => el.classList.add('hidden'));
    document.getElementById(tabId).classList.remove('hidden');

    document.querySelectorAll('.dash-tab-btn').forEach(el => {
      el.classList.remove('btn-primary');
      el.classList.add('btn-outline');
    });

    const activeBtnId = tabId === 'dash-students' ? 'tab-btn-students' : 'tab-btn-questions';
    document.getElementById(activeBtnId).classList.remove('btn-outline');
    document.getElementById(activeBtnId).classList.add('btn-primary');
  },

  updateHomeStatus() {
    const sCount = DB.getStudents().length;
    const qCount = DB.getQuestions().length;

    document.getElementById('students-status').innerHTML = sCount > 0
? `<i class="fa-solid fa-check text-brown-600 ml-1"></i> يوجد <b>${sCount}</b> طالب مسجل.`
      : `<i class="fa-solid fa-info-circle text-orange-500 ml-1"></i> لم يتم إضافة طلاب بعد.`;

    document.getElementById('questions-status').innerHTML = qCount > 0
      ? `<i class="fa-solid fa-check text-brown-600 ml-1"></i> يوجد <b>${qCount}</b> سؤال مسجل.`
      : `<i class="fa-solid fa-info-circle text-orange-500 ml-1"></i> لم يتم إضافة أسئلة بعد.`;
  },

  populateCircleFilter() {
    const select = document.getElementById('circle-filter');
    const circles = DB.getCircles();
    select.innerHTML = '<option value="all">جميع الحلقات</option>';
    circles.forEach(c => {
      select.innerHTML += `<option value="${c}">${c}</option>`;
    });
  },

  renderDashboardTables() {
    // Students
    const sTbody = document.getElementById('students-tbody');
    sTbody.innerHTML = '';
    DB.getStudents().forEach(s => {
      sTbody.innerHTML +=
        `<tr>
            <td class="font-bold">${s.name}</td>
<td><span class="bg-brown-100 text-brown-900 px-2 py-1 rounded text-xs">${s.circle}</span></td>
            <td>${s.level || '-'}</td>
            <td class="text-center">
              <button onclick="App.deleteStudent('${s.id}')" class="text-red-500 hover:text-red-700 transition" title="حذف"><i class="fa-solid fa-trash"></i></button>
            </td>
          </tr>`;
    });

    // Questions
    const qTbody = document.getElementById('questions-tbody');
    qTbody.innerHTML = '';
    DB.getQuestions().forEach(q => {
      qTbody.innerHTML +=
        `<tr>
            <td><span class="bg-gray-100 text-gray-700 px-2 py-1 rounded text-xs">${q.category || '-'}</span></td>
            <td>${q.lesson || '-'}</td>
            <td class="font-bold truncate max-w-xs" title="${q.question}">${q.question}</td>
<td class="text-brown-700">${q.answer}</td>
            <td class="text-center">
              <button onclick="App.deleteQuestion('${q.id}')" class="text-red-500 hover:text-red-700 transition" title="حذف"><i class="fa-solid fa-trash"></i></button>
            </td>
          </tr>`;
    });
  },

  updateSessionStats() {
    if (!Session.state) return;
    const state = Session.state;

    let totalS = DB.getStudents().length;
    if (state.activeCircle !== 'all') {
      totalS = DB.getStudents().filter(s => s.circle === state.activeCircle).length;
    }
    const totalQ = DB.getQuestions().length;

    document.getElementById('stat-total-students').textContent = totalS;
    document.getElementById('stat-called-students').textContent = state.usedStudents.length;
    document.getElementById('stat-total-questions').textContent = totalQ;
    document.getElementById('stat-used-questions').textContent = state.usedQuestions.length;

    document.getElementById('stat-correct').textContent = state.stats.correct;
    document.getElementById('stat-wrong').textContent = state.stats.wrong;

    const totalAnswered = state.stats.correct + state.stats.wrong;
    const successRate = totalAnswered > 0 ? (state.stats.correct / totalAnswered) * 100 : 0;
    document.getElementById('stat-success-bar').style.width = `${successRate}%`;

    const circleName = state.activeCircle === 'all' ? 'جميع الحلقات' : state.activeCircle;
    document.getElementById('session-circle-name').textContent = `(${circleName})`;
  },

  updateLeaderboard() {
    const scores = DB.getScores();
    let students = DB.getStudents();
    if (Session.state && Session.state.activeCircle !== 'all') {
      students = students.filter(s => s.circle === Session.state.activeCircle);
    }

    // Map scores to students and sort descending
    const ranked = students.map(s => ({
      name: s.name,
      score: scores[s.id] || 0
    })).sort((a, b) => b.score - a.score);

    const tbody = document.getElementById('leaderboard-tbody');
    tbody.innerHTML = '';

    ranked.forEach((r, index) => {
      let medal = '';
      if (index === 0 && r.score > 0) medal = '<i class="fa-solid fa-medal text-yellow-500 ml-1"></i>';
      else if (index === 1 && r.score > 0) medal = '<i class="fa-solid fa-medal text-gray-400 ml-1"></i>';
      else if (index === 2 && r.score > 0) medal = '<i class="fa-solid fa-medal text-orange-400 ml-1"></i>';

      tbody.innerHTML +=
        `<tr class="border-b last:border-0 hover:bg-gray-50">
            <td class="py-2 px-2">${medal} ${r.name}</td>
<td class="py-2 px-2 text-center font-bold text-brown-700">${r.score}</td>
          </tr>`;
    });
  },
  updateSoundIcon() {
    const enabled = DB.getSettings().soundEnabled;
    const icon = document.getElementById('sound-icon');
    icon.className = enabled ? 'fa-solid fa-volume-high text-xl' : 'fa-solid fa-volume-xmark text-xl opacity-50';
  },

  setupEventListeners() {
    // Forms
    document.getElementById('add-student-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const s = {
        name: document.getElementById('stu-name').value,
        circle: document.getElementById('stu-circle').value,
        level: document.getElementById('stu-level').value
      };
      DB.addStudent(s);
      e.target.reset();
      this.renderDashboardTables();
      this.updateHomeStatus();
      this.populateCircleFilter();
      this.toast('تم إضافة الطالب بنجاح');
    });

    document.getElementById('add-question-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = {
        category: document.getElementById('q-category').value,
        lesson: document.getElementById('q-lesson').value,
        question: document.getElementById('q-text').value,
        answer: document.getElementById('q-answer').value
      };
      DB.addQuestion(q);
      e.target.reset();
      this.renderDashboardTables();
      this.updateHomeStatus();
      this.toast('تم إضافة السؤال بنجاح');
    });

    // File Uploads (Excel/CSV via SheetJS)
    document.getElementById('upload-students').addEventListener('change', (e) => this.handleFileUpload(e, 'students'));
    document.getElementById('upload-questions').addEventListener('change', (e) => this.handleFileUpload(e, 'questions'));
  },

  handleFileUpload(event, type) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        // Convert to array of arrays to map dynamically regardless of header exact names
        const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

        if (rows.length < 2) throw new Error("الملف فارغ أو لا يحتوي على بيانات");

        let importedCount = 0;
        if (type === 'students') {
          // Assuming col 0: Name, col 1: Circle, col 2: Level
          rows.slice(1).forEach(row => {
            if (row[0] && row[1]) {
              DB.addStudent({ name: String(row[0]).trim(), circle: String(row[1]).trim(), level: row[2] ? String(row[2]).trim() : '' });
              importedCount++;
            }
          });
        } else {
          // Assuming col 0: Category, col 1: Lesson, col 2: Question, col 3: Answer
          rows.slice(1).forEach(row => {
            // Question and Answer are mandatory
            if (row[2] && row[3]) {
              DB.addQuestion({ category: row[0] ? String(row[0]).trim() : '', lesson: row[1] ? String(row[1]).trim() : '', question: String(row[2]).trim(), answer: String(row[3]).trim() });
              importedCount++;
            }
          });
        }

        this.renderDashboardTables();
        this.updateHomeStatus();
        if (type === 'students') this.populateCircleFilter();

        this.toast(`تم استيراد ${importedCount} سجل بنجاح`, 'success');
      } catch (error) {
        console.error(error);
        this.toast('خطأ في قراءة الملف، تأكد من التنسيق.', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = ''; // Reset input
  }
};

// ================= 5. MAIN APP CONTROLLER =================
const App = {
  navigate(viewId) {
    // Hide all views
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    // Show target view
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.remove('hidden');
    if (viewId === 'session') target.classList.add('flex'); // Because session uses flex

    // Update Nav Active State
document.querySelectorAll('.nav-btn').forEach(el => {
      el.classList.remove('bg-brown-800', 'font-bold');
      if (el.dataset.target === viewId) el.classList.add('bg-brown-800', 'font-bold');
    });

    // Init specific view logic
    if (viewId === 'session') {
      Session.init();
      if (!Session.activeStudent) Session.resetStage(); // if coming back without active turn
      UI.updateSessionStats();
      UI.updateLeaderboard();
      document.getElementById('nav-session-btn').classList.remove('hidden');
    }
  },

  deleteStudent(id) {
    if (confirm('هل أنت متأكد من حذف الطالب؟')) {
      DB.deleteStudent(id);
      UI.renderDashboardTables();
      UI.updateHomeStatus();
      UI.populateCircleFilter();
    }
  },

  deleteQuestion(id) {
    if (confirm('هل أنت متأكد من حذف السؤال؟')) {
      DB.deleteQuestion(id);
      UI.renderDashboardTables();
      UI.updateHomeStatus();
    }
  },

  toggleSound() {
    const settings = DB.getSettings();
    settings.soundEnabled = !settings.soundEnabled;
    DB.saveSettings(settings);
    UI.updateSoundIcon();
    if (settings.soundEnabled) {
      AudioSys.init();
      AudioSys.playSelect();
    }
    UI.toast(settings.soundEnabled ? 'تم تفعيل الأصوات' : 'تم كتم الأصوات');
  }
};

// ================= INITIALIZE =================
document.addEventListener('DOMContentLoaded', () => {
  // Pre-load audio context on first user interaction to comply with browser autoplay policies
  document.body.addEventListener('click', () => { AudioSys.init(); }, { once: true });

  UI.init();
});

