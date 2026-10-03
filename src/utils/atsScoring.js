// ── ATS Scoring Engine ─────────────────────────────────────────────────────
// Comprehensive resume scoring with category breakdowns and actionable insights

import { industryKeywords, actionVerbs } from './atsData';

// ── Constants ─────────────────────────────────────────────────────────────

const SCORE_WEIGHTS = {
  contact: 10,
  summary: 10,
  experience: 20,
  skills: 15,
  education: 10,
  projects: 5,
  certifications: 5,
  formatting: 10,
  keywords: 10,
  readability: 5,
};

const WEAK_ACTION_VERBS = [
  'handled',
  'managed',
  'responsible for',
  'assisted',
  'helped',
  'supported',
  'participated',
  'worked on',
  'did',
  'made',
  'performed',
  'implemented',
  'used',
  'utilized',
  'operated',
  'maintained',
  'provided',
  'served',
  'coordinated',
  'organized',
];

const PASSIVE_PHRASES = [
  'was responsible for',
  'was tasked with',
  'was in charge of',
  'was involved in',
  'was assigned to',
  'was selected to',
  'was given the opportunity to',
  'was able to',
  'was asked to',
  'was required to',
  'was expected to',
  'was supposed to',
];

const FORMATTING_ISSUES = [
  'table',
  'column',
  'graphic',
  'image',
  'photo',
  'chart',
  'column layout',
  'two column',
  'multi-column',
  'sidebar',
];

// The two verb lists are consumed independently by `detectActionVerbStrength`
// (which iterates each one to count strong vs. weak matches). No aggregate
// list is needed; an earlier `ALL_ACTION_VERBS` constant was declared but
// never referenced and has been removed.
const STRONG_ACTION_VERBS = Object.values(actionVerbs).flat();

// ── Regex helpers ────────────────────────────────────────────────────────
//
// Every keyword list in this file may contain entries that are not plain
// words. `industryKeywords.technology`, for example, contains `C++`, `C#`,
// `Node.js`, `ASP.NET`, and `CI/CD`. Building a regex from such an entry
// without escaping has two distinct failure modes:
//
//   1. HARD CRASH — `new RegExp('\\bC++\\b')` throws
//      `SyntaxError: Invalid regular expression: /\bc++\b/g: Nothing to
//      repeat`. `+` is a quantifier, and `c++` has no atom for the second
//      `+` to repeat. The exception propagates out of `detectKeywordStuffing`,
//      through `scoreKeywords`, through `calculateDetailedScore`, and out of
//      the ATS Scanner's scan pipeline. The entire resume scan fails with no
//      result and a "Scan failed" toast.
//
//   2. SILENT MISMATCH — `new RegExp('\\bNode.js\\b')` compiles, but the
//      unescaped `.` matches any character. The pattern matches `NodeXjs`,
//      `Node-js`, and similar strings the user did not write. `C#` compiles
//      but the trailing `\b` requires a word character to its left, and `#`
//      is not a word character — so `\bC#\b` never matches "I know C#"
//      (silent false negative).
//
// `escapeRegExp` solves the crash and the miscompilation. It is the same
// idiom already used in `src/utils/resumeParser.js`.
//
// `buildWholeWordRegex` additionally solves the false-negative case for
// terms that start or end with a non-word character. `\b` requires a word
// character on both sides of the boundary, so `\bC\+\+\b` cannot match
// "I know C++" — the trailing `\b` has no word character to its left after
// `++`. Lookarounds check "not preceded/followed by an ASCII alphanumeric"
// instead, which is what "whole word" actually means for symbol-bearing
// keywords. Lookbehind is supported in every browser this app targets
// (Safari 16.4+, Chrome 62+, Firefox 78+).

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildWholeWordRegex = (term, flags = 'g') => {
  const escaped = escapeRegExp(term);
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, flags);
};

// ── Utility Functions ────────────────────────────────────────────────────

const countWords = (text) => {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
};

const countSentences = (text) => {
  if (!text) return 0;
  return text.split(/[.!?]+/).filter(Boolean).length;
};

