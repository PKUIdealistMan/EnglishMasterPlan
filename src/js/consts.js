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

/* drill 模板第 6 条里 Claude 扮演的角色：社交节点是路上的旅伴，办事节点是工作人员 */
const DRILL_ROLE = {
  social: 'a friendly fellow traveler',
  service: 'the staff member in this scenario (stay in that role)',
};

/* §8.1 任务 1–3，drill 和 debrief 共用 */
const RULES_1_TO_3 = `1. corrected: the minimal-edit correct version. Keep the learner's own words and meaning;
   fix only real errors. Ignore capitalization and punctuation.
2. errors: every error, each {type, orig, fix, sev, asr_suspect, note_zh}.
   type is one of: T-PAST, T-PERF, T-FUT, T-OTHER, BE-V, AGR, PLUR, ART, PREP, QWO, PRON,
   YESNO, WORD, STRUCT. sev is "high" if it could cause a misunderstanding, else "low".
   asr_suspect is true only for a missing or extra -s/-ed ending that speech-to-text could
   have produced. note_zh is one short Chinese sentence stating the rule.
   Casual spoken forms (gonna, yeah, dropped subjects in replies) are not errors.
3. natural: a more natural spoken version ONLY if clearly better than corrected; else null.
   Simple, friendly, everyday spoken English. Not fancy.`;

const PROMPTS = {
  /* §8.1 逐句反馈 */
  drill: `You are an English speaking coach for a Chinese native speaker preparing for a trip
(Camino de Santiago from Sarria, then Barcelona, Milan, Venice, Florence, Rome, Naples;
Oct 17 – Nov 20). The learner answered by phone speech-to-text; the text is raw.

Scenario: {{title_zh}} — main question: "{{main_q}}"
Facts the learner has confirmed about themself (keep follow-ups consistent with them):
{{profile_facts}}
Conversation so far in this scenario (oldest first, at most 6 exchanges):
{{history}}

Question asked: "{{q}}"
Learner's raw answer: "{{raw}}"

Tasks:
{{rules}}
4. asked_back: true if the answer ends by asking the other person something.
5. vocab: Chinese words the learner used because they lacked the English,
   each {zh, en, example}.
6. followup: your next line as {{role}}. React briefly to what they
   said, then ask ONE natural follow-up question (max 20 words). Draw on these if they
   fit: {{followups}}

Reply with only JSON:
{"corrected":"…","errors":[],"natural":null,"asked_back":false,"vocab":[],"followup":"…"}`,

  /* §8.2 实战对话（第一条 user 消息） */
  convo: `Role-play for speaking practice. You are {{name}}: {{bio}}. Setting: {{setting}}.
Talk the way this person would in real life: 1–3 short spoken sentences per turn,
everyday English. {{style}}
React to what the learner says and keep the conversation going; ask a question most turns.
Never correct the learner and never mention that this is practice. If you can't understand
them, ask for clarification like a real person would.
Start with a natural opening line.`,

  /* §8.3 对话讲评 */
  debrief: `Below is a role-play transcript between a learner (L) and {{name}} (P).
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
