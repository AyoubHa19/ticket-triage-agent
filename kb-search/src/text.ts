/** Lowercase, strip accents ("café" -> "cafe"), drop hyphens. Applied to documents and queries alike. */
export function fold(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[-‐-―_]/g, "");
}

// Function words, already folded (apostrophes removed).
const STOPWORDS = new Set(
  `the a an and or but not no i you he she it we they me my mine your our their its us them is are was were be been
   being am have has had do does did can could will would should shall may might must what when where how who whom
   which why to of in on at for with from by as about into over under up down out off this that these those there
   here then than so if also only just very too any some all please hello hi thanks thank need want get got im ive
   dont cant isnt whats`.split(/\s+/),
);

// Longest first. Light suffix stripping, not a real stemmer: it only needs to make inflected forms
// of the same word meet ("radiators"/"radiator", "leaking"/"leak", "batteries"/"battery").
const SUFFIXES = ["ings", "ing", "ies", "ers", "ed", "es", "er", "ly", "e", "s"];
const MIN_STEM = 3;

export function stem(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= MIN_STEM) {
      const base = token.slice(0, -suffix.length);
      return suffix === "ies" ? `${base}y` : base;
    }
  }
  return token;
}

/** Folded words without stopwords, not yet stemmed. */
export function words(text: string): string[] {
  return fold(text)
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export function tokenize(text: string): string[] {
  return words(text).map(stem);
}
