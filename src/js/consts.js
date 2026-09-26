/* =====================================================================
 * 常量：错误分类、提示词模板、固定题。页面内 Claude 和分析会话共用同一套错误代码。
 * 模板变量写成 {{name}}，fill() 只替换这种写法；单花括号的 JSON 结构原样保留。
 * ===================================================================== */

const APP_VERSION = '1.0.0';

const ERROR_TYPES = [
  { code: 'T-PAST',  name: '该用过去时',              sev: 'high', ex: ['I go there yesterday', 'I went there yesterday'] },
  { code: 'T-PERF',  name: '该用现在完成（进行）时',   sev: 'high', ex: ['I walk for five days', "I've been walking for five days"] },
  { code: 'T-FUT',   name: '计划和将来的说法',         sev: 'high', ex: ['Tomorrow I go to Santiago', "Tomorrow I'm going to Santiago"] },
  { code: 'T-OTHER', name: '其他时态问题',             sev: 'high', ex: null },
  { code: 'BE-V',    name: 'be 动词多余或缺失',        sev: 'low',  ex: ['I am live in Beijing', 'I live in Beijing'] },
  { code: 'AGR',     name: '主谓一致、第三人称单数',   sev: 'low',  ex: ['He walk fast', 'He walks fast'] },
  { code: 'PLUR',    name: '单复数',                   sev: 'low',  ex: ['two ticket', 'two tickets'] },
  { code: 'ART',     name: '冠词',                     sev: 'low',  ex: ['I booked bed', 'I booked a bed'] },
  { code: 'PREP',    name: '介词',                     sev: 'low',  ex: ['arrive to Rome', 'arrive in Rome'] },
  { code: 'QWO',     name: '疑问句语序',               sev: 'high', ex: ['Where I can buy tickets?', 'Where can I buy tickets?'] },
  { code: 'PRON',    name: 'he/she 等代词混用',        sev: 'high', ex: ['My sister, he…', 'My sister, she…'] },
  { code: 'YESNO',   name: '否定疑问句 yes/no 用反',   sev: 'high', ex: ['"You\'re not Japanese?" "Yes."', '"No, I\'m Chinese."'] },
  { code: 'WORD',    name: '用词不当或中式直译',       sev: null,   ex: ['open the light', 'turn on the light'] },
  { code: 'STRUCT',  name: '句子不完整或结构混乱',     sev: null,   ex: null },
];
const ERROR_MAP = Object.fromEntries(ERROR_TYPES.map(t => [t.code, t]));
const ERROR_CODES = ERROR_TYPES.map(t => t.code);
/* asr_suspect 只用于词尾类问题 */
const ASR_SUSPECT_TYPES = ['PLUR', 'AGR', 'T-PAST', 'T-PERF'];
const MAX_SHOWN_ERRORS = 3;

const TRACKS = [
  { id: 'social',    name: '社交',   sub: '路上聊天' },
  { id: 'service',   name: '办事',   sub: '住宿、吃饭、交通' },
  { id: 'listening', name: '听力',   sub: '专项清单' },
];

const STATUS_ZH = { todo: '未开始', doing: '练习中', done: '已盖章' };

const FIXED_PROMPTS = {
  intro: { zh: '一分钟自我介绍', en: 'Introduce yourself to a fellow pilgrim.' },
};

/* 实战对话里非母语角色固定用这句 style；母语者留空 */
const NON_NATIVE_STYLE = 'Use simple words and short sentences, like a non-native speaker, but keep your grammar correct.';

/* 逐句反馈里"对方"是谁：社交节点是一位旅伴（从角色里挑），办事节点是工作人员 */
const DRILL_STAFF = 'the staff member in this scenario (albergue warden, waiter, ticket clerk, receptionist — whichever fits)';
const DRILL_PARTNERS = ['linda', 'jonas', 'siobhan', 'jiwoo'];

/* 输入法语音输入常把英文听错。页面内 Claude 先还原本意，听错不算学习者的错。 */
const ASR_NOTE = `The learner speaks into a Chinese phone keyboard's voice input, which often mishears
English: similar-sounding words (walking → "working"), split or merged words, stray Chinese
characters, broken-off fragments, and trip words it doesn't know. Trip words it often mangles:
Camino (heard as "communal", "commune", "come in", "terminal"), Santiago, Sarria, Portomarín,
albergue, pilgrim, credencial, Buen Camino, Finisterre, Galicia. Work out what the learner most
likely said before judging. A mishearing is never the learner's error.`;

/* §8.1 任务 1–3，drill 和 debrief 共用 */
const RULES_1_TO_3 = `1. corrected: the minimal-edit correct version of what the learner said (mishearings repaired).
   Keep the learner's own words and meaning; fix only real errors. Ignore capitalization and punctuation.
2. errors: every error the learner actually made, each {type, orig, fix, sev, asr_suspect, note_zh}.
   type is one of: T-PAST, T-PERF, T-FUT, T-OTHER, BE-V, AGR, PLUR, ART, PREP, QWO, PRON,
   YESNO, WORD, STRUCT. sev is "high" if it could cause a misunderstanding, else "low".
   asr_suspect is true only for a missing or extra -s/-ed ending that speech-to-text could
   have produced. note_zh is one short Chinese sentence stating the rule.
   Casual spoken forms (gonna, yeah, dropped subjects in replies) and fillers (um, hmm,
   repeated words) are not errors. Voice-input mishearings are not errors.
3. natural: a more natural spoken version ONLY if clearly better than corrected; else null.
   Simple, friendly, everyday spoken English. Not fancy.`;

