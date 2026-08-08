// Free, no-API-cost classifier: matches an email against each category's
// keyword list by simple case-insensitive substring matching against the
// subject + snippet + sender. Returns the first category with the most
// keyword hits (min 1 hit), or null if nothing matches.
//
// This intentionally avoids calling any paid LLM API. If you later want
// smarter classification, swap matchCategory() for a call to an LLM of your
// choice (that will introduce API costs on your own key).

function matchCategory(categories, email) {
  const haystack = `${email.subject || ''} ${email.snippet || ''} ${email.from || ''}`.toLowerCase();

  let best = null;
  let bestScore = 0;

  for (const cat of categories) {
    const keywords = (cat.keywords || []).map(k => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.length === 0) continue;
    let score = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }

  return best;
}

module.exports = { matchCategory };