const countBulletPoints = (text) => {
  if (!text) return 0;
  const matches = text.match(/[•\-*]\s/g);
  return matches ? matches.length : 0;
};

const hasQuantifiableAchievement = (text) => {
  if (!text) return false;
  return /(\d+%|\$\d+|\d+\s*(people|users|clients|team|customers)|increased|decreased|reduced|improved|generated|saved|delivered)/i.test(
    text
  );
};

const countQuantifiableAchievements = (text) => {
  if (!text) return 0;
  const patterns = [
    /\d+%/g,
    /\$\d+(?:,\d{3})*(?:\.\d+)?/g,
    /\d+\s*(?:people|users|clients|customers|team|employees|staff|members)/gi,
    /\d+(?:\.\d+)?\s*(?:million|billion|thousand|k|m|b)/gi,
  ];
  let count = 0;
  patterns.forEach((pattern) => {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  });
  return count;
};

const detectActionVerbStrength = (text) => {
  if (!text) return { strong: 0, weak: 0, total: 0 };
  const lower = text.toLowerCase();
  let strong = 0;
  let weak = 0;
  STRONG_ACTION_VERBS.forEach((verb) => {
    const regex = buildWholeWordRegex(verb.toLowerCase());
    const matches = lower.match(regex);
    if (matches) strong += matches.length;
  });
  WEAK_ACTION_VERBS.forEach((verb) => {
    const regex = buildWholeWordRegex(verb.toLowerCase());
    const matches = lower.match(regex);
    if (matches) weak += matches.length;
  });
  return { strong, weak, total: strong + weak };
};

const detectPassiveVoice = (text) => {
  if (!text) return { count: 0, phrases: [] };
  const lower = text.toLowerCase();
  const found = PASSIVE_PHRASES.filter((phrase) => lower.includes(phrase.toLowerCase()));
  let count = 0;
  found.forEach((phrase) => {
    const regex = buildWholeWordRegex(phrase.toLowerCase());
    const matches = lower.match(regex);
    if (matches) count += matches.length;
  });
  return { count, phrases: found };
};

const detectFormattingIssues = (text) => {
  if (!text) return { found: [], count: 0 };
  const lower = text.toLowerCase();
  const found = FORMATTING_ISSUES.filter((issue) => lower.includes(issue));
  return { found, count: found.length };
};

const detectDuplicateSkills = (skills) => {
  if (!skills || !Array.isArray(skills)) return { duplicates: [], count: 0 };
  const seen = new Set();
  const duplicates = [];
  skills.forEach((skill) => {
    const normalized = skill.toLowerCase().trim();
    if (seen.has(normalized)) {
      duplicates.push(skill);
    } else {
      seen.add(normalized);
    }
  });
  return { duplicates, count: duplicates.length };
};

const detectKeywordStuffing = (text, keywords) => {
  if (!text || !keywords || !keywords.length) return { stuffed: [], count: 0 };
  const lower = text.toLowerCase();
  const stuffed = [];
  keywords.forEach((keyword) => {
    const regex = buildWholeWordRegex(keyword.toLowerCase());
    const matches = lower.match(regex);
    if (matches && matches.length > 3) {
      stuffed.push({ keyword, count: matches.length });
    }
  });
  return { stuffed, count: stuffed.length };
};

const getKeywordGaps = (text, keywords) => {
  if (!text || !keywords || !keywords.length) return { missing: [], count: 0 };
  const lower = text.toLowerCase();
  const missing = keywords.filter((keyword) => !lower.includes(keyword.toLowerCase()));
  return { missing, count: missing.length };
};

