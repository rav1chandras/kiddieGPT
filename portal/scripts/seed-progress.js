// Seed two students with a week of realistic progress on paid.monthly@gmail.com.
// Everything goes through the real parent APIs, so it is validated exactly like
// data arriving from the extension.
const BASE = process.env.BASE || "http://localhost:8080";
const EMAIL = "paid.monthly@gmail.com";
const PW = "kiddiegpt123";

async function api(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 160) }; }
  return { status: res.status, body: payload || {} };
}

const dayKey = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

// Two contrasting learners so the portal shows real variation rather than
// the same numbers twice: Ben leans on maths, Ava on reading and writing.
const PLAN = {
  Ben: [
    { back: 6, lessons: 1, cardsReviewed: 12, mathSolved: 8,  tutorLessons: 1, explains: 2, writingChecks: 0, lastLesson: "Fractions on a number line", quizzes: [{ title: "Fractions check", score: 7, total: 10 }] },
    { back: 5, lessons: 0, cardsReviewed: 8,  mathSolved: 14, tutorLessons: 1, explains: 1, writingChecks: 0, lastLesson: "Equivalent fractions" },
    { back: 4, lessons: 1, cardsReviewed: 16, mathSolved: 11, tutorLessons: 0, explains: 3, writingChecks: 1, lastLesson: "Multiplying fractions", quizzes: [{ title: "Times tables sprint", score: 9, total: 10 }] },
    { back: 3, lessons: 0, cardsReviewed: 6,  mathSolved: 5,  tutorLessons: 1, explains: 1, writingChecks: 0, lastLesson: "Word problems" },
    { back: 2, lessons: 1, cardsReviewed: 14, mathSolved: 16, tutorLessons: 2, explains: 2, writingChecks: 0, lastLesson: "Long division", quizzes: [{ title: "Division quiz", score: 8, total: 10 }] },
    { back: 1, lessons: 1, cardsReviewed: 10, mathSolved: 12, tutorLessons: 1, explains: 4, writingChecks: 1, lastLesson: "Decimals and place value" },
    { back: 0, lessons: 0, cardsReviewed: 9,  mathSolved: 7,  tutorLessons: 1, explains: 1, writingChecks: 0, lastLesson: "Rounding decimals", quizzes: [{ title: "Decimals check", score: 10, total: 10 }] }
  ],
  Ava: [
    { back: 6, lessons: 1, cardsReviewed: 18, mathSolved: 2, tutorLessons: 0, explains: 5, writingChecks: 2, lastLesson: "Photosynthesis", quizzes: [{ title: "Plant parts", score: 9, total: 10 }] },
    { back: 5, lessons: 1, cardsReviewed: 22, mathSolved: 0, tutorLessons: 1, explains: 4, writingChecks: 3, lastLesson: "Water cycle" },
    { back: 4, lessons: 0, cardsReviewed: 11, mathSolved: 3, tutorLessons: 0, explains: 2, writingChecks: 1, lastLesson: "Book report draft" },
    { back: 3, lessons: 2, cardsReviewed: 25, mathSolved: 1, tutorLessons: 1, explains: 6, writingChecks: 4, lastLesson: "Persuasive writing", quizzes: [{ title: "Water cycle quiz", score: 6, total: 10 }] },
    { back: 2, lessons: 1, cardsReviewed: 15, mathSolved: 4, tutorLessons: 0, explains: 3, writingChecks: 2, lastLesson: "Editing paragraphs" },
    { back: 1, lessons: 0, cardsReviewed: 19, mathSolved: 2, tutorLessons: 1, explains: 4, writingChecks: 3, lastLesson: "Solar system", quizzes: [{ title: "Space facts", score: 8, total: 10 }] },
    { back: 0, lessons: 1, cardsReviewed: 13, mathSolved: 1, tutorLessons: 0, explains: 5, writingChecks: 2, lastLesson: "Planets and moons" }
  ]
};