const PROMPTS = {
  /* §8.1 逐句反馈（改版：还原语音识别、对方会回答反问、提示按需给） */
  drill: `You play two roles for a Chinese native speaker practicing travel English for a trip
(Camino de Santiago from Sarria, then Barcelona, Milan, Venice, Florence, Rome, Naples;
Oct 17 – Nov 20): P, the person they are talking to, and a quiet speaking coach.
P is {{partner}}.

${ASR_NOTE}

Scenario: {{title_zh}} — opening line: "{{main_q}}"
Facts the learner (L) has confirmed about themself:
{{profile_facts}}
Conversation so far (oldest first):
{{history}}

P just said: "{{q}}"
L's raw voice-input text: "{{raw}}"

Tasks:
0. understood: what L most likely said, with voice-input mishearings repaired but L's own
   grammar and word choices kept exactly as spoken. Judge tasks 1–5 against this.
{{rules}}
4. asked_back: true if L asked P anything, anywhere in the answer.
5. vocab: Chinese words L used because they lacked the English, each {zh, en, example}.
6. followup: P's next line. 1–3 short spoken sentences (max 35 words) of everyday English,
   the way a real person talks, not an interviewer:
   - If L asked P something, answer it first with a concrete detail about yourself, consistent
     with what P said earlier.
   - React to the specific thing L said, not with a generic "That's great!". Sometimes share
     a small experience or opinion of your own.
   - Then either ask ONE question or say something L can respond to. Do not ask a question
     every turn. Never repeat a question P already asked above. Use these only if they fit
     and were not asked yet: {{followups}}
   - If L said "pardon", "sorry?" or seemed lost, say your last line again more simply.
7. tip_zh: usually null. One short Chinese coaching tip ONLY when there is something specific
   and new to say about how L handled the conversation (a one-word answer, a missed chance to
   ask back, answering a different question, or something done well worth repeating).
   Never repeat an earlier tip: {{tips_given}}
8. ask_back_en: if asking P something would have been natural here and L didn't, one short
   question L could have asked that fits this exact moment; otherwise null. Avoid
   "What about you?" unless it really is the best fit.

Reply with only JSON:
{"understood":"…","corrected":"…","errors":[],"natural":null,"asked_back":false,"vocab":[],"followup":"…","tip_zh":null,"ask_back_en":null}`,

  /* §8.2 实战对话（第一条 user 消息；改版：像真人聊天，不是一味追问） */
  convo: `Role-play for speaking practice. You are {{name}}: {{bio}}. Setting: {{setting}}.
Talk the way this person would in real life: 1–3 short spoken sentences per turn,
everyday English. {{style}}
Be a real conversation partner, not an interviewer: react to what the learner actually said,
answer their questions with concrete details about yourself, share small stories or opinions,
and ask a question only some of the time. Never repeat a question you already asked.
The learner's messages come from phone voice input that mishears words (e.g. "communal" for
"Camino", "working" for "walking"); guess what they meant, and ask for clarification only if
you really can't. Never correct the learner and never mention that this is practice.
Start with a natural opening line.`,

  /* §8.3 对话讲评 */
  debrief: `Below is a role-play transcript between a learner (L) and {{name}} (P).
${ASR_NOTE}
For EACH learner turn i, return {i, corrected, errors, natural} using these rules:
{{rules}}
Then a summary: {top:[{type,count,example_orig,example_fix}], strengths_zh, rule_zh,
next_focus_zh}. rule_zh is one short, memorable Chinese rule for the most frequent
high-severity error.
Reply with only JSON: {"turns":[…],"summary":{…}}

Transcript:
{{transcript_lines}}`,

  /* §8.4 本次练习小结：次数由页面统计 */
  summary: `A learner's most frequent spoken-English errors this session (type, count, examples):
{{top3}}
Reply with only JSON: {"rule_zh":"…","next_focus_zh":["…","…"]}
rule_zh: one short, memorable Chinese rule for the top error. next_focus_zh: at most two
concrete things to practice next time, in Chinese.`,

  /* §8.5 口袋本条目 */
  bank: `Scenario: {{title_zh}} — "{{main_q}}". Learner facts: {{profile_facts}}.
The learner's corrected answers in this scenario: {{corrected_answers}}
Write the learner's best answer to keep for the trip.
Reply with only JSON: {"best_en":"…","chunks":[{"en":"…","zh":"…"}]}
best_en: 2–4 short spoken sentences in first person, using the learner's own facts and
words where possible, ending with a question back. chunks: 4–8 reusable sentence pieces
from it, each with a Chinese gloss.`,
};

/* sample 错误码 → 给用户看的话 */
const SAMPLE_ERR_ZH = {
  cancelled: '已停止。',
  not_granted: '你没有允许这个页面使用 Claude。依赖 Claude 的功能已隐藏；重新打开页面可以再选一次。',
  sampling_disabled: '这个账号或组织不能在页面里使用 Claude。',
  not_declared: '页面没有声明 Claude 能力，需要重新发布。',
  capability_disabled: '当前环境里页面内 Claude 不可用。',
  capability_removed: '当前 App 版本不支持页面内 Claude，请更新 App 或改用浏览器。',
  unavailable: '页面内 Claude 不可用（需要在 Claude 的 artifact 查看器里打开）。',
  rate_limited: '调用太频繁或用量到上限了，稍后再试。',
  session_expired: '登录已过期，请重新登录 claude.ai。',
  refused: 'Claude 拒绝了这次请求。换个说法再试。',
  empty_completion: 'Claude 没有返回内容。',
  invalid_json: 'Claude 的回复不是有效的 JSON。',
  bad_shape: 'Claude 的回复缺少必要字段。',
  prompt_too_large: '内容太长了。',
  upstream_error: '网络或服务出错了。',
};
function sampleErrZh(code) { return SAMPLE_ERR_ZH[code] || SAMPLE_ERR_ZH.upstream_error; }