const calculateReadingLevel = (text) => {
  if (!text) return { score: 0, label: 'Not enough text' };
  const words = countWords(text);
  const sentences = countSentences(text) || 1;
  const avgWordsPerSentence = words / sentences;
  // Simple Flesch-Kincaid-like approximation
  let score = 0;
  if (avgWordsPerSentence < 10) score = 100;
  else if (avgWordsPerSentence < 15) score = 80;
  else if (avgWordsPerSentence < 20) score = 60;
  else if (avgWordsPerSentence < 25) score = 40;
  else score = 20;
  return {
    score,
    label: score >= 80 ? 'Good' : score >= 60 ? 'Fair' : score >= 40 ? 'Needs Improvement' : 'Poor',
    avgWordsPerSentence,
  };
};

// ── Category Scorers ─────────────────────────────────────────────────────

const scoreContactInfo = (data) => {
  const personal = data?.personal || {};
  let score = 0;
  const details = {};

  if (personal.fullName?.trim()) {
    score += 3;
    details.fullName = true;
  } else {
    details.fullName = false;
  }

  if (personal.email?.trim()) {
    score += 3;
    details.email = true;
  } else {
    details.email = false;
  }

  if (personal.phone?.trim()) {
    score += 2;
    details.phone = true;
  } else {
    details.phone = false;
  }

  if (personal.location?.trim()) {
    score += 1;
    details.location = true;
  } else {
    details.location = false;
  }

  if (personal.linkedin || personal.github || personal.website) {
    score += 1;
    details.social = true;
  } else {
    details.social = false;
  }

  const maxScore = SCORE_WEIGHTS.contact;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreSummary = (data) => {
  const summary = data?.personal?.summary || '';
  const words = countWords(summary);
  let score = 0;
  const details = {};

  if (words >= 80) {
    score += 4;
    details.length = 'good';
  } else if (words >= 50) {
    score += 2;
    details.length = 'fair';
  } else if (words > 0) {
    score += 1;
    details.length = 'short';
  } else {
    details.length = 'missing';
  }

  // Check for action verbs
  const verbAnalysis = detectActionVerbStrength(summary);
  if (verbAnalysis.strong >= 2) {
    score += 3;
    details.actionVerbs = 'good';
  } else if (verbAnalysis.strong >= 1) {
    score += 2;
    details.actionVerbs = 'fair';
  } else if (verbAnalysis.total > 0) {
    score += 1;
    details.actionVerbs = 'weak';
  } else {
    details.actionVerbs = 'none';
  }

  // Check for quantifiable achievements
  if (hasQuantifiableAchievement(summary)) {
    score += 2;
    details.quantifiable = true;
  } else {
    details.quantifiable = false;
  }

  // Check for passive voice
  const passive = detectPassiveVoice(summary);
  if (passive.count === 0) {
    score += 1;
    details.passiveVoice = 'none';
  } else if (passive.count <= 2) {
    details.passiveVoice = 'few';
  } else {
    details.passiveVoice = 'many';
  }

  const maxScore = SCORE_WEIGHTS.summary;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreExperience = (data) => {
  const experiences = data?.experience || [];
  let score = 0;
  const details = {};

  if (experiences.length === 0) {
    details.count = 0;
    return {
      score: 0,
      maxScore: SCORE_WEIGHTS.experience,
      details,
      recommendations: ['Add work experience to showcase your career history'],
    };
  }

  details.count = experiences.length;
  if (experiences.length >= 3) {
    score += 5;
    details.countScore = 'good';
  } else if (experiences.length >= 2) {
    score += 3;
    details.countScore = 'fair';
  } else {
    score += 1;
    details.countScore = 'poor';
  }

  let totalQuantifiable = 0;
  let totalActionVerbs = 0;
  let totalDescriptions = 0;

  experiences.forEach((exp) => {
    const desc = exp.description || '';
    if (desc.trim()) {
      totalDescriptions++;
      const quant = countQuantifiableAchievements(desc);
      totalQuantifiable += quant;
      const verbs = detectActionVerbStrength(desc);
      totalActionVerbs += verbs.strong;
    }
  });

  // Quantifiable achievements
  if (totalQuantifiable >= 5) {
    score += 6;
    details.quantifiable = 'excellent';
  } else if (totalQuantifiable >= 3) {
    score += 4;
    details.quantifiable = 'good';
  } else if (totalQuantifiable >= 1) {
    score += 2;
    details.quantifiable = 'fair';
  } else {
    details.quantifiable = 'none';
  }

  // Action verbs
  if (totalActionVerbs >= 6) {
    score += 5;
    details.actionVerbs = 'excellent';
  } else if (totalActionVerbs >= 4) {
    score += 3;
    details.actionVerbs = 'good';
  } else if (totalActionVerbs >= 2) {
    score += 1;
    details.actionVerbs = 'fair';
  } else {
    details.actionVerbs = 'weak';
  }

  // Description completeness
  const descRatio = totalDescriptions / experiences.length;
  if (descRatio >= 0.8) {
    score += 4;
    details.completeness = 'good';
  } else if (descRatio >= 0.5) {
    score += 2;
    details.completeness = 'fair';
  } else {
    details.completeness = 'poor';
  }

  const maxScore = SCORE_WEIGHTS.experience;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreSkills = (data) => {
  const skills = data?.skills || {};
  const technical = skills.technical || [];
  const soft = skills.soft || [];
  const languages = skills.languages || [];

  let score = 0;
  const details = {};

  // Technical skills
  if (technical.length >= 8) {
    score += 6;
    details.technical = 'excellent';
  } else if (technical.length >= 5) {
    score += 4;
    details.technical = 'good';
  } else if (technical.length >= 3) {
    score += 2;
    details.technical = 'fair';
  } else {
    details.technical = 'poor';
  }

  // Soft skills
  if (soft.length >= 4) {
    score += 3;
    details.soft = 'good';
  } else if (soft.length >= 2) {
    score += 2;
    details.soft = 'fair';
  } else if (soft.length >= 1) {
    score += 1;
    details.soft = 'poor';
  } else {
    details.soft = 'none';
  }

  // Languages
  if (languages.length >= 2) {
    score += 2;
    details.languages = 'good';
  } else if (languages.length >= 1) {
    score += 1;
    details.languages = 'fair';
  } else {
    details.languages = 'none';
  }

  // Duplicate detection
  const allSkills = [...technical, ...soft, ...languages];
  const dupAnalysis = detectDuplicateSkills(allSkills);
  if (dupAnalysis.count === 0) {
    score += 2;
    details.duplicates = 'none';
  } else {
    details.duplicates = dupAnalysis.count;
  }

  // Skill categories coverage
  const hasProgramming = technical.some((s) =>
    /javascript|python|java|c\+\+|typescript|go|rust|ruby|php|swift|kotlin/.test(s.toLowerCase())
  );
  const hasFrontend = technical.some((s) =>
    /react|vue|angular|next|html|css|tailwind|bootstrap/.test(s.toLowerCase())
  );
  const hasBackend = technical.some((s) =>
    /node|express|django|flask|spring|graphql|rest|api/.test(s.toLowerCase())
  );
  const hasDatabase = technical.some((s) =>
    /sql|postgres|mongo|mysql|redis|elasticsearch|firebase|dynamodb/.test(s.toLowerCase())
  );
  const hasCloud = technical.some((s) =>
    /aws|azure|gcp|docker|kubernetes|terraform|cloud|serverless/.test(s.toLowerCase())
  );

  const categories = [hasProgramming, hasFrontend, hasBackend, hasDatabase, hasCloud];
  const covered = categories.filter(Boolean).length;
  if (covered >= 4) {
    details.coverage = 'excellent';
  } else if (covered >= 3) {
    details.coverage = 'good';
  } else if (covered >= 2) {
    details.coverage = 'fair';
  } else {
    details.coverage = 'poor';
  }

  const maxScore = SCORE_WEIGHTS.skills;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreEducation = (data) => {
  const education = data?.education || [];
  let score = 0;
  const details = {};

  if (education.length === 0) {
    details.count = 0;
    return {
      score: 0,
      maxScore: SCORE_WEIGHTS.education,
      details,
      recommendations: ['Add education information'],
    };
  }

  details.count = education.length;
  if (education.length >= 2) {
    score += 4;
    details.countScore = 'good';
  } else {
    score += 2;
    details.countScore = 'fair';
  }

  let completeEntries = 0;
  education.forEach((edu) => {
    if (edu.institution?.trim() && edu.degree?.trim() && edu.startDate) {
      completeEntries++;
    }
  });

  const ratio = completeEntries / education.length;
  if (ratio >= 0.8) {
    score += 4;
    details.completeness = 'good';
  } else if (ratio >= 0.5) {
    score += 2;
    details.completeness = 'fair';
  } else {
    details.completeness = 'poor';
  }

  // GPA check
  const hasGPA = education.some((edu) => edu.gpa?.trim());
  if (hasGPA) {
    score += 1;
    details.gpa = true;
  } else {
    details.gpa = false;
  }

  // Honors/achievements
  const hasHonors = education.some((edu) => edu.honors || edu.achievements);
  if (hasHonors) {
    score += 1;
    details.honors = true;
  } else {
    details.honors = false;
  }

  const maxScore = SCORE_WEIGHTS.education;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreProjects = (data) => {
  const projects = data?.projects || [];
  let score = 0;
  const details = {};

  if (projects.length === 0) {
    details.count = 0;
    return { score: 0, maxScore: SCORE_WEIGHTS.projects, details, recommendations: [] };
  }

  details.count = projects.length;
  if (projects.length >= 2) {
    score += 2;
    details.countScore = 'good';
  } else {
    score += 1;
    details.countScore = 'fair';
  }

  let hasTech = 0;
  let hasLink = 0;

  projects.forEach((proj) => {
    if (proj.technologies?.trim()) hasTech++;
    if (proj.link || proj.github) hasLink++;
    // `hasDescription` was previously counted here but never read - the score
    // uses only `techRatio` and `hasLink`. If project description presence
    // should influence the score in future, add it deliberately and update
    // the thresholds.
  });

  const techRatio = hasTech / projects.length;
  if (techRatio >= 0.7) {
    score += 2;
    details.technologies = 'good';
  } else if (techRatio >= 0.4) {
    score += 1;
    details.technologies = 'fair';
  } else {
    details.technologies = 'poor';
  }

  if (hasLink > 0) {
    score += 1;
    details.links = true;
  } else {
    details.links = false;
  }

  const maxScore = SCORE_WEIGHTS.projects;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreCertifications = (data) => {
  const certifications = data?.certifications || [];
  let score = 0;
  const details = {};

  if (certifications.length === 0) {
    details.count = 0;
    return { score: 0, maxScore: SCORE_WEIGHTS.certifications, details, recommendations: [] };
  }

  details.count = certifications.length;
  if (certifications.length >= 3) {
    score += 3;
    details.countScore = 'good';
  } else if (certifications.length >= 1) {
    score += 2;
    details.countScore = 'fair';
  }

  // Verification status
  const verified = certifications.filter((c) => c.verified).length;
  if (verified > 0) {
    score += 1;
    details.verified = true;
  } else {
    details.verified = false;
  }

  // Expiry tracking
  const hasExpiry = certifications.some((c) => c.expiryDate && !c.neverExpires);
  if (hasExpiry) {
    score += 1;
    details.expiry = true;
  } else {
    details.expiry = false;
  }

  const maxScore = SCORE_WEIGHTS.certifications;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreFormatting = (data) => {
  const text = JSON.stringify(data);
  const issues = detectFormattingIssues(text);
  let score = 10;
  const details = {};

  if (issues.count === 0) {
    details.issues = 'none';
    return { score, maxScore: SCORE_WEIGHTS.formatting, details, recommendations: [] };
  }

  // Deduct for each formatting issue found
  score = Math.max(0, score - issues.count * 2);
  details.issues = issues.found;

  const maxScore = SCORE_WEIGHTS.formatting;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

// `_jobRole` is accepted for API symmetry with the caller
// (`calculateDetailedScore` forwards its own `jobRole` argument here) but is
// not currently used by this scorer. The underscore prefix signals to the
// reader and to the project's ESLint configuration (`argsIgnorePattern: '^_'`)
// that the value is intentionally discarded. Wire it into the scoring
// algorithm if role-specific keyword weighting becomes necessary.
const scoreKeywords = (data, industry = 'general', _jobRole = '') => {
  const text = JSON.stringify(data);
  const keywords = industryKeywords[industry] || industryKeywords.general;
  const gapAnalysis = getKeywordGaps(text, keywords);
  const stuffingAnalysis = detectKeywordStuffing(text, keywords);

  let score = 0;
  const details = {};

  // Keyword coverage (percentage of keywords present)
  const totalKeywords = keywords.length;
  const present = totalKeywords - gapAnalysis.count;
  const coverage = totalKeywords > 0 ? (present / totalKeywords) * 100 : 0;

  if (coverage >= 60) {
    score += 6;
    details.coverage = 'excellent';
  } else if (coverage >= 40) {
    score += 4;
    details.coverage = 'good';
  } else if (coverage >= 20) {
    score += 2;
    details.coverage = 'fair';
  } else {
    details.coverage = 'poor';
  }

  // Keyword stuffing penalty
  if (stuffingAnalysis.count === 0) {
    score += 3;
    details.stuffing = 'none';
  } else if (stuffingAnalysis.count <= 2) {
    score += 1;
    details.stuffing = 'minor';
  } else {
    details.stuffing = 'excessive';
  }

  // Missing critical keywords (top 10 most important)
  const criticalKeywords = keywords.slice(0, 10);
  const criticalMissing = getKeywordGaps(text, criticalKeywords);
  if (criticalMissing.count === 0) {
    score += 1;
    details.criticalMissing = 'none';
  } else {
    details.criticalMissing = criticalMissing.missing;
  }

  const maxScore = SCORE_WEIGHTS.keywords;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

const scoreReadability = (data) => {
  const text = JSON.stringify(data);
  const verbAnalysis = detectActionVerbStrength(text);
  const passive = detectPassiveVoice(text);
  const readingLevel = calculateReadingLevel(text);
  const bulletCount = countBulletPoints(text);

  let score = 0;
  const details = {};

  // Action verb strength
  const verbRatio = verbAnalysis.total > 0 ? verbAnalysis.strong / verbAnalysis.total : 0;
  if (verbRatio >= 0.7) {
    score += 2;
    details.actionVerbs = 'excellent';
  } else if (verbRatio >= 0.4) {
    score += 1;
    details.actionVerbs = 'good';
  } else if (verbRatio > 0) {
    details.actionVerbs = 'weak';
  } else {
    details.actionVerbs = 'none';
  }

  // Passive voice
  if (passive.count === 0) {
    score += 1;
    details.passiveVoice = 'none';
  } else if (passive.count <= 2) {
    details.passiveVoice = 'few';
  } else {
    details.passiveVoice = 'many';
  }

  // Reading level
  if (readingLevel.score >= 60) {
    score += 1;
    details.readability = 'good';
  } else {
    details.readability = 'fair';
  }

  // Bullet points
  if (bulletCount >= 10) {
    score += 1;
    details.bulletPoints = 'excellent';
  } else if (bulletCount >= 5) {
    details.bulletPoints = 'good';
  } else {
    details.bulletPoints = 'few';
  }

  const maxScore = SCORE_WEIGHTS.readability;
  return {
    score: Math.min(score, maxScore),
    maxScore,
    details,
    recommendations: [],
  };
};

// ── Main Scoring Function ────────────────────────────────────────────────

export const calculateDetailedScore = (resumeData, industry = 'general', jobRole = '') => {
  const categories = {
    contact: scoreContactInfo(resumeData),
    summary: scoreSummary(resumeData),
    experience: scoreExperience(resumeData),
    skills: scoreSkills(resumeData),
    education: scoreEducation(resumeData),
    projects: scoreProjects(resumeData),
    certifications: scoreCertifications(resumeData),
    formatting: scoreFormatting(resumeData),
    keywords: scoreKeywords(resumeData, industry, jobRole),
    readability: scoreReadability(resumeData),
  };

  // Calculate total score
  let totalScore = 0;
  let totalMaxScore = 0;
  Object.keys(categories).forEach((key) => {
    const cat = categories[key];
    totalScore += cat.score;
    totalMaxScore += cat.maxScore;
  });

  const overallScore = totalMaxScore > 0 ? Math.round((totalScore / totalMaxScore) * 100) : 0;

  // Generate recommendations
  const recommendations = generateRecommendations(categories, resumeData, industry);

  return {
    overall: overallScore,
    categories,
    recommendations,
    totalScore,
    totalMaxScore,
  };
};

// ── Recommendation Generator ─────────────────────────────────────────────

const generateRecommendations = (categories, data, industry) => {
  const recs = [];

  // Contact
  const contact = categories.contact;
  if (contact.score < contact.maxScore) {
    if (!contact.details.fullName)
      recs.push({
        category: 'contact',
        priority: 'high',
        message: 'Add your full name to help recruiters identify you.',
      });
    if (!contact.details.email)
      recs.push({
        category: 'contact',
        priority: 'high',
        message: 'Include a professional email address for contact.',
      });
    if (!contact.details.phone)
      recs.push({
        category: 'contact',
        priority: 'medium',
        message: 'Add a phone number where you can be reached.',
      });
  }

  // Summary
  const summary = categories.summary;
  if (summary.score < summary.maxScore) {
    if (summary.details.length === 'missing') {
      recs.push({
        category: 'summary',
        priority: 'high',
        message: 'Add a professional summary to introduce yourself.',
      });
    } else if (summary.details.length === 'short') {
      recs.push({
        category: 'summary',
        priority: 'medium',
        message: 'Expand your summary to 80+ words for better impact.',
      });
    }
    if (summary.details.actionVerbs === 'weak' || summary.details.actionVerbs === 'none') {
      recs.push({
        category: 'summary',
        priority: 'medium',
        message: 'Use strong action verbs like "Led", "Developed", or "Achieved" in your summary.',
      });
    }
    if (!summary.details.quantifiable) {
      recs.push({
        category: 'summary',
        priority: 'medium',
        message: 'Quantify your impact with numbers and percentages.',
      });
    }
  }

  // Experience
  const exp = categories.experience;
  if (exp.score < exp.maxScore) {
    if (exp.details.count === 0) {
      recs.push({
        category: 'experience',
        priority: 'high',
        message: 'Add work experience to showcase your career.',
      });
    }
    if (exp.details.quantifiable === 'none' || exp.details.quantifiable === 'fair') {
      recs.push({
        category: 'experience',
        priority: 'high',
        message:
          'Include more quantifiable achievements (%, $, numbers) in your experience descriptions.',
      });
    }
    if (exp.details.actionVerbs === 'weak' || exp.details.actionVerbs === 'fair') {
      recs.push({
        category: 'experience',
        priority: 'medium',
        message:
          'Start bullet points with strong action verbs like "Led", "Developed", "Achieved".',
      });
    }
    if (exp.details.completeness === 'poor') {
      recs.push({
        category: 'experience',
        priority: 'medium',
        message: 'Add detailed descriptions for each experience entry.',
      });
    }
  }

  // Skills
  const skills = categories.skills;
  if (skills.score < skills.maxScore) {
    if (skills.details.technical === 'poor') {
      recs.push({
        category: 'skills',
        priority: 'high',
        message: 'Add more technical skills relevant to your industry (aim for 5+).',
      });
    }
    if (skills.details.soft === 'none') {
      recs.push({
        category: 'skills',
        priority: 'medium',
        message: 'Include soft skills like leadership, communication, and teamwork.',
      });
    }
    if (skills.details.duplicates > 0) {
      recs.push({
        category: 'skills',
        priority: 'low',
        message: `Remove duplicate skills (${skills.details.duplicates} duplicates found).`,
      });
    }
    if (skills.details.coverage === 'poor') {
      recs.push({
        category: 'skills',
        priority: 'medium',
        message:
          'Diversify your skills across different categories (programming, frontend, backend, database, cloud).',
      });
    }
  }

  // Education
  const edu = categories.education;
  if (edu.score < edu.maxScore) {
    if (edu.details.count === 0) {
      recs.push({
        category: 'education',
        priority: 'medium',
        message: 'Add your education background.',
      });
    }
    if (edu.details.completeness === 'poor' || edu.details.completeness === 'fair') {
      recs.push({
        category: 'education',
        priority: 'low',
        message: 'Include institution name, degree, and dates for each education entry.',
      });
    }
    if (!edu.details.gpa && edu.details.count > 0) {
      recs.push({
        category: 'education',
        priority: 'low',
        message: "Consider adding GPA if it's 3.0+ or relevant for the role.",
      });
    }
  }

  // Keywords
  const keywords = categories.keywords;
  if (keywords.score < keywords.maxScore) {
    if (keywords.details.coverage === 'poor' || keywords.details.coverage === 'fair') {
      recs.push({
        category: 'keywords',
        priority: 'high',
        message: `Add more industry keywords for ${industry}. Use the Keyword Suggestions tool.`,
      });
    }
    if (keywords.details.stuffing === 'excessive') {
      recs.push({
        category: 'keywords',
        priority: 'medium',
        message: 'Reduce keyword stuffing. Use keywords naturally in context.',
      });
    }
    if (
      keywords.details.criticalMissing !== 'none' &&
      keywords.details.criticalMissing.length > 0
    ) {
      const missing = keywords.details.criticalMissing.slice(0, 3).join(', ');
      recs.push({
        category: 'keywords',
        priority: 'high',
        message: `Add critical keywords: ${missing}`,
      });
    }
  }

  // Readability
  const readability = categories.readability;
  if (readability.score < readability.maxScore) {
    if (readability.details.actionVerbs === 'weak') {
      recs.push({
        category: 'readability',
        priority: 'medium',
        message: 'Use stronger action verbs throughout your resume.',
      });
    }
    if (readability.details.passiveVoice === 'many') {
      recs.push({
        category: 'readability',
        priority: 'medium',
        message: 'Reduce passive voice. Use active language.',
      });
    }
    if (readability.details.bulletPoints === 'few') {
      recs.push({
        category: 'readability',
        priority: 'low',
        message: 'Use bullet points to improve readability and scannability.',
      });
    }
  }

  // Formatting
  const formatting = categories.formatting;
  if (formatting.score < formatting.maxScore) {
    recs.push({
      category: 'formatting',
      priority: 'high',
      message:
        'Avoid tables, columns, graphics, and complex formatting that may confuse ATS parsers.',
    });
  }

  // Projects
  const projects = categories.projects;
  if (projects.details.count === 0) {
    recs.push({
      category: 'projects',
      priority: 'low',
      message: 'Add projects to showcase your practical skills and accomplishments.',
    });
  }

  // Certifications
  const certs = categories.certifications;
  if (certs.details.count === 0) {
    recs.push({
      category: 'certifications',
      priority: 'low',
      message: 'Add relevant certifications to enhance your credibility.',
    });
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return recs;
};

// ── Export ────────────────────────────────────────────────────────────────

/**
 * Aggregate object exported as the module's default. Declared as a named
 * constant (rather than inline in `export default { ... }`) so stack traces,
 * DevTools, and editor auto-import show the symbol as `atsScoring` instead
 * of `<anonymous>`. Consumers can import either the default export or the
 * named export - both refer to the same object.
 */
const atsScoring = {
  calculateDetailedScore,
  detectActionVerbStrength,
  detectPassiveVoice,
  detectFormattingIssues,
  detectDuplicateSkills,
  detectKeywordStuffing,
  getKeywordGaps,
  calculateReadingLevel,
  countQuantifiableAchievements,
  hasQuantifiableAchievement,
};

export { atsScoring };
export default atsScoring;