// Usage totals drive the stat tiles and the "favourite tool" line.
const USAGE = {
  Ben: [["flashcard", 40], ["quiz", 12], ["tutor", 14], ["explain", 9], ["mission", 4], ["read", 3]],
  Ava: [["flashcard", 55], ["quiz", 15], ["write", 17], ["explain", 24], ["mission", 6], ["pdf", 5], ["read", 8]]
};
const MATH = { Ben: 73, Ava: 13 };

async function main() {
  const login = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PW, role: "parent" } });
  const token = login.body.token;
  if (!token) throw new Error("login failed: " + JSON.stringify(login.body));

  // Make sure the family has exactly the two students we are seeding.
  const before = await api("/api/account/progress", { token });
  const existing = before.body.children || [];
  console.log("students before:", existing.map((c) => c.name).join(", ") || "none");

  const family = (await api("/api/entitlements/me", { token })).body;
  const children = [
    { id: "fam_test_monthly_kid", studentName: "Ben", grade: "Grade 5", readingLevel: "On track",
      goal: "Build math confidence", reward: "Movie night",
      learningGoals: [{ goal: "Build math confidence", reward: "Movie night", completed: true },
                      { goal: "Finish times tables", reward: "Park trip", completed: false }] },
    { id: "fam_test_monthly_kid2", studentName: "Ava", grade: "Grade 3", readingLevel: "Advanced",
      goal: "Read every night", reward: "New book",
      learningGoals: [{ goal: "Read every night", reward: "New book", completed: false }] }
  ];
  const saved = await api("/api/families", {
    method: "POST",
    body: { email: EMAIL, parentName: "Mona Monthly", children }
  });
  console.log("students saved:", (saved.body.children || []).map((c) => c.studentName).join(", "));

  for (const [name, rows] of Object.entries(PLAN)) {
    const child = (saved.body.children || []).find((c) => c.studentName === name);
    if (!child) { console.log("no child for", name); continue; }
    for (const row of rows) {
      const { back, quizzes, ...bucket } = row;
      const payload = {
        childId: child.id,
        date: dayKey(back),
        bucket: {
          ...bucket,
          quizzes: (quizzes || []).map((q) => ({ ...q, ts: Date.now() - back * 86400000, missed: [] }))
        }
      };
      const r = await api("/api/progress", { method: "POST", token, body: payload });
      if (r.status !== 200) console.log("  progress failed", name, dayKey(back), r.status, JSON.stringify(r.body));
    }
    for (const [tool, count] of USAGE[name]) {
      for (let i = 0; i < count; i++) {
        await api("/api/usage/report", { method: "POST", token, body: { childId: child.id, tool, at: new Date(Date.now() - (i % 7) * 86400000).toISOString() } });
      }
    }
    await api("/api/usage/report", { method: "POST", token, body: { childId: child.id, tool: "math", mathProblems: MATH[name] } });
    await api("/api/usage/report", { method: "POST", token, body: { childId: child.id, tool: "tutor", voiceSeconds: name === "Ben" ? 900 : 480 } });
    console.log(`seeded ${name}: ${rows.length} days of progress + usage`);
  }

  const after = await api("/api/account/progress", { token });
  console.log("\n--- what the portal will render ---");
  for (const c of after.body.children || []) {
    const t = c.progress.reduce((acc, r) => {
      for (const k of ["lessons", "cardsReviewed", "mathSolved", "tutorLessons", "explains", "writingChecks"]) acc[k] = (acc[k] || 0) + (r.bucket[k] || 0);
      acc.quizzes = (acc.quizzes || 0) + (r.bucket.quizzes || []).length;
      return acc;
    }, {});
    console.log(`\n${c.name} (${c.grade})  days with activity: ${c.progress.length}  favourite tool: ${c.favoriteTool || "-"}`);
    console.log(`  missions ${t.lessons} | flashcards ${t.cardsReviewed} | math ${t.mathSolved} | tutor ${t.tutorLessons} | explain ${t.explains} | writing ${t.writingChecks} | quizzes ${t.quizzes}`);
    console.log(`  goals ${c.goals.completed}/${c.goals.total} | stats tiles -> flashcards ${c.stats.flashcards}, quiz ${c.stats.quiz}, math ${c.stats.math}, topics ${c.stats.topics}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